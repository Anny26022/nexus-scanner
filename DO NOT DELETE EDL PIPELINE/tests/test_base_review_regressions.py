"""Regression coverage for PR review boundary and publication fixes."""
import gzip
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import pandas as pd
from edl_pipeline.scanner.bases import BaseConfig, detect_bases
from edl_pipeline.scanner.turnover import average_turnover_crore
from edl_pipeline.scanner.base_conditions import evaluate_base_condition
from edl_pipeline.scanner.base_publication import build_base_records, prepare_base_peer_context, compact_setup_match
from edl_pipeline.scanner.presets import get_preset
from edl_pipeline.scanner.base_presets import materialize_base_preset


class BaseReviewRegressions(unittest.TestCase):
    def test_complete_checkpoints_skip_cross_sectional_context(self):
        import sys
        from unittest.mock import patch
        sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
        import validate_scanner_full_universe as validation
        frames={'A':object(),'B':object()}
        with patch.object(validation,'prepare_base_peer_context',return_value='prepared') as prepare:
            self.assertIsNone(validation.pending_peer_context(frames,{},None,{'A','B'}))
            prepare.assert_not_called()
            self.assertEqual(validation.pending_peer_context(frames,{},None,{'A'}),'prepared')
            prepare.assert_called_once_with(frames,{},None)

    def test_missing_date_never_becomes_latest_metrics_row(self):
        from advanced_metrics_processor import process_symbol_csv
        frame=pd.DataFrame({'Date':['2026-09-29','2026-09-30',None], 'Open':[100,101,900], 'High':[102,103,901], 'Low':[99,100,899], 'Close':[101,102,900], 'Volume':[1000,1000,1000], 'Turnover':[1e7,2e7,9e7]})
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'A.csv';frame.to_csv(path,index=False)
            self.assertEqual(process_symbol_csv(str(path))[1]['as_of_date'],'2026-09-30')

    def test_alignment_normalizes_basic_iso_and_reports_invalid_json(self):
        import subprocess,sys
        script=Path(__file__).resolve().parents[2]/'scripts/check_base_data_alignment.py'
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'ohlcv_data').mkdir()
            artifact=root/'all_stocks_fundamental_analysis.json.gz'
            artifact.write_bytes(gzip.compress(json.dumps([{'symbol':'A','as_of_date':'2026-09-30'}]).encode()))
            (root/'ohlcv_data/A.csv').write_text('Date,Close\n2026-09-30,100\n')
            result=subprocess.run([sys.executable,str(script),'--root',str(root),'--session','20260930'],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)['session'],'2026-09-30')
            artifact.write_bytes(gzip.compress(b'null'))
            result=subprocess.run([sys.executable,str(script),'--root',str(root)],capture_output=True,text=True)
            self.assertEqual(result.returncode,2)
            self.assertIn('Alignment check failed',result.stderr)
            self.assertNotIn('Traceback',result.stderr)

    def test_public_witness_omits_config_and_keeps_floor(self):
        episode={'id':'A','stage':'FORMING','setupCandidateOnly':True,'config':{'min_sessions':15},'base':{'ageSessions':20,'floor':80},'current':{},'selection':{}}
        witness=compact_setup_match(episode)
        self.assertNotIn('config',witness)
        self.assertEqual(witness['base']['floor'],80)

    def test_missing_nullable_turnover_rejects_partial_window(self):
        frame=pd.DataFrame({'Turnover':pd.Series([2e7,pd.NA],dtype='Float64')})
        self.assertIsNone(average_turnover_crore(frame,2))
        self.assertEqual(average_turnover_crore(frame.iloc[:1],1),2)

    def test_boolean_thresholds_are_not_numeric_config(self):
        for name in ('pullback_pct','max_depth_pct','stop_pct','touch_tolerance_pct','contraction_noise_pct'):
            with self.assertRaises(ValueError):BaseConfig(**{name:True}).validate()

    def test_default_family_requires_one_close_above_sma50(self):
        for family in ('blue-sky','multi-year','ipo','vcp'):
            expression=materialize_base_preset(get_preset('lib-nexus-'+family+'-setup'),{})
            gate=next(leaf for leaf in expression['children'] if leaf['params'].get('metric')=='current.aboveSMA50Sessions')
            self.assertEqual(gate['params']['value'],1)
            self.assertFalse(evaluate_base_condition({'FORMING':{'current':{'aboveSMA50Sessions':0}}},gate['kind'],gate['params']))

    def test_overflow_arithmetic_is_unavailable(self):
        self.assertIsNone(evaluate_base_condition({'FORMING':{'base':{'depthPct':1e308,'ageSessions':1e308}}},'BASE_FORMULA',{'metric':'base.depthPct','rightMetric':'base.ageSessions','arithmetic':'MULTIPLY','value':1}))

    def test_rank_sink_matches_ledger_without_retaining_it(self):
        close=np.linspace(100,200,270)
        frame=pd.DataFrame({'Date':pd.bdate_range('2025-01-01',periods=len(close)),'Open':close,'High':close+1,'Low':close-1,'Close':close,'Volume':1000.})
        stocks={'A':{'symbol':'A'},'B':{'symbol':'B'}}
        frames={'A':frame,'B':frame.assign(Close=close+1,Open=close+1,High=close+2,Low=close)}
        retained={};streamed={}
        build_base_records(frames,stocks,rank_history=retained,rank_sink=lambda symbol,ledger:streamed.update({symbol:ledger}))
        self.assertEqual(streamed,retained)
        only_stream={}
        build_base_records(frames,stocks,rank_sink=lambda symbol,ledger:only_stream.update({symbol:ledger}))
        self.assertEqual(only_stream,retained)
        shared=prepare_base_peer_context(frames,stocks)
        from unittest.mock import patch
        with patch('edl_pipeline.scanner.base_publication.strength_history',side_effect=AssertionError('must reuse peer context')):
            for symbol in frames:
                ledger={}
                build_base_records(frames,stocks,symbols={symbol},rank_history=ledger,peer_context=shared)
                self.assertEqual(ledger[symbol],retained[symbol])

    def test_nested_maturity_excludes_breakout_and_invalidated_parent(self):
        close=100+np.sin(np.arange(240)*.23)*12+np.cos(np.arange(240)*.06)*20
        frame=pd.DataFrame({'Date':pd.bdate_range('2025-01-01',periods=len(close)),'Open':close,'High':close+1,'Low':close-1,'Close':close,'Volume':1000.})
        minimum=8
        episodes=detect_bases(frame,'A',BaseConfig(min_sessions=minimum,max_depth_pct=20))
        by_id={e['id']:e for e in episodes};positions={str(day.date()):i for i,day in enumerate(frame.Date)}
        self.assertTrue(any(e['parentId'] for e in episodes))
        expected={identity:0 for identity in by_id}
        for child in episodes:
            parent=by_id.get(child['parentId'])
            if parent is None or child['base']['ageSessions']<minimum:continue
            mature=positions[child['base']['startDate']]+minimum-1
            stop=parent['breakout'] or parent['exit']
            if stop is None or mature<positions[stop['date']]:expected[parent['id']]+=1
        for parent in episodes:self.assertEqual(parent['nestedCount'],expected[parent['id']])
