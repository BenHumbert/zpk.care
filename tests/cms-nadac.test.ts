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
 * The NADAC importer finds the newest CMS file instead of fetching a fixed one (A-134).
 *
 * What was wrong: src/data/import-nadac.ts downloaded one file by name,
 * nadac-national-average-drug-acquisition-cost-03-11-2026.csv. CMS publishes a new file every week under a new dated
 * name, and a new dataset every year, so every import fetched the same March file: the catalog committed on 2026-11-02
 * holds the snapshot of 2026-03-11, and against CMS's snapshot of 2026-10-28 27,774 of its 30,130 drugs are priced
 * differently (median 6.2%, a tenth by more than 21.8%), 2,040 are no longer surveyed and 2,077 new drugs are missing.
 *
 * How it was found: 2026-11-03, reading CMS's dataset catalog to design the price-source connector (phased plan item 1).
 *
 * What is true now: newestNadacFile reads CMS's dataset catalog (data.medicaid.gov's metastore), takes the dataset of
 * the latest year titled "NADAC (National Average Drug Acquisition Cost) YYYY", and returns its CSV download with the
 * date CMS last changed it. The importer uses it unless NADAC_CSV names a local copy.
 */
import fs from 'fs';
import path from 'path';
import { newestNadacFile, findNewestNadacFile, NADAC_CATALOG_URL } from '../src/pricing/cms-nadac.js';

const REPO = path.resolve(__dirname, '..');

/** A dataset as CMS's catalog lists it, trimmed to the fields that matter. */
function dataset(title: string, identifier: string, modified: string, downloadURL: string, format = 'csv'): Record<string, unknown> {
  return {
    '@type': 'dcat:Dataset',
    title,
    identifier,
    modified,
    distribution: [{ identifier: `${identifier}-d`, data: { '@type': 'dcat:Distribution', format, downloadURL } }],
  };
}

const CATALOG = [
  dataset('NADAC (National Average Drug Acquisition Cost) 2024', '99315a95', '2024-12-23T21:05:00+00:00', 'https://download.medicaid.gov/data/nadac-12-25-2024.csv'),
  dataset('First Time NADAC Rates', 'f1', '2026-10-30T10:00:00+00:00', 'https://download.medicaid.gov/data/first-time.csv'),
  dataset('NADAC (National Average Drug Acquisition Cost) 2026', 'fbb83258', '2026-10-27T11:30:01+00:00', 'https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-10-28-2026.csv'),
  dataset('NADAC Comparison', 'c1', '2026-10-31T10:00:00+00:00', 'https://download.medicaid.gov/data/comparison.csv'),
  dataset('NADAC (National Average Drug Acquisition Cost) 2025', 'f38d0706', '2025-12-30T15:25:00+00:00', 'https://download.medicaid.gov/data/nadac-12-31-2025.csv'),
  dataset('State Drug Utilization Data 2026', 's1', '2026-11-01T10:00:00+00:00', 'https://download.medicaid.gov/data/sdud.csv'),
];

describe('newestNadacFile', () => {
  test("takes the latest year's NADAC dataset and its CSV, not the other NADAC titles", () => {
    expect(newestNadacFile(CATALOG)).toEqual({
      year: 2026,
      title: 'NADAC (National Average Drug Acquisition Cost) 2026',
      identifier: 'fbb83258',
      modified: '2026-10-27T11:30:01+00:00',
      downloadURL: 'https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-10-28-2026.csv',
    });
  });

  test('passes over a distribution that is not CSV', () => {
    const withJson = [
      ...CATALOG.filter((d) => d.identifier !== 'fbb83258'),
      {
        ...CATALOG[2],
        distribution: [
          { data: { format: 'json', downloadURL: 'https://download.medicaid.gov/data/nadac-2026.json' } },
          { data: { format: 'CSV', downloadURL: 'https://download.medicaid.gov/data/nadac-2026.csv' } },
        ],
      },
    ];
    expect(newestNadacFile(withJson).downloadURL).toBe('https://download.medicaid.gov/data/nadac-2026.csv');
  });

  test('refuses a catalog with no NADAC dataset, saying what it looked for', () => {
    expect(() => newestNadacFile([CATALOG[1], CATALOG[5]])).toThrow('CMS\'s dataset catalog lists no "NADAC (National Average Drug Acquisition Cost) YYYY" dataset');
  });

  test('refuses a newest NADAC dataset with no CSV to download', () => {
    const noCsv = [{ ...CATALOG[2], distribution: [{ data: { format: 'json', downloadURL: 'https://x.example/n.json' } }] }];
    expect(() => newestNadacFile(noCsv)).toThrow('NADAC (National Average Drug Acquisition Cost) 2026 has no CSV download');
  });

  test('refuses an answer that is not a catalog', () => {
    expect(() => newestNadacFile({ message: 'rate limited' })).toThrow("CMS's dataset catalog did not answer with a list of datasets");
  });

  test('refuses a download that is not https from medicaid.gov', () => {
    const elsewhere = [dataset('NADAC (National Average Drug Acquisition Cost) 2026', 'x', '2026-10-27T11:30:01+00:00', 'http://download.medicaid.gov/data/n.csv')];
    expect(() => newestNadacFile(elsewhere)).toThrow('is not an https download from medicaid.gov');
    const lookalike = [dataset('NADAC (National Average Drug Acquisition Cost) 2026', 'x', '2026-10-27T11:30:01+00:00', 'https://download.medicaid.gov.example.com/n.csv')];
    expect(() => newestNadacFile(lookalike)).toThrow('is not an https download from medicaid.gov');
  });
});

describe('findNewestNadacFile', () => {
  test("asks CMS's metastore and reads the answer", async () => {
    const asked: string[] = [];
    const file = await findNewestNadacFile(async (url) => { asked.push(url); return CATALOG; });
    expect(asked).toEqual([NADAC_CATALOG_URL]);
    expect(NADAC_CATALOG_URL).toBe('https://data.medicaid.gov/api/1/metastore/schemas/dataset/items?show-reference-ids=false');
    expect(file.year).toBe(2026);
  });
});

describe('the importer', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'data', 'import-nadac.ts'), 'utf8');

  test('names no dated CMS file', () => {
    expect(src).not.toMatch(/nadac-national-average-drug-acquisition-cost-\d\d-\d\d-\d{4}\.csv/);   // before: the 03-11-2026 file
  });

  test('finds the newest file unless NADAC_CSV names a local copy', () => {
    expect(src).toContain('findNewestNadacFile()');
    expect(src).toContain('process.env.NADAC_CSV');
  });
});
