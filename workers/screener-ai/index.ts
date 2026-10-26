import {MAX_PROMPT_LENGTH} from '../../frontend/src/api/aiScreenerContract';

import {createAiFilterCatalog} from '../../frontend/src/api/aiFilterCatalog';
import type {FilterChoices} from '../../frontend/src/types/filterChoices';
import {GROQ_MODEL, PRIMARY_MODEL, FALLBACK_MODEL, compileWithFallback, compilerPrompt, type CompileModel, type InferenceInput} from './compiler';
import {compilationCacheKey, readCompilation, storeCompilation} from './compilationCache';
import {handleAgentRequest} from './md/route';
import {htmlPage} from './md/page';

type WorkerEnv = Omit<Env, 'GROQ_API_KEY'> & {
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
};

const isObject = (v:unknown): v is Record<string,unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const json = (body: unknown, status = 200) => Response.json(body, {status,
  headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

async function readBody(request: Request | Response, maxBytes = 12000): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing JSON body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // Pages, their markdown versions and the agent discovery files (llms.txt, ai.txt, robots.txt, sitemap).
    const agent = await handleAgentRequest(request, env.ASSETS);
    if (agent) return agent instanceof Response ? agent : htmlPage(request, env.ASSETS, agent.page);
    if (url.pathname !== '/api/screener/ai-compile') {
      return url.pathname.startsWith('/api/') ? json({error:'API route not found'},404) : env.ASSETS.fetch(request);
    }
    if (request.method !== 'POST') return json({error:'Use POST to build a screen.'},405);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({error:'Cross-origin requests are not allowed.'},403);
    if (!request.headers.get('Content-Type')?.includes('application/json')) return json({error:'Send a JSON request.'},415);
    let body: unknown;
    try { body = await readBody(request); } catch { return json({error:'Invalid or oversized JSON request.'},400); }
    const text = typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT_LENGTH) {
      return json({error:`Describe your screen in 1–${MAX_PROMPT_LENGTH} characters.`},400);
    }
    const {success} = await env.AI_RATE_LIMITER.limit({key:request.headers.get('CF-Connecting-IP') || 'local'});
    if (!success) return json({error:'Too many requests. Please wait a minute before building another screen.'},429);
    const requestId = crypto.randomUUID();
    try {
      const asset = await env.ASSETS.fetch(new Request(new URL('/data/ai-filter-choices.json',url)));
      const data = await readBody(asset,300000);
      if (!isObject(data) || typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.revision) || !isObject(data.choices)) {
        return json({error:'The published filter catalogue is unavailable. Please rebuild the app.'},503);
      }
      if (isObject(body) && body.datasetRevision !== undefined && body.datasetRevision !== data.revision) {
        return json({error:'The dataset changed. Refresh the screener before building filters.'},409);
      }
      const choices: FilterChoices = {SECTOR:[],INDUSTRY:[],SERIES:[],PRICE_BAND:[],INDEX_MEMBERSHIP:[]};
      for (const key of ['SECTOR','INDUSTRY','SERIES','PRICE_BAND','INDEX_MEMBERSHIP','TRADINGVIEW_METRIC'] as const) {
        const values = data.choices[key];
        if (!Array.isArray(values) || values.length > 1000 || values.some(v=>typeof v !== 'string' || v.length > 250)) throw new Error('Invalid published choices');
        choices[key] = values.map(String);
      }
      const catalog = createAiFilterCatalog(choices);
      const key = await compilationCacheKey(url,data.revision,compilerPrompt(catalog, text),text);
      const cache = caches.default;
      const cached = await readCompilation(cache,key,catalog);
      if (cached) return json({...cached,catalogRevision:data.revision});
      const groqApiKey = env.GROQ_API_KEY?.trim();
      const groqModel = env.GROQ_MODEL?.trim() || GROQ_MODEL;
      const models: CompileModel[] = groqApiKey
        ? [groqModel, PRIMARY_MODEL, FALLBACK_MODEL]
        : [PRIMARY_MODEL, FALLBACK_MODEL];

      const runModel = async (model: CompileModel, input: InferenceInput, signal: AbortSignal): Promise<unknown> => {
        if (model === groqModel && groqApiKey) {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${groqApiKey}`,
            },
            body: JSON.stringify({
              model: groqModel,
              messages: input.messages,
              response_format: input.response_format,
              temperature: input.temperature,
              max_tokens: input.max_tokens,
            }),
            signal,
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`groq_error_${res.status}: ${errText}`);
          }
          return await res.json();
        }
        return env.AI.run(model as any, input as any, {signal});
      };

      const result = await compileWithFallback(text.trim(), catalog, runModel, {
        models,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(78000)]),
        onAttempt: attempt => console.log(JSON.stringify({event: 'ai_compile_attempt', requestId, ...attempt})),
      });
      const payload = {...result,catalogRevision:data.revision};
      if (!result.unsupportedClauses.length) {
        ctx.waitUntil(storeCompilation(cache,key,payload,catalog)
          .catch(()=>console.warn(JSON.stringify({event:'ai_compile_cache_failed',requestId}))));
      }
      return json(payload);
    } catch (error) {
      // Do not log user prompts or untrusted model output.
      const message = error instanceof Error ? error.message : '';
      console.error(JSON.stringify({event:'ai_compile_failed', requestId,
        kind:error instanceof SyntaxError ? 'invalid_json' : 'inference_or_validation', message}));
      if (/4006|quota|allocation|neuron/i.test(message)) {
        return json({error: message, requestId}, 429);
      }
      return json({error:'The AI could not build a valid screen. Please rephrase your request and try again.',requestId},502);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
