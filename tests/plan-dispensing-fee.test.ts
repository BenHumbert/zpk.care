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
 * The dispensing fee is the plan's (owner decision 2026-10-18), checked where it is set and charged where it is quoted.
 *
 * What was wrong: three fees disagreed (the engine's $2.00, the estimate's $3.00, the dashboard's $13.00) and no plan
 * had one; the estimate took the fee from its caller and rounded NADAC x quantity as a float.
 *
 * Now a plan carries dispensingFeeCents (absent or null: the $10.00 network default). The insurer's POST and PUT
 * /plans and the sequencer's l2_storePlan refuse anything but whole cents from 0 to 10,000; l2_getPlanLimits reports
 * the fee a fill is charged and where it came from; and l2_estimateCost prices with the fill's own code, ignoring any
 * fee its caller sends, at the fee the plan was published with.
 *
 * The insurer's routes with no sequencer behind them (a refusal must come first), and a real sequencer RPC server with
 * the formulary service loaded from the 100-drug catalog, as the Leviathan loads it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(180_000);

const OPERATOR = 'operator-token-for-dispensing-fee';
const ABACAVIR = '00378410591';
let rpcServer: any;
let seq: any;
let url: string;
let insurerRoutes: any[];
let publishedTermsFrom: any;
let hashString: (s: string) => Field;
const tempDirs: string[] = [];

interface Captured { status: number; payload: any }
async function callRoute(method: string, p: string, args: { params?: Record<string, string>; body?: unknown } = {}): Promise<Captured> {
  const route = insurerRoutes.find((r) => r.method === method && r.path === p);
  if (!route) throw new Error(`route not registered: ${method} ${p}`);
  let status = 0;
  let payload: any = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(body?: string) { if (body) { try { payload = JSON.parse(body); } catch { payload = { raw: body }; } } return this; },
    get writableEnded() { return status !== 0; },
  };
  await route.handler({ url: p, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, args.params ?? {}, new URLSearchParams(), args.body);
  return { status, payload };
}
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
const planOf = (planId: string, over: Record<string, unknown> = {}) => ({
  planId, name: planId, coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000, annualBenefitMaxCents: 0,
  familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, formularyNdcs: [], networkProviderWalletIds: [],
  published: false, createdAt: 0, updatedAt: 0, ...over,
});

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
  const { InsurerNode } = await import('../src/nodes/insurer-node.js');
  const { buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js');
  const { formularyRaw } = await import('../src/data/formulary-loader.js');
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-dispensing-fee' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  seq.getFormularyService().loadFromNadac(formularyRaw);
  rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  await rpcServer.start();
  url = `http://127.0.0.1:${rpcServer.getPort()}`;

  // The insurer's routes over a sequencer that is not there: a refusal must happen before any call to it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispensing-fee-'));
  tempDirs.push(dir);
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir, enableSSE: false,
    maxSseConnections: 0, allowedOrigins: [], adminToken: 'admin-token-for-tests',
  } as any);
  server.setEntityNode(new InsurerNode({ role: 'insurer', sequencerUrl: 'http://127.0.0.1:1', displayName: 'Insurer' } as any));
  insurerRoutes = buildInsurerRoutes(server);
});

