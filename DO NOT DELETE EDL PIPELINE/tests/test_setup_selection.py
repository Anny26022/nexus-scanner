"""Regression fixtures for family witnesses, causal identity, and traded ceilings."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import unittest
import numpy as np
import pandas as pd
from edl_pipeline.scanner.base_publication import build_base_records, selected_base_episodes, setup_candidate_records, runtime_setup_candidate_records, runtime_setup_candidate_history_complete
from edl_pipeline.scanner.base_conditions import select_setup_episode
from edl_pipeline.scanner.base_presets import materialize_base_preset
from edl_pipeline.scanner.presets import get_preset
from edl_pipeline.scanner.base_replay import replay_breakouts


def candles(values):
    values=np.array(values,float)
    return pd.DataFrame({'Date':pd.bdate_range('2025-01-01',periods=len(values)),'Open':values,'High':values+1,'Low':values-1,'Close':values,'Volume':1000.,'Turnover':2e7})


def candidate(identity,date,first=1,**context):
    return {'id':identity,'symbol':'A','stage':'FORMING','pivotBasis':'CLOSE','pivot':100,'setupCandidateOnly':True,
            'config':{'min_sessions':15},'firstEligibleBase':first,'distanceFromPivotPct':-2,
            'base':{'startDate':date,'ageSessions':60,'depthPct':20},
            'current':{'listingAgeSessionWeeks':20,'distanceSMA50':2,'aboveSMA50Sessions':1,'marketCapCr':500,'medianTurnover20':2,**context}}


class SetupSelectionTests(unittest.TestCase):
    def test_cli_universe_builds_correlated_candidates_from_canonical_history(self):
        import tempfile
        from edl_pipeline.scanner.trend import evaluate_universe
        frame=candles([100]+[94]*40+list(np.linspace(95,99,30)))
        session=str(frame.Date.iloc[-1].date())
        stock={'symbol':'A','listing_date':str(frame.Date.iloc[0].date()),'as_of_date':session,'market_cap_crore':500}
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);frame.to_csv(folder/'A.csv',index=False)
            result=evaluate_universe(folder,{'kind':'BASE_SETUP','params':{'presetId':'lib-nexus-ipo-setup'}},session,context_by_symbol={'stocks':{'A':stock}})
        self.assertEqual(result['counts']['match'],1)
        self.assertEqual(result['results'][0]['symbol'],'A')

    def test_first_ipo_is_not_hidden_by_a_newer_non_first_formation(self):
        first=candidate('first','2025-01-01');later=candidate('later','2025-03-01',first=0)
        value,witness=select_setup_episode([later,first],get_preset('lib-nexus-ipo-setup'),{})
        self.assertTrue(value);self.assertEqual(witness['id'],'first')
        self.assertEqual(select_setup_episode([first,later],get_preset('lib-nexus-ipo-setup'),{})[1]['id'],'first')
        self.assertEqual(select_setup_episode([first,later],get_preset('lib-nexus-ipo-setup'),{'requireFirstBase':False})[1]['id'],'later')

    def test_clauses_cannot_be_satisfied_by_different_candidates(self):
        rich=candidate('rich','2025-01-01',medianTurnover20=.1)
        liquid=candidate('liquid','2025-03-01',marketCapCr=100)
        value,witness=select_setup_episode([rich,liquid],get_preset('lib-nexus-ipo-setup'),{})
        self.assertFalse(value);self.assertIsNone(witness)
        unknown=candidate('unknown','2025-01-01',medianTurnover20=None)
        self.assertIsNone(select_setup_episode([unknown],get_preset('lib-nexus-ipo-setup'),{})[0])
        self.assertIsNone(select_setup_episode(None,get_preset('lib-nexus-ipo-setup'),{})[0])
        self.assertFalse(select_setup_episode([],get_preset('lib-nexus-ipo-setup'),{})[0])

    def test_intraday_wick_has_its_own_pivot_and_later_breakout(self):
        frame=candles([100]+[94]*60+[102,103,106])
        frame.loc[0,'High']=105
        stock={'symbol':'A','listing_date':str(frame.Date.iloc[0].date()),'as_of_date':str(frame.Date.iloc[-1].date()),'market_cap_crore':500}
        records=build_base_records({'A':frame},{'A':stock},setup_candidates=True)['A']
        closing=next(e for e in records if e.get('setupCandidateOnly') and e['pivotBasis']=='CLOSE' and e['base']['startDate']==stock['listing_date'])
        intraday=next(e for e in records if e.get('setupCandidateOnly') and e['pivotBasis']=='HIGH' and e['base']['startDate']==stock['listing_date'])
        self.assertEqual(closing['pivot'],100);self.assertEqual(intraday['pivot'],105)
        self.assertEqual(intraday['base']['pivot'],105)
        self.assertGreater(intraday['breakout']['date'],closing['breakout']['date'])
        self.assertEqual(intraday['selection']['pivotVsHistoricalIntradayHigh'],0)
        intraday['selection']['rsRating']=90
        value,witness=select_setup_episode([intraday,closing],get_preset('lib-nexus-blue-sky-setup'),{'setupStage':'FRESH_BREAKOUT'})
        self.assertTrue(value);self.assertEqual(witness['id'],intraday['id'])
        replay=replay_breakouts(frame,[intraday],preset_id='lib-nexus-blue-sky-setup')
        self.assertEqual([row['baseId'] for row in replay['trades']],[intraday['id']])

    def test_first_structural_base_excludes_an_earlier_overdeep_pause(self):
        frame=candles([100]+[60]*20+[105]+[95]*60+[104])
        stock={'symbol':'A','listing_date':str(frame.Date.iloc[0].date())}
        full=build_base_records({'A':frame},{'A':stock},setup_candidates=True)['A']
        family=[e for e in full if e.get('setupCandidateOnly') and e['pivotBasis']=='CLOSE']
        earliest=min(family,key=lambda e:e['base']['startDate'])
        self.assertIsNone(earliest['structuralQualifiedDate']);self.assertEqual(earliest['firstEligibleBase'],0)
        first=next(e for e in family if e['firstEligibleBase']==1)
        self.assertGreater(first['base']['startDate'],earliest['base']['startDate'])
        prefix=frame.iloc[:-1]
        earlier=build_base_records({'A':prefix},{'A':stock},setup_candidates=True)['A']
        self.assertEqual(next(e['id'] for e in earlier if e.get('setupCandidateOnly') and e['firstEligibleBase']==1 and e['pivotBasis']=='CLOSE'),first['id'])

    def test_first_base_can_mature_after_sma50_warmup(self):
        frame=candles([100]+[94]*40+list(np.linspace(95,99,30)))
        stock={'symbol':'A','listing_date':str(frame.Date.iloc[0].date()),'as_of_date':str(frame.Date.iloc[-1].date()),'market_cap_crore':500}
        records=build_base_records({'A':frame},{'A':stock},setup_candidates=True)['A']
        value,witness=select_setup_episode(records,get_preset('lib-nexus-ipo-setup'),{})
        self.assertTrue(value);self.assertEqual(witness['firstEligibleBase'],1)
        self.assertGreater(witness['current']['aboveSMA50Sessions'],1)
        self.assertTrue(all('parts' not in e['base'] for e in setup_candidate_records(records)))

    def test_family_detector_does_not_replace_legacy_selections(self):
        frame=candles([100]+[94]*20+[103]+[90]*20+[104])
        stock={'symbol':'A','listing_date':str(frame.Date.iloc[0].date())}
        legacy=build_base_records({'A':frame},{'A':stock})['A']
        enhanced=build_base_records({'A':frame},{'A':stock},setup_candidates=True)['A']
        self.assertEqual({k:v['id'] for k,v in selected_base_episodes(legacy).items()},{k:v['id'] for k,v in selected_base_episodes(enhanced).items()})
        self.assertTrue(all(v['config']['max_depth_pct']==60 for v in selected_base_episodes(enhanced).values()))
        self.assertTrue(all(e['config']['max_depth_pct']==95 for e in enhanced if e.get('setupCandidateOnly')))

    def test_runtime_witnesses_keep_live_setups_and_bound_completed_history(self):
        live=candidate('live','2026-09-01')
        completed=[]
        for basis in ('CLOSE','HIGH'):
            for index in range(6):
                record=candidate(f'{basis}-{index}',f'2026-0{index + 1}-01')
                record.update(stage='PLAYED_OUT',pivotBasis=basis,breakout={'date':f'2026-0{index + 1}-01','volumeRatio':2,'closeInRange':.8,'throughPct':1},selection=record.pop('current'))
                completed.append(record)
        runtime=runtime_setup_candidate_records([live,*completed])
        self.assertFalse(runtime_setup_candidate_history_complete([live,*completed]))
        self.assertEqual({record['id'] for record in runtime if record['stage']=='FORMING'},{'live'})
        self.assertEqual(len([record for record in runtime if record['stage']=='PLAYED_OUT']),4)
        self.assertNotIn('config',runtime[0])
        self.assertNotIn('selection',next(record for record in runtime if record['stage']=='FORMING'))
        self.assertNotIn('current',next(record for record in runtime if record['stage']=='PLAYED_OUT'))
        self.assertNotIn('parts',runtime[0]['base'])
        self.assertEqual(next(record for record in runtime if record['id']=='live')['base']['startDate'],'2026-09-01')

    def test_runtime_projection_preserves_family_truth_and_selected_identity(self):
        # Qualification must still pick the most recent matching formation,
        # even when lexicographic IDs would select the older one.
        earlier=candidate('z-earlier','2025-01-01')
        later=candidate('a-later','2025-03-01',first=0)
        later['selection']={};earlier['selection']={}
        full=[earlier,later]
        projected=runtime_setup_candidate_records(full)
        expected=select_setup_episode(full,get_preset('lib-nexus-ipo-setup'),{'requireFirstBase':False})
        actual=select_setup_episode(projected,get_preset('lib-nexus-ipo-setup'),{'requireFirstBase':False})
        self.assertEqual(actual[0],expected[0]);self.assertEqual(actual[1]['id'],expected[1]['id'])

    def test_runtime_projection_covers_every_materialized_family_dependency(self):
        from edl_pipeline.scanner.base_publication import RUNTIME_SETUP_BASE_KEYS, RUNTIME_SETUP_CONTEXT_KEYS, RUNTIME_SETUP_BREAKOUT_KEYS
        for family in ('vcp','blue-sky','multi-year','ipo'):
            for stage in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'):
                parameters={'setupStage':stage,'strictContractionLegs':True,'requireAccumulation':True,
                    'minPriorAdvancePct':20,'requireRising200':True,'reclaim200Within':5,
                    'slopeTurn200Within':5,'above50Persistence':5,'athPolicy':'AUDITED_INTRADAY'}
                if stage!='FORMING':parameters['requireBreakoutConfirmation']=True
                for leaf in materialize_base_preset(get_preset('lib-nexus-'+family+'-setup'),parameters)['children']:
                    metric=leaf['params'].get('metric')
                    if not metric or '.' not in metric:continue
                    scope,key=metric.split('.',1)
                    keys=RUNTIME_SETUP_BASE_KEYS if scope=='base' else RUNTIME_SETUP_BREAKOUT_KEYS if scope=='breakout' else RUNTIME_SETUP_CONTEXT_KEYS
                    self.assertIn(key,keys,(family,stage,metric))

    def test_optional_quality_and_confirmation_are_explicit(self):
        preset=get_preset('lib-nexus-vcp-setup')
        leaves=materialize_base_preset(preset,{'strictContractionLegs':True,'minContractionLegs':0,'requireAccumulation':True,'minPriorAdvancePct':20,'requireRising200':True,'reclaim200Within':5,'slopeTurn200Within':10,'above50Persistence':3})['children']
        paths={leaf['params'].get('metric'):leaf['params'] for leaf in leaves}
        self.assertEqual(paths['base.contractionMaxRatio']['comparison'],'LESS')
        self.assertEqual(paths['base.contractionLegCount']['value'],2)
        self.assertEqual(paths['base.netUpDownVolume']['comparison'],'GREATER')
        self.assertEqual(paths['current.reclaimSMA200Age']['comparison'],'LESS')
        confirmed=materialize_base_preset(get_preset('lib-nexus-multi-year-setup'),{'setupStage':'FRESH_BREAKOUT','requireBreakoutConfirmation':True})['children']
        self.assertIn('breakout.volumeRatio',[leaf['params'].get('metric') for leaf in confirmed])
        self.assertFalse(any(leaf['params'].get('metric')=='base.ageSessions' and leaf['params']['value']==100 for leaf in confirmed))
        for params in ({'requireAccumulation':None},{'strictContractionLegs':True,'maxContractionLegRatio':1.1},{'requireBreakoutConfirmation':True},{'above50Persistence':1.5}):
            with self.assertRaises(ValueError):materialize_base_preset(preset,params)


if __name__=='__main__':unittest.main()
