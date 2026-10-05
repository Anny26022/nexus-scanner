"""Pipeline runner orchestration.

The public script entrypoint delegates here so the orchestration can be tested
without shelling out to the full live pipeline.
"""

from concurrent.futures import ThreadPoolExecutor
import csv
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from tempfile import NamedTemporaryFile

from pipeline_utils import BASE_DIR, compress_file, save_json
import pipeline_utils

from .artifacts import (
    FILES_TO_COMPRESS,
    FINAL_ARTIFACT_SPECS,
    INTERMEDIATE_DIRS,
    INTERMEDIATE_FILES,
    OHLCV_DERIVED_FILES,
    OHLCV_DERIVED_FINAL_PATHS,
    OHLCV_DERIVED_SCRIPT,
    OHLCV_FETCH_LANE,
    OPTIONAL_SCRIPTS,
    PHASE2_SCRIPTS,
    PHASE4_SCRIPTS,
    POST_STANDARDIZATION_SCRIPTS,
    REQUIRED_PHASE2_SCRIPTS,
    SCANNER_HISTORY_SCRIPT,
    SCRIPT_OUTPUT_SPECS,
)
from .config import PipelineConfig
from .validators import validate_many


@dataclass
class ScriptResult:
    ok: bool
    required: bool
    elapsed: float = 0.0
    returncode: int = 0
    error: str = ""
    validations: list = field(default_factory=list)

    def to_dict(self):
        data = asdict(self)
        data["validations"] = [check.to_dict() for check in self.validations]
        return data


def validate_script_outputs(script_name):
    """Validate the known artifacts produced by a script."""
    specs = SCRIPT_OUTPUT_SPECS.get(script_name, [])
    if not specs:
        return []

    checks = validate_many(specs)
    failed = [check for check in checks if not check.ok]
    for check in failed:
        print(f"    WARNING: {check.path} validation failed: {check.message}")
    if checks and not failed:
        print(f"    Validated {len(checks)} artifact(s).")
    return checks


def run_script(script_name, phase_label="", required=False):
    """Run a Python script and report whether it completed successfully."""
    script_path = os.path.join(os.path.dirname(pipeline_utils.__file__), script_name)

    if not os.path.exists(script_path):
        print(f"  WARNING: SKIP: {script_name} not found.")
        return ScriptResult(False, required, error="missing")

    print(f"  Running {script_name}...")
    start = time.time()

    try:
        result = subprocess.run(
            [sys.executable, script_path],
            cwd=BASE_DIR,
            text=True,
            timeout=1800,
        )
        elapsed = time.time() - start

        if result.returncode == 0:
            validations = validate_script_outputs(script_name)
            failed_validations = [check for check in validations if not check.ok]
            if required and failed_validations:
                print(f"  FAILED {script_name} ({elapsed:.1f}s, output validation failed)")
                return ScriptResult(False, required, elapsed=elapsed, error="validation", validations=validations)
            print(f"  OK {script_name} ({elapsed:.1f}s)")
            return ScriptResult(True, required, elapsed=elapsed, validations=validations)

        print(f"  FAILED {script_name} ({elapsed:.1f}s, exit {result.returncode})")
        return ScriptResult(False, required, elapsed=elapsed, returncode=result.returncode)

    except subprocess.TimeoutExpired:
        print(f"  TIMEOUT {script_name} (>30 min)")
        return ScriptResult(False, required, elapsed=1800, error="timeout")
    except Exception as e:
        print(f"  EXCEPTION {script_name}: {e}")
        return ScriptResult(False, required, error=str(e))


def run_script_sequence(scripts):
    """Run one ordered lane and return its results keyed by script name."""
    return {
        script_name: run_script(script_name, phase_label, required)
        for script_name, phase_label, required in scripts
    }


def run_script_lanes(lanes):
    """Run independent ordered lanes with bounded top-level concurrency."""
    if not lanes:
        return {}
    if len(lanes) == 1:
        name, scripts = next(iter(lanes.items()))
        return {name: run_script_sequence(scripts)}

    with ThreadPoolExecutor(max_workers=len(lanes), thread_name_prefix="edl-fetch") as executor:
        futures = {
            name: executor.submit(run_script_sequence, scripts)
            for name, scripts in lanes.items()
        }
        # Preserve lane declaration order in reports even if completion order
        # differs. Script output itself remains visible live in Actions logs.
        return {name: futures[name].result() for name in lanes}


