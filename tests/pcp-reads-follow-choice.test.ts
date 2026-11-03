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
 * A primary-care prescriber reads a member's claims only while the member names it and the plan keeps it active (A-59).
 *
 * What was wrong: the sequencer's 'pcp' reader opened a member's claims, receipts, rebuilt accumulator and directory
 * entry to every wallet the member had ever named as primary care. Its links only grew, and the check looked at neither
 * the member's later choice nor the provider registry, so a prescriber the member had left, one the plan had suspended,
 * and a wallet the plan never credentialed all kept reading everything: drug names, dates and amounts.
 *
 * Now the reader is the prescriber the member names now, and only while the provider registry shows it a credentialed,
 * active prescriber; where an engine is attached, the engine's record of the member's choice must name it too. A
 * prescriber's patient list follows the member's choice the same way.
 *
 * On a real sequencer server, as tests/member-data-reads.test.ts.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_FORBIDDEN } from '../src/l2/l2-rpc-server.js';
import { ProviderLifecycle } from '../src/l2/provider-registry-types.js';
import { LIFECYCLE_ELIGIBLE } from '../src/engine/lifecycle.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-pcp-reads';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const memberNode = generateNodeKey('member-node');
const prescriberNode = generateNodeKey('prescriber-node');
const pharmacyNode = generateNodeKey('pharmacy-node');
const EK = {
  member: 'ek-member-' + 'a'.repeat(32),
  drA: 'ek-dr-a-' + 'b'.repeat(32),
  drB: 'ek-dr-b-' + 'c'.repeat(32),
  drC: 'ek-dr-c-' + 'd'.repeat(32),
  drX: 'ek-dr-x-' + 'e'.repeat(32),
  rx: 'ek-rx-' + 'f'.repeat(32),
};
const W = { member: '1001', drA: '2001', drB: '2002', drC: '2003', drX: '2004', rx: '3001' };
type Who = keyof typeof W;

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
const byWallet = (who: Who, body: string) => signRequest({ ...walletSigner(EK[who], W[who]), method: 'POST', path: '/rpc', body });
const byNode = (key: ReturnType<typeof generateNodeKey>, body: string) => signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });

/** The four reads the 'pcp' reader opens, each asked for the member by a wallet: answered or refused. */
const PCP_READS = ['l2_getClaimsByMember', 'l2_getReceiptsByWallet', 'l2_reconstructAccumulator', 'l2_getEntity'] as const;
async function readsAs(who: Who): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const method of PCP_READS) {
    const body = envelope(method, { walletId: W.member });
    const r = await rpcWith(byWallet(who, body), body);
    out[method] = r.error === undefined ? 'answered' : r.error.code === RPC_FORBIDDEN ? 'refused' : `error ${r.error.code}: ${r.error.message}`;
  }
  return out;
}
const ALL_ANSWERED = Object.fromEntries(PCP_READS.map((m) => [m, 'answered']));
const ALL_REFUSED = Object.fromEntries(PCP_READS.map((m) => [m, 'refused']));

/** The member names a primary-care prescriber, signed as its wallet, as its device registers the choice. */
async function memberNames(who: Who): Promise<void> {
  const body = envelope('l2_registerPcpAssignment', { memberWalletId: W.member, prescriberWalletId: W[who], effectiveDate: '2026-11-03' });
  const r = await rpcWith(byWallet('member', body), body);
  if (r.error) throw new Error(`naming ${who} failed: ${r.error.message}`);
}
async function planSetsStatus(who: Who, newState: ProviderLifecycle): Promise<void> {
  const r = await rpcWith(bearer, envelope('l2_updateProviderStatus', { walletId: W[who], newState }));
  if (r.error) throw new Error(`setting ${who} to ${newState} failed: ${r.error.message}`);
}
/** A prescriber's own patient list, as its node reads it. */
async function patientsOf(who: Who): Promise<string[]> {
  const body = envelope('l2_getPcpAssignments', { prescriberWalletId: W[who] });
  const r = await rpcWith(byWallet(who, body), body);
  if (r.error) throw new Error(`the patient list of ${who} failed: ${r.error.message}`);
  return (r.result as Array<{ memberWalletId: string }>).map((a) => a.memberWalletId);
}
/** An engine whose record names `pcp` as the member's primary-care prescriber; it quotes nothing. */
function engineNaming(pcp: Who | null) {
  return { quote: () => null, primaryCareOf: (memberWalletId: string) => (memberWalletId === W.member && pcp ? W[pcp] : null) };
}

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-pcp-reads-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  server.registerNodeKey(prescriberNode.nodeId, prescriberNode.publicKeyHex, 'prescriber');
  server.registerNodeKey(pharmacyNode.nodeId, pharmacyNode.publicKeyHex, 'pharmacy');
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
  const register = async (key: ReturnType<typeof generateNodeKey>, who: Who, type: string) => {
    const body = envelope('l2_registerEntity', { walletId: W[who], displayName: who, type, signingPublicKeyHex: deriveWalletSigningKey(EK[who]).publicKeyHex });
    const j = await rpcWith(byNode(key, body), body);
    if (j.error) throw new Error(`fixture registration of ${who} failed: ${j.error.message}`);
  };
  await register(memberNode, 'member', 'member');
  for (const who of ['drA', 'drB', 'drC', 'drX'] as const) await register(prescriberNode, who, 'prescriber');
  await register(pharmacyNode, 'rx', 'pharmacy');
  // Three of the prescribers and the pharmacy are credentialed, so the provider registry holds them active. Dr X is
  // in the directory as a prescriber, by its own node's registration, and was never credentialed.
  const credential = async (who: Who, providerType: 'prescriber' | 'pharmacy') => {
    const j = await rpcWith(bearer, envelope('l2_credentialProvider', { walletId: W[who], displayName: who, providerType }));
    if (j.error) throw new Error(`fixture credentialing of ${who} failed: ${j.error.message}`);
  };
  for (const who of ['drA', 'drB', 'drC'] as const) await credential(who, 'prescriber');
  await credential('rx', 'pharmacy');
  node.getSequencer().adminMutate('test: provision the member', ({ provision }) => {
    provision(Field(BigInt(W.member)), LIFECYCLE_ELIGIBLE);
  });
});

