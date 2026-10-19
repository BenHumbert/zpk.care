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
 * The insurer's Cost Estimator reaches quotes through its own route, not the node's /rpc proxy (owner decision
 * 2026-10-19: "Insurer must stop forwarding member quotes").
 *
 * What was wrong: the estimator posted l2_estimateCost to the insurer node's generic /rpc proxy, which signs what it
 * forwards with the insurer node's key, the key the sequencer's read gate admits as the plan for every member. The A-49
 * fix put the proxy's member reads behind the node's admin token; the owner's decision takes l2_estimateCost off the
 * proxy altogether, so the estimator needs a door of its own.
 *
 * Now POST /pricing/estimate (the node's admin credential) checks the drug, the quantity (thousandths of the pricing
 * unit) and the member or plan, and asks l2_estimateCost as the insurer node, sending nothing else; the dashboard's
 * API.estimateCost posts to it.
 *
 * A real sequencer RPC server with the catalog loaded and a stand-in engine quote behind it, and an insurer node keyed
 * as start-leviathan keys it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(120_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const OPERATOR = 'operator-token-for-pricing-route';
const INSURER_ADMIN = 'insurer-admin-token-for-pricing-route';
const MEMBER = '79000000000000000001';
const UNKNOWN = '79000000000000009999';
const ABACAVIR = '00378410591';

let rpcServer: any;
let insurerServer: any;
let insurerNode: any;
let insurerUrl: string;
let ndcHash: string;
const asked: Array<Record<string, unknown>> = [];
const sent: Array<Record<string, unknown>> = [];
const dirs: string[] = [];

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { formularyRaw } = await import('../src/data/formulary-loader.js');
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  const { hashString } = await import('../src/zkp/hash-utils.js');
  const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
  const { InsurerNode } = await import('../src/nodes/insurer-node.js');
  const { buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js');
  const { resolveRpcProxyPolicy } = await import('../src/security/network-policy.js');
  ndcHash = hashString(ABACAVIR).toString();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-pricing-route' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  node.getSequencer().getFormularyService().loadFromNadac(formularyRaw);
  rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  const insurerKey = generateNodeKey('insurer-node');
  rpcServer.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
  // The engine's quote, as registerInteractiveRoutes registers it: one enrolled member, in the deductible phase.
  rpcServer.setMemberCostQuoteProvider((request: Record<string, unknown>) => {
    asked.push(request);
    if (request.walletId !== MEMBER) return null;
    return {
      covered: true, copayAmountCents: 1500, copayBasis: 'plan', tierLevel: 1,
      price: { basis: 'NADAC', ndc: ABACAVIR, nadacUnitPriceE5: 60042, pricingUnit: 'EA', dispensingFeeCents: 1250, dispensingFeeSource: 'plan', quantity: 30, ingredientCostCents: 1801, totalCostCents: 3051 },
      split: { patientPayCents: 3051, planPayCents: 0, deductibleCreditCents: 3051, phase: 'deductible', familyRule: 0 },
    };
  });
  await rpcServer.start();
  const seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-route-'));
  dirs.push(dir);
  insurerServer = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: INSURER_ADMIN, nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
    rpcProxy: resolveRpcProxyPolicy({}, 'insurer node'),
  } as any);
  insurerServer.registerRoutes(buildInsurerRoutes(insurerServer));
  insurerNode = new InsurerNode({ role: 'insurer', sequencerUrl: seqUrl, displayName: 'Insurer', clientOptions: insurerServer.sequencerClientOptions() } as any);
  // what this node sends the sequencer, as L2Client.estimateCost receives it
  const client = insurerNode.client;
  const estimate = client.estimateCost.bind(client);
  client.estimateCost = async (params: Record<string, unknown>, signer?: unknown) => { sent.push(params); return estimate(params, signer); };
  insurerServer.setEntityNode(insurerNode);
  await insurerServer.start();
  insurerUrl = `http://127.0.0.1:${insurerServer.getPort()}`;
});

