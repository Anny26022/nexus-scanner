import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import unittest
import numpy as np
import pandas as pd
from edl_pipeline.scanner.base_publication import strength_history, trend_context, build_base_records, compact_base_records


def candles(values):
    values=np.asarray(values,dtype=float)
    return pd.DataFrame({'Date':pd.bdate_range('2025-01-01',periods=len(values)),
        'Open':values,'High':values+1,'Low':values-1,'Close':values,'Volume':1000.0})


class BasePublicationTests(unittest.TestCase):
    def test_absolute_context_facts_and_month_offsets(self):
        frame=candles(np.arange(260)+100.)
        frame['Turnover']=np.arange(260)*1e7
        frame['Volume']=np.arange(260)+1
        ranks=pd.Series(np.arange(260,dtype=float))
        facts=trend_context(frame,259,ranks)
        for period in (10,20,50,100,150,200):
            self.assertAlmostEqual(facts[f'sma{period}'],frame.Close.tail(period).mean())
            self.assertAlmostEqual(facts[f'sma{period}MonthAgo'],frame.Close.iloc[:-21].tail(period).mean())
            self.assertAlmostEqual(facts[f'ema{period}MonthAgo'],frame.Close.ewm(span=period,adjust=False,min_periods=period).mean().iloc[-22])
        for period in (10,20,50,100,200):
            self.assertAlmostEqual(facts[f'averageTurnover{period}'],frame.Turnover.tail(period).mean()/1e7)
            self.assertAlmostEqual(facts[f'averageVolume{period}'],frame.Volume.tail(period).mean())
        self.assertEqual(facts['turnoverCr'],259)
        self.assertEqual(facts['rsMonthAgo'],237)
        frame.loc[259,'Turnover']=float('nan')
        self.assertIsNone(trend_context(frame,259,ranks)['averageTurnover10'])

    def test_market_cap_requires_alignment_and_frozen_turnover_excludes_breakout(self):
        frame=candles([100]+[94]*19+[102,104])
        frame['Turnover']=[2e7]*20+[9e8,8e8]
        date=str(frame.Date.iloc[-1].date())
        stock={'symbol':'A','market_cap_crore':1040,'as_of_date':date}
        records=build_base_records({'A':frame},{'A':stock})['A']
        record=compact_base_records(records,include_parts=True)['FRESH_BREAKOUT']
        self.assertEqual(record['base']['parts']['full']['turnoverCr'],2)
        self.assertEqual(record['selection']['turnoverCr'],2)
        self.assertEqual(record['current']['turnoverCr'],80)
        self.assertEqual(record['current']['marketCapCr'],1040)
        self.assertAlmostEqual(record['selection']['marketCapCr'],940)
        stale=build_base_records({'A':frame},{'A':{**stock,'as_of_date':'2020-01-01'}})['A']
        self.assertIsNone(stale[0]['current']['marketCapCr'])

    def test_symbol_selection_preserves_full_universe_strength_and_peers(self):
        frames={name:candles([100+i*.1 for i in range(270)]+[110]*19+[140]+[150]*10) for name in ('A','B','C')}
        stocks={name:{'industry':'Peer Group'} for name in frames}
        complete=build_base_records(frames,stocks)
        archived={}
        streamed=build_base_records(frames,stocks,episode_sink=lambda symbol,episodes:archived.update({symbol:episodes}))
        self.assertEqual(archived,complete)
        for symbol in frames:
            self.assertLessEqual(len(streamed[symbol]),4)
            self.assertEqual(compact_base_records(streamed[symbol],include_parts=True),compact_base_records(complete[symbol],include_parts=True))
        with self.assertRaisesRegex(ValueError,'Complete archives'):
            build_base_records(frames,stocks,selected_only=True,episode_sink=lambda *_:None)
        chart_only=build_base_records(frames,stocks,selected_only=True)
        for symbol in frames:
            self.assertLessEqual(len(chart_only[symbol]),4)
            self.assertEqual(compact_base_records(chart_only[symbol],include_parts=True),compact_base_records(complete[symbol],include_parts=True))
        selected=build_base_records(frames,stocks,symbols={'A'})
        self.assertEqual(set(selected),{'A'})
        self.assertEqual(selected['A'],complete['A'])
        self.assertTrue(any(episode['current']['rsRating'] is not None for episode in selected['A']))
        self.assertTrue(any(episode['current']['industryRelative63'] is not None for episode in selected['A']))
        with self.assertRaisesRegex(ValueError,'Missing aligned history: MISSING'):
            build_base_records(frames,stocks,symbols={'MISSING'})

    def test_strength_is_prefix_invariant_and_requires_warmup(self):
        frames={'A':candles(np.arange(1,301)+100),'B':candles(np.arange(1,301)*.2+100)}
        full=strength_history(frames)
        prefix=strength_history({s:f.iloc[:270] for s,f in frames.items()})
        pd.testing.assert_frame_equal(full.iloc[:270],prefix)
        self.assertTrue(full.iloc[:252].isna().all().all())
        self.assertEqual(full.iloc[-1].A,99)
        self.assertEqual(full.iloc[-1].B,1)

    def test_official_listing_age_is_not_cache_length(self):
        frame=candles([100]*25)
        self.assertIsNone(trend_context(frame,24)['listingAgeWeeks'])
        expected=(frame.Date.iloc[-1]-pd.Timestamp('2020-01-01')).days/7
        self.assertEqual(trend_context(frame,24,listing_date='2020-01-01')['listingAgeWeeks'],expected)

    def test_public_summary_keeps_selected_episode_and_drops_detailed_parts(self):
        frame=candles([100]+[94]*19+[102,104])
        records=build_base_records({'A':frame},{'A':{'listing_date':'2020-01-01'}})['A']
        public=compact_base_records(records)['FRESH_BREAKOUT']
        self.assertEqual(public['id'],records[0]['id'])
        self.assertNotIn('parts',public['base'])
        self.assertIn('parts',records[0]['base'])
        self.assertIsNone(public['selection']['rsRating'])
        self.assertIsNone(public['current']['industryRelative63'])
        self.assertEqual(public['trade'],records[0]['trade'])
        self.assertEqual(public['exit'],records[0]['exit'])
        self.assertEqual(public['trade']['status'],'OPEN')
        for detailed in (False,True):
            projection=compact_base_records(records,include_parts=detailed,public=not detailed)['FRESH_BREAKOUT']
            self.assertEqual(projection['trade'],public['trade'])

    def test_dated_industry_context_does_not_change_frozen_selection(self):
        frames={name:candles([100+i*.1 for i in range(270)]+[120]*19+[140]+[150]*10) for name in ('A','B','C')}
        frames['A'].loc[270:288,'Close']=110
        frames['A'].loc[270:288,'Open']=110
        frames['A'].loc[270:288,'High']=111
        frames['A'].loc[270:288,'Low']=109
        stocks={name:{'industry':'Peer Group'} for name in frames}
        prefix=build_base_records({name:frame.iloc[:290] for name,frame in frames.items()},stocks)
        complete=build_base_records(frames,stocks)
        first=next(e for e in prefix['A'] if e['breakout'])
        later=next(e for e in complete['A'] if e['id']==first['id'])
        self.assertEqual(first['selection'],later['selection'])
        self.assertIsNotNone(first['selection']['industryRelative63'])
        self.assertIsNotNone(first['selection']['industryAboveSMA50Pct'])

    def test_closed_execution_facts_survive_public_and_private_projection(self):
        frame=candles([100]+[94]*19+[102,90,95,130])
        frame.loc[21,'Open']=110
        frame.loc[21,'High']=111
        records=build_base_records({'A':frame},{'A':{}})['A']
        episode=next(e for e in records if e['trade']['status']=='CLOSED')
        trade=episode['trade']
        self.assertEqual(trade['entryPrice'],110)
        self.assertEqual(trade['exitPrice'],95)
        self.assertEqual(trade['exitReason'],'STOP')
        self.assertAlmostEqual(trade['realizedReturnPct'],(95/110-1)*100)
        for public in (True,False):
            selected=compact_base_records(records,include_parts=not public,public=public)['PLAYED_OUT']
            self.assertEqual(selected['trade'],trade)
            self.assertEqual(selected['exit'],episode['exit'])

if __name__=='__main__':unittest.main()
