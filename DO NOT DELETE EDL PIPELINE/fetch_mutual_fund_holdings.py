"""Weekly mutual fund portfolios from Dhan: holdings, asset mix, AUM history, fund houses and NFOs.

For every Direct-Growth fund in Dhan's screener:
  * holdings  (`SectorAllocation`, one request per fund): each security with weight, value, shares and their change,
    sector and industry, as of the fund's portfolio date (Dhan's lag a few months behind);
  * AUM history (`getAumDetails`, one per fund): month-end AUM since Dhan has it;
  * asset mix (`getAssetData`, 50 funds per request): equity, bond, cash and other shares.
Plus the fund-house list (`getAmcData`) and open and recently closed NFOs (`NFODetails`, `getClosedNFODetails`).

About 1,900 requests most weeks (3,700 when AUM history is a month old), at 5 a second: ~7 minutes, ~13 with AUM.
A 403/429 pauses for a few minutes and resumes, so a throttled run finishes late instead of publishing a partial week.

`build_files` turns the answers into the published files, including the reverse index: for each Indian equity, the
funds that hold it.
"""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import re
import time

import requests

from fetch_mutual_funds import ISIN, current_funds, fetch_dhan, fund_record, iso_date, number, text
from mutual_fund_history import Pacer, Throttled
from pipeline_utils import get_headers, http_session

BASE = 'https://mf-openweb-search.dhan.co/'
WORKERS = 3
# 5 requests a second: 1,835 at this pace drew no rate limit (2026-11-09); ~30 a second did.
INTERVAL = 0.2
THROTTLE_PAUSE = 300  # seconds to wait after a 403/429 before resuming
MAX_PAUSES = 3  # for the whole run, across every request stage, so the job stays inside its timeout
ASSET_BATCH = 50
# A week where fewer funds than this answered is a Dhan problem; the previous week stays live.
MIN_COVERAGE = 0.9
EQUITY_ISIN = re.compile(r'INE[A-Z0-9]{9}')


def post(endpoint, body):
    headers = dict(get_headers(), Origin='https://dhan.co', Referer='https://dhan.co/')
    for attempt in range(2):
        try:
            response = http_session().post(BASE + endpoint, json=body, headers=headers, timeout=60)
        except (requests.ConnectionError, requests.Timeout):
            if attempt:
                raise
            time.sleep(2)
            continue
        if response.status_code in (403, 429):
            raise Throttled(f'Dhan answered {response.status_code} for {endpoint}')
        if response.status_code >= 500 and not attempt:
            time.sleep(2)
            continue
        response.raise_for_status()
        payload = response.json()
        # Answers carry status "success", or "" (getAumDetails); a refused request says "error". A fund with no
        # portfolio answers with an empty list, but anything else is an error, not empty data.
        if not isinstance(payload, dict) or payload.get('status') not in ('success', '') or not isinstance(payload.get('data'), list):
            raise ValueError(f"Dhan {endpoint} answered {str(payload)[:160]}")
        return payload['data']
    raise ValueError(f'Dhan {endpoint} did not answer')


def fetch_holdings(isin):
    return post('SectorAllocation', {'entity_id': 'Openweb', 'source': 'W', 'iv': '', 'aes_key': '', 'ip': '',
                                     'data': {'client_id': '', 'scheme_isin': isin}})


def fetch_aum_history(code):
    return post('getAumDetails', {'entity_id': 'dhanMF', 'source': 'W', 'data': {'schemeCode': str(code)}})


def fetch_asset_mix(isins):
    return post('getAssetData', {'entity_id': 'OpenWeb', 'source': 'W', 'iv': '', 'data': {'scheme_isin': list(isins)}})


def fetch_fund_houses():
    return post('getAmcData', {'entity_id': 'Openweb', 'source': 'W', 'aes_key': '', 'ip': '',
                               'data': {'client_id': '', 'sCode': '', 'period': ''}})


def fetch_nfos(endpoint):
    return post(endpoint, {'entity_id': 'dhanMF', 'source': 'W', 'data': {'schemeCode': ''}})


