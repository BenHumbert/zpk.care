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
 * A provider the engine does not know is refused, never treated as seed provider 0.
 *
 * What was wrong: the pharmacy node turned an unknown pharmacy wallet (resolve-indices answering -1, or the resolve
 * call failing) into pharmacy index 0, sent a missing prescriber as wallet '0', and read pharmacy 0's queue for every
 * pharmacy; the prescriber node fell back to indices 0/0 when the resolve failed, and resolved only after the eScript
 * had gone out; the engine's prescribe-and-fill defaulted a missing or unknown prescriber and pharmacy to 0, and
 * prescriptions-by-pharmacy read pharmacy 0 when no index was given. So a pharmacy without a seed filled claims as
 * pharmacy 0. Now each refuses: 409 for a provider the engine has no index for, 400 for a missing or unknown index,
 * 502 when the engine cannot be asked, and the nodes resolve before anything is sent.
 *
 * Part 1: the engine's routes on a real sequencer server with a stand-in engine. Part 2: the provider nodes' route
 * handlers called directly with a fake node server. No compile, no proof, no real network beyond the local server.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';
import { buildPrescriberRoutes } from '../src/nodes/routes/prescriber-routes.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();

/** Let fire-and-forget jobs run to their first network call and past it. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('the engine\'s routes', () => {
  let server: L2RpcServer;
  let url: string;
  const created: Array<Record<string, unknown>> = [];

  /** Seed prescriber 0 is wallet 700 and seed pharmacy 0 is wallet 500; no other index exists. Everything else is a no-op. */
  function standIn() {
    const svc = {
      getState() { return { compiled: true, enrolledMembers: [] }; },
      isProvingReady() { return true; }, // a proving route refuses with 503 while the engine's provers start
      getPrescriberWalletId(i: number) { return i === 0 ? Field(700) : undefined; },
      getPharmacyWalletId(i: number) { return i === 0 ? Field(500) : undefined; },
      getL2Node() { return { withProvingLock: (fn: () => Promise<unknown>) => Promise.resolve().then(fn) }; },
      async createPrescription(o: Record<string, unknown>) { created.push(o); return { prescriptionId: 'RX-T' }; },
      async dispensePrescription() { return {}; },
      async forceBatch() {},
    };
    return new Proxy(svc, { get(t, p) { if (p in t) return (t as any)[p]; return typeof p === 'string' && p !== 'then' ? () => undefined : undefined; } });
  }

  async function post(p: string, body: unknown) {
    const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, text, json };
  }

  beforeAll(async () => {
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-provider-index' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    registerInteractiveRoutes(server, standIn() as any);
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;
  });

  afterAll(async () => { await server.stop(); });

  beforeEach(() => { created.length = 0; });

  test('prescribe-and-fill refuses a prescriber wallet the engine does not know', async () => {
    const r = await post('/interactive/prescribe-and-fill', { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '999', pharmacyIndex: 0 });
    await settle();
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/not a provider/);
    expect(created).toEqual([]);
  });

  test('prescribe-and-fill refuses a missing or unknown pharmacy index', async () => {
    for (const body of [
      { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '700' },
      { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '700', pharmacyIndex: 7 },
    ]) {
      const r = await post('/interactive/prescribe-and-fill', body);
      await settle();
      expect(r.status).toBe(400);
    }
    expect(created).toEqual([]);
  });

  test('prescribe-and-fill still takes a seeded prescriber and pharmacy', async () => {
    const r = await post('/interactive/prescribe-and-fill', { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '700', pharmacyIndex: 0 });
    await settle();
    expect(r.status).toBe(202);
    expect(created[created.length - 1]).toMatchObject({ prescriberIndex: 0, pharmacyIndex: 0 });
  });

  test('resolve-indices answers -1 for an unknown wallet and the seed index for a known one', async () => {
    const unknown = await post('/interactive/resolve-indices', { prescriberWalletId: '999', pharmacyWalletId: '999' });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toEqual({ prescriberIndex: -1, pharmacyIndex: -1 });
    const known = await post('/interactive/resolve-indices', { prescriberWalletId: '700', pharmacyWalletId: '500' });
    expect(known.status).toBe(200);
    expect(known.json).toEqual({ prescriberIndex: 0, pharmacyIndex: 0 });
  });

  test('prescriptions-by-pharmacy refuses a request that names no pharmacy', async () => {
    const r = await fetch(`${url}/interactive/prescriptions-by-pharmacy`, { headers: { Authorization: `Bearer ${OPERATOR}` } });
    expect(r.status).toBe(400);
  });
});

