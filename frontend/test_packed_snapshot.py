import copy
import json
from pathlib import Path
import unittest
from packed_snapshot import pack_snapshot


def decode_packed_snapshot(packed):
    """Independent test decoder; do not call the publisher's encoder."""
    def records(table):
        return [
            {key: value for i, (key, value) in enumerate(zip(table['keys'], row)) if i not in missing}
            for row, missing in zip(table['values'], table['missing'])
        ]
    stocks = records(packed['stocksTable'])
    for field, nested in packed['nestedTables'].items():
        for position, child in zip(nested['indexes'], records(nested['table'])):
            stocks[position][field] = child
    return {
        **{key: value for key, value in packed.items() if key not in ('stockEncoding', 'stocksTable', 'nestedTables')},
        'stocks': stocks,
    }


class PackedSnapshotTests(unittest.TestCase):
    def test_shared_browser_fixture_and_input_unchanged(self):
        fixture = json.loads((Path(__file__).parent/'src/__tests__/fixtures/packedSnapshot.json').read_text())
        original = copy.deepcopy(fixture['original'])
        self.assertEqual(pack_snapshot(original), fixture['packed'])
        self.assertEqual(original, fixture['original'])
        self.assertEqual(decode_packed_snapshot(fixture['packed']), original)
