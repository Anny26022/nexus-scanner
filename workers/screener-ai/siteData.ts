/**
 * Published `/data/...` files, served from R2 so a data refresh needs neither a commit nor a Worker rebuild.
 *
 * The bucket layout is the one Nexus Journal's R2 mode already reads (packages/nexus-scanner/src/api/origins.ts
 * there), so both sites share the immutable files:
 *
 *   /data/revisions/<rev>/<file>          -> releases/<rev>/<file>          immutable
 *   /data/company/revisions/<rev>/<file>  -> releases/company/<rev>/<file>  immutable
 *   /data/<pointer>                       -> site/data/<pointer>            revalidated
 *
 * Pointers live outside `daily/`, whose bucket lifecycle rule expires objects after 90 days, and outside the
 * journal's `daily/journal/`, so the two pipelines never overwrite each other's pointers. Anything else is 404.
 * frontend/site_data.py publishes the same layout; keep the two in step.
 */
export const POINTER_PREFIX = 'site/data';
export const POINTERS = new Set([
  'current.json', 'sessions.json', 'price-band-history.json', 'ai-filter-choices.json',
  'results/index.json', 'results/us_index.json', 'heatmap/index.json', 'company/current.json',
]);

const REVISION_FILE = /^revisions\/([a-f0-9]{64})\/((?:[A-Za-z0-9&_.-]+\/)?[A-Za-z0-9&_.-]+\.json(?:\.gz)?)$/;
const COMPANY_FILE = /^company\/revisions\/([a-f0-9]{64})\/([A-Za-z0-9_.-]+\.json(?:\.gz)?)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The R2 key and cache policy for a `/data/...` path, or null when the path is not published. */
export function siteDataKey(pathname: string): {key: string; immutable: boolean} | null {
  if (!pathname.startsWith('/data/')) return null;
  let path: string;
  try { path = decodeURIComponent(pathname.slice('/data/'.length)); } catch { return null; }
  if (path.split('/').some(part => part === '.' || part === '..')) return null;
  if (POINTERS.has(path)) return {key: `${POINTER_PREFIX}/${path}`, immutable: false};
  const release = REVISION_FILE.exec(path);
  if (release) return {key: `releases/${release[1]}/${release[2]}`, immutable: true};
  const company = COMPANY_FILE.exec(path);
  if (company) return {key: `releases/company/${company[1]}/${company[2]}`, immutable: true};
  return null;
}

/** The same object, read by the AI endpoint without going through HTTP. */
export const pointerKey = (name: string) => `${POINTER_PREFIX}/${name}`;

/** The parts of R2Bucket used here. Structural, so the frontend's type-check of its tests accepts this file. */
interface StoredObject {
  httpEtag: string;
  httpMetadata?: {contentEncoding?: string};
  writeHttpMetadata(headers: Headers): void;
  body?: ReadableStream;
}
export interface SiteBucket {
  get(key: string, options?: {onlyIf?: Headers}): Promise<StoredObject | null>;
  head(key: string): Promise<StoredObject | null>;
}

// Published data is public and read-only; embedding hosts (Nexus Journal) read it cross-origin.
const PUBLIC_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Encoding, Content-Length, ETag',
  'X-Content-Type-Options': 'nosniff',
};

export async function serveSiteData(request: Request, bucket: SiteBucket): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, {status: 405, headers: {...PUBLIC_HEADERS, Allow: 'GET, HEAD', 'Cache-Control': 'no-store'}});
  }
  const target = siteDataKey(new URL(request.url).pathname);
  if (!target) return new Response(null, {status: 404, headers: {...PUBLIC_HEADERS, 'Cache-Control': 'no-store'}});
  const object = request.method === 'HEAD'
    ? await bucket.head(target.key)
    : await bucket.get(target.key, {onlyIf: request.headers});
  if (!object) return new Response(null, {status: 404, headers: {...PUBLIC_HEADERS, 'Cache-Control': 'no-cache'}});
  const headers = new Headers(PUBLIC_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', target.immutable ? IMMUTABLE : 'no-cache');
  // A failed If-None-Match precondition returns the object without a body.
  if (request.method === 'GET' && !('body' in object)) return new Response(null, {status: 304, headers});
  // An object stored with Content-Encoding is already encoded: send its bytes as they are. Without 'manual' the
  // runtime would compress them again, and browsers would receive gzip inside gzip (see PR #178).
  const init: ResponseInit & {encodeBody?: 'manual'} = {headers};
  if (object.httpMetadata?.contentEncoding) init.encodeBody = 'manual';
  return new Response(request.method === 'HEAD' ? null : object.body, init);
}
