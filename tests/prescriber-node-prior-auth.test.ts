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
 * The prescriber node gives its administrator the patient's own price and the prior-authorization path, and nobody else
 * (owner decision 2026-10-19), and the insurer, pharmacy and prescriber nodes stop forwarding member quotes.
 *
 * What was wrong: the node's /estimate-cost forwarded a member's walletId with no credential of the caller, signed with
 * the node's key, so the only way to the patient's price was her tapped attestation; the node had no way to start a
 * prior authorization or read one; and the insurer, pharmacy and prescriber /rpc proxies all listed l2_estimateCost.
 *
 * Now /estimate-cost with a walletId requires this node's admin token (until provider sign-in, B4) and asks the
 * sequencer signed as the prescriber's own wallet, so the read gate admits the member's named primary-care prescriber;
 * a refusal is a 403, bad input a 400, and the price with no member stays open. POST /prior-auth/request and GET
 * /prior-auth/status require the token and call the engine signed as the prescriber's wallet, which names the
 * prescriber; the body cannot. Only the member node and the explorer forward l2_estimateCost.
 *
 * A real sequencer RPC server and engine (programs not compiled, proofs skipped), and a real prescriber Nautilus node
 * set up as start-prescriber-nautilus.ts sets up its seed prescriber: the enrollment key held in memory, the wallet's
 * signing key registered on the sequencer, its own node key and admin token.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-prescriber-node-pa';
const NODE_ADMIN = 'prescriber-node-admin-token-for-pa';
const ABACAVIR = '00378410591';   // tier 1: no prior authorization, 90 EA per fill
const PA_DRUG = '59148004580';    // prior authorization and step therapy, 30 EA per fill
const W = '79200000000000000001';   // names prescriber 0, this node, as primary care
const W2 = '79200000000000000002';  // names no one

let rpcServer: any;
let svc: any;
let seq: any;
let node: any;
let app: any;
let seqUrl: string;
let nodeUrl: string;
let hashString: (s: string) => Field;
let resolveRpcProxyPolicy: any;
const dirs: string[] = [];
const ndcHashOf = (ndc: string) => hashString(ndc).toString();
const adminHeader = { Authorization: `Bearer ${NODE_ADMIN}` };

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${seqUrl}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
}

/** A call to the prescriber node, as its dashboard makes it; the answer's envelope { ok, data, error }. */
async function call(method: 'GET' | 'POST', p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(nodeUrl + p, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { formularyRaw } = await import('../src/data/formulary-loader.js');
  const { getAllFormularyEntries, PRESCRIBERS } = await import('../src/data/index.js');
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  const { deriveWalletSigningKey } = await import('../src/security/wallet-key.js');
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
  const { buildPrescriberRoutes } = await import('../src/nodes/routes/prescriber-routes.js');
  const { PrescriberNode } = await import('../src/nodes/prescriber-node.js');
  ({ resolveRpcProxyPolicy } = await import('../src/security/network-policy.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  const LC = await import('../src/engine/lifecycle.js');

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-prescriber-node-pa' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  seq = node.getSequencer();
  seq.getFormularyService().loadFromNadac(formularyRaw);
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });
  rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  const nodeKey = generateNodeKey('prescriber-node');
  rpcServer.registerNodeKey(nodeKey.nodeId, nodeKey.publicKeyHex, 'prescriber');
  registerInteractiveRoutes(rpcServer, svc);
  await rpcServer.start();
  seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;

  // The plan and two members on it
  const base: any = {
    planId: 'PLAN-NODE-PA', name: 'Node PA plan', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1300,
    formularyNdcs: [ABACAVIR, PA_DRUG], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  for (const w of [W, W2]) {
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(w)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: w, groupIdHash: ndcHashOf('GRP-NODE-PA'), planIdHash: ndcHashOf(base.planId), planId: base.planId, employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: w, ownershipProofJson: '{}', displayName: 'Node PA member' });
  }

  // Seed prescriber 0's node, as start-prescriber-nautilus.ts starts it
  const prescriber = PRESCRIBERS[0];
  const walletId = svc.getPrescriberWalletId(0).toString();
  expect((await rpc('l2_registerEntity', {
    walletId, displayName: 'Prescriber 0', type: 'prescriber', npi: String(prescriber.localData.prescriberId),
    signingPublicKeyHex: deriveWalletSigningKey(prescriber.enrollmentKey).publicKeyHex,
  })).error).toBeUndefined();
  svc.enrolledMembers.get(W).pcpAssignment = { pcpWalletId: Field(BigInt(walletId)) };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prescriber-node-pa-'));
  dirs.push(dir);
  app = new NautilusAppServer({
    role: 'prescriber', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: NODE_ADMIN, nodeKey: { nodeId: nodeKey.nodeId, seedHex: nodeKey.seedHex },
    rpcProxy: resolveRpcProxyPolicy({}, 'prescriber node'),
  } as any);
  jest.useFakeTimers();   // the route builder starts a PCP sync interval
  try { app.registerRoutes(buildPrescriberRoutes(app)); } finally { jest.useRealTimers(); }
  app.getLocalState().setEnrollmentKey(prescriber.enrollmentKey);
  app.setEntityNode(new PrescriberNode({ role: 'prescriber', walletId, sequencerUrl: seqUrl, displayName: 'Prescriber 0', clientOptions: app.sequencerClientOptions() } as any));
  await app.start();
  nodeUrl = `http://127.0.0.1:${app.getPort()}`;
});

