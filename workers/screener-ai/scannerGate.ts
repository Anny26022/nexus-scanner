/**
 * The Scanner token gate for this Worker's /data files and Ask AI (see ../auth/scannerToken.mjs). Kept apart from
 * index.ts, and typed structurally like siteData.ts, so frontend tests can import it without Worker type globals.
 */
import {authMode, denial, keepPrivate, logAuth, verifyScannerToken, type ScannerTokenEnv} from '../auth/scannerToken.mjs';
import {serveSiteData, type SiteBucket} from './siteData';

/** The part of a Rate Limiting binding used here. */
export interface Limiter {
  limit(options: {key: string}): Promise<{success: boolean}>;
}

export interface GateEnv extends ScannerTokenEnv {
  /** Per-account limit on /data requests (token sub). */
  DATA_RATE_LIMITER?: Limiter;
}

export const DATA_PREFLIGHT = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  // Browsers cap this (Chrome at 2 hours); each data URL is preflighted at most that often.
  'Access-Control-Max-Age': '86400',
};

/** Published /data files, behind the Scanner token once AUTH_MODE is enforce. */
export async function serveGatedData(request: Request, env: GateEnv, bucket: SiteBucket): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:DATA_PREFLIGHT});
  const mode = authMode(env);
  if (mode !== 'off') {
    const result = await verifyScannerToken(request, env, 'data');
    logAuth(result, mode, 'data');
    const denied = denial(result, mode, {'Access-Control-Allow-Origin': '*'});
    if (denied) return denied;
    if (result.status === 'valid' && env.DATA_RATE_LIMITER && !(await env.DATA_RATE_LIMITER.limit({key:result.payload.sub})).success) {
      return Response.json({error:'Too many requests. Please slow down.'}, {status:429,
        headers:{'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*', 'Retry-After':'60'}});
    }
  }
  const response = await serveSiteData(request, bucket);
  return mode === 'off' ? response : keepPrivate(response);
}

/**
 * Ask AI spends model credits: refused without a valid token once enforcing, and limited per account when a token is
 * valid (per address otherwise). Returns the refusal, or the key for the AI rate limiter.
 */
export async function gateAskAi(request: Request, env: GateEnv, corsHeaders: Record<string, string>):
  Promise<{denied: Response} | {rateKey: string}> {
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  const mode = authMode(env);
  if (mode === 'off') return {rateKey: address};
  const result = await verifyScannerToken(request, env, 'ai');
  logAuth(result, mode, 'ai');
  const denied = denial(result, mode, corsHeaders);
  if (denied) return {denied};
  return {rateKey: result.status === 'valid' ? `sub:${result.payload.sub}` : address};
}
