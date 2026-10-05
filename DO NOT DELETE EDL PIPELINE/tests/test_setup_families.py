import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import unittest
import json
import gzip
import tempfile
import numpy as np
import pandas as pd
from edl_pipeline.scanner.base_presets import materialize_base_preset
from edl_pipeline.scanner.presets import get_preset
from edl_pipeline.scanner.base_conditions import evaluate_base_condition
from edl_pipeline.scanner.base_publication import build_base_records, compact_base_records, trend_context, load_history_audits
from edl_pipeline.scanner.bases import BaseConfig, detect_bases, measure_base, confirmed_contractions
from edl_pipeline.scanner.base_execution import position_size
from edl_pipeline.scanner.base_replay import replay_breakouts


def candles(values):
    values=np.asarray(values,float)
    return pd.DataFrame({'Date':pd.bdate_range('2025-01-01',periods=len(values)),
                         'Open':values,'High':values+1,'Low':values-1,'Close':values,'Volume':1000.,'Turnover':2e7})


def clauses(family, **parameters):
    return materialize_base_preset(get_preset('lib-nexus-'+family+'-setup'),parameters)['children']


class SetupFamilyTests(unittest.TestCase):
    def test_liquidity_and_pivot_facts_freeze_for_every_post_breakout_stage(self):
        for stage in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'):
            leaves=clauses('blue-sky',setupStage=stage)
            scope='current' if stage=='FORMING' else 'selection'
            paths=[leaf['params'].get('metric') for leaf in leaves]
            self.assertIn(scope+'.marketCapCr',paths)
            self.assertIn(scope+'.medianTurnover20',paths)
            self.assertIn('distanceFromPivotPct' if stage=='FORMING' else 'selection.distanceFromPivotPct',paths)
            self.assertTrue(all(leaf['params']['stage']==stage for leaf in leaves))
        leaves=clauses('blue-sky',setupStage='PLAYED_OUT')
        facts={'stage':'PLAYED_OUT','base':{'overheadPct':0,'depthPct':40},'selection':{'historyFromListing':1,'rsRating':90,'marketCapCr':500,'medianTurnover20':2,'distanceFromPivotPct':-3},'current':{'rsRating':1,'marketCapCr':10,'medianTurnover20':0}}
        self.assertTrue(all(evaluate_base_condition({'PLAYED_OUT':facts},leaf['kind'],leaf['params']) is True for leaf in leaves))
        cap=next(i for i,n in enumerate(get_preset('lib-nexus-blue-sky-setup')['expression']['children']) if n['params'].get('metric')=='current.marketCapCr')
        edited=clauses('blue-sky',setupStage='PLAYED_OUT',**{f'threshold{cap}':600})
        self.assertFalse(all(evaluate_base_condition({'PLAYED_OUT':facts},leaf['kind'],leaf['params']) is True for leaf in edited))

    def test_generated_contract_and_audit_loader_match_publication_inputs(self):
        from edl_pipeline.scanner.presets import load_preset_library
        from edl_pipeline.scanner.base_publication import PUBLIC_BASE_KEYS, PUBLIC_CONTEXT_KEYS
        catalog_dir=Path(__file__).resolve().parents[2]/'frontend/src/data'
        self.assertEqual(set(json.loads((catalog_dir/'basePublicKeys.json').read_text())),PUBLIC_BASE_KEYS)
        self.assertEqual(set(json.loads((catalog_dir/'baseContextKeys.json').read_text())),PUBLIC_CONTEXT_KEYS)
        catalog=Path(__file__).resolve().parents[2]/'frontend/src/data/presetDefinitions.json'
        self.assertEqual(json.loads(catalog.read_text()),load_preset_library()['presets'])
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            self.assertEqual(load_history_audits(root),{})
            (root/'base_history_audits.json.gz').write_bytes(gzip.compress(b'{"A":{"source":"old"}}'))
            self.assertEqual(load_history_audits(root)['A']['source'],'old')
            (root/'base_history_audits.json').write_text('{"A":{"source":"staged"}}')
            self.assertEqual(load_history_audits(root)['A']['source'],'staged')
            (root/'base_history_audits.json').write_text('[]')
            with self.assertRaises(ValueError):load_history_audits(root)

    def test_optional_policies_and_invalid_parameters(self):
        self.assertNotIn('firstEligibleBase',[n['params'].get('metric') for n in clauses('ipo',requireFirstBase=False)])
        self.assertIn('current.lifetimePriceHistoryVerified',[n['params'].get('metric') for n in clauses('blue-sky',athPolicy='AUDITED_INTRADAY')])
        self.assertIn('base.contractionMaxRatio',[n['params'].get('metric') for n in clauses('vcp',minContractionLegs=3)])
        for parameters in ({'minContractionLegs':1},{'minContractionLegs':2.5},{'maxBaseDepth':None},{'maxBaseDepth':True},{'setupStage':None},{'requireFirstBase':None},{'athPolicy':'UNKNOWN'}):
            with self.assertRaises(ValueError):clauses('vcp',**parameters)
        depths=[n['params']['value'] for n in clauses('vcp',maxBaseDepth=45) if n['params'].get('metric')=='base.depthPct' and n['params']['comparison']=='BELOW']
        self.assertEqual(depths,[45])
        self.assertIn('base.atrContraction',[n['params'].get('metric') for n in clauses('vcp',contractionMethod='WILDER_ATR')])
        long=clauses('multi-year')
        self.assertTrue(any(n['params'].get('metric')=='base.ageWeeks' and n['params']['value']==52 for n in long))

    def test_raw_true_range_is_not_smoothed_atr_and_ages_are_distinct(self):
        frame=candles([100,110,95,108,100])
        facts=measure_base(frame,0,4,pd.Series([1.,2.,3.,4.,5.]))
        tr=pd.concat([frame.High-frame.Low,(frame.High-frame.Close.shift()).abs(),(frame.Low-frame.Close.shift()).abs()],axis=1).max(axis=1)/frame.Close*100
        self.assertAlmostEqual(facts['parts']['full']['trueRangePct'],tr.mean())
        self.assertAlmostEqual(facts['trueRangeContraction'],tr.iloc[3:].mean()/tr.iloc[:3].mean())
        self.assertNotEqual(facts['parts']['full']['trueRangePct'],facts['parts']['full']['atrPct'])
        self.assertEqual(facts['ageWeeks'],1)
        self.assertAlmostEqual(facts['ageCalendarWeeks'],(frame.Date.iloc[-1]-frame.Date.iloc[0]).days/7)
        self.assertIsNone(trend_context(frame,4)['trMeanPct10'])

    def test_contraction_requires_confirmed_reversal(self):
        prices=[100,90,100,94,100,97]
        self.assertEqual(len(confirmed_contractions(prices,prices,prices,5)),2)
        unconfirmed=[100,90,100,94,95]
        self.assertEqual(len(confirmed_contractions(unconfirmed,unconfirmed,unconfirmed,5)),1)

    def test_listing_coverage_and_first_base_are_unavailable_for_truncated_history(self):
        frame=candles([100]+[94]*19+[102,104])
        listing=str(frame.Date.iloc[0].date())
        full=build_base_records({'A':frame},{'A':{'listing_date':listing}})['A']
        self.assertEqual(full[0]['firstEligibleBase'],1)
        self.assertEqual(full[0]['current']['historyCoverageComplete'],1)
        self.assertEqual(full[0]['current']['listingAgeSessionWeeks'],len(frame)/5)
        self.assertIsNone(full[0]['current']['lifetimePriceHistoryVerified'])
        selected=build_base_records({'A':frame},{'A':{'listing_date':listing}},selected_only=True)['A']
        self.assertEqual(compact_base_records(full),compact_base_records(selected))
        missing=frame.drop(index=3).reset_index(drop=True)
        records=build_base_records({'A':missing,'B':frame},{'A':{'listing_date':listing},'B':{'listing_date':listing}})['A']
        self.assertIsNone(records[0]['firstEligibleBase'])
        self.assertEqual(records[0]['current']['historyMissingSessions'],1)
        self.assertEqual(records[0]['current']['lifetimePriceHistoryVerified'],0)
        audit={'pricesAdjusted':True,'sessionsVerified':True,'source':'verified test ledger','throughDate':str(frame.Date.iloc[-1].date()),'historyStartDate':listing}
        verified=build_base_records({'A':frame},{'A':{'listing_date':listing}},history_audits={'A':audit})['A'][0]
        self.assertEqual(verified['current']['lifetimePriceHistoryVerified'],1)
        self.assertLess(verified['selection']['pivotVsHistoricalIntradayHigh'],0)
        truncated=build_base_records({'A':frame},{'A':{'listing_date':'2020-01-01'}})['A'][0]
        self.assertIsNone(truncated['firstEligibleBase'])

    def test_cost_aware_sizing_and_validation_without_qualifiers(self):
        sized=position_size(100,92,capital=100000)
        self.assertLessEqual(sized['plannedRiskPct'],1.5)
        self.assertIsInstance(sized['shares'],int)
        self.assertLessEqual(position_size(100,99,max_position_pct=10)['positionFraction'],.1)
        self.assertEqual(position_size(100,92,capital=1)['status'],'BELOW_ONE_SHARE')
        self.assertEqual(position_size(100,102)['status'],'INVALID_STOP')
        with self.assertRaises(ValueError):replay_breakouts(candles([100]),[],risk_pct=0)
        with self.assertRaises(ValueError):replay_breakouts(candles([100]),[],capital=-1)

    def test_breakeven_is_optional_and_executes_on_following_open(self):
        frame=candles([100]+[94]*19+[102,103,115,103,102,99])
        cfg=BaseConfig(trail_period=200,breakeven_gain_pct=10)
        episode=next(e for e in detect_bases(frame,'A',cfg) if e['breakout'])
        self.assertTrue(episode['breakevenArmed'])
        self.assertEqual(episode['exit']['reason'],'BREAKEVEN')
        self.assertEqual(episode['trade']['status'],'CLOSED')
        self.assertGreater(episode['trade']['executionDate'],episode['exit']['date'])
        baseline=next(e for e in detect_bases(frame,'A',BaseConfig(trail_period=200)) if e['breakout'])
        self.assertFalse(baseline['breakevenArmed'])
        self.assertIsNone(baseline['exit'])
        prefix=next(e for e in detect_bases(frame.iloc[:-2],'A',cfg) if e['breakout'])
        self.assertEqual(prefix['trade']['status'],'EXIT_PENDING')


if __name__=='__main__':unittest.main()
