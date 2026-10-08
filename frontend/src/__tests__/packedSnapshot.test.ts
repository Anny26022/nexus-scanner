import { expect, it } from 'vitest';
import fixture from './fixtures/packedSnapshot.json';
import { unpackSnapshot } from '../api/packedSnapshot';

it('reconstructs Python output including missing keys, nulls, booleans and empty objects', () => {
  const packed = structuredClone(fixture.packed);
  expect(unpackSnapshot(packed)).toStrictEqual(fixture.original);
  expect(packed).toStrictEqual(fixture.packed);
});
it('accepts existing snapshots unchanged', () => {
  expect(unpackSnapshot(fixture.original)).toBe(fixture.original);
});
it.each([
  {...fixture.packed, stockEncoding:'unknown'},
  {...fixture.packed, stocksTable:{keys:['a'], values:[[1, 2]], missing:[[]]}},
  {...fixture.packed, stocksTable:{keys:['a', 'a'], values:[], missing:[]}},
  {...fixture.packed, stocksTable:{keys:['a'], values:[[1]], missing:[[2]]}},
  {...fixture.packed, nestedTables:{metrics:{indexes:[99], table:fixture.packed.stocksTable}}},
])('rejects malformed packed records', packed => {
  expect(() => unpackSnapshot(packed)).toThrow('Invalid packed scanner snapshot');
});
