import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from classification_contract import catalog_of, group_labels, validate_classification, project_company_classifications
from theme_classification import classify, consolidated_classification, SOURCE_PATH, POLICY_PATH


class ClassificationContractTests(unittest.TestCase):
    def test_cross_language_contract_and_complete_source_graph(self):
        fixture = json.loads((Path(__file__).parent / 'src/__tests__/fixtures/classificationContract.json').read_text())
        actual = classify(fixture['stocks'], fixture['sessionDate'])
        self.assertEqual(actual['records'], fixture['taxonomy']['records'])
        self.assertEqual(actual['nodes'], fixture['taxonomy']['nodes'])
        self.assertEqual(len(actual['nodes']), 316)
        self.assertEqual(actual['records']['CYIENTDLM']['levels']['theme'], ['Emerging EMS', 'Industrial Systems & Controls'])
        self.assertEqual(actual['records']['CYIENTDLM']['levels']['macro'], ['II. INDUSTRIAL & DEFENSE ALPHA'])
        self.assertEqual(actual['records']['ONLY_YOUNG']['theme'], None)
        self.assertEqual(actual['records']['ONLY_YOUNG']['memberships'], {})
        self.assertEqual(actual['coverage']['unmapped'], ['ONLY_YOUNG'])
        validate_classification(fixture['stocks'], actual, consolidated_classification(fixture['stocks'], actual))

    def test_aliases_resolve_but_aggregates_never_guess_leaf_exposures(self):
        stocks = [{'symbol':'HOTEL', 'sector':'Leisure Services', 'industry':'Hotels & Resorts'},
                  {'symbol':'BROAD', 'sector':'Automobiles', 'industry':'Auto Components'}]
        result = classify(stocks, '2026-10-23')
        self.assertEqual(result['records']['HOTEL']['theme'], 'Premium Hotels & Resorts')
        broad = result['records']['BROAD']
        self.assertEqual(broad['mappingSpecificity'], 'broad')
        self.assertEqual(broad['levels']['theme'], ['Auto Components'])
        self.assertNotIn('Drivetrain & Axles', broad['memberships'])

    def test_cohort_requires_recent_listing_and_expires_independently(self):
        base = {'symbol':'UNKNOWN', 'metrics':{'historySessions':10}}
        for value in (None, 'bad', '1995-02-08', '2026-10-24'):
            with self.subTest(listing=value):
                row = classify([{**base, 'listingDate':value}], '2026-10-23')['records']['UNKNOWN']
                self.assertEqual(row['cohorts'], {})
        young = classify([{**base, 'listingDate':'01-OCT-2026'}], '2026-10-23')['records']['UNKNOWN']
        self.assertEqual(list(young['cohorts']), ['IPO / Young Bases'])
        old = classify([{**base, 'listingDate':'2026-10-01', 'metrics':{'historySessions':101}}], '2026-10-23')
        self.assertEqual(old['records']['UNKNOWN']['cohorts'], {})

    def test_reviewed_businesses_and_overlap_decisions(self):
        rows = classify([{'symbol':s} for s in ['RAYMOND','LUMAXIND','VIMTALABS','KENNAMET','GNA','STERTOOLS']], '2026-10-23')['records']
        self.assertEqual(rows['RAYMOND']['theme'], 'Precision Components & Tools')
        self.assertIn('Aerospace & Defense OEM', rows['RAYMOND']['memberships'])
        self.assertNotIn('Premium & Branded Apparel', rows['RAYMOND']['memberships'])
        self.assertEqual(rows['VIMTALABS']['subIndustry'], 'Contract Research & Testing')
        self.assertEqual(rows['LUMAXIND']['theme'], 'Electronics & Systems')
        self.assertIn('Drivetrain & Axles', rows['GNA']['memberships'])
        self.assertNotIn('EPC / Buildout', rows['STERTOOLS']['memberships'])

    def test_verified_recent_issuers_and_dated_symbol_change(self):
        symbols = ['AZADIND','BONFIG','FUSIONCX','HDFIRE','SMT','TONBO','ZETWERK','ICICILIFE']
        result = classify([{'symbol':symbol} for symbol in symbols], '2026-10-23')
        self.assertEqual(result['coverage']['unmapped'], [])
        self.assertEqual(result['records']['ICICILIFE']['theme'], 'Life Insurance')
        self.assertEqual(result['records']['ICICILIFE']['sourceSymbol'], 'ICICIPRULI')
        self.assertIsNone(classify([{'symbol':'ICICILIFE'}], '2026-10-22')['records']['ICICILIFE']['theme'])

    def test_reviewed_overlay_can_reject_an_imported_membership(self):
        rows = classify([{'symbol':'TATATECH'}, {'symbol':'KAYNES'}], '2026-10-23')['records']
        self.assertEqual(rows['TATATECH']['theme'], 'ER&D / Product Software')
        self.assertNotIn('Emerging EMS', rows['TATATECH']['memberships'])
        self.assertIn('Emerging EMS', rows['KAYNES']['memberships'])
        self.assertEqual(rows['KAYNES']['theme'], 'EMS - Electronics')

    def test_macro_pillars_follow_business_scope_rather_than_a_proxy_end_market(self):
        rows = classify([{'symbol':'TEAMLEASE'}, {'symbol':'POLYCAB'}], '2026-10-23')['records']
        self.assertEqual(rows['TEAMLEASE']['macro'], 'VII. BUSINESS & PROFESSIONAL SERVICES')
        self.assertEqual(rows['POLYCAB']['macro'], 'II. INDUSTRIAL & DEFENSE ALPHA')

    def test_specific_aliases_do_not_expand_to_unrelated_businesses(self):
        rows = classify([{'symbol':s} for s in ['DIVISLAB','CPPLUS','CDSL','DLF']], '2026-10-23')['records']
        self.assertNotIn('Pharma - API', rows['DIVISLAB']['aliases'])
        self.assertNotIn('Consumer Electronics - EMS', rows['CPPLUS']['aliases'])
        self.assertNotIn('Finance - Capital Markets - RTA', rows['CDSL']['aliases'])
        self.assertIn('Real Estate Developers', rows['DLF']['levels']['aggregate'])
        self.assertNotIn('Realty - National', rows['DLF']['levels']['aggregate'])

    def test_bridge_predicate_uses_frozen_memberships_and_preserves_unknowns(self):
        import scanner_bridge as bridge
        node = bridge.translate('THEME', {'values':['Industrial Systems & Controls','Emerging EMS'], 'match':'ALL'})
        record = classify([{'symbol':'CYIENTDLM'}], '2026-10-23')['records']['CYIENTDLM']
        diagnostics = set()
        self.assertTrue(bridge.evaluate(node, {'symbol':'CYIENTDLM', 'as_of_date':'2026-10-23'}, None,
            {'classifications':{'CYIENTDLM':record}}, '2026-10-23', diagnostics, []))
        self.assertIsNone(bridge.evaluate(node, {'symbol':'UNKNOWN', 'as_of_date':'2026-10-23'}, None,
            {'classifications':{}}, '2026-10-23', diagnostics, []))

    def test_ipo_projection_preserves_other_fields_and_uses_primary_business_labels(self):
        original = [{'symbol':'A', 'sector':'Old', 'industry':'Old', 'close':123}, {'symbol':'OUTSIDE', 'sector':'Retain'}]
        projected = project_company_classifications(original, [{'symbol':'A','sector':'New','industry':'New industry'}])
        self.assertEqual(projected[0], {'symbol':'A','sector':'New','industry':'New industry','close':123})
        self.assertEqual(projected[1], original[1])
        self.assertEqual(original[0]['sector'], 'Old')

    def test_primary_is_independent_of_source_block_and_stock_order(self):
        source = json.loads(SOURCE_PATH.read_text())
        source['blocks'].reverse()
        for block in source['blocks']:
            block['themes'].reverse()
        stocks = [{'symbol':'CYIENTDLM'}, {'symbol':'UNREVIEWED', 'sector':'Financial Services', 'industry':'NBFC'}]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'source.json'; path.write_text(json.dumps(source))
            before = classify(stocks, '2026-10-23')
            after = classify(list(reversed(stocks)), '2026-10-23', path)
        self.assertEqual(before['records'], after['records'])

    def test_graph_and_projection_validation_fail_closed(self):
        source = json.loads(SOURCE_PATH.read_text()); policy = json.loads(POLICY_PATH.read_text())
        source['blocks'][0]['themes'][0]['mirrorOf'] = ['Public Sector Bank']
        with self.assertRaisesRegex(ValueError, 'cycle'):
            catalog_of(source, policy)
        stocks = [{'symbol':'CYIENTDLM'}]; taxonomy = classify(stocks, '2026-10-23')
        combined = consolidated_classification(stocks, taxonomy)
        combined['records']['CYIENTDLM']['thematic'] = {}
        with self.assertRaisesRegex(ValueError, 'projections disagree'):
            validate_classification(stocks, taxonomy, combined)
        combined = consolidated_classification(stocks, taxonomy)
        combined['records']['CYIENTDLM']['basicIndustry'] = 'Unrelated imported industry'
        with self.assertRaisesRegex(ValueError, 'Primary company classification projections disagree'):
            validate_classification(stocks, taxonomy, combined)

    def test_legacy_memberships_do_not_depend_on_evidence_basis(self):
        row = {'symbol':'A'}
        record = {'theme':'One', 'memberships':{'One':'manual','Two':'reviewed-overlap','IPO / Young Bases':'curated-rule'}}
        self.assertEqual(group_labels(row, record, 'theme'), ['One','Two'])
        self.assertEqual(group_labels(row, record, 'cohort'), ['IPO / Young Bases'])
        self.assertEqual(group_labels(row, {'theme':'IPO / Young Bases','block':'EMERGING THEMES'}, 'block'), [])


if __name__ == '__main__':
    unittest.main()
