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
 * The proving lease — plan item D7's interim remedy for A-33: one prover at a time per partition,
 * first come first served, so concurrent devices queue instead of proving against roots that move.
 *
 * The lease itself: granted when free, kept and extended by its holder, queued in arrival order,
 * lapsed on expiry, released on landing; a waiter that stops asking loses its place. On the
 * sequencer: the witnesses answer only the holder, a landed proof releases, an operator mutation
 * waits for a free lease. Over the RPC: a second holder is told its place and when to ask again.
 */
import { Field, MerkleTree } from 'o1js';
import { ProvingLease } from '../src/l2/proving-lease.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';

jest.setTimeout(60_000);

describe('the lease', () => {
  let t = 1_000_000;
  const clock = () => t;

  test('is granted when free, kept and extended by its holder, and queues everyone else in arrival order', () => {
    const lease = new ProvingLease(10_000, 20_000, clock);
    const a = lease.acquire('A');
    expect(a.granted).toBe(true);
    const b = lease.acquire('B');
    const c = lease.acquire('C');
    expect(b).toMatchObject({ granted: false, position: 1 });
    expect(c).toMatchObject({ granted: false, position: 2 });
    t += 3_000;
    const again = lease.acquire('A');                       // a contended retry re-fetches: still A's, extended
    expect(again.granted).toBe(true);
    expect((again as { expiresAt: number }).expiresAt).toBe(t + 10_000);
    expect(lease.status()).toEqual({ held: true, queueLength: 2, expiresInMs: 10_000 });
  });

  test('a landed transition releases it to the next in line, and only to the next in line', () => {
    const lease = new ProvingLease(10_000, 20_000, clock);
    lease.acquire('A'); lease.acquire('B'); lease.acquire('C');
    expect(lease.release('C')).toBe(false);                 // not C's to release
    expect(lease.release('A')).toBe(true);
    expect(lease.acquire('C').granted).toBe(false);         // B arrived first
    expect(lease.acquire('B').granted).toBe(true);
    expect(lease.acquire('C')).toMatchObject({ granted: false, position: 1 });
  });

  test('lapses on expiry, and a waiter that stopped asking loses its place', () => {
    const lease = new ProvingLease(10_000, 5_000, clock);
    lease.acquire('A'); lease.acquire('B');
    t += 10_000;                                            // A's lease lapsed; B asked 10 s ago, past the waiter window
    expect(lease.isHeldBy('A')).toBe(false);
    expect(lease.acquire('C').granted).toBe(true);          // B's place is gone; C takes it
  });

  test('waitUntilFree resolves at once when free, on release, and on expiry, and never past its bound', async () => {
    const lease = new ProvingLease(2_000, 20_000, clock);
    await lease.waitUntilFree(100);                         // free: immediate
    lease.acquire('A');
    let released = false;
    const p = lease.waitUntilFree(5_000).then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(released).toBe(false);
    lease.release('A');
    await p;
    expect(released).toBe(true);
    lease.acquire('B');
    t += 2_000;                                             // B's lease lapses: the wait ends at once
    await lease.waitUntilFree(5_000);
    expect(lease.status().held).toBe(false);
    const real = new ProvingLease(60_000);                  // the real clock: a holder that never releases, and the bound ends the wait
    real.acquire('C');
    const start = Date.now();
    await real.waitUntilFree(300);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(real.status().held).toBe(true);
  });
});

describe('the sequencer', () => {
  const R = [Field(1000), Field(1001), Field(1002)];
  const LC = Field(2000);
  const proof = (walletId: Field, oldRoot: Field, newRoot: Field) => ({ verify: () => {}, publicOutput: { walletId, oldRegistryRoot: oldRoot, newRegistryRoot: newRoot, oldLifecycleRoot: LC, newLifecycleRoot: LC }, toJSON: () => ({}) } as any);

  test('hands the witnesses to one holder, releases on the landed proof, and makes an operator mutation wait', async () => {
    const seq = new L2SequencerService(new InMemoryStore(), R[0], LC, Field(0));
    seq.setTransitionVerifier(createAcceptAllVerifierForTests('tests/proving-lease.test.ts'));
    seq.setProvingLeaseMs(5_000);
    expect(seq.acquireProvingLease('100').granted).toBe(true);
    expect(seq.acquireProvingLease('200')).toMatchObject({ granted: false, position: 1 });
    let mutated = false;
    const mutation = seq.withRootsSettled(() => { mutated = true; return 'done'; });
    await new Promise((r) => setTimeout(r, 30));
    expect(mutated).toBe(false);                            // the operator waits for the prover
    await seq.submitProof(proof(Field(100), R[0], R[1]));   // 100's proof lands: released
    expect(await mutation).toBe('done');
    expect(seq.provingLeaseStatus().held).toBe(false);
    expect(seq.acquireProvingLease('200').granted).toBe(true);
  });

  test('acquireProvingLeaseWaiting queues until the lease is free', async () => {
    const seq = new L2SequencerService(new InMemoryStore(), R[0], LC, Field(0));
    seq.setProvingLeaseMs(5_000);
    seq.acquireProvingLease('100');
    let got = false;
    const waiting = seq.acquireProvingLeaseWaiting('200', 5_000, 20).then(() => { got = true; });
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toBe(false);
    seq.releaseProvingLease('100');
    await waiting;
    expect(got).toBe(true);
    expect(seq.provingLeaseStatus()).toMatchObject({ held: true, queueLength: 0 });
  });
});

describe('over the RPC', () => {
  const OPERATOR = 'operator-token-for-tests';
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  let server: L2RpcServer; let url: string;
  const rpc = async (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()) as { result?: any; error?: { message: string } };
  };
  beforeAll(async () => {
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-lease' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;
  });
  afterAll(async () => { await server.stop(); });

  test('registration witnesses answer the holder, tell the next one its place, and answer a caller that names no holder as before', async () => {
    const plain = await rpc('l2_getRegistrationWitnesses', {});
    expect(plain.result?.registryWitnessJson).toBeDefined();
    expect(plain.result?.lease).toBeUndefined();
    const first = await rpc('l2_getRegistrationWitnesses', { holder: '7001' });
    expect(first.result?.lease?.granted).toBe(true);
    expect(first.result?.registryWitnessJson).toBeDefined();
    const second = await rpc('l2_getRegistrationWitnesses', { holder: '7002' });
    expect(second.result?.busy).toBe(true);
    expect(second.result?.position).toBe(1);
    expect(second.result?.registryWitnessJson).toBeUndefined();
    const status = await rpc('l2_getProvingLease', {});
    expect(status.result).toMatchObject({ held: true, queueLength: 1 });
    expect(JSON.stringify(status.result)).not.toContain('7001');   // no holder id in the open status
  });
});
