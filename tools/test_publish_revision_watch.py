import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools import publish_revision_watch as watch

OLD, NEW = 'a' * 64, 'b' * 64
SOURCE, WATCH = 'https://source.example/data/current.json', 'https://watch.example/current.json'
ENV = {'CLOUDFLARE_API_TOKEN': 'token', 'REVISION_WATCH_SOURCE_URL': SOURCE, 'REVISION_WATCH_URL': WATCH}


def manifest(revision):
    return json.dumps({'revision': revision, 'sessionDate': '2026-10-29'}).encode()


class PublishRevisionWatchTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / 'public').mkdir()
        self.source, self.served, self.deploys, self.sleeps = manifest(NEW), [manifest(OLD)], [], []

    def read(self, url, attempts=3):
        if url == SOURCE:
            return self.source
        body = self.served[0] if len(self.served) == 1 else self.served.pop(0)
        if isinstance(body, Exception):
            raise body
        return body

    def deploy(self, environ, worker_dir):
        self.deploys.append((environ['CLOUDFLARE_API_TOKEN'], worker_dir))

    def run_main(self, environ=ENV):
        return watch.main(environ, read=self.read, deploy=self.deploy, sleep=self.sleeps.append, worker_dir=self.dir)

    def test_without_a_token_it_warns_and_changes_nothing(self):
        self.assertEqual(watch.main({}, read=self.fail, deploy=self.fail, worker_dir=self.dir), 0)
        self.assertFalse((self.dir / 'public' / 'current.json').exists())

    def test_publishes_the_live_bytes_and_waits_until_they_are_served(self):
        self.served = [manifest(OLD), manifest(OLD), manifest(NEW)]  # before the deploy, then propagation
        self.assertEqual(self.run_main(), 0)
        self.assertEqual((self.dir / 'public' / 'current.json').read_bytes(), self.source)
        self.assertEqual(self.deploys, [('token', self.dir)])
        self.assertEqual(self.sleeps, [watch.VERIFY_DELAY])

    def test_skips_the_deploy_when_the_copy_already_serves_the_revision(self):
        self.served = [manifest(NEW)]
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.deploys, [])

    def test_first_deploy_when_the_copy_does_not_exist_yet(self):
        self.served = [None, manifest(NEW)]  # 404 before the first deploy
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.deploys), 1)

    def test_an_unreachable_copy_is_redeployed(self):
        self.served = [RuntimeError('offline'), manifest(NEW)]
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.deploys), 1)

    def test_rejects_a_live_file_without_a_revision(self):
        for body in (b'<html>', json.dumps({'revision': 'short'}).encode(), None):
            with self.subTest(body=body):
                self.source = body
                self.assertEqual(self.run_main(), 1)
                self.assertEqual(self.deploys, [])

    def test_reports_a_failed_deploy(self):
        def failing(environ, worker_dir):
            raise subprocess.CalledProcessError(1, 'wrangler')
        self.assertEqual(watch.main(ENV, read=self.read, deploy=failing, sleep=self.sleeps.append, worker_dir=self.dir), 1)

    def test_reports_a_copy_that_never_updates(self):
        self.served = [manifest(OLD)]
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(len(self.sleeps), watch.VERIFY_ATTEMPTS - 1)

    def test_revision_of_accepts_only_manifest_revisions(self):
        self.assertEqual(watch.revision_of(manifest(NEW)), NEW)
        for body in (None, b'', b'[]', b'{"revision": 5}', manifest('A' * 64)):
            self.assertIsNone(watch.revision_of(body))


class RevisionWatchWorkerTests(unittest.TestCase):
    def test_worker_is_assets_only_and_revalidated_cross_origin(self):
        config = (watch.WORKER_DIR / 'wrangler.jsonc').read_text()
        self.assertNotIn('"main"', config)  # a script would make every request a billed invocation
        self.assertIn('"directory": "./public"', config)
        headers = (watch.WORKER_DIR / 'public' / '_headers').read_text()
        rules = [line.strip() for line in headers.split('/current.json', 1)[1].splitlines() if line.strip()]
        self.assertIn('Cache-Control: no-cache', rules)
        self.assertIn('Access-Control-Allow-Origin: *', rules)
        self.assertIn('Access-Control-Expose-Headers: ETag', rules)

    def test_the_generated_copy_is_never_committed(self):
        ignored = subprocess.run(['git', 'check-ignore', 'workers/revision-watch/public/current.json'],
                                 cwd=watch.ROOT, capture_output=True, text=True)
        self.assertEqual(ignored.returncode, 0)


if __name__ == '__main__':
    unittest.main()
