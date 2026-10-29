/**
 * The screener's pages are used inside Nexus Journal, which fetches this Worker's /data/* and /api/* directly from
 * the public workers.dev address. With UI_REDIRECT set (wrangler.jsonc), a browser opening any other path here is
 * sent to the journal instead of getting the standalone UI; data and API answer as before. Unset in local
 * development, where this Worker serves the UI itself.
 *
 * Plain functions over paths, so the frontend's type-check of its tests needs no Workers runtime types.
 */

/** Paths that keep answering at this address whatever UI_REDIRECT says. */
const SERVED_PREFIXES = ['/data/', '/api/'];

export const isServedPath = (pathname: string) => SERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix));

/** A temporary redirect for a page request, or null when the request should be handled here. */
export function pageRedirect(pathname: string, target: string | undefined): Response | null {
  if (!target || isServedPath(pathname)) return null;
  // Temporary: the UI may come back here, and browsers must not cache the move.
  return new Response(null, {status: 302, headers: {Location: target, 'Cache-Control': 'no-store'}});
}
