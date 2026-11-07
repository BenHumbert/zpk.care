/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The price list: one record per drug, a fixed order of sources, and a root anyone can rebuild (phased plan, item 1).
 *
 * Why: every fill was priced from the NADAC field of src/data/formulary.json as each process read it at start. Nothing
 * recorded which list a price came from, a drug without a NADAC price could not be listed, and no root committed the
 * prices: the formulary tree's leaf holds a drug's coverage (tier, copay, prior authorization, day supply), not its price.
 *
 * What this pins: a price list is a set of entries, one per 11-digit NDC, each naming its basis (NADAC; WAC; or REVIEW,
 * for a drug with neither), its price in whole $0.00001 per unit, the unit, and the date the source's price took effect.
 * The entries go in NDC order into a height-16 Poseidon Merkle tree. The root and a SHA-256 digest of the canonical text
 * identify the list, and the same entries in any order rebuild both. mergeByBasis applies the fixed order: NADAC where
 * CMS publishes one, then the licensed WAC, then REVIEW, and never prices a drug in a unit other than the one its
 * quantities are counted in.
 */
import crypto from 'crypto';
import { MerkleTree, Poseidon, Field } from 'o1js';
import { hashString } from '../src/zkp/hash-utils.js';
import {
  PRICE_LIST_TREE_HEIGHT,
  PRICE_LIST_CAPACITY,
  priceEntryError,
  canonicalPriceEntries,
  priceLeafHash,
  priceListRoot,
  priceListDigest,
  canonicalPriceText,
  mergeByBasis,
  type PriceEntry,
  type SourcePrice,
} from '../src/pricing/price-list.js';

jest.setTimeout(120_000);

const A: PriceEntry = { ndc: '00378013701', basis: 'NADAC', priceE5: 3476, unit: 'EA', effectiveDate: '2026-03-04' };
const B: PriceEntry = { ndc: '59148000813', basis: 'NADAC', priceE5: 1871019, unit: 'EA', effectiveDate: '2026-03-04' };
const C: PriceEntry = { ndc: '00093515556', basis: 'WAC', priceE5: 125000, unit: 'ML', effectiveDate: '2026-02-01' };
const D: PriceEntry = { ndc: '12345678901', basis: 'REVIEW', priceE5: 0, unit: 'GM', effectiveDate: '2026-03-05' };

describe('an entry', () => {
  test.each([
    ['NADAC', A],
    ['WAC', C],
    ['REVIEW', D],
  ])('a %s entry is accepted', (_basis, entry) => {
    expect(priceEntryError(entry)).toBeNull();
  });

  test.each<[string, Record<string, unknown>, string]>([
    ['a 10-digit NDC', { ...A, ndc: '0037801370' }, 'ndc must be the 11-digit NDC'],
    ['an NDC with dashes', { ...A, ndc: '00378-0137-01' }, 'ndc must be the 11-digit NDC'],
    ['an unknown basis', { ...A, basis: 'AWP' }, 'basis must be NADAC, WAC or REVIEW'],
    ['a negative price', { ...A, priceE5: -1 }, 'priceE5 must be whole $0.00001'],
    ['a fractional price', { ...A, priceE5: 3476.5 }, 'priceE5 must be whole $0.00001'],
    ['a price as text', { ...A, priceE5: '3476' }, 'priceE5 must be whole $0.00001'],
    ['a NADAC price of zero', { ...A, priceE5: 0 }, 'a NADAC or WAC entry needs a price above $0; a drug with no price is REVIEW'],
    ['a REVIEW entry with a price', { ...D, priceE5: 100 }, 'a REVIEW entry has no price (priceE5 0)'],
    ['an unknown unit', { ...A, unit: 'TAB' }, 'unit must be EA, ML or GM'],
    ['a US-style date', { ...A, effectiveDate: '03/04/2026' }, 'effectiveDate must be a calendar date, YYYY-MM-DD'],
    ['a date that does not exist', { ...A, effectiveDate: '2026-02-30' }, 'effectiveDate must be a calendar date, YYYY-MM-DD'],
  ])('refuses %s', (_label, entry, message) => {
    expect(priceEntryError(entry)).toContain(message);
  });
});

describe('the list', () => {
  test('is the entries in NDC order', () => {
    expect(canonicalPriceEntries([B, D, A, C]).map((e) => e.ndc)).toEqual(['00093515556', '00378013701', '12345678901', '59148000813']);
  });

  test('refuses a drug listed twice, naming it', () => {
    expect(() => canonicalPriceEntries([A, B, { ...A, priceE5: 4000 }])).toThrow('00378013701 is listed twice');
  });

  test('refuses an entry that is not one, naming it', () => {
    expect(() => canonicalPriceEntries([A, { ...B, unit: 'TAB' as never }])).toThrow('59148000813: unit must be EA, ML or GM');
  });

  test(`holds at most ${PRICE_LIST_CAPACITY} drugs, the tree's leaves`, () => {
    expect(PRICE_LIST_TREE_HEIGHT).toBe(16);
    expect(PRICE_LIST_CAPACITY).toBe(32_768);
    const many = Array.from({ length: PRICE_LIST_CAPACITY + 1 }, (_, i) => ({ ...A, ndc: String(i).padStart(11, '0') }));
    expect(() => canonicalPriceEntries(many)).toThrow(`A price list holds at most 32768 drugs; this one has 32769`);
  });
});

