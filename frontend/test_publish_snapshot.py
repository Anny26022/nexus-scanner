import gzip
from contextlib import ExitStack, nullcontext
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import pandas as pd
import scanner_bridge as bridge
from publish_snapshot import publish, delivery_lookback
from session_history import archive_daily_snapshot, register_session
from scanner_cache import ScannerCache
from edl_pipeline.scanner import context, trend
from edl_pipeline.scanner.calculation_cache import memoized


class SnapshotPublicationTests(unittest.TestCase):
    def test_archived_dates_survive_rollover_and_same_date_reruns(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'EDL_CHART_STORAGE': 'local'}):
            output = Path(folder)
            for session, revision in [('2026-10-19', 'a'*64), ('2026-10-21', 'b'*64), ('2026-10-21', 'c'*64)]:
                source = output/'revisions'/revision/'stocks.json.gz'
                source.parent.mkdir(parents=True)
                source.write_bytes(gzip.compress(revision.encode(), mtime=0))
                entry = archive_daily_snapshot(output, {'sessionDate': session, 'revision': revision})
                register_session(output/'sessions.json', entry)
            sessions = json.loads((output/'sessions.json').read_text())['sessions']
            self.assertEqual([(s['date'], s['revision']) for s in sessions],
                             [('2026-10-21', 'b'*64), ('2026-10-19', 'a'*64)])
            for session, revision in [('2026-10-19', 'a'*64), ('2026-10-21', 'b'*64)]:
                self.assertEqual(gzip.decompress((output/f'snapshots/{session}.json.gz').read_bytes()), revision.encode())

    def test_unverified_or_conflicting_archive_is_never_registered(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder); source = output/'revisions'/('a'*64)/'stocks.json.gz'
            source.parent.mkdir(parents=True); source.write_bytes(b'original')
            manifest = {'sessionDate': '2026-10-21', 'revision': 'a'*64}
            store = Mock(); store.cache_command.return_value = b'corrupted'
            with patch.dict('os.environ', {'EDL_CHART_STORAGE': 'r2'}), \
                    patch('session_history.R2Store', return_value=store), patch('session_history.charts_enabled', return_value=True):
                with self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
                    archive_daily_snapshot(output, manifest)
            with patch.dict('os.environ', {'EDL_CHART_STORAGE': 'local'}):
                archive_daily_snapshot(output, manifest)
                source.write_bytes(b'different')
                with self.assertRaisesRegex(RuntimeError, 'Conflicting daily snapshot'):
                    archive_daily_snapshot(output, manifest)
            self.assertFalse((output/'sessions.json').exists())

    def test_failed_daily_archive_preserves_current_pointer_and_sessions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)/'edl'; root.mkdir(); output = Path(folder)/'public'; self.fixture(root)
            publish(root, output)
            before = {name: (output/name).read_bytes() for name in ('current.json', 'sessions.json')}
            with patch('publish_snapshot.archive_daily_snapshot', side_effect=RuntimeError('read-back mismatch')):
                with self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
                    publish(root, output)
            for name, data in before.items():
                self.assertEqual((output/name).read_bytes(), data)

    def test_daily_publication_carries_aligned_tradingview_fields_through_both_wire_formats(self):
        from test_packed_snapshot import decode_packed_snapshot
        with tempfile.TemporaryDirectory() as folder, patch('publish_snapshot.list_presets', return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl'; root.mkdir(); output=Path(folder)/'public'; self.fixture(root)
            source=root/'all_stocks_fundamental_analysis.json.gz'
            stocks=json.loads(gzip.decompress(source.read_bytes()))
            stocks[0]['tradingview_snapshot'] = {'source':'https://scanner.tradingview.com/india/scan',
                'as_of_date':'2026-09-30', 'fetched_at':'2026-09-30T12:00:00Z',
                'update_mode':'delayed_streaming_900','currency':'INR','financial_currency':'INR',
                'exchange':'NSE','is_primary':True,'primary_exchange':'NSE','listing_symbol':'NSE:TEST',
                'market':{'rvol10':2.5,'turnover30_crore':5,'adr14_pct':1.5},
                'financials':{'pe_ttm':25.4},'technicals':{'ema5':99}}
            source.write_bytes(gzip.compress(json.dumps(stocks).encode()))
            manifest=publish(root,output)
            path=output/'revisions'/manifest['revision']
            payload=json.loads((path/'stocks.json').read_text())
            sessions=json.loads((output/'sessions.json').read_text())['sessions']
            self.assertEqual(sessions[0]['date'], manifest['sessionDate'])
            self.assertEqual(sessions[0]['revision'], manifest['revision'])
            self.assertEqual((output/'snapshots'/f"{manifest['sessionDate']}.json.gz").read_bytes(),
                             (path/'stocks.json.gz').read_bytes())
            self.assertEqual(payload['extendedMetricsVersion'],1)
            self.assertNotIn('source', payload['stocks'][0]['extended'])
            self.assertNotIn(b'tradingview', (path/'stocks.json').read_bytes().lower())
            self.assertEqual(payload['stocks'][0]['extended']['exchange'],'NSE')
            self.assertIs(payload['stocks'][0]['extended']['isPrimary'],True)
            self.assertEqual(payload['stocks'][0]['extended']['primaryExchange'],'NSE')
            self.assertEqual(payload['stocks'][0]['extended']['listingSymbol'],'NSE:TEST')
            values=payload['stocks'][0]['extended']['values']
            self.assertEqual(values['market.rvol10'],2.5)
            self.assertEqual(values['market.turnover30_crore'],5)
            self.assertEqual(values['market.adr14_pct'],1.5)
            self.assertEqual(values['technicals.ema5'],99)
            self.assertEqual(values['financials.pe_ttm'],25.4)
            # Verify intelligent fallback populated the primary row!
            self.assertEqual(payload['stocks'][0]['peRatio'],25.4)
            with gzip.open(path/'chart-directory.json.gz','rt') as handle:
                directory = json.load(handle)
            self.assertEqual(directory['revision'], manifest['revision'])
            self.assertEqual(directory['asOfDate'], manifest['sessionDate'])
            self.assertEqual(directory['stocks'][0]['symbol'], payload['stocks'][0]['symbol'])
            self.assertEqual(directory['stocks'][0]['marketCapCrore'], payload['stocks'][0]['marketCapCrore'])
            self.assertNotIn('extended', directory['stocks'][0])
            self.assertTrue(manifest['chartDirectoryUrl'].endswith('/chart-directory.json.gz'))
            with gzip.open(path/'stocks.packed.json.gz','rt') as handle:
                self.assertEqual(decode_packed_snapshot(json.load(handle)),payload)

    def test_tradingview_publication_never_relabels_stale_dates_or_foreign_amounts(self):
        from publish_snapshot import tradingview_row
        source={'source':'https://scanner.tradingview.com/india/scan','as_of_date':'2026-09-29',
                'currency':'INR','financial_currency':'USD','financials':{'total_debt_fy_crore':100}}
        self.assertIsNone(tradingview_row({'tradingview_snapshot':source},'2026-09-30'))
        source['as_of_date']='2026-09-30'
        result=tradingview_row({'tradingview_snapshot':source},'2026-09-30')
        self.assertIsNone(result['values']['financials.total_debt_fy_crore'])

    def test_delivery_window_is_derived_from_nested_and_legacy_rule_inputs(self):
        expressions = [bridge.group('AND',
            bridge.leaf('DELIVERY_PCT_SPIKE', withinDays=3, minDeliverablePct=60),
            {'type': 'not', 'child': {'type': 'preset', 'expression':
                {'condition': 'delivery_percent_spike', 'fired_within': 8, 'minimum_delivery_percent': 60}}},
            bridge.leaf('DELIVERY_PERCENT', value=50, comparison='ABOVE'))]
        self.assertEqual(delivery_lookback(expressions), 8)
        self.assertEqual(delivery_lookback([bridge.leaf('DELIVERY_PERCENT', fired_within=99)]), 1)
        self.assertEqual(delivery_lookback([bridge.leaf('NEW_HIGH')]), 0)
        for invalid in (0, -1, None, 'invalid', float('inf')):
            self.assertIsNone(delivery_lookback([bridge.leaf('DELIVERY_PCT_SPIKE', fired_within=invalid)]))

    def test_bounded_delivery_preserves_complete_publication_and_frozen_history(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'edl'; root.mkdir(); self.fixture(root)
            official = root / 'delivery_history_data'
            # Old files can contain current dates, and gzip rows can override JSON rows.
            historical = {'records': [
                {'symbol': 'TEST', 'date': '2020-01-01', 'delivery_percent': 30},
                {'symbol': 'OTHER', 'date': '2026-09-30', 'delivery_percent': 55},
                {'symbol': 'TEST', 'date': '2026-09-29', 'delivery_percent': 65},
            ]}
            (official / '2000-01-01.json').write_text(json.dumps(historical))
            (official / '2026-09-30.json.gz').write_bytes(gzip.compress(json.dumps({'records': [
                {'symbol': 'TEST', 'date': '2026-09-30', 'delivery_percent': None},
            ]}).encode(), mtime=0))
            (official / '2000-01-02.json').write_bytes(b'\xef\xbb\xbf{"records":[]}')
            fallback = root / 'eod2_delivery_history_data'; fallback.mkdir()
            (fallback / 'TEST.csv').write_text('Date,delivery_percent\n2020-01-01,99\n2026-09-28,71\n2026-09-30,99\n')
            original_loader = bridge._load_delivery_history
            histories = []
            def observe(*args, **kwargs):
                result = original_loader(*args, **kwargs); histories.append(result)
                return result
            baseline_output, bounded_output = Path(folder) / 'baseline', Path(folder) / 'bounded'
            with patch.object(bridge, '_load_delivery_history', side_effect=observe):
                with patch('publish_snapshot.delivery_lookback', return_value=None):
                    baseline = publish(root, baseline_output)
                bounded = publish(root, bounded_output)
            self.assertLess(sum(map(len, histories[1].values())), sum(map(len, histories[0].values())))
            self.assertEqual(bounded, baseline)
            def files(output):
                return {str(path.relative_to(output)): path.read_bytes()
                        for path in output.rglob('*') if path.is_file()}
            self.assertEqual(files(bounded_output), files(baseline_output))
            backend = root / '.scanner_cache/revisions' / bounded['revision']
            self.assertEqual((backend / 'eod2_delivery_history_data/TEST.csv').read_bytes(), (fallback / 'TEST.csv').read_bytes())
            self.assertEqual(gzip.decompress((backend / 'delivery_history_data/2000-01-01.json.gz').read_bytes()),
                             (official / '2000-01-01.json').read_bytes())

    def test_calculation_reuse_preserves_all_presets_and_publication_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'edl'; root.mkdir()
            self.fixture(root)
            # Include sufficient full history and non-flat candles to exercise
            # all 45 presets, moving averages and persistence modes.
            import numpy as np
            close = 100 + np.arange(300) / 10 + np.sin(np.arange(300) / 7) * 5
            frame = pd.DataFrame({'Date': pd.bdate_range(end='2026-09-30', periods=300),
                                  'Open': close, 'High': close + 2, 'Low': close - 2,
                                  'Close': close, 'Volume': 100.})
            frame.to_csv(root / 'ohlcv_data/TEST.csv', index=False)
            baseline_output, cached_output = Path(folder) / 'baseline', Path(folder) / 'cached'
            with ExitStack() as stack:
                calculations = {}
                for module, name in ((trend, '_ma'), (trend, '_extreme_run'),
                                     (context, '_aligned_relative_strength')):
                    implementation = Mock(wraps=getattr(module, name).__wrapped__)
                    stack.enter_context(patch.object(module, name, memoized(implementation)))
                    calculations[name] = implementation
                with patch('publish_snapshot.calculation_cache', side_effect=nullcontext):
                    baseline = publish(root, baseline_output)
                baseline_calls = {name: spy.call_count for name, spy in calculations.items()}
                for spy in calculations.values():
                    spy.reset_mock()
                cached = publish(root, cached_output)
                for name, spy in calculations.items():
                    self.assertGreater(spy.call_count, 0, name)
                    self.assertLess(spy.call_count, baseline_calls[name], name)
            self.assertEqual(cached, baseline)
            def files(output):
                return {str(path.relative_to(output)): path.read_bytes()
                        for path in output.rglob('*') if path.is_file()}
            self.assertEqual(files(cached_output), files(baseline_output))

    def test_publishes_rule_only_signal_even_when_eligibility_fails(self):
        with tempfile.TemporaryDirectory() as folder, patch('publish_snapshot.list_presets', return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl'; root.mkdir(); output=Path(folder)/'public'; self.fixture(root, cap=100)
            path = root/'ohlcv_data/TEST.csv'
            frame = pd.read_csv(path)
            frame.loc[frame.index[-1], ['Open','High','Low','Close']] = [110,113,109,112]
            frame.to_csv(path, index=False)
            manifest = publish(root, output)
            payload = json.loads((output/'revisions'/manifest['revision']/'stocks.json').read_text())
            row = payload['stocks'][0]
            self.assertTrue(row['presetRuleMatches']['lib-easy-money'])
            self.assertFalse(row['presetMatches']['lib-easy-money'])
            # The packed wire format retains the new results without changing schemas.
            from test_packed_snapshot import decode_packed_snapshot
            with gzip.open(output/'revisions'/manifest['revision']/'stocks.packed.json.gz', 'rt') as handle:
                self.assertEqual(decode_packed_snapshot(json.load(handle)), payload)

    def test_publishes_ownership_values_and_preserves_old_revision(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            source=root/'all_stocks_fundamental_analysis.json.gz'
            with gzip.open(source,'rt') as handle:
                stocks=json.load(handle)
            stocks[0].update(promoter_holding_percent=50.48,fii_percent_change_qoq=-1.47,dii_percent_change_qoq=0.0)
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            first=publish(root,output)
            original=output/'revisions'/first['revision']/'stocks.json.gz'  # the superseded revision keeps only compressed stocks files
            original_bytes=original.read_bytes()
            row=json.loads(gzip.decompress(original_bytes))['stocks'][0]
            self.assertEqual(row['promoterHoldingPct'],50.48)
            self.assertEqual(row['fiiChangePctQoq'],-1.47)
            self.assertEqual(row['diiChangePctQoq'],0.0)
            symbol_file=output/first['financialHistoryUrlTemplate'].replace('{symbol}', 'TEST').removeprefix('/data/')
            with gzip.open(symbol_file,'rt') as handle:
                self.assertEqual(json.load(handle), stocks[0]['financial_statement_history'])
            stocks[0].update(promoter_holding_percent=None,fii_percent_change_qoq=None,dii_percent_change_qoq=2.25)
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            second=publish(root,output)
            row=json.loads((output/'revisions'/second['revision']/'stocks.json').read_text())['stocks'][0]
            self.assertIsNone(row['promoterHoldingPct'])
            self.assertIsNone(row['fiiChangePctQoq'])
            self.assertEqual(row['diiChangePctQoq'],2.25)
            self.assertNotEqual(first['revision'],second['revision'])
            self.assertEqual(original.read_bytes(),original_bytes)
            self.assertFalse((output/'revisions'/first['revision']/'stocks.json').exists())

    def fixture(self, root, cap=5000):
        stocks=[{'symbol':'TEST','name':'Test','close':100,'open':99,'high':101,'low':98,'volume':200,'as_of_date':'2026-09-30',
                 'market_cap_crore':cap,'daily_rupee_turnover_50_cr':10,'circuit_limit':'20','listing_series':'EQ','index_memberships':[]}]
        files={'all_stocks_fundamental_analysis.json.gz':stocks,'market_breadth_v2.json.gz':{'records':[{'date':'2026-09-30'}]},
               'quarterly_financial_history.json.gz':{'records':[]},'earnings_calendar.json.gz':{'source':'BSE forthcoming results calendar','fetched_at':'2026-10-01T00:00:00+00:00','events':[],'available':True},'ipo_screener.json.gz':{'records':[], 'provider_data':{'analytics':{'year_summary':{'year':'2026'}}}}}
        for name,value in files.items():
            with gzip.open(root/name,'wt') as handle: json.dump(value,handle)
        charts=root/'chart_artifacts';charts.mkdir(exist_ok=True)
        (charts/'TEST.json.gz').write_bytes(gzip.compress(json.dumps({'symbol':'TEST','asOfDate':'2026-09-30'}).encode(),mtime=0))
        (charts/'index.json').write_text(json.dumps({'symbols':1,'asOfDate':'2026-09-30'}))
        (root/'ohlcv_data').mkdir(exist_ok=True)
        delivery = root/'delivery_history_data'; delivery.mkdir(exist_ok=True)
        (delivery/'2026-09-30.json').write_text(json.dumps({'date':'2026-09-30','records':[
            {'symbol':'TEST','date':'2026-09-30','delivery_percent':60.0}
        ]}))
        frame=pd.DataFrame({'Date':pd.bdate_range(end='2026-09-30',periods=60),'Open':99.,'High':101.,'Low':98.,'Close':100.,'Volume':100.})
        frame.to_csv(root/'ohlcv_data/TEST.csv',index=False)

    def test_publishes_ownership_values_and_preserves_old_revision(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            source=root/'all_stocks_fundamental_analysis.json.gz'
            with gzip.open(source,'rt') as handle:
                stocks=json.load(handle)
            stocks[0].update(promoter_holding_percent=50.48,fii_percent_change_qoq=-1.47,dii_percent_change_qoq=0.0)
            stocks[0].update(cwip_crore=237686,pb_ratio=1.8247,ev_ebitda=24.91,
                             total_income_in_lakhs=31601800,total_tax_expenses_in_lakhs=743400,
                             debt_to_equity=0.44,financial_units_version=1,debt_to_equity_source='SCANX_Debt2Eq')
            stocks[0]['financial_statement_history'] = {'source': 'ScanX', 'observed_on': '2026-09-30',
                'quarterly': [{'period_end': '2026-06-30', 'revenue': 120}], 'annual': []}
            stocks[0]['ttm_revenue_growth_percent'] = 20
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            first=publish(root,output)
            original=output/'revisions'/first['revision']/'stocks.json.gz'  # the superseded revision keeps only compressed stocks files
            original_bytes=original.read_bytes()
            row=json.loads(gzip.decompress(original_bytes))['stocks'][0]
            self.assertEqual(row['promoterHoldingPct'],50.48)
            self.assertEqual(row['fiiChangePctQoq'],-1.47)
            self.assertEqual(row['diiChangePctQoq'],0.0)
            self.assertEqual(row['cwipCrore'],237686)
            self.assertEqual(row['pbRatio'],1.8247)
            self.assertEqual(row['evEbitda'],24.91)
            self.assertEqual(row['totalIncomeLakh'],31601800)
            self.assertEqual(row['totalTaxExpensesLakh'],743400)
            self.assertEqual(row['debtToEquity'],0.44)
            self.assertEqual(row['financialUnitsVersion'],1)
            self.assertEqual(row['debtToEquitySource'],'SCANX_Debt2Eq')
            self.assertEqual(row['ttmRevenueGrowthPct'],20)
            self.assertEqual(row['financialHistoryObservedOn'],'2026-09-30')
            self.assertNotIn('financialStatementHistory',row)
            self.assertEqual(json.loads((output/'current.json').read_text())['financialHistoryUrl'],first['financialHistoryUrl'])
            history_file=output/first['financialHistoryUrl'].removeprefix('/data/')
            with gzip.open(history_file,'rt') as handle:
                self.assertEqual(json.load(handle)['TEST'],stocks[0]['financial_statement_history'])
            symbol_file=output/first['financialHistoryUrlTemplate'].replace('{symbol}', 'TEST').removeprefix('/data/')
            with gzip.open(symbol_file,'rt') as handle:
                self.assertEqual(json.load(handle), stocks[0]['financial_statement_history'])
            stocks[0].update(promoter_holding_percent=None,fii_percent_change_qoq=None,dii_percent_change_qoq=2.25)
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            second=publish(root,output)
            row=json.loads((output/'revisions'/second['revision']/'stocks.json').read_text())['stocks'][0]
            self.assertIsNone(row['promoterHoldingPct'])
            self.assertIsNone(row['fiiChangePctQoq'])
            self.assertEqual(row['diiChangePctQoq'],2.25)
            self.assertNotEqual(first['revision'],second['revision'])
            self.assertEqual(original.read_bytes(),original_bytes)

    def test_same_session_correction_creates_new_revision_and_old_backend_stays_frozen(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            first=publish(root,output)
            payload = json.loads((output/'revisions'/first['revision']/'stocks.json').read_text())
            self.assertEqual(payload['presetRuleMatchesVersion'], 1)
            self.assertEqual(set(payload['stocks'][0]['presetRuleMatches']), set(payload['stocks'][0]['presetMatches']))
            self.assertEqual(first['themeClassificationUrl'], f"/data/revisions/{first['revision']}/theme-classification.json.gz")
            with gzip.open(output/'revisions'/first['revision']/'theme-classification.json.gz', 'rt') as handle:
                taxonomy = json.load(handle)
            self.assertEqual(taxonomy['version'], first['themeClassificationVersion'])
            self.assertEqual(taxonomy['asOfDate'], first['sessionDate'])
            self.assertIn('TEST', taxonomy['records'])
            self.assertEqual(first['universeClassificationUrl'], f"/data/revisions/{first['revision']}/universe-classification.json")
            combined = json.loads((output/'revisions'/first['revision']/'universe-classification.json').read_text())
            self.assertEqual(combined['asOfDate'], first['sessionDate'])
            self.assertEqual(combined['records']['TEST']['thematic'], taxonomy['records']['TEST'])
            self.assertIn('basicIndustry', combined['records']['TEST'])
            self.assertEqual(combined['records']['TEST']['nicheTags'], [])
            with gzip.open(output/'revisions'/first['revision']/'ipos.json.gz','rt') as handle:
                self.assertEqual(json.load(handle)['provider_data']['analytics']['year_summary']['year'], '2026')
            self.assertTrue((output/'revisions'/first['revision']/'earnings-calendar.json.gz').exists())
            with gzip.open(output/'revisions'/first['revision']/'earnings-calendar.json.gz','rt') as handle:
                self.assertEqual(json.load(handle),{'fetched_at':'2026-10-01T00:00:00+00:00','events':[],'available':True})
            self.assertEqual(first['earningsCalendarUrl'], f"/data/revisions/{first['revision']}/earnings-calendar.json.gz")
            self.fixture(root,cap=6000)
            second=publish(root,output)
            compressed=(output/'revisions'/second['revision']/'stocks.json.gz').read_bytes()
            self.assertEqual(gzip.decompress(compressed),(output/'revisions'/second['revision']/'stocks.json').read_bytes())
            self.assertEqual(second['datasetPackedGzipUrl'], f"/data/revisions/{second['revision']}/stocks.packed.json.gz")
            from test_packed_snapshot import decode_packed_snapshot
            packed = json.loads(gzip.decompress((output/'revisions'/second['revision']/'stocks.packed.json.gz').read_bytes()))
            self.assertEqual(decode_packed_snapshot(packed), json.loads((output/'revisions'/second['revision']/'stocks.json').read_text()))
            self.assertEqual(second['datasetGzipUrl'],f"/data/revisions/{second['revision']}/stocks.json.gz")
            self.assertNotEqual(first['revision'],second['revision'])
            self.assertEqual(json.loads((output/'current.json').read_text())['revision'],second['revision'])
            request={'asOfDate':'2026-09-30','universe':'mainboard','expressionTree':{'type':'group','operator':'all','children':[]},'datasetRevision':first['revision']}
            old=bridge.run(request,root,ScannerCache())
            new=bridge.run({**request,'datasetRevision':second['revision']},root,ScannerCache())
            self.assertEqual(old['rows'][0]['marketCapCrore'],5000)
            self.assertEqual(new['rows'][0]['marketCapCrore'],6000)
            self.assertTrue((root/'.scanner_cache/revisions'/second['revision']/'delivery_history_data/2026-09-30.json.gz').exists())

    def test_taxonomy_metadata_preserves_themes_and_resource_changes_version_the_release(self):
        from pipeline_utils import resource_path
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'edl'; root.mkdir()
            output = Path(folder) / 'public'; self.fixture(root)
            source = root / 'all_stocks_fundamental_analysis.json.gz'
            with gzip.open(source, 'rt') as handle:
                stocks = json.load(handle)
            stocks[0].update(sector='IT Software', industry='IT Enabled Services', niche_tags=['Enterprise Services'],
                             provider_sector='Information Technology', provider_industry='IT Enabled Services')
            with gzip.open(source, 'wt') as handle:
                json.dump(stocks, handle)
            resource = Path(folder) / 'taxonomy_overrides.json'
            resource.write_bytes(resource_path(resource.name).read_bytes())
            with patch('publish_snapshot.resource_path', side_effect=lambda name: resource if name == resource.name else resource_path(name)):
                first = publish(root, output)
                original = output / 'revisions' / first['revision'] / 'stocks.json.gz'  # the superseded revision keeps only compressed stocks files
                original_bytes = original.read_bytes()
                row = json.loads(gzip.decompress(original_bytes))['stocks'][0]
                self.assertEqual(row['sector'], 'IT Software')
                self.assertEqual(row['nicheTags'], ['Enterprise Services'])
                self.assertEqual(row['providerSector'], 'Information Technology')
                with gzip.open(output / 'revisions' / first['revision'] / 'theme-classification.json.gz', 'rt') as handle:
                    self.assertEqual(json.load(handle)['records']['TEST']['theme'], 'IT Enabled Services')
                resource.write_bytes(resource.read_bytes() + b'\n')
                second = publish(root, output)
            self.assertNotEqual(first['revision'], second['revision'])
            self.assertEqual(original.read_bytes(), original_bytes)

    def test_failure_does_not_replace_current_manifest(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            publish(root,output); original=(output/'current.json').read_bytes()
            (root/'ipo_screener.json.gz').write_bytes(b'not gzip')
            with self.assertRaises(OSError): publish(root,output)
            self.assertEqual((output/'current.json').read_bytes(),original)

    def test_manual_publication_without_calendar_omits_calendar_url(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            (root/'earnings_calendar.json.gz').unlink()
            first=publish(root,output)
            self.assertNotIn('earningsCalendarUrl',first)
            self.assertFalse((output/'revisions'/first['revision']/'earnings-calendar.json.gz').exists())
            self.assertEqual((output/'current.json').read_bytes(),(output/'revisions'/first['revision']/'release.json').read_bytes())
            self.assertEqual(publish(root,output),first)

    def test_scanner_only_and_chart_release_have_distinct_revisions(self):
        import os
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            with patch.dict(os.environ,{'EDL_CHART_STORAGE':'r2'},clear=True):
                scanner=publish(root,output)
            with patch.dict(os.environ,{'EDL_CHART_STORAGE':'local'},clear=True):
                charts=publish(root,output)
            self.assertEqual(scanner['schemaVersion'],4)
            self.assertEqual(charts['schemaVersion'],6)
            self.assertNotEqual(scanner['revision'],charts['revision'])
            for key in ('chartUrlTemplate', 'chartRevision', 'chartObjectPrefix'):
                self.assertNotIn(key, scanner)
            self.assertEqual(json.loads((output/'current.json').read_text()), charts)
