"""Upload a backfill's archived session snapshots to R2 and check each one, for both markets' backfill workflows.

    python tools/upload_snapshots.py outputs/historical_snapshots snapshots .upload_verified
    python tools/upload_snapshots.py outputs/historical_snapshots/us snapshots/us .upload_verified_us

Each `<source>/*.json.gz` goes to `<prefix>/<name>` with the daily archive's metadata (frontend/session_history.py),
checked by content as the daily archive's read-back is. Snapshots are a few MB, one PUT each: the upload carries its
MD5 (R2 refuses a body that does not match it), and the stored object's ETag, the MD5 of its bytes, must equal it.

Archived snapshots are immutable, as the daily archive's `--immutable` upload keeps them: a key that already holds
these bytes is left as it is, and one holding anything else stops the upload. (An object whose ETag is not a plain
MD5, from a multipart upload, is compared by size.) The sentinel is written only once every file is up, so the
workflow publishes the sessions manifest only then. No snapshots (every date already archived, or none traded) is a
successful no-op without one.
"""
import base64
import glob
import hashlib
import os
import re
import sys

PLAIN_MD5 = re.compile(r'[0-9a-f]{32}')


def stored(s3, bucket, key):
    """The object's head, or None when there is none."""
    try:
        return s3.head_object(Bucket=bucket, Key=key)
    except Exception as error:
        response = getattr(error, 'response', {})
        if response.get('ResponseMetadata', {}).get('HTTPStatusCode') == 404 or \
                response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
            return None
        raise


def etag(head):
    return str(head.get('ETag', '')).strip('"').lower()


def holds(head, data, md5):
    """Whether an existing object holds these bytes: by MD5, or by size for a multipart ETag."""
    tag = etag(head)
    return tag == md5 if PLAIN_MD5.fullmatch(tag) else head.get('ContentLength') == len(data)


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
        with open(filepath, 'rb') as handle:
            data = handle.read()
        digest = hashlib.md5(data)
        md5 = digest.hexdigest()
        existing = stored(s3, bucket_name, key)
        if existing is not None:
            if holds(existing, data, md5):
                print(f'{key} is already archived; left as it is')
                continue
            sys.exit(f'{key} is already archived with different content (ETag {etag(existing)}, '
                     f'{existing.get("ContentLength")} bytes; this run has {md5}, {len(data)} bytes); '
                     'archived snapshots are never replaced')
        s3.put_object(Bucket=bucket_name, Key=key, Body=data, ContentType='application/gzip',
                      ContentMD5=base64.b64encode(digest.digest()).decode())
        head = s3.head_object(Bucket=bucket_name, Key=key)
        if etag(head) != md5 or head.get('ContentLength') != len(data):
            sys.exit(f'R2 readback verification failed for {key}: expected MD5 {md5} and {len(data)} bytes, '
                     f'got ETag {etag(head)} and {head.get("ContentLength")} bytes')
        print(f'Uploaded and verified {key} ({len(data)} bytes, MD5 {md5})')

    with open(sentinel, 'w') as handle:
        handle.write(f'Verified upload and readback of {len(snapshots)} snapshots\n')
    print('R2 snapshot upload and readback complete and verified.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
