import { DataUnavailableError } from './dataErrors';

export async function getIpoJson<T>(url: string, resource = 'IPO catalogue'): Promise<T> {
  if (!url.endsWith('.gz')) {
    const response = await fetch(url);
    if (!response.ok) throw new DataUnavailableError(`${resource} unavailable`, 'download_failed');
    return response.json() as Promise<T>;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Empty IPO catalogue');
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Gzip unsupported');
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text()) as T;
    }
    // Fetch decodes Content-Encoding before returning bytes (including Vite 8).
    if (response.headers.get('Content-Encoding')?.toLowerCase() === 'gzip') {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }
    throw new Error('Expected gzip');
  } catch {
    throw new Error(`${resource} unavailable`);
  }
}
