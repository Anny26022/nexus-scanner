/**
 * Where published data and the AI API live. Both default to this page's origin, so the standalone site keeps
 * requesting `/data/current.json` and `/api/...`. An embedding host (or a build with VITE_SCANNER_DATA_ORIGIN /
 * VITE_SCANNER_API_ORIGIN) points them at the scanner deployment; relative release URLs then resolve against it.
 */
const trim = (origin: string | undefined) => (origin ?? '').trim().replace(/\/+$/, '');

let dataOrigin = trim(import.meta.env.VITE_SCANNER_DATA_ORIGIN);
let apiOrigin = trim(import.meta.env.VITE_SCANNER_API_ORIGIN);

export function configureOrigins(origins: {dataOrigin?: string; apiOrigin?: string}) {
  if (origins.dataOrigin !== undefined) dataOrigin = trim(origins.dataOrigin);
  if (origins.apiOrigin !== undefined) apiOrigin = trim(origins.apiOrigin);
}

const resolve = (origin: string, url: string) => origin && url.startsWith('/') && !url.startsWith('//') ? origin + url : url;

/** A root-relative data URL against the configured data origin; absolute URLs are returned unchanged. */
export const dataUrl = (url: string) => resolve(dataOrigin, url);
/** A root-relative API URL against the configured API origin. */
export const apiUrl = (url: string) => resolve(apiOrigin, url);
