/**
 * Who may call the AI endpoint from a browser. Same-origin requests (and requests without an Origin header)
 * always pass, as before. Other origins pass only when listed in ALLOWED_ORIGINS, a comma-separated list of
 * exact origins such as `https://www.nexusjournal.co.in,https://nexusjournal.co.in`.
 */
export type OriginDecision =
  | {allowed: true; corsOrigin?: string}
  | {allowed: false};

export function parseAllowedOrigins(value: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of (value ?? '').split(',')) {
    const origin = entry.trim().replace(/\/+$/, '');
    if (origin && origin !== '*') origins.add(origin);
  }
  return origins;
}

export function checkOrigin(request: Request, allowed: Set<string>): OriginDecision {
  const origin = request.headers.get('Origin');
  if (!origin || origin === new URL(request.url).origin) return {allowed: true};
  return allowed.has(origin) ? {allowed: true, corsOrigin: origin} : {allowed: false};
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
