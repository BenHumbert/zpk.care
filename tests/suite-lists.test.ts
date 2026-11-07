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
 * Every suite is in exactly one list: the regression batch (`scripts/dev/regression-suites.txt`, `npm test`) or the
 * slow list (`scripts/dev/slow-suites.txt`, which `npm run test:all` adds), so no suite can drift out of every run.
 *
 * What was wrong (cleanup plan, phase 1.1): the batch actually run lived in a scratch file, the repo's list was 20
 * suites behind it, and 44 suites were in no batch at all. Several had been failing for weeks, one since March, on
 * calls and fixtures the code had moved past; one of them hid a real defect (A-148).
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string): string[] =>
  fs
    .readFileSync(path.join(ROOT, 'scripts', 'dev', file), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');

describe('the suite lists', () => {
  const batch = read('regression-suites.txt');
  const slow = read('slow-suites.txt');
  const suites = fs
    .readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/${f}`)
    .sort();

  test('name every suite exactly once between them', () => {
    const listed = [...batch, ...slow].sort();
    expect(listed).toEqual([...new Set(listed)].sort()); // no suite twice
    expect(suites.filter((s) => !listed.includes(s))).toEqual([]); // none left out
    expect(listed.filter((s) => !suites.includes(s))).toEqual([]); // none that is gone
  });

  test('name each suite by its path from the repository root', () => {
    for (const s of [...batch, ...slow]) expect(s).toMatch(/^tests\/[\w.-]+\.test\.ts$/);
  });
});
