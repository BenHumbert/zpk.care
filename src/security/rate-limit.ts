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
 * A sliding-window rate limiter, keyed by whatever the caller wants to count: a remote address, a
 * token ID, or a single shared key for a route-wide ceiling. No dependencies, so any listener can
 * use it. Memory is bounded by evicting keys whose window has gone quiet.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  /**
   * @param max — how many events a key may have inside one window
   * @param windowMs — the window's length
   */
  constructor(private readonly max: number, private readonly windowMs: number) {
    if (!(max > 0) || !(windowMs > 0)) throw new Error('SlidingWindowLimiter: max and windowMs must be positive');
  }

  /** Record an event for `key` if it is allowed; returns false when the key is over its limit. */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    let times = this.hits.get(key);
    if (!times) {
      times = [];
      this.hits.set(key, times);
    }
    while (times.length > 0 && times[0] <= cutoff) times.shift();
    if (times.length >= this.max) return false;
    times.push(now);
    if (this.hits.size > 10_000) this.evict(cutoff);
    return true;
  }

  /** How many events `key` has inside the current window. */
  count(key: string, now: number = Date.now()): number {
    const times = this.hits.get(key);
    if (!times) return 0;
    const cutoff = now - this.windowMs;
    return times.filter((t) => t > cutoff).length;
  }

  private evict(cutoff: number): void {
    for (const [k, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) this.hits.delete(k);
    }
  }
}