describe('the provider nodes\' routes', () => {
  type Answer = { status: number; body: unknown };

  /** A node server reduced to what these handlers use. Only resolve-indices answers; every other engine call is a 500. */
  function fakeNodeServer(walletId: string | null, resolveAnswer: Answer) {
    const calls: Array<{ url: string; body: any }> = [];
    const sent: Array<{ status: number; ok: boolean; data: unknown; error?: string }> = [];
    const storeMessage = jest.fn();
    const server = {
      getEntityNode: () => ({ getWalletId: () => walletId, storeMessage }),
      getConfig: () => ({ sequencerUrl: 'http://seq.test' }),
      getLocalState: () => ({ hasEnrollmentKey: () => false }),
      signedFetch(u: string, init?: { body?: string }) {
        calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
        if (u.endsWith('/interactive/resolve-indices')) {
          return Promise.resolve(new Response(JSON.stringify(resolveAnswer.body), { status: resolveAnswer.status }));
        }
        // a job the old code started fails at once on this answer and never polls
        return Promise.resolve(new Response(JSON.stringify({ error: 'stub engine' }), { status: 500 }));
      },
      sendResponse(_res: unknown, status: number, ok: boolean, data?: unknown, error?: string) { sent.push({ status, ok, data, error }); },
    };
    return { server, calls, sent, storeMessage };
  }

  async function call(routes: Array<{ method: string; path: string; handler: Function }>, method: string, path: string, body?: unknown) {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`no route ${method} ${path}`);
    await route.handler({}, {}, {}, new URLSearchParams(), body);
    await settle();
  }

  const pharmacy = (walletId: string, resolveAnswer: Answer) => {
    const fake = fakeNodeServer(walletId, resolveAnswer);
    return { ...fake, routes: buildPharmacyRoutes(fake.server as any) };
  };
  const callsTo = (calls: Array<{ url: string }>, suffix: string) => calls.filter((c) => c.url.split('?')[0].endsWith(suffix));

  test('an unseeded pharmacy\'s fill is refused, not filled as pharmacy 0', async () => {
    const p = pharmacy('999', { status: 200, body: { prescriberIndex: 0, pharmacyIndex: -1 } });
    await call(p.routes, 'POST', '/dispensing/fill', { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '700' });
    expect(p.sent[0]?.status).toBe(409);
    expect(p.sent[0]?.error).toMatch(/not a provider the engine can adjudicate for/);
    expect(callsTo(p.calls, '/interactive/prescribe-and-fill')).toHaveLength(0);
  });

  test('a fill whose providers cannot be resolved is refused with 502', async () => {
    const p = pharmacy('999', { status: 500, body: {} });
    await call(p.routes, 'POST', '/dispensing/fill', { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '700' });
    expect(p.sent[0]?.status).toBe(502);
    expect(callsTo(p.calls, '/interactive/prescribe-and-fill')).toHaveLength(0);
  });

  test('a fill that names no prescriber is refused before anything is sent', async () => {
    const p = pharmacy('999', { status: 200, body: { prescriberIndex: 0, pharmacyIndex: 2 } });
    await call(p.routes, 'POST', '/dispensing/fill', { memberWalletId: '1', ndcHash: '1' });
    expect(p.sent[0]?.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  test('a seeded pharmacy\'s fill goes out with its own index and the named prescriber', async () => {
    const p = pharmacy('5002', { status: 200, body: { prescriberIndex: 0, pharmacyIndex: 2 } });
    await call(p.routes, 'POST', '/dispensing/fill', { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '700' });
    expect(p.sent[0]?.status).toBe(202);
    const sentToEngine = callsTo(p.calls, '/interactive/prescribe-and-fill');
    expect(sentToEngine).toHaveLength(1);
    expect(sentToEngine[0].body).toMatchObject({ pharmacyIndex: 2, prescriberWalletId: '700' });
  });

  test('the prescription list is this pharmacy\'s own queue, and an unseeded pharmacy has none', async () => {
    const unseeded = pharmacy('999', { status: 200, body: { prescriberIndex: -1, pharmacyIndex: -1 } });
    await call(unseeded.routes, 'GET', '/prescriptions/list');
    expect(unseeded.sent[0]?.status).toBe(409);
    expect(callsTo(unseeded.calls, '/interactive/prescriptions-by-pharmacy')).toHaveLength(0);
    const seeded = pharmacy('5002', { status: 200, body: { prescriberIndex: -1, pharmacyIndex: 2 } });
    await call(seeded.routes, 'GET', '/prescriptions/list');
    const listed = callsTo(seeded.calls, '/interactive/prescriptions-by-pharmacy');
    expect(listed).toHaveLength(1);
    expect(listed[0].url).toContain('pharmacyIndex=2');
  });

  test('an unseeded prescriber is refused before any eScript goes out', async () => {
    const fake = fakeNodeServer('999', { status: 200, body: { prescriberIndex: -1, pharmacyIndex: 0 } });
    // the builder starts a PCP sync interval and timeout; fake timers keep them from holding the process open
    jest.useFakeTimers();
    let routes: ReturnType<typeof buildPrescriberRoutes>;
    try {
      routes = buildPrescriberRoutes(fake.server as any);
    } finally {
      jest.useRealTimers();
    }
    await call(routes, 'POST', '/prescriptions/prescribe', { memberWalletId: '1', pharmacyWalletId: '500', ndcHash: '1' });
    expect(fake.sent[0]?.status).toBe(409);
    expect(fake.storeMessage).not.toHaveBeenCalled();
    expect(callsTo(fake.calls, '/interactive/prescribe')).toHaveLength(0);
  });
});
