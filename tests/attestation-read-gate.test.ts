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
 * A member's attestation answers the member, not a wallet ID (the sweep of the open routes, 2026-10-24).
 *
 * What was wrong: the sequencer's l2_getAttestation returned the attestation it last signed for a wallet, good for a
 * day by default, to anyone who named the wallet. That attestation is the member's tap at a counter: D1's read gate
 * accepts it from any signed caller as a reader of the member's claims, receipts, accumulator and wallet state, and the
 * pharmacy node's open /nfc/scan and /dur/* routes accept it from anyone and read the member's drug history signed as
 * the pharmacy. So a wallet ID, which the network passes around everywhere, opened the member's fills. The read-only
 * sweep of every route anyone can call named it, and it was reproduced end to end before the fix: an anonymous
 * l2_getAttestation, then /nfc/scan with its answer, returned the member's fills.
 *
 * The sweep's fix made l2_getAttestation a D1 read (MEMBER_DATA_METHODS) whose one reader was the wallet itself. The
 * security review of the sweep fixes (2026-10-24) found what that still allowed: D1 answers the plan's node key, the
 * operator's bearer and every key with the operator role for every member, so they took the member's live attestation,
 * the member's identity at any pharmacy's /nfc/scan, though A10b refuses those same credentials when they ask the
 * sequencer to issue one (WALLET_SIGNED_METHODS lists l2_requestAttestation). With the operator's token, the review
 * fetched the attestation and the counter read the member's fills with it.
 *
 * Now l2_getAttestation takes the wallet gate that issuing one takes (WALLET_SIGNED_METHODS): only the wallet's own
 * signature opens it. An anonymous caller, any bearer (the operator's included), another wallet (with the attestation in
 * hand or not), the member's primary-care prescriber, a pharmacy and every node key (the plan's and an operator key
 * included) are refused, each with A10b's reason. It has left the D1 table, which is as it was before the sweep but for
 * the duplicate-claims check that the same review added (tests/duplicate-claims-read-gate.test.ts). The member's device
 * still reads its own through its node's /rpc proxy, which signs as the wallet, and the pharmacy still reads the drug
 * history with the tap the member presents.
 *
 * A real sequencer RPC server; a real member node holding the member's enrollment key, which asks for the attestation
 * through its own route as the member app does; and the pharmacy's /nfc/scan over a real PharmacyNode signing as the
 * pharmacy's wallet (the pattern of nfc-scan-verify.test.ts). No compile, no proof.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_UNAUTHORIZED } from '../src/l2/l2-rpc-server.js';
import { MEMBER_DATA_METHODS, callReadsMemberData, memberDataSpecOf } from '../src/l2/member-data-methods.js';
import { LIFECYCLE_ELIGIBLE } from '../src/engine/lifecycle.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';
import { resolveRpcProxyPolicy } from '../src/security/network-policy.js';
import { NautilusLocalState } from '../src/nodes/nautilus-local-state.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { MemberNode } from '../src/nodes/member-node.js';
import { PharmacyNode } from '../src/nodes/pharmacy-node.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';

jest.setTimeout(120_000);

const OPERATOR = 'operator-token-for-attestation-reads';
const DEVICE_ADMIN = 'member-node-admin-for-attestation-reads';
const PIN = '739204';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const memberNodeKey = generateNodeKey('member-node');
const prescriberNodeKey = generateNodeKey('prescriber-node');
const pharmacyNodeKey = generateNodeKey('pharmacy-node');
const insurerNodeKey = generateNodeKey('insurer-node');
const operatorNodeKey = generateNodeKey('operator-node');
/** Alice's enrollment key is on her device, the member node's state; the other wallets sign with fixed keys. */
const EK = { alice: randomBytes(32).toString('base64url'), bob: 'ek-bob-' + 'b'.repeat(32), drP: 'ek-drp-' + 'c'.repeat(32), rx: 'ek-rx-' + 'd'.repeat(32) };
const W = { alice: '1001', bob: '1002', drP: '2001', rx: '3001' };

