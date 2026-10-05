import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import unittest
from edl_pipeline.scanner.presets import get_preset, list_presets
from edl_pipeline.scanner.base_conditions import evaluate_base_condition


def record():
    return {'continuousHolding':True,'holdsPivot':True,'distanceFromPivotPct':2,'breakoutAgeSessions':2,
        'base':{'ageSessions':40,'depthPct':20,'atrContraction':.6,'volumeDryUp':.6},
        'selection':{'medianTurnover20':10,'distanceSMA200':10,'slopeSMA200':1,'rsRating':90,'rsChange22':5,'distanceClosing52wHigh':10},
        'current':{'medianTurnover20':1,'rsRating':20},
        'breakout':{'volumeRatio':2,'closeInRange':.8,'throughPct':2}}


def evaluate(preset,records):
    values=[evaluate_base_condition(records,node['kind'],node['params']) for node in preset['expression']['children']]
    return False if False in values else None if None in values else True


class BasePresetTests(unittest.TestCase):
    def test_seven_original_presets_preserve_original_library(self):
        ids={p['id'] for p in list_presets()}
        self.assertEqual(len([x for x in ids if x.startswith('lib-nexus-') and not x.endswith('-setup')]),7)
        self.assertEqual(len([x for x in ids if x.endswith('-setup')]),4)
        self.assertEqual(len([x for x in ids if not x.startswith('lib-nexus-')]),45)

    def test_fresh_breakout_uses_frozen_quality_and_current_extension(self):
        data=record();preset=get_preset('lib-nexus-fresh-breakouts')
        self.assertTrue(evaluate(preset,{'FRESH_BREAKOUT':data}))
        data['distanceFromPivotPct']=6
        self.assertFalse(evaluate(preset,{'FRESH_BREAKOUT':data}))

    def test_holding_requires_continuous_pivot_holding(self):
        data=record();preset=get_preset('lib-nexus-holding-breakouts')
        self.assertTrue(evaluate(preset,{'HOLDING':data}))
        data['continuousHolding']=False
        self.assertFalse(evaluate(preset,{'HOLDING':data}))
        preset['expression']['children'][0]['params']['holdingPolicy']='RETEST'
        self.assertTrue(evaluate(preset,{'HOLDING':data}))

if __name__=='__main__':unittest.main()
