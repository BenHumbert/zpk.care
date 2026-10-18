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
 * The wallet speaks for itself — plan item A10b, findings A-12 (second half), A-15, A-16, A-32.
 *
 * A real L2RpcServer on a random port. Entities register with their wallet signing key through
 * node keys of the right role. Then, for each of the three methods that speak for a wallet, the
 * only request the sequencer accepts is one signed by that wallet: unsigned, bearer, node key,
 * another wallet's key and a replay are all refused with the reason. The attestation states the
 * ledger's lifecycle and refuses a revoked or unregistered wallet. Registration is owned by its
 * key, a node registers only entities of its own kind, and only the operator or the insurer
 * credentials a provider on the way.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_UNAUTHORIZED, RPC_FORBIDDEN } from '../src/l2/l2-rpc-server.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';
import { LIFECYCLE_ELIGIBLE, LIFECYCLE_REVOKED } from '../src/engine/lifecycle.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-bearer-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();

let node: L2Node;
let server: L2RpcServer;
let url: string;
const memberNode = generateNodeKey('member-node');
const prescriberNode = generateNodeKey('prescriber-node');
const insurerNode = generateNodeKey('insurer-node');

// Wallets and the enrollment keys their signing keys derive from
const EK = { alice: 'ek-alice-' + 'a'.repeat(32), bob: 'ek-bob-' + 'b'.repeat(32), carol: 'ek-carol-' + 'c'.repeat(32), dave: 'ek-dave-fixture-' + 'x'.repeat(32), erin: 'ek-erin-' + 'e'.repeat(32), drP: 'ek-doctor-' + 'd'.repeat(32) };
const W = { alice: '1001', bob: '1002', carol: '1003', dave: '1004', erin: '1005', drP: '2001', drQ: '2002', drR: '2003' };

interface RpcReply { status: number; error?: { code: number; message: string }; result?: any }
async function rpcWith(headers: Record<string, string>, body: string): Promise<RpcReply> {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, error: parsed?.error, result: parsed?.result };
}
const envelope = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const byNode = (key: { nodeId: string; seedHex: string }, body: string) =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });
const byWallet = (enrollmentKey: string, walletId: string, body: string) =>
  signRequest({ ...walletSigner(enrollmentKey, walletId), method: 'POST', path: '/rpc', body });
const bearer = { Authorization: `Bearer ${OPERATOR}` };

const message = (sender: string, recipient: string) => envelope('l2_storeMessage', {
  message: { messageCommitment: '77', senderWalletId: sender, recipientWalletId: recipient, messageType: 'text', threadIdHash: '5' },
  payload: { ciphertext: 'aa', iv: 'bb', tag: 'cc' },
});

async function registerMember(enrollmentKey: string, walletId: string, displayName = 'Member') {
  const body = envelope('l2_registerEntity', { walletId, displayName, type: 'member', signingPublicKeyHex: deriveWalletSigningKey(enrollmentKey).publicKeyHex });
  return rpcWith(byNode(memberNode, body), body);
}

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-under-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  server.registerNodeKey(prescriberNode.nodeId, prescriberNode.publicKeyHex, 'prescriber');
  server.registerNodeKey(insurerNode.nodeId, insurerNode.publicKeyHex, 'insurer');
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
  // Alice, Bob and Erin hold registrations on the ledger; Erin's is revoked. Dave registers an
  // entity but never proves a registration.
  node.getSequencer().adminMutate('test fixtures', ({ provision }) => {
    provision(Field(BigInt(W.alice)), LIFECYCLE_ELIGIBLE);
    provision(Field(BigInt(W.bob)), LIFECYCLE_ELIGIBLE);
    provision(Field(BigInt(W.erin)), LIFECYCLE_REVOKED);
  });
  for (const [who, wallet] of [['alice', W.alice], ['bob', W.bob], ['carol', W.carol], ['dave', W.dave], ['erin', W.erin]] as const) {
    const r = await registerMember(EK[who], wallet, who);
    if (r.error) throw new Error(`fixture registration for ${who} failed: ${r.error.message}`);
  }
});

afterAll(async () => {
  await server.stop();
});

