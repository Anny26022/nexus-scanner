import unittest
from edl_pipeline.scanner.base_conditions import evaluate_base_condition


class BaseConditionTests(unittest.TestCase):
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
