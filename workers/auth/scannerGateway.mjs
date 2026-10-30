/**
 * Who may use the Scanner Workers. Nexus Journal reaches them through its own API (nexus-journal-api's
 * /functions/v1/scanner route): it checks the Journal's Google sign-in and forwards each request here with a shared
 * secret, so once AUTH_MODE is "enforce" only requests it forwards are served. The secret never reaches a browser: it
 * lives on the Journal API and these Workers only.
 *
 *   X-Nexus-Gateway: <SCANNER_GATEWAY_SECRET>   the request came from the Journal API
 *   X-Nexus-User:    <opaque account id>         whom it is for (per-account rate limits); trusted only with the secret
 *
 * SCANNER_GATEWAY_SECRET is a Worker secret; a comma-separated list is accepted, so it can be changed without downtime.
 * AUTH_MODE: "off" (default) ignores it; "report" checks and logs but serves everyone; "enforce" refuses requests
 * without the secret.
 */

export const GATEWAY_HEADER = 'X-Nexus-Gateway';
export const USER_HEADER = 'X-Nexus-User';

/** @returns {'off' | 'report' | 'enforce'} */
export function authMode(env) {
  const mode = String(env?.AUTH_MODE ?? '').trim();
  return mode === 'report' || mode === 'enforce' ? mode : 'off';
}

// Compares in time independent of where the strings differ.
function sameSecret(presented, secret) {
  if (presented.length !== secret.length) return false;
  let difference = 0;
  for (let i = 0; i < secret.length; i++) difference |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  return difference === 0;
}

/**
 * Whether the request came through the Journal API.
 * @returns {{status: 'valid', user: string} | {status: 'missing'} | {status: 'invalid', reason: string}}
 */
export function verifyGateway(request, env) {
  const presented = request.headers.get(GATEWAY_HEADER);
  if (!presented) return { status: 'missing' };
  const secrets = String(env?.SCANNER_GATEWAY_SECRET ?? '').split(',').map((secret) => secret.trim()).filter(Boolean);
  if (!secrets.length) return { status: 'invalid', reason: 'not_configured' };
  if (!secrets.some((secret) => sameSecret(presented, secret))) return { status: 'invalid', reason: 'secret' };
  const user = request.headers.get(USER_HEADER) ?? '';
  return { status: 'valid', user: /^[0-9a-f]{16,64}$/.test(user) ? user : 'gateway' };
}

/** The 401 to send in enforce mode, or null when the request may proceed. `headers` adds the route's CORS headers. */
export function denial(result, mode, headers = {}) {
  if (mode !== 'enforce' || result.status === 'valid') return null;
  const reason = result.status === 'missing' ? 'missing' : result.reason;
  return new Response(JSON.stringify({ error: 'Open the Scanner from Nexus Journal, signed in.', reason }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** One log line per checked request in report mode (to measure what still arrives directly), only failures in enforce. */
export function logAuth(result, mode, route) {
  if (mode === 'off' || (mode === 'enforce' && result.status === 'valid')) return;
  console.log(JSON.stringify({
    event: 'scanner_auth', route, mode, status: result.status,
    ...(result.status === 'invalid' ? { reason: result.reason } : {}),
  }));
}

/** The request without the gateway's headers (and any credentials), for passing on to a cached entrypoint. */
export function withoutCredentials(request) {
  const forwarded = new Request(request);
  for (const name of [GATEWAY_HEADER, USER_HEADER, 'Authorization', 'Cookie']) forwarded.headers.delete(name);
  return forwarded;
}

/**
 * A gated response must not be stored by a shared cache in front of this Worker, or it would be served to callers who
 * were never checked. Browsers still keep it as before.
 */
export function keepPrivate(response) {
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (/\b(private|no-store)\b/.test(cacheControl)) return response;
  const rest = cacheControl.split(',').map(part => part.trim()).filter(part => part && !/^(public|s-maxage=\d+)$/i.test(part));
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', ['private', ...rest].join(', '));
  result.headers.delete('CDN-Cache-Control');
  result.headers.delete('Vercel-CDN-Cache-Control');
  return result;
}
