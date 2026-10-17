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
 * Reading and writing the formulary tree cache. The validity rules live in
 * `FormularyService`; this file only moves the bytes.
 *
 * The file sits in the checkpoint directory, so `npm run clean:state` removes it and a clean
 * boot rebuilds from scratch. That is the intended relationship: the cache is derived state
 * with the same lifetime as the rest of the sequencer's derived state, not configuration.
 *
 * Nothing here is trusted. A missing, unreadable, truncated or stale file is a cache miss, and
 * a miss is just a slower boot. Writes are atomic (temp file, fsync, rename) so an interrupted
 * write cannot leave a half-written cache that a later boot would try to use.
 */
import fs from 'fs';
import path from 'path';
import type { FormularyTreeCache } from './formulary-service.js';

export const FORMULARY_CACHE_FILENAME = 'formulary-tree-cache.json';

export function formularyCachePath(dir: string): string {
  return path.join(dir, FORMULARY_CACHE_FILENAME);
}

/**
 * Read a cache if one is there and parses. Returns null on anything else, including a corrupt
 * file, because every failure here is a cache miss and a cache miss is not an error.
 */
export function readFormularyTreeCache(dir: string): FormularyTreeCache | null {
  const file = formularyCachePath(dir);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as FormularyTreeCache;
  } catch (err: unknown) {
    console.warn(
      '  [formulary] could not read the tree cache (%s); rebuilding.',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Write the cache atomically. A failure is logged and ignored: not being able to save a cache
 * must never stop a sequencer that has already built the tree it needs.
 */
export function writeFormularyTreeCache(dir: string, cache: FormularyTreeCache): boolean {
  const file = formularyCachePath(dir);
  const temp = file + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(cache));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    return true;
  } catch (err: unknown) {
    console.warn(
      '  [formulary] could not save the tree cache (%s); the next boot will rebuild.',
      err instanceof Error ? err.message : String(err),
    );
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to clean up */ }
    return false;
  }
}
