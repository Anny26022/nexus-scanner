"""Build in isolation; promote only a complete, validated output set.

Git publication is one commit. Local promotion rolls back on an I/O failure;
it is not an atomic multi-file transaction for concurrent filesystem readers.
"""
import os
from contextlib import nullcontext
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory, NamedTemporaryFile

import pipeline_utils
from pipeline_utils import save_json
from .artifacts import FINAL_ARTIFACT_SPECS
from .config import PipelineConfig
from .quality import inspect_publication


def atomic_copy(source, destination):
    """Replace one artifact using bounded memory and a same-filesystem rename."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=destination.parent, suffix='.tmp', delete=False) as handle:
        temporary = Path(handle.name)
    try:
        shutil.copyfile(source, temporary)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def promote(stage, destination, names, directories=(), after=None):
    with TemporaryDirectory(prefix='.promotion-', dir=destination) as directory:
        _promote(stage, destination, names, directories, after, Path(directory))


def _promote(stage, destination, names, directories, after, backup_dir):
    """Roll back files and chart directories together if publication fails."""
    # Preflight every source before touching published files.
    for name in names:
        with (stage / name).open('rb'):
            pass
    previous_files = {name: (destination / name).exists() for name in names}
    for name, exists in previous_files.items():
        if exists:
            backup = backup_dir / name
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(destination / name, backup)
    replaced_files, replaced_directories = [], []
    paths = [(destination / name, destination / f".{name}.incoming",
              destination / f".{name}.previous") for name in directories]
    # Recover the previous charts after an interrupted directory swap.
    for target, incoming, previous in paths:
        if previous.exists() and not target.exists():
            previous.replace(target)
        elif previous.exists():
            shutil.rmtree(previous)
        shutil.rmtree(incoming, ignore_errors=True)
    try:
        for name, (_, incoming, _) in zip(directories, paths):
            shutil.copytree(stage / name, incoming)
        for name in names:
            replaced_files.append(name)
            atomic_copy(stage / name, destination / name)
        for target, incoming, previous in paths:
            replaced_directories.append((target, previous, target.exists()))
            if target.exists():
                target.replace(previous)
            incoming.replace(target)
        if after:
            after()
    except Exception:
        for target, previous, existed in reversed(replaced_directories):
            if previous.exists():
                shutil.rmtree(target, ignore_errors=True)
                previous.replace(target)
            elif not existed:
                shutil.rmtree(target, ignore_errors=True)
        for name in reversed(replaced_files):
            if not previous_files[name]:
                (destination / name).unlink(missing_ok=True)
            else:
                atomic_copy(backup_dir / name, destination / name)
        raise
    finally:
        for _, incoming, _ in paths:
            shutil.rmtree(incoming, ignore_errors=True)
    for _, _, previous in paths:
        shutil.rmtree(previous, ignore_errors=True)


def promote_directory(stage, destination, name):
    promote(stage, destination, [], directories=(name,))


def publish_frontend(destination):
    publisher = Path(pipeline_utils.__file__).resolve().parent.parent / 'frontend' / 'publish_snapshot.py'
    if publisher.exists():
        result = subprocess.run([sys.executable, str(publisher)], cwd=publisher.parent,
                                env=dict(os.environ, EDL_BASE_DIR=str(destination)))
        if result.returncode:
            raise RuntimeError('Scanner snapshot publication failed; the previous frontend revision remains active.')


def main(phase="all", stage_path=None):
    if phase not in {"all", "fetch", "build"} or (phase != "all" and stage_path is None):
        raise ValueError("Split refreshes require an explicit stage directory")
    config = PipelineConfig.from_env()
    destination = Path(pipeline_utils.BASE_DIR)
    source = Path(pipeline_utils.__file__).resolve().parent
    destination.mkdir(parents=True, exist_ok=True)
    # A no-history run is diagnostic only; never mix fresh stocks with old breadth.
    if not config.fetch_ohlcv:
        print("EDL_FETCH_OHLCV=0: diagnostic run; published files will not change.")
    context = nullcontext(str(stage_path)) if stage_path is not None else TemporaryDirectory(prefix=".edl-refresh-", dir=destination)
    with context as temporary:
        stage = Path(temporary).resolve()
        if stage == destination.resolve():
            raise ValueError("Stage and destination must differ")
        marker = stage / '.refresh-stage.json'
        if phase == 'build':
            if pipeline_utils.load_json(marker, default={}) != {'destination': str(destination.resolve())}:
                raise ValueError('Stage was not prepared for this destination')
        if phase != 'build':
            if stage_path is not None:
                stage.mkdir(parents=True, exist_ok=False)
            save_json(marker, {"destination": str(destination.resolve())})
            for name in ("ohlcv_data", "indices_ohlcv_data", "delivery_history_data", "eod2_delivery_history_data", "scanner_history_data", "filing_history_data", "ipo_provider_history_data", "scanx_ipo_history_data"):
                cache = destination / name
                cache.mkdir(exist_ok=True)
                (stage / name).symlink_to(cache, target_is_directory=True)
            methodology = destination / "breadth_methodology.json"
            if not methodology.exists():
                methodology = source / "breadth_methodology.json"
            shutil.copy2(methodology, stage / methodology.name)
            listed_archive = destination / "ipo_provider_listed_archive.json.gz"
            if listed_archive.exists():
                shutil.copy2(listed_archive, stage / listed_archive.name)
            calendar = destination / "earnings_calendar.json.gz"
            if calendar.exists():
                shutil.copy2(calendar, stage / calendar.name)
            details_archive = destination / "ipo_provider_details_archive.json.gz"
            if details_archive.exists():
                shutil.copy2(details_archive, stage / details_archive.name)
            for name in ("scanx_ipo_listed_archive.json.gz", "scanx_ipo_details_archive.json.gz"):
                archive = destination / name
                if archive.exists():
                    shutil.copy2(archive, stage / archive.name)
        env = dict(os.environ, EDL_BASE_DIR=str(stage), EDL_CLEANUP_INTERMEDIATE="0", EDL_PIPELINE_PHASE=phase, PYTHONUNBUFFERED="1")
        env["PYTHONPATH"] = os.pathsep.join([str(source), str(source / "src"), env.get("PYTHONPATH", "")])
        result = subprocess.run(
            [sys.executable, "-c", "import os; from edl_pipeline.runner import main; raise SystemExit(main(phase=os.environ['EDL_PIPELINE_PHASE']))"],
            cwd=stage, env=env,
        )
        report_path = stage / "pipeline_report.json"
        report = pipeline_utils.load_json(report_path, default={})
        if result.returncode != 0 or not config.fetch_ohlcv:
            report["published"] = False
            save_json(destination / "pipeline_failure_report.json", report)
            return result.returncode
        if phase == "fetch":
            return 0
        quality = inspect_publication(stage)
        save_json(stage / "data_quality.json", quality)
        report["quality_errors"] = quality["errors"]
        report["published"] = not quality["errors"]
        if quality["errors"]:
            report["exit_code"] = 1
            save_json(destination / "pipeline_failure_report.json", report)
            save_json(destination / "data_quality_failure.json", quality)
            print("Publication rejected:", "; ".join(quality["errors"][:10]))
            return 1
        save_json(report_path, report)
        names = [spec.path for spec in FINAL_ARTIFACT_SPECS] + ["data_quality.json", "pipeline_report.json"]
        promote(stage, destination, names, directories=("chart_artifacts",),
                after=lambda: publish_frontend(destination))
        print("Published validated dataset and per-symbol data_quality.json.")
        if stage_path is not None:
            shutil.rmtree(stage)
        return 0
