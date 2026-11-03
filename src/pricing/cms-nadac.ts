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
 * Where CMS's newest NADAC file is (finding A-134; the CMS connector of phased plan item 1).
 *
 * CMS publishes NADAC weekly as one CSV per calendar year, holding every weekly snapshot of that year, under a name
 * that carries the date of its last update (nadac-national-average-drug-acquisition-cost-10-28-2026.csv). The name
 * changes with every update and the dataset with every year, so a fixed URL goes stale within a week: the importer's
 * did, and the catalog committed on 2026-11-02 was built from the file of 2026-03-11.
 *
 * CMS's dataset catalog (data.medicaid.gov's DKAN metastore) lists each year's dataset with its current download, so
 * the newest file is the CSV of the latest year's dataset. The download is taken only over https from medicaid.gov,
 * because the address comes from a remote answer.
 */

/** CMS's dataset catalog: every dataset on data.medicaid.gov with its downloads. About 1.2 MB of JSON. */
export const NADAC_CATALOG_URL = 'https://data.medicaid.gov/api/1/metastore/schemas/dataset/items?show-reference-ids=false';

/** The title CMS gives each year's NADAC dataset. "First Time NADAC Rates" and "NADAC Comparison" are other data. */
const NADAC_TITLE = /^NADAC \(National Average Drug Acquisition Cost\) (\d{4})$/;

/** The newest NADAC file, as CMS's catalog describes it. */
export interface NadacFile {
  /** The calendar year the dataset covers */
  year: number;
  title: string;
  /** CMS's identifier for the dataset */
  identifier: string;
  /** When CMS last changed the dataset, as the catalog gives it (ISO 8601) */
  modified: string;
  /** The CSV to download */
  downloadURL: string;
}

/** Whether u is an https address on medicaid.gov or one of its subdomains. */
function isMedicaidHttps(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === 'medicaid.gov' || url.hostname.endsWith('.medicaid.gov'));
  } catch {
    return false;
  }
}

/** The CSV download among a dataset's distributions, or null. */
function csvDownload(distribution: unknown): string | null {
  if (!Array.isArray(distribution)) return null;
  for (const item of distribution) {
    const data = item && typeof item === 'object' ? (item as { data?: unknown }).data : undefined;
    if (!data || typeof data !== 'object') continue;
    const { format, downloadURL } = data as { format?: unknown; downloadURL?: unknown };
    if (typeof downloadURL === 'string' && typeof format === 'string' && format.toLowerCase() === 'csv') return downloadURL;
  }
  return null;
}

/**
 * The newest NADAC file in CMS's dataset catalog: the CSV of the latest year's NADAC dataset. Throws, saying what is
 * missing, when the answer is not a catalog, lists no NADAC dataset, or offers no usable CSV for the newest one.
 */
export function newestNadacFile(catalog: unknown): NadacFile {
  if (!Array.isArray(catalog)) throw new Error("CMS's dataset catalog did not answer with a list of datasets");
  let newest: { year: number; dataset: Record<string, unknown> } | null = null;
  for (const dataset of catalog) {
    if (!dataset || typeof dataset !== 'object') continue;
    const title = (dataset as { title?: unknown }).title;
    const match = typeof title === 'string' ? NADAC_TITLE.exec(title) : null;
    if (!match) continue;
    const year = Number(match[1]);
    if (!newest || year > newest.year) newest = { year, dataset: dataset as Record<string, unknown> };
  }
  if (!newest) throw new Error('CMS\'s dataset catalog lists no "NADAC (National Average Drug Acquisition Cost) YYYY" dataset');

  const { year, dataset } = newest;
  const title = dataset.title as string;
  const downloadURL = csvDownload(dataset.distribution);
  if (!downloadURL) throw new Error(`${title} has no CSV download in CMS's dataset catalog`);
  if (!isMedicaidHttps(downloadURL)) throw new Error(`${title}: its download ${downloadURL} is not an https download from medicaid.gov`);
  return {
    year,
    title,
    identifier: typeof dataset.identifier === 'string' ? dataset.identifier : '',
    modified: typeof dataset.modified === 'string' ? dataset.modified : '',
    downloadURL,
  };
}

/** GET a URL and read its JSON, refusing any answer but 200. */
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
}

/** Ask CMS's dataset catalog for the newest NADAC file. `get` is injectable for tests. */
export async function findNewestNadacFile(get: (url: string) => Promise<unknown> = fetchJson): Promise<NadacFile> {
  return newestNadacFile(await get(NADAC_CATALOG_URL));
}
