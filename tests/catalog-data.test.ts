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
 * Tests read a frozen copy of the drug catalog; the network reads the live one (A-134).
 *
 * What was wrong: every suite read src/data, the catalog the network prices from, so each import from CMS broke the
 * suites that pin a drug's price or its place in the list (fourteen of them at A-126), and keeping prices current meant
 * re-pinning those suites every time CMS publishes, which is weekly.
 *
 * What is true now: jest.config.js runs tests/setup/frozen-data-dir.ts before every suite, and it points ZKP_DATA_DIR,
 * which every data loader honours, at tests/fixtures/data: the catalog as committed on 2026-11-02 (the CMS snapshot of
 * 2026-03-11), the 100-drug list and the fixture providers. The live catalog is checked here for what must hold whatever
 * its prices are: every drug converts to a price-list entry, no NDC appears twice, the list fits the tree, and the
 * 100-drug list is drawn from it.
 */
import fs from 'fs';
import path from 'path';
import { MEDICATIONS } from '../src/data/index.js';
import { formularyRaw } from '../src/data/formulary-loader.js';
import { priceEntryError, PRICE_LIST_CAPACITY, type PriceEntry } from '../src/pricing/price-list.js';
import { nadacUnitPriceE5 } from '../src/fulfillment/nadac-pricing.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'data');
const LIVE = path.join(REPO, 'src', 'data');
const FILES = ['formulary.json', 'formulary-100.json', 'pharmacies.json', 'prescribers.json'];

interface CatalogRecord { ndc: string; nadacPerUnit: number; pricingUnit: string; effectiveDate: string }
const readCatalog = (dir: string, file = 'formulary.json'): CatalogRecord[] => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

describe('the catalog the tests read', () => {
  test('is the frozen copy', () => {
    expect(process.env.ZKP_DATA_DIR).toBe(FIXTURE);   // before: unset, so every suite read src/data
  });

  test('has every file the data loaders read', () => {
    for (const f of FILES) expect([f, fs.existsSync(path.join(FIXTURE, f))]).toEqual([f, true]);
  });

  test('is what the loaders loaded', () => {
    const frozen = readCatalog(FIXTURE);
    expect(formularyRaw.length).toBe(frozen.length);
    expect(MEDICATIONS.length).toBe(frozen.length);
    expect(formularyRaw.map((r) => r.ndc)).toEqual(frozen.map((r) => r.ndc));
  });
});

describe('the live catalog', () => {
  const live = readCatalog(LIVE);
  const toIso = (us: string): string => {
    const [m, d, y] = us.split('/');
    return `${y}-${(m ?? '').padStart(2, '0')}-${(d ?? '').padStart(2, '0')}`;
  };

  test('converts drug by drug to price-list entries', () => {
    const problems: string[] = [];
    for (const r of live) {
      let priceE5 = -1;
      try { priceE5 = nadacUnitPriceE5(r.nadacPerUnit); } catch (err) { problems.push(`${r.ndc}: ${(err as Error).message}`); continue; }
      const entry = { ndc: r.ndc, basis: 'NADAC', priceE5, unit: r.pricingUnit, effectiveDate: toIso(r.effectiveDate) } as PriceEntry;
      const err = priceEntryError(entry);
      if (err) problems.push(`${r.ndc}: ${err}`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  test('lists no NDC twice and fits the tree', () => {
    expect(new Set(live.map((r) => r.ndc)).size).toBe(live.length);
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThanOrEqual(PRICE_LIST_CAPACITY);
  });

  test('is where the 100-drug list comes from', () => {
    const subset = readCatalog(LIVE, 'formulary-100.json');
    const ndcs = new Set(live.map((r) => r.ndc));
    expect(subset).toHaveLength(100);
    expect(subset.filter((r) => !ndcs.has(r.ndc)).map((r) => r.ndc)).toEqual([]);
  });
});