def compress_output(include_ohlcv_derived=True):
    """Compress final JSONs to .json.gz and return raw/gz byte sizes."""
    total_raw = 0
    total_gz = 0

    for filename, output_name in FILES_TO_COMPRESS.items():
        if not include_ohlcv_derived and filename in OHLCV_DERIVED_FILES:
            continue
        raw_size, gz_size = compress_file(filename, output_name)
        if raw_size:
            total_raw += raw_size
            total_gz += gz_size
        else:
            print(f"  WARNING: {filename} not found to compress.")

    ratio = (1 - total_gz / total_raw) * 100 if total_raw > 0 else 0
    print(
        f"  Compressed: {total_raw / (1024 * 1024):.1f} MB -> "
        f"{total_gz / (1024 * 1024):.1f} MB ({ratio:.0f}% reduction)"
    )
    return total_raw, total_gz


def download_nse_listing_dates():
    """Download NSE listing dates used by the base analyzer."""
    print("  Downloading NSE Listing Dates...")
    csv_path = Path(BASE_DIR) / "nse_equity_list.csv"
    temporary_path = None
    try:
        with NamedTemporaryFile("wb", delete=False, dir=csv_path.parent, prefix=".nse_equity_list.") as handle:
            temporary_path = Path(handle.name)
        result = subprocess.run([
            "curl", "--fail", "--silent", "--show-error", "--http1.1",
            "-o", str(temporary_path),
            "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
            "--header", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ], capture_output=True, text=True, timeout=30)
        with temporary_path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            headers = {header.strip() for header in reader.fieldnames or []}
            valid_rows = sum(1 for _ in reader)
        if result.returncode == 0 and {"SYMBOL", "NAME OF COMPANY"} <= headers and valid_rows >= 1000:
            temporary_path.replace(csv_path)
            print("  OK NSE Listing Dates downloaded.")
            return True
        print(f"  WARNING: NSE CSV download failed validation (exit {result.returncode}, non-critical).")
    except Exception as e:
        print(f"  WARNING: NSE CSV download failed: {e} (non-critical).")
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
    return False


def cleanup_intermediate():
    """Delete intermediate files and directories, keeping final gz artifacts and OHLCV cache."""
    removed_files = 0
    removed_dirs = 0
    freed_bytes = 0

    for filename in INTERMEDIATE_FILES:
        path = os.path.join(BASE_DIR, filename)
        if os.path.exists(path):
            freed_bytes += os.path.getsize(path)
            os.remove(path)
            removed_files += 1

    for dirname in INTERMEDIATE_DIRS:
        path = os.path.join(BASE_DIR, dirname)
        if os.path.exists(path):
            for root, _dirs, files in os.walk(path):
                for file in files:
                    freed_bytes += os.path.getsize(os.path.join(root, file))
            shutil.rmtree(path)
            removed_dirs += 1

    freed_mb = freed_bytes / (1024 * 1024)
    print(f"  Cleaned: {removed_files} files + {removed_dirs} dirs ({freed_mb:.1f} MB freed)")


def config_to_dict(config):
    return {
        "fetch_ohlcv": config.fetch_ohlcv,
        "fetch_optional": config.fetch_optional,
        "cleanup_intermediate": config.cleanup_intermediate,
    }


def build_pipeline_report(results, total_time, raw_size, gz_size, final_checks, config, exit_code):
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "base_dir": ".",
        "config": config_to_dict(config),
        "total_time_seconds": round(total_time, 3),
        "raw_size_bytes": raw_size,
        "gzip_size_bytes": gz_size,
        "exit_code": exit_code,
        "scripts": {script: result.to_dict() for script, result in results.items()},
        "final_artifacts": [check.to_dict() for check in final_checks],
    }


def write_pipeline_report(report):
    save_json("pipeline_report.json", report, indent=2, ensure_ascii=False)
    print("  Report: pipeline_report.json")


def validate_final_artifacts(include_ohlcv_derived=True):
    specs = [
        spec
        for spec in FINAL_ARTIFACT_SPECS
        if include_ohlcv_derived or spec.path not in OHLCV_DERIVED_FINAL_PATHS
    ]
    checks = validate_many(specs)
    failed = [check for check in checks if not check.ok]
    if failed:
        print("\nFINAL ARTIFACT VALIDATION")
        print("-" * 40)
        for check in failed:
            print(f"  FAILED {check.path}: {check.message}")
    else:
        print("  Final artifacts validated.")
    return checks