afterAll(async () => {
  await insurerServer?.stop();
  await rpcServer?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

beforeEach(() => { asked.length = 0; sent.length = 0; });

async function estimate(body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${INSURER_ADMIN}` }): Promise<{ status: number; json: any }> {
  const r = await fetch(`${insurerUrl}/pricing/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

describe('POST /pricing/estimate', () => {
  test('without the node\'s admin credential no quote is answered, and nothing is asked', async () => {
    const r = await estimate({ ndcHash, quantity: 30, walletId: MEMBER }, {});
    expect(r.status).toBe(401);                                   // before: 404, no such route
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('a member\'s quote is the engine\'s, asked as the plan', async () => {
    const r = await estimate({ ndcHash, quantity: 30, walletId: MEMBER });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({
      covered: true, drugName: 'ABACAVIR', pricingUnit: 'EA', quantity: 30, ingredientCostCents: 1801, dispensingFeeCents: 1250,
      dispensingFeeSource: 'plan', totalCostCents: 3051, phase: 'deductible', memberPayCents: 3051, employerPayCents: 0,
    });
    expect(asked).toEqual([expect.objectContaining({ walletId: MEMBER, ndcHash, quantity: 30 })]);
  });

  test('with no member: a plan\'s price, or the list price; no member is asked about', async () => {
    const plan = await estimate({ ndcHash, quantity: 30, planId: 'PLAN-NOT-STORED' });
    expect(plan.status).toBe(200);
    expect(plan.json.data).toMatchObject({ covered: true, ingredientCostCents: 1801, dispensingFeeSource: 'network-default' });
    const list = await estimate({ ndcHash, quantity: 0.4 });
    expect(list.status).toBe(200);
    expect(list.json.data).toMatchObject({ quantity: 0.4, ingredientCostCents: 24 });   // 0.60042 x 0.4 = 0.240168, half up
    expect(asked).toEqual([]);
  });

  test('only the drug, the quantity and the member (or else the plan) are sent on', async () => {
    await estimate({ ndcHash, quantity: 30, walletId: MEMBER, planId: 'PLAN-X', dispensingFeeCents: 1, deductibleAmountCents: 0, oopMaxCents: 0 });
    await estimate({ ndcHash, quantity: 30, planId: 'PLAN-X', annualBenefitMaxCents: 0 });
    expect(sent).toEqual([{ ndcHash, quantity: 30, walletId: MEMBER }, { ndcHash, quantity: 30, planId: 'PLAN-X' }]);
  });

  test('a wallet that is not a member is the sequencer\'s refusal, as a 400', async () => {
    const r = await estimate({ ndcHash, quantity: 30, walletId: UNKNOWN });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not a member enrolled with the engine/);
  });

  test('the quantity is checked at this door: thousandths of the pricing unit, nothing asked otherwise', async () => {
    for (const quantity of [undefined, 0, -1, 0.0005, '30', null]) {
      const r = await estimate({ ndcHash, quantity, walletId: MEMBER });
      expect([quantity, r.status]).toEqual([quantity, 400]);
    }
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('the drug and the member must be decimal IDs; a drug the sequencer does not hold is a 404', async () => {
    expect((await estimate({ ndcHash: 'ABACAVIR', quantity: 30 })).status).toBe(400);
    expect((await estimate({ ndcHash, quantity: 30, walletId: 'not-a-wallet' })).status).toBe(400);
    expect((await estimate({ ndcHash, quantity: 30, planId: 7 })).status).toBe(400);
    expect(sent).toEqual([]);
    const unknownDrug = await estimate({ ndcHash: '12345', quantity: 30 });
    expect(unknownDrug.status).toBe(404);
    expect(unknownDrug.json.error).toMatch(/Drug not found/);
  });
});

describe('the insurer dashboard\'s estimator', () => {
  test('API.estimateCost posts to /pricing/estimate with the node\'s admin token, not to /rpc', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const quote = { covered: true, memberPayCents: 3051 };
    const ctx: Record<string, unknown> = {
      location: { origin: 'http://127.0.0.1:4004' },
      localStorage: { getItem: () => 'insurer-admin-token', setItem() {} },
      fetch: async (url: string, init: any) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: quote }) };
      },
    };
    vm.createContext(ctx);
    vm.runInContext(read('dashboard-insurer/rpc.js') + '\n;globalThis.__API = API;', ctx);
    const API = ctx.__API as any;
    const q = await API.estimateCost({ ndcHash: '1', quantity: 30, walletId: MEMBER });
    expect(q).toEqual(quote);
    expect(calls).toHaveLength(1);
    expect([calls[0].init.method, calls[0].url]).toEqual(['POST', 'http://127.0.0.1:4004/pricing/estimate']);   // before: /rpc
    expect(calls[0].init.headers.Authorization).toBe('Bearer insurer-admin-token');
    expect(JSON.parse(calls[0].init.body)).toEqual({ ndcHash: '1', quantity: 30, walletId: MEMBER });
  });

  test('nothing on the insurer\'s pages asks l2_estimateCost through the proxy', () => {
    for (const file of ['dashboard-insurer/rpc.js', 'dashboard-insurer/app.js']) {
      expect([file, read(file).includes("'l2_estimateCost'")]).toEqual([file, false]);
    }
  });
});
