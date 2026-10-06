import tempfile
import unittest
import gzip
import json
from pathlib import Path
from unittest.mock import patch

from filing_classification import VERSION, TAXONOMY, classify_filing, classify_filings, classify_corporate_action, source_label_mapping
import build_filing_history_artifact as publisher
from build_chart_artifacts import _filing_events
import build_chart_artifacts as chart_publisher
from pipeline_utils import save_json, load_json


class FilingClassificationTests(unittest.TestCase):
    def test_taxonomy_has_unique_stable_ids(self):
        self.assertEqual(len(TAXONOMY), 61)
        self.assertEqual(len({r['id'] for r in TAXONOMY}), 61)

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
            'regulatory_update': 'USFDA warning letter',
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
                self.assertEqual(classify_filing({'descriptor': label})['topics'], [topic])

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
            self.assertEqual(artifact['classification_version'], VERSION)
            self.assertEqual(artifact['coverage']['filings'], 2)
            events = _filing_events(artifact, '2026-10-06')['ABC']
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]['classification']['topics'], ['dividend'])
            self.assertEqual(events[0]['publishedAt'], '2026-10-05 16:30:00')

    def test_inventory_mapping_uses_valid_topics_and_keeps_ambiguous_labels_open(self):
        valid = {row['id'] for row in TAXONOMY}
        mappings = source_label_mapping()
        for field, mapping in mappings.items():
            for label, topics in mapping.items():
                self.assertTrue(set(topics) <= valid, (field, label))
        self.assertEqual(mappings['descriptor']['appointment'], [])
        self.assertEqual(classify_filing({'descriptor': 'Meeting Updates'})['topics'], ['unclassified'])

    def test_archive_business_aliases_and_negative_examples(self):
        cases = [
            ('Capacity Enhancement Of MEA Ethylation Unit', {'capex'}),
            ('Provisional Operational Updates - Q4 FY26', {'business_update'}),
            ('Formal inauguration of Research & Development Laboratory', {'product_launch'}),
            ('ABB inaugurates new factory, doubles production capacity', {'product_launch', 'capex'}),
            ('Received contract from Airport Authority', {'order_win'}),
        ]
        for caption, expected in cases:
            with self.subTest(caption=caption):
                self.assertTrue(expected <= set(classify_filing({'descriptor': 'General', 'caption': caption})['topics']))
        fraud = classify_filing({'caption': 'Fraud warning: Telegram channel ABD Sales Volume No.1'})
        self.assertNotIn('business_update', fraud['topics'])
        signature = classify_filing({'caption': 'Please find enclosed', 'news_body': 'For Company Limited, Company Secretary'})
        self.assertNotIn('secretary_change', signature['topics'])
        tax = classify_filing({'descriptor': 'Award_of_Order_Receipt_of_Order', 'caption': 'Award of Order', 'news_body': 'Assessment order received from State Tax Officer'})
        self.assertIn('litigation', tax['topics'])
        self.assertNotIn('order_win', tax['topics'])

    def test_regulatory_outcomes_are_not_positive_approvals(self):
        for caption, outcome in [('USFDA warning letter', 'adverse_observations'),
                                 ('Lifting of Import Alert 66-40 by US FDA', 'restriction_lifted'),
                                 ('USFDA inspection concluded with no adverse observations', 'no_adverse_observations')]:
            with self.subTest(caption=caption):
                result = classify_filing({'descriptor': 'Regulatory approval', 'caption': caption})
                self.assertIn('regulatory_update', result['topics'])
                self.assertNotIn('regulatory_approval', result['topics'])
                self.assertTrue(any(e['evidence'].get('outcome') == outcome for e in result['events']))
        self.assertIn('regulatory_approval', classify_filing({'caption': 'USFDA approved product'})['topics'])

    def test_event_statuses_remain_separate(self):
        for text in ('Regulatory approval pending', 'Awaiting approval', 'Approval for project'):
            self.assertNotEqual(classify_filing({'caption': text})['status'], 'approved')
        result = classify_filing({'descriptor': 'Outcome of Board Meeting', 'caption': 'Approved dividend; withdrew rights issue proposal'})
        self.assertEqual(result['status'], 'mixed')
        statuses = {(e['topic'], e['status']) for e in result['events']}
        self.assertIn(('dividend', 'approved'), statuses)
        self.assertIn(('fundraise', 'withdrawn'), statuses)
        conditional = classify_filing({'descriptor': 'Board Meeting', 'caption': 'To consider dividend, if any; to consider acquisition'})
        statuses = {(e['topic'], e['status']) for e in conditional['events']}
        self.assertIn(('dividend', 'conditional'), statuses)
        self.assertIn(('acquisition', 'proposed'), statuses)
        self.assertEqual(classify_filing({'caption': 'Commercial production has not commenced'})['status'], 'not_completed')
        self.assertEqual(classify_filing({'descriptor': 'Closure of Trading Window', 'ann_type': 'Insider Trading / SAST'})['topics'], ['compliance'])

    def test_negated_approval_and_completion_are_not_positive_events(self):
        for caption in ('Dividend was not approved', 'Dividend has not yet been approved',
                        'Dividend was not declared'):
            with self.subTest(caption=caption):
                result = classify_filing({'caption': caption})
                self.assertEqual(result['status'], 'not_approved')
                self.assertTrue(result['events'])
                self.assertTrue(all(e['status'] != 'approved' for e in result['events']))
        for caption in ('Regulatory approval has not yet been granted',
                        'USFDA has not received regulatory approval'):
            with self.subTest(caption=caption):
                self.assertEqual(classify_filing({'caption':caption})['status'], 'not_approved')
        for caption in ('Commissioning has not yet been completed',
                        'Commissioning not yet been completed',
                        'Commercial production has not yet commenced'):
            with self.subTest(caption=caption):
                result = classify_filing({'caption': caption})
                self.assertEqual(result['status'], 'not_completed')
                self.assertTrue(result['events'])

    def test_revision_priority_preserves_withdrawal_and_cancellation(self):
        for caption, status in [('Revised and approved dividend', 'revised'),
                                ('Revised outcome dividend completed', 'revised'),
                                ('Withdrawn revised dividend', 'withdrawn'),
                                ('Cancelled revised dividend', 'cancelled')]:
            with self.subTest(caption=caption):
                self.assertEqual(classify_filing({'caption': caption})['status'], status)
        result = classify_filing({'caption':'Revised and approved dividend; withdrew rights issue'})
        self.assertEqual(result['status'], 'mixed')
        dividend = next(e for e in result['events'] if e['topic'] == 'dividend')
        self.assertEqual(dividend['status'], 'revised')
        self.assertEqual(dividend['evidence']['excerpt'], 'Revised and approved dividend')

    def test_rta_certificate_is_only_compliance_and_wrapper_status_is_secondary(self):
        result = classify_filing({'descriptor': 'Reg. 7(3) Compliance Certificate - RTA & Compliance Officer'})
        self.assertEqual(result['topics'], ['compliance'])
        self.assertEqual([e['topic'] for e in result['events']], ['compliance'])
        result = classify_filing({'descriptor':'Board Meeting', 'caption':'Dividend withdrawn'})
        self.assertEqual(result['status'], 'withdrawn')
        self.assertIn(('board_intimation','proposed'), {(e['topic'],e['status']) for e in result['events']})

    def test_regulatory_negative_clause_does_not_erase_separate_approval(self):
        for update in ('USFDA warning letter', 'USFDA inspection with no adverse observations',
                       'Import alert lifted by USFDA'):
            with self.subTest(update=update):
                result = classify_filing({'descriptor':'Regulatory approval',
                                         'caption': f'USFDA approved product A; {update}'})
                self.assertIn('regulatory_approval', result['topics'])
                self.assertIn('regulatory_update', result['topics'])
                approval = [e for e in result['events'] if e['topic'] == 'regulatory_approval']
                self.assertEqual(len(approval), 1)
                self.assertEqual(approval[0]['status'], 'approved')
                self.assertEqual(approval[0]['evidence']['excerpt'], 'USFDA approved product A')

    def test_missing_corporate_action_terms_are_absent(self):
        self.assertEqual(classify_corporate_action({})['terms'], {})
        action = classify_corporate_action({'action_type':'DIVIDEND', 'ex_date':'2026-10-05',
                                           'source_details':'Dividend Rs 5 Per Share'})
        self.assertNotIn('recordDate', action['terms'])
        self.assertEqual(action['terms']['exDate'], '2026-10-05')
        self.assertEqual(action['terms']['dividendAmountsRupeesPerShare'], [5.0])

    def test_legacy_chart_filings_have_ids_and_no_fake_endpoints(self):
        raw = {'caption': 'Dividend', 'news_date': '2026-10-05', 'sourceEndpoints': []}
        payload = {'records': [{'symbol': 'ABC', 'filings': [raw]}]}
        event = _filing_events(payload, '2026-10-06')['ABC'][0]
        self.assertEqual(event['sourceEndpoints'], [])
        self.assertEqual(event['filingId'], classify_filings([raw])[0]['filingId'])
        self.assertEqual(event['classification']['version'], VERSION)

    def test_historical_presentations_and_inventory_subtypes(self):
        result = classify_filing({'descriptor': 'Investor Presentation', 'caption': 'Investor presentation', 'news_body': 'Previously announced acquisition completed last year. Capacity enhancement in 2026.'})
        self.assertEqual(result['topics'], ['investor_presentation'])
        current = classify_filing({'caption': 'Capacity enhancement announced in 2026'})
        self.assertIn('capex', current['topics'])
        self.assertTrue(any(e['topic'] == 'capex' for e in current['events']))
        self.assertTrue(all(e['reference'] == 'unspecified' for e in current['events']))
        for label, subtype in [('Loss of Certificate / Duplicate Certificate', 'securities_certificate'),
                               ('Book Closure', 'book_closure'), ('Business Responsibility and Sustainability Report', 'sustainability_report')]:
            self.assertIn(subtype, classify_filing({'descriptor': label})['subtypes'])

    def test_duplicate_classification_is_order_independent(self):
        base = {'file_url': 'https://example.com/a.pdf', 'news_date': '2026-10-05', 'caption': 'Approved dividend'}
        rows = [{**base, 'descriptor': 'General'}, {**base, 'descriptor': 'Outcome of Board Meeting'}]
        forward = classify_filings(rows)[0]['classification']
        reverse = classify_filings(list(reversed(rows)))[0]['classification']
        self.assertEqual(forward, reverse)
        self.assertEqual(forward['documentType'], 'board_outcome')
        rows = [{**base, 'caption': 'Please find enclosed', 'descriptor': 'Dividend'},
                {**base, 'caption': 'Please find enclosed', 'descriptor': 'Record Date'}]
        self.assertEqual(classify_filings(rows)[0]['classification'],
                         classify_filings(list(reversed(rows)))[0]['classification'])

    def test_official_action_terms_do_not_change_adjustments(self):
        dividend = {'action_type': 'dividend', 'source_details': 'Dividend - Rs 5 Per Share / Special Dividend - Re. 1/- Per Share', 'ex_date': '2026-10-05', 'record_date': '2026-10-06'}
        terms = classify_corporate_action(dividend)['terms']
        self.assertEqual(terms['dividendAmountsRupeesPerShare'], [5, 1])
        self.assertEqual(terms['exDate'], dividend['ex_date'])
        self.assertEqual(terms['recordDate'], dividend['record_date'])
        self.assertNotIn('classification', dividend)
        bonus = classify_corporate_action({'action_type': 'bonus', 'source_details': 'Bonus 1:2'})
        self.assertEqual(bonus['terms']['bonusRatio'], {'issued': 1, 'held': 2})
        split = classify_corporate_action({'action_type': 'split', 'source_details': 'Face Value Split From Rs 10 To Rs 2'})
        self.assertEqual(split['terms']['splitFaceValuesRupees'], {'old': 10, 'new': 2})

    def test_action_classification_reaches_compressed_chart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            save_json(root / 'all_stocks_fundamental_analysis.json', [{'symbol': 'ABC', 'as_of_date': '2026-10-06'}])
            action = {'symbol': 'ABC', 'action_type': 'BONUS', 'ex_date': '2026-10-05',
                      'record_date': '2026-10-06', 'source_details': 'Bonus 1:2',
                      'adjustment_factor': 2 / 3, 'share_factor': 1.5}
            save_json(root / 'corporate_action_ledger.json', {'records': [action, {**action, 'ex_date': '2026-10-07'}]})
            with patch.object(chart_publisher, 'BASE_DIR', str(root)):
                self.assertEqual(chart_publisher.main(), 0)
            with gzip.open(root / 'chart_artifacts/ABC.json.gz', 'rt') as handle:
                chart = json.load(handle)
            self.assertEqual(len(chart['corporateActions']), 1)
            published = chart['corporateActions'][0]
            self.assertEqual(published['adjustment_factor'], action['adjustment_factor'])
            self.assertEqual(published['share_factor'], action['share_factor'])
            self.assertEqual(published['ex_date'], action['ex_date'])
            self.assertEqual(published['classification']['terms']['bonusRatio'], {'issued': 1, 'held': 2})
            self.assertEqual(chart['filingClassificationVersion'], VERSION)
