import io
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from pypdf import PdfWriter
import filing_documents as documents
from filing_classification import classify_filing, classify_filings
import build_filing_history_artifact as publisher
from build_chart_artifacts import _filing_events
from pipeline_utils import load_json, save_json


class EventModelTests(unittest.TestCase):
    def test_term_sheet_execution_is_not_transaction_completion(self):
        result = classify_filing({'descriptor': 'General', 'caption': 'Execution of Binding Term Sheet between Optiemus Infracom Limited and Nothing Electronics Private Limited'})
        event = result['events'][0]
        self.assertEqual(result['topics'], ['strategic_agreement'])
        self.assertEqual(event['status'], 'executed')
        self.assertEqual(event['transactionStage'], 'unknown')
        self.assertEqual(event['instrument'], 'binding_term_sheet')
        self.assertEqual(event['partiesMentioned'][1], 'Nothing Electronics Private Limited')
        self.assertNotIn('importance', result)

    def test_mou_source_label_does_not_assert_joint_venture(self):
        result = classify_filing({'descriptor': 'Memorandum of Understanding /Agreements'})
        self.assertEqual(result['topics'], ['strategic_agreement'])
        self.assertEqual(result['events'][0]['transactionStage'], 'unknown')

    def test_nonbinding_negated_and_conditional_agreements(self):
        for caption, expected in [('Execution of non-binding term sheet', 'executed'), ('Binding term sheet has not yet been executed', 'not_executed'), ('Proposed execution of binding term sheet', 'proposed'), ('Signed binding term sheet subject to regulatory approval', 'executed')]:
            with self.subTest(caption=caption):
                event = next(e for e in classify_filing({'caption': caption})['events'] if e['topic'] == 'strategic_agreement')
                self.assertEqual(event['status'], expected)
                self.assertEqual(event['transactionStage'], 'unknown')
        self.assertEqual(classify_filing({'caption': 'Execution of non-binding term sheet'})['events'][0]['instrument'], 'non_binding_term_sheet')

    def test_guarantee_loan_and_intent_are_separate(self):
        for caption, included, excluded in [('Corporate guarantee enhanced', 'corporate_guarantee', 'borrowing'), ('Execution of loan agreement', 'borrowing', 'corporate_guarantee'), ('Receipt of letter of intent', 'letter_of_intent', 'order_win'), ('Letter of award for supply of power', 'order_win', 'letter_of_intent')]:
            with self.subTest(caption=caption):
                result = classify_filing({'descriptor': 'General', 'caption': caption})
                self.assertIn(included, result['topics'])
                self.assertNotIn(excluded, result['topics'])

    def test_specific_label_allows_independent_current_events(self):
        result = classify_filing({'descriptor': 'Acquisition', 'caption': 'Acquisition completed; executed binding term sheet'})
        statuses = {(e['topic'], e['status']) for e in result['events']}
        self.assertIn(('acquisition', 'completed'), statuses)
        self.assertIn(('strategic_agreement', 'executed'), statuses)
        result = classify_filing({'caption': 'Acquisition update: completed execution of loan agreement'})
        self.assertNotEqual(next(e for e in result['events'] if e['topic'] == 'acquisition')['status'], 'completed')

    def test_revision_group_preserves_observations(self):
        base = {'file_url': 'https://www.bseindia.com/a.pdf', 'news_date': '2026-10-01', 'caption': 'Corporate guarantee'}
        rows = classify_filings([base, {**base, 'caption': 'Revised corporate guarantee'}])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['documentGroupId'], rows[1]['documentGroupId'])
        self.assertNotEqual(rows[0]['filingId'], rows[1]['filingId'])


class DocumentTests(unittest.TestCase):
    def test_invalid_host_rejected_before_request(self):
        with patch.object(documents.requests, 'get') as request:
            with self.assertRaises(ValueError):
                documents.download_pdf('https://example.com/x.pdf')
            request.assert_not_called()

    @unittest.skipIf(sys.platform == "darwin", "macOS RLIMIT_AS unsupported: parser intentionally fails closed")
    def test_scanned_pdf_is_unreadable_not_invented(self):
        writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
        stream = io.BytesIO(); writer.write(stream)
        with patch.object(documents, 'download_pdf', return_value=stream.getvalue()):
            result = documents.extract_document('https://www.bseindia.com/x.pdf')
        self.assertEqual(result['status'], 'unreadable')

    def test_pdf_cache_publication_and_chart_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = {'descriptor': 'General', 'caption': 'Please find attached intimation', 'file_url': 'https://www.bseindia.com/x.pdf', 'news_date': '2026-10-01'}
            save_json(root / 'filing_history_data/filing_history.json', {'updated_at': '2026-10-04', 'symbols': {'ABC': {'filings': [row]}}})
            parsed = {'status': 'extracted', 'sha256': 'a' * 64, 'pages': [{'page': 1, 'text': 'Execution of binding term sheet between ABC Limited and XYZ Limited'}]}
            with patch.object(documents, 'extract_document', return_value=parsed) as fetch, patch.object(publisher, 'BASE_DIR', str(root)):
                self.assertEqual(publisher.main(), 0)
                self.assertEqual(publisher.main(), 0)
                fetch.assert_called_once()
            event = _filing_events(load_json(root / 'filing_history.json'), '2026-10-04')['ABC'][0]
            self.assertEqual(event['classification']['topics'], ['strategic_agreement'])
            self.assertEqual(event['classification']['events'][0]['evidence']['field'], 'document_page_1')
            self.assertNotIn('pages', event['documentExtraction'])
            self.assertEqual(event['documentExtraction']['sha256'], 'a' * 64)
            with patch.object(documents, 'extract_document') as fetch:
                records = [{'filings': [row.copy()]}]
                documents.enrich_documents(records, root, '2026-11-01')
                self.assertIn('documentExtraction', records[0]['filings'][0])
                fetch.assert_not_called()

    def test_failure_retains_metadata_and_retries_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [{'descriptor': 'General', 'caption': 'Corporate guarantee', 'news_date': '2026-10-01', 'file_url': f'https://www.bseindia.com/{i}.pdf'} for i in range(3)]
            with patch.dict('os.environ', {'EDL_FILING_PDF_LIMIT': '1'}), patch.object(documents, 'extract_document', side_effect=ValueError('invalid')) as fetch:
                documents.enrich_documents([{'filings': rows}], root, '2026-10-04')
                self.assertEqual(fetch.call_count, 1)
                selected = next(row for row in rows if 'documentExtraction' in row)
                self.assertEqual(selected['documentExtraction']['status'], 'failed')
                self.assertEqual(classify_filing(rows[0])['topics'], ['corporate_guarantee'])
                documents.enrich_documents([{'filings': [selected]}], root, '2026-10-04')
                self.assertEqual(fetch.call_count, 1)


