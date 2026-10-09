"""Pipeline runner orchestration.

The public script entrypoint delegates here so the orchestration can be tested
without shelling out to the full live pipeline.
"""

from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from collections import deque
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

from pipeline_utils import BASE_DIR, compress_file, file_fingerprint, save_json
from filing_archives import prepare_filing_archives
import pipeline_utils

from .artifacts import (
    BULK_FETCH_SCRIPTS,
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
from .validators import ArtifactCheck, validate_many


@dataclass
class ScriptResult:
    ok: bool
    required: bool
    elapsed: float = 0.0
    returncode: int = 0
    error: str = ""
    validations: list = field(default_factory=list)
    validation_elapsed: float = 0.0

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
            validation_start = time.time()
            validations = validate_script_outputs(script_name)
            validation_elapsed = time.time() - validation_start
            print(f"  Validation {script_name}: {validation_elapsed:.2f}s", flush=True)
            failed_validations = [check for check in validations if not check.ok]
            if required and failed_validations:
                print(f"  FAILED {script_name} ({elapsed:.1f}s, output validation failed)")
                return ScriptResult(False, required, elapsed=elapsed, error="validation", validations=validations, validation_elapsed=validation_elapsed)
            print(f"  OK {script_name} ({elapsed:.1f}s)")
            return ScriptResult(True, required, elapsed=elapsed, validations=validations, validation_elapsed=validation_elapsed)

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

    # Yield capacity between scripts, not only when a whole lane finishes.
    # Keep the formerly disjoint high-fanout quote/news fetches disjoint;
    # interleaving their CPU-only preparation must not stack provider pools.
    sequences = {name: iter(scripts) for name, scripts in lanes.items()}
    ready = deque((name, next(scripts, None)) for name, scripts in sequences.items())
    results = {name: {} for name in lanes}
    with ThreadPoolExecutor(max_workers=min(3, len(lanes)), thread_name_prefix="edl-fetch") as executor:
        pending = {}
        while ready or pending:
            for _ in range(len(ready)):
                if len(pending) == min(3, len(lanes)):
                    break
                name, script = ready.popleft()
                if script is None:
                    continue
                if script[0] in BULK_FETCH_SCRIPTS and any(item[1][0] in BULK_FETCH_SCRIPTS for item in pending.values()):
                    ready.append((name, script))
                    continue
                pending[executor.submit(run_script, *script)] = (name, script)
            if not pending:
                continue
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                name, script = pending.pop(future)
                results[name][script[0]] = future.result()
                ready.append((name, next(sequences[name], None)))
    # Reports retain lane and script declaration order, not completion order.
    return results


def compress_output(include_ohlcv_derived=True, prepared=None):
    """Compress final JSONs to .json.gz and return raw/gz byte sizes."""
    total_raw = 0
    total_gz = 0

    files = [(name, output) for name, output in FILES_TO_COMPRESS.items()
             if include_ohlcv_derived or name not in OHLCV_DERIVED_FILES]
    # Independent files retain their serializer, compression level and atomic
    # replacement. Report results in declaration order.
    with ThreadPoolExecutor(max_workers=min(2, os.cpu_count() or 1)) as executor:
        futures = [(prepared or {}).get(name) or executor.submit(compress_file, name, output)
                   for name, output in files]
        for (filename, output_name), future in zip(files, futures):
            raw_size, gz_size = future.result()
            if raw_size:
                total_raw += raw_size
                total_gz += gz_size
                print(f"  OK {output_name} ({gz_size / (1024 * 1024):.1f} MB)", flush=True)
            else:
                print(f"  WARNING: {filename} not found to compress.")

    ratio = (1 - total_gz / total_raw) * 100 if total_raw > 0 else 0
    print(
        f"  Compressed: {total_raw / (1024 * 1024):.1f} MB -> "
        f"{total_gz / (1024 * 1024):.1f} MB ({ratio:.0f}% reduction)"
    )
    return total_raw, total_gz


def prepare_filing_output():
    """Hide filing compression/archival behind independent stock enrichment."""
    started = time.perf_counter()
    sizes = compress_file('filing_history.json', FILES_TO_COMPRESS['filing_history.json'])
    prepare_filing_archives(Path(BASE_DIR), Path(BASE_DIR) / '.filing_archives',
                            compressed_classified=Path(BASE_DIR) / 'filing_history.json.gz')
    print(f'  Filing compression and archives elapsed: {time.perf_counter() - started:.2f}s', flush=True)
    return sizes


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
        if result.returncode == 0 and {"SYMBOL", "NAME OF COMPANY", "ISIN NUMBER", "DATE OF LISTING"} <= headers and valid_rows >= 1000:
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


def validate_final_artifacts(include_ohlcv_derived=True, prepared=None):
    specs = [
        spec
        for spec in FINAL_ARTIFACT_SPECS
        if include_ohlcv_derived or spec.path not in OHLCV_DERIVED_FINAL_PATHS
    ]
    prepared = prepared or {}
    reusable = {spec.path: prepared[spec.path][1] for spec in specs
                if spec.path in prepared and prepared[spec.path][0] is not None
                and file_fingerprint(Path(BASE_DIR) / spec.path) == prepared[spec.path][0]}
    remaining = iter(validate_many([spec for spec in specs if spec.path not in reusable]))
    checks = [reusable[spec.path] if spec.path in reusable else next(remaining) for spec in specs]
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


def main(config=None, phase="all"):
    """Run all stages or resume validated fetch results in the same staging directory."""
    if phase not in {"all", "fetch", "build"}:
        raise ValueError("Unknown pipeline phase")
    config = config or PipelineConfig.from_env()
    overall_start = time.time()

    print("=" * 60)
    print("  EDL PIPELINE - FULL DATA REFRESH")
    print("=" * 60)

    results = {}
    checkpoint_path = Path(BASE_DIR) / 'fetch_checkpoint.json'
    if phase == 'build':
        try:
            checkpoint = pipeline_utils.load_json(checkpoint_path, default={})
        except (OSError, ValueError):
            checkpoint = {}
        if not isinstance(checkpoint, dict) or checkpoint.get('config') != config_to_dict(config) or checkpoint.get('exit_code') != 0:
            raise ValueError('Cannot build from a missing, failed or incompatible fetch checkpoint')
        for script, data in checkpoint['scripts'].items():
            results[script] = ScriptResult(**{**data, 'validations': [ArtifactCheck(**v) for v in data['validations']]})
        overall_start -= checkpoint['total_time_seconds']
    raw_size = 0
    gz_size = 0
    final_checks = []

    if phase != 'build':
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

        if not download_nse_listing_dates():
            results['nse_equity_list.csv'] = ScriptResult(False, True, error='Fresh NSE listing validation failed')
            write_pipeline_report(build_pipeline_report(results, time.time() - overall_start, 0, 0, [], config, 1))
            return 1

        # The canonical universe must use the completed session, including
        # when today's new listings already appear in the provider snapshot.
        results["fetch_nse_delivery_data.py"] = run_script("fetch_nse_delivery_data.py", "Phase 1", required=True)
        if not results["fetch_nse_delivery_data.py"].ok:
            write_pipeline_report(build_pipeline_report(results, time.time() - overall_start, 0, 0, [], config, 1))
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

        results['validate_market_quotes.py'] = run_script('validate_market_quotes.py', 'Phase 1', required=True)
        if not results['validate_market_quotes.py'].ok:
            write_pipeline_report(build_pipeline_report(results, time.time() - overall_start, 0, 0, [], config, 1))
            return 1

        results["fetch_fundamental_data.py"] = run_script("fetch_fundamental_data.py", "Phase 1", required=True)
        if not results["fetch_fundamental_data.py"].ok:
            print("\nCRITICAL: fetch_fundamental_data.py failed. Cannot continue.")
            print("   This script produces fundamental_data.json for the base analyzer.")
            write_pipeline_report(
                build_pipeline_report(results, time.time() - overall_start, raw_size, gz_size, final_checks, config, 1)
            )
            return 1

        results["reconcile_nse_equity_universe.py"] = run_script(
            "reconcile_nse_equity_universe.py", "Phase 1", required=False
        )

        reference_scripts = [(name, "Phase 2 / reference lane", True)
                             for name in ("fetch_ipo_provider_data.py", "fetch_scanx_ipo_data.py")]
        if config.fetch_ohlcv:
            print("\nPHASE 2: Independent fetch lanes (Enrichment + OHLCV)")
            print("-" * 40)
            enrichment_scripts = [
                (script, "Phase 2 / enrichment lane", script in REQUIRED_PHASE2_SCRIPTS)
                for script in PHASE2_SCRIPTS
                if script == "fetch_company_filings.py"
            ]
            independent_scripts = [
                (script, "Phase 2 / independent lane", script in REQUIRED_PHASE2_SCRIPTS)
                for script in PHASE2_SCRIPTS
                if script != "fetch_company_filings.py"
            ]
            ohlcv_scripts = [
                (
                    script,
                    "Phase 2 / OHLCV lane",
                    True,
                )
                for script in OHLCV_FETCH_LANE
            ]
            # These smaller fetches consume foundation files, not the official
            # constituent refresh. Queue them on the first free worker rather
            # than behind that slow refresh (still at most three subprocesses).
            # Their internal order retains the corporate-actions/calendar and
            # price-band dependencies; index OHLCV still waits for all lanes.
            lane_results = run_script_lanes(
                {
                    "enrichment": enrichment_scripts,
                    "ohlcv": ohlcv_scripts,
                    "reference": reference_scripts,
                    "independent": independent_scripts,
                }
            )
            results.update(lane_results["enrichment"])
            results.update(lane_results["ohlcv"])
            results.update(lane_results["reference"])
            results.update(lane_results["independent"])

            # A required fetch failure cannot produce a valid dataset. Stop
            # here instead of spending the build phase on outputs that will be
            # rejected, while retaining the report for the next retry.
            if any(result.required and not result.ok for result in results.values()):
                report = build_pipeline_report(results, time.time() - overall_start, 0, 0, [], config, 1)
                save_json(checkpoint_path, report)
                write_pipeline_report(report)
                return 1

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

            # Preserve the no-OHLCV diagnostic path's existing stage order.
            results.update(run_script_sequence(reference_scripts + [
                ("refresh_official_index_constituents.py", "Phase 2 / reference lane", False)]))

        failed = any(result.required and not result.ok for result in results.values())
        if phase == 'fetch' or failed:
            report = build_pipeline_report(results, time.time() - overall_start, 0, 0, [], config, int(failed))
            save_json(checkpoint_path, report)
            write_pipeline_report(report)
            return int(failed)

    # The official constituent reference writes only repository/reference/.
    # No scanner, index-history or publication calculation consumes it. Retain
    # the refresh and its result, but hide network waits behind the build.
    # Older fetch checkpoints may already include it: never execute it twice.
    reference_name = "refresh_official_index_constituents.py"
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

    # Start best-effort work only after the fail-fast base build succeeds;
    # executor shutdown cannot then delay reporting a base-build failure.
    prepared = {}
    prepared_checks = {}
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="edl-prepare") as preparation, \
            ThreadPoolExecutor(max_workers=2, thread_name_prefix="edl-build") as executor:
        # Both consume completed fetch inputs and write separate artifacts.
        # Neither reads or mutates the stock snapshot being enriched below.
        def prepare_and_validate_filings():
            sizes = prepare_filing_output()
            spec = next(spec for spec in FINAL_ARTIFACT_SPECS if spec.path == 'filing_history.json.gz')
            started = time.perf_counter()
            digest = file_fingerprint(Path(BASE_DIR) / spec.path)
            checks = validate_many([spec])
            prepared_checks[spec.path] = (digest, checks[0])
            print(f'  Early filing gzip validation elapsed: {time.perf_counter() - started:.2f}s', flush=True)
            return sizes

        def build_independent(name):
            result = run_script(name, "Build / independent", required=True)
            if name == 'build_filing_history_artifact.py' and result.ok and (Path(BASE_DIR) / 'filing_history.json').is_file():
                prepared['filing_history.json'] = preparation.submit(prepare_and_validate_filings)
            return result
        independent = {
            name: executor.submit(build_independent, name)
            for name in ("build_filing_history_artifact.py", OHLCV_DERIVED_SCRIPT)
        } if config.fetch_ohlcv else {}
        # Optional network activity must not occupy capacity needed by either
        # required build. Queue it only after both required branches.
        reference = None if reference_name in results else executor.submit(
            run_script, reference_name, "Build / standalone reference", required=False)

        print("\nPHASE 4: Enrichment (Injecting into Master JSON)")
        print("-" * 40)
        for script in PHASE4_SCRIPTS:
            results[script] = independent[script].result() if script in independent else run_script(script, "Phase 4", required=True)

        print("\nPHASE 4.5: Canonical consumers")
        print("-" * 40)
        for script in POST_STANDARDIZATION_SCRIPTS:
            results[script] = independent[script].result() if script in independent else run_script(script, "Phase 4.5", required=True)
        if reference is not None:
            results[reference_name] = reference.result()

    if any(result.required and not result.ok for result in results.values()):
        write_pipeline_report(build_pipeline_report(results, time.time() - overall_start, 0, 0, [], config, 1))
        return 1

    # Prepared objects remain private until every required build has succeeded.
    # Promotion carries them with the chart directory; frontend publication
    # verifies their hashes before moving them into the public object set.
    archive_source = Path(BASE_DIR) / '.filing_archives'
    chart_root = Path(BASE_DIR) / 'chart_artifacts'
    if prepared and archive_source.is_dir() and chart_root.is_dir():
        archive_source.replace(chart_root / '.prepared_archives')

    print("\nPHASE 5: Compression (.json -> .json.gz)")
    print("-" * 40)
    started = time.perf_counter()
    raw_size, gz_size = compress_output(include_ohlcv_derived=config.fetch_ohlcv, prepared=prepared)
    print(f"  Compression elapsed: {time.perf_counter() - started:.2f}s", flush=True)

    print("\nPHASE 5.5: Scanner point-in-time context")
    print("-" * 40)
    results[SCANNER_HISTORY_SCRIPT] = run_script(SCANNER_HISTORY_SCRIPT, "Phase 5.5", required=True)

    if config.fetch_optional:
        print("\nPHASE 6: Optional Standalone Data")
        print("-" * 40)
        for script in OPTIONAL_SCRIPTS:
            results[script] = run_script(script, "Phase 6")

    started = time.perf_counter()
    final_checks = validate_final_artifacts(
        include_ohlcv_derived=config.fetch_ohlcv, prepared=prepared_checks
    )
    print(f"  Final validation elapsed: {time.perf_counter() - started:.2f}s", flush=True)
    required_failed = any(result.required and not result.ok for result in results.values())
    final_failed = any(not check.ok for check in final_checks)
    exit_code = 1 if required_failed or final_failed else 0
    if exit_code == 0 and config.cleanup_intermediate:
        cleanup_intermediate()
    total_time = time.time() - overall_start
    print_final_report(results, total_time, raw_size, config.cleanup_intermediate and exit_code == 0, final_checks)
    write_pipeline_report(build_pipeline_report(results, total_time, raw_size, gz_size, final_checks, config, exit_code))
    return exit_code
