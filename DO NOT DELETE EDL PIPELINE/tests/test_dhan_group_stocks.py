import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import requests
import sync_dhan_group_stocks as sync


def row(isin='ISIN1', symbol='AAA', exchange='NSE', name='Company'):
    return {'Isin': isin, 'Sym': symbol, 'DispSym': name, 'Exch': exchange}


def response(rows, *, total=None, pages=1):
    return {'code': 0, 'tot_rec': len(rows) if total is None else total, 'tot_pg': pages, 'data': rows}


class DhanGroupStocksTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.output = Path(self.folder.name) / 'membership.json'
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(sync, 'GROUPS', [('test-group', 'Test Group', 'TEST')]))
        self.log = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def refresh(self, nse=None, bse=None):
        with patch.object(sync, 'post_json', side_effect=[response(nse or [row()]), response(bse or [])]):
            return sync.sync_group_stocks(self.output)

    def test_prefers_nse_retains_bse_only_and_stores_membership_once(self):
        self.refresh([row('ISIN2', 'NSE2'), row()],
                     [row('ISIN2', 'BSE2', 'BSE'), row('ISIN3', 'BSE3', 'BSE')])
        data = json.loads(self.output.read_text())
        stocks = data['groups']['test-group']['stocks']
        self.assertEqual([s['isin'] for s in stocks], ['ISIN1', 'ISIN2', 'ISIN3'])
        self.assertEqual(stocks[1]['symbol'], 'NSE2')
        self.assertEqual(stocks[2]['exchange'], 'BSE')
        self.assertEqual(set(data), {'source', 'groups'})
        self.assertEqual(set(stocks[0]), {'isin', 'symbol', 'name', 'exchange'})

    def test_unchanged_refresh_preserves_bytes_and_mtime_despite_order_and_prices(self):
        self.refresh([row('ISIN2'), row()])
        before = self.output.read_bytes(), self.output.stat().st_mtime_ns
        changed_metrics = [{**row(), 'Ltp': 999}, row('ISIN2')]
        with patch.object(sync, 'save_json') as save:
            self.assertFalse(self.refresh(changed_metrics))
            save.assert_not_called()
        self.assertEqual((self.output.read_bytes(), self.output.stat().st_mtime_ns), before)

    def test_reports_additions_removals_and_identity_updates(self):
        self.refresh([row(), row('ISIN2')])
        self.log.truncate(0)
        self.log.seek(0)
        self.refresh([row(symbol='RENAMED'), row('ISIN3')])
        self.assertIn('+1 added, -1 removed, 1 identities updated', self.log.getvalue())
        self.assertIn('Added: ISIN3', self.log.getvalue())
        self.assertIn('Removed: ISIN2', self.log.getvalue())
        self.assertIn('Updated: ISIN1', self.log.getvalue())
        self.assertEqual(json.loads(self.output.read_text())['groups']['test-group']['stocks'][0]['symbol'], 'RENAMED')

    def test_failure_after_a_complete_group_preserves_previous_file(self):
        self.refresh()
        before = self.output.read_bytes()
        cases = [
            None, {'status': 'error'}, response([]),
            {**response([row()]), 'code': 1},
            {**response([row()]), 'data': {}},
            {**response([row()]), 'tot_rec': None},
            response([row()], total=2), response([row()], pages=0),
            response([{**row(), 'Isin': ''}]),
            response([row(exchange='BSE')]),
            response([row(), row()]),
            requests.Timeout('timed out'),
        ]
        with patch.object(sync, 'GROUPS', sync.GROUPS + [('other-group', 'Other Group', 'OTHER')]):
            for bad in cases:
                with self.subTest(bad=bad), patch.object(sync, 'post_json', side_effect=[response([row()]), response([]), bad, response([])]):
                    with self.assertRaises((ValueError, requests.Timeout)):
                        sync.sync_group_stocks(self.output)
                    self.assertEqual(self.output.read_bytes(), before)

    def test_empty_existing_exchange_is_rejected_even_if_other_exchange_succeeds(self):
        self.refresh()
        before = self.output.read_bytes()
        with patch.object(sync, 'post_json', side_effect=[response([]), response([row(exchange='BSE')])]):
            with self.assertRaisesRegex(ValueError, 'refusing to clear'):
                sync.sync_group_stocks(self.output)
        self.assertEqual(self.output.read_bytes(), before)

    def test_empty_new_group_does_not_create_a_file(self):
        with patch.object(sync, 'post_json', return_value=response([])):
            with self.assertRaisesRegex(ValueError, 'empty group'):
                sync.sync_group_stocks(self.output)
        self.assertFalse(self.output.exists())

    def test_fetches_all_reported_pages(self):
        pages = [response([row()], total=2, pages=2), response([row('ISIN2')], total=2, pages=2)]
        with patch.object(sync, 'post_json', side_effect=pages) as post:
            self.assertEqual(set(sync.fetch_exchange('TEST', 'NSE')), {'ISIN1', 'ISIN2'})
        self.assertEqual([call.args[1]['data']['pgno'] for call in post.call_args_list], [1, 2])
        self.assertTrue(all(call.kwargs == {'include_origin': True, 'timeout': 30} for call in post.call_args_list))

    def test_rejects_repeated_missing_or_changing_pages(self):
        first = response([row()], total=2, pages=2)
        for second in (first, response([], total=2, pages=2), response([row('ISIN2')], total=3, pages=2)):
            with self.subTest(second=second), patch.object(sync, 'post_json', side_effect=[first, second]):
                with self.assertRaises(ValueError):
                    sync.fetch_exchange('TEST', 'NSE')
