import {describe, expect, it, vi, afterEach} from 'vitest';
import fixture from './fixtures/classificationContract.json';
import {classificationLabels, joinCompanyClassification, validateClassification, type ThemeClassification} from '../data/classification';
import {formatCopyResults} from '../utils/copyResults';
import {groupRecords} from '../api/earnings';
import {screenSnapshot, type Snapshot, type SnapshotStock} from '../api/snapshotScreen';
import {createSnapshotEngine} from '../api/snapshotEngine';
import {loadPublishedSnapshot} from './fixtures/publishedSnapshot';
import type {ScreenerRunRequest} from '../types/screener';

const taxonomy = fixture.taxonomy as ThemeClassification;
const base = loadPublishedSnapshot().snapshot.stocks[0];
const stocks = fixture.stocks.map(stock => ({...base, ...stock, isSme:false,
  asOfDate:fixture.sessionDate, metadataAsOfDate:fixture.sessionDate, historyAligned:true,
  classification:taxonomy.records[stock.symbol]})) as SnapshotStock[];
const snapshot: Snapshot = {revision:'a'.repeat(64), asOfDate:fixture.sessionDate, totalStocks:stocks.length, stocks, classificationVersion:taxonomy.version};
const request = (values:string[], match = 'ANY', id = 'THEME'): ScreenerRunRequest => ({
  asOfDate:fixture.sessionDate, universe:'mainboard', page:1, pageSize:50,
  expressionTree:{type:'group', operator:'all', children:[{type:'condition', condition:{instanceId:'membership', conditionId:id, parameters:{values, match}}}]},
});
afterEach(() => vi.unstubAllGlobals());

describe('shared classification contract', () => {
  it('keeps the primary industry when joining a legacy Tracker industry', () => {
    const thematic = {...taxonomy.records.CYIENTDLM, industry:'Industrial Products Companies'};
    const joined = joinCompanyClassification({sector:'Aerospace and Defence', industry:'EMS'}, thematic);
    expect(joined.industry).toBe('EMS');
    expect(classificationLabels(joined, joined, 'theme')).toContain('Emerging EMS');
  });
  it('retains secondary themes in copy, Earnings and screener membership', () => {
    const copy = formatCopyResults(stocks, 'theme', taxonomy);
    expect(copy).toContain('###Emerging EMS(1),NSE:CYIENTDLM');
    expect(copy).toContain('###Industrial Systems & Controls(1),NSE:CYIENTDLM');
    const earnings = groupRecords(stocks.map(stock => ({symbol:stock.symbol, filing_day:fixture.sessionDate, isUpcoming:false})),
      'theme', symbol => taxonomy.records[symbol]);
    expect(earnings.find(group => group.label === 'Emerging EMS')?.records.map(r => r.symbol)).toEqual(['CYIENTDLM']);
    expect(screenSnapshot(snapshot, request(['Emerging EMS']))?.matchedSymbols).toEqual(['CYIENTDLM']);
  });
  it('uses distinct unions and intersections and deduplicates shared parents', () => {
    expect(screenSnapshot(snapshot, request(['Emerging EMS', 'India Data-Centre Buildout']))?.matchedSymbols?.sort()).toEqual(['ANANTRAJ','CYIENTDLM']);
    expect(screenSnapshot(snapshot, request(['Emerging EMS', 'Industrial Systems & Controls'], 'ALL'))?.matchedSymbols).toEqual(['CYIENTDLM']);
    expect(screenSnapshot(snapshot, request(['Emerging EMS', 'India Data-Centre Buildout'], 'ALL'))?.matchedSymbols).toEqual([]);
    expect(classificationLabels({}, taxonomy.records.CYIENTDLM, 'block')).toEqual(['ENGINEERING & MANUFACTURING']);
    expect(formatCopyResults([stocks[0],stocks[0]], 'macro', taxonomy)).toBe('###II. INDUSTRIAL & DEFENSE ALPHA(1),NSE:CYIENTDLM');
  });
  it('keeps young cohorts separate from business mapping and aggregates', () => {
    expect(classificationLabels({}, taxonomy.records.ONLY_YOUNG, 'theme')).toEqual([]);
    expect(classificationLabels({}, taxonomy.records.ONLY_YOUNG, 'cohort')).toEqual(['IPO / Young Bases']);
    expect(screenSnapshot(snapshot, request(['IPO / Young Bases'], 'ANY', 'LISTING_COHORT'))?.matchedSymbols?.sort()).toEqual(['CONTRACT_NBFC','ONLY_YOUNG']);
    expect(taxonomy.records.CYIENTDLM.levels?.theme).not.toContain('Consumer Electronics - EMS');
    const negative = request(['Emerging EMS']);
    if (negative.expressionTree.type === 'group' && negative.expressionTree.children[0].type === 'condition')
      negative.expressionTree.children[0].condition.isNegated = true;
    expect(screenSnapshot(snapshot, negative)?.matchedSymbols).not.toContain('ONLY_YOUNG');
  });
  it('honors every legacy membership basis without inventing a parent rollup', () => {
    const old = {theme:'One', memberships:{One:'manual', Two:'web-research'}, block:'Primary'};
    expect(classificationLabels({}, old, 'theme')).toEqual(['One','Two']);
    expect(classificationLabels({}, old, 'block')).toEqual(['Primary']);
  });
  it('rejects partial joins and malformed membership projections', () => {
    expect(() => validateClassification(taxonomy, stocks.length)).not.toThrow();
    expect(() => validateClassification({...taxonomy, records:{}}, stocks.length)).toThrow();
    const broken = structuredClone(taxonomy);
    broken.records.CYIENTDLM.levels!.theme = [];
    expect(() => validateClassification(broken, stocks.length)).toThrow();
  });
  it('rejects invented, alias and retired groups instead of matching their negation', () => {
    const data = {...snapshot, classificationNodes:taxonomy.nodes};
    expect(() => screenSnapshot(data, request(['Invented theme']))).toThrow('unavailable');
    expect(() => screenSnapshot(data, request(['Pharma - Small Cap'], 'ANY', 'LISTING_COHORT'))).toThrow('unavailable');
    expect(() => screenSnapshot(data, request(['Realty - National'], 'ANY', 'THEME_AGGREGATE'))).toThrow('unavailable');
  });
  it('loads the exact sidecar once and exposes the same membership choices', async () => {
    const data = {...snapshot, stocks:stocks.map(({classification, ...stock}) => stock as SnapshotStock)};
    const fetch = vi.fn(async () => new Response(JSON.stringify(taxonomy), {headers:{'Content-Encoding':'gzip'}}));
    vi.stubGlobal('fetch', fetch);
    const run = createSnapshotEngine(async () => data);
    const source = {revision:snapshot.revision, url:'/stocks.json', classificationUrl:'/themes.json.gz', classificationVersion:taxonomy.version};
    const [choices, result] = await Promise.all([run({type:'filterChoices', source}), run({type:'screen', source, request:request(['Emerging EMS'])})]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(choices).toMatchObject({type:'filterChoices', result:{THEME:expect.arrayContaining(['Emerging EMS'])}});
    expect(result).toMatchObject({type:'screen', result:{matchedSymbols:['CYIENTDLM']}});
  });
});
