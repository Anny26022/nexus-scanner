"""Upload a backfill's archived session snapshots to R2 and check each one, for both markets' backfill workflows.

    python tools/upload_snapshots.py outputs/historical_snapshots snapshots .upload_verified
    python tools/upload_snapshots.py outputs/historical_snapshots/us snapshots/us .upload_verified_us

Each `<source>/*.json.gz` goes to `<prefix>/<name>` with the daily archive's metadata (frontend/session_history.py)
and is checked by size. The sentinel is written only once every file is up, so the workflow publishes the sessions
manifest only then. No snapshots (every date already archived, or none traded) is a successful no-op without one.
"""
import glob
import os
import sys


def main(argv=None):
    source, prefix, sentinel = (argv if argv is not None else sys.argv[1:])
    account_id = os.environ.get('R2_ACCOUNT_ID')
    access_key = os.environ.get('R2_ACCESS_KEY_ID')
    secret_key = os.environ.get('R2_SECRET_ACCESS_KEY')
    bucket_name = os.environ.get('R2_BUCKET', 'nexus-screener-chart-data')
    if not (account_id and access_key and secret_key):
        sys.exit('Error: R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are required when upload_r2 is true.')

    snapshots = sorted(glob.glob(os.path.join(source, '*.json.gz')))
    if not snapshots:
        print(f'No new snapshots in {source} to upload; all requested sessions are already archived.')
        return 0

    import boto3
    s3 = boto3.client('s3', endpoint_url=f'https://{account_id}.r2.cloudflarestorage.com',
                      aws_access_key_id=access_key, aws_secret_access_key=secret_key, region_name='auto')
    print(f"Uploading and verifying {len(snapshots)} snapshots to R2 bucket '{bucket_name}' under {prefix}/...")
    for filepath in snapshots:
        key = f'{prefix}/{os.path.basename(filepath)}'
        file_size = os.path.getsize(filepath)
        with open(filepath, 'rb') as handle:
            s3.upload_fileobj(handle, bucket_name, key, ExtraArgs={'ContentType': 'application/gzip'})
        head = s3.head_object(Bucket=bucket_name, Key=key)
        if head.get('ContentLength') != file_size:
            sys.exit(f'R2 readback verification failed for {key}: expected {file_size} bytes, got {head.get("ContentLength")}')
        print(f'Uploaded and verified {key} ({file_size} bytes)')

    with open(sentinel, 'w') as handle:
        handle.write(f'Verified upload and readback of {len(snapshots)} snapshots\n')
    print('R2 snapshot upload and readback complete and verified.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
