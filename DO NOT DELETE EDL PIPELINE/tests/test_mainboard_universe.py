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
                    path.write_text('SYMBOL,ISIN NUMBER,DATE OF LISTING\n' + ''.join(
                        f"{row['Symbol']},{row['ISIN']},01-JAN-2000\n" for row in master[:100 - missing]))
                    with patch('filter_mainboard_universe.nse_calendar_date', return_value='2026-10-08'), \
                            patch('filter_mainboard_universe.load_json', side_effect=[master, [{'Symbol': 'SME'}], raw,
                                  {'as_of_date': '2026-10-07', 'retrieved_at': '2026-10-08T09:33:00+05:30'}]), \
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

    def test_session_cutoff_filters_outputs_reports_deferrals_and_readmits_on_listing_day(self):
        master = [{'Symbol': symbol, 'ISIN': f'INE{i}', 'Sid': i}
                  for i, symbol in enumerate(('OLD', 'BOUNDARY', 'NITYAS', 'VNL', 'SME'), 1)]
        raw = [{'Sym': row['Symbol']} for row in master]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'nse_equity_list.csv'
            path.write_text('SYMBOL,ISIN NUMBER,DATE OF LISTING\n'
                            'OLD,INE1,06-OCT-2026\nBOUNDARY,INE2,07-OCT-2026\n'
                            'NITYAS,INE3,08-OCT-2026\nVNL,INE4,08-OCT-2026\n')
            for session in ('2026-10-07', '2026-10-08'):
                with self.subTest(session=session), \
                        patch('filter_mainboard_universe.nse_calendar_date', return_value='2026-10-08'), \
                        patch('filter_mainboard_universe.load_json', side_effect=[master, [{'Symbol': 'SME'}], raw,
                              {'as_of_date': session, 'retrieved_at': '2026-10-08T09:33:00+05:30'}]), \
                        patch('filter_mainboard_universe.resolve_path', return_value=path), \
                        patch('filter_mainboard_universe.save_json') as save:
                    self.assertTrue(main())
                    kept = ['OLD', 'BOUNDARY'] if session == '2026-10-07' else ['OLD', 'BOUNDARY', 'NITYAS', 'VNL']
                    self.assertEqual([r['Symbol'] for r in save.call_args_list[0].args[1]], kept)
                    self.assertEqual([r['Sym'] for r in save.call_args_list[1].args[1]], kept)
                    report = save.call_args_list[-1].args[1]
                    self.assertEqual(report['session_date'], session)
                    self.assertEqual(report['excluded_unlisted_count'], 0)
                    self.assertEqual(report['deferred_listing_count'], 2 if session == '2026-10-07' else 0)
                    if session == '2026-10-07':
                        self.assertEqual(report['deferred_listings'], [
                            {'symbol': 'NITYAS', 'isin': 'INE3', 'listing_date': '2026-10-08', 'reason': 'listing_after_session'},
                            {'symbol': 'VNL', 'isin': 'INE4', 'listing_date': '2026-10-08', 'reason': 'listing_after_session'},
                        ])

    def test_stale_or_missing_session_stops_filtering_before_any_output(self):
        master = [{'Symbol': symbol} for symbol in ('NITYAS', 'SME')]
        for staged in ({}, {'as_of_date': '2026-10-07'},
                       {'as_of_date': '2026-10-07', 'retrieved_at': '2026-10-07T09:33:00+05:30'},
                       {'as_of_date': '2026-10-09', 'retrieved_at': '2026-10-08T09:33:00+05:30'}):
            with self.subTest(staged=staged), \
                    patch('filter_mainboard_universe.nse_calendar_date', return_value='2026-10-08'), \
                    patch('filter_mainboard_universe.load_json', side_effect=[master, [{'Symbol': 'SME'}],
                          [{'Sym': 'NITYAS'}, {'Sym': 'SME'}], staged]), \
                    patch('filter_mainboard_universe.resolve_path') as resolve, \
                    patch('filter_mainboard_universe.save_json') as save:
                with self.assertRaises(ValueError):
                    main()
                resolve.assert_not_called()
                save.assert_not_called()

    def test_invalid_listing_date_does_not_silently_defer_or_admit_stock(self):
        with self.assertRaises(ValueError):
            reconcile_listed_universe([{'Symbol': 'TEST', 'ISIN': 'INE1'}],
                [{'SYMBOL': 'TEST', 'ISIN NUMBER': 'INE1', 'DATE OF LISTING': 'invalid'}], '2026-10-07')


if __name__ == "__main__":
    unittest.main()
