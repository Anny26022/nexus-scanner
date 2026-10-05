import unittest
import pandas as pd
from edl_pipeline.scanner.bases import BaseConfig, detect_bases, measure_base


def candles(closes):
    return pd.DataFrame({'Date':pd.bdate_range('2026-01-01', periods=len(closes)),
        'Open':closes, 'High':[x+1 for x in closes], 'Low':[x-1 for x in closes],
        'Close':closes, 'Volume':[1000]*len(closes)})


class BaseTests(unittest.TestCase):
    def test_breakout_freezes_base_and_excludes_breakout_bar(self):
        frame=candles([100]+[94]*19+[102,104,110])
        cfg=BaseConfig(atr_period=2)
        prefix=detect_bases(frame.iloc[:21], 'TEST',cfg)
        future=detect_bases(frame,'TEST',cfg)
        first=next(e for e in prefix if e['breakout'])
        updated=next(e for e in future if e['id']==first['id'])
        self.assertEqual(first['base'],updated['base'])
        self.assertEqual(first['breakout'],updated['breakout'])
        self.assertEqual(first['base']['ageSessions'],20)
        self.assertEqual(first['pivot'],100)
        self.assertEqual(first['breakout']['volumeRatio'],1)
        self.assertLess(first['base']['endDate'],first['breakout']['date'])

    def test_trail_requires_arming(self):
        cfg=BaseConfig(atr_period=2,trail_period=3)
        frame=candles([100]+[94]*19+[102,101,95])
        episode=next(e for e in detect_bases(frame,'TEST',cfg) if e['breakout'])
        self.assertTrue(episode['trailArmed'])
        self.assertEqual(episode['stage'],'PLAYED_OUT')
        self.assertEqual(episode['exit']['reason'],'MA_TRAIL')

    def test_invalid_configuration_and_duplicate_dates_fail(self):
        with self.assertRaises(ValueError): detect_bases(candles([100,94]),'TEST',BaseConfig(min_sessions=0))
        frame=candles([100,94]);frame.loc[1,'Date']=frame.loc[0,'Date']
        with self.assertRaises(ValueError): detect_bases(frame,'TEST')

    def test_missing_rs_does_not_invent_strength(self):
        episode=detect_bases(candles([100]+[94]*20),'TEST')[0]
        self.assertIsNone(episode['base']['rsAverage'])
        self.assertEqual(episode['base']['netUpDownVolume'],-1.0)

    def test_outcomes_are_unavailable_until_horizon_and_ignore_trade_exit(self):
        frame=candles([100]+[94]*19+[102,90]+[105]*60)
        early=next(e for e in detect_bases(frame.iloc[:25],'TEST') if e['breakout'])
        final=next(e for e in detect_bases(frame,'TEST') if e['id']==early['id'])
        self.assertIsNone(early['outcomes']['5'])
        self.assertEqual(final['exit']['reason'],'STOP')
        self.assertTrue(final['outcomes']['5']['closedInsideBase'])
        self.assertAlmostEqual(final['outcomes']['60']['returnPct'],(105/102-1)*100)
        self.assertEqual(final['breakoutFailure']['reason'],'CLOSE_BACK_INSIDE')

    def test_configuration_is_part_of_episode_identity(self):
        frame=candles([100]+[94]*20)
        first=detect_bases(frame,'TEST',BaseConfig(stop_pct=8))[0]
        second=detect_bases(frame,'TEST',BaseConfig(stop_pct=9))[0]
        self.assertNotEqual(first['id'],second['id'])

    def test_touch_tolerance_is_configured_and_failed_poke_is_confirmed(self):
        frame=candles([100]+[94]*18+[99,100.5,98])
        # An intraday ceiling above the closing pivot makes this a poke,
        # confirmed only when a later close returns inside the base.
        frame.loc[0,'High']=102
        before=next(e for e in detect_bases(frame.iloc[:21],'TEST',BaseConfig(trail_period=200)) if e['breakout'])
        after=next(e for e in detect_bases(frame,'TEST',BaseConfig(trail_period=200)) if e['id']==before['id'])
        self.assertEqual(before['failedPokeCount'],0)
        self.assertEqual(after['failedPokeCount'],1)
        self.assertEqual(before['base'],after['base'])
        atr=pd.Series([1.0]*len(frame))
        tight=measure_base(frame,0,19,atr,touch_tolerance_pct=.5)
        loose=measure_base(frame,0,19,atr,touch_tolerance_pct=2)
        self.assertEqual(tight['touchCount'],1)
        self.assertEqual(loose['touchCount'],2)

    def test_immature_children_do_not_inflate_nested_count(self):
        frame=candles([100,94,99,93]+[94]*14)
        early=detect_bases(frame.iloc[:5],'TEST')
        parent=next(e for e in early if e['pivot']==100)
        self.assertEqual(parent['base']['nestedCount'],0)
        later=detect_bases(frame,'TEST')
        parent=next(e for e in later if e['id']==parent['id'])
        self.assertEqual(parent['base']['nestedCount'],1)

    def test_inconsistent_ohlc_is_rejected(self):
        frame=candles([100,94]);frame.loc[1,'High']=90
        with self.assertRaises(ValueError): detect_bases(frame,'TEST')

if __name__=='__main__':unittest.main()

