"""Build and check the installed distribution without checkout imports or live work.

Run after installing pipeline dependencies plus build, setuptools>=69 and wheel:
    python3 tools/check_pipeline_wheel.py
"""

import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import venv


ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / "DO NOT DELETE EDL PIPELINE"
RESOURCES = ("breadth_methodology.json", "filing_source_labels.json")

PROBE = r'''
import importlib
import json
import pkgutil
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import edl_pipeline
import pipeline_utils
from edl_pipeline import publication
from edl_pipeline.artifacts import SCRIPT_OUTPUT_SPECS
from edl_pipeline.breadth.config import load_methodology
from filing_classification import source_label_mapping
from build_filing_history_artifact import classification_rules

installed = Path(pipeline_utils.__file__).parent
assert installed.is_relative_to(Path(__import__('sys').prefix)), installed
for module in pkgutil.walk_packages(edl_pipeline.__path__, edl_pipeline.__name__ + '.'):
    importlib.import_module(module.name)
for module in ('announcement_artifacts', 'build_chart_artifacts', 'nse_delivery',
               'nse_fno_ban', 'screen_trend_conditions', 'sync_local_scanner_history'):
    importlib.import_module(module)
for script in SCRIPT_OUTPUT_SPECS:
    assert (installed / script).is_file(), script
assert load_methodology(pipeline_utils.resource_path('breadth_methodology.json'))
assert source_label_mapping() == json.loads(Path('filing_source_labels.json').read_text())['fields']
assert classification_rules()[-1] == pipeline_utils.file_fingerprint(Path('filing_source_labels.json'))
stage = Path.cwd() / 'stage'
with patch.object(publication.subprocess, 'run', return_value=SimpleNamespace(returncode=1)) as run:
    assert publication.main(phase='fetch', stage_path=stage) == 1
    run.assert_called_once()
assert (stage / 'breadth_methodology.json').read_bytes() == Path('breadth_methodology.json').read_bytes()
import run_full_pipeline
with patch.object(run_full_pipeline, 'main', return_value=7) as main:
    assert run_full_pipeline.cli(['--phase', 'build', '--stage', str(stage)]) == 7
    main.assert_called_once_with(phase='build', stage_path=stage)
print('Wheel-only imports, runtime scripts, resource consumers and staging passed.')
'''


def main():
    with TemporaryDirectory(prefix="nexus-wheel-") as directory:
        temporary = Path(directory)
        dist = temporary / "dist"
        subprocess.run([sys.executable, "-m", "build", "--sdist", "--no-isolation",
                        "--outdir", str(dist), str(PIPELINE)], check=True)
        # Building from the sdist also proves that the canonical inputs survive it.
        archive, = dist.glob("*.tar.gz")
        subprocess.run([sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-build-isolation",
                        "--no-index", "--wheel-dir", str(dist), str(archive)], check=True)
        wheel, = dist.glob("*.whl")
        environment = temporary / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        bin_dir = environment / ("Scripts" if os.name == "nt" else "bin")
        python = bin_dir / ("python.exe" if os.name == "nt" else "python")
        subprocess.run([str(python), "-m", "pip", "install", str(wheel)], check=True)
        work = temporary / "outside-checkout"
        work.mkdir()
        for name in RESOURCES:
            # Expected bytes only; imports must resolve resources from the wheel.
            (work / name).write_bytes((PIPELINE / name).read_bytes())
        env = dict(os.environ, EDL_BASE_DIR=str(work / "outputs"))
        env.pop("PYTHONPATH", None)
        subprocess.run([str(python), "-I", "-c", PROBE], cwd=work, env=env, check=True, timeout=60)
        command = bin_dir / ("edl-pipeline.exe" if os.name == "nt" else "edl-pipeline")
        help_result = subprocess.run([str(command), "--help"], cwd=work, env=env,
                                     text=True, capture_output=True, timeout=15, check=True)
        assert "--phase" in help_result.stdout and "--stage" in help_result.stdout
        invalid = subprocess.run([str(command), "--phase", "fetch"], cwd=work, env=env,
                                 text=True, capture_output=True, timeout=15)
        assert invalid.returncode == 2 and "requires --stage" in invalid.stderr
        print("Installed CLI help and split-phase argument validation passed.")


if __name__ == "__main__":
    main()
