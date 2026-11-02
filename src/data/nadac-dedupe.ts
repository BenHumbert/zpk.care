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
 * Picking each drug's latest NADAC rate (A-126).
 *
 * The CMS file writes effective dates as MM/DD/YYYY. Compared as text, "12/18/2024" sorts after "01/08/2025", so a
 * December rate of an older year beat a January rate of a newer one and the catalog kept a stale rate for almost
 * every drug. Dates are compared as YYYYMMDD numbers instead.
 */

/** MM/DD/YYYY as a sortable YYYYMMDD number; -1 for anything else, so any readable date wins over it. */
export function nadacDateKey(mmddyyyy: string): number {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mmddyyyy).trim());
  if (!m) return -1;
  return Number(m[3]) * 10_000 + Number(m[1]) * 100 + Number(m[2]);
}

/** Each NDC's row with the latest effective date; on an equal date the first row read is kept. */
export function deduplicateToLatest<T extends { ndc: string; effectiveDate: string }>(rows: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const existing = latest.get(row.ndc);
    if (!existing || nadacDateKey(row.effectiveDate) > nadacDateKey(existing.effectiveDate)) latest.set(row.ndc, row);
  }
  return latest;
}

/**
 * The CMS year file holds every weekly NADAC snapshot since January of the prior year, each stamped with its As of
 * Date. The current list is the newest snapshot alone: a drug CMS has stopped surveying appears only in older
 * snapshots and must not keep its last rate, and the newest snapshot's rate stands even where an older one carried a
 * later effective date (a CMS revision).
 */
export function latestSnapshotRows<T extends { asOfDate: string }>(rows: readonly T[]): T[] {
  let newest = -1;
  for (const row of rows) newest = Math.max(newest, nadacDateKey(row.asOfDate));
  return rows.filter((row) => nadacDateKey(row.asOfDate) === newest);
}

/**
 * Catalog order across imports: each drug still listed keeps its previous position relative to the others, so its
 * leaf index moves only when drugs before it leave; drugs new to the list follow, in the order the snapshot gives.
 */
export function stableCatalogOrder(previousNdcs: readonly string[], currentNdcs: readonly string[]): string[] {
  const current = new Set(currentNdcs);
  const kept = previousNdcs.filter((ndc) => current.has(ndc));
  const seen = new Set(kept);
  return [...kept, ...currentNdcs.filter((ndc) => !seen.has(ndc))];
}

/**
 * A curated subset (the 100-drug demo list) refreshed against a new catalog: each drug still on the catalog takes its
 * new record in place; each drug that left is replaced in its slot by the next catalog drug of the same tier and OTC
 * status that comes after the subset's last continuing drug and is not already in it, preferring a drug whose name the
 * subset does not hold yet. The subset keeps its positions, its tier mix and its run through the catalog, instead of
 * collecting near-duplicates (other package codes of one drug).
 */
export function refreshSubset<T extends { ndc: string; tierLevel: number; otc: boolean; description?: string }>(previous: readonly T[], catalog: readonly T[]): T[] {
  const position = new Map(catalog.map((r, i) => [r.ndc, i] as const));
  const continuing = previous.filter((r) => position.has(r.ndc));
  const used = new Set(continuing.map((r) => r.ndc));
  const names = new Set(continuing.map((r) => r.description).filter((d): d is string => !!d));
  const start = continuing.reduce((max, r) => Math.max(max, position.get(r.ndc)! + 1), 0);
  const order = [...catalog.slice(start), ...catalog.slice(0, start)];
  return previous.map((r) => {
    const at = position.get(r.ndc);
    if (at !== undefined) return catalog[at];
    const fits = (c: T) => !used.has(c.ndc) && c.tierLevel === r.tierLevel && c.otc === r.otc;
    const substitute = order.find((c) => fits(c) && !(c.description && names.has(c.description))) ?? order.find(fits);
    if (!substitute) throw new Error(`No current drug of tier ${r.tierLevel} (otc ${r.otc}) to replace ${r.ndc}`);
    used.add(substitute.ndc);
    if (substitute.description) names.add(substitute.description);
    return substitute;
  });
}
