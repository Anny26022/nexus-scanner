"""Weekly mutual fund portfolios: Dhan answers turned into the published files and the stock-to-funds index."""
from pathlib import Path
import sys
import unittest
import unittest.mock
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

    def test_drops_ghost_rows_and_fills_blank_sectors_from_other_funds(self):
        files, _ = self.build({'INF000000001': [holding('HDFC Bank', HDFC, 8), holding('HDFC Bank', HDFC, 0, shares=0)],
                               'INF000000002': [holding('HDFC Bank', HDFC, 3, sector='NA')]})
        self.assertEqual(len(files['holdings/INF000000001.json.gz']['holdings']), 1)
        self.assertEqual(files['holdings/INF000000002.json.gz']['holdings'][0]['sector'], 'Financial Services')
        self.assertEqual(files['holders/' + HDFC + '.json.gz']['fundCount'], 2)

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

    def test_the_weekly_funds_are_the_daily_snapshots(self):
        daily = [fund('INF000000001', code='1')]
        with patch.object(w, 'fetch_snapshot', return_value={'funds': daily}) as snapshot, patch.object(w, 'fetch_holdings', return_value=[]), \
                patch.object(w, 'fetch_aum_history', return_value=[]), patch.object(w, 'fetch_asset_mix', side_effect=lambda isins: [{'isin': i} for i in isins]), \
                patch.object(w, 'fetch_fund_houses', return_value=[{'FUND_NAME': 'A'}]), patch.object(w, 'fetch_nfos', return_value=[]):
            _, report = w.fetch_week()
        snapshot.assert_called_once_with()
        self.assertEqual(report['fundCount'], 1)

    def test_aum_history_is_monthly_and_oldest_first(self):
        rows = [{'invdate': 'September 2026', 'totnav': '145070.0'}, {'invdate': 'June 2022', 'totnav': '22324.0'}, {'invdate': 'bad', 'totnav': '1'}]
        self.assertEqual(w.aum_history(rows), [('2022-06', 22324.0), ('2026-09', 145070.0)])


class FetchWeekTests(unittest.TestCase):
    def test_reused_aum_history_skips_those_funds_requests(self):
        funds = [fund('INF000000001', code='1'), fund('INF000000002', code='2')]
        asked = []
        with patch.object(w, 'fetch_holdings', return_value=[]), patch.object(w, 'fetch_asset_mix', side_effect=lambda isins: [{'isin': i} for i in isins]), \
                patch.object(w, 'fetch_aum_history', side_effect=lambda code: asked.append(code) or [{'invdate': 'October 2026', 'totnav': '7'}]), \
                patch.object(w, 'fetch_fund_houses', return_value=[{'FUND_NAME': 'A'}]), patch.object(w, 'fetch_nfos', return_value=[]):
            files, report = w.fetch_week(funds, previous_aums={'INF000000001': [['2026-09', 5.0]]}, aum_fetched_at='2026-11-01T05:00:00+00:00')
            summary = {row['isin']: row['aumHistory'] for row in files['summary.json.gz']['funds']}
            self.assertEqual((asked, summary, report['aumFetchedAt']),
                             (['2'], {'INF000000001': [['2026-09', 5.0]], 'INF000000002': [('2026-10', 7.0)]}, '2026-11-01T05:00:00+00:00'))
            asked.clear()
            _, report = w.fetch_week(funds)
            self.assertEqual((sorted(asked), report['aumFetchedAt'] == report['fetchedAt']), (['1', '2'], True))


class AnswerTests(unittest.TestCase):
    def answer(self, payload):
        response = unittest.mock.Mock(status_code=200, json=lambda: payload)
        response.raise_for_status = lambda: None
        session = unittest.mock.Mock(post=lambda *a, **k: response)
        with patch.object(w, 'http_session', return_value=session):
            return w.post('getAumDetails', {})

    def test_accepts_success_or_a_blank_status_and_refuses_errors(self):
        self.assertEqual(self.answer({'status': '', 'data': [{'invdate': 'September 2026'}]}), [{'invdate': 'September 2026'}])  # getAumDetails
        self.assertEqual(self.answer({'status': 'success', 'error_code': 'DH-2001', 'data': []}), [])
        for bad in ({'status': 'error', 'error_code': 'DH-0020', 'message': 'Invalid Request', 'data': []}, {'status': 'success'}, []):
            with self.subTest(bad), self.assertRaises(ValueError):
                self.answer(bad)


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