afterAll(async () => {
  await rpcServer?.stop();
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('the insurer routes', () => {
  test('POST /plans refuses a fee that is not whole cents from 0 to 10,000, before any sequencer call', async () => {
    for (const fee of [-1, 12.5, '1250', 10001]) {
      const r = await callRoute('POST', '/plans', { body: { planId: 'P1', name: 'N', dispensingFeeCents: fee } });
      expect([fee, r.status]).toEqual([fee, 400]);
      expect(r.payload.error).toMatch(/dispensingFeeCents must be whole cents/);
    }
  });

  test('PUT /plans/:planId refuses one too', async () => {
    const r = await callRoute('PUT', '/plans/:planId', { params: { planId: 'P1' }, body: { dispensingFeeCents: 'x' } });
    expect(r.status).toBe(400);
    expect(r.payload.error).toMatch(/dispensingFeeCents must be whole cents/);
  });
});

describe('the sequencer', () => {
  test('l2_storePlan refuses a bad fee, in the plan or in its published terms, and stores a good one, 0 included', async () => {
    for (const fee of [-5, 12.5]) {
      const r = await rpc('l2_storePlan', { plan: planOf('P-BAD', { dispensingFeeCents: fee }) });
      expect(r.error?.message).toMatch(/dispensingFeeCents must be whole cents/);
    }
    const terms = { ...publishedTermsFrom(planOf('P-BAD'), '123', '0', 1), dispensingFeeCents: 10001 };
    const t = await rpc('l2_storePlan', { plan: planOf('P-BAD', { publishedTerms: terms }) });
    expect(t.error?.message).toMatch(/publishedTerms.dispensingFeeCents must be whole cents/);
    expect(seq.getPlan('P-BAD')).toBeNull();
    expect((await rpc('l2_storePlan', { plan: planOf('P-1250', { dispensingFeeCents: 1250 }) })).error).toBeUndefined();
    expect((await rpc('l2_getPlan', { planId: 'P-1250' })).result.dispensingFeeCents).toBe(1250);
    expect((await rpc('l2_storePlan', { plan: planOf('P-ZERO', { dispensingFeeCents: 0 }) })).error).toBeUndefined();
    expect((await rpc('l2_getPlan', { planId: 'P-ZERO' })).result.dispensingFeeCents).toBe(0);
  });

  test('l2_getPlanLimits says what fee a fill is charged and where it came from', async () => {
    expect((await rpc('l2_getPlanLimits', { planId: 'P-1250' })).result).toMatchObject({ dispensingFeeCents: 1250, dispensingFeeSource: 'plan' });
    expect((await rpc('l2_getPlanLimits', { planId: 'P-ZERO' })).result).toMatchObject({ dispensingFeeCents: 0, dispensingFeeSource: 'plan' });
    await rpc('l2_storePlan', { plan: planOf('P-NONE') });
    await rpc('l2_storePlan', { plan: planOf('P-NULL', { dispensingFeeCents: null }) });
    for (const planId of ['P-NONE', 'P-NULL']) {
      expect((await rpc('l2_getPlanLimits', { planId })).result).toMatchObject({ dispensingFeeCents: 1000, dispensingFeeSource: 'network-default' });
    }
  });

  test('a published plan is reported at its published fee and limits, not a draft\'s', async () => {
    const published = planOf('P-PUB', { dispensingFeeCents: 1250, published: true });
    const draft = { ...published, dispensingFeeCents: 2500, deductibleAmountCents: 1, published: false, publishedTerms: publishedTermsFrom(published, '123', '0', 1) };
    expect((await rpc('l2_storePlan', { plan: draft })).error).toBeUndefined();
    expect((await rpc('l2_getPlanLimits', { planId: 'P-PUB' })).result).toMatchObject({ dispensingFeeCents: 1250, dispensingFeeSource: 'plan', deductibleAmountCents: 50000 });
  });

  test('l2_estimateCost prices with the fill\'s code: NADAC x quantity + the plan\'s fee, and ignores a fee the caller sends', async () => {
    const ndcHash = hashString(ABACAVIR).toString();
    const withPlan = (await rpc('l2_estimateCost', { ndcHash, quantity: 30, planId: 'P-1250' })).result;
    expect(withPlan).toMatchObject({ ingredientCostCents: 1801, dispensingFeeCents: 1250, dispensingFeeSource: 'plan', totalCostCents: 3051 });
    const noPlan = (await rpc('l2_estimateCost', { ndcHash, quantity: 30 })).result;
    expect(noPlan).toMatchObject({ ingredientCostCents: 1801, dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', totalCostCents: 2801 });
    const callerFee = (await rpc('l2_estimateCost', { ndcHash, quantity: 30, dispensingFeeCents: 1 })).result;
    expect(callerFee).toMatchObject({ dispensingFeeCents: 1000, totalCostCents: 2801 });
    const published = (await rpc('l2_estimateCost', { ndcHash, quantity: 30, planId: 'P-PUB' })).result;
    expect(published).toMatchObject({ dispensingFeeCents: 1250, dispensingFeeSource: 'plan', totalCostCents: 3051 });
  });
});
