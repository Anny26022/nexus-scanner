"""Alert through a GitHub issue when the published dataset lags the last NSE session.

Dry-run by default: prints the verdict. Pass --apply to open, comment on or close the issue.
"""
import argparse
from datetime import date, datetime, time, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time as clock
import urllib.request

IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_CUTOFF = time(19, 30)  # The 16:00 IST refresh gets 3.5 hours to publish.
DEFAULT_URL = "https://nexus-scanner.aniketmahato26.workers.dev/data/current.json"
HOLIDAYS_PATH = Path(__file__).resolve().parent.parent / "reference" / "nse-trading-holidays.json"
ISSUE_TITLE = "Published dataset is behind the last NSE trading session"
ISSUE_LABEL = "stale-data"
MARKER = "<!-- stale-data-check expected={expected} live={live} -->"


def load_calendar(path=HOLIDAYS_PATH):
    """Return (holiday dates, years whose official list is recorded)."""
    document = json.loads(Path(path).read_text())
    holidays = {date.fromisoformat(entry["date"])
                for entries in document["holidays"].values() for entry in entries}
    return holidays, set(document["publishedYears"])


def is_trading_day(day, holidays):
    return day.weekday() < 5 and day not in holidays


def last_completed_session(now, holidays, cutoff=DEFAULT_CUTOFF):
    """The latest trading day whose refresh should be live by `now` (an aware datetime)."""
    local = now.astimezone(IST)
    day = local.date() if local.time() >= cutoff else local.date() - timedelta(days=1)
    while not is_trading_day(day, holidays):
        day -= timedelta(days=1)
    return day


def sessions_behind(live, expected, holidays):
    """Trading sessions after `live` up to and including `expected`."""
    count, day = 0, live + timedelta(days=1)
    while day <= expected:
        count += is_trading_day(day, holidays)
        day += timedelta(days=1)
    return count


def fetch_current(url, attempts=3):
    """Fetch the pointer, bypassing every cache between here and the origin."""
    separator = "&" if "?" in url else "?"
    for attempt in range(attempts):
        request = urllib.request.Request(
            f"{url}{separator}stale-check={int(clock.time())}",
            headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache",
                     "User-Agent": "nexus-scanner-stale-data-check"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except (OSError, ValueError) as error:
            if attempt == attempts - 1:
                raise RuntimeError(f"could not fetch {url}: {error}") from error
            clock.sleep(5 * (attempt + 1))


def verdict(pointer, expected, holidays, published_years):
    """Summarise the live pointer against the expected session."""
    live = pointer.get("sessionDate") if pointer else None
    result = {"expected": expected.isoformat(), "live": live,
              "revision": (pointer or {}).get("revision"),
              "publishedAt": (pointer or {}).get("publishedAt")}
    try:
        live_day = date.fromisoformat(live)
    except (TypeError, ValueError):
        result.update(status="stale", behind=None)
    else:
        behind = sessions_behind(live_day, expected, holidays)
        result.update(status="stale" if behind else "current", behind=behind)
    result["calendarWarning"] = None if expected.year in published_years else (
        f"No NSE holiday list recorded for {expected.year}; its weekdays count as trading days. "
        "Add it to reference/nse-trading-holidays.json.")
    return result


def report(result, repo=None, runs=()):
    lines = [f"- Expected session: **{result['expected']}**",
             f"- Live session: **{result['live'] or 'unavailable'}**",
             f"- Sessions behind: {'unknown' if result['behind'] is None else result['behind']}",
             f"- Revision: `{result['revision'] or 'unavailable'}`",
             f"- Published at: {result['publishedAt'] or 'unavailable'}"]
    if result.get("error"):
        lines.append(f"- Fetch error: {result['error']}")
    if result["calendarWarning"]:
        lines.append(f"- Warning: {result['calendarWarning']}")
    if repo:
        lines.append(f"\nDaily refresh runs: https://github.com/{repo}/actions/workflows/daily_refresh.yml")
    lines.extend(f"- [{run['createdAt']} · {run.get('conclusion') or run['status']}]({run['url']})"
                 for run in runs)
    return "\n".join(lines)


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def latest_refresh_runs(repo, limit=3):
    try:
        return json.loads(gh("run", "list", "--repo", repo, "--workflow", "daily_refresh.yml",
                             "--limit", str(limit), "--json", "createdAt,status,conclusion,url"))
    except (OSError, subprocess.CalledProcessError, ValueError):
        return []  # The links are a convenience; never let them block the alert.


def open_issue(repo):
    issues = json.loads(gh("issue", "list", "--repo", repo, "--state", "open", "--label", ISSUE_LABEL,
                           "--json", "number,title", "--limit", "20"))
    return next((issue["number"] for issue in issues if issue["title"] == ISSUE_TITLE), None)


def already_reported(repo, number, marker):
    issue = json.loads(gh("issue", "view", str(number), "--repo", repo, "--json", "body,comments"))
    texts = [issue["body"], *(comment["body"] for comment in issue["comments"])]
    return marker in texts[-1]


def apply(result, repo, body):
    """Open, update or close the tracking issue. Returns the action taken."""
    number = open_issue(repo)
    if result["status"] == "current":
        if number is None:
            return "none"
        gh("issue", "comment", str(number), "--repo", repo,
           "--body", f"Data is current again; closing.\n\n{body}")
        gh("issue", "close", str(number), "--repo", repo)
        return f"closed #{number}"
    marker = MARKER.format(**result)
    text = f"{marker}\nThe published dataset is behind the last completed NSE trading session.\n\n{body}"
    if number is None:
        gh("label", "create", ISSUE_LABEL, "--repo", repo, "--force", "--color", "d93f0b",
           "--description", "Published dataset lags the last NSE trading session")
        gh("issue", "create", "--repo", repo, "--title", ISSUE_TITLE, "--label", ISSUE_LABEL, "--body", text)
        return "opened"
    if already_reported(repo, number, marker):
        return f"unchanged #{number}"  # Same lag as the last report; avoid repeat emails.
    gh("issue", "comment", str(number), "--repo", repo, "--body", text)
    return f"commented #{number}"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--repo", default=os.getenv("GITHUB_REPOSITORY"))
    parser.add_argument("--now", type=datetime.fromisoformat, help="ISO timestamp with offset")
    parser.add_argument("--cutoff", type=time.fromisoformat, default=DEFAULT_CUTOFF, help="IST, HH:MM")
    parser.add_argument("--expected-session", type=date.fromisoformat,
                        default=os.getenv("EDL_EXPECTED_SESSION") or None)
    parser.add_argument("--apply", action="store_true", help="Open, comment on or close the issue")
    args = parser.parse_args(argv)

    holidays, published_years = load_calendar()
    now = args.now or datetime.now(timezone.utc)
    expected = args.expected_session or last_completed_session(now, holidays, args.cutoff)
    try:
        pointer, error = fetch_current(args.url), None
    except RuntimeError as failure:
        pointer, error = None, str(failure)
    result = verdict(pointer, expected, holidays, published_years)
    result["error"] = error
    body = report(result, args.repo, latest_refresh_runs(args.repo) if args.repo else ())
    print(f"Verdict: {result['status'].upper()}\n{body}")
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as handle:
            handle.write(f"## Stale data check: {result['status']}\n\n{body}\n")
    if args.apply:
        if not args.repo:
            parser.error("--apply needs --repo or GITHUB_REPOSITORY")
        print(f"Issue: {apply(result, args.repo, body)}")
    else:
        print("Dry run: issues left untouched.")


if __name__ == "__main__":
    sys.exit(main())
