"""Daily mutual fund snapshot: Dhan's fund screener for the analytics, AMFI's official NAV file to check it.

Two requests a day:
  * Dhan `SearchScript` (the screener behind dhan.co/mutual-funds): every Direct-Growth fund with its returns,
    category ranges, ratings, AUM, costs and SIP rules.
  * AMFI `NAVAll.txt`: the regulator's NAV for every plan, matched to Dhan by ISIN.

The published NAV is AMFI's when AMFI has the fund and its NAV is as new as Dhan's. Dhan's returns are usually as of
its NAV date but for some funds a day behind (checked against its NAV chart), so `returnsAsOf` is left empty here.
The publisher replaces them, for every fund with usable NAV history, with returns computed as of the latest NAV;
funds without history (none yet, or no chart from Dhan) keep Dhan's undated returns. Where both sources quote the same date, their NAVs must agree, or the snapshot is refused
and the previous one stays live.

    python fetch_mutual_funds.py   # writes mutual_fund_snapshot.json
"""
import ast
from collections import Counter
from datetime import date, datetime, timedelta, timezone
import math
import re
import sys
from zoneinfo import ZoneInfo

import requests

from pipeline_utils import get_headers, http_session, save_json

DHAN_URL = 'https://mf-openweb-search.dhan.co/SearchScript'
AMFI_URL = 'https://www.amfiindia.com/spages/NAVAll.txt'
OUTPUT = 'mutual_fund_snapshot.json'
SCHEMA_VERSION = 1
# A smaller universe means Dhan answered with part of it; the publisher also compares with the live count.
MIN_FUNDS = 1000
# NAVs quoted for the same date by both sources must agree this closely, for this share of the funds compared.
NAV_TOLERANCE = 0.0001
MIN_NAV_AGREEMENT = 0.95
# Below this many same-date pairs the agreement share says little (AMFI and Dhan update at different hours).
MIN_NAV_COMPARISONS = 100
# AMFI lists nearly every fund Dhan does (97.6% when this was written); far fewer means a truncated download.
MIN_AMFI_COVERAGE = 0.9
ISIN = re.compile(r'INF[A-Z0-9]{9}')

# Dhan spells a few sub-categories two ways; one name each (AMFI's current names otherwise, which Dhan already uses).
SUB_CATEGORY = {'ELSS': 'ELSS - Tax Saver Fund', 'Equity Savings': 'Equity Savings Fund',
                'Banking and PSU Fund': 'Banking and PSU Debt Fund', 'Multi Asset Allocation': 'Multi Asset Allocation Fund',
                'Other Scheme - Index Fund': 'Index Fund', 'Dynamic Bond': 'Dynamic Term Fund',
                'Medium Duration Fund': 'Medium Term Fund', 'Sectoral / Thematic': 'Thematic Fund'}
# The tabs fund sites list by (Dhan's "Other" holds index funds and funds of funds); any other category is its own group.
GROUP = {'ELSS - Tax Saver Fund': 'ELSS', 'Index Fund': 'Index Funds', 'FoFs Domestic': 'Fund of Funds', 'FoFs Overseas': 'Fund of Funds'}
# A fund whose NAV is this much older than the snapshot's has closed, merged or matured (Dhan keeps listing some).
MAX_NAV_AGE_DAYS = 10
IST = ZoneInfo('Asia/Kolkata')
RETURN_PERIODS = {'1w': '1_week', '1m': '1_month', '3m': '3_month', '6m': '6_month', '1y': '1_year', '3y': '3_year', '5y': '5_year'}
CATEGORY_PERIODS = {'1d': '1_day', '1w': '1_week', '1m': '1_month', '3m': '3_month', '6m': '6_month', '1y': '1_year',
                    '3y': '3_year', '6y': '6_year'}


def number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def text(value):
    value = '' if value is None else str(value).strip()
    return None if value in ('', 'NA', 'N.A.', 'None') else value


def flag(value):
    return str(value).strip().upper() == 'Y'


