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
 * Publishing a plan commits to its formulary (plan-bound formularies).
 *
 * What was wrong: publishing stored the overlay version number ('1') as the plan's formularyRoot and a provider count
 * as its networkRoot; the plan's NDC list was ignored; the overlay's tier copays were the plan copay times 1, 3.5, 7.5
 * and 15, with '|| 1000' turning a $0 copay into $10; and an edit could set the roots and the published flag.
 *
 * Now publishing builds the plan's formulary from its copay and NDC list (buildPlanFormulary, the engine's own
 * function) and stores its root, the real network root and the published terms; the overlay charges the plan copay at
 * every tier; create refuses a malformed copay or NDC list; a plan that covers nothing is not published; an edit sets
 * none of the roots, the published flag or the published terms; and the sequencer refuses a malformed plan itself.
 *
 * The insurer's routes over a real sequencer RPC server, the insurer node signing as itself. The formulary is cut to
 * 100 drugs before anything loads src/data.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(180_000);

const OPERATOR = 'operator-token-for-plan-publish';
let rpcServer: any;
let seq: any;
let seqUrl: string;
let routes: any[];
let catalog: any[];
let buildPlanFormulary: any;
let ndcA: string;
let ndcB: string;
const tempDirs: string[] = [];

interface Captured { status: number; payload: any }
function fakeRes(): { res: unknown; captured: () => Captured } {
  let status = 0;
  let payload: any = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(body?: string) { if (body) { try { payload = JSON.parse(body); } catch { payload = { raw: body }; } } return this; },
    get writableEnded() { return status !== 0; },
  };
  return { res, captured: () => ({ status, payload }) };
}
function find(method: string, p: string): any {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route not registered: ${method} ${p}`);
  return r;
}
async function call(method: string, p: string, args: { params?: Record<string, string>; body?: unknown } = {}): Promise<Captured> {
  const { res, captured } = fakeRes();
  await find(method, p).handler({ url: p, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, args.params ?? {}, new URLSearchParams(), args.body);
  return captured();
}
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${seqUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
const rootOf = (copayAmountCents: number, formularyNdcs: string[]) => buildPlanFormulary({ copayAmountCents, formularyNdcs }, catalog).root.toString();
const planBody = (over: Record<string, unknown>) => ({ planId: 'PLAN-PUB-X', name: 'Published', copayAmountCents: 1500, formularyNdcs: [ndcA], ...over });

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
  const { InsurerNode } = await import('../src/nodes/insurer-node.js');
  const { buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js');
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  catalog = getAllFormularyEntries();
  ndcA = catalog[3].ndc;
  ndcB = catalog[7].ndc;

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-plan-publish' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  const insurerKey = generateNodeKey('insurer-node');
  rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  rpcServer.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
  await rpcServer.start();
  seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-publish-'));
  tempDirs.push(dir);
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: 'admin-token-for-tests', nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
  } as any);
  server.setEntityNode(new InsurerNode({ role: 'insurer', sequencerUrl: seqUrl, displayName: 'Insurer', clientOptions: server.sequencerClientOptions() } as any));
  routes = buildInsurerRoutes(server);
});

afterAll(async () => {
  await rpcServer?.stop();
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('publishing a plan commits to its formulary', () => {
  test('publishing writes the root the engine rebuilds, not the overlay version, and the published terms', async () => {
    const dashed = `${ndcA.slice(0, 5)}-${ndcA.slice(5, 9)}-${ndcA.slice(9)}`;
    const created = await call('POST', '/plans', { body: planBody({ planId: 'PLAN-PUB-1', formularyNdcs: [dashed, ndcB, '99999999999'] }) });
    expect(created.status).toBe(201);
    expect(created.payload.data.publishError).toBeUndefined();
    expect(created.payload.data.published).toBe(true);
    const root = rootOf(1500, [ndcA, ndcB]);
    expect(created.payload.data.formularyRoot).toBe(root);
    expect(root).not.toBe('1');
    const stored = seq.getPlan('PLAN-PUB-1');
    expect(stored.formularyRoot).toBe(root);
    expect(stored.networkRoot).toBe('0');
    expect(stored.publishedTerms).toMatchObject({ copayAmountCents: 1500, formularyNdcs: [dashed, ndcB, '99999999999'], formularyRoot: root, networkRoot: '0' });
    expect(seq.getFormularyService().getOverlay('PLAN-PUB-1').defaults).toEqual({ tier1Copay: 1500, tier2Copay: 1500, tier3Copay: 1500, tier4Copay: 1500 });

    const republished = await call('POST', '/plans/:planId/publish', { params: { planId: 'PLAN-PUB-1' } });
    expect(republished.status).toBe(200);
    expect(republished.payload.data).toMatchObject({ published: true, formularyRoot: root, formularyEntryCount: 2, unknownNdcs: ['99999999999'], networkRoot: '0' });
  });

  test('a $0 copay stays $0, at every tier and in every entry', async () => {
    const created = await call('POST', '/plans', { body: planBody({ planId: 'PLAN-PUB-ZERO', copayAmountCents: 0 }) });
    expect(created.status).toBe(201);
    expect(created.payload.data.formularyRoot).toBe(rootOf(0, [ndcA]));
    expect(seq.getFormularyService().getOverlay('PLAN-PUB-ZERO').defaults).toEqual({ tier1Copay: 0, tier2Copay: 0, tier3Copay: 0, tier4Copay: 0 });
  });

  test('a provider network is published as its Merkle root, not a count', async () => {
    const { planNetworkRoot } = await import('../src/onboarding/plan-formulary.js');
    const created = await call('POST', '/plans', { body: planBody({ planId: 'PLAN-PUB-NET', networkProviderWalletIds: ['11', '12'] }) });
    expect(created.status).toBe(201);
    expect(created.payload.data.networkRoot).toBe(planNetworkRoot(['11', '12']).toString());
    expect(created.payload.data.networkRoot).not.toBe('2');
  });

  test('create refuses a copay or an NDC list it cannot bind, and stores nothing', async () => {
    const bad: Array<Record<string, unknown>> = [{ copayAmountCents: -1 }, { copayAmountCents: 10.5 }, { copayAmountCents: '1500' }, { formularyNdcs: [1, 2] }];
    for (const [i, over] of bad.entries()) {
      const r = await call('POST', '/plans', { body: planBody({ planId: `PLAN-PUB-BAD-${i}`, ...over }) });
      expect([JSON.stringify(over), r.status]).toEqual([JSON.stringify(over), 400]);
      expect(seq.getPlan(`PLAN-PUB-BAD-${i}`)).toBeNull();
    }
  });

  test('a plan that covers nothing is not published', async () => {
    const created = await call('POST', '/plans', { body: planBody({ planId: 'PLAN-PUB-NONE', formularyNdcs: ['99999999999'] }) });
    expect(created.status).toBe(201);
    expect(created.payload.data.published).toBe(false);
    expect(created.payload.data.publishError).toMatch(/None of the plan's 1 NDCs/);
    const r = await call('POST', '/plans/:planId/publish', { params: { planId: 'PLAN-PUB-NONE' } });
    expect(r.status).toBe(502);
    expect(r.payload.error).toMatch(/None of the plan's 1 NDCs/);
    const stored = seq.getPlan('PLAN-PUB-NONE');
    expect(stored.published).toBe(false);
    expect(stored.publishedTerms).toBeUndefined();
  });

  test('an edit cannot set the roots, the published flag or the published terms; the plan is a draft until republished', async () => {
    const before = seq.getPlan('PLAN-PUB-1');
    const r = await call('PUT', '/plans/:planId', {
      params: { planId: 'PLAN-PUB-1' },
      body: { copayAmountCents: 2000, formularyRoot: '123', networkRoot: '9', published: true, publishedTerms: { ...before.publishedTerms, copayAmountCents: 1 } },
    });
    expect(r.status).toBe(200);
    const stored = seq.getPlan('PLAN-PUB-1');
    expect(stored.published).toBe(false);
    expect(stored.copayAmountCents).toBe(2000);
    expect(stored.formularyRoot).toBe(before.formularyRoot);
    expect(stored.networkRoot).toBe(before.networkRoot);
    expect(stored.publishedTerms).toEqual(before.publishedTerms);
    // publishing again binds the edit: new copay, new root, new terms
    const republished = await call('POST', '/plans/:planId/publish', { params: { planId: 'PLAN-PUB-1' } });
    expect(republished.status).toBe(200);
    const after = seq.getPlan('PLAN-PUB-1');
    expect(after.published).toBe(true);
    expect(after.publishedTerms.copayAmountCents).toBe(2000);
    expect(after.formularyRoot).toBe(rootOf(2000, [ndcA, ndcB]));
  });

  test('the sequencer itself refuses a malformed plan sent straight to l2_storePlan', async () => {
    const r = await rpc('l2_storePlan', { plan: { planId: 'PLAN-RPC-BAD', name: 'x', copayAmountCents: -5 } });
    expect(r.error?.message).toMatch(/copayAmountCents/);
    expect(seq.getPlan('PLAN-RPC-BAD')).toBeNull();
    const t = await rpc('l2_storePlan', { plan: { planId: 'PLAN-RPC-BAD', name: 'x', publishedTerms: { copayAmountCents: 1500 } } });
    expect(t.error?.message).toMatch(/publishedTerms/);
  });
});
