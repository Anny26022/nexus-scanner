import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import unittest
from edl_pipeline.scanner.base_conditions import evaluate_base_condition
from edl_pipeline.scanner.base_conditions import METRICS
import json


class BaseConditionTests(unittest.TestCase):
    def test_generated_frontend_metric_catalog_matches_python_contract(self):
        catalog=Path(__file__).resolve().parents[2]/'frontend/src/data/baseMetrics.json'
        self.assertEqual(set(json.loads(catalog.read_text())),METRICS)
    def test_bounded_expression_arithmetic_and_validation(self):
        parameters={'stage':'HOLDING','formula':'(base.depthPct - 5) / 2 + 3 * 2','comparison':'EQUAL','value':16}
        self.assertTrue(evaluate_base_condition(self.records,'BASE_FORMULA',parameters))
        self.assertIsNone(evaluate_base_condition(self.records,'BASE_FORMULA',{**parameters,'formula':'base.depthPct / (2 - 2)'}))
        self.assertIsNone(evaluate_base_condition({},'BASE_FORMULA',parameters))
        for formula in ('unknown + 1','base.depthPct ** 2','__import__(1)','(base.depthPct','base.depthPct 2','+'*70+'1','('*10+'1'+')'*10,'1'*2049):
            with self.subTest(formula=formula),self.assertRaises(ValueError):
                evaluate_base_condition({},'BASE_FORMULA',{**parameters,'formula':formula})

    def setUp(self):
        self.records={'HOLDING':{'base':{'depthPct':25,'atrContraction':.6,'volumeDryUp':.8},'continuousHolding':False,'holdsPivot':True}}

    def test_strict_inclusive_and_formula(self):
        p={'stage':'HOLDING','metric':'base.depthPct','comparison':'LESS','value':25}
        self.assertFalse(evaluate_base_condition(self.records,'BASE_METRIC',p))
        p['comparison']='BELOW'
        self.assertTrue(evaluate_base_condition(self.records,'BASE_METRIC',p))
        self.assertTrue(evaluate_base_condition(self.records,'BASE_FORMULA',{'stage':'HOLDING','metric':'base.atrContraction','rightMetric':'base.volumeDryUp','arithmetic':'DIVIDE','comparison':'LESS','value':1}))

    def test_holding_and_missing_measurements(self):
        self.assertFalse(evaluate_base_condition(self.records,'BASE_STAGE',{'stage':'HOLDING','holdingPolicy':'STRICT'}))
        self.assertTrue(evaluate_base_condition(self.records,'BASE_STAGE',{'stage':'HOLDING','holdingPolicy':'RETEST'}))
        self.assertIsNone(evaluate_base_condition({},'BASE_METRIC',{'metric':'base.depthPct','value':25}))
        self.assertFalse(evaluate_base_condition({},'BASE_STAGE',{}))
        self.assertIsNone(evaluate_base_condition(None,'BASE_STAGE',{}))

    def test_invalid_paths_and_parameters_fail_even_without_a_base(self):
        with self.assertRaises(ValueError): evaluate_base_condition({},'BASE_METRIC',{'metric':'__proto__','value':1})
        with self.assertRaises(ValueError): evaluate_base_condition({},'BASE_STAGE',{'holdingPolicy':'UNKNOWN'})
        with self.assertRaises(ValueError): evaluate_base_condition({},'BASE_METRIC',{'metric':'base.depthPct','value':float('nan')})

if __name__=='__main__':unittest.main()
