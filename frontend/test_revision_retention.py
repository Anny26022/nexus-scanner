import tempfile
import unittest
from pathlib import Path

from revision_retention import retain_revisions


class RevisionRetentionTests(unittest.TestCase):
    def test_keeps_current_and_previous_and_trims_the_previous_plain_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            current, previous, stale = 'a' * 64, 'b' * 64, 'c' * 64
            for revision in (current, previous, stale):
                directory = output / 'revisions' / revision
                (directory / 'financial-history').mkdir(parents=True)
                for name in ('stocks.json', 'stocks.json.gz', 'release.json', 'financial-history/TEST.json.gz'):
                    (directory / name).write_text('{}')
            (output / 'revisions' / 'not-a-revision').mkdir()

            self.assertEqual(retain_revisions(output, current, previous), [stale])

            self.assertFalse((output / 'revisions' / stale).exists())
            self.assertTrue((output / 'revisions' / current / 'stocks.json').exists())
            self.assertFalse((output / 'revisions' / previous / 'stocks.json').exists())
            self.assertTrue((output / 'revisions' / previous / 'stocks.json.gz').exists())
            self.assertTrue((output / 'revisions' / previous / 'financial-history/TEST.json.gz').exists())
            self.assertTrue((output / 'revisions' / 'not-a-revision').exists())

    def test_first_release_keeps_only_itself(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / 'revisions' / ('a' * 64)).mkdir(parents=True)
            (output / 'revisions' / ('c' * 64)).mkdir()
            self.assertEqual(retain_revisions(output, 'a' * 64), ['c' * 64])
            self.assertEqual(retain_revisions(output / 'missing', 'a' * 64), [])


if __name__ == '__main__':
    unittest.main()
