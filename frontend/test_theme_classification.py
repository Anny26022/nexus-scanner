import copy
import unittest

from theme_classification import classify


class ThemeClassificationTests(unittest.TestCase):
    def test_canonical_curated_aliases_and_unknowns(self):
        stocks = [{'symbol': symbol, 'sector': 'Original', 'industry': 'Original'}
                  for symbol in ['AUGMONT', 'CYIENTDLM', 'OPTIEMUS', 'UNKNOWN']]
        original = copy.deepcopy(stocks)
        result = classify(stocks, '2026-10-13')
        records = result['records']
        self.assertEqual(records['AUGMONT']['theme'], 'Jewellery')
        self.assertEqual(records['AUGMONT']['memberships']['Jewellery'], 'reviewed_recent_listing')
        self.assertEqual(records['AUGMONT']['issuerOverlay']['niche'], 'Integrated precious-metals platform: bullion trading, refining and digital gold')
        self.assertEqual(records['AUGMONT']['issuerOverlay']['sourceUrl'], 'https://www.augmont.com/investors/augmont')
        self.assertEqual(records['CYIENTDLM']['theme'], 'Industrial Systems & Controls')
        self.assertIn('Emerging EMS', records['CYIENTDLM']['memberships'])
        self.assertEqual(records['OPTIEMUS']['theme'], 'Telecom Equipment')
        self.assertIsNone(records['UNKNOWN']['theme'])
        self.assertEqual(result['coverage']['unmapped'], ['UNKNOWN'])
        self.assertEqual(stocks, original)
        self.assertEqual(result, classify(list(reversed(stocks)), '2026-10-13'))
        self.assertEqual(len(result['version']), 64)

    def test_exact_scanner_industry_bridges_uncovered_symbols(self):
        result = classify([{'symbol': 'UNREVIEWED', 'sector': 'Financial Services', 'industry': 'NBFC'}], '2026-10-13')
        record = result['records']['UNREVIEWED']
        self.assertEqual(record['theme'], 'NBFC')
        self.assertEqual(record['memberships'], {'NBFC': 'scanner-industry-bridge'})
        self.assertEqual(record['mappingConfidence'], 'medium')
        self.assertEqual(result['coverage']['unmapped'], [])

    def test_young_cohort_preserves_business_theme_and_expires_after_100_sessions(self):
        stock = {'symbol': 'UNREVIEWED', 'sector': 'Financial Services', 'industry': 'NBFC',
                 'metrics': {'historySessions': 100}}
        young = classify([stock], '2026-10-13')['records']['UNREVIEWED']
        self.assertEqual(young['theme'], 'NBFC')
        self.assertEqual(young['memberships'], {'NBFC': 'scanner-industry-bridge', 'IPO / Young Bases': 'curated-rule'})
        older = classify([{**stock, 'metrics': {'historySessions': 101}}], '2026-10-14')['records']['UNREVIEWED']
        self.assertEqual(older['memberships'], {'NBFC': 'scanner-industry-bridge'})

    def test_reviewed_sector_names_preserve_provider_based_theme_memberships(self):
        source = [{'symbol': 'ABMKNO', 'sector': 'Information Technology', 'industry': 'IT Enabled Services'}]
        baseline = classify(source, '2026-10-13')
        reviewed = [{**source[0], 'sector': 'IT Software',
                     'providerSector': source[0]['sector'], 'providerIndustry': source[0]['industry']}]
        self.assertEqual(classify(reviewed, '2026-10-13'), baseline)
        # Unknown raw industries must not acquire a guessed business exposure.
        unknown = [{'symbol': 'UNREVIEWED', 'sector': 'Financial Services', 'industry': 'NBFC',
                    'providerSector': None, 'providerIndustry': None}]
        self.assertEqual(classify(unknown, '2026-10-13')['coverage']['unmapped'], ['UNREVIEWED'])

    def test_issuer_mapping_and_niche_overlay_are_distinct(self):
        record = classify([{'symbol': 'AASTHA'}], '2026-10-13')['records']['AASTHA']
        self.assertEqual(record['theme'], 'Spinning & Yarn Processing')
        self.assertEqual(record['mappingConfidence'], 'high')
        self.assertEqual(record['mappingEvidenceUrl'], 'https://www.aasthaspintex.com/ipo')
        self.assertIsNone(record['issuerOverlay'])

    def test_duplicate_snapshot_symbols_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'duplicate symbols'):
            classify([{'symbol': 'SBIN'}, {'symbol': 'SBIN'}], '2026-10-13')

    def test_mirror_is_an_alias_not_a_new_exposure(self):
        record = classify([{'symbol': 'SBIN'}], '2026-10-13')['records']['SBIN']
        self.assertEqual(record['theme'], 'Public Sector Bank')
        self.assertIn('Banks - PSU', record['aliases'])
        self.assertNotIn('Banks - PSU', record['memberships'])
