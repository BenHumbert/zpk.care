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
 * The drug price list: one record per drug, the fixed order of sources, and a root anyone can rebuild (phased plan,
 * item 1).
 *
 * Every fill used to be priced from the NADAC field of src/data/formulary.json, as each process read it at start.
 * Nothing recorded which list a price came from, a drug without a NADAC price could not be listed, and no root
 * committed the prices: the formulary tree's leaf holds a drug's coverage (tier, copay, prior authorization, day
 * supply), not its price.
 *
 * A price list is a set of entries, one per 11-digit NDC. Each names its basis, its price in whole $0.00001 per unit
 * (CMS publishes NADAC to five decimals, so this is exact), the unit the drug's quantities are counted in, and the date
 * the source's price took effect. The basis is the fixed order the owner set: NADAC where CMS publishes one, then the
 * wholesale acquisition cost (WAC) from a licensed file, then REVIEW, for a drug with neither: it is listed, and its
 * price is set by invoice review instead of by the list.
 *
 * The list is identified two ways, and anyone can rebuild both from the entries alone:
 *
 *   root    a height-16 Poseidon Merkle tree over the entries in NDC order, one leaf each:
 *           Poseidon[hashString(ndc), priceE5, unit, basis, YYYYMMDD], with units EA 1, ML 2, GM 3 and bases
 *           NADAC 1, WAC 2, REVIEW 3. This is what a circuit can check a price against.
 *   digest  SHA-256 of one line per entry in NDC order, "ndc,basis,priceE5,unit,YYYY-MM-DD\n". This is what a person
 *           or a script without o1js can check.
 *
 * No o1js state is kept here; the functions are pure, so the insurer's build, the sequencer's check and a rebuild by
 * anyone else run the same code.
 */
import crypto from 'crypto';
import { Field, MerkleTree, Poseidon } from 'o1js';
import { hashString } from '../zkp/hash-utils.js';
import { buildTreeBottomUp } from '../zkp/merkle-build.js';

/** The price list's tree height, the formulary's: one leaf per drug the network can list. */
export const PRICE_LIST_TREE_HEIGHT = 16;

/** The most drugs a list holds: the tree's leaves, 2^(height-1). */
export const PRICE_LIST_CAPACITY = 2 ** (PRICE_LIST_TREE_HEIGHT - 1);

