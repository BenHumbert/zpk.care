/**
 * Splitting a secret among key holders — the key ceremony (owner, 2026-11-04: node secrets are made
 * at a multisig ceremony modeled on the DNS root key ceremony, so no one person ever holds one).
 *
 * Any `threshold` of the shares rebuild the secret and fewer give no information about it. The field
 * arithmetic is checked against the FIPS-197 worked examples and, for every pair of bytes, against an
 * independent table-based multiplication; the split is checked by rebuilding from every 3-of-5 subset
 * and by showing that two shares fit every possible secret byte equally well.
 */
import { gfMul, gfInv, splitSecret, combineShares, MAX_SHARES } from '../src/keys/shamir.js';
import type { SecretShare } from '../src/keys/shamir.js';

function tableMul(): (a: number, b: number) => number {
  // log/antilog tables over the generator 3, built independently of gfMul
  const exp = new Array<number>(510);
  const log = new Array<number>(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    const doubled = ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;
    x = doubled ^ x;
  }
  for (let i = 255; i < 510; i++) exp[i] = exp[i - 255];
  return (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);
}

function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [first, ...s]), ...subsets(rest, k)];
}

function counterRng(seed: number): (n: number) => Buffer {
  let state = seed >>> 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = state >>> 24;
    }
    return out;
  };
}

describe('GF(2^8) arithmetic', () => {
  test('matches the FIPS-197 worked examples', () => {
    expect(gfMul(0x57, 0x83)).toBe(0xc1);
    expect(gfMul(0x57, 0x13)).toBe(0xfe);
    expect(gfInv(0x53)).toBe(0xca);
  });

  test('matches an independent table multiplication for every pair of bytes', () => {
    const mul = tableMul();
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        if (gfMul(a, b) !== mul(a, b)) throw new Error(`gfMul(${a}, ${b}) = ${gfMul(a, b)}, expected ${mul(a, b)}`);
      }
    }
  });

  test('every nonzero byte times its inverse is 1, and 0 has no inverse', () => {
    for (let a = 1; a < 256; a++) expect(gfMul(a, gfInv(a))).toBe(1);
    expect(() => gfInv(0)).toThrow(/no inverse/);
  });
});

describe('splitSecret and combineShares', () => {
  const secret = Buffer.from('a3f1c4e2b5d6978812345678deadbeef0011223344556677889900aabbccddee', 'hex');

  test('any 3 of 5 shares rebuild the secret', () => {
    const shares = splitSecret(secret, 3, 5);
    expect(shares.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    for (const subset of subsets(shares, 3)) {
      expect(combineShares(subset).equals(secret)).toBe(true);
    }
    for (const subset of subsets(shares, 4)) {
      expect(combineShares(subset).equals(secret)).toBe(true);
    }
    expect(combineShares(shares).equals(secret)).toBe(true);
  });

  test('the order the shares arrive in does not matter', () => {
    const shares = splitSecret(secret, 3, 5);
    expect(combineShares([shares[4], shares[0], shares[2]]).equals(secret)).toBe(true);
  });

  test('two of a 3-of-5 split rebuild something other than the secret', () => {
    const shares = splitSecret(secret, 3, 5, counterRng(7));
    for (const pair of subsets(shares, 2)) {
      expect(combineShares(pair).equals(secret)).toBe(false);
    }
  });

  test('two shares fit every value of a secret byte equally well, so they reveal nothing', () => {
    // For fixed shares at x = 1 and x = 2 of a 3-of-n split, each candidate secret byte s has exactly one
    // polynomial s + c1 x + c2 x^2 through both points: count the (c1, c2) pairs that do, for every s.
    const y1 = 0x5c;
    const y2 = 0xa7;
    for (let s = 0; s < 256; s++) {
      let fits = 0;
      for (let c1 = 0; c1 < 256; c1++) {
        // f(1) = s ^ c1 ^ c2 = y1 fixes c2; then check f(2)
        const c2 = s ^ c1 ^ y1;
        if ((s ^ gfMul(c1, 2) ^ gfMul(c2, gfMul(2, 2))) === y2) fits++;
      }
      expect(fits).toBe(1);
    }
  });

  test('a split is fresh each time: the same secret gives different shares', () => {
    const a = splitSecret(secret, 3, 5);
    const b = splitSecret(secret, 3, 5);
    expect(a[0].value.equals(b[0].value)).toBe(false);
  });

  test('the shares do not contain the secret', () => {
    for (const share of splitSecret(secret, 3, 5)) {
      expect(share.value.equals(secret)).toBe(false);
      expect(share.value.length).toBe(secret.length);
    }
  });

  test('a 2-of-2 and a 255-share split both work', () => {
    const two = splitSecret(secret, 2, 2);
    expect(combineShares(two).equals(secret)).toBe(true);
    const many = splitSecret(Buffer.from([0x42]), 5, MAX_SHARES);
    expect(many).toHaveLength(255);
    expect(combineShares([many[0], many[100], many[200], many[250], many[254]]).equals(Buffer.from([0x42]))).toBe(true);
  });

  test('refuses thresholds and counts that would not protect the secret', () => {
    expect(() => splitSecret(secret, 1, 5)).toThrow(/threshold must be at least 2/);
    expect(() => splitSecret(secret, 6, 5)).toThrow(/at least the threshold/);
    expect(() => splitSecret(secret, 3, 256)).toThrow(/at most 255/);
    expect(() => splitSecret(secret, 2.5, 5)).toThrow(/threshold must be at least 2/);
    expect(() => splitSecret(Buffer.alloc(0), 2, 3)).toThrow(/1 to 1024 bytes/);
    expect(() => splitSecret(Buffer.alloc(1025), 2, 3)).toThrow(/1 to 1024 bytes/);
  });

  test('refuses an rng that returns the wrong number of bytes', () => {
    expect(() => splitSecret(secret, 3, 5, () => Buffer.alloc(3))).toThrow(/random bytes/);
  });

  test('refuses shares that cannot be combined', () => {
    const shares = splitSecret(secret, 3, 5);
    expect(() => combineShares([shares[0]])).toThrow(/at least 2 shares/);
    expect(() => combineShares([shares[0], shares[0], shares[1]])).toThrow(/twice/);
    const short: SecretShare = { index: 9, value: Buffer.alloc(3) };
    expect(() => combineShares([shares[0], shares[1], short])).toThrow(/same length/);
    expect(() => combineShares([shares[0], { index: 0, value: shares[1].value }])).toThrow(/1 to 255/);
    expect(() => combineShares([shares[0], { index: 256, value: shares[1].value }])).toThrow(/1 to 255/);
  });
});
