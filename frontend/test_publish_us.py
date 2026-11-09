import json
from pathlib import Path
import unittest

import publish_us
from publish_snapshot import tradingview_row
import site_data


class PublishUsTests(unittest.TestCase):
    def test_the_release_has_its_own_pointer_and_declares_its_units(self):
        self.assertEqual(publish_us.POINTER, 'us/current.json')
        self.assertIn(publish_us.POINTER, site_data.POINTERS)
        manifest = publish_us.manifest_for('a' * 64, '2026-11-09', 3)
        self.assertEqual((manifest['market'], manifest['currency'], manifest['amountUnit']), ('us', 'USD', 1_000_000))
        for key in ('datasetUrl', 'datasetPackedGzipUrl', 'iposUrl'):
            self.assertTrue(manifest[key].startswith('/data/revisions/' + 'a' * 64 + '/'), key)

    def test_us_floors_cover_every_preset_eligibility_rule(self):
        rules = json.loads((Path(__file__).parent / 'src/data/presetEligibility.json').read_text())
        self.assertEqual(set(publish_us.US_ELIGIBILITY), {rule['id'] for rule in rules})

    def test_us_rows_carry_the_us_scan_and_only_its_dollar_values(self):
        snapshot = {'source': publish_us.TRADINGVIEW_US, 'as_of_date': '2026-11-09', 'currency': 'USD', 'financial_currency': 'USD',
                    'market': {'performance_1m_pct': 4.2}, 'financials': {}, 'technicals': {}}
        stock = {'tradingview_snapshot': snapshot}
        us = (publish_us.TRADINGVIEW_US, 'USD')
        self.assertEqual(tradingview_row(stock, '2026-11-09', us)['values']['market.performance_1m_pct'], 4.2)
        # India's release never takes the US scan, and the US release refuses other currencies.
        self.assertIsNone(tradingview_row(stock, '2026-11-09'))
        rupees = {'tradingview_snapshot': {**snapshot, 'currency': 'INR'}}
        self.assertIsNone(tradingview_row(rupees, '2026-11-09', us)['values']['market.performance_1m_pct'])


if __name__ == '__main__':
    unittest.main()
