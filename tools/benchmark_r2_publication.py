"""Compare rclone discovery/concurrency using loopback S3, never live R2.

The artificial latency model measures request behavior, not production savings.
Run with --repeats 3 for medians; rclone 1.60.1 matches the inspected Actions job.
"""
import argparse
import bisect
from collections import Counter
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit
from xml.sax.saxutils import escape


class S3Fixture(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def respond(self, status, body=b'', headers=None):
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, str(value))
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def handle_object(self):
        state = self.server.state
        path = urlsplit(self.path)
        query = parse_qs(path.query)
        key = unquote(path.path).removeprefix('/test/')
        if path.path.rstrip('/') == '/test' and self.command == 'GET':
            with self.server.counter_lock:
                state['requests']['LIST'] += 1
            time.sleep(self.server.list_delay)
            keys = sorted(k for k in state['objects'] if k.startswith(query.get('prefix', [''])[0]))
            marker = query.get('continuation-token', query.get('marker', ['']))[0]
            start = bisect.bisect(keys, marker) if marker else 0
            batch = keys[start:start + 1000]
            more = start + len(batch) < len(keys)
            body = ['<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
                    '<Name>test</Name><MaxKeys>1000</MaxKeys>',
                    f'<IsTruncated>{str(more).lower()}</IsTruncated>']
            if more:
                body.append(f'<NextMarker>{batch[-1]}</NextMarker><NextContinuationToken>{batch[-1]}</NextContinuationToken>')
            for name in batch:
                data = state['objects'][name]
                body.append(f'<Contents><Key>{escape(name)}</Key><LastModified>2026-10-15T00:00:00.000Z</LastModified>'
                            f'<ETag>"{hashlib.md5(data).hexdigest()}"</ETag><Size>{len(data)}</Size>'
                            '<StorageClass>STANDARD</StorageClass></Contents>')
            self.respond(200, (''.join(body) + '</ListBucketResult>').encode(), {'Content-Type': 'application/xml'})
            return
        with self.server.counter_lock:
            state['requests'][self.command] += 1
        time.sleep(self.server.object_delay)
        if self.command == 'PUT':
            data = self.rfile.read(int(self.headers['Content-Length']))
            state['objects'][key] = data
            self.respond(200, headers={'ETag': '"' + hashlib.md5(data).hexdigest() + '"'})
        elif key not in state['objects']:
            self.respond(404, b'<Error><Code>NoSuchKey</Code></Error>')
        else:
            data = state['objects'][key]
            headers = {'ETag': '"' + hashlib.md5(data).hexdigest() + '"',
                       'Last-Modified': 'Thu, 15 Oct 2026 00:00:00 GMT'}
            if self.command == 'HEAD':
                self.send_response(200)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
            else:
                self.respond(200, data, headers)

    do_GET = do_HEAD = do_PUT = handle_object


class FixtureServer(ThreadingHTTPServer):
    request_queue_size = 256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rclone', default='rclone')
    parser.add_argument('--repeats', type=int, default=1)
    parser.add_argument('--list-delay', type=float, default=.08)
    parser.add_argument('--object-delay', type=float, default=.03)
    args = parser.parse_args()
    if args.repeats < 1 or min(args.list_delay, args.object_delay) < 0:
        parser.error('repeats must be positive and delays nonnegative')
    with tempfile.TemporaryDirectory() as folder:
        source = Path(folder) / 'source'
        source.mkdir()
        for i in range(500):
            (source / f'{i:064x}.json.gz').write_bytes(b'x' * 4096 + str(i).encode())
        expected = {'objects/' + p.name: p.read_bytes() for p in source.iterdir()}
        names = Path(folder) / 'names.txt'
        names.write_text('\n'.join(sorted(p.name for p in source.iterdir())) + '\n')
        server = FixtureServer(('127.0.0.1', 0), S3Fixture)
        server.counter_lock = threading.Lock()
        server.list_delay, server.object_delay = args.list_delay, args.object_delay
        env = {k: v for k, v in os.environ.items() if not k.startswith('RCLONE_')}
        env.update(RCLONE_CONFIG=os.devnull, RCLONE_CONFIG_BENCH_TYPE='s3',
                   RCLONE_CONFIG_BENCH_PROVIDER='Other', RCLONE_CONFIG_BENCH_ACCESS_KEY_ID='fixture',
                   RCLONE_CONFIG_BENCH_SECRET_ACCESS_KEY='fixture', RCLONE_CONFIG_BENCH_REGION='us-east-1',
                   RCLONE_CONFIG_BENCH_ENDPOINT=f'http://127.0.0.1:{server.server_port}', NO_PROXY='127.0.0.1')
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for existing in (10000, 0):
                for targeted, workers in ((False, 16), (True, 16), (True, 32), (True, 64), (False, 32)):
                    samples = []
                    for _ in range(args.repeats):
                        old = {f'objects/old{i:064x}.json.gz': b'old' for i in range(existing)}
                        server.state = {'objects': dict(old), 'requests': Counter()}
                        elapsed = []
                        for command in ('copy', 'check'):
                            flags = (['--immutable', '--checksum', '--metadata', '--metadata-set', 'content-type=application/gzip',
                                      '--metadata-set', 'cache-control=public,max-age=31536000,immutable', '--transfers', str(workers)]
                                     if command == 'copy' else ['--one-way', '--download'])
                            # Original copy used rclone's default eight checkers.
                            if command == 'check' or targeted or workers != 16:
                                flags += ['--checkers', str(workers)]
                            if targeted:
                                flags += ['--no-traverse']
                            start = time.perf_counter()
                            subprocess.run([args.rclone, command, str(source), 'bench:test/objects',
                                            '--files-from', str(names), '--s3-no-check-bucket', '--s3-no-head',
                                            '--retries', '1', *flags], env=env, check=True, capture_output=True, timeout=90)
                            elapsed.append(time.perf_counter() - start)
                        if server.state['objects'] != {**old, **expected}:
                            raise RuntimeError('Object bytes changed or unrelated objects were lost')
                        counts = dict(server.state['requests'])
                        if counts.get('PUT') != 500 or counts.get('GET') != 500 or (targeted and counts.get('LIST', 0)):
                            raise RuntimeError('Unexpected copy, download verification or discovery requests')
                        samples.append(elapsed)
                    print(json.dumps({'existing': existing, 'targeted': targeted, 'workers': workers,
                                      'copy_median_s': round(statistics.median(s[0] for s in samples), 3),
                                      'check_median_s': round(statistics.median(s[1] for s in samples), 3),
                                      'total_median_s': round(statistics.median(sum(s) for s in samples), 3),
                                      'requests': counts, 'repeats': args.repeats}), flush=True)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
