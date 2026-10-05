import unittest
import pandas as pd
from edl_pipeline.scanner.base_replay import replay_breakouts


def fixture():
    dates=pd.bdate_range('2026-01-01',periods=70)
    frame=pd.DataFrame({'Date':dates,'Open':[100]*70,'High':[101]*70,'Low':[99]*70,'Close':[100]*70,'Volume':[1000]*70})
    frame.loc[2,['Open','High','Low','Close']]=[120,121,99,100]
    record={'id':'base','symbol':'TEST','stage':'PLAYED_OUT','pivot':100,
        'base':{'ageSessions':40,'depthPct':20,'atrContraction':.6,'volumeDryUp':.6},
        'selection':{'medianTurnover20':10,'distanceSMA200':10,'slopeSMA200':1,'rsRating':90,'rsChange22':5,'distanceClosing52wHigh':10},
        'current':{'rsRating':10},'breakout':{'date':str(dates[1].date()),'close':102,'throughPct':2,'volumeRatio':2,'closeInRange':.8},
        'exit':{'date':str(dates[3].date()),'reason':'STOP'}}
    return frame,record


class ReplayTests(unittest.TestCase):
    def test_uses_next_open_and_costs_not_breakout_close(self):
        frame,record=fixture()
        trade=replay_breakouts(frame,[record],fee_bps=10,slippage_bps=10)['trades'][0]
        self.assertEqual(trade['entryPrice'],120)
        self.assertAlmostEqual(trade['outcomes']['5']['grossReturnPct'],(100/120-1)*100)
        self.assertLess(trade['outcomes']['5']['netReturnPct'],trade['outcomes']['5']['grossReturnPct'])
        self.assertEqual(trade['tradeExit']['executionDate'],str(frame.Date.iloc[4].date()))

    def test_prefix_invariance_and_incomplete_horizons(self):
        frame,record=fixture()
        early=replay_breakouts(frame.iloc[:10],[record])['trades'][0]
        later=replay_breakouts(frame,[record])['trades'][0]
        self.assertEqual(early['outcomes']['5'],later['outcomes']['5'])
        self.assertIsNone(early['outcomes']['20'])
        self.assertIsNotNone(later['outcomes']['60'])
        no_entry=replay_breakouts(frame.iloc[:2],[record])['trades'][0]
        self.assertIsNone(no_entry['entryDate'])

    def test_rejects_invalid_cost_and_non_breakout_presets(self):
        frame,record=fixture()
        with self.assertRaises(ValueError):replay_breakouts(frame,[record],fee_bps=-1)
        with self.assertRaises(ValueError):replay_breakouts(frame,[record],preset_id='lib-nexus-strong-bases')

if __name__=='__main__':unittest.main()
