import unittest

from public_payload import public, public_ipos


class PublicPayloadTest(unittest.TestCase):
    def test_drops_provenance_at_every_depth_and_keeps_the_data(self):
        payload = {'source': 'upstream', 'records': [{'symbol': 'A', 'source_url': 'https://x', 'value': 1,
                                                     'nested': {'sourceUrl': 'https://y', 'kept': [{'source': 'z', 'n': 2}]}}]}
        self.assertEqual(public(payload), {'records': [{'symbol': 'A', 'value': 1, 'nested': {'kept': [{'n': 2}]}}]})

    def test_renames_provider_named_containers(self):
        self.assertEqual(public({'records': [{'scanx': {'details': {'issue_size': 10, 'cmpny_logo': 'https://x'}}}]}),
                         {'records': [{'profile': {'details': {'issue_size': 10}}}]})

    def test_neutralizes_methodology_notes_and_labels(self):
        row = {'debtToEquitySource': 'X', 'financialMetadata': {'basis': 'CONSOLIDATED', 'debt_to_equity_formula': 'X'},
               'memberships': {'Pharma': 'stockscans_manual', 'Banks': 'web-research'}}
        self.assertEqual(public(row), {'financialMetadata': {'basis': 'CONSOLIDATED'},
                                       'memberships': {'Pharma': 'manual', 'Banks': 'web-research'}})

    def test_ipo_catalogue_drops_the_raw_provider_dump(self):
        payload = public_ipos({'records': [], 'provider_data': {'details': {'a': {}}, 'scanx': {'feeds': {}}, 'fetched_at': 't'}})
        self.assertEqual(payload['provider_data'], {'details': {'a': {}}, 'fetched_at': 't'})

    def test_input_is_not_modified(self):
        original = {'source': 'upstream', 'items': [{'source': 'z'}]}
        public(original)
        self.assertEqual(original, {'source': 'upstream', 'items': [{'source': 'z'}]})


if __name__ == '__main__':
    unittest.main()
