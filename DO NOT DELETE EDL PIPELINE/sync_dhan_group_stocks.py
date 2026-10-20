"""Refresh corporate group membership; market metrics stay in the market snapshot."""
import sys
from pathlib import Path

from pipeline_utils import SCANX_FETCH_URL, load_json, post_json, save_json

GROUPS = [
    ('tata-group-stocks', 'Tata Group', 'TN'),
    ('adani-group-stocks', 'Adani Group', 'ADN'),
    ('mukesh-ambani-group-stocks', 'Mukesh Ambani Group', 'MDA'),
    ('anil-ambani-group-stocks', 'Anil Ambani Group', 'AL'),
    ('jindal-group-stocks', 'Jindal Group', 'JYOP,PRJI,DPJ,JYBC,JSW,NJIN,RJIN'),
    ('birla-group-stocks', 'Birla Group', 'DXMP,DXBK,DXAV,DXCK,DXKK,DXY'),
    ('bajaj-group-stocks', 'Bajaj Group', 'BH,BHS,BHH'),
    ('hinduja-group-stocks', 'Hinduja Group', 'HD'),
    ('godrej-group-stocks', 'Godrej Group', 'GJ'),
    ('hdfc-group-stocks', 'HDFC Group', 'HI'),
    ('icici-group-stocks', 'ICICI Group', 'ICI'),
    ('lt-group-stocks', 'L&T Group', 'LTG'),
    ('murugappa-group-stocks', 'Murugappa Group', 'NS'),
    ('mahindra-group-stocks', 'Mahindra Group', 'ML,KMG'),
]
DATA_PATH = Path(__file__).resolve().parents[1] / 'reference/dhan/group-stocks.json'
IDENTITY_FIELDS = {'isin': 'Isin', 'symbol': 'Sym', 'name': 'DispSym', 'exchange': 'Exch'}


def fetch_exchange(group_id, exchange):
    stocks = {}
    page = 1
    expected = None
    while True:
        payload = {'data': {
            'sort': 'Mcap', 'sorder': 'desc', 'count': 100, 'pgno': page,
            'params': [
                {'field': 'CompanyGrpId', 'op': '', 'val': group_id},
                {'field': 'OgInst', 'op': '', 'val': 'ES'},
                {'field': 'Seg', 'op': '', 'val': 'E'},
                {'field': 'Exch', 'op': '', 'val': exchange},
            ],
            'fields': list(IDENTITY_FIELDS.values()),
        }}
        response = post_json(SCANX_FETCH_URL, payload, include_origin=True, timeout=30)
        if (not isinstance(response, dict) or response.get('code') != 0
                or not isinstance(response.get('data'), list)):
            raise ValueError(f'{group_id}/{exchange}: invalid ScanX response')
        totals = (response.get('tot_rec'), response.get('tot_pg'))
        if (any(type(n) is not int or n < 0 for n in totals)
                or (totals[0] > 0 and totals[1] == 0)
                or (expected is not None and totals != expected)):
            raise ValueError(f'{group_id}/{exchange}: invalid or changing page totals')
        expected = totals
        before = len(stocks)
        for item in response['data']:
            if (not isinstance(item, dict)
                    or any(not isinstance(item.get(k), str) or not item[k].strip()
                           for k in IDENTITY_FIELDS.values())):
                raise ValueError(f'{group_id}/{exchange}: incomplete stock identity')
            if item['Exch'] != exchange or item['Isin'] in stocks:
                raise ValueError(f'{group_id}/{exchange}: wrong exchange or duplicate ISIN')
            stocks[item['Isin']] = {key: item[field] for key, field in IDENTITY_FIELDS.items()}
        if page >= max(1, expected[1]):
            break
        if len(stocks) == before:
            raise ValueError(f'{group_id}/{exchange}: incomplete page')
        page += 1
    if len(stocks) != expected[0]:
        raise ValueError(f'{group_id}/{exchange}: incomplete result ({len(stocks)}/{expected[0]})')
    return stocks


def sync_group_stocks(output=DATA_PATH):
    output = Path(output)
    previous = load_json(output) if output.exists() else {'groups': {}}
    groups = {}
    for slug, name, group_id in GROUPS:
        old = {s['isin']: s for s in previous['groups'].get(slug, {}).get('stocks', [])}
        stocks = {}
        for exchange in ('NSE', 'BSE'):
            members = fetch_exchange(group_id, exchange)
            if not members and any(s['exchange'] == exchange for s in old.values()):
                raise ValueError(f'{slug}/{exchange}: refusing to clear existing exchange membership')
            for isin, stock in members.items():
                stocks.setdefault(isin, stock)  # Prefer NSE, retain BSE-only members.
        if not stocks:
            raise ValueError(f'{slug}: refusing an empty group')
        added, removed = stocks.keys() - old.keys(), old.keys() - stocks.keys()
        updated = [isin for isin in stocks.keys() & old.keys()
                   if any(stocks[isin][key] != old[isin].get(key) for key in IDENTITY_FIELDS)]
        print(f'{slug}: +{len(added)} added, -{len(removed)} removed, {len(updated)} identities updated')
        for label, isins in (('Added', added), ('Removed', removed), ('Updated', updated)):
            if isins:
                print(f'  {label}: {", ".join(sorted(isins))}')
        groups[slug] = {
            'groupName': name,
            'sourceUrl': f'https://dhan.co/stocks/market/{slug}/',
            'stocks': [stocks[isin] for isin in sorted(stocks)],
        }
    result = {'source': 'Dhan (ow-scanx-analytics.dhan.co)', 'groups': groups}
    if result == previous:
        print('Group membership and identities unchanged.')
        return False
    save_json(output, result, indent=2)
    return True


if __name__ == '__main__':
    try:
        sync_group_stocks()
    except Exception as error:
        print(f'::warning::Dhan group refresh failed; previous dataset preserved: {error}', file=sys.stderr)
        sys.exit(1)
