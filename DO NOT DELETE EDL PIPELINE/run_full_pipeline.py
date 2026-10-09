"""Compatibility wrapper for the package runner."""

import sys
import argparse
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from edl_pipeline.config import env_bool  # re-exported for existing tests/users
from edl_pipeline.publication import main


def cli(argv=None):
    """Share argument validation between the script and installed command."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=('all', 'fetch', 'build'), default='all')
    parser.add_argument('--stage', type=Path)
    args = parser.parse_args(argv)
    if args.phase != 'all' and args.stage is None:
        parser.error('--phase fetch/build requires --stage')
    return main(phase=args.phase, stage_path=args.stage)


if __name__ == "__main__":
    sys.exit(cli())
