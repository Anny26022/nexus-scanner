"""NYSE trading calendar: holidays, early closes and which session a moment belongs to.

NYSE holidays follow published rules (NYSE Rule 7.2), so they are computed rather than copied by hand as NSE's are.
A holiday on Saturday is observed the Friday before and on Sunday the Monday after, except New Year's Day: when it
falls on a Saturday the exchange stays open the Friday before (the closure would land in the old year). Early closes
are at 1:00 PM Eastern. Closures no rule predicts (national days of mourning) are listed in SPECIAL_CLOSURES.

Times are Eastern (America/New_York), so daylight saving is handled by the zone: the 4:00 PM close is 1:30 AM IST in
summer and 2:30 AM IST in winter.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from functools import lru_cache

from .. import UNITED_STATES

EASTERN = UNITED_STATES.timezone
EARLY_CLOSE = time(13, 0)
# Unscheduled full-day closures within the published history (Dhan's US history starts in March 2021).
SPECIAL_CLOSURES = {date(2025, 1, 9): 'National Day of Mourning for President Jimmy Carter'}


def _easter(year: int) -> date:
    """Gregorian Easter Sunday (the anonymous Gregorian algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = divmod(b, 4)
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _observed(day: date) -> date | None:
    """The weekday a fixed-date holiday is observed on; None when it is not observed at all."""
    if day.weekday() == 5:
        return None if (day.month, day.day) == (1, 1) else day - timedelta(days=1)
    return day + timedelta(days=1) if day.weekday() == 6 else day


@lru_cache(maxsize=None)
def nyse_holidays(year: int) -> dict[date, str]:
    """Full-day closures in `year`, observed dates first, then any special closures that year."""
    fixed = [(date(year, 1, 1), "New Year's Day"), (date(year, 7, 4), 'Independence Day'), (date(year, 12, 25), 'Christmas Day')]
    if year >= 2022:
        fixed.append((date(year, 6, 19), 'Juneteenth National Independence Day'))
    holidays = {observed: name for day, name in fixed if (observed := _observed(day))}
    holidays.update({
        _nth_weekday(year, 1, 0, 3): 'Martin Luther King Jr. Day',
        _nth_weekday(year, 2, 0, 3): "Washington's Birthday",
        _easter(year) - timedelta(days=2): 'Good Friday',
        _last_weekday(year, 5, 0): 'Memorial Day',
        _nth_weekday(year, 9, 0, 1): 'Labor Day',
        _nth_weekday(year, 11, 3, 4): 'Thanksgiving Day',
    })
    holidays.update({day: name for day, name in SPECIAL_CLOSURES.items() if day.year == year})
    return dict(sorted(holidays.items()))


@lru_cache(maxsize=None)
def nyse_early_closes(year: int) -> dict[date, str]:
    """1:00 PM closes: the day after Thanksgiving, and July 3 and December 24 when they fall Monday to Thursday."""
    closes = {_nth_weekday(year, 11, 3, 4) + timedelta(days=1): 'Day after Thanksgiving'}
    for day, name in ((date(year, 7, 3), 'Independence Day eve'), (date(year, 12, 24), 'Christmas Eve')):
        if day.weekday() < 4:
            closes[day] = name
    return dict(sorted(closes.items()))


def is_nyse_session_day(day: date) -> bool:
    """Whether `day` (a date or datetime) carries a regular NYSE session."""
    day = day.date() if isinstance(day, datetime) else day
    return day.weekday() < 5 and day not in nyse_holidays(day.year)


def nyse_close(day: date) -> time:
    """The session's closing time in Eastern time."""
    return EARLY_CLOSE if day in nyse_early_closes(day.year) else UNITED_STATES.session_close


def previous_session_day(day: date) -> date:
    day -= timedelta(days=1)
    while not is_nyse_session_day(day):
        day -= timedelta(days=1)
    return day


@lru_cache(maxsize=None)
def _holidays_between(first_year: int, last_year: int) -> tuple:
    import numpy
    return tuple(numpy.datetime64(day) for year in range(first_year, last_year + 1) for day in nyse_holidays(year))


def sessions_after(start: date, end: date) -> int:
    """NYSE sessions after `start` up to and including `end` (the count a history from `start` would hold).

    Holidays follow Rule 7.2 for every year; one-off closures before 2021 (such as 2001's and 2012's) are not listed,
    so a pre-2021 count may be a few sessions high.
    """
    import numpy
    if end <= start:
        return 0
    holidays = list(_holidays_between(start.year, end.year))
    return int(numpy.busday_count(start + timedelta(days=1), end + timedelta(days=1), holidays=holidays))


def us_now(now: datetime | None = None) -> datetime:
    """`now` (aware, or naive meaning Eastern) in Eastern time."""
    instant = now or datetime.now(EASTERN)
    return instant.replace(tzinfo=EASTERN) if instant.tzinfo is None else instant.astimezone(EASTERN)


def is_us_cash_session(now: datetime | None = None) -> bool:
    """Whether a snapshot taken at `now` can hold a session that is still trading."""
    instant = us_now(now)
    day = instant.date()
    return is_nyse_session_day(day) and UNITED_STATES.session_open <= instant.time() < nyse_close(day)


def last_closed_session(now: datetime | None = None) -> date:
    """The latest NYSE session whose close has passed at `now`: the date a post-close snapshot belongs to.

    A run at 6:00 AM IST on a Tuesday is still Monday evening in New York, so it labels Monday's session, in summer
    and in winter alike; during or before Monday's session it labels the Friday before (or earlier over holidays).
    """
    instant = us_now(now)
    day = instant.date()
    if is_nyse_session_day(day) and instant.time() >= nyse_close(day):
        return day
    return previous_session_day(day)
