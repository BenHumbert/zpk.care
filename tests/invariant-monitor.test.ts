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
 * A fake clock drives the monitor through the states that matter: replicas in step; a replica out
 * of step inside the grace period (reported, not alarmed) and beyond it (alarmed, once in the log);
 * recovery (cleared, once); proofs pending with no batch built beyond the threshold (alarmed); a
 * batch built restarting that clock; and nothing pending clearing it.
 */
import { InvariantMonitor, snapshotOf, type NodeSnapshot } from '../src/l2/invariant-monitor.js';

const snap = (nodeId: string, over: Partial<NodeSnapshot> = {}): NodeSnapshot => ({
  nodeId, registryRoot: 'R1', lifecycleRoot: 'L1', walletCount: '3', proofsAccepted: 5, batchesBuilt: 2, pendingProofs: 0, batchIntervalMs: 10_000, ...over,
});

function harness(initial: { leader: NodeSnapshot; replicas: NodeSnapshot[] }) {
  const state = { ...initial, now: 1_000_000 };
  const log: string[] = [];
  const monitor = new InvariantMonitor({
    leader: () => state.leader,
    replicas: () => state.replicas,
    divergenceGraceMs: 30_000,
    batchStallMs: 60_000,
    log: (line) => log.push(line),
    now: () => state.now,
  });
  return { state, log, monitor, tick: (ms: number) => { state.now += ms; return monitor.assess(); } };
}

describe('replica divergence', () => {
  test('in step: ok, no alarms, nothing logged', () => {
    const h = harness({ leader: snap('leader'), replicas: [snap('replica-1'), snap('replica-2')] });
    const r = h.tick(0);
    expect(r.ok).toBe(true);
    expect(r.replicas.map((x) => x.inSync)).toEqual([true, true]);
    expect(r.alarms).toEqual([]);
    expect(h.log).toEqual([]);
  });

  test('out of step inside the grace period is reported, not alarmed; beyond it, alarmed once; back in step, cleared once', () => {
    const h = harness({ leader: snap('leader'), replicas: [snap('replica-1'), snap('replica-2', { registryRoot: 'R0', proofsAccepted: 4 })] });
    let r = h.tick(0);
    expect(r.ok).toBe(true);
    expect(r.replicas[1]).toMatchObject({ inSync: false, behindBy: 1, divergentForMs: 0 });
    r = h.tick(20_000);
    expect(r.ok).toBe(true);
    expect(r.replicas[1].divergentForMs).toBe(20_000);
    r = h.tick(15_000);
    expect(r.ok).toBe(false);
    expect(r.alarms).toHaveLength(1);
    expect(r.alarms[0]).toMatch(/replica-2 has diverged from the leader for 35 s/);
    h.tick(5_000);
    expect(h.log.filter((l) => l.includes('ALARM'))).toHaveLength(1);
    h.state.replicas[1] = snap('replica-2');
    r = h.tick(5_000);
    expect(r.ok).toBe(true);
    expect(r.replicas[1]).toMatchObject({ inSync: true, divergentForMs: 0 });
    expect(h.log.filter((l) => l.includes('cleared'))).toEqual(['[invariant] cleared: replica-2 is back in step with the leader']);
  });

  test('a lifecycle root that differs is divergence too, and the proof counters are only a hint', () => {
    const h = harness({ leader: snap('leader', { proofsAccepted: 50 }), replicas: [snap('replica-1', { lifecycleRoot: 'L0', proofsAccepted: 50 }), snap('replica-2', { proofsAccepted: 3 })] });
    const r = h.tick(0);
    expect(r.replicas[0].inSync).toBe(false);
    expect(r.replicas[1]).toMatchObject({ inSync: true, behindBy: 47 });
  });
});

describe('batch stall', () => {
  test('proofs pending with no batch built beyond the threshold is an alarm; a batch built restarts the clock; nothing pending clears it', () => {
    const h = harness({ leader: snap('leader', { pendingProofs: 2, batchesBuilt: 2 }), replicas: [] });
    let r = h.tick(0);
    expect(r.batch).toMatchObject({ stalled: false, pendingProofs: 2, pendingForMs: 0, stallAfterMs: 60_000 });
    r = h.tick(61_000);
    expect(r.batch.stalled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.alarms[0]).toMatch(/batch stalled: 2 proof\(s\) pending for 61 s/);
    h.tick(1_000);
    expect(h.log.filter((l) => l.includes('ALARM'))).toHaveLength(1);
    // a batch is built; three proofs arrived meanwhile and are pending again
    h.state.leader = snap('leader', { pendingProofs: 3, batchesBuilt: 3 });
    r = h.tick(1_000);
    expect(r.batch).toMatchObject({ stalled: false, pendingForMs: 0 });
    expect(h.log.filter((l) => l.includes('cleared'))).toEqual(['[invariant] cleared: a batch was built']);
    r = h.tick(30_000);
    expect(r.batch).toMatchObject({ stalled: false, pendingForMs: 30_000 });
    h.state.leader = snap('leader', { pendingProofs: 0, batchesBuilt: 4 });
    r = h.tick(1_000);
    expect(r.batch).toMatchObject({ stalled: false, pendingProofs: 0, pendingForMs: 0 });
    expect(r.ok).toBe(true);
  });

  test('the default threshold is three batch intervals, never under a minute', () => {
    const quick = new InvariantMonitor({ leader: () => snap('l', { batchIntervalMs: 5_000, pendingProofs: 1 }), replicas: () => [], log: () => {} });
    expect(quick.assess().batch.stallAfterMs).toBe(60_000);
    const slow = new InvariantMonitor({ leader: () => snap('l', { batchIntervalMs: 60_000, pendingProofs: 1 }), replicas: () => [], log: () => {} });
    expect(slow.assess().batch.stallAfterMs).toBe(180_000);
  });
});

describe('snapshotOf and report', () => {
  test('reads the status fields the monitor needs, and report() assesses once when nothing ran yet', () => {
    const s = snapshotOf({
      running: true, uptimeMs: 1, pendingProofs: 4, totalProofsAccepted: 9, totalBatchesBuilt: 3, totalBatchesSettled: 3, totalBatchesFailed: 0,
      currentRegistryRoot: 'RR', currentLifecycleRoot: 'LL', currentWalletCount: '7', inFlightBatch: null, nextBatchInMs: 1, batchIntervalMs: 15_000,
      chainProofEnabled: false, globalStateRoot: '0', blockHeight: '0', l2Only: true,
    } as any, 'seq');
    expect(s).toEqual({ nodeId: 'seq', registryRoot: 'RR', lifecycleRoot: 'LL', walletCount: '7', proofsAccepted: 9, batchesBuilt: 3, pendingProofs: 4, batchIntervalMs: 15_000 });
    const m = new InvariantMonitor({ leader: () => s, replicas: () => [{ ...s, nodeId: 'r' }], log: () => {} });
    const r = m.report();
    expect(r.ok).toBe(true);
    expect(r.leader.nodeId).toBe('seq');
    expect(m.report()).toBe(r);
  });
});
