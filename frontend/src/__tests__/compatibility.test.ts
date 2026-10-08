import { describe, expect, it } from 'vitest';
import { SCANNER_IDENTITY, assertScannerIdentity } from '../engine/compatibility';

describe('scanner compatibility', () => {
  it('accepts the exact deployed identity', () => {
    expect(() => assertScannerIdentity(SCANNER_IDENTITY)).not.toThrow();
  });
  it.each([null, {}, {...SCANNER_IDENTITY, engineVersion:'old'},
    {...SCANNER_IDENTITY, conditionContractHash:'old'}])('rejects absent or different identities', value => {
    expect(() => assertScannerIdentity(value)).toThrow('incompatible');
  });
});
