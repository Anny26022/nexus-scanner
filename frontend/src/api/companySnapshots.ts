import { dataUrl } from './origins';

export interface CompanySnapshot {
  name: string;
  as_of: string | null;
  the_read: string[];
  what_to_watch: Array<{title: string; window: string; body: string}>;
  key_events: Array<{chart_date: string; label: string}>;
}

export async function getCompanySnapshots(): Promise<Record<string, CompanySnapshot>> {
  const manifestResponse = await fetch(dataUrl('/data/company/current.json'), {cache: 'no-cache'});
  if (!manifestResponse.ok) throw new Error('Company snapshots could not be loaded.');
  const manifest = await manifestResponse.json();
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.revision) ||
    manifest.datasetUrl !== `/data/company/revisions/${manifest.revision}/overviews.json.gz`) {
    throw new Error('Company snapshot reference is invalid.');
  }
  const response = await fetch(dataUrl(manifest.datasetUrl));
  if (!response.ok) throw new Error('Company snapshots could not be loaded.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Hosts may serve raw gzip or let the browser decode Content-Encoding: gzip.
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await new Response(new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
  const reports = JSON.parse(text);
  if (!reports || typeof reports !== 'object' || Array.isArray(reports)) {
    throw new Error('Company snapshots are invalid.');
  }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const strings = (value: unknown, keys: string[]) => object(value) && keys.every(key => typeof value[key] === 'string');
  for (const report of Object.values(reports) as unknown[]) {
    if (!object(report) || typeof report.name !== 'string'
        || (report.as_of !== null && typeof report.as_of !== 'string')
        || !Array.isArray(report.the_read) || !report.the_read.every(item => typeof item === 'string')
        || !Array.isArray(report.what_to_watch) || !report.what_to_watch.every(item => strings(item, ['title', 'window', 'body']))
        || !Array.isArray(report.key_events)) {
      throw new Error('Company snapshots are invalid.');
    }
    // Some published events are partial source records. Keep renderable labels
    // without trusting missing dates or failing every company's snapshot.
    report.key_events = report.key_events.filter(item => object(item) && typeof item.label === 'string')
      .map(item => ({label: item.label, chart_date: typeof item.chart_date === 'string' ? item.chart_date : ''}));
  }
  return reports;
}
