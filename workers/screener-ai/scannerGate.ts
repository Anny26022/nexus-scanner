/**
 * The gate on this Worker's /data files and Ask AI (see ../auth/scannerGateway.mjs): once AUTH_MODE is "enforce", only
 * requests forwarded by Nexus Journal's API (with the shared secret) are served. Kept apart from index.ts, and typed
 * structurally like siteData.ts, so frontend tests can import it without Worker type globals.
 */
import {authMode, denial, keepPrivate, logAuth, verifyGateway, type GatewayEnv} from '../auth/scannerGateway.mjs';
import {serveSiteData, type SiteBucket} from './siteData';

/** The part of a Rate Limiting binding used here. */
export interface Limiter {
  limit(options: {key: string}): Promise<{success: boolean}>;
}

export interface GateEnv extends GatewayEnv {
  /** Per-account limit on /data requests (the Journal's account id). */
  DATA_RATE_LIMITER?: Limiter;
}

/** Published /data files, behind the Journal's sign-in once AUTH_MODE is enforce. */
export async function serveGatedData(request: Request, env: GateEnv, bucket: SiteBucket): Promise<Response> {
  const mode = authMode(env);
  if (mode !== 'off') {
    const result = verifyGateway(request, env);
    logAuth(result, mode, 'data');
    const denied = denial(result, mode);
    if (denied) return denied;
    if (result.status === 'valid' && env.DATA_RATE_LIMITER && !(await env.DATA_RATE_LIMITER.limit({key:result.user})).success) {
      return Response.json({error:'Too many requests. Please slow down.'}, {status:429, headers:{'Cache-Control':'no-store', 'Retry-After':'60'}});
    }
  }
  const response = await serveSiteData(request, bucket);
  return mode === 'off' ? response : keepPrivate(response);
}

/**
 * Ask AI spends model credits: refused without the gateway once enforcing, and limited per account when it came through
 * the Journal (per address otherwise). Returns the refusal, or the key for the AI rate limiter.
 */
export async function gateAskAi(request: Request, env: GateEnv, corsHeaders: Record<string, string>):
  Promise<{denied: Response} | {rateKey: string}> {
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  const mode = authMode(env);
  if (mode === 'off') return {rateKey: address};
  const result = verifyGateway(request, env);
  logAuth(result, mode, 'ai');
  const denied = denial(result, mode, corsHeaders);
  if (denied) return {denied};
  return {rateKey: result.status === 'valid' ? `user:${result.user}` : address};
}
