"""Weekly mutual fund portfolios from Dhan: holdings, asset mix, AUM history, fund houses and NFOs.

For every Direct-Growth fund in Dhan's screener:
  * holdings  (`SectorAllocation`, one request per fund): each security with weight, value, shares and their change,
    sector and industry, as of the fund's portfolio date (Dhan's lag a few months behind);
  * AUM history (`getAumDetails`, one per fund): month-end AUM since Dhan has it;
  * asset mix (`getAssetData`, 50 funds per request): equity, bond, cash and other shares.
Plus the fund-house list (`getAmcData`) and open and recently closed NFOs (`NFODetails`, `getClosedNFODetails`).

About 3,700 requests, paced like the NAV chart (mutual_fund_history.py). A 403/429 pauses for a few minutes and
resumes, so a throttled run finishes late instead of publishing a partial week.

`build_files` turns the answers into the published files, including the reverse index: for each Indian equity, the
funds that hold it.
"""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import re
import time

import requests

from fetch_mutual_funds import fetch_dhan, fund_record, iso_date, number, text
from mutual_fund_history import Pacer, Throttled
from pipeline_utils import get_headers, http_session

BASE = 'https://mf-openweb-search.dhan.co/'
WORKERS = 3
INTERVAL = 0.35
THROTTLE_PAUSE = 300  # seconds to wait after a 403/429 before resuming
MAX_PAUSES = 3
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
        return payload.get('data') if isinstance(payload, dict) else None
    return None


def fetch_holdings(isin):
    return post('SectorAllocation', {'entity_id': 'Openweb', 'source': 'W', 'iv': '', 'aes_key': '', 'ip': '',
                                     'data': {'client_id': '', 'scheme_isin': isin}}) or []


def fetch_aum_history(code):
    return post('getAumDetails', {'entity_id': 'dhanMF', 'source': 'W', 'data': {'schemeCode': str(code)}}) or []


def fetch_asset_mix(isins):
    return post('getAssetData', {'entity_id': 'OpenWeb', 'source': 'W', 'iv': '', 'data': {'scheme_isin': list(isins)}}) or []


def fetch_fund_houses():
    return post('getAmcData', {'entity_id': 'Openweb', 'source': 'W', 'aes_key': '', 'ip': '',
                               'data': {'client_id': '', 'sCode': '', 'period': ''}}) or []


def fetch_nfos(endpoint):
    return post(endpoint, {'entity_id': 'dhanMF', 'source': 'W', 'data': {'schemeCode': ''}}) or []


def paced_map(function, items, workers=WORKERS, interval=INTERVAL, pause=THROTTLE_PAUSE, max_pauses=MAX_PAUSES):
    """{item: result} for each item; failures map to an exception. A 403/429 pauses everyone, then resumes."""
    pacer, results, pauses = Pacer(interval), {}, 0
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
        if pauses >= max_pauses:
            for item in throttled:
                results[item] = Throttled('gave up after repeated rate limits')
            break
        pauses += 1
        print(f'Dhan rate-limited {len(throttled)} request(s); pausing {pause}s ({pauses}/{max_pauses})', flush=True)
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
    answered = [fund for fund in funds if isinstance(holdings.get(fund['isin']), list)]
    if len(answered) < MIN_COVERAGE * len(funds):
        raise ValueError(f'Holdings answered for {len(answered)} of {len(funds)} funds')
    files, summaries, holders = {}, [], defaultdict(list)
    for fund in funds:
        rows = holdings.get(fund['isin'])
        positions = sorted((holding_record(row) for row in rows), key=lambda item: -(item['weight'] or 0)) if isinstance(rows, list) else None
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


def fetch_week(funds=None):
    """Everything for the weekly files: the screener's universe, then the per-fund and market-wide requests."""
    fetched_at = datetime.now(timezone.utc).isoformat()
    if funds is None:
        funds = [fund_record(row) for row in fetch_dhan() if isinstance(row, dict)]
        funds = [fund for fund in {fund['isin']: fund for fund in funds if fund['isin'] and fund['name'] and fund['nav']}.values()]
    started = time.monotonic()
    holdings = paced_map(fetch_holdings, [fund['isin'] for fund in funds])
    holdings = {isin: rows for isin, rows in holdings.items() if isinstance(rows, list)}
    codes = {fund['dhanSchemeCode']: fund['isin'] for fund in funds if fund.get('dhanSchemeCode')}
    aums = {codes[code]: aum_history(rows) for code, rows in paced_map(fetch_aum_history, list(codes)).items() if isinstance(rows, list)}
    batches = [tuple(fund['isin'] for fund in funds[index:index + ASSET_BATCH]) for index in range(0, len(funds), ASSET_BATCH)]
    assets = {}
    for rows in paced_map(fetch_asset_mix, batches).values():
        for row in rows if isinstance(rows, list) else []:
            if row.get('isin'):
                assets[row['isin']] = asset_mix_record(row)
    market = paced_map(lambda name: {'houses': fetch_fund_houses, 'open': lambda: fetch_nfos('NFODetails'),
                                     'closed': lambda: fetch_nfos('getClosedNFODetails')}[name](), ['houses', 'open', 'closed'])
    market = {name: value if isinstance(value, list) else [] for name, value in market.items()}
    print(f'Holdings for {len(holdings)}/{len(funds)} funds, AUM history {len(aums)}, asset mix {len(assets)}, '
          f"{len(market['houses'])} fund houses, {len(market['open'])} open NFOs in {time.monotonic() - started:.0f}s", flush=True)
    return build_files(funds, holdings, assets, aums, market['houses'], {'open': market['open'], 'closed': market['closed']}, fetched_at)
