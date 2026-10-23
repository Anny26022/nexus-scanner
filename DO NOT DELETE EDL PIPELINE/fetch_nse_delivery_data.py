"""Stage NSE's newest full-universe delivery bhavcopy for the EDL pipeline."""

import os
import time
import requests
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

from nse_delivery import fetch_latest_full_bhavcopy
from pipeline_utils import BASE_DIR, save_json


OUTPUT_FILE = Path(BASE_DIR) / "nse_delivery_data.json"


def fetch_expected_bhavcopy(expected=None, attempts=5, delay=60):
    """Retry only when freshness is required; never save an older or misdated file."""
    latest = 'unavailable'
    for attempt in range(attempts if expected else 1):
        try:
            result = fetch_latest_full_bhavcopy(expected_date=expected) if expected else fetch_latest_full_bhavcopy()
            metadata, records, ohlcv = result
            latest = metadata['as_of_date']
            if not expected or (latest == expected and records and ohlcv
                                and all(row['date'] == expected for row in [*records, *ohlcv])):
                return result
            latest = f'{latest} (metadata or row dates do not match the expected session)'
        except (requests.RequestException, ValueError, RuntimeError) as error:
            if not expected:
                raise
            latest = str(error)
        if attempt < attempts - 1:
            print(f'Waiting for NSE session {expected}: observed {latest}; retrying in {delay}s.', flush=True)
            time.sleep(delay)
    message = f'Data not advanced: expected NSE session {expected}, observed {latest}. Previous snapshot unchanged.'
    if os.getenv('GITHUB_ACTIONS'):
        print(f'::error::{message}', flush=True)
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as output:
            output.write('### Data not advanced\n' + message + '\n')
    raise RuntimeError(message)


def main():
    metadata, records, ohlcv_records = fetch_expected_bhavcopy(os.getenv('EDL_EXPECTED_SESSION'))
    save_json(OUTPUT_FILE, {
        **metadata,
        "retrieved_at": datetime.now(ZoneInfo("Asia/Kolkata")).isoformat(),
        "records": records,
        "ohlcv_records": ohlcv_records,
    }, ensure_ascii=False)
    print(
        f"Saved {len(records)} delivery and {len(ohlcv_records)} OHLCV rows from {metadata['file_name']} "
        f"for {metadata['as_of_date']}."
    )
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
