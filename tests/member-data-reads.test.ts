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
 * A member's data answers no bare wallet ID — plan item D1, finding A-2 (the last critical one).
 *
 * On a real sequencer server: the member-data reads refuse an anonymous caller; the operator and a
 * node key with the insurer role read everything; a wallet reads its own data and nothing of another
 * wallet's; a prescriber the member named as primary care reads the member's claims; any signed caller
 * presenting the member's own attestation reads them too, and a forged or foreign attestation does
 * not; a thread answers a wallet only its own messages; enumerations answer the plan and the operator
 * alone; the directory serves providers to anyone and members to credentials; the entity list behind
 * the visualizer needs a credential.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_UNAUTHORIZED, RPC_FORBIDDEN } from '../src/l2/l2-rpc-server.js';
import { LIFECYCLE_ELIGIBLE } from '../src/engine/lifecycle.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const memberNode = generateNodeKey('member-node');
const prescriberNode = generateNodeKey('prescriber-node');
const pharmacyNode = generateNodeKey('pharmacy-node');
const insurerNode = generateNodeKey('insurer-node');
const EK = { alice: 'ek-alice-' + 'a'.repeat(32), bob: 'ek-bob-' + 'b'.repeat(32), drP: 'ek-drp-' + 'c'.repeat(32), rx: 'ek-rx-' + 'd'.repeat(32) };
const W = { alice: '1001', bob: '1002', drP: '2001', rx: '3001' };

let node: L2Node;
let server: L2RpcServer;
let url: string;

function envelope(method: string, params: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}
async function rpcWith(headers: Record<string, string>, body: string) {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return (await r.json()) as { result?: any; error?: { code: number; message: string } };
}
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const byWallet = (ek: string, walletId: string, body: string) => signRequest({ ...walletSigner(ek, walletId), method: 'POST', path: '/rpc', body });
const byNode = (key: ReturnType<typeof generateNodeKey>, body: string) => signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-reads-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  server.registerNodeKey(prescriberNode.nodeId, prescriberNode.publicKeyHex, 'prescriber');
  server.registerNodeKey(pharmacyNode.nodeId, pharmacyNode.publicKeyHex, 'pharmacy');
  server.registerNodeKey(insurerNode.nodeId, insurerNode.publicKeyHex, 'insurer');
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
  const register = async (key: ReturnType<typeof generateNodeKey>, who: keyof typeof W, type: string) => {
    const body = envelope('l2_registerEntity', { walletId: W[who], displayName: who, type, signingPublicKeyHex: deriveWalletSigningKey(EK[who]).publicKeyHex });
    const j = await rpcWith(byNode(key, body), body);
    if (j.error) throw new Error(`fixture registration of ${who} failed: ${j.error.message}`);
  };
  await register(memberNode, 'alice', 'member');
  await register(memberNode, 'bob', 'member');
  await register(prescriberNode, 'drP', 'prescriber');
  await register(pharmacyNode, 'rx', 'pharmacy');
  // Alice and Bob exist on the ledger, so attestations can be issued for them.
  node.getSequencer().adminMutate('test: provision members', ({ provision }) => {
    provision(Field(BigInt(W.alice)), LIFECYCLE_ELIGIBLE);
    provision(Field(BigInt(W.bob)), LIFECYCLE_ELIGIBLE);
  });
});

afterAll(async () => { await server.stop(); });