def iso_date(value):
    value = text(value)
    try:
        return datetime.strptime(value[:10], '%Y-%m-%d').date().isoformat() if value else None
    except ValueError:
        return None


def rating(value):
    stars = number(value)
    return int(stars) if stars and 1 <= stars <= 5 else None


def split(value):
    return [part.strip() for part in str(value or '').split('|') if part.strip()]


def high_low(value):
    """Dhan sends the 52-week range as an object, or as its Python repr on the web pages."""
    if isinstance(value, str):
        try:
            value = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return None
    if not isinstance(value, dict):
        return None
    return {'high': number(value.get('52weekshigh')), 'highDate': iso_date(value.get('date_high')),
            'low': number(value.get('52weekslow')), 'lowDate': iso_date(value.get('date_low'))}


def fund_record(row):
    """One Dhan screener row as the published fund; the contact, address and per-frequency SIP limits stay out."""
    record = {
        'isin': row['dmfm_isin_code'],
        'name': text(row.get('dmfm_custom_scheme_name')) or text(row.get('dmfm_scheme_name')),
        'schemeName': text(row.get('dmfm_scheme_name')),
        'slug': text(row.get('dmfm_seo_symbol')),
        'dhanSchemeCode': text(row.get('dmfm_cmots_scheme_code')),
        'bseSchemeCode': text(row.get('dmfm_bse_scheme_code')),
        'fundHouse': text(row.get('dmfm_fund_name')),
        'fundHouseCode': text(row.get('dmfm_cmots_company_code')),
        'amc': text(row.get('dmfm_amc_name')),
        'category': text(row.get('dmfm_category_name')),
        'subCategory': SUB_CATEGORY.get(text(row.get('dmfm_subcategory_name')), text(row.get('dmfm_subcategory_name'))),
        'plan': text(row.get('dmfm_scheme_plan')),
        'option': text(row.get('dmfm_fund_plan')),
        'schemeType': text(row.get('dmfm_scheme_type')),
        'benchmark': text(row.get('dmfm_benchmark')),
        'inceptionDate': iso_date(row.get('dmfm_inception_date')),
        'objective': text(row.get('dmfm_investment_objective')),
        'fundManagers': split(row.get('dmfm_fund_manager')),
        'nav': number(row.get('dmfm_latest_nav_value')),
        'navDate': iso_date(row.get('dmfm_latest_nav_date')),
        'navSource': 'Dhan',
        'previousNav': number(row.get('dmfm_prev_nav_value')),
        'returnsAsOf': None,  # Dhan's figures are as of its NAV date or a day before; it does not say which
        'returnsSource': 'Dhan',
        'returns': dict({period: number(row.get(f'dmfm_scheme_{key}_return')) for period, key in RETURN_PERIODS.items()}, **{'10y': None}),
        'absoluteReturns': {'3y': number(row.get('dmfm_3_year_absolute_return')), '5y': number(row.get('dmfm_5_year_absolute_return'))},
        'categoryReturns': {period: {stat: number(row.get(f'dmfm_category_ret_{key}_{stat}')) for stat in ('avg', 'min', 'max')}
                            for period, key in CATEGORY_PERIODS.items()},
        'range52w': high_low(row.get('highlow')),
        'aumCrore': number(row.get('dmfm_scheme_aum')),
        'expenseRatio': number(row.get('dmfm_expense_ratio')),
        'morningstarRating': rating(row.get('dmfm_ms_rating')),
        'valueResearchRating': rating(row.get('dmfm_vr_rating')),
        'risk': text(row.get('dmfm_risk_value')),
        'riskCode': number(row.get('dmfm_risk_code')),
        'exitLoad': text(row.get('dmfm_exit_load')),
        'exitLoadPct': number(row.get('dmfm_exit_load_in_percent')),
        'lockInYears': number(row.get('dmfm_lock_in_period')),
        'stampDutyPct': number(row.get('dmfm_stamp_duty')),
        'minLumpsum': number(row.get('dmfm_lumsum_minimum_amt')),
        'minSipMonthly': number(row.get('dmfm_sip_min_amt_m')),
        'sipFrequencies': [part.lower() for part in split(row.get('dmfm_sip_frequency'))],
        'purchaseAllowed': flag(row.get('dmfm_purchase_allowed')),
        'sipAllowed': flag(row.get('dmfm_sip_flag')),
        'swpAllowed': flag(row.get('dmfm_swp_flag')),
        'stpAllowed': flag(row.get('dmfm_stp_flag')),
    }
    record['group'] = GROUP.get(record['subCategory'], record['category'])
    return record