class PauseBudget:
    """Rate-limit pauses left for the run."""
    def __init__(self, pauses=MAX_PAUSES):
        self.left = pauses


def paced_map(function, items, workers=WORKERS, interval=INTERVAL, pause=THROTTLE_PAUSE, budget=None):
    """{item: result} for each item; failures map to an exception. A 403/429 pauses everyone, then resumes, while the
    run's pause budget lasts."""
    budget = budget or PauseBudget()
    pacer, results = Pacer(interval), {}
    pending = list(items)
    while pending:
        throttled = []

        def call(item):
            pacer.wait()
            try:
                return item, function(item)
            except Throttled as error:
                return item, error
            except Exception as error:
                return item, error
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for item, result in pool.map(call, pending):
                if isinstance(result, Throttled):
                    throttled.append(item)
                else:
                    results[item] = result
        if not throttled:
            break
        if budget.left <= 0:
            for item in throttled:
                results[item] = Throttled('gave up after repeated rate limits')
            break
        budget.left -= 1
        print(f'Dhan rate-limited {len(throttled)} request(s); pausing {pause}s ({budget.left} pause(s) left)', flush=True)
        time.sleep(pause)
        pending = throttled
    return results


def holding_record(row):
    ticker = text(row.get('pmd_ticker'))
    return {'name': text(row.get('pmd_name')), 'isin': text(row.get('pmd_isin')), 'ticker': ticker,
            'type': text(row.get('pmd_holdingtype')), 'weight': number(row.get('pmd_weighting')),
            'marketValue': number(row.get('pmd_marketvalue')), 'shares': number(row.get('pmd_numberofshare')),
            'shareChange': number(row.get('pmd_sharechange')), 'sector': text(row.get('pmd_sector')),
            'industry': text(row.get('pmd_globalindustry')), 'country': text(row.get('pmd_country')),
            'firstBought': iso_date(row.get('pmd_firstboughtdate')), 'portfolioDate': iso_date(row.get('pmd_portfolio_date')),
            'dhanSlug': text(row.get('seo_symbol'))}


def asset_mix_record(row):
    return {'equity': number(row.get('equitynet')), 'bond': number(row.get('bondnet')), 'cash': number(row.get('cashnet')),
            'preferred': number(row.get('preferredstocknet')), 'convertible': number(row.get('convertiblenet')),
            'other': number(row.get('othernet')), 'portfolioDate': iso_date(row.get('portfoliodate'))}


def aum_history(rows):
    """Month-end AUM (₹ crore), oldest first: [['2022-06', 22324.0], ...]."""
    months = {}
    for row in rows or []:
        try:
            month = datetime.strptime(str(row.get('invdate')), '%B %Y').strftime('%Y-%m')
        except ValueError:
            continue
        value = number(row.get('totnav'))
        if value is not None:
            months[month] = value
    return sorted(months.items())


def fund_house_record(row):
    return {'code': text(row.get('FUND_CODE')), 'name': text(row.get('FUND_NAME')), 'shortName': text(row.get('AMC_CUSTOM_NAME')),
            'company': text(row.get('AMC')), 'slug': text(row.get('AMC_SEO_SYMBOL')), 'aumCrore': number(row.get('TOTAL_AUM')),
            'schemes': number(row.get('SCHEMES_MANAGED')), 'incorporated': iso_date(row.get('INCORPORAT')),
            'fundType': text(row.get('FUND_TYPE')), 'website': text(row.get('WEBSITE_URL')), 'active': text(row.get('AMC_STATUS')) == 'A'}


def nfo_record(row):
    return {'name': text(row.get('SCHEME_NAME')), 'isin': text(row.get('ISIN')), 'plan': text(row.get('SCHEME_PLAN')),
            'opens': iso_date(row.get('START_DATE')), 'closes': iso_date(row.get('END_DATE')),
            'allotment': iso_date(row.get('ALLOTMENT_DATE')), 'minPurchase': number(row.get('MIN_PURCHASE_AMT')),
            'sipAllowed': text(row.get('SIP_ALLOWED_FLAG')) == 'Y', 'dhanSlug': text(row.get('NFO_SEO_SYMBOL')),
            'dhanSchemeCode': text(row.get('CMOTS_SCHEME_CODE'))}


