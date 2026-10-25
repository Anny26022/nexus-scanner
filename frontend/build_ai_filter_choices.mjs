import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
export async function buildAiFilterChoices() {
  const data = path.join(directory, 'public/data');
  const manifest = JSON.parse(await readFile(path.join(data, 'current.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(manifest.revision)) throw new Error('Invalid AI catalogue revision');
  const target = path.join(data,'ai-filter-choices.json');
  // Releases keep the compressed list; the plain one is served from R2 for old browsers only.
  const revision = path.join(data,'revisions',manifest.revision);
  const source = await stat(path.join(revision,'stocks.json.gz')).then(()=>path.join(revision,'stocks.json.gz'),()=>path.join(revision,'stocks.json'));
  const existing = await readFile(target,'utf8').then(JSON.parse).catch(()=>null);
  const modified = (await stat(source)).mtimeMs;
  if (existing?.revision === manifest.revision && existing.sourceModified === modified
      && existing.classificationVersion === manifest.themeClassificationVersion) return;
  const bytes = await readFile(source);
  const snapshot = JSON.parse((source.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
  if (snapshot.revision !== manifest.revision || !Array.isArray(snapshot.stocks)) throw new Error('AI catalogue dataset mismatch');
  const fields = {SECTOR:'sector', INDUSTRY:'industry', SERIES:'series', PRICE_BAND:'circuitLimit', INDEX_MEMBERSHIP:'indexMemberships'};
  const choices = Object.fromEntries(Object.entries(fields).map(([id, field]) => [id,
    [...new Set(snapshot.stocks.flatMap(stock => Array.isArray(stock[field]) ? stock[field] : [stock[field]])
      .filter(value=>typeof value === 'string' && value.trim()).map(value=>value.trim().toUpperCase()))].sort()]));
  if (manifest.classificationSchemaVersion === 2) {
    const taxonomy = JSON.parse(gunzipSync(await readFile(path.join(directory, 'public', manifest.themeClassificationUrl))));
    if (taxonomy.version !== manifest.themeClassificationVersion || taxonomy.asOfDate !== manifest.sessionDate
        || Object.keys(taxonomy.records).length !== snapshot.stocks.length
        || snapshot.stocks.some(stock => !taxonomy.records[stock.symbol])) throw new Error('AI classification release mismatch');
    const levels = {THEME:'theme', THEMATIC_BLOCK:'block', MACRO_PILLAR:'macro', SUB_INDUSTRY:'subIndustry', LISTING_COHORT:'cohort', THEME_AGGREGATE:'aggregate'};
    for (const [id, level] of Object.entries(levels)) choices[id] = [...new Set(snapshot.stocks.flatMap(stock =>
      taxonomy.records[stock.symbol].levels[level]).map(value => value.toUpperCase()))].sort();
  }
  choices.TRADINGVIEW_METRIC = [...new Set(snapshot.stocks.flatMap(stock => stock.tradingview?.asOfDate === snapshot.asOfDate
    ? Object.entries(stock.tradingview.values ?? {}).filter(([,value])=>typeof value === 'number' && Number.isFinite(value)).map(([id])=>id) : []))].sort();
  await mkdir(data,{recursive:true});
  await writeFile(target,JSON.stringify({revision:manifest.revision,sessionDate:manifest.sessionDate,sourceModified:modified,classificationVersion:manifest.themeClassificationVersion,choices}));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAiFilterChoices();
