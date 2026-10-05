import unittest
import pandas as pd
from edl_pipeline.scanner.bases import BaseConfig, detect_bases


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

if __name__=='__main__':unittest.main()
