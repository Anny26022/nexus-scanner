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


def prepare_filing_archives(root, directory):
    """Read immutable staged inputs directly, using the original archive writer."""
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
            with source.open('rb') as incoming, temporary.open('wb') as outgoing:
                with gzip.GzipFile(fileobj=outgoing, mode='wb', mtime=0, filename='') as packed:
                    shutil.copyfileobj(incoming, packed)
            digest = file_digest(temporary)
            temporary.replace(directory / (digest + '.json.gz'))
            archives[name] = digest
    (directory / 'index.json').write_text(json.dumps(archives, separators=(',', ':')))
    return archives
