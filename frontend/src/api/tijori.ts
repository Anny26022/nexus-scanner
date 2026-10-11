export interface TijoriOverview {
  name: string;
  sourceUrl: string;
  as_of: string;
  the_read: string[];
  what_to_watch: Array<{title: string; window: string; body: string}>;
  key_events: Array<{chart_date: string; label: string}>;
}

export async function getTijoriOverviews(): Promise<Record<string, TijoriOverview>> {
  const manifestResponse = await fetch('/data/tijori/current.json', {cache: 'no-cache'});
  if (!manifestResponse.ok) throw new Error('Company snapshots could not be loaded.');
  const manifest = await manifestResponse.json();
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.revision) ||
    manifest.datasetUrl !== `/data/tijori/revisions/${manifest.revision}/overviews.json.gz`) {
    throw new Error('Company snapshot reference is invalid.');
  }
  const response = await fetch(manifest.datasetUrl);
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
  return reports;
}
