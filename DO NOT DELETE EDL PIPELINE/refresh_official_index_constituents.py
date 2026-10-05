"""Refresh the standalone official NSE Indices constituent reference.

This stage is deliberately isolated from scanner and publication artifacts. It
only runs the repository-level reference refresher so the dated official
constituent snapshot stays current alongside normal pipeline refreshes.
"""

from pathlib import Path
import subprocess
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
REFRESHER = REPOSITORY_ROOT / "tools" / "fetch_requested_index_constituents.py"


def main() -> int:
    if not REFRESHER.is_file():
        print(f"Official index constituent refresher is missing: {REFRESHER}")
        return 1
    return subprocess.run([sys.executable, str(REFRESHER)], cwd=REPOSITORY_ROOT).returncode


if __name__ == "__main__":
    raise SystemExit(main())
