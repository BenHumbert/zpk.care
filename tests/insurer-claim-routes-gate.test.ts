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
 * The insurer node's claim, audit and messaging reads take its admin credential.
 *
 * What was wrong: GET /claims/prescriber/:walletId, /claims/pharmacy/:walletId, /claims/drug/:ndcHash and
 * /audit/duplicate-claims took no credential. Each reads the sequencer through the node's L2Client, signed with the
 * insurer node's key, which the sequencer's read gate (D1) admits as the plan for every member. So anything that reached
 * the insurer's port, the origin that also serves the public marketplace, got members' wallet IDs with the NDC, the brand
 * name, the date of service and the amounts, while /claims/member and /audit/log in the same block took the node's admin
 * credential (A-43 gated those and left these open). Four more reads were open the same way: /audit/financial-balance
 * and /audit/chain-integrity, whose totals, counts and receipt IDs name no member but which read every member's audit
 * events as the plan and computed over all of them on the node's one thread, for any caller as often as it liked; and
 * /messaging/wallet/:walletId and /messaging/thread/:threadIdHash, any wallet's messages and any whole thread, read as
 * the plan. The insurer dashboard's rpc.js called all eight without its token.
 *
 * How it was found: the security review of the sweep fixes, 2026-10-24, reproduced it with a real L2RpcServer, the
 * insurer node's key, a NautilusAppServer with buildInsurerRoutes and one claim.
 *
 * What is true now: the eight routes are adminOnly. Without the node's admin credential each answers 401 and the
 * sequencer is not asked; with it each answers as before. The GET routes still open are named here (OPEN_GETS), and none
 * names a member: /batches/all, /chain-proof and /messaging/status answer roots, counts and proofs that the sequencer
 * gives any caller (l2_getAllBatches, l2_getChainProof, l2_getMessageStoreRoot), and the rest read the provider
 * directory, the plans and the plans an employer may add. The dashboard sends its token on each of the eight.
 *
 * A real sequencer RPC server with the insurer node's key registered as the plan, one claim in its accumulator, the same
 * fill twice in its audit log and one message in its store, and an insurer node keyed as start-insurer-nautilus keys it.
 * No compile, no proof.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import type { L2Client } from '../src/l2/l2-client.js';
import type { L2Receipt } from '../src/l2/l2-types.js';
import type { AuditEvent } from '../src/audit/audit-types.js';
import { AuditService } from '../src/audit/audit-service.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { resolveRpcProxyPolicy } from '../src/security/network-policy.js';
import { hashString } from '../src/zkp/hash-utils.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import { InsurerNode } from '../src/nodes/insurer-node.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';