describe('the leaf, the root and the digest', () => {
  test('a leaf is Poseidon over the NDC hash, the price, the unit, the basis and the date', () => {
    // Written out so that anyone can rebuild a root without this code. Units: EA 1, ML 2, GM 3. Bases: NADAC 1, WAC 2, REVIEW 3.
    expect(priceLeafHash(A).toString()).toBe(
      Poseidon.hash([hashString(A.ndc), Field(3476), Field(1), Field(1), Field(20260304)]).toString(),
    );
    expect(priceLeafHash(C).toString()).toBe(
      Poseidon.hash([hashString(C.ndc), Field(125000), Field(2), Field(2), Field(20260201)]).toString(),
    );
    expect(priceLeafHash(D).toString()).toBe(Poseidon.hash([hashString(D.ndc), Field(0), Field(3), Field(3), Field(20260305)]).toString());
  });

  test('the root is the plain tree over the leaves in NDC order', () => {
    const tree = new MerkleTree(PRICE_LIST_TREE_HEIGHT);
    canonicalPriceEntries([A, B, C, D]).forEach((e, i) => tree.setLeaf(BigInt(i), priceLeafHash(e)));
    expect(priceListRoot([A, B, C, D])).toBe(tree.getRoot().toString());
  });

  test('the same entries in any order give the same root and digest', () => {
    expect(priceListRoot([D, C, B, A])).toBe(priceListRoot([A, B, C, D]));
    expect(priceListDigest([D, C, B, A])).toBe(priceListDigest([A, B, C, D]));
  });

  test.each<[string, PriceEntry]>([
    ['price', { ...A, priceE5: 3477 }],
    ['unit', { ...A, unit: 'ML' }],
    ['basis', { ...A, basis: 'WAC' }],
    ['date', { ...A, effectiveDate: '2026-03-11' }],
  ])('a different %s gives a different root and digest', (_field, changed) => {
    expect(priceListRoot([changed, B])).not.toBe(priceListRoot([A, B]));
    expect(priceListDigest([changed, B])).not.toBe(priceListDigest([A, B]));
  });

  test('an empty list has the empty tree for its root', () => {
    expect(priceListRoot([])).toBe(new MerkleTree(PRICE_LIST_TREE_HEIGHT).getRoot().toString());
  });

  test('the digest is SHA-256 of one line per entry, in NDC order', () => {
    const text = '00378013701,NADAC,3476,EA,2026-03-04\n59148000813,NADAC,1871019,EA,2026-03-04\n';
    expect(canonicalPriceText([B, A])).toBe(text);
    expect(priceListDigest([B, A])).toBe(crypto.createHash('sha256').update(text).digest('hex'));
  });
});

describe('the fixed order of sources', () => {
  const nadac = new Map<string, SourcePrice>([
    [A.ndc, { ndc: A.ndc, priceE5: 3476, unit: 'EA', effectiveDate: '2026-03-04' }],
    [B.ndc, { ndc: B.ndc, priceE5: 1871019, unit: 'EA', effectiveDate: '2026-03-04' }],
  ]);
  const wac = new Map<string, SourcePrice>([
    [B.ndc, { ndc: B.ndc, priceE5: 2500000, unit: 'EA', effectiveDate: '2026-01-01' }],
    [C.ndc, { ndc: C.ndc, priceE5: 125000, unit: 'ML', effectiveDate: '2026-02-01' }],
    ['99999999999', { ndc: '99999999999', priceE5: 100, unit: 'EA', effectiveDate: '2026-01-01' }],
  ]);
  const catalog = [
    { ndc: A.ndc, unit: 'EA' as const },
    { ndc: B.ndc, unit: 'EA' as const },
    { ndc: C.ndc, unit: 'ML' as const },
    { ndc: D.ndc, unit: 'GM' as const },
  ];

  test('NADAC first, then WAC, then REVIEW, for every drug in the catalog and no other', () => {
    const { entries, problems } = mergeByBasis(catalog, { nadac, wac }, '2026-03-05');
    expect(entries).toEqual([
      { ndc: C.ndc, basis: 'WAC', priceE5: 125000, unit: 'ML', effectiveDate: '2026-02-01' }, // no NADAC: its WAC
      { ndc: A.ndc, basis: 'NADAC', priceE5: 3476, unit: 'EA', effectiveDate: '2026-03-04' },
      { ndc: D.ndc, basis: 'REVIEW', priceE5: 0, unit: 'GM', effectiveDate: '2026-03-05' }, // neither: listed, priced by review
      { ndc: B.ndc, basis: 'NADAC', priceE5: 1871019, unit: 'EA', effectiveDate: '2026-03-04' }, // NADAC beats its WAC
    ]);
    expect(problems).toEqual([]); // 99999999999 is not in the catalog, so it is not listed
  });

  test('without a licensed file, a drug CMS does not survey is REVIEW', () => {
    const { entries } = mergeByBasis(catalog, { nadac }, '2026-03-05');
    expect(entries.find((e) => e.ndc === C.ndc)).toEqual({
      ndc: C.ndc,
      basis: 'REVIEW',
      priceE5: 0,
      unit: 'ML',
      effectiveDate: '2026-03-05',
    });
  });

  test('a source price in another unit than the drug is counted in is not used, and is reported', () => {
    const wacPerGram = new Map<string, SourcePrice>([[C.ndc, { ndc: C.ndc, priceE5: 125000, unit: 'GM', effectiveDate: '2026-02-01' }]]);
    const { entries, problems } = mergeByBasis(catalog, { wac: wacPerGram }, '2026-03-05');
    expect(entries.find((e) => e.ndc === C.ndc)?.basis).toBe('REVIEW');
    expect(problems).toEqual([`${C.ndc}: the WAC is per GM, but the drug is counted in ML; it was not used`]);
  });

  test('refuses an as-of date that is not one', () => {
    expect(() => mergeByBasis(catalog, { nadac }, '03/05/2026')).toThrow('asOf must be a calendar date, YYYY-MM-DD');
  });
});