class ReviewRegressionTests(unittest.TestCase):
    def test_conditional_execution_and_signed_execution_are_distinct(self):
        for text, expected in [
            ('Execution of binding term sheet subject to board approval', 'conditional'),
            ('Signing of binding term sheet subject to shareholder approval', 'conditional'),
            ('Signed binding term sheet subject to regulatory approval', 'executed')]:
            result = classify_filing({'caption': text})
            event = next(e for e in result['events'] if e['topic'] == 'strategic_agreement')
            self.assertEqual(event['status'], expected)
            self.assertEqual(event['agreementStage'], expected)
            self.assertEqual(event['transactionStage'], 'unknown')

    def test_loan_not_strategic_and_explicit_collaboration_is(self):
        loan = classify_filing({'caption': 'Execution of loan agreement'})
        self.assertEqual(loan['topics'], ['borrowing'])
        partnership = classify_filing({'caption': 'Execution of collaboration services agreement with UBS'})
        self.assertIn('strategic_agreement', partnership['topics'])

    def test_evidence_is_bounded_and_contains_late_match(self):
        raw = 'background ' * 2000 + 'Corporate guarantee enhanced for subsidiary ABC'
        event = classify_filing({'news_body': raw})['events'][0]
        excerpt = event['evidence']['excerpt']
        self.assertLessEqual(len(excerpt), 360)
        self.assertIn('Corporate guarantee', excerpt)
        self.assertIn(excerpt, raw)
        self.assertFalse(any(k.startswith('_') for k in event['evidence']))

    def test_equivalent_copies_merge_but_independent_events_remain(self):
        result = classify_filing({'caption': 'Corporate guarantee for ABC', 'news_body': 'Please find attached intimation regarding corporate guarantee for ABC.'})
        self.assertEqual(len(result['events']), 1)
        result = classify_filing({'caption': 'Corporate guarantee for ABC; corporate guarantee for XYZ'})
        self.assertEqual(len(result['events']), 2)

    def test_pdf_sort_is_stable_and_invalid_budget_falls_back(self):
        rows = [{'caption': 'Corporate guarantee', 'news_date': '2026-10-01', 'file_url': f'https://www.bseindia.com/{i}.pdf'} for i in range(3)]
        selected = []
        for ordered in (rows, list(reversed(rows))):
            with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'EDL_FILING_PDF_LIMIT': '1'}), patch.object(documents, 'extract_document', return_value={'status': 'unreadable'}) as fetch:
                documents.enrich_documents([{'filings': [dict(r) for r in ordered]}], Path(directory), '2026-10-04')
                selected.append(fetch.call_args.args[0])
        self.assertEqual(selected[0], selected[1])
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'EDL_FILING_PDF_LIMIT': 'invalid'}):
            result = documents.enrich_documents([], Path(directory), '2026-10-04')
            self.assertEqual(result['limit'], 20)

    def test_parser_has_resource_limits_and_timeout(self):
        import resource
        writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
        stream = io.BytesIO(); writer.write(stream)
        with patch.object(resource, 'setrlimit') as limits:
            self.assertEqual(documents._parse_pdf(stream.getvalue())['status'], 'unreadable')
            self.assertEqual(limits.call_args_list[0].args, (resource.RLIMIT_AS, (384 * 1024 * 1024,) * 2))
            self.assertEqual(limits.call_args_list[1].args, (resource.RLIMIT_CPU, (10, 10)))
        with patch.object(documents, 'download_pdf', return_value=stream.getvalue()), patch.object(documents.subprocess, 'run', side_effect=subprocess.TimeoutExpired('parser', 15)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                documents.extract_document('https://www.bseindia.com/x.pdf')
            self.assertEqual(run.call_args.kwargs['timeout'], 15)
            self.assertTrue(run.call_args.kwargs['check'])

    def test_chart_metadata_is_independent_of_attempt_time(self):
        classified = classify_filings([{'caption': 'Corporate guarantee', 'news_date': '2026-10-01'}])[0]
        outputs = []
        for attempted in ('2026-10-01', '2026-10-02'):
            row = {**classified, 'documentExtraction': {'status': 'failed', 'error': 'HTTPError', 'attemptedAt': attempted}}
            outputs.append(_filing_events({'records': [{'symbol': 'ABC', 'filings': [row]}]}, '2026-10-04'))
        self.assertEqual(outputs[0], outputs[1])
        self.assertNotIn('attemptedAt', outputs[0]['ABC'][0]['documentExtraction'])