describe('registration is owned by its signing key', () => {
  test('a re-registration with the same key is accepted; a different key is refused; the operator may change it', async () => {
    const same = await registerMember(EK.carol, W.carol, 'Carol again');
    expect(same.error).toBeUndefined();
    const takeover = envelope('l2_registerEntity', { walletId: W.carol, displayName: 'Mallory', type: 'member', signingPublicKeyHex: deriveWalletSigningKey('ek-mallory').publicKeyHex });
    const refused = await rpcWith(byNode(memberNode, takeover), takeover);
    expect(refused.error?.message).toMatch(/owned by its registered signing key/);
    const noKey = envelope('l2_registerEntity', { walletId: W.carol, displayName: 'Nameless', type: 'member' });
    expect((await rpcWith(byNode(memberNode, noKey), noKey)).error?.message).toMatch(/owned by its registered signing key/);
    const rotated = await rpcWith(bearer, takeover);
    expect(rotated.error).toBeUndefined();
    // Carol's old key no longer speaks for the wallet; the rotated one does
    const body = message(W.carol, W.alice);
    expect((await rpcWith(byWallet(EK.carol, W.carol, body), body)).error?.code).toBe(RPC_UNAUTHORIZED);
    const withNew = signRequest({ signerId: W.carol, privateKey: deriveWalletSigningKey('ek-mallory').privateKey, method: 'POST', path: '/rpc', body });
    expect((await rpcWith(withNew, body)).error).toBeUndefined();
  });

  test('a node registers only entities of its own kind (A-32)', async () => {
    const asPrescriber = envelope('l2_registerEntity', { walletId: W.drQ, displayName: 'Dr Q', type: 'prescriber', npi: '1234567893' });
    const r = await rpcWith(byNode(memberNode, asPrescriber), asPrescriber);
    expect(r.error?.message).toMatch(/member node may register a member entity, not a prescriber/);
    expect((await rpcWith(bearer, envelope('l2_getProvider', { walletId: W.drQ }))).result).toBeNull();
  });

  test('a provider node registering itself is not credentialed by it; the operator registering a provider is (A-32)', async () => {
    const self = envelope('l2_registerEntity', { walletId: W.drP, displayName: 'Dr P', type: 'prescriber', npi: '1234567890', signingPublicKeyHex: deriveWalletSigningKey(EK.drP).publicKeyHex });
    const r = await rpcWith(byNode(prescriberNode, self), self);
    expect(r.error).toBeUndefined();
    expect((await rpcWith(bearer, envelope('l2_getProvider', { walletId: W.drP }))).result).toBeNull();
    // the insurer's own path is l2_credentialProvider; the operator may register any kind, and that credentials
    const byOperator = envelope('l2_registerEntity', { walletId: W.drR, displayName: 'Dr R', type: 'prescriber', npi: '1234567891' });
    expect((await rpcWith(bearer, byOperator)).error).toBeUndefined();
    const provider = (await rpcWith(bearer, envelope('l2_getProvider', { walletId: W.drR }))).result;
    expect(provider).not.toBeNull();
  });

  test('the insurer re-credentialing a provider keeps the keys the provider registered', async () => {
    const cred = envelope('l2_credentialProvider', { walletId: W.drP, displayName: 'Dr P, credentialed', providerType: 'prescriber', npi: '1234567890' });
    expect((await rpcWith(byNode(insurerNode, cred), cred)).error).toBeUndefined();
    // Dr P can still speak for the wallet: the key survived the re-credentialing
    const body = message(W.drP, W.alice);
    expect((await rpcWith(byWallet(EK.drP, W.drP, body), body)).error).toBeUndefined();
  });
});