/** The D1 table before the sweep, which l2_getAttestation has left again. */
const D1_BEFORE = {
  l2_getClaimsByMember: { subject: 'wallet', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_getReceiptsByWallet: { subject: 'wallet', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_reconstructAccumulator: { subject: 'wallet', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_getWalletState: { subject: 'wallet', param: 'walletId|0', readers: ['self', 'attestation'] },
  l2_getWalletWitnesses: { subject: 'wallet', param: 'walletId|0', readers: ['self', 'attestation'] },
  l2_getMessagesByWallet: { subject: 'wallet', param: 'walletId', readers: ['self'] },
  l2_getMessagesBySender: { subject: 'wallet', param: 'walletId', readers: ['self'] },
  l2_getMessagesByRecipient: { subject: 'wallet', param: 'walletId', readers: ['self'] },
  l2_getMessagesByThread: { subject: 'thread', readers: ['signed'] },
  l2_getEntity: { subject: 'entity', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_getEncryptionKey: { subject: 'wallet', param: 'walletId', readers: ['signed'] },
  l2_getPcpAssignments: { subject: 'provider', param: 'prescriberWalletId', readers: ['self'] },
  l2_getClaimsByPharmacy: { subject: 'provider', param: 'walletId', readers: ['self'] },
  l2_getClaimsByPrescriber: { subject: 'provider', param: 'walletId', readers: ['self'] },
  l2_getClaimsByNdc: { subject: 'enumeration', readers: [] },
  l2_getAllReceipts: { subject: 'enumeration', readers: [] },
  l2_getAuditLog: { subject: 'enumeration', readers: [] },
  l2_getReceipt: { subject: 'receipt', param: 'receiptId', readers: ['self'] },
  l2_getClaimWithProof: { subject: 'leaf', param: 'leafIndex', readers: ['self'] },
  l2_estimateCost: { subject: 'optional-wallet', param: 'walletId', readers: ['self', 'prescriber', 'attestation'] },
};

let node: L2Node;
let seq: L2RpcServer;
let url: string;
let device: NautilusAppServer;
let deviceUrl: string;
let session: Record<string, string>;
/** Alice's attestation, as her device received it from its node's /attestation/request. */
let tap: Record<string, any>;
const dirs: string[] = [];

let rpcId = 0;
/** Each envelope has its own id, so two identical reads signed in the same millisecond are not one replayed signature. */
const envelope = (method: string, params: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
const attestationOf = (walletId: string) => envelope('l2_getAttestation', { walletId });
async function rpcWith(headers: Record<string, string>, body: string) {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return (await r.json()) as { result?: any; error?: { code: number; message: string } };
}
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const byWallet = (who: keyof typeof W, body: string) => signRequest({ ...walletSigner(EK[who], W[who]), method: 'POST', path: '/rpc', body });
const byNode = (key: ReturnType<typeof generateNodeKey>, body: string) => signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });

/** A request to Alice's member node, as her app makes it. */
async function deviceCall(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(`${deviceUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** The pharmacy node's /nfc/scan over a real PharmacyNode that signs as the pharmacy's wallet. */
function counter() {
  const sent: Array<{ status: number; ok: boolean; data?: any; error?: string }> = [];
  const pharmacy = new PharmacyNode({ role: 'pharmacy', walletId: W.rx, sequencerUrl: url });
  pharmacy.setWalletSignerSource(() => walletSigner(EK.rx, W.rx));
  const reads = jest.spyOn(pharmacy, 'getPatientFullDrugHistory');
  const server = {
    getEntityNode: () => pharmacy,
    getConfig: () => ({ sequencerUrl: url }),
    sendResponse(_res: unknown, status: number, ok: boolean, data?: unknown, error?: string) { sent.push({ status, ok, data, error }); },
  };
  const route = buildPharmacyRoutes(server as any).find((r) => r.method === 'POST' && r.path === '/nfc/scan')!;
  const scan = (body: unknown) => route.handler({ headers: {} } as any, {} as any, {}, new URLSearchParams(), body);
  return { sent, reads, scan };
}

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-attestation-reads' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  seq = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  seq.registerNodeKey(memberNodeKey.nodeId, memberNodeKey.publicKeyHex, 'member');
  seq.registerNodeKey(prescriberNodeKey.nodeId, prescriberNodeKey.publicKeyHex, 'prescriber');
  seq.registerNodeKey(pharmacyNodeKey.nodeId, pharmacyNodeKey.publicKeyHex, 'pharmacy');
  seq.registerNodeKey(insurerNodeKey.nodeId, insurerNodeKey.publicKeyHex, 'insurer');
  seq.registerNodeKey(operatorNodeKey.nodeId, operatorNodeKey.publicKeyHex, 'operator');
  await seq.start();
  url = `http://127.0.0.1:${seq.getPort()}`;
  const fixtures = [[memberNodeKey, 'alice', 'member'], [memberNodeKey, 'bob', 'member'], [prescriberNodeKey, 'drP', 'prescriber'], [pharmacyNodeKey, 'rx', 'pharmacy']] as const;
  for (const [key, who, type] of fixtures) {
    const body = envelope('l2_registerEntity', { walletId: W[who], displayName: who, type, signingPublicKeyHex: deriveWalletSigningKey(EK[who]).publicKeyHex });
    const j = await rpcWith(byNode(key, body), body);
    if (j.error) throw new Error(`fixture registration of ${who} failed: ${j.error.message}`);
  }
  // Alice and Bob hold registrations on the ledger, so the sequencer issues them attestations; Alice has one fill.
  node.getSequencer().adminMutate('test: provision members', ({ provision }) => {
    provision(Field(BigInt(W.alice)), LIFECYCLE_ELIGIBLE);
    provision(Field(BigInt(W.bob)), LIFECYCLE_ELIGIBLE);
  });
  node.getSequencer().getClaimAccumulator().appendClaim(
    { memberWalletId: W.alice, ndcHash: '42', pharmacyWalletId: W.rx, prescriberWalletId: W.drP, dateOfService: '20261020', patientPayCents: '1500', planPayCents: '50000', operationType: '1', deductibleCreditCents: '0' },
    { receiptId: 'rcpt-attestation-reads', timestamp: Date.now(), ndc: '00378410591', brandName: 'Abacavir', tierLevel: 1 },
  );
  // Alice names Dr P as primary care, and Bob's device has asked for his own attestation.
  const link = envelope('l2_registerPcpAssignment', { memberWalletId: W.alice, prescriberWalletId: W.drP, effectiveDate: '2026-10-18' });
  const linked = await rpcWith(byWallet('alice', link), link);
  if (linked.error) throw new Error(`fixture PCP link failed: ${linked.error.message}`);
  const askBob = envelope('l2_requestAttestation', { walletId: W.bob });
  if ((await rpcWith(byWallet('bob', askBob), askBob)).result?.w !== W.bob) throw new Error('the fixture attestation for Bob was not issued');

  // Alice's device: a member node holding her wallet and enrollment key, its proxy as the member launcher configures it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attestation-reads-'));
  dirs.push(dir);
  const seed = new NautilusLocalState(dir);
  await seed.unlock(PIN);
  await seed.save({ version: 1, role: 'member', walletId: W.alice, enrollmentKey: EK.alice, onboarding: { phase: 'ready' }, lastSavedAt: new Date().toISOString() });
  seed.lock();
  device = new NautilusAppServer({
    role: 'member', port: 0, host: '127.0.0.1', sequencerUrl: url, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: DEVICE_ADMIN, rpcProxy: resolveRpcProxyPolicy({}, 'member node'),
  });
  device.registerRoutes(buildMemberRoutes(device));
  await device.getLocalState().unlock(PIN);
  await device.getLocalState().load();
  device.setEntityNode(new MemberNode({ role: 'member', walletId: W.alice, sequencerUrl: url }));
  await device.start();
  deviceUrl = `http://127.0.0.1:${device.getPort()}`;
  const unlocked = await deviceCall('POST', '/onboarding/unlock', { pin: PIN });
  session = { 'X-Device-Session': String(unlocked.json?.data?.deviceSession ?? '') };
  // The member app's Request Attestation: the node asks the sequencer, signed as the wallet (A10b).
  const issued = await deviceCall('POST', '/attestation/request', { expirySeconds: 86_400 }, session);
  tap = issued.json?.data;
  if (tap?.w !== W.alice) throw new Error(`the fixture attestation for Alice was not issued: ${JSON.stringify(issued.json)}`);
});

afterAll(async () => {
  await device?.stop();
  await seq?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('the gates', () => {
  test('l2_getAttestation takes the wallet gate that issuing one takes, and is no D1 read, which the plan and the operator always pass', () => {
    expect(L2RpcServer.WALLET_SIGNED_METHODS.l2_getAttestation).toBe('walletId'); // before: undefined, so D1 decided it and answered the plan and the operator
    expect(L2RpcServer.WALLET_SIGNED_METHODS.l2_requestAttestation).toBe('walletId');
    expect(L2RpcServer.walletSpokenFor('l2_getAttestation', { walletId: W.alice })).toBe(W.alice); // before: undefined, outside the wallet gate
    expect(memberDataSpecOf('l2_getAttestation')).toBeUndefined(); // before: { subject: 'wallet', param: 'walletId', readers: ['self'] }, beside the plan and the operator
    expect(callReadsMemberData('l2_getAttestation', { walletId: W.alice })).toBe(false); // before: true, as a D1 read
    expect(MEMBER_DATA_METHODS).toEqual({
      ...D1_BEFORE,
      l2_detectDuplicateClaims: { subject: 'enumeration', readers: [] },
      l2_verifyFinancialBalance: { subject: 'enumeration', readers: [] },
    }); // before: l2_getAttestation in it, the duplicate-claims and balance checks not
    expect(L2RpcServer.MEMBER_DATA_METHODS).toBe(MEMBER_DATA_METHODS);
  });
});

describe('l2_getAttestation at the sequencer', () => {
  test('answers no anonymous caller and no bearer, the operator\'s included, as issuing one answers none', async () => {
    const anonymous = await rpcWith({}, attestationOf(W.alice));
    expect(anonymous.result).toBeUndefined();          // before: Alice's signed attestation, good for a day
    expect(anonymous.error?.code).toBe(RPC_UNAUTHORIZED); // before: no error
    const wrong = await rpcWith({ Authorization: 'Bearer not-the-operator' }, attestationOf(W.alice));
    expect(wrong.result).toBeUndefined();              // before: Alice's attestation; the method checked no credential
    expect(wrong.error?.code).toBe(RPC_UNAUTHORIZED);  // before: no error
    const operator = await rpcWith(bearer, attestationOf(W.alice));
    expect(operator.result).toBeUndefined();           // before: Alice's attestation, as every D1 read answers the operator
    expect(operator.error?.code).toBe(RPC_UNAUTHORIZED); // before: no error
    expect(operator.error?.message).toMatch(/only that wallet's signature opens it, not a bearer token$/); // before: no error
    const ask = envelope('l2_requestAttestation', { walletId: W.alice });
    expect((await rpcWith(bearer, ask)).error?.code).toBe(RPC_UNAUTHORIZED);
  });

  test('answers no other wallet, even one presenting her attestation, nor her primary-care prescriber or a pharmacy', async () => {
    const asBob = attestationOf(W.alice);
    const bob = await rpcWith(byWallet('bob', asBob), asBob);
    expect(bob.result).toBeUndefined();                // before: Alice's attestation, to any signed wallet
    expect(bob.error?.code).toBe(RPC_UNAUTHORIZED);    // before: no error; as a D1 read, RPC_FORBIDDEN
    expect(bob.error?.message).toMatch(/signed by 1002, not by wallet 1001 it speaks for$/); // before: no error; as a D1 read, the read gate's reason
    const presenting = envelope('l2_getAttestation', { walletId: W.alice, memberAttestation: tap });
    expect((await rpcWith(byWallet('bob', presenting), presenting)).error?.code).toBe(RPC_UNAUTHORIZED); // before: answered; as a D1 read, RPC_FORBIDDEN
    const pcp = attestationOf(W.alice);
    expect((await rpcWith(byWallet('drP', pcp), pcp)).error?.code).toBe(RPC_UNAUTHORIZED); // before: answered; as a D1 read, RPC_FORBIDDEN
    const pharmacy = envelope('l2_getAttestation', { walletId: W.alice, memberAttestation: tap });
    expect((await rpcWith(byWallet('rx', pharmacy), pharmacy)).error?.code).toBe(RPC_UNAUTHORIZED); // before: answered; as a D1 read, RPC_FORBIDDEN
  });

  test('answers no node key, the plan\'s and an operator key included: a node is not the member', async () => {
    for (const key of [memberNodeKey, pharmacyNodeKey, prescriberNodeKey, insurerNodeKey, operatorNodeKey]) {
      const body = attestationOf(W.alice);
      const r = await rpcWith(byNode(key, body), body);
      expect([key.nodeId, r.result]).toEqual([key.nodeId, undefined]); // before: Alice's attestation, to every node key; as a D1 read, to the plan's and the operator key
      expect([key.nodeId, r.error?.code]).toEqual([key.nodeId, RPC_UNAUTHORIZED]); // before: no error; as a D1 read, RPC_FORBIDDEN for the other keys
      expect(r.error?.message).toMatch(/not by wallet 1001 it speaks for$/); // before: no error; as a D1 read, the read gate's reason for the other keys
    }
  });

  test('answers the wallet itself, signing as itself, and the plan and the operator no more than it issues them one', async () => {
    const own = attestationOf(W.alice);
    expect((await rpcWith(byWallet('alice', own), own)).result).toEqual(tap);
    const plan = attestationOf(W.alice);
    const asPlan = await rpcWith(byNode(insurerNodeKey, plan), plan);
    expect(asPlan.result).toBeUndefined();             // before: Alice's attestation, as every D1 read answers the plan
    expect(asPlan.error?.code).toBe(RPC_UNAUTHORIZED); // before: no error
    expect((await rpcWith(bearer, attestationOf(W.alice))).result).toBeUndefined(); // before: Alice's attestation, as every D1 read answers the operator
    const planAsks = envelope('l2_requestAttestation', { walletId: W.alice });
    expect((await rpcWith(byNode(insurerNodeKey, planAsks), planAsks)).error?.code).toBe(RPC_UNAUTHORIZED);
  });
});

describe('the member\'s device', () => {
  test('reads its own attestation through its node\'s /rpc proxy, which signs as the wallet; without its session, nothing', async () => {
    const read = { jsonrpc: '2.0', id: 1, method: 'l2_getAttestation', params: { walletId: W.alice } };
    const own = await deviceCall('POST', '/rpc', read, session);
    expect(own.status).toBe(200);
    expect(own.json?.result).toEqual(tap);
    expect((await deviceCall('POST', '/rpc', { ...read, id: 2 })).status).toBe(401);
  });

  test('its proxy reads no other member\'s attestation: the sequencer sees the device\'s wallet, not the one named', async () => {
    const r = await deviceCall('POST', '/rpc', { jsonrpc: '2.0', id: 3, method: 'l2_getAttestation', params: { walletId: W.bob } }, session);
    expect(r.json?.result).toBeUndefined();            // before: Bob's attestation, through any member's own node
    expect(r.json?.error?.code).toBe(RPC_UNAUTHORIZED); // before: no error; as a D1 read, RPC_FORBIDDEN
    expect(r.json?.error?.message).toMatch(/signed by 1001, not by wallet 1002 it speaks for$/); // before: no error; as a D1 read, the read gate's reason
  });
});

describe('the pharmacy counter', () => {
  test('a stranger who knows the wallet ID gets no attestation to present at the open /nfc/scan, so no drug history', async () => {
    const fetched = await rpcWith({}, attestationOf(W.alice));
    const c = counter();
    await c.scan({ attestation: fetched.result });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].status).toBe(400);                // before: 200 with Alice's fills (Abacavir), read signed as the pharmacy
    expect(c.sent[0].data).toBeUndefined();            // before: her full history and active medications
    expect(c.reads).not.toHaveBeenCalled();            // before: called with the attestation the sequencer handed out
  });

  test('nor do the operator and the plan: what they ask the sequencer for opens nothing at the counter', async () => {
    const plan = attestationOf(W.alice);
    const fetched = [await rpcWith(bearer, attestationOf(W.alice)), await rpcWith(byNode(insurerNodeKey, plan), plan)];
    for (const answer of fetched) {
      const c = counter();
      await c.scan({ attestation: answer.result });
      expect(c.sent).toHaveLength(1);
      expect(c.sent[0].status).toBe(400);              // before: 200 with Alice's fills (Abacavir), read signed as the pharmacy
      expect(c.sent[0].data).toBeUndefined();          // before: her full history and active medications
      expect(c.reads).not.toHaveBeenCalled();          // before: called with the attestation the sequencer handed the operator or the plan
    }
  });

  test('the member\'s own tap still opens her history at the counter, and at D1\'s attestation reader', async () => {
    const c = counter();
    await c.scan({ attestation: tap });
    expect(c.sent[0]).toMatchObject({ status: 200, ok: true });
    expect(c.sent[0].data.fullHistory.map((v: any) => v.brandName)).toEqual(['Abacavir']);
    const withTap = envelope('l2_getClaimsByMember', { walletId: W.alice, memberAttestation: tap });
    expect((await rpcWith(byWallet('rx', withTap), withTap)).result.map((e: any) => e.metadata.brandName)).toEqual(['Abacavir']);
  });
});