def build_files(funds, holdings, assets, aums, fund_houses, nfos, fetched_at):
    """The week's published files, keyed by path, and a summary for the pointer."""
    if not funds:
        raise ValueError('No funds to fetch portfolios for')
    answered = [fund for fund in funds if isinstance(holdings.get(fund['isin']), list)]
    if len(answered) < MIN_COVERAGE * len(funds):
        raise ValueError(f'Holdings answered for {len(answered)} of {len(funds)} funds')
    for label, found in (('AUM history', aums), ('Asset mix', assets)):
        covered = sum(fund['isin'] in found for fund in funds)
        if covered < MIN_COVERAGE * len(funds):
            raise ValueError(f'{label} answered for {covered} of {len(funds)} funds')
    if not fund_houses:
        raise ValueError('Dhan returned no fund houses')
    # Dhan repeats some positions as a row with no weight and no shares (4.8% of rows): not a holding.
    records = {isin: [item for item in map(holding_record, rows) if item['weight'] or item['shares']]
               for isin, rows in holdings.items() if isinstance(rows, list)}
    # Some funds leave an equity's sector blank ("NA" -> None) that others give: use the sector most funds report.
    sector_votes = defaultdict(Counter)
    for items in records.values():
        for item in items:
            if item['isin'] and item['sector']:
                sector_votes[item['isin']][item['sector']] += 1
    files, summaries, holders = {}, [], defaultdict(list)
    for fund in funds:
        positions = records.get(fund['isin'])
        if positions is not None:
            for item in positions:
                if not item['sector'] and sector_votes.get(item['isin']):
                    item['sector'] = sector_votes[item['isin']].most_common(1)[0][0]
            positions.sort(key=lambda item: -(item['weight'] or 0))
        dates = sorted({item['portfolioDate'] for item in positions or [] if item['portfolioDate']})
        summary = {'isin': fund['isin'], 'name': fund['name'], 'category': fund['category'], 'subCategory': fund['subCategory'],
                   'portfolioDate': dates[-1] if dates else None, 'holdingCount': len(positions) if positions is not None else None,
                   'assetMix': assets.get(fund['isin']), 'aumHistory': aums.get(fund['isin'])}
        if positions:
            equity = [item for item in positions if item['type'] == 'E']
            sectors = defaultdict(float)
            for item in equity:
                sectors[item['sector'] or 'Other'] += item['weight'] or 0
            summary.update(equityCount=len(equity), top10Weight=round(sum(item['weight'] or 0 for item in positions[:10]), 4),
                           sectorWeights={sector: round(weight, 4) for sector, weight in sorted(sectors.items(), key=lambda pair: -pair[1])})
            files[f"holdings/{fund['isin']}.json.gz"] = {'isin': fund['isin'], 'name': fund['name'],
                                                          'portfolioDate': summary['portfolioDate'], 'holdings': positions}
            for item in equity:
                if item['isin'] and EQUITY_ISIN.fullmatch(item['isin']):
                    holders[item['isin']].append({
                        'fundIsin': fund['isin'], 'fundName': fund['name'], 'category': fund['category'], 'subCategory': fund['subCategory'],
                        'weight': item['weight'], 'shares': item['shares'], 'shareChange': item['shareChange'],
                        'marketValue': item['marketValue'], 'portfolioDate': item['portfolioDate'], 'stock': (item['name'], item['ticker'])})
        summaries.append(summary)
    for stock_isin, rows in holders.items():
        name, ticker = rows[0].pop('stock')
        for row in rows[1:]:
            row.pop('stock')
        rows.sort(key=lambda row: -(row['marketValue'] or 0))
        files[f'holders/{stock_isin}.json.gz'] = {'isin': stock_isin, 'name': name, 'ticker': ticker, 'fundCount': len(rows),
                                                   'totalShares': sum(row['shares'] or 0 for row in rows),
                                                   'totalMarketValue': sum(row['marketValue'] or 0 for row in rows), 'holders': rows}
    files['summary.json.gz'] = {'funds': summaries}
    files['fund-houses.json.gz'] = {'fundHouses': sorted((fund_house_record(row) for row in fund_houses), key=lambda row: -(row['aumCrore'] or 0))}
    files['nfos.json.gz'] = {'open': [nfo_record(row) for row in nfos.get('open', [])], 'closed': [nfo_record(row) for row in nfos.get('closed', [])]}
    portfolio_dates = sorted({summary['portfolioDate'] for summary in summaries if summary['portfolioDate']})
    report = {'fetchedAt': fetched_at, 'fundCount': len(funds), 'withHoldings': len(answered), 'stockCount': len(holders),
              'portfolioDates': {'oldest': portfolio_dates[0], 'newest': portfolio_dates[-1]} if portfolio_dates else None}
    return files, report