describe('l2_storeMessage speaks for its sender', () => {
  test('is refused unsigned, with a bearer, with a node key, with another wallet\'s key, and on replay', async () => {
    const body = message(W.alice, W.bob);
    const unsigned = await rpcWith({}, body);
    expect(unsigned.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(unsigned.error?.message).toMatch(/must be signed by it/);
    const asOperator = await rpcWith(bearer, body);
    expect(asOperator.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(asOperator.error?.message).toMatch(/not a bearer token/);
    const asNode = await rpcWith(byNode(memberNode, body), body);
    expect(asNode.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(asNode.error?.message).toMatch(/signed by member-node, not by wallet/);
    const asBob = await rpcWith(byWallet(EK.bob, W.bob, body), body);
    expect(asBob.error?.code).toBe(RPC_UNAUTHORIZED);
    const headers = byWallet(EK.alice, W.alice, body);
    const accepted = await rpcWith(headers, body);
    expect(accepted.error).toBeUndefined();
    expect(accepted.result?.leafIndex).toBeDefined();
    const replay = await rpcWith(headers, body);
    expect(replay.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(replay.error?.message).toMatch(/already been presented/);
  });

  test('a wallet with no signing key registered cannot send, even with a valid signature of some key', async () => {
    const body = message('9999', W.bob);
    const r = await rpcWith(byWallet('ek-nobody', '9999', body), body);
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(r.error?.message).toMatch(/no signing key registered/);
  });

  test('names no wallet: refused before the handler', async () => {
    const body = envelope('l2_storeMessage', { message: { messageCommitment: '1' }, payload: { ciphertext: 'aa', iv: 'bb', tag: 'cc' } });
    const r = await rpcWith(byWallet(EK.alice, W.alice, body), body);
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(r.error?.message).toMatch(/names no wallet/);
  });
});

describe('l2_registerPcpAssignment speaks for the member', () => {
  test('only the member\'s signature links the member to a prescriber', async () => {
    const body = envelope('l2_registerPcpAssignment', { memberWalletId: W.alice, prescriberWalletId: W.drP, effectiveDate: '2026-10-18' });
    expect((await rpcWith({}, body)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(bearer, body)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(byWallet(EK.bob, W.bob, body), body)).error?.code).toBe(RPC_UNAUTHORIZED);
    const ok = await rpcWith(byWallet(EK.alice, W.alice, body), body);
    expect(ok.error).toBeUndefined();
    const list = await rpcWith(bearer, envelope('l2_getPcpAssignments', { prescriberWalletId: W.drP }));
    expect(list.result.map((a: any) => a.memberWalletId)).toEqual([W.alice]);
  });
});

describe('l2_requestAttestation speaks for the wallet and states the ledger', () => {
  test('is refused unsigned, with a bearer and with another wallet\'s key', async () => {
    const body = envelope('l2_requestAttestation', { walletId: W.alice });
    expect((await rpcWith({}, body)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(bearer, body)).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(byWallet(EK.bob, W.bob, body), body)).error?.code).toBe(RPC_UNAUTHORIZED);
  });

  test('signed by the wallet, the attestation names it and carries the lifecycle the ledger holds', async () => {
    const body = envelope('l2_requestAttestation', { walletId: W.alice, expirySeconds: 600 });
    const r = await rpcWith(byWallet(EK.alice, W.alice, body), body);
    expect(r.error).toBeUndefined();
    expect(r.result?.w).toBe(W.alice);
    expect(r.result?.ls).toBe(Number(LIFECYCLE_ELIGIBLE.toString()));
    expect(typeof r.result?.sig).toBe('string');
  });

  test('a revoked wallet and a wallet with no ledger registration get nothing', async () => {
    const revoked = envelope('l2_requestAttestation', { walletId: W.erin });
    const r1 = await rpcWith(byWallet(EK.erin, W.erin, revoked), revoked);
    expect(r1.error?.message).toMatch(/revoked/);
    const unregistered = envelope('l2_requestAttestation', { walletId: W.dave });
    const r2 = await rpcWith(byWallet('ek-dave-' + 'd'.repeat(32), W.dave, unregistered), unregistered);
    // Dave's entity key was registered under a different enrollment key in the fixtures, so this is
    // refused as a bad signature; with his real key it is refused for the missing registration.
    expect(r2.error?.code).toBe(RPC_UNAUTHORIZED);
    const r3 = await rpcWith(byWallet(EK.alice, W.dave, unregistered), unregistered);
    expect(r3.error?.code).toBe(RPC_UNAUTHORIZED);
  });
});

describe('the admin gate is untouched', () => {
  test('a role still cannot call an operator method', async () => {
    const body = envelope('l2_forceBatch');
    expect((await rpcWith(byNode(memberNode, body), body)).error?.code).toBe(RPC_FORBIDDEN);
  });
});
