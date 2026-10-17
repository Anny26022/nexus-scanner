import {validateAiScreenResult, type AiScreenResult} from '../../frontend/src/api/aiScreenerContract';
import type {AiFilterDefinition} from '../../frontend/src/api/aiFilterCatalog';

export const COMPILATION_CACHE_TTL = 6 * 60 * 60;
export interface CompilationCache {
  match(key:Request): Promise<Response | undefined>;
  put(key:Request, response:Response): Promise<void>;
}
const object = (value:unknown): value is Record<string,unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function compilationCacheKey(url:URL, revision:string, prompt:string, query:string) {
  const input = JSON.stringify(['ai-compiler-v3',revision,prompt,query.trim()]);
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
  const hash = [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return new Request(new URL(`/__ai_compilations/${hash}`,url));
}

export async function readCompilation(cache:CompilationCache,key:Request,catalog:AiFilterDefinition[]) {
  try {
    const response = await cache.match(key);
    const reader = response?.body?.getReader();
    if (!reader) return undefined;
    const chunks:Uint8Array[] = [];
    let size = 0;
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 200000) { void reader.cancel().catch(()=>undefined); return undefined; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    const payload:unknown = JSON.parse(new TextDecoder().decode(bytes));
    const result = validateAiScreenResult(payload,catalog);
    if (result.unsupportedClauses.length || !object(payload) || !object(payload.compilation)) return undefined;
    const metadata = payload.compilation;
    if (typeof metadata.model !== 'string' || typeof metadata.attempts !== 'number' || metadata.attempts < 1 || metadata.attempts > 4
      || ![metadata.inputTokens,metadata.outputTokens].every(value=>typeof value === 'number' && Number.isFinite(value) && value >= 0)) return undefined;
    return {...result,...(typeof payload.catalogRevision === 'string' ? {catalogRevision:payload.catalogRevision} : {}),
      compilation:{model:metadata.model,attempts:metadata.attempts,cacheHit:true,
        inputTokens:metadata.inputTokens as number,outputTokens:metadata.outputTokens as number}};
  } catch {
    // Cache failures and stale entries must not prevent fresh inference.
    return undefined;
  }
}

export async function storeCompilation(cache:CompilationCache,key:Request,payload:AiScreenResult,catalog:AiFilterDefinition[]) {
  const checked = validateAiScreenResult(payload,catalog);
  if (checked.unsupportedClauses.length || !payload.compilation) return;
  await cache.put(key,Response.json({...payload,...checked},
    {headers:{'Cache-Control':`public, max-age=${COMPILATION_CACHE_TTL}`}}));
}
