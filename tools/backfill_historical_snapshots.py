"""Rebuild historical screens, verify their R2 objects, then publish session pointers."""
import argparse
from datetime import date
import gzip
import hashlib
import json
import os
from pathlib import Path

import generate_historical_snapshots as generator


def snapshot_object(path):
    """Reject incomplete or incorrectly labelled snapshots before uploading anything."""
    content = path.read_bytes()
    payload = json.loads(gzip.decompress(content))
    session = date.fromisoformat(payload["asOfDate"]).isoformat()
    revision = payload.pop("revision")
    digest = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    stocks = payload.get("stocks")
    required = {"rsRating", "setupGeometry", "trendTemplate", "stageStatus", "isLiquidScreen", "presetRuleMatches"}
    if (revision != digest or path.name != f"{session}.json.gz"
            or payload.get("screenMethodologyVersion") != generator.SCREEN_METHODOLOGY_VERSION
            or payload.get("presetRuleMatchesVersion") != 1
            or not isinstance(stocks, list) or not stocks or payload.get("totalStocks") != len(stocks)
            or any(not required.issubset(stock) for stock in stocks)):
        raise ValueError(f"Incomplete or invalid historical snapshot: {path.name}")
    return session, revision, f"snapshots/{session}/{revision}.json.gz", hashlib.sha256(content).hexdigest()


def publish_snapshots(paths, client, bucket, sessions_manifest):
    # Validate the entire batch before the first upload. New objects never replace
    # existing date aliases or revision objects with different dataset contents.
    records = [(path, *snapshot_object(path)) for path in paths]
    if not records:
        raise ValueError("No historical snapshots were generated; nothing was published")
    for path, session, revision, key, checksum in records:
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError(f"Snapshot changed during publication: {path.name}")
        client.put_object(Bucket=bucket, Key=key, Body=content, ContentType="application/json",
                          ContentEncoding="gzip", CacheControl="public, max-age=31536000, immutable")
        stored = client.get_object(Bucket=bucket, Key=key)["Body"]
        try:
            actual = hashlib.sha256(stored.read()).hexdigest()
        finally:
            stored.close()
        if actual != checksum:
            raise ValueError(f"R2 content verification failed: {key}")
        print(f"Uploaded and verified {key}")
    generator.update_sessions_manifest(sessions_manifest, [(date.fromisoformat(s), r) for _, s, r, _, _ in records])


def r2_client():
    required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise ValueError("R2 publication requires: " + ", ".join(missing))
    import boto3
    return boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-date", type=date.fromisoformat, required=True)
    parser.add_argument("--end-date", type=date.fromisoformat, required=True)
    parser.add_argument("--pipeline-dir", type=Path, default=Path("DO NOT DELETE EDL PIPELINE"))
    parser.add_argument("--output-dir", type=Path, default=Path("outputs/historical_snapshots"))
    parser.add_argument("--sessions-manifest", type=Path, default=Path("frontend/public/data/sessions.json"))
    parser.add_argument("--upload-r2", action="store_true", help="Upload verified snapshots and update the local session manifest.")
    parser.add_argument("--dry-run", action="store_true", help="Show the plan without writing files or contacting R2.")
    args = parser.parse_args(argv)
    if args.end_date < args.start_date:
        parser.error("--end-date must be on or after --start-date")
    if args.dry_run:
        print(f"Would rebuild {args.start_date} through {args.end_date}; R2 publication: {args.upload_r2}")
        return 0
    registered = set()
    if args.upload_r2 and args.sessions_manifest.exists():
        catalog = json.loads(args.sessions_manifest.read_text())
        registered = {date.fromisoformat(item["date"]) for item in catalog["sessions"]}
        registered = {d for d in registered if args.start_date <= d <= args.end_date}
    client = r2_client() if args.upload_r2 else None
    generated = generator.main(["--pipeline-dir", str(args.pipeline_dir), "--output-dir", str(args.output_dir),
                                "--start-date", str(args.start_date), "--end-date", str(args.end_date)])
    paths = [args.output_dir / f"{session.isoformat()}.json.gz" for session, _ in generated]
    if args.upload_r2:
        missing = registered - {session for session, _ in generated}
        if missing:
            raise ValueError("Missing history for registered sessions: " + ", ".join(map(str, sorted(missing))))
        publish_snapshots(paths, client, os.environ.get("R2_BUCKET", "nexus-screener-chart-data"), args.sessions_manifest)
    else:
        print("Preview generated; R2 and published session pointers are unchanged. Use --upload-r2 to publish.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
