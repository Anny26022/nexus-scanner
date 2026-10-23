"""Pin the daily refresh to the latest closed, regular NSE cash session."""

import os
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

from nse_delivery import NSE_HEADERS, parse_nse_date

HOLIDAYS_URL = 'https://www.nseindia.com/api/holiday-master?type=trading'


def expected_session(now, holiday_rows):
    holidays = {date.fromisoformat(parse_nse_date(row['tradingDate'])) for row in holiday_rows}
    day = now.date()
    if now.time() < time(15, 30):
        day -= timedelta(days=1)
    for _ in range(14):
        if day.year not in {holiday.year for holiday in holidays}:
            raise ValueError('NSE calendar does not cover the expected year; set an explicit expected session.')
        if day.weekday() < 5 and day not in holidays:
            return day.isoformat()
        day -= timedelta(days=1)
    raise ValueError('No closed NSE session found in the calendar window.')


def resolve_session(override=None, now=None):
    now = now or datetime.now(ZoneInfo('Asia/Kolkata'))
    if override:
        parsed = date.fromisoformat(override)
        if parsed.isoformat() != override or parsed > now.date():
            raise ValueError('Expected session must be an ISO date no later than today.')
        return override
    response = requests.get(HOLIDAYS_URL, headers=NSE_HEADERS, timeout=30)
    response.raise_for_status()
    return expected_session(now, response.json()['CM'])


if __name__ == '__main__':
    session = resolve_session(os.getenv('REQUESTED_SESSION'))
    with Path(os.environ['GITHUB_ENV']).open('a') as output:
        output.write(f'EDL_EXPECTED_SESSION={session}\n')
    message = f'Expected NSE session: {session}. A lagging report must not be published as fresh.'
    print(message)
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as output:
        output.write(message + '\n')
