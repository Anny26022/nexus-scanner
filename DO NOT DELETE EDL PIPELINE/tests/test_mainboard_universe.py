import sys
import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from filter_mainboard_universe import filter_mainboard_universe, filter_rows_by_symbol, reconcile_listed_universe, main


class MainboardUniverseTests(unittest.TestCase):
    def test_excludes_current_nse_sme_symbols_only(self):
        master = [
            {"Symbol": "MAIN", "ISIN": "INE000A01001"},
            {"Symbol": "smeone", "ISIN": "INE000A01002"},
            # A former SME that is absent from the current NSE SME feed is a
            # mainboard listing and must remain eligible.
            {"Symbol": "UPGRADED", "ISIN": "INE000A01003"},
        ]
        sme = [{"Symbol": "SMEONE", "Series": "SM"}]

        mainboard, symbols = filter_mainboard_universe(master, sme)

        self.assertEqual(symbols, {"SMEONE"})
        self.assertEqual([row["Symbol"] for row in mainboard], ["MAIN", "UPGRADED"])

    def test_filters_raw_scanx_rows_to_the_canonical_mainboard_set(self):
        rows = [{"Sym": "MAIN", "Mcap": 10}, {"Sym": "smeone", "Mcap": 1}]
        result = filter_rows_by_symbol(rows, {"MAIN"}, "Sym")
        self.assertEqual(result, [{"Sym": "MAIN", "Mcap": 10}])

    def test_reconciliation_excludes_unlisted_but_retains_listed_identity_mismatches(self):
        master = [
            {'Symbol': 'LIVE', 'ISIN': 'INE000A01001'},
            {'Symbol': 'STALE', 'ISIN': 'INE000A01002'},
            {'Symbol': 'CHANGED', 'ISIN': 'INE000A01003'},
            {'Symbol': 'MISSING'},
        ]
        nse = [
            {'SYMBOL': 'LIVE', 'ISIN NUMBER': 'INE000A01001'},
            {'SYMBOL': 'CHANGED', 'ISIN NUMBER': 'INE000A01004'},
            {'SYMBOL': 'MISSING', 'ISIN NUMBER': 'INE000A01005'},
        ]
        retained, excluded, mismatches = reconcile_listed_universe(master, nse)
        self.assertEqual(retained, [master[0], master[2], master[3]])
        self.assertEqual(excluded, [
            {'symbol': 'STALE', 'isin': 'INE000A01002', 'reason': 'absent_from_nse_equity_list'},
        ])
        self.assertEqual(mismatches, [
            {'symbol': 'CHANGED', 'isin': 'INE000A01003', 'nse_isin': 'INE000A01004', 'reason': 'isin_mismatch'},
            {'symbol': 'MISSING', 'isin': '', 'nse_isin': 'INE000A01005', 'reason': 'missing_provider_isin'},
        ])

    def test_truncated_listing_rejected_before_outputs_and_five_percent_allowed(self):
        master = [{'Symbol': f'S{i}', 'ISIN': f'INE{i:09d}'} for i in range(100)]
        master.append({'Symbol': 'SME', 'ISIN': 'INE999999999'})
        raw = [{'Sym': row['Symbol']} for row in master]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'nse_equity_list.csv'
            for missing in (50, 6, 5):
                with self.subTest(missing=missing):
                    path.write_text('SYMBOL,ISIN NUMBER\n' + ''.join(
                        f"{row['Symbol']},{row['ISIN']}\n" for row in master[:100 - missing]))
                    with patch('filter_mainboard_universe.load_json', side_effect=[master, [{'Symbol': 'SME'}], raw]), \
                            patch('filter_mainboard_universe.resolve_path', return_value=path), \
                            patch('filter_mainboard_universe.save_json') as save:
                        if missing > 5:
                            with self.assertRaisesRegex(ValueError, f'{missing}/100 symbols absent'):
                                main()
                            save.assert_not_called()
                        else:
                            self.assertTrue(main())
                            self.assertEqual(len(save.call_args_list[0].args[1]), 95)
                            self.assertEqual(save.call_args_list[-1].args[1]['excluded_unlisted_count'], 5)


if __name__ == "__main__":
    unittest.main()