def current_funds(records, today=None):
    """Funds with a current NAV. A NAV dated after today is a fund not launched yet (Dhan lists NFOs with a
    placeholder NAV); one more than MAX_NAV_AGE_DAYS before the newest is a closed, merged or matured scheme."""
    today = (today or datetime.now(IST).date()).isoformat()
    launched = [record for record in records if record['navDate'] <= today]
    newest = max((record['navDate'] for record in launched), default=None)
    if not newest:
        return launched
    cutoff = (date.fromisoformat(newest) - timedelta(days=MAX_NAV_AGE_DAYS)).isoformat()
    return [record for record in launched if record['navDate'] >= cutoff]


def one_per_scheme(records, known):
    """One fund per Dhan scheme code. An old ISIN Dhan keeps beside the live one shares its code and NAV (Shriram
    Overnight); the ISIN AMFI knows (`known`) wins, then the larger fund."""
    by_code = {}
    for record in sorted(records, key=lambda record: (record['isin'] not in known, -(record['aumCrore'] or 0))):
        by_code.setdefault(record['dhanSchemeCode'] or record['isin'], record)
    return list(by_code.values())


def parse_amfi(content):
    """AMFI's NAVAll.txt: `code;ISIN growth/payout;ISIN reinvestment;name;[plan;option;]NAV;date` under category and
    fund-house headings. Returns {ISIN: {code, nav, navDate}}; both ISIN columns map to the plan."""
    navs = {}
    for line in content.splitlines():
        parts = [part.strip() for part in line.split(';')]
        if len(parts) not in (6, 8) or not parts[0].isdigit():
            continue
        nav, day = number(parts[-2]), parts[-1]
        try:
            nav_date = datetime.strptime(day, '%d-%b-%Y').date().isoformat()
        except ValueError:
            continue
        if not nav or nav <= 0:
            continue
        for isin in parts[1:3]:
            if ISIN.fullmatch(isin):
                navs[isin] = {'code': parts[0], 'nav': nav, 'navDate': nav_date, 'option': parts[5] if len(parts) == 8 else ''}
    return navs


