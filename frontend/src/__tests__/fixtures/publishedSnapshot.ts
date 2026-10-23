import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {unpackSnapshot} from '../../api/packedSnapshot';
import type {Snapshot} from '../../api/snapshotScreen';

// Plain JSON may be offloaded to R2; the packed publication stays in the checkout.
export function loadPublishedSnapshot() {
  const manifest = JSON.parse(readFileSync('public/data/current.json', 'utf8'));
  const packed = JSON.parse(gunzipSync(readFileSync(`public${manifest.datasetPackedGzipUrl}`)).toString());
  return {manifest, snapshot:unpackSnapshot(packed) as Snapshot};
}
