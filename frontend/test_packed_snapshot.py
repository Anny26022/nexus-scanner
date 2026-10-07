import copy
import json
from pathlib import Path
import unittest
from packed_snapshot import pack_snapshot


class PackedSnapshotTests(unittest.TestCase):
    def test_shared_browser_fixture_and_input_unchanged(self):
        fixture = json.loads((Path(__file__).parent/'src/__tests__/fixtures/packedSnapshot.json').read_text())
        original = copy.deepcopy(fixture['original'])
        self.assertEqual(pack_snapshot(original), fixture['packed'])
        self.assertEqual(original, fixture['original'])