jest.setTimeout(120_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const OPERATOR = 'operator-token-for-insurer-claim-routes';
const ADMIN = 'insurer-admin-token-for-insurer-claim-routes';
const AS_ADMIN = { Authorization: `Bearer ${ADMIN}` };
/** Twenty digits each, so no root or hash in an answer holds one by chance. */
const W = { member: '79000000000000000101', prescriber: '79000000000000000202', pharmacy: '79000000000000000303' };
const NDC = '00378410591';
const NDC_HASH = hashString(NDC).toString();
const THREAD = '424242';
const RECEIPTS = ['rcpt-claim-routes-1', 'rcpt-claim-routes-2'];

/** The L2Client read each gated route makes, signed with the insurer node's key. */
type ClientRead = 'getClaimsByPrescriber' | 'getClaimsByPharmacy' | 'getClaimsByNdc' | 'getAuditLog' | 'getMessagesByWallet' | 'getMessagesByThread';

/** The routes this fix gates: each route, the request made of it here, and the sequencer read behind it. */
const GATED: Array<[string, string, ClientRead]> = [
  ['/claims/prescriber/:walletId', `/claims/prescriber/${W.prescriber}`, 'getClaimsByPrescriber'],
  ['/claims/pharmacy/:walletId', `/claims/pharmacy/${W.pharmacy}`, 'getClaimsByPharmacy'],
  ['/claims/drug/:ndcHash', `/claims/drug/${NDC_HASH}`, 'getClaimsByNdc'],
  ['/audit/duplicate-claims', '/audit/duplicate-claims', 'getAuditLog'],
  ['/audit/financial-balance', '/audit/financial-balance', 'getAuditLog'],
  ['/audit/chain-integrity', '/audit/chain-integrity', 'getAuditLog'],
  ['/messaging/wallet/:walletId', `/messaging/wallet/${W.member}`, 'getMessagesByWallet'],
  ['/messaging/thread/:threadIdHash', `/messaging/thread/${THREAD}`, 'getMessagesByThread'],
];

/** The insurer node's GET routes that answer without its admin credential, and why each may: none names a member. */
const OPEN_GETS = [
  '/batches/all', // roots, counts and batch proofs (l2_getAllBatches, which the sequencer answers any caller)
  '/chain-proof', // the latest chain proof and its roots (l2_getChainProof, likewise)
  '/messaging/status', // the message store's root and count (l2_getMessageStoreRoot, likewise)
  '/credentialing/status/:walletId', // a provider's entry in the provider registry
  '/credentialing/registry', // the provider directory
  '/plans', // the plans, which the marketplace shows employers
  '/plans/:planId',
  '/employer-agreements/:applicationId/plans-to-add', // plan IDs, per application, rate-limited
];

let rpcServer: L2RpcServer;
let insurerServer: NautilusAppServer;
let routes: RouteRegistration[];
let client: L2Client;
let url: string;
const dirs: string[] = [];

async function get(target: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const r = await fetch(url + target, { headers });
  return { status: r.status, json: await r.json() };
}

/** The insurer dashboard's rpc.js as its page runs it, against this node: the token it has stored, and what it sends. */
function dashboard(token: string): { API: any; sent: Array<{ path: string; authorization?: string }> } {
  const sent: Array<{ path: string; authorization?: string }> = [];
  const ctx: Record<string, unknown> = {
    location: { origin: url },
    localStorage: { getItem: () => token, setItem() {} },
    fetch: async (u: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      sent.push({ path: new URL(u).pathname, authorization: init?.headers?.Authorization });
      return fetch(u, init);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('dashboard-insurer/rpc.js') + '\n;globalThis.__API = API;', ctx);
  return { API: ctx.__API, sent };
}

beforeAll(async () => {
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-insurer-claim-routes' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  const insurerKey = generateNodeKey('insurer-node');
  rpcServer.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
  await rpcServer.start();
  const seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;

  const seq = node.getSequencer();
  // One fill in the claim accumulator, as the engine records it.
  seq.getClaimAccumulator().appendClaim(
    { memberWalletId: W.member, ndcHash: NDC_HASH, pharmacyWalletId: W.pharmacy, prescriberWalletId: W.prescriber, dateOfService: '20261020', patientPayCents: '1500', planPayCents: '50000', operationType: '1', deductibleCreditCents: '0' },
    { receiptId: RECEIPTS[0], timestamp: Date.now(), dateOfService: '20261020', ndc: NDC, brandName: 'Abacavir', tierLevel: 1 },
  );
  // The same fill twice in the audit log, chained as the sequencer chains its events, so the duplicate check names it.
  for (const [i, receiptId] of RECEIPTS.entries()) {
    const sequenceNumber = BigInt(i + 1);
    const registryRoot = seq.getCurrentRegistryRoot().toString();
    const lifecycleRoot = seq.getCurrentLifecycleRoot().toString();
    const roots = { oldRegistryRoot: registryRoot, newRegistryRoot: registryRoot, oldLifecycleRoot: lifecycleRoot, newLifecycleRoot: lifecycleRoot };
    const event: AuditEvent = {
      sequenceNumber, receiptId, walletId: W.member, isRegistration: false, ...roots, eventCommitment: '', chainHash: '',
      timestamp: Date.now(), l1Status: 'pending', patientPayCents: 1500, planPayCents: 50000, ndcHash: NDC_HASH, operationType: 1,
      claimContext: {
        pharmacyWalletId: W.pharmacy, memberWalletId: W.member, prescriberWalletId: W.prescriber, ndcHash: NDC_HASH,
        ingredientCostCents: 50250, dispensingFeeCents: 1250, quantityDispensed: '30000', dateOfService: 20261020, fillNumber: 0,
      },
    };
    const commitment = AuditService.computeEventCommitment(event);
    event.eventCommitment = commitment.toString();
    event.chainHash = AuditService.computeChainHash(Field(BigInt(seq.getAuditLog().latestChainHash)), commitment).toString();
    const receipt: L2Receipt = { receiptId, walletId: W.member, sequenceNumber, ...roots, isRegistration: false, acceptedAt: Date.now(), l1Status: 'pending' };
    seq.applyReplicatedReceipt(receipt, event);
  }
  // One message from the member to the prescriber.
  seq.storeMessage(
    { messageCommitment: '77', senderWalletId: W.member, recipientWalletId: W.prescriber, messageType: '1', threadIdHash: THREAD },
    { ciphertext: '6d79207265666', iv: '00', tag: '00', timestamp: Date.now() },
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insurer-claim-routes-'));
  dirs.push(dir);
  insurerServer = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: ADMIN, nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
    rpcProxy: resolveRpcProxyPolicy({}, 'insurer node'),
  });
  routes = buildInsurerRoutes(insurerServer);
  insurerServer.registerRoutes(routes);
  const insurerNode = new InsurerNode({ role: 'insurer', sequencerUrl: seqUrl, displayName: 'Insurer', clientOptions: insurerServer.sequencerClientOptions() });
  client = (insurerNode as unknown as { client: L2Client }).client;
  insurerServer.setEntityNode(insurerNode);
  await insurerServer.start();
  url = `http://127.0.0.1:${insurerServer.getPort()}`;
});

afterAll(async () => {
  await insurerServer?.stop();
  await rpcServer?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

afterEach(() => { jest.restoreAllMocks(); });

describe('the claim, audit and messaging reads', () => {
  test.each(GATED)('%s refuses a caller without the node\'s admin credential, and the sequencer is not asked', async (_route, target, sequencerRead) => {
    const asked = jest.spyOn(client, sequencerRead);
    for (const headers of [{}, { Authorization: 'Bearer not-the-token' }]) {
      const r = await get(target, headers);
      expect([r.status, r.json.data]).toEqual([401, undefined]);  // before: 200, read as the plan for anyone
    }
    expect(asked).not.toHaveBeenCalled();                          // before: asked, signed with the plan's key
  });

  test('with the credential, the prescriber, pharmacy and drug reads answer the claim as before, its member named', async () => {
    for (const target of [`/claims/prescriber/${W.prescriber}`, `/claims/pharmacy/${W.pharmacy}`, `/claims/drug/${NDC_HASH}`]) {
      const r = await get(target, AS_ADMIN);
      expect([target, r.status]).toEqual([target, 200]);
      expect(r.json.data).toEqual([expect.objectContaining({
        memberWalletId: W.member, prescriberWalletId: W.prescriber, pharmacyWalletId: W.pharmacy, ndcHash: NDC_HASH, ndc: NDC,
        brandName: 'Abacavir', dateOfService: '20261020', patientPayCents: '1500', planPayCents: '50000', receiptId: RECEIPTS[0],
      })]);
    }
  });

  test('with the credential, the audit checks answer as before', async () => {
    const duplicates = await get('/audit/duplicate-claims', AS_ADMIN);
    expect(duplicates.status).toBe(200);
    expect(duplicates.json.data).toEqual({
      hasDuplicates: true, totalDuplicates: 2, duplicateGroups: [{ key: `${W.member}|${NDC_HASH}|20261020|0`, receiptIds: RECEIPTS }],
    });
    const balance = await get('/audit/financial-balance', AS_ADMIN);
    expect(balance.status).toBe(200);
    expect(balance.json.data).toEqual({
      isValid: true, totalClaims: 2, reversals: 0, imbalancedClaims: [], totalPatientPayCents: 3000, totalPlanPayCents: 100000,
      totalIngredientCostCents: 100500, totalDispensingFeeCents: 2500,
    });
    const chain = await get('/audit/chain-integrity', AS_ADMIN);
    expect(chain.status).toBe(200);
    expect(chain.json.data).toEqual({ isValid: true, totalEvents: 2, brokenLinks: [] });
  });

  test('with the credential, a wallet\'s messages and its thread answer as before', async () => {
    for (const target of [`/messaging/wallet/${W.member}`, `/messaging/thread/${THREAD}`]) {
      const r = await get(target, AS_ADMIN);
      expect([target, r.status]).toEqual([target, 200]);
      expect(r.json.data).toEqual([expect.objectContaining({
        message: { messageCommitment: '77', senderWalletId: W.member, recipientWalletId: W.prescriber, messageType: '1', threadIdHash: THREAD },
      })]);
    }
  });
});

describe('the reads that stay open', () => {
  test('/batches/all, /chain-proof and /messaging/status answer any caller, and name no member', async () => {
    for (const target of ['/batches/all', '/chain-proof', '/messaging/status']) {
      const r = await get(target, {});
      expect([target, r.status]).toEqual([target, 200]);
      expect(JSON.stringify(r.json.data)).not.toContain(W.member);
    }
    expect((await get('/messaging/status', {})).json.data.messageCount).toBe('1');
  });

  test('every other GET route of the insurer node takes its admin credential', () => {
    const open = routes.filter((r) => r.method === 'GET' && !r.adminOnly).map((r) => r.path);
    expect(open.sort()).toEqual([...OPEN_GETS].sort()); // before: also the three claim reads, the three audit checks and the two message reads
  });
});

describe('the insurer dashboard', () => {
  /** The dashboard's call for each of the eight, and the path it asks. */
  const CALLS: Array<[string, (API: any) => Promise<any>]> = [
    [`/claims/prescriber/${W.prescriber}`, (API) => API.getPrescriberClaims(W.prescriber)],
    [`/claims/pharmacy/${W.pharmacy}`, (API) => API.getPharmacyClaims(W.pharmacy)],
    [`/claims/drug/${NDC_HASH}`, (API) => API.getDrugClaims(NDC_HASH)],
    ['/audit/duplicate-claims', (API) => API.detectDuplicateClaims()],
    ['/audit/financial-balance', (API) => API.verifyFinancialBalance()],
    ['/audit/chain-integrity', (API) => API.verifyChainIntegrity()],
    [`/messaging/wallet/${W.member}`, (API) => API.getMessagesByWallet(W.member)],
    [`/messaging/thread/${THREAD}`, (API) => API.getMessagesByThread(THREAD)],
  ];

  test('sends its token on each of the eight reads, and reads what the node answers', async () => {
    const { API, sent } = dashboard(ADMIN);
    const answers: any[] = [];
    for (const [, call] of CALLS) answers.push(await call(API));
    expect(sent.map((s) => s.path)).toEqual(CALLS.map(([p]) => p));
    expect(sent.map((s) => s.authorization)).toEqual(Array(CALLS.length).fill(`Bearer ${ADMIN}`)); // before: no Authorization on any of the eight
    for (const claims of answers.slice(0, 3)) expect(claims.map((c: any) => c.memberWalletId)).toEqual([W.member]);
    expect(answers[3].totalDuplicates).toBe(2);
    expect(answers[4].isValid).toBe(true);
    expect(answers[5].isValid).toBe(true);
    for (const messages of answers.slice(6)) expect(messages.map((m: any) => m.message.senderWalletId)).toEqual([W.member]);
  });

  test('with no token stored, each of the eight is refused, and the open reads still answer', async () => {
    const { API, sent } = dashboard('');
    for (const [p, call] of CALLS) {
      await expect(call(API).then(() => `${p} answered`)).rejects.toThrow('Unauthorized'); // before: answered with the member's data
    }
    expect(sent.map((s) => s.authorization)).toEqual(Array(CALLS.length).fill(undefined));
    expect(await API.getBatches()).toEqual([]);
    expect((await API.getChainProof()).enabled).toBe(false);
    expect((await API.getMessageStoreStatus()).messageCount).toBe('1');
  });
});