def universe(rows):
    """The screener's funds with a valid ISIN; for a duplicated ISIN the larger fund, as the daily snapshot keeps."""
    funds = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not ISIN.fullmatch(str(row.get('dmfm_isin_code', ''))):
            continue
        fund = fund_record(row)
        held = funds.get(fund['isin'])
        if fund['name'] and fund['nav'] and fund['navDate'] and (held is None or (fund['aumCrore'] or 0) > (held['aumCrore'] or 0)):
            funds[fund['isin']] = fund
    return current_funds(funds.values())


def fetch_week(funds=None, previous_aums=None, aum_fetched_at=None):
    """Everything for the weekly files: the screener's universe, then the per-fund and market-wide requests.

    `previous_aums` ({ISIN: history}, from last week's summary) is month-end data: when given, only funds missing
    from it are asked for AUM history, which skips ~1,800 requests on most weeks.
    """
    fetched_at = datetime.now(timezone.utc).isoformat()
    if funds is None:
        funds = universe(fetch_dhan())
    budget, started = PauseBudget(), time.monotonic()
    holdings = paced_map(fetch_holdings, [fund['isin'] for fund in funds], budget=budget)
    holdings = {isin: rows for isin, rows in holdings.items() if isinstance(rows, list)}
    reused = {fund['isin']: previous_aums[fund['isin']] for fund in funds if fund['isin'] in (previous_aums or {})}
    codes = {fund['dhanSchemeCode']: fund['isin'] for fund in funds if fund.get('dhanSchemeCode') and fund['isin'] not in reused}
    aums = dict(reused, **{codes[code]: aum_history(rows) for code, rows in paced_map(fetch_aum_history, list(codes), budget=budget).items() if isinstance(rows, list)})
    batches = [tuple(fund['isin'] for fund in funds[index:index + ASSET_BATCH]) for index in range(0, len(funds), ASSET_BATCH)]
    assets = {}
    for rows in paced_map(fetch_asset_mix, batches, budget=budget).values():
        for row in rows if isinstance(rows, list) else []:
            if row.get('isin'):
                assets[row['isin']] = asset_mix_record(row)
    market = paced_map(lambda name: {'houses': fetch_fund_houses, 'open': lambda: fetch_nfos('NFODetails'),
                                     'closed': lambda: fetch_nfos('getClosedNFODetails')}[name](), ['houses', 'open', 'closed'], budget=budget)
    failed = [name for name, value in market.items() if not isinstance(value, list)]
    if failed:
        raise ValueError(f"Dhan's {', '.join(failed)} request failed: {market[failed[0]]}")
    print(f'Holdings for {len(holdings)}/{len(funds)} funds, AUM history {len(aums)} ({len(reused)} reused), asset mix {len(assets)}, '
          f"{len(market['houses'])} fund houses, {len(market['open'])} open NFOs in {time.monotonic() - started:.0f}s", flush=True)
    files, report = build_files(funds, holdings, assets, aums, market['houses'], {'open': market['open'], 'closed': market['closed']}, fetched_at)
    report['aumFetchedAt'] = aum_fetched_at if reused else fetched_at
    return files, report