afterAll(async () => { await server.stop(); });

describe('the member\'s choice', () => {
  test('the prescriber the member names reads its claims, receipts, accumulator and directory entry, and lists it', async () => {
    await memberNames('drA');
    expect(await readsAs('drA')).toEqual(ALL_ANSWERED);
    expect(await patientsOf('drA')).toEqual([W.member]);
  });

  test('a prescriber the member named before reads nothing once it names another, and no longer lists it', async () => {
    await memberNames('drA');
    await memberNames('drB');
    expect(await readsAs('drA')).toEqual(ALL_REFUSED);   // before: every read answered, through the link kept for good
    expect(await readsAs('drB')).toEqual(ALL_ANSWERED);
    expect(await patientsOf('drA')).toEqual([]);         // before: the member, for good
    expect(await patientsOf('drB')).toEqual([W.member]);
  });

  test('naming a former prescriber again restores that one, and only that one', async () => {
    await memberNames('drB');
    await memberNames('drA');
    expect(await readsAs('drA')).toEqual(ALL_ANSWERED);
    expect(await readsAs('drB')).toEqual(ALL_REFUSED);   // before: every read answered
    expect(await patientsOf('drA')).toEqual([W.member]);
    expect(await patientsOf('drB')).toEqual([]);
  });

  test('the refusal says who may read', async () => {
    await memberNames('drA');
    const body = envelope('l2_getClaimsByMember', { walletId: W.member });
    const r = await rpcWith(byWallet('drB', body), body);
    expect(r.error?.code).toBe(RPC_FORBIDDEN);
    expect(r.error?.message).toMatch(/or the primary-care prescriber it names now, while the plan keeps that prescriber active/);
  });
});

describe('the provider registry', () => {
  test('a suspended prescriber reads nothing, reads again once the plan reinstates it, and nothing once terminated', async () => {
    await memberNames('drC');
    expect(await readsAs('drC')).toEqual(ALL_ANSWERED);
    await planSetsStatus('drC', ProviderLifecycle.SUSPENDED);
    expect(await readsAs('drC')).toEqual(ALL_REFUSED);   // before: every read answered
    await planSetsStatus('drC', ProviderLifecycle.ACTIVE);
    expect(await readsAs('drC')).toEqual(ALL_ANSWERED);
    await planSetsStatus('drC', ProviderLifecycle.TERMINATED);
    expect(await readsAs('drC')).toEqual(ALL_REFUSED);   // before: every read answered
    // The list still names the member: whom a suspension or a termination leaves without primary care, for the plan.
    expect(await patientsOf('drC')).toEqual([W.member]);
    const asPlan = await rpcWith(bearer, envelope('l2_getPcpAssignments', { prescriberWalletId: W.drC }));
    expect((asPlan.result as Array<{ memberWalletId: string }>).map((a) => a.memberWalletId)).toEqual([W.member]);
  });

  test('a wallet that is not a credentialed, active prescriber opens nothing by being named', async () => {
    await memberNames('drX');                             // in the directory as a prescriber, never credentialed
    expect(await readsAs('drX')).toEqual(ALL_REFUSED);   // before: every read answered
    await memberNames('rx');                              // a credentialed pharmacy
    expect(await readsAs('rx')).toEqual(ALL_REFUSED);    // before: every read answered
  });
});

describe('the engine\'s record of the member\'s choice', () => {
  afterEach(() => { server.setMemberCostQuoteProvider(null); });

  test('must name the same prescriber as the member\'s latest link, where an engine is attached', async () => {
    await memberNames('drA');
    server.setMemberCostQuoteProvider(engineNaming('drB'));
    expect(await readsAs('drA')).toEqual(ALL_REFUSED);   // the link names Dr A; the engine's record, Dr B
    expect(await readsAs('drB')).toEqual(ALL_REFUSED);   // and the engine's record alone opens nothing
    server.setMemberCostQuoteProvider(engineNaming(null));
    expect(await readsAs('drA')).toEqual(ALL_REFUSED);   // an engine that records no choice for the member
    server.setMemberCostQuoteProvider(engineNaming('drA'));
    expect(await readsAs('drA')).toEqual(ALL_ANSWERED);
  });

  test('an engine that registers only its quote leaves the decision to the ledger', async () => {
    await memberNames('drA');
    server.setMemberCostQuoteProvider(() => null);
    expect(await readsAs('drA')).toEqual(ALL_ANSWERED);
    expect(await readsAs('drB')).toEqual(ALL_REFUSED);
  });
});
