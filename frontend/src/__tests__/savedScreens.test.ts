import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SCREEN_STORAGE_KEYS, applySharedScreenFromUrl, decodeScreen, encodeScreen, parseSavedScreens, parseScreenDefinition,
  screenShareUrl, upsertSavedScreen, type ScreenDefinition,
} from '../utils/savedScreens';

const screen: ScreenDefinition = {
  universe: 'nifty500',
  matchMode: 'any',
  conditions: {
    sma: {instanceId: 'sma', conditionId: 'trend_price_vs_ma', parameters: {maType: 'SMA', maPeriod: 50, operator: 'above', thresholdPct: 0}},
    sector: {instanceId: 'sector', conditionId: 'SECTOR', parameters: {values: ['IT Software', 'Banks']}},
  },
  query: '',
  sort: {field: 'rvol', direction: 'desc'},
};

beforeEach(() => localStorage.clear());

describe('screen definitions', () => {
  it('round-trips through a share link, including non-ASCII text', () => {
    const withQuery = {...screen, query: 'P/E < 20 AND name ~ “टाटा”'};
    expect(decodeScreen(encodeScreen(withQuery))).toEqual(withQuery);
    expect(screenShareUrl(screen, {origin: 'https://nexus.example', pathname: '/'})).toMatch(/^https:\/\/nexus\.example\/\?screen=[A-Za-z0-9_-]+$/);
  });

  it('rejects unknown conditions, unsafe parameters and malformed input', () => {
    expect(parseScreenDefinition({...screen, conditions: {x: {instanceId: 'x', conditionId: 'NOT_A_CONDITION', parameters: {}}}})).toBeNull();
    expect(parseScreenDefinition({...screen, conditions: {x: {...screen.conditions.sma, parameters: {nested: {a: 1}}}}})).toBeNull();
    expect(parseScreenDefinition({...screen, universe: 'custom'})).toBeNull();
    expect(parseScreenDefinition({...screen, sort: {field: 'rvol; drop', direction: 'desc'}})).toBeNull();
    expect(decodeScreen('not base64!')).toBeNull();
    expect(decodeScreen(btoa('{"v":2}'))).toBeNull();
  });

  it('keeps only valid saved screens', () => {
    const saved = parseSavedScreens([
      {id: 'a', name: 'Momentum', savedAt: '2026-10-22T00:00:00.000Z', screen},
      {id: 'b', name: 'Broken', savedAt: '2026-10-22T00:00:00.000Z', screen: {...screen, matchMode: 'some'}},
      'junk',
    ]);
    expect(saved.map(item => item.name)).toEqual(['Momentum']);
  });

  it('updates a screen saved under the same name instead of duplicating it', () => {
    const first = upsertSavedScreen([], '  Momentum   breakouts ', screen, new Date('2026-10-20T00:00:00Z'));
    const second = upsertSavedScreen(first, 'momentum breakouts', {...screen, matchMode: 'all'}, new Date('2026-10-22T00:00:00Z'));
    expect(first[0].name).toBe('Momentum breakouts');
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].screen.matchMode).toBe('all');
    expect(upsertSavedScreen(second, '   ', screen)).toBe(second);
  });
});

describe('applySharedScreenFromUrl', () => {
  it('writes a valid shared screen to storage, opens the Screener and strips the link', () => {
    localStorage.setItem(SCREEN_STORAGE_KEYS.pagination, JSON.stringify({page: 4, pageSize: 50}));
    const replaceState = vi.fn();
    const applied = applySharedScreenFromUrl(
      {search: `?screen=${encodeScreen(screen)}&ref=x`, pathname: '/', hash: '#workspace'},
      {replaceState, state: null},
    );
    expect(applied).toBe(true);
    expect(JSON.parse(localStorage.getItem(SCREEN_STORAGE_KEYS.conditions)!)).toEqual(screen.conditions);
    expect(JSON.parse(localStorage.getItem(SCREEN_STORAGE_KEYS.universe)!)).toBe('nifty500');
    expect(JSON.parse(localStorage.getItem(SCREEN_STORAGE_KEYS.activeTab)!)).toBe('screener');
    expect(localStorage.getItem(SCREEN_STORAGE_KEYS.pagination)).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?ref=x#workspace');
  });

  it('ignores a tampered link without touching the saved screen', () => {
    localStorage.setItem(SCREEN_STORAGE_KEYS.query, JSON.stringify('mine'));
    const replaceState = vi.fn();
    expect(applySharedScreenFromUrl({search: '?screen=abc', pathname: '/', hash: ''}, {replaceState, state: null})).toBe(false);
    expect(JSON.parse(localStorage.getItem(SCREEN_STORAGE_KEYS.query)!)).toBe('mine');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('does nothing without a screen parameter', () => {
    const replaceState = vi.fn();
    expect(applySharedScreenFromUrl({search: '?ref=x', pathname: '/', hash: ''}, {replaceState, state: null})).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
