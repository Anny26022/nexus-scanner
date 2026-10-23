import { beforeEach, describe, expect, it } from 'vitest';
import { WATCHLIST_KEY, readChartStorage, writeChartStorage } from '../chart/storage';
import {
  LISTS_KEY, createList, deleteList, flaggedSymbols, loadFlags, loadWatchlistStore, moveItem, renameList,
  saveWatchlistStore, setFlag, switchList, withActiveItems,
} from '../chart/watchlists';

beforeEach(() => localStorage.clear());

describe('watchlist store', () => {
  it('migrates the existing single watchlist into a named default list', () => {
    writeChartStorage(WATCHLIST_KEY, ['###Swing', 'TCS', 'INFY', 'bad symbol']);
    const store = loadWatchlistStore();
    expect(store.lists).toEqual([{id: 'default', name: 'Watchlist', items: ['###Swing', 'TCS', 'INFY']}]);
    expect(store.activeId).toBe('default');
  });

  it('keeps watchlist.v2 as the active list so other features keep adding to it', () => {
    let store = loadWatchlistStore();
    store = createList(withActiveItems(store, ['TCS']), 'Momentum', 1);
    saveWatchlistStore(withActiveItems(store, ['RELIANCE']));
    expect(readChartStorage(WATCHLIST_KEY)).toEqual(['RELIANCE']);

    writeChartStorage(WATCHLIST_KEY, ['RELIANCE', 'SBIN']); // e.g. "Add to watchlist" from the Screener
    store = loadWatchlistStore();
    expect(store.lists.map(list => [list.name, list.items])).toEqual([['Watchlist', ['TCS']], ['Momentum', ['RELIANCE', 'SBIN']]]);

    saveWatchlistStore(switchList(store, 'default'));
    expect(readChartStorage(WATCHLIST_KEY)).toEqual(['TCS']);
  });

  it('renames, deletes and never leaves zero lists', () => {
    let store = createList(loadWatchlistStore(), '  Long   ideas  ', 1);
    expect(store.lists[1].name).toBe('Long ideas');
    store = renameList(store, store.lists[1].id, 'Breakouts');
    expect(store.lists[1].name).toBe('Breakouts');
    expect(renameList(store, store.lists[1].id, '   ').lists[1].name).toBe('Breakouts');
    store = deleteList(store, store.activeId);
    expect(store.lists.map(list => list.name)).toEqual(['Watchlist']);
    expect(store.activeId).toBe('default');
    expect(deleteList(withActiveItems(store, ['TCS']), 'default').lists).toEqual([{id: 'default', name: 'Watchlist', items: []}]);
  });

  it('ignores corrupt stored lists', () => {
    writeChartStorage(LISTS_KEY, {activeId: 'x', lists: [null, {id: 'a', name: 5}]});
    expect(loadWatchlistStore().lists).toEqual([{id: 'default', name: 'Watchlist', items: []}]);
  });
});

describe('flags and ordering', () => {
  it('sets, clears and filters colour flags', () => {
    let flags = setFlag({}, 'TCS', 'red');
    flags = setFlag(flags, 'INFY', 'blue');
    flags = setFlag(flags, 'SBIN', 'red');
    expect(flaggedSymbols(flags, 'red')).toEqual(['TCS', 'SBIN']);
    expect(setFlag(flags, 'TCS', null).TCS).toBeUndefined();
    writeChartStorage('watchlist-flags.v1', {...flags, BAD: 'gold', 'no symbol': 'red'});
    expect(loadFlags()).toEqual(flags);
  });

  it('moves an item to a new position', () => {
    expect(moveItem(['A', 'B', 'C', 'D'], 0, 2)).toEqual(['B', 'C', 'A', 'D']);
    expect(moveItem(['A', 'B', 'C'], 2, 0)).toEqual(['C', 'A', 'B']);
    expect(moveItem(['A', 'B'], 5, 0)).toEqual(['A', 'B']);
  });
});
