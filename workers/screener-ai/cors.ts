/**
 * Who may call the AI endpoint from a browser. Same-origin requests (and requests without an Origin header)
 * always pass, as before. Other origins pass only when listed in ALLOWED_ORIGINS, a comma-separated list of
 * exact origins such as `https://www.nexusjournal.co.in,https://nexusjournal.co.in`. An entry like
 * `https://*-team.vercel.app` matches any https host ending in `-team.vercel.app` (Vercel branch previews); the
 * part after `*` must start with `-` or `.` and contain a dot, so it can never match every origin.
 */
export type OriginDecision =
  | {allowed: true; corsOrigin?: string}
  | {allowed: false};

const SUFFIX_ENTRY = /^https:\/\/\*([-.][a-z0-9-]*\.[a-z0-9.-]+)$/;

export function parseAllowedOrigins(value: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of (value ?? '').split(',')) {
    const origin = entry.trim().replace(/\/+$/, '').toLowerCase();
    if (!origin || (origin.includes('*') && !SUFFIX_ENTRY.test(origin))) continue;
    origins.add(origin);
  }
  return origins;
}

function isAllowed(origin: string, allowed: Set<string>): boolean {
  if (allowed.has(origin)) return true;
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.port || url.origin !== origin) return false;
    host = url.hostname;
  } catch { return false; }
  for (const entry of allowed) {
    const suffix = SUFFIX_ENTRY.exec(entry)?.[1];
    if (suffix && host.endsWith(suffix) && host.length > suffix.length) return true;
  }
  return false;
}

export function checkOrigin(request: Request, allowed: Set<string>): OriginDecision {
  const origin = request.headers.get('Origin');
  if (!origin || origin === new URL(request.url).origin) return {allowed: true};
  return isAllowed(origin, allowed) ? {allowed: true, corsOrigin: origin} : {allowed: false};
}

/** Response headers for an allowed cross-origin caller. `Vary: Origin` keeps caches from mixing callers. */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

export function withCors(response: Response, decision: OriginDecision): Response {
  if (!decision.allowed || !decision.corsOrigin) return response;
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(corsHeaders(decision.corsOrigin))) result.headers.set(name, value);
  return result;
}
