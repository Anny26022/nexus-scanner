import {MAX_PROMPT_LENGTH, validateAiScreenResult} from './aiScreenerContract';
import {createAiFilterCatalog} from './aiFilterCatalog';
import type {FilterChoices} from '../types/filterChoices';
export type {AiScreenResult, ClauseCompilation} from './aiScreenerContract';

export interface SamplePrompt {
  label: string;
  text: string;
  tags?: string[];
}

export const SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    label: '200 EMA aur 2× volume',
    text: 'Close 200 EMA ke upar aur volume kam se kam 2 times the 20 day average',
    tags: ['Hinglish', 'Momentum', 'Trend'],
  },
  {
    label: '50 EMA and ADX strength',
    text: 'Latest close above 50 EMA and ADX at least 25',
    tags: ['English', 'Trend', 'Strength'],
  },
  {
    label: 'Average turnover ₹5 Cr+',
    text: '20 day average daily turnover at least 5 crore',
    tags: ['Liquidity', 'Turnover'],
  },
  {
    label: 'Near 52-week high breakout',
    text: 'Stock within 5% of 52-week high and relative volume at least 2',
    tags: ['Breakout', 'RVOL'],
  },
  {
    label: 'P/E ≤ 25 aur ROE ≥ 15%',
    text: 'P/E ratio at most 25 and Return on Equity at least 15%',
    tags: ['Fundamental', 'Hinglish'],
  },
  {
    label: 'Above 200 EMA or 50 SMA',
    text: 'Latest close above 200 EMA or latest close above 50 SMA',
    tags: ['Trend', 'OR'],
  },
];

/** Build conditions using the same-origin Cloudflare Workers AI endpoint. */
export async function compileNaturalLanguageQuery(input: string, signal?: AbortSignal, context?: {datasetRevision?:string; choices?:FilterChoices}) {
  const text = input.trim();
  if (!text || text.length > MAX_PROMPT_LENGTH) throw new Error(`Use 1–${MAX_PROMPT_LENGTH} characters to describe your screen.`);
  
  const response = await fetch('/api/screener/ai-compile', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text,...(context?.datasetRevision ? {datasetRevision:context.datasetRevision} : {})}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof payload === 'object' && payload !== null && 'error' in payload ? payload.error : undefined;
    throw new Error(typeof error === 'string' ? error : 'The AI compiler is unavailable. Please try again.');
  }

  const result = validateAiScreenResult(payload, createAiFilterCatalog(context?.choices));
  if (typeof payload === 'object' && payload !== null && 'catalogRevision' in payload) {
    if (context?.datasetRevision && payload.catalogRevision !== context.datasetRevision) throw new Error('The filter catalogue changed. Refresh the screener.');
    if (typeof payload.catalogRevision === 'string') result.catalogRevision = payload.catalogRevision;
  }
  return result;
}