def print_final_report(results, total_time, raw_size, cleanup_intermediate_enabled, final_checks=None):
    final_checks = final_checks or []
    success = sum(1 for v in results.values() if v.ok)
    failed = sum(1 for v in results.values() if not v.ok)
    validation_warnings = sum(
        1 for result in results.values() for check in result.validations if not check.ok
    ) + sum(1 for check in final_checks if not check.ok)

    print("\n" + "=" * 60)
    print("  PIPELINE COMPLETE")
    print("=" * 60)
    print(f"  Total Time:  {total_time:.1f}s ({total_time / 60:.1f} min)")
    print(f"  Successful:  {success}/{len(results)}")
    print(f"  Failed:      {failed}/{len(results)}")
    print(f"  Validation:  {validation_warnings} warning(s)")

    if failed > 0:
        print("\n  Failed Scripts:")
        for script, result in results.items():
            if not result.ok:
                critical = " CRITICAL" if result.required else ""
                print(f"    FAILED{critical} {script}")

    gz_path = os.path.join(BASE_DIR, "all_stocks_fundamental_analysis.json.gz")
    if os.path.exists(gz_path):
        gz_mb = os.path.getsize(gz_path) / (1024 * 1024)
        raw_mb = raw_size / (1024 * 1024) if raw_size else 0
        print(f"\n  Output: all_stocks_fundamental_analysis.json.gz ({gz_mb:.1f} MB)")
        if raw_size:
            print(f"  Compression: {raw_mb:.1f} MB -> {gz_mb:.1f} MB ({(1 - gz_mb / raw_mb) * 100:.0f}% smaller)")

    if cleanup_intermediate_enabled:
        print("  Cleanup: only .json.gz + ohlcv_data/ remain. Intermediate data purged.")

    print("=" * 60)
    return failed


