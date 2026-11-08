"""Mutual fund snapshot: Dhan's screener rows, checked against AMFI's NAV file."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import fetch_mutual_funds as mf  # noqa: E402

AMFI = """Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Flexi Cap Fund)

PPFAS Mutual Fund
122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;93.9483;06-Nov-2026
122640;INF879O01035;INF879O01043;Parag Parikh Flexi Cap Fund;Regular Plan;IDCW;80.1;06-Nov-2026
122641;INF879O01050;;Closed plan;Direct Plan;Growth;N.A.;06-Nov-2026
118955;INF179K01UT0;-;HDFC Flexi Cap Fund - Growth Option - Direct Plan;2335.942;07-Nov-2026
"""


def row(isin, nav='93.9483', day='2026-11-06', aum='1000', **extra):
    return {'dmfm_isin_code': isin, 'dmfm_custom_scheme_name': f'Fund {isin}', 'dmfm_scheme_name': f'FUND {isin}',
            'dmfm_latest_nav_value': nav, 'dmfm_latest_nav_date': day, 'dmfm_scheme_aum': aum,
            'dmfm_scheme_3_year_return': '13.4363', 'dmfm_category_ret_1_year_avg': '3.64',
            'dmfm_ms_rating': '0', 'dmfm_vr_rating': '4', 'dmfm_fund_manager': 'A|B', 'dmfm_sip_frequency': 'DAILY|MONTHLY',
            'dmfm_sip_flag': 'Y', 'dmfm_inception_date': '2013-05-24 00:00:00', **extra}


def isin(index):
    return f'INF{index:09d}'


class MutualFundTests(unittest.TestCase):
    def test_amfi_file_maps_both_isin_columns_and_skips_missing_navs(self):
        navs = mf.parse_amfi(AMFI)
        self.assertEqual(navs['INF879O01027'], {'code': '122639', 'nav': 93.9483, 'navDate': '2026-11-06'})
        self.assertEqual(navs['INF879O01043']['code'], '122640')
        self.assertNotIn('INF879O01050', navs)
        # The older six-column layout without plan and option.
        self.assertEqual(navs['INF179K01UT0'], {'code': '118955', 'nav': 2335.942, 'navDate': '2026-11-07'})

    def test_fund_record_parses_ratings_ranges_and_lists(self):
        record = mf.fund_record(row(isin(1), highlow="{'date_low': '2026-03-30', '52weekslow': 85.26, 'date_high': '2025-12-05', '52weekshigh': 95.37}"))
        self.assertIsNone(record['morningstarRating'])
        self.assertEqual(record['valueResearchRating'], 4)
        self.assertEqual(record['range52w'], {'high': 95.37, 'highDate': '2025-12-05', 'low': 85.26, 'lowDate': '2026-03-30'})
        self.assertEqual((record['fundManagers'], record['sipFrequencies'], record['sipAllowed'], record['inceptionDate']),
                         (['A', 'B'], ['daily', 'monthly'], True, '2013-05-24'))
        self.assertEqual(record['returns']['3y'], 13.4363)
        self.assertEqual(record['categoryReturns']['1y']['avg'], 3.64)
        self.assertEqual(mf.fund_record(row(isin(2), highlow={'52weekshigh': 1, 'date_high': 'x'}))['range52w']['highDate'], None)

    def test_snapshot_takes_amfi_navs_and_keeps_one_row_per_isin(self):
        rows = [row(isin(index)) for index in range(3)] + [row(isin(0), aum='5'), row('BAD'), row(isin(9), nav='')]
        amfi = {isin(0): {'code': '1', 'nav': 93.9483, 'navDate': '2026-11-06'},   # same day, agrees
                isin(1): {'code': '2', 'nav': 95.0, 'navDate': '2026-11-07'},      # newer: AMFI's NAV
                isin(2): {'code': '3', 'nav': 90.0, 'navDate': '2026-11-05'}}      # older: Dhan's stays
        with patch.object(mf, 'MIN_FUNDS', 3), patch.object(mf, 'MIN_NAV_COMPARISONS', 1):
            snapshot = mf.build_snapshot(rows, amfi, '2026-11-07T01:00:00+00:00')
        funds = {fund['isin']: fund for fund in snapshot['funds']}
        self.assertEqual(sorted(funds), [isin(0), isin(1), isin(2)])
        self.assertEqual(funds[isin(0)]['aumCrore'], 1000)
        self.assertEqual((funds[isin(1)]['nav'], funds[isin(1)]['navDate'], funds[isin(1)]['navSource'], funds[isin(1)]['returnsSource']),
                         (95.0, '2026-11-07', 'AMFI', 'Dhan'))
        self.assertEqual((funds[isin(2)]['nav'], funds[isin(2)]['navSource']), (93.9483, 'Dhan'))
        self.assertEqual(snapshot['navDate'], '2026-11-07')
        self.assertEqual(snapshot['navCheck'], {'amfiMatched': 3, 'sameDateCompared': 1, 'sameDateAgreed': 1, 'navFromAmfi': 2})

    def test_drops_funds_without_a_positive_nav_or_a_real_date(self):
        rows = [row(isin(0)), row(isin(1), nav='0'), row(isin(2), nav='-3'), row(isin(3), day='2026-02-31'), row(isin(4))]
        with patch.object(mf, 'MIN_FUNDS', 2):
            self.assertEqual([fund['isin'] for fund in mf.build_snapshot(rows, {}, 'now')['funds']], [isin(0), isin(4)])

    def test_a_truncated_amfi_file_is_treated_as_unavailable(self):
        rows = [row(isin(index)) for index in range(10)]
        partial = {isin(0): {'code': '1', 'nav': 99.0, 'navDate': '2026-11-07'}}
        with patch.object(mf, 'MIN_FUNDS', 10):
            snapshot = mf.build_snapshot(rows, partial, 'now')
        self.assertEqual(snapshot['navCheck']['amfiMatched'], 0)
        self.assertTrue(all(fund['navSource'] == 'Dhan' for fund in snapshot['funds']))

    def test_refuses_a_partial_universe_or_navs_that_disagree_with_amfi(self):
        rows = [row(isin(index)) for index in range(4)]
        with patch.object(mf, 'MIN_FUNDS', 5), self.assertRaisesRegex(ValueError, 'usable funds'):
            mf.build_snapshot(rows, {}, 'now')
        wrong = {isin(index): {'code': str(index), 'nav': 90.0, 'navDate': '2026-11-06'} for index in range(4)}
        with patch.object(mf, 'MIN_FUNDS', 4), patch.object(mf, 'MIN_NAV_COMPARISONS', 4), self.assertRaisesRegex(ValueError, 'agree for only 0 of 4'):
            mf.build_snapshot(rows, wrong, 'now')
        # Too few same-day pairs to judge: published, with the check recorded.
        with patch.object(mf, 'MIN_FUNDS', 4), patch.object(mf, 'MIN_NAV_COMPARISONS', 5):
            self.assertEqual(mf.build_snapshot(rows, wrong, 'now')['navCheck']['sameDateAgreed'], 0)


if __name__ == '__main__':
    unittest.main()
