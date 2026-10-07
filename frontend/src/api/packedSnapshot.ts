// Only the wire format changes. Reconstruct ordinary records before screening.
interface Table { keys: string[]; values: unknown[][]; missing: number[][] }
const invalid = () => { throw new Error('Invalid packed scanner snapshot'); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function indexes(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.some(i => !Number.isInteger(i) || i < 0 || i >= length)
      || new Set(value).size !== value.length) return invalid();
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!object(value) || !Array.isArray(value.keys) || value.keys.some(k => typeof k !== 'string')
      || new Set(value.keys).size !== value.keys.length || !Array.isArray(value.values)
      || !Array.isArray(value.missing) || value.values.length !== value.missing.length) return invalid();
  const table = value as unknown as Table;
  return table.values.map((row, n) => {
    if (!Array.isArray(row) || row.length !== table.keys.length) return invalid();
    const missing = new Set(indexes(table.missing[n], table.keys.length));
    return Object.fromEntries(table.keys.flatMap((key, i) => missing.has(i) ? [] : [[key, row[i]]]));
  });
}
export function unpackSnapshot(value: unknown): unknown {
  if (!object(value) || value.stockEncoding === undefined) return value;
  if (value.stockEncoding !== 'columnar-v1' || !object(value.nestedTables)) return invalid();
  const stocks = records(value.stocksTable);
  for (const [field, nested] of Object.entries(value.nestedTables)) {
    if (!['presetMatches', 'metrics', 'financialMetadata', 'historyMetadata'].includes(field)
        || !object(nested)) return invalid();
    const positions = indexes(nested.indexes, stocks.length), children = records(nested.table);
    if (positions.length !== children.length) return invalid();
    positions.forEach((position, i) => {
      if (Object.hasOwn(stocks[position], field)) return invalid();
      stocks[position][field] = children[i];
    });
  }
  const { stockEncoding, stocksTable, nestedTables, ...metadata } = value;
  return { ...metadata, stocks };
}
