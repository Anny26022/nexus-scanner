import unittest
import numpy as np
import pandas as pd
from edl_pipeline.scanner.base_publication import strength_history, trend_context, build_base_records, compact_base_records


def candles(values):
    values=np.asarray(values,dtype=float)
    return pd.DataFrame({'Date':pd.bdate_range('2025-01-01',periods=len(values)),
        'Open':values,'High':values+1,'Low':values-1,'Close':values,'Volume':1000.0})


class BasePublicationTests(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
