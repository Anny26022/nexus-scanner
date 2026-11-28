from datetime import date, datetime, time, timezone
import json
import unittest
from unittest import mock

import stale_data_check as check

IST = check.IST
HOLIDAYS, PUBLISHED = check.load_calendar()


def at(day, hour, minute=0):
    return datetime.fromisoformat(day).replace(hour=hour, minute=minute, tzinfo=IST)


def expected(day, hour, minute=0, holidays=HOLIDAYS, **kwargs):
    return check.last_completed_session(at(day, hour, minute), holidays, **kwargs).isoformat()


class CalendarFileTest(unittest.TestCase):
    def test_listed_holidays_are_unique_weekdays_in_their_year(self):
        document = json.loads(check.HOLIDAYS_PATH.read_text())
        self.assertIn("nseindia.com", document["source"])
        for year, entries in document["holidays"].items():
            days = [date.fromisoformat(entry["date"]) for entry in entries]
            self.assertEqual(len(days), len(set(days)))
            for day in days:
                self.assertEqual(day.year, int(year))
                self.assertLess(day.weekday(), 5, day)
            self.assertEqual(bool(days), int(year) in PUBLISHED)


class LastCompletedSessionTest(unittest.TestCase):
    def test_cutoff_separates_today_from_the_previous_session(self):
        self.assertEqual(expected("2026-10-29", 19, 29), "2026-10-28")
        self.assertEqual(expected("2026-10-29", 19, 30), "2026-10-29")
        self.assertEqual(expected("2026-10-29", 8), "2026-10-28")

    def test_cutoff_is_configurable(self):
        self.assertEqual(expected("2026-10-29", 17, cutoff=time(16)), "2026-10-29")

    def test_weekends_fall_back_to_friday(self):
        for day in ("2026-10-31", "2026-11-01"):
            self.assertEqual(expected(day, 22), "2026-10-30")
        self.assertEqual(expected("2026-11-02", 10), "2026-10-30")  # Monday before the cutoff

    def test_listed_holiday_is_skipped(self):
        self.assertEqual(expected("2026-10-20", 22), "2026-10-19")  # Dussehra
        self.assertEqual(expected("2026-10-21", 9), "2026-10-19")
        self.assertEqual(expected("2026-10-21", 20), "2026-10-21")
        # Good Friday then a weekend: Monday morning still expects Thursday.
        self.assertEqual(expected("2026-04-06", 9), "2026-04-02")

    def test_utc_input_is_converted_to_ist(self):
        now = datetime(2026, 10, 29, 14, 15, tzinfo=timezone.utc)  # 19:45 IST
        self.assertEqual(check.last_completed_session(now, HOLIDAYS).isoformat(), "2026-10-29")

    def test_year_boundaries(self):
        self.assertEqual(expected("2027-01-01", 10), "2026-12-31")
        # 2026-12-25 is Christmas, so the morning after expects the 24th.
        self.assertEqual(expected("2026-12-26", 10), "2026-12-24")
        self.assertEqual(expected("2027-01-04", 10), "2027-01-01")  # Monday after New Year's Day
        new_year = {date(2027, 1, 1)}
        self.assertEqual(expected("2027-01-04", 10, holidays=new_year), "2026-12-31")


class VerdictTest(unittest.TestCase):
    def test_counts_only_trading_sessions_behind(self):
        result = check.verdict({"sessionDate": "2026-10-16", "revision": "abc"},
                               date(2026, 10, 21), HOLIDAYS, PUBLISHED)
        self.assertEqual((result["status"], result["behind"]), ("stale", 2))  # 19th, 21st
        self.assertIsNone(result["calendarWarning"])

    def test_current_or_ahead_is_not_stale(self):
        for live in ("2026-10-29", "2026-10-30"):
            result = check.verdict({"sessionDate": live}, date(2026, 10, 29), HOLIDAYS, PUBLISHED)
            self.assertEqual(result["status"], "current")

    def test_missing_or_invalid_pointer_is_stale(self):
        for pointer in (None, {}, {"sessionDate": "nope"}):
            result = check.verdict(pointer, date(2026, 10, 29), HOLIDAYS, PUBLISHED)
            self.assertEqual((result["status"], result["behind"]), ("stale", None))

    def test_unpublished_calendar_year_is_flagged(self):
        result = check.verdict({"sessionDate": "2027-01-04"}, date(2027, 1, 4), HOLIDAYS, PUBLISHED)
        self.assertIn("2027", result["calendarWarning"])


class ApplyTest(unittest.TestCase):
    RESULT = {"status": "stale", "expected": "2026-10-29", "live": "2026-10-28"}

    def run_apply(self, result, responses):
        calls = []

        def fake_gh(*args):
            calls.append(args)
            return responses.get(args[:2], "")
        with mock.patch.object(check, "gh", fake_gh):
            action = check.apply(result, "owner/repo", "body")
        return action, [call[:2] for call in calls]

    def test_opens_labelled_issue_when_none_is_open(self):
        action, calls = self.run_apply(self.RESULT, {("issue", "list"): "[]"})
        self.assertEqual(action, "opened")
        self.assertIn(("issue", "create"), calls)

    def test_comments_once_per_new_lag(self):
        listing = json.dumps([{"number": 7, "title": check.ISSUE_TITLE}])
        old = json.dumps({"body": check.MARKER.format(expected="2026-10-28", live="2026-10-27"),
                          "comments": []})
        action, calls = self.run_apply(self.RESULT, {("issue", "list"): listing, ("issue", "view"): old})
        self.assertEqual(action, "commented #7")
        same = json.dumps({"body": "x", "comments": [{"body": check.MARKER.format(**self.RESULT)}]})
        action, calls = self.run_apply(self.RESULT, {("issue", "list"): listing, ("issue", "view"): same})
        self.assertEqual(action, "unchanged #7")
        self.assertNotIn(("issue", "comment"), calls)

    def test_closes_open_issue_once_current(self):
        listing = json.dumps([{"number": 7, "title": check.ISSUE_TITLE}])
        action, calls = self.run_apply({"status": "current"}, {("issue", "list"): listing})
        self.assertEqual(action, "closed #7")
        self.assertEqual(calls[-1], ("issue", "close"))

    def test_current_without_issue_does_nothing(self):
        self.assertEqual(self.run_apply({"status": "current"}, {("issue", "list"): "[]"})[0], "none")


class DryRunTest(unittest.TestCase):
    def test_dry_run_never_calls_gh(self):
        pointer = {"sessionDate": "2026-10-28", "revision": "abc"}
        with mock.patch.object(check, "fetch_current", return_value=pointer), \
                mock.patch.object(check, "gh", side_effect=AssertionError("gh called")), \
                mock.patch.dict("os.environ", {}, clear=True), \
                mock.patch("builtins.print") as printed:
            check.main(["--now", "2026-10-29T20:00:00+05:30"])
        output = "\n".join(str(call.args[0]) for call in printed.call_args_list)
        self.assertIn("Verdict: STALE", output)
        self.assertIn("Dry run", output)


if __name__ == "__main__":
    unittest.main()
