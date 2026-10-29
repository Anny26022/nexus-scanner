/**
 * Scanner access tokens, issued by Nexus Journal's API (nexus-journal-api, /api/v1/scanner-token) to users with
 * Scanner access and checked here with the public key alone (no database on the data path).
 *
 *   token = base64url(JSON payload) + "." + base64url(Ed25519 signature over the first segment's ASCII bytes)
 *   payload = {v: 1, kid, sub, aud: "nexus-scanner", scope: ["data", "ai"], src, iat, exp}
 *
 * SCANNER_TOKEN_PUBLIC_KEYS is JSON {kid: base64url raw 32-byte public key}, so keys rotate by adding a kid.
 * AUTH_MODE: "off" (default) ignores tokens; "report" checks and logs them but serves everyone; "enforce" refuses
 * requests without a valid token. Rolling out is report first, enforce once the Journal sends tokens everywhere.
 */

export const SCANNER_TOKEN_AUDIENCE = 'nexus-scanner';
const CLOCK_SKEW_SECONDS = 60;
const keys = new Map();

/** @returns {'off' | 'report' | 'enforce'} */
export function authMode(env) {
  const mode = String(env?.AUTH_MODE ?? '').trim();
  return mode === 'report' || mode === 'enforce' ? mode : 'off';
}

function fromBase64url(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function publicKey(env, kid) {
  let configured;
  try { configured = JSON.parse(env?.SCANNER_TOKEN_PUBLIC_KEYS || '{}'); } catch { return null; }
  const raw = configured && typeof configured === 'object' ? configured[kid] : undefined;
  if (typeof raw !== 'string') return null;
  if (!keys.has(raw)) {
    const key = crypto.subtle.importKey('raw', fromBase64url(raw), { name: 'Ed25519' }, false, ['verify']);
    key.catch(() => keys.delete(raw));
    keys.set(raw, key);
  }
  return keys.get(raw);
}

const invalid = (reason) => ({ status: 'invalid', reason });

/**
 * Checks the request's bearer token for `scope` ('data' or 'ai').
 * @returns {Promise<{status: 'valid', payload: object} | {status: 'missing'} | {status: 'invalid', reason: string}>}
 */
export async function verifyScannerToken(request, env, scope, nowSeconds = Date.now() / 1000) {
  const header = request.headers.get('Authorization');
  if (!header) return { status: 'missing' };
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!match) return invalid('malformed');
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(fromBase64url(match[1]))); } catch { return invalid('malformed'); }
  if (!payload || typeof payload !== 'object' || payload.v !== 1) return invalid('version');

  // The signature is checked before any claim is trusted.
  const keyPromise = publicKey(env, payload.kid);
  if (!keyPromise) return invalid('unknown_key');
  let verified;
  try {
    verified = await crypto.subtle.verify({ name: 'Ed25519' }, await keyPromise, fromBase64url(match[2]), new TextEncoder().encode(match[1]));
  } catch { return invalid('signature'); }
  if (!verified) return invalid('signature');

  if (payload.aud !== SCANNER_TOKEN_AUDIENCE) return invalid('audience');
  if (!Array.isArray(payload.scope) || !payload.scope.includes(scope)) return invalid('scope');
  if (typeof payload.sub !== 'string' || !payload.sub) return invalid('subject');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) return invalid('expired');
  if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_SECONDS > nowSeconds) return invalid('not_yet_valid');
  return { status: 'valid', payload };
}

/** The 401 to send in enforce mode, or null when the request may proceed. `headers` adds the route's CORS headers. */
export function denial(result, mode, headers = {}) {
  if (mode !== 'enforce' || result.status === 'valid') return null;
  const reason = result.status === 'missing' ? 'missing' : result.reason;
  return new Response(JSON.stringify({
    error: reason === 'missing' ? 'Scanner access needs a signed-in account with access.' : 'Scanner access token is invalid or expired.',
    reason,
  }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Bearer realm="nexus-scanner"',
      ...headers,
    },
  });
}

/** One log line per checked request in report mode (to measure who still has no token), only failures in enforce. */
export function logAuth(result, mode, route) {
  if (mode === 'off' || (mode === 'enforce' && result.status === 'valid')) return;
  console.log(JSON.stringify({
    event: 'scanner_auth', route, mode, status: result.status,
    ...(result.status === 'invalid' ? { reason: result.reason } : {}),
    ...(result.status === 'valid' ? { src: result.payload.src } : {}),
  }));
}
