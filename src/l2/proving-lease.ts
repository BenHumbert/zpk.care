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
 * The proving lease — plan item D7, interim remedy for finding A-33.
 *
 * Every proof a device makes commits to the ledger's exact current roots and takes tens of seconds,
 * so any transition that lands in that window invalidates it. With a few active members something
 * lands every half minute, and a device can lose every round: the multi-member run saw one of three
 * concurrent registrations starve after six attempts. The lease hands the witnesses to one prover at
 * a time per partition, first come first served, and holds every other root change — other devices'
 * proofs, the engine's own, the operator's lifecycle mutations — until that prover's transition lands
 * or its lease expires. Nothing is proven in vain and nobody starves. Throughput is one transition per
 * proving time per partition, which is the pilot's number; the structural fix, the split of the state
 * transition into the device's authorization proof and a sequencer-proven tree transition, is D7's
 * second half.
 *
 * Open follow-up (recorded with A-33): a holder that takes the lease and never proves freezes its
 * partition for one lease window at a time. The remedies — authenticated holders only, a registration
 * ticket for the wallet that does not exist yet, one slot per principal, an expiry sized to the
 * measured proving time, a cooldown for a holder that lets a lease lapse, alerting on queue depth —
 * are the lease-hardening item and must be in place before any network a stranger can reach.
 */

export interface LeaseGranted {
  granted: true;
  holder: string;
  /** Epoch ms after which the lease lapses and the next in line may take it. */
  expiresAt: number;
}

export interface LeaseBusy {
  granted: false;
  /** This caller's place in line, 1 = next. */
  position: number;
  /** How long to wait before asking again. */
  retryAfterMs: number;
  /** When the current holder's lease lapses at the latest. */
  expiresAt: number;
}

export type LeaseAnswer = LeaseGranted | LeaseBusy;

export interface LeaseStatus {
  held: boolean;
  queueLength: number;
  /** ms until the current lease lapses; 0 when free */
  expiresInMs: number;
}

export class ProvingLease {
  private holder: string | null = null;
  private expiresAt = 0;
  /** Waiting holders in arrival order, with the time each last asked; a waiter that stops asking is dropped. */
  private readonly queue = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];

  constructor(
    private ttlMs: number = ProvingLease.DEFAULT_TTL_MS,
    private readonly waiterTtlMs: number = ProvingLease.DEFAULT_WAITER_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Long enough for the slowest honest prover on the slowest device the network admits; a DoS window otherwise. */
  static readonly DEFAULT_TTL_MS = 120_000;
  /** A waiter that has not asked again within this time has gone away and no longer holds its place. */
  static readonly DEFAULT_WAITER_TTL_MS = 20_000;

  setTtl(ms: number): void {
    if (!Number.isFinite(ms) || ms < 1_000) throw new Error('ProvingLease: the lease must last at least a second');
    this.ttlMs = ms;
  }

  get ttl(): number { return this.ttlMs; }

  /**
   * Ask for the lease. Granted when it is free (or lapsed) and nobody arrived earlier and is still
   * asking; the current holder asking again keeps it and extends it (a contended retry re-fetches
   * witnesses). Otherwise the caller takes or keeps its place in line.
   */
  acquire(holder: string): LeaseAnswer {
    if (!holder) throw new Error('ProvingLease: a holder is required');
    const now = this.now();
    this.expireIfDue(now);
    this.pruneWaiters(now);
    if (this.holder === holder) {
      this.expiresAt = now + this.ttlMs;
      return { granted: true, holder, expiresAt: this.expiresAt };
    }
    const first = this.queue.keys().next();
    const nextInLine: string | undefined = first.done ? undefined : first.value;
    if (this.holder === null && (nextInLine === undefined || nextInLine === holder)) {
      this.queue.delete(holder);
      this.holder = holder;
      this.expiresAt = now + this.ttlMs;
      return { granted: true, holder, expiresAt: this.expiresAt };
    }
    this.queue.set(holder, now);
    let position = 0;
    for (const k of this.queue.keys()) { position++; if (k === holder) break; }
    const expiresAt = this.holder === null ? now : this.expiresAt;
    const retryAfterMs = Math.min(5_000, Math.max(500, Math.ceil((expiresAt - now) / Math.max(1, position))));
    return { granted: false, position, retryAfterMs, expiresAt };
  }

  /** The holder's transition landed, or it gave up: free the lease for the next in line. */
  release(holder: string): boolean {
    if (this.holder !== holder) return false;
    this.holder = null;
    this.expiresAt = 0;
    this.wake();
    return true;
  }

  /** Whether `holder` holds an unexpired lease right now. */
  isHeldBy(holder: string): boolean {
    this.expireIfDue(this.now());
    return this.holder === holder;
  }

  status(): LeaseStatus {
    const now = this.now();
    this.expireIfDue(now);
    this.pruneWaiters(now);
    return { held: this.holder !== null, queueLength: this.queue.size, expiresInMs: this.holder === null ? 0 : Math.max(0, this.expiresAt - now) };
  }

  /**
   * Wait until no prover holds the lease, for a synchronous root mutation by the operator. Resolves
   * at once when free, when the holder releases, or when its lease lapses; `maxWaitMs` bounds it.
   * The caller must mutate in the same tick, before any other request can be served.
   */
  async waitUntilFree(maxWaitMs: number = this.ttlMs + 1_000): Promise<void> {
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      const now = this.now();
      this.expireIfDue(now);
      if (this.holder === null || now >= deadline) return;
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, this.expiresAt - now)))),
      ]);
    }
  }

  private expireIfDue(now: number): void {
    if (this.holder !== null && now >= this.expiresAt) {
      this.holder = null;
      this.expiresAt = 0;
      this.wake();
    }
  }

  private pruneWaiters(now: number): void {
    for (const [k, lastAsked] of this.queue) {
      if (now - lastAsked > this.waiterTtlMs) this.queue.delete(k);
    }
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}