afterAll(async () => {
  await app?.stop();
  await rpcServer?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('the /rpc proxy catalogs', () => {
  test('the insurer, pharmacy and prescriber nodes no longer forward l2_estimateCost; the member node and the explorer still do', () => {
    for (const role of ['insurer node', 'pharmacy node', 'prescriber node']) {
      const policy = resolveRpcProxyPolicy({}, role);
      expect([role, policy.allowed.has('l2_estimateCost')]).toEqual([role, false]);   // before: true for all three
      expect(policy.allowed.has('l2_getFormularyPage')).toBe(true);                     // the catalog reads stay
    }
    expect(resolveRpcProxyPolicy({}, 'member node').allowed.has('l2_estimateCost')).toBe(true);
    expect(resolveRpcProxyPolicy({}, 'explorer').allowed.has('l2_estimateCost')).toBe(true);
  });

  test('the prescriber node refuses it at its proxy, with or without its admin token', async () => {
    for (const headers of [{}, adminHeader]) {
      const r = await fetch(`${nodeUrl}/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_estimateCost', params: { ndcHash: ndcHashOf(ABACAVIR), quantity: 30 } }),
      });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatchObject({ code: -32601 });
    }
  });
});

describe('/estimate-cost', () => {
  test('a patient\'s own price answers only this node\'s administrator', async () => {
    const body = { ndcHash: ndcHashOf(ABACAVIR), walletId: W, quantity: 30 };
    const bare = await call('POST', '/estimate-cost', body);
    expect(bare.status).toBe(401);                   // before: forwarded for anyone who reached the port
    expect(bare.json.data).toBeUndefined();
    expect((await call('POST', '/estimate-cost', body, { Authorization: 'Bearer not-the-token' })).status).toBe(401);
  });

  test('with the token, the node asks as the prescriber\'s wallet and the member\'s named PCP gets her own price and the drug\'s availability', async () => {
    const r = await call('POST', '/estimate-cost', { ndcHash: ndcHashOf(ABACAVIR), walletId: W, quantity: 30 }, adminHeader);
    expect(r.status).toBe(200);                      // before: 403, the tap was the only way in
    const asOperator = (await rpc('l2_estimateCost', { walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).result;
    expect(r.json.data).toEqual(asOperator);
    expect(r.json.data).toMatchObject({
      covered: true, phase: 'deductible', memberPayCents: 3101, employerPayCents: 0, ingredientCostCents: 1801, dispensingFeeCents: 1300,
      priorAuthRequired: false, stepTherapyRequired: false, maxQuantityPerFill: 90,
    });
    const pa = await call('POST', '/estimate-cost', { ndcHash: ndcHashOf(PA_DRUG), walletId: W, quantity: 30 }, adminHeader);
    expect(pa.json.data).toMatchObject({ priorAuthRequired: true, stepTherapyRequired: true, maxQuantityPerFill: 30, priorAuth: { status: 'none' } });
  });

  test('a member who has not named this prescriber is refused with 403, saying who may read it; bad input is a 400 before asking', async () => {
    const r = await call('POST', '/estimate-cost', { ndcHash: ndcHashOf(ABACAVIR), walletId: W2, quantity: 30 }, adminHeader);
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/primary-care prescriber/);
    expect((await call('POST', '/estimate-cost', { ndcHash: ndcHashOf(ABACAVIR), walletId: W, quantity: 0.0004 }, adminHeader)).status).toBe(400);
    expect((await call('POST', '/estimate-cost', { walletId: W, quantity: 30 }, adminHeader)).status).toBe(400);
  });

  test('the price with no member stays open', async () => {
    const r = await call('POST', '/estimate-cost', { ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ covered: true, dispensingFeeSource: 'network-default', ingredientCostCents: 1801 });
    expect(r.json.data).not.toHaveProperty('priorAuthRequired');
  });
});

describe('prior authorization from the prescriber node', () => {
  test('a request answers only this node\'s administrator', async () => {
    const r = await call('POST', '/prior-auth/request', { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 });
    expect(r.status).toBe(401);                      // before: no such route
    expect((await call('GET', `/prior-auth/status?walletId=${W}&ndcHash=${ndcHashOf(PA_DRUG)}`)).status).toBe(401);
    expect(svc.priorAuths.size).toBe(0);
  });

  test('the node asks the engine as this prescriber: pending, recorded under prescriber 0, and the status reads back', async () => {
    const r = await call('POST', '/prior-auth/request', { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30, reason: 'Oral therapy failed' }, adminHeader);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'pending', ndcHash: ndcHashOf(PA_DRUG), quantity: 30, pricingUnit: 'EA' });
    const recorded = [...svc.priorAuths.values()];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ memberWalletId: W, status: 'PENDING', prescriberIndex: 0 });
    const status = await call('GET', `/prior-auth/status?walletId=${W}&ndcHash=${ndcHashOf(PA_DRUG)}`, undefined, adminHeader);
    expect(status.status).toBe(200);
    expect(status.json.data).toMatchObject({ status: 'pending' });
    const quote = await call('POST', '/estimate-cost', { ndcHash: ndcHashOf(PA_DRUG), walletId: W, quantity: 30 }, adminHeader);
    expect(quote.json.data.priorAuth).toMatchObject({ status: 'pending' });
  });

  test('the body names no prescriber; a duplicate, a drug that needs none and a member who has not consented are refused with the engine\'s status', async () => {
    const named = await call('POST', '/prior-auth/request', { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30, prescriberIndex: 3 }, adminHeader);
    expect(named.status).toBe(400);
    const dup = await call('POST', '/prior-auth/request', { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 }, adminHeader);
    expect([dup.status, dup.json.error]).toEqual([409, expect.stringMatching(/already pending/)]);
    const none = await call('POST', '/prior-auth/request', { walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 }, adminHeader);
    expect(none.status).toBe(409);
    const noConsent = await call('POST', '/prior-auth/request', { walletId: W2, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 }, adminHeader);
    expect(noConsent.status).toBe(403);
    expect((await call('GET', `/prior-auth/status?walletId=${W2}&ndcHash=${ndcHashOf(PA_DRUG)}`, undefined, adminHeader)).status).toBe(403);
    expect((await call('POST', '/prior-auth/request', { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 0 }, adminHeader)).status).toBe(400);
    expect(svc.priorAuths.size).toBe(1);
  });
});
