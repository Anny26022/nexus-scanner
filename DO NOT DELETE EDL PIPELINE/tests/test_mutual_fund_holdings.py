"""Weekly mutual fund portfolios: Dhan answers turned into the published files and the stock-to-funds index."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import fetch_mutual_fund_holdings as w  # noqa: E402
from mutual_fund_history import Throttled  # noqa: E402


def fund(isin, name='Fund', category='Equity', code='1'):
    return {'isin': isin, 'name': name, 'category': category, 'subCategory': 'Flexi Cap Fund', 'dhanSchemeCode': code}


def holding(name, isin, weight, kind='E', value=100.0, shares=10, sector='Financial Services', date='2026-05-31'):
    return {'pmd_name': name, 'pmd_isin': isin, 'pmd_ticker': name.upper(), 'pmd_holdingtype': kind, 'pmd_weighting': str(weight),
            'pmd_marketvalue': str(value), 'pmd_numberofshare': str(shares), 'pmd_sharechange': '1', 'pmd_sector': sector,
            'pmd_globalindustry': 'Banks', 'pmd_country': 'India', 'pmd_firstboughtdate': '2023-07-31', 'pmd_portfolio_date': date,
            'seo_symbol': 'x'}


HDFC, RELIANCE, TBILL = 'INE040A01034', 'INE002A01018', 'IN002025X123'


class BuildTests(unittest.TestCase):
    def build(self, holdings, funds=None, assets=None, aums=None, houses=None):
        funds = funds or [fund('INF000000001', 'Alpha'), fund('INF000000002', 'Beta')]
        assets = assets if assets is not None else {item['isin']: {'equity': 90.0} for item in funds}
        aums = aums if aums is not None else {item['isin']: [['2026-09', 100.0]] for item in funds}
        return w.build_files(funds, holdings, assets, aums, houses if houses is not None else [{'FUND_CODE': '1', 'FUND_NAME': 'A MF', 'TOTAL_AUM': '5', 'AMC_STATUS': 'A'}],
                             {'open': [{'SCHEME_NAME': 'New', 'START_DATE': '2026-11-01 00:00:00'}], 'closed': []}, 'now')

    def test_holdings_summary_and_the_stock_to_funds_index(self):
        files, report = self.build({
            'INF000000001': [holding('HDFC Bank', HDFC, 8, value=800), holding('T-Bill', TBILL, 5, kind='DG'), holding('Reliance', RELIANCE, 9, value=900)],
            'INF000000002': [holding('HDFC Bank', HDFC, 3, value=300, date='2026-06-15')]})
        alpha = files['holdings/INF000000001.json.gz']
        self.assertEqual([item['name'] for item in alpha['holdings']], ['Reliance', 'HDFC Bank', 'T-Bill'])
        hdfc = files[f'holders/{HDFC}.json.gz']
        self.assertEqual((hdfc['name'], hdfc['fundCount'], [row['fundName'] for row in hdfc['holders']], hdfc['totalMarketValue']),
                         ('HDFC Bank', 2, ['Alpha', 'Beta'], 1100.0))
        self.assertNotIn(f'holders/{TBILL}.json.gz', files)  # only Indian equities
        summary = {row['isin']: row for row in files['summary.json.gz']['funds']}
        self.assertEqual((summary['INF000000001']['holdingCount'], summary['INF000000001']['equityCount'], summary['INF000000001']['top10Weight']), (3, 2, 22.0))
        self.assertEqual(summary['INF000000001']['sectorWeights'], {'Financial Services': 17.0})
        self.assertEqual((summary['INF000000001']['assetMix'], summary['INF000000001']['aumHistory']), ({'equity': 90.0}, [['2026-09', 100.0]]))
        self.assertEqual(report['portfolioDates'], {'oldest': '2026-05-31', 'newest': '2026-06-15'})
        self.assertEqual((report['withHoldings'], report['stockCount']), (2, 2))
        self.assertEqual(files['fund-houses.json.gz']['fundHouses'][0]['name'], 'A MF')
        self.assertEqual(files['nfos.json.gz']['open'][0]['opens'], '2026-11-01')

    def test_a_fund_with_an_empty_portfolio_counts_as_answered(self):
        files, report = self.build({'INF000000001': [], 'INF000000002': [holding('HDFC Bank', HDFC, 3)]})
        self.assertEqual(report['withHoldings'], 2)
        self.assertNotIn('holdings/INF000000001.json.gz', files)

    def test_refuses_a_week_where_too_few_funds_answered(self):
        funds = [fund(f'INF00000000{index}') for index in range(10)]
        with self.assertRaisesRegex(ValueError, 'Holdings answered for 8 of 10'):
            self.build({f'INF00000000{index}': [] for index in range(8)}, funds)

    def test_refuses_missing_sources_and_an_empty_universe(self):
        full = {'INF000000001': [], 'INF000000002': []}
        for kwargs, message in (({'aums': {}}, 'AUM history answered for 0 of 2'), ({'assets': {}}, 'Asset mix answered for 0 of 2'),
                                ({'houses': []}, 'no fund houses')):
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                self.build(full, **kwargs)
        with self.assertRaisesRegex(ValueError, 'No funds'):
            w.build_files([], {}, {}, {}, [{'FUND_NAME': 'A'}], {'open': [], 'closed': []}, 'now')

    def test_universe_keeps_valid_isins_and_the_larger_duplicate(self):
        row = lambda isin, aum: {'dmfm_isin_code': isin, 'dmfm_custom_scheme_name': f'F {aum}', 'dmfm_latest_nav_value': '10',
                                 'dmfm_latest_nav_date': '2026-11-06', 'dmfm_scheme_aum': str(aum)}
        funds = w.universe([row('INF000000001', 500), row('INF000000001', 5), row('../../etc', 9), row('INF000000002', 1)])
        self.assertEqual([(item['isin'], item['aumCrore']) for item in funds], [('INF000000001', 500.0), ('INF000000002', 1.0)])

    def test_aum_history_is_monthly_and_oldest_first(self):
        rows = [{'invdate': 'September 2026', 'totnav': '145070.0'}, {'invdate': 'June 2022', 'totnav': '22324.0'}, {'invdate': 'bad', 'totnav': '1'}]
        self.assertEqual(w.aum_history(rows), [('2022-06', 22324.0), ('2026-09', 145070.0)])


class PacingTests(unittest.TestCase):
    def test_a_rate_limit_pauses_then_retries_only_the_refused_items(self):
        calls = []

        def call(item):
            calls.append(item)
            if item == 'b' and calls.count('b') == 1:
                raise Throttled('403')
            return item.upper()
        with patch.object(w.time, 'sleep') as sleep:
            results = w.paced_map(call, ['a', 'b', 'c'], workers=1, interval=0, pause=300)
        self.assertEqual(results, {'a': 'A', 'b': 'B', 'c': 'C'})
        self.assertEqual(calls, ['a', 'b', 'c', 'b'])
        sleep.assert_called_once_with(300)

    def test_gives_up_after_repeated_rate_limits(self):
        calls = []

        def call(item):
            calls.append(item)
            raise Throttled('403')
        budget = w.PauseBudget(2)
        with patch.object(w.time, 'sleep') as sleep:
            results = w.paced_map(call, ['a'], workers=1, interval=0, pause=0, budget=budget)
            self.assertIsInstance(results['a'], Throttled)
            self.assertEqual((len(calls), sleep.call_count, budget.left), (3, 2, 0))
            # The budget is shared: a later stage of the same run does not pause again.
            w.paced_map(call, ['b'], workers=1, interval=0, pause=0, budget=budget)
            self.assertEqual(sleep.call_count, 2)


if __name__ == '__main__':
    unittest.main()
