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
 * The persisted attempt limiter — phase A item A7 (A-21: the HR Tool's passphrase had no attempt
 * limit). Same shape as the device PIN's backoff from item A4: free attempts, then a doubling delay
 * to a cap, persisted in a plaintext counter beside the encrypted data, and never a wipe.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PersistedAttemptLimiter, DEFAULT_ATTEMPT_LIMITS } from '../src/security/attempt-limiter.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempts-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('the attempt limiter', () => {
  test('three attempts are free, then the delay doubles from two seconds to a fifteen-minute cap', () => {
    const lim = new PersistedAttemptLimiter(path.join(dir, 'attempts.json'));
    const t = 1_000_000;
    expect(lim.check('k', t).allowed).toBe(true);
    expect(lim.recordFailure('k', t)).toBe(0);
    expect(lim.recordFailure('k', t)).toBe(0);
    expect(lim.recordFailure('k', t)).toBe(0);
    expect(lim.check('k', t).allowed).toBe(true);
    expect(lim.recordFailure('k', t)).toBe(2_000);
    const v = lim.check('k', t + 1_000);
    expect(v.allowed).toBe(false);
    expect(v.allowed ? 0 : v.retryAfterMs).toBe(1_000);
    expect(lim.check('k', t + 2_000).allowed).toBe(true);
    expect(lim.recordFailure('k', t)).toBe(4_000);
    expect(lim.recordFailure('k', t)).toBe(8_000);
    let d = 0;
    for (let i = 0; i < 20; i++) d = lim.recordFailure('k', t);
    expect(d).toBe(DEFAULT_ATTEMPT_LIMITS.maxDelayMs);
  });

  test('keys are independent and a success clears only its own', () => {
    const lim = new PersistedAttemptLimiter(path.join(dir, 'attempts.json'));
    for (let i = 0; i < 5; i++) lim.recordFailure('a', 0);
    expect(lim.check('a', 0).allowed).toBe(false);
    expect(lim.check('b', 0).allowed).toBe(true);
    lim.reset('a');
    expect(lim.check('a', 0).allowed).toBe(true);
    expect(lim.failures('a')).toBe(0);
  });

  test('the counter survives a restart, which is the point of persisting it', () => {
    const file = path.join(dir, 'attempts.json');
    const first = new PersistedAttemptLimiter(file);
    for (let i = 0; i < 4; i++) first.recordFailure('ws', 500_000);
    const second = new PersistedAttemptLimiter(file);
    expect(second.failures('ws')).toBe(4);
    expect(second.check('ws', 500_000).allowed).toBe(false);
  });

  test('the counter file holds no secret: keys and numbers only', () => {
    const file = path.join(dir, 'attempts.json');
    const lim = new PersistedAttemptLimiter(file);
    lim.recordFailure('unlock:workspace-abc', 1);
    const text = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toEqual({ 'unlock:workspace-abc': { failures: 1, lockedUntil: 1 } });
  });

  test('a corrupt counter file never blocks a legitimate attempt', () => {
    const file = path.join(dir, 'attempts.json');
    fs.writeFileSync(file, '{not json');
    const lim = new PersistedAttemptLimiter(file);
    expect(lim.check('k').allowed).toBe(true);
    expect(lim.recordFailure('k', 0)).toBe(0);
  });

  test('invalid limits are refused at construction', () => {
    expect(() => new PersistedAttemptLimiter(path.join(dir, 'x.json'), { freeAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 }))
      .not.toThrow();   // baseDelayMs 0 is a legal "no delay" configuration
    expect(() => new PersistedAttemptLimiter(path.join(dir, 'x.json'), { maxDelayMs: -1 } as never)).not.toThrow();
  });
});
