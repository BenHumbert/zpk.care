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
 * A-126: the NADAC file writes effective dates as MM/DD/YYYY, so comparing them as text let a December rate of an
 * older year beat a January rate of a newer one, and the catalog kept a stale rate for almost every drug.
 */
import { deduplicateToLatest, latestSnapshotRows, nadacDateKey, refreshSubset, stableCatalogOrder } from '../src/data/nadac-dedupe.js';

const row = (ndc: string, effectiveDate: string, nadacPerUnit: number) => ({ ndc, effectiveDate, nadacPerUnit });

describe('A-126: the latest NADAC rate wins across a year boundary', () => {
  it('keeps the January rate of the newer year over the December rate of the older one', () => {
    const latest = deduplicateToLatest([row('1', '01/08/2025', 0.30), row('1', '12/18/2024', 0.28)]);
    expect(latest.get('1')?.nadacPerUnit).toBe(0.30);
  });

  it('does so whichever row comes first', () => {
    const latest = deduplicateToLatest([row('1', '12/18/2024', 0.28), row('1', '01/08/2025', 0.30)]);
    expect(latest.get('1')?.nadacPerUnit).toBe(0.30);
  });

  it('orders months and days within a year', () => {
    const latest = deduplicateToLatest([row('2', '03/04/2026', 1), row('2', '11/02/2025', 2), row('2', '03/11/2026', 3)]);
    expect(latest.get('2')?.nadacPerUnit).toBe(3);
  });

  it('keeps the first row on an equal date and lets any valid date beat an unreadable one', () => {
    expect(deduplicateToLatest([row('3', '02/01/2026', 1), row('3', '02/01/2026', 2)]).get('3')?.nadacPerUnit).toBe(1);
    expect(deduplicateToLatest([row('4', 'n/a', 9), row('4', '01/01/2020', 1)]).get('4')?.nadacPerUnit).toBe(1);
  });

  it('turns MM/DD/YYYY into a sortable number', () => {
    expect(nadacDateKey('12/18/2024')).toBe(20241218);
    expect(nadacDateKey('1/8/2025')).toBe(20250108);
    expect(nadacDateKey('2025-01-08')).toBe(-1);
    expect(nadacDateKey('12/18/2024')).toBeLessThan(nadacDateKey('01/08/2025'));
  });
});


describe('A-126: the catalog is the latest weekly snapshot, not every rate the year file ever held', () => {
  const snap = (ndc: string, asOfDate: string, effectiveDate: string, p: number) => ({ ndc, asOfDate, effectiveDate, nadacPerUnit: p });

  it('keeps only the rows of the newest As of Date, so a drug CMS stopped surveying is left out', () => {
    const rows = [snap('A', '03/04/2026', '02/18/2026', 1), snap('A', '03/11/2026', '02/18/2026', 1), snap('GONE', '01/07/2026', '12/17/2025', 5)];
    expect(latestSnapshotRows(rows).map((r) => r.ndc)).toEqual(['A']);
  });

  it('takes the rate the newest snapshot states, even when an older snapshot carried a later effective date', () => {
    const rows = [snap('B', '03/04/2026', '03/04/2026', 2), snap('B', '03/11/2026', '02/18/2026', 3)];
    expect(deduplicateToLatest(latestSnapshotRows(rows)).get('B')?.nadacPerUnit).toBe(3);
  });

  it('orders across a year boundary by As of Date', () => {
    const rows = [snap('C', '12/31/2025', '12/17/2025', 1), snap('C', '01/07/2026', '12/17/2025', 2)];
    expect(latestSnapshotRows(rows).map((r) => r.nadacPerUnit)).toEqual([2]);
  });

  it('keeps each continuing drug in its previous position and appends new ones in snapshot order', () => {
    expect(stableCatalogOrder(['X', 'GONE', 'Y', 'Z'], ['NEW1', 'Z', 'X', 'NEW2', 'Y'])).toEqual(['X', 'Y', 'Z', 'NEW1', 'NEW2']);
  });

  it('refreshes a demo subset in place: a drug that left is replaced by the next unused current drug of its tier and OTC status after the run', () => {
    const catalog = [
      { ndc: 'N0', tierLevel: 2, otc: false }, { ndc: 'K1', tierLevel: 1, otc: false }, { ndc: 'K2', tierLevel: 2, otc: true },
      { ndc: 'N1', tierLevel: 1, otc: false }, { ndc: 'N2', tierLevel: 2, otc: false },
    ];
    const previous = [{ ndc: 'K1', tierLevel: 1, otc: false }, { ndc: 'GONE1', tierLevel: 2, otc: false }, { ndc: 'K2', tierLevel: 2, otc: true }, { ndc: 'GONE2', tierLevel: 1, otc: false }];
    expect(refreshSubset(previous, catalog).map((r) => r.ndc)).toEqual(['K1', 'N2', 'K2', 'N1']);
  });

  it('prefers a drug name the subset does not hold yet over another package code of the same drug', () => {
    const catalog = [
      { ndc: 'K', tierLevel: 1, otc: false, description: 'KEEP 1 MG' },
      { ndc: 'D1', tierLevel: 1, otc: false, description: 'DUP 5 MG' }, { ndc: 'D2', tierLevel: 1, otc: false, description: 'DUP 5 MG' },
      { ndc: 'E1', tierLevel: 1, otc: false, description: 'ELSE 2 MG' },
    ];
    const previous = [{ ndc: 'K', tierLevel: 1, otc: false, description: 'KEEP 1 MG' }, { ndc: 'G1', tierLevel: 1, otc: false }, { ndc: 'G2', tierLevel: 1, otc: false }];
    expect(refreshSubset(previous, catalog).map((r) => r.ndc)).toEqual(['K', 'D1', 'E1']);
  });

  it('wraps to the top of the catalog when nothing after the run fits', () => {
    const catalog = [{ ndc: 'TOP', tierLevel: 3, otc: false }, { ndc: 'K', tierLevel: 1, otc: false }];
    expect(refreshSubset([{ ndc: 'K', tierLevel: 1, otc: false }, { ndc: 'GONE', tierLevel: 3, otc: false }], catalog).map((r) => r.ndc)).toEqual(['K', 'TOP']);
  });
});