def build_snapshot(dhan_rows, amfi_navs, fetched_at):
    if not isinstance(dhan_rows, list):
        raise ValueError('Dhan fund screener did not return a list')
    funds = {}
    for row in dhan_rows:
        if not isinstance(row, dict) or not ISIN.fullmatch(str(row.get('dmfm_isin_code', ''))):
            continue
        record = fund_record(row)
        if not record['name'] or not record['nav'] or record['nav'] <= 0 or not record['navDate']:
            continue
        held = funds.get(record['isin'])
        # Dhan lists a few ISINs twice; the larger fund is the live listing.
        if held is None or (record['aumCrore'] or 0) > (held['aumCrore'] or 0):
            funds[record['isin']] = record
    if len(funds) < MIN_FUNDS:
        raise ValueError(f'Dhan fund screener returned {len(funds)} usable funds; expected at least {MIN_FUNDS}')

    covered = sum(isin in amfi_navs for isin in funds)
    if amfi_navs and covered < MIN_AMFI_COVERAGE * len(funds):
        print(f'AMFI NAV file covers only {covered} of {len(funds)} funds; treating it as unavailable', flush=True)
        amfi_navs = {}
    compared = agreed = from_amfi = 0
    for record in funds.values():
        official = amfi_navs.get(record['isin'])
        if not official:
            continue
        record['amfiSchemeCode'] = official['code']
        if official['navDate'] == record['navDate']:
            compared += 1
            agreed += abs(official['nav'] - record['nav']) <= NAV_TOLERANCE * official['nav']
        if official['navDate'] >= record['navDate']:
            record['nav'], record['navDate'], record['navSource'] = official['nav'], official['navDate'], 'AMFI'
            from_amfi += 1
    if compared >= MIN_NAV_COMPARISONS and agreed / compared < MIN_NAV_AGREEMENT:
        raise ValueError(f'Dhan and AMFI NAVs agree for only {agreed} of {compared} funds on the same date')

    current = current_funds(funds.values())
    not_current = len(funds) - len(current)
    current = one_per_scheme(current, amfi_navs)
    duplicates = len(funds) - not_current - len(current)
    # Two funds Dhan names alike are different plans (e.g. Kotak Gilt's "Provident Fund and Trust" option): name it.
    names = Counter(record['name'] for record in current)
    for record in current:
        option = (amfi_navs.get(record['isin']) or {}).get('option') or ''
        if names[record['name']] > 1 and option and not re.fullmatch(r'growth( option)?', option, re.I):
            record['name'] = f"{record['name']} ({option})"
    ordered = sorted(current, key=lambda record: (-(record['aumCrore'] or 0), record['name']))
    nav_dates = sorted({record['navDate'] for record in ordered})
    return {
        'schemaVersion': SCHEMA_VERSION,
        'fetchedAt': fetched_at,
        'navDate': max(nav_dates),
        'sources': {'funds': DHAN_URL, 'nav': AMFI_URL},
        'navCheck': {'amfiMatched': sum('amfiSchemeCode' in record for record in ordered), 'sameDateCompared': compared,
                     'sameDateAgreed': agreed, 'navFromAmfi': from_amfi},
        'fundCount': len(ordered),
        'droppedNotCurrent': not_current,
        'droppedDuplicateIsin': duplicates,
        'funds': ordered,
    }


def fetch_dhan():
    headers = dict(get_headers(), Origin='https://dhan.co', Referer='https://dhan.co/')
    payload = {'entity_id': 'Openweb', 'source': 'W', 'data': {
        'filedSearch': '', 'search': '', 'page': 0, 'fieldSearchValue': '', 'filter': {}, 'size': '5000',
        'sort': {'dmfm_scheme_aum': 'desc'}, 'tags_needed': ''}}
    response = http_session().post(DHAN_URL, json=payload, headers=headers, timeout=90)
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, dict) or body.get('status') != 'success':
        raise ValueError(f'Dhan fund screener refused the request: {str(body)[:200]}')
    return body.get('data')


def fetch_amfi():
    response = http_session().get(AMFI_URL, headers={'User-Agent': get_headers()['User-Agent']}, timeout=90)
    response.raise_for_status()
    response.encoding = response.encoding or 'utf-8'
    return parse_amfi(response.text)


def fetch_snapshot():
    """Both sources, combined. AMFI is a check, so a failed AMFI request publishes Dhan's NAVs on their own."""
    fetched_at = datetime.now(timezone.utc).isoformat()
    dhan_rows = fetch_dhan()
    try:
        amfi_navs = fetch_amfi()
    except (requests.RequestException, UnicodeError) as error:
        print(f'AMFI NAV file unavailable ({error}); publishing Dhan NAVs unchecked', flush=True)
        amfi_navs = {}
    return build_snapshot(dhan_rows, amfi_navs, fetched_at)


def main():
    try:
        snapshot = fetch_snapshot()
    except (requests.RequestException, ValueError, TypeError, KeyError) as error:
        print(f'Mutual fund snapshot unavailable: {error}', flush=True)
        return False
    save_json(OUTPUT, snapshot)
    check = snapshot['navCheck']
    print(f"Mutual funds: {snapshot['fundCount']} funds, NAV date {snapshot['navDate']}; AMFI matched "
          f"{check['amfiMatched']}, same-date NAVs agreed {check['sameDateAgreed']}/{check['sameDateCompared']}", flush=True)
    return True


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
