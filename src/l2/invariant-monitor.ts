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
 * The invariant monitor — plan item A13, findings A-8 and C-3.
 *
 * Two things must hold on a running network, and for 29 hours neither did without anyone being
 * told: every replica's roots equal the leader's once gossip has had a moment to land, and a
 * leader with proofs pending builds a batch within its interval. The monitor reads the leader and
 * its replicas (in this process, no RPC), decides, remembers since when a replica has been out of
 * step or a batch overdue, and raises an alarm once the grace period is spent. It logs on
 * transitions only, and its last report rides on `l2_getStatus` as `invariants`, so the harness
 * and an operator can read it.
 *
 * The roots are the invariant; the proof counters are reported as a hint, because a leader
 * restored from a checkpoint keeps its lifetime count while an in-memory replica starts again.
 */
import type { L2NodeStatus } from './l2-node.js';

/** What the monitor reads from a node, once per tick. */
export interface NodeSnapshot {
  nodeId: string;
  registryRoot: string;
  lifecycleRoot: string;
  walletCount: string;
  proofsAccepted: number;
  batchesBuilt: number;
  pendingProofs: number;
  batchIntervalMs: number;
}

export interface ReplicaState {
  nodeId: string;
  /** Both roots equal the leader's. */
  inSync: boolean;
  /** Leader's accepted proofs minus the replica's, never negative; a hint, not the invariant. */
  behindBy: number;
  /** How long the replica has been out of step; 0 when in sync. */
  divergentForMs: number;
}

export interface InvariantReport {
  /** No alarm is raised. */
  ok: boolean;
  checkedAt: number;
  leader: { nodeId: string; registryRoot: string; lifecycleRoot: string; proofsAccepted: number; batchesBuilt: number; pendingProofs: number };
  replicas: ReplicaState[];
  batch: { stalled: boolean; pendingProofs: number; pendingForMs: number; stallAfterMs: number };
  alarms: string[];
  divergenceGraceMs: number;
}

export interface InvariantMonitorOptions {
  leader: () => NodeSnapshot;
  replicas: () => NodeSnapshot[];
  /** How long a replica may lag before its divergence is an alarm. Default 30 s. */
  divergenceGraceMs?: number;
  /** How long proofs may sit pending with no batch built before that is an alarm. Default 3 batch intervals, at least 60 s. */
  batchStallMs?: number;
  /** Where transition lines go. Default: console.log. */
  log?: (line: string) => void;
  /** The clock; tests supply their own. */
  now?: () => number;
}

/** The monitor's view of a node, from its status. */
export function snapshotOf(status: L2NodeStatus, nodeId: string): NodeSnapshot {
  return {
    nodeId,
    registryRoot: status.currentRegistryRoot,
    lifecycleRoot: status.currentLifecycleRoot,
    walletCount: status.currentWalletCount,
    proofsAccepted: status.totalProofsAccepted,
    batchesBuilt: status.totalBatchesBuilt,
    pendingProofs: status.pendingProofs,
    batchIntervalMs: status.batchIntervalMs,
  };
}

const short = (root: string) => (root.length > 10 ? `${root.slice(0, 10)}…` : root);
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

export class InvariantMonitor {
  private readonly leader: () => NodeSnapshot;
  private readonly replicas: () => NodeSnapshot[];
  private readonly divergenceGraceMs: number;
  private readonly batchStallMs: number | undefined;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  /** When each replica was first seen out of step; absent while in sync. */
  private divergentSince = new Map<string, number>();
  /** When the current run of pending proofs began with no batch built since. */
  private pendingSince: number | null = null;
  private lastBatchesBuilt: number | null = null;
  /** The alarms raised at the previous tick, to log transitions only. */
  private raised = new Set<string>();
  private last: InvariantReport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: InvariantMonitorOptions) {
    this.leader = opts.leader;
    this.replicas = opts.replicas;
    this.divergenceGraceMs = opts.divergenceGraceMs ?? 30_000;
    this.batchStallMs = opts.batchStallMs;
    this.log = opts.log ?? ((line) => console.log(line));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Evaluate once: update the timers, decide the alarms, log what changed, return the report. */
  assess(): InvariantReport {
    const now = this.now();
    const leader = this.leader();
    const alarms: string[] = [];
    const keyed = new Map<string, string>();

    const replicas: ReplicaState[] = this.replicas().map((r) => {
      const inSync = r.registryRoot === leader.registryRoot && r.lifecycleRoot === leader.lifecycleRoot;
      let divergentForMs = 0;
      if (inSync) {
        this.divergentSince.delete(r.nodeId);
      } else {
        const since = this.divergentSince.get(r.nodeId) ?? now;
        this.divergentSince.set(r.nodeId, since);
        divergentForMs = now - since;
        if (divergentForMs > this.divergenceGraceMs) {
          keyed.set(`diverged:${r.nodeId}`,
            `${r.nodeId} has diverged from the leader for ${seconds(divergentForMs)} (registry root ${short(r.registryRoot)} vs ${short(leader.registryRoot)}; ${r.proofsAccepted} of ${leader.proofsAccepted} proofs applied)`);
        }
      }
      return { nodeId: r.nodeId, inSync, behindBy: Math.max(0, leader.proofsAccepted - r.proofsAccepted), divergentForMs };
    });

    // A batch is overdue when proofs have been pending, and no batch has been built, for longer than
    // the stall threshold. A batch built restarts the clock for whatever is pending after it.
    const stallAfterMs = this.batchStallMs ?? Math.max(60_000, leader.batchIntervalMs * 3);
    if (leader.pendingProofs === 0) {
      this.pendingSince = null;
    } else if (this.lastBatchesBuilt !== null && leader.batchesBuilt !== this.lastBatchesBuilt) {
      this.pendingSince = now;
    } else if (this.pendingSince === null) {
      this.pendingSince = now;
    }
    this.lastBatchesBuilt = leader.batchesBuilt;
    const pendingForMs = this.pendingSince === null ? 0 : now - this.pendingSince;
    const stalled = this.pendingSince !== null && pendingForMs > stallAfterMs;
    if (stalled) {
      keyed.set('batch-stalled', `batch stalled: ${leader.pendingProofs} proof(s) pending for ${seconds(pendingForMs)} with no batch built (threshold ${seconds(stallAfterMs)})`);
    }

    // Transitions, once each
    for (const [key, text] of keyed) {
      alarms.push(text);
      if (!this.raised.has(key)) this.log(`[invariant] ALARM ${text}`);
    }
    for (const key of this.raised) {
      if (!keyed.has(key)) this.log(`[invariant] cleared: ${key.startsWith('diverged:') ? `${key.slice('diverged:'.length)} is back in step with the leader` : 'a batch was built'}`);
    }
    this.raised = new Set(keyed.keys());

    this.last = {
      ok: alarms.length === 0,
      checkedAt: now,
      leader: { nodeId: leader.nodeId, registryRoot: leader.registryRoot, lifecycleRoot: leader.lifecycleRoot, proofsAccepted: leader.proofsAccepted, batchesBuilt: leader.batchesBuilt, pendingProofs: leader.pendingProofs },
      replicas,
      batch: { stalled, pendingProofs: leader.pendingProofs, pendingForMs, stallAfterMs },
      alarms,
      divergenceGraceMs: this.divergenceGraceMs,
    };
    return this.last;
  }

  /** The last report, assessing first if there is none yet. */
  report(): InvariantReport {
    return this.last ?? this.assess();
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.assess();
    this.timer = setInterval(() => {
      try {
        this.assess();
      } catch (err) {
        this.log(`[invariant] monitor error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
