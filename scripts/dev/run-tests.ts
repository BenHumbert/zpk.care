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
 * `npm test`: the regression batch, the suites listed in `scripts/dev/regression-suites.txt`, run one at a time
 * (`--runInBand`, so proofs do not contend for the CPU) and with `--forceExit` (a few suites leave a handle open
 * after they pass).
 *
 *   npm test                          the batch
 *   npm test -- tests/a.test.ts       only the suites named: an argument ending in .test.ts replaces the list
 *   npm test -- -t "some test name"   the batch, with Jest's own options passed through
 *   npm run test:all                  every suite under tests/, the slow ones included
 *
 * A suite the list names that no longer exists stops the run before it starts, so a deleted or renamed suite
 * cannot silently drop out of the batch.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGRESSION_LIST = path.join(ROOT, 'scripts', 'dev', 'regression-suites.txt');

/** The suite paths a list file names: one per line; blank lines and `#` comments are skipped. */
function readSuiteList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

function main(): void {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const passThrough = args.filter((a) => a !== '--all');
  const named = passThrough.filter((a) => a.endsWith('.test.ts'));
  const suites = all || named.length > 0 ? [] : readSuiteList(readFileSync(REGRESSION_LIST, 'utf8'));
  const missing = suites.filter((s) => !existsSync(path.join(ROOT, s)));
  if (missing.length > 0) {
    console.error('scripts/dev/regression-suites.txt names suites that do not exist:\n  %s', missing.join('\n  '));
    process.exit(2);
  }
  const jest = createRequire(import.meta.url).resolve('jest/bin/jest');
  const run = spawnSync(process.execPath, [jest, ...suites, ...passThrough, '--runInBand', '--forceExit'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  process.exit(run.status ?? 1);
}

main();