describe('a member\'s claims, receipts and accumulator', () => {
  const claims = envelope('l2_getClaimsByMember', { walletId: W.alice });

  test('answer no anonymous caller, and no bearer that is not the operator\'s', async () => {
    expect((await rpcWith({}, claims)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith({ Authorization: 'Bearer not-the-operator' }, claims)).error?.code).toBe(RPC_UNAUTHORIZED);
    for (const method of ['l2_getReceiptsByWallet', 'l2_reconstructAccumulator', 'l2_getWalletState', 'l2_getWalletWitnesses', 'l2_getMessagesByWallet']) {
      expect((await rpcWith({}, envelope(method, { walletId: W.alice }))).error?.code).toBe(RPC_UNAUTHORIZED);
    }
  });

  test('answer the operator and the plan', async () => {
    expect((await rpcWith(bearer, claims)).result).toEqual([]);
    expect((await rpcWith(byNode(insurerNode, claims), claims)).result).toEqual([]);
  });

  test('answer the wallet itself and refuse another wallet', async () => {
    expect((await rpcWith(byWallet(EK.alice, W.alice, claims), claims)).result).toEqual([]);
    const other = await rpcWith(byWallet(EK.bob, W.bob, claims), claims);
    expect(other.error?.code).toBe(RPC_FORBIDDEN);
    expect(other.error?.message).toMatch(/answers that wallet, the plan or the operator/);
    const receipts = envelope('l2_getReceiptsByWallet', { walletId: W.alice });
    expect((await rpcWith(byWallet(EK.alice, W.alice, receipts), receipts)).result).toEqual([]);
    expect((await rpcWith(byWallet(EK.bob, W.bob, receipts), receipts)).error?.code).toBe(RPC_FORBIDDEN);
  });

  test('a prescriber node key is not a wallet, and a member node key is not the member', async () => {
    expect((await rpcWith(byNode(prescriberNode, claims), claims)).error?.code).toBe(RPC_FORBIDDEN);
    expect((await rpcWith(byNode(memberNode, claims), claims)).error?.code).toBe(RPC_FORBIDDEN);
  });

  test('answer the prescriber the member named as primary care, for that member only', async () => {
    expect((await rpcWith(byWallet(EK.drP, W.drP, claims), claims)).error?.code).toBe(RPC_FORBIDDEN);
    const link = envelope('l2_registerPcpAssignment', { memberWalletId: W.alice, prescriberWalletId: W.drP, effectiveDate: '2026-10-18' });
    expect((await rpcWith(byWallet(EK.alice, W.alice, link), link)).error).toBeUndefined();
    expect((await rpcWith(byWallet(EK.drP, W.drP, claims), claims)).result).toEqual([]);
    const bobs = envelope('l2_getClaimsByMember', { walletId: W.bob });
    expect((await rpcWith(byWallet(EK.drP, W.drP, bobs), bobs)).error?.code).toBe(RPC_FORBIDDEN);
    // The directory entry of a member follows the same rule; a provider's entry is public.
    const aliceEntity = envelope('l2_getEntity', { walletId: W.alice });
    expect((await rpcWith({}, aliceEntity)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(byWallet(EK.drP, W.drP, aliceEntity), aliceEntity)).result?.type).toBe('member');
    const drEntity = envelope('l2_getEntity', { walletId: W.drP });
    expect((await rpcWith({}, drEntity)).result?.type).toBe('prescriber');
  });

  test('answer a signed caller presenting the member\'s own attestation, and not a foreign or forged one', async () => {
    const ask = envelope('l2_requestAttestation', { walletId: W.alice });
    const att = (await rpcWith(byWallet(EK.alice, W.alice, ask), ask)).result;
    expect(att?.w).toBe(W.alice);
    const withTap = envelope('l2_getClaimsByMember', { walletId: W.alice, memberAttestation: att });
    expect((await rpcWith(byWallet(EK.rx, W.rx, withTap), withTap)).result).toEqual([]);
    expect((await rpcWith(byNode(pharmacyNode, withTap), withTap)).result).toEqual([]);
    expect((await rpcWith({}, withTap)).error?.code).toBe(RPC_UNAUTHORIZED);
    const askBob = envelope('l2_requestAttestation', { walletId: W.bob });
    const bobAtt = (await rpcWith(byWallet(EK.bob, W.bob, askBob), askBob)).result;
    const foreign = envelope('l2_getClaimsByMember', { walletId: W.alice, memberAttestation: bobAtt });
    expect((await rpcWith(byWallet(EK.rx, W.rx, foreign), foreign)).error?.code).toBe(RPC_FORBIDDEN);
    const forged = envelope('l2_getClaimsByMember', { walletId: W.alice, memberAttestation: { ...bobAtt, w: W.alice } });
    expect((await rpcWith(byWallet(EK.rx, W.rx, forged), forged)).error?.code).toBe(RPC_FORBIDDEN);
    const state = envelope('l2_getWalletState', { walletId: W.alice, memberAttestation: att });
    expect((await rpcWith(byWallet(EK.rx, W.rx, state), state)).result?.walletId).toBe(W.alice);
  });
});

describe('threads, enumerations and the directory', () => {
  test('a thread answers any signed caller, a wallet only with its own messages', async () => {
    const thread = envelope('l2_getMessagesByThread', { threadIdHash: '77' });
    expect((await rpcWith({}, thread)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect(Array.isArray((await rpcWith(byWallet(EK.bob, W.bob, thread), thread)).result)).toBe(true);
    expect(Array.isArray((await rpcWith(bearer, thread)).result)).toBe(true);
  });

  test('the receipt list, the audit log and claims by drug answer the plan and the operator only', async () => {
    for (const [method, params] of [['l2_getAllReceipts', {}], ['l2_getAuditLog', {}], ['l2_getClaimsByNdc', { ndcHash: '5' }]] as const) {
      const body = envelope(method, params as Record<string, unknown>);
      expect((await rpcWith({}, body)).error?.code).toBe(RPC_UNAUTHORIZED);
      expect((await rpcWith(byWallet(EK.alice, W.alice, body), body)).error?.code).toBe(RPC_FORBIDDEN);
      expect((await rpcWith(bearer, body)).error).toBeUndefined();
      expect((await rpcWith(byNode(insurerNode, body), body)).error).toBeUndefined();
    }
  });

  test('a prescriber\'s patient list answers that prescriber and the plan', async () => {
    const list = envelope('l2_getPcpAssignments', { prescriberWalletId: W.drP });
    expect((await rpcWith({}, list)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(byWallet(EK.alice, W.alice, list), list)).error?.code).toBe(RPC_FORBIDDEN);
    expect((await rpcWith(byWallet(EK.drP, W.drP, list), list)).result.map((a: any) => a.memberWalletId)).toEqual([W.alice]);
    expect((await rpcWith(bearer, list)).result).toHaveLength(1);
  });

  test('a wallet\'s encryption key answers any signed caller and no anonymous one', async () => {
    const key = envelope('l2_getEncryptionKey', { walletId: W.alice });
    expect((await rpcWith({}, key)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(byWallet(EK.bob, W.bob, key), key)).error).toBeUndefined();
    expect((await rpcWith(byNode(prescriberNode, key), key)).error).toBeUndefined();
  });

  test('the entity list behind the visualizer needs the operator or the plan', async () => {
    const anon = await fetch(`${url}/viz/entities`);
    expect(anon.status).toBe(401);
    const asOperator = await fetch(`${url}/viz/entities`, { headers: bearer });
    expect(asOperator.status).toBe(200);
    expect(((await asOperator.json()) as any[]).some((e) => e.walletId === W.alice)).toBe(true);
    const asPlan = await fetch(`${url}/viz/entities`, { headers: signRequest({ signerId: insurerNode.nodeId, privateKey: privateKeyFromSeedHex(insurerNode.seedHex), method: 'GET', path: '/viz/entities' }) });
    expect(asPlan.status).toBe(200);
  });
});
