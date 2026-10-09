"""Deterministic retained filing archives; preparation never publishes a pointer."""
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import tempfile


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_archive_payload(compressed, temporary):
    """Reuse a freshly compressed level-9 stream with a deterministic header.

    Only accept the header emitted by pipeline_utils.compress_file. Unsupported
    headers fall back to the original archive writer, not a partial archive.
    """
    with compressed.open('rb') as incoming:
        header = incoming.read(10)
        if (len(header) != 10 or header[:3] != b'\x1f\x8b\x08'
                or header[3] not in (0, 8) or header[8:] != b'\x02\xff'):
            return False
        if header[3] == 8:
            for _ in range(1024):
                byte = incoming.read(1)
                if byte == b'\0':
                    break
                if not byte:
                    return False
            else:
                return False
        with temporary.open('wb') as outgoing:
            outgoing.write(b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff')
            shutil.copyfileobj(incoming, outgoing)
    return True


def prepare_filing_archives(root, directory, *, compressed_classified=None):
    """Retain both archives; optionally reuse this run's classified compression.

    compressed_classified must be the fresh compress_file result for the same
    immutable source, never a restored or source-hash-only cache entry.
    """
    directory.mkdir(parents=True, exist_ok=True)
    archives = {}
    for name, source in (
        ('classified', root / 'filing_history.json'),
        ('raw', root / 'filing_history_data/filing_history.json'),
    ):
        if not source.is_file():
            continue
        with tempfile.TemporaryDirectory(dir=directory) as folder:
            temporary = Path(folder) / 'archive.json.gz'
            reused = (name == 'classified' and compressed_classified is not None
                      and _copy_archive_payload(compressed_classified, temporary))
            if not reused:
                with source.open('rb') as incoming, temporary.open('wb') as outgoing:
                    with gzip.GzipFile(fileobj=outgoing, mode='wb', mtime=0, filename='') as packed:
                        shutil.copyfileobj(incoming, packed)
            digest = file_digest(temporary)
            temporary.replace(directory / (digest + '.json.gz'))
            archives[name] = digest
    with tempfile.TemporaryDirectory(dir=directory) as folder:
        temporary = Path(folder) / 'index.json'
        temporary.write_text(json.dumps(archives, separators=(',', ':')))
        temporary.replace(directory / 'index.json')
    return archives
