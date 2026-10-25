import {expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {validateClassification, type ThemeClassification} from '../data/classification';
import {loadPublishedSnapshot} from './fixtures/publishedSnapshot';

it('binds every checked-in active classification projection to the same release', () => {
  const {manifest, snapshot} = loadPublishedSnapshot();
  const taxonomy = JSON.parse(gunzipSync(readFileSync(`public${manifest.themeClassificationUrl}`)).toString()) as ThemeClassification;
  const consolidated = JSON.parse(readFileSync(`public${manifest.universeClassificationUrl}`, 'utf8'));
  const directory = JSON.parse(gunzipSync(readFileSync(`public${manifest.chartDirectoryUrl}`)).toString());
  expect(taxonomy.version).toBe(manifest.themeClassificationVersion);
  // A code-only rollout keeps the active legacy release until normal publication emits v2.
  if (taxonomy.schemaVersion === 2) expect(snapshot.classificationVersion).toBe(taxonomy.version);
  expect(consolidated.themeVersion).toBe(taxonomy.version);
  expect(taxonomy.asOfDate).toBe(manifest.sessionDate);
  expect(directory.revision).toBe(manifest.revision);
  validateClassification(taxonomy, snapshot.totalStocks);
  expect(Object.keys(taxonomy.records).sort()).toEqual(snapshot.stocks.map(stock => stock.symbol).sort());
  const companies = new Map(directory.stocks.map((stock: {symbol:string;sector:string;industry:string}) => [stock.symbol, stock]));
  for (const stock of snapshot.stocks) {
    expect(consolidated.records[stock.symbol].thematic).toEqual(taxonomy.records[stock.symbol]);
    expect(consolidated.records[stock.symbol]).toMatchObject({sector:stock.sector, basicIndustry:stock.industry});
    expect(companies.get(stock.symbol)).toMatchObject({sector:stock.sector, industry:stock.industry});
  }
});
