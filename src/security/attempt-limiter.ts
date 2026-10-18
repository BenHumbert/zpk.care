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
 * A persisted attempt limiter for secrets that are typed by people — phase A item A7, finding
 * A-21 (the HR Tool's passphrase had no attempt limit), using the same shape item A4 gave the
 * device PIN: a few free attempts, then a delay that doubles to a cap. Never a wipe.
 *
 * The counter lives in a small plaintext JSON file beside the encrypted data, because it cannot
 * live inside a file that is encrypted under the very secret being guessed. The file carries no
 * secret: keys are workspace directory names or route labels, values are counts and times.
 *
 * Only `node:fs` and `node:path`, so any tool can use it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface AttemptLimiterOptions {
  /** Failures allowed before any delay is imposed. */
  freeAttempts: number;
  /** The first delay, doubled on each further failure. */
  baseDelayMs: number;
  /** The delay never exceeds this. */
  maxDelayMs: number;
}

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimiterOptions = {
  freeAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 15 * 60_000,
};

interface Entry { failures: number; lockedUntil: number }

export type AttemptVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

export class PersistedAttemptLimiter {
  private readonly opts: AttemptLimiterOptions;
  private state: Record<string, Entry> = {};
  private loaded = false;

  constructor(private readonly file: string, opts: Partial<AttemptLimiterOptions> = {}) {
    this.opts = { ...DEFAULT_ATTEMPT_LIMITS, ...opts };
  }

  /** Whether an attempt for `key` may proceed right now. Does not record anything. */
  check(key: string, now: number = Date.now()): AttemptVerdict {
    this.load();
    const e = this.state[key];
    if (!e || e.lockedUntil <= now) return { allowed: true };
    return { allowed: false, retryAfterMs: e.lockedUntil - now };
  }

  /** Record a failed attempt; returns the delay now in force (0 while attempts are still free). */
  recordFailure(key: string, now: number = Date.now()): number {
    this.load();
    const e = this.state[key] ?? { failures: 0, lockedUntil: 0 };
    e.failures += 1;
    const over = e.failures - this.opts.freeAttempts;
    const delay = over <= 0 ? 0 : Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (over - 1));
    e.lockedUntil = now + delay;
    this.state[key] = e;
    this.persist();
    return delay;
  }

  /** A success clears the key. */
  reset(key: string): void {
    this.load();
    if (this.state[key]) {
      delete this.state[key];
      this.persist();
    }
  }

  /** Failures recorded for `key`. */
  failures(key: string): number {
    this.load();
    return this.state[key]?.failures ?? 0;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Entry>;
        if (parsed && typeof parsed === 'object') this.state = parsed;
      }
    } catch {
      // An unreadable counter must not block a legitimate attempt; it starts over.
      this.state = {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Best effort: the in-memory counter still applies for this process's lifetime.
    }
  }
}
