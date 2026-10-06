import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from filing_classification import TAXONOMY, classify_filing, classify_filings
import build_filing_history_artifact as publisher
from build_chart_artifacts import _filing_events
from pipeline_utils import save_json, load_json


class FilingClassificationTests(unittest.TestCase):
    def test_taxonomy_has_unique_stable_ids(self):
        self.assertEqual(len(TAXONOMY), 60)
        self.assertEqual(len({r['id'] for r in TAXONOMY}), 60)

    def test_all_topics_have_positive_disclosure_fixtures(self):
        fixtures = {
            'financial_results': 'Financial Results', 'annual_report': 'Reg. 34 (1) Annual Report',
            'financial_revision': 'Voluntary revision of financial statements',
            'board_intimation': 'Board Meeting', 'board_outcome': 'Outcome of Board Meeting',
            'board_change': 'Board Meeting Rescheduled', 'general_announcement': 'General',
            'order_win': 'Award of Order / Receipt of Order', 'press_release': 'Press Release / Media Release',
            'business_update': 'Monthly Business Updates', 'investor_presentation': 'Investor Presentation',
            'capex': 'Capacity addition', 'commissioning': 'Commencement of commercial production',
            'regulatory_approval': 'Regulatory approval', 'product_launch': 'Product launch',
            'recognition': 'Received industry award', 'acquisition': 'Acquisition',
            'merger': 'Scheme of Arrangement', 'joint_venture': 'Joint Venture',
            'divestment': 'Sale or disposal', 'subsidiary': 'Incorporation',
            'bonus_split': 'Sub-division / Stock Split', 'buyback': 'Buy back',
            'listing': 'Delisting', 'dividend': 'Dividend', 'open_offer': 'Open Offer',
            'fundraise': 'Qualified Institutional Placement', 'allotment': 'Allotment of Equity Shares',
            'record_date': 'Record Date', 'borrowing': 'Giving guarantees', 'esop': 'Allotment of ESOP / ESPS',
            'ofs': 'Offer for Sale', 'debt_repayment': 'Intimation of Repayment of Commercial Paper',
            'fund_utilisation': 'Monitoring Agency Report', 'stake_change': 'Disclosures under SEBI SAST',
            'pledge': 'Pledge disclosure', 'credit_rating': 'Credit Rating', 'esg_rating': 'ESG rating',
            'shareholding_pattern': 'Shareholding', 'insider_transaction': 'Form C continual disclosure',
            'trading_plan': 'Trading Plan under SEBI PIT', 'clarification': 'Clarification sought',
            'disruption': 'Strikes / Lockouts / Disturbances', 'debt_default': 'Defaults on Payment of Interest',
            'insolvency': 'Appointment of Interim Resolution Professional', 'litigation': 'Pendency of Litigation',
            'workforce': 'Workforce restructuring', 'fraud': 'Frauds Initial Disclosure',
            'kmp_change': 'Resignation of Chief Financial Officer CFO', 'auditor_change': 'Appointment of Statutory Auditor',
            'director_change': 'Change in Directorate', 'secretary_change': 'Appointment of Company Secretary',
            'related_party': 'Related Party Transactions', 'shareholder_meeting': 'Postal Ballot',
            'call_transcript': 'Earnings Call Transcript', 'investor_meet': 'Analyst Investor Meet',
            'administration': 'Change of Name', 'compliance': 'Certificate under Reg 74 5',
            'post_action': 'Daily Buy Back of equity shares', 'newspaper': 'Newspaper Publication',
        }
        self.assertEqual(set(fixtures), {row['id'] for row in TAXONOMY})
        for topic, label in fixtures.items():
            with self.subTest(topic=topic):
                self.assertIn(topic, classify_filing({'descriptor': label})['topics'])

    def test_real_ambiguous_disclosures(self):
        cases = [
            ({'descriptor': 'Award_of_Order_Receipt_of_Order', 'caption': 'Order received from State Tax Officer'}, 'litigation', 'order_win'),
            ({'descriptor': 'Board Meeting', 'caption': 'To consider financial results'}, 'board_intimation', 'financial_results'),
            ({'descriptor': 'Closure of Trading Window', 'ann_type': 'Insider Trading / SAST'}, 'compliance', 'insider_transaction'),
            ({'descriptor': 'Allotment of ESOP / ESPS'}, 'esop', 'allotment'),
            ({'descriptor': 'Daily Buy Back of equity shares'}, 'post_action', 'buyback'),
            ({'descriptor': 'Reg. 34 (1) Annual Report'}, 'annual_report', 'unclassified'),
            ({'descriptor': 'General', 'caption': 'Incorporation of wholly owned subsidiary'}, 'subsidiary', 'general_announcement'),
        ]
        for row, included, excluded in cases:
            with self.subTest(row=row):
                topics = classify_filing(row)['topics']
                self.assertIn(included, topics)
                self.assertNotIn(excluded, topics)
        withdrawn = classify_filing({'caption': 'Board approved withdrawal of rights issue proposal'})
        self.assertIn('fundraise', withdrawn['topics'])
        self.assertEqual(withdrawn['status'], 'withdrawn')

    def test_unknown_and_multiple_topics(self):
        self.assertEqual(classify_filing({'caption': 'Please find enclosed'})['topics'], ['unclassified'])
        row = classify_filing({'descriptor': 'Outcome of Board Meeting', 'caption': 'Approved dividend'})
        self.assertEqual(row['documentType'], 'board_outcome')
        self.assertEqual(row['status'], 'approved')
        self.assertIn('dividend', row['topics'])

    def test_duplicate_documents_preserve_sources_and_revisions(self):
        base = {'news_date': '2026-10-05 16:00:00', 'file_url': 'https://example.com/a.pdf', 'caption': 'Dividend', 'news_body': 'Declared dividend'}
        rows = classify_filings([{**base, 'source_endpoint': 'lodr'}, {**base, 'source_endpoint': 'company_filings'}, {**base, 'caption': 'Revised dividend'}])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['sourceEndpoints'], ['company_filings', 'lodr'])
        self.assertEqual(len(rows[0]['sourceLabels']), 2)
        self.assertNotEqual(rows[0]['filingId'], rows[1]['filingId'])
        enriched = classify_filings([{**base, 'descriptor': 'General'}, {**base, 'descriptor': 'Financial Results'}])
        self.assertIn('financial_results', enriched[0]['classification']['topics'])
        self.assertNotIn('general_announcement', enriched[0]['classification']['topics'])

    def test_pipeline_publication_reaches_chart_without_future_filings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            save_json(root / 'filing_history_data/filing_history.json', {'symbols': {'ABC': {'filings': [
                {'descriptor': 'Dividend', 'news_date': '2026-10-05 16:30:00', 'source_endpoint': 'lodr'},
                {'descriptor': 'Acquisition', 'news_date': '2026-10-07'}]}}})
            with patch.object(publisher, 'BASE_DIR', str(root)):
                self.assertEqual(publisher.main(), 0)
            artifact = load_json(root / 'filing_history.json')
            self.assertEqual(artifact['classification_version'], 1)
            self.assertEqual(artifact['coverage']['filings'], 2)
            events = _filing_events(artifact, '2026-10-06')['ABC']
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]['classification']['topics'], ['dividend'])
            self.assertEqual(events[0]['publishedAt'], '2026-10-05 16:30:00')