/** Where a price came from, in the order a drug's price is taken. */
export const PRICE_BASES = ['NADAC', 'WAC', 'REVIEW'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

/** The units a quantity is counted in, NCPDP's billing units. */
export const PRICING_UNITS = ['EA', 'ML', 'GM'] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

const BASIS_CODE: Readonly<Record<PriceBasis, number>> = { NADAC: 1, WAC: 2, REVIEW: 3 };
const UNIT_CODE: Readonly<Record<PricingUnit, number>> = { EA: 1, ML: 2, GM: 3 };

/** One drug's price on a list. */
export interface PriceEntry {
  /** The 11-digit NDC, digits only */
  ndc: string;
  basis: PriceBasis;
  /** Price per unit in whole $0.00001 (0.60042 -> 60042); 0 for REVIEW, above 0 otherwise */
  priceE5: number;
  /** The unit the drug's quantities are counted in, and the price is per */
  unit: PricingUnit;
  /** When the source's price took effect, YYYY-MM-DD */
  effectiveDate: string;
}

/** One drug's price as a source gives it, before the fixed order picks a basis. */
export interface SourcePrice {
  ndc: string;
  priceE5: number;
  unit: PricingUnit;
  effectiveDate: string;
}

const NDC_11 = /^\d{11}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** Whether s is a real calendar date written YYYY-MM-DD (not 2026-02-30). */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Why e cannot be a price entry, or null when it can. */
export function priceEntryError(e: unknown): string | null {
  if (!e || typeof e !== 'object') return 'a price entry must be an object';
  const r = e as Record<string, unknown>;
  if (typeof r.ndc !== 'string' || !NDC_11.test(r.ndc)) return `ndc must be the 11-digit NDC, digits only (got ${show(r.ndc)})`;
  if (!(PRICE_BASES as readonly unknown[]).includes(r.basis)) return `basis must be NADAC, WAC or REVIEW (got ${show(r.basis)})`;
  if (typeof r.priceE5 !== 'number' || !Number.isSafeInteger(r.priceE5) || r.priceE5 < 0) {
    return `priceE5 must be whole $0.00001, 0 or more (got ${show(r.priceE5)})`;
  }
  if (r.basis === 'REVIEW' && r.priceE5 !== 0) return `a REVIEW entry has no price (priceE5 0); got ${r.priceE5}`;
  if (r.basis !== 'REVIEW' && r.priceE5 === 0) return 'a NADAC or WAC entry needs a price above $0; a drug with no price is REVIEW';
  if (!(PRICING_UNITS as readonly unknown[]).includes(r.unit)) return `unit must be EA, ML or GM (got ${show(r.unit)})`;
  if (!isCalendarDate(r.effectiveDate)) return `effectiveDate must be a calendar date, YYYY-MM-DD (got ${show(r.effectiveDate)})`;
  return null;
}

/**
 * The entries as a list: each checked, in NDC order, copied to exactly the five fields. Throws, naming the drug, on an
 * entry that is not one or a drug listed twice, and on more drugs than the tree holds.
 */
export function canonicalPriceEntries(entries: readonly PriceEntry[]): PriceEntry[] {
  if (entries.length > PRICE_LIST_CAPACITY) {
    throw new Error(`A price list holds at most ${PRICE_LIST_CAPACITY} drugs; this one has ${entries.length}`);
  }
  const seen = new Set<string>();
  const list: PriceEntry[] = [];
  entries.forEach((e, i) => {
    const err = priceEntryError(e);
    if (err) {
      const ndc =
        e && typeof e === 'object' && typeof (e as { ndc?: unknown }).ndc === 'string' ? (e as { ndc: string }).ndc : `entry ${i}`;
      throw new Error(`${ndc}: ${err}`);
    }
    if (seen.has(e.ndc)) throw new Error(`${e.ndc} is listed twice`);
    seen.add(e.ndc);
    list.push({ ndc: e.ndc, basis: e.basis, priceE5: e.priceE5, unit: e.unit, effectiveDate: e.effectiveDate });
  });
  return list.sort((a, b) => (a.ndc < b.ndc ? -1 : a.ndc > b.ndc ? 1 : 0));
}

/** One entry's leaf: Poseidon[hashString(ndc), priceE5, unit, basis, YYYYMMDD]. The entry is assumed checked. */
export function priceLeafHash(e: PriceEntry): Field {
  return Poseidon.hash([
    hashString(e.ndc),
    Field(e.priceE5),
    Field(UNIT_CODE[e.unit]),
    Field(BASIS_CODE[e.basis]),
    Field(Number(e.effectiveDate.replace(/-/g, ''))),
  ]);
}

/** The list's root, in decimal: the height-16 tree over its entries in NDC order. Checks the entries first. */
export function priceListRoot(entries: readonly PriceEntry[]): string {
  const tree = new MerkleTree(PRICE_LIST_TREE_HEIGHT);
  const list = canonicalPriceEntries(entries);
  if (list.length > 0) buildTreeBottomUp(tree, list.map(priceLeafHash));
  return tree.getRoot().toString();
}

/** The list as text: one line per entry in NDC order, "ndc,basis,priceE5,unit,YYYY-MM-DD\n". Checks the entries first. */
export function canonicalPriceText(entries: readonly PriceEntry[]): string {
  return canonicalPriceEntries(entries)
    .map((e) => `${e.ndc},${e.basis},${e.priceE5},${e.unit},${e.effectiveDate}\n`)
    .join('');
}

/** SHA-256 of canonicalPriceText, in hex. */
export function priceListDigest(entries: readonly PriceEntry[]): string {
  return crypto.createHash('sha256').update(canonicalPriceText(entries)).digest('hex');
}

/** A drug the network lists, and the unit its quantities are counted in. */
export interface CatalogDrug {
  ndc: string;
  unit: PricingUnit;
}

/** The prices each source gives, by NDC. A source that is not loaded is absent. */
export interface PriceSources {
  nadac?: ReadonlyMap<string, SourcePrice>;
  wac?: ReadonlyMap<string, SourcePrice>;
}

/**
 * One entry for every drug in the catalog, by the fixed order: its NADAC if CMS publishes one, else its WAC, else
 * REVIEW (no price, effective `asOf`). A source price that cannot be used (a unit other than the one the drug is
 * counted in, or a price that is not one) is passed over for the next basis and reported in `problems`; drugs outside
 * the catalog are not listed. Throws when `asOf` is not a calendar date.
 */
export function mergeByBasis(
  catalog: readonly CatalogDrug[],
  sources: PriceSources,
  asOf: string,
): { entries: PriceEntry[]; problems: string[] } {
  if (!isCalendarDate(asOf)) throw new Error(`asOf must be a calendar date, YYYY-MM-DD (got ${show(asOf)})`);
  const entries: PriceEntry[] = [];
  const problems: string[] = [];
  for (const drug of catalog) {
    let chosen: PriceEntry | null = null;
    for (const [basis, prices] of [
      ['NADAC', sources.nadac],
      ['WAC', sources.wac],
    ] as const) {
      const price = prices?.get(drug.ndc);
      if (!price) continue;
      if (price.unit !== drug.unit) {
        problems.push(`${drug.ndc}: the ${basis} is per ${price.unit}, but the drug is counted in ${drug.unit}; it was not used`);
        continue;
      }
      const candidate: PriceEntry = { ndc: drug.ndc, basis, priceE5: price.priceE5, unit: price.unit, effectiveDate: price.effectiveDate };
      const err = priceEntryError(candidate);
      if (err) {
        problems.push(`${drug.ndc}: the ${basis} price cannot be used (${err}); it was not used`);
        continue;
      }
      chosen = candidate;
      break;
    }
    entries.push(chosen ?? { ndc: drug.ndc, basis: 'REVIEW', priceE5: 0, unit: drug.unit, effectiveDate: asOf });
  }
  return { entries: canonicalPriceEntries(entries), problems };
}