def main(config=None):
    """Run the full pipeline and return a process exit code."""
    config = config or PipelineConfig.from_env()
    overall_start = time.time()

    print("=" * 60)
    print("  EDL PIPELINE - FULL DATA REFRESH")
    print("=" * 60)

    results = {}
    raw_size = 0
    gz_size = 0
    final_checks = []

    print("\nPHASE 1: Core Data (Foundation)")
    print("-" * 40)
    results["fetch_dhan_data.py"] = run_script("fetch_dhan_data.py", "Phase 1", required=True)
    if not results["fetch_dhan_data.py"].ok:
        print("\nCRITICAL: fetch_dhan_data.py failed. Cannot continue.")
        print("   This script produces master_isin_map.json which ALL other scripts need.")
        write_pipeline_report(
            build_pipeline_report(results, time.time() - overall_start, raw_size, gz_size, final_checks, config, 1)
        )
        return 1

    # The raw ScanX response includes current SME listings.  Fetch the
    # authoritative NSE SME universe before any stage reads the canonical map.
    results["fetch_sme_data.py"] = run_script("fetch_sme_data.py", "Phase 1", required=True)
    if not results["fetch_sme_data.py"].ok:
        print("\nCRITICAL: fetch_sme_data.py failed. Cannot safely publish a mainboard-only universe.")
        write_pipeline_report(
            build_pipeline_report(results, time.time() - overall_start, raw_size, gz_size, final_checks, config, 1)
        )
        return 1

    results["filter_mainboard_universe.py"] = run_script(
        "filter_mainboard_universe.py", "Phase 1", required=True
    )
    if not results["filter_mainboard_universe.py"].ok:
        print("\nCRITICAL: mainboard universe filter failed. Cannot continue.")
        write_pipeline_report(
            build_pipeline_report(results, time.time() - overall_start, raw_size, gz_size, final_checks, config, 1)
        )
        return 1

    results["fetch_fundamental_data.py"] = run_script("fetch_fundamental_data.py", "Phase 1", required=True)
    if not results["fetch_fundamental_data.py"].ok:
        print("\nCRITICAL: fetch_fundamental_data.py failed. Cannot continue.")
        print("   This script produces fundamental_data.json for the base analyzer.")
        write_pipeline_report(
            build_pipeline_report(results, time.time() - overall_start, raw_size, gz_size, final_checks, config, 1)
        )
        return 1

    download_nse_listing_dates()
    results["reconcile_nse_equity_universe.py"] = run_script(
        "reconcile_nse_equity_universe.py", "Phase 1", required=False
    )

    if config.fetch_ohlcv:
        print("\nPHASE 2: Independent fetch lanes (Enrichment + OHLCV)")
        print("-" * 40)
        enrichment_scripts = [
            (script, "Phase 2 / enrichment lane", script in REQUIRED_PHASE2_SCRIPTS)
            for script in PHASE2_SCRIPTS
            if script != "fetch_nse_delivery_data.py"
        ]
        ohlcv_scripts = [
            (
                script,
                "Phase 2 / OHLCV lane",
                script != "fetch_nse_delivery_data.py",
            )
            for script in OHLCV_FETCH_LANE
        ]
        lane_results = run_script_lanes(
            {
                "enrichment": enrichment_scripts,
                "ohlcv": ohlcv_scripts,
            }
        )
        results.update(lane_results["enrichment"])
        results.update(lane_results["ohlcv"])

        print("\nPHASE 2.5: Index OHLCV (after index-list fetch)")
        print("-" * 40)
        results["fetch_indices_ohlcv.py"] = run_script(
            "fetch_indices_ohlcv.py", "Phase 2.5", required=True
        )
    else:
        print("\nPHASE 2: Data Enrichment (Fetching)")
        print("-" * 40)
        for script in PHASE2_SCRIPTS:
            results[script] = run_script(
                script,
                "Phase 2",
                required=script in REQUIRED_PHASE2_SCRIPTS,
            )

    print("\nPHASE 2.75: Standalone official index constituents")
    print("-" * 40)
    # This preserves a separate official reference only.  It is intentionally
    # not consumed by the scanner or publication path, and a temporary public
    # source failure must not block the core market-data refresh.
    results["refresh_official_index_constituents.py"] = run_script(
        "refresh_official_index_constituents.py", "Phase 2.75", required=False
    )

    print("\nPHASE 3: Base Analysis (Building Master JSON)")
    print("-" * 40)
    results["bulk_market_analyzer.py"] = run_script("bulk_market_analyzer.py", "Phase 3", required=True)
    if not results["bulk_market_analyzer.py"].ok:
        print("\nCRITICAL: bulk_market_analyzer.py failed.")
        print("   Cannot produce all_stocks_fundamental_analysis.json.")
        write_pipeline_report(
            build_pipeline_report(results, time.time() - overall_start, raw_size, gz_size, final_checks, config, 1)
        )
        return 1

    print("\nPHASE 4: Enrichment (Injecting into Master JSON)")
    print("-" * 40)
    for script in PHASE4_SCRIPTS:
        results[script] = run_script(
            script,
            "Phase 4",
            required=True,
        )

    print("\nPHASE 4.5: Canonical consumers")
    print("-" * 40)
    for script in POST_STANDARDIZATION_SCRIPTS:
        results[script] = run_script(script, "Phase 4.5", required=True)

    if any(result.required and not result.ok for result in results.values()):
        write_pipeline_report(build_pipeline_report(results, time.time() - overall_start, 0, 0, [], config, 1))
        return 1

    print("\nPHASE 5: Compression (.json -> .json.gz)")
    print("-" * 40)
    raw_size, gz_size = compress_output(include_ohlcv_derived=config.fetch_ohlcv)

    print("\nPHASE 5.5: Scanner point-in-time context")
    print("-" * 40)
    results[SCANNER_HISTORY_SCRIPT] = run_script(SCANNER_HISTORY_SCRIPT, "Phase 5.5", required=True)

    if config.fetch_optional:
        print("\nPHASE 6: Optional Standalone Data")
        print("-" * 40)
        for script in OPTIONAL_SCRIPTS:
            results[script] = run_script(script, "Phase 6")

    final_checks = validate_final_artifacts(
        include_ohlcv_derived=config.fetch_ohlcv
    )
    required_failed = any(result.required and not result.ok for result in results.values())
    final_failed = any(not check.ok for check in final_checks)
    exit_code = 1 if required_failed or final_failed else 0
    if exit_code == 0 and config.cleanup_intermediate:
        cleanup_intermediate()
    total_time = time.time() - overall_start
    print_final_report(results, total_time, raw_size, config.cleanup_intermediate and exit_code == 0, final_checks)
    write_pipeline_report(build_pipeline_report(results, total_time, raw_size, gz_size, final_checks, config, exit_code))
    return exit_code
