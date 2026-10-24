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
 * A node's /rpc proxy does not lend its own read rights to whoever reaches its port (review of the pricing fixes,
 * security lens, F1).
 *
 * What was wrong: the insurer node's /rpc proxy forwards l2_estimateCost, checks no caller credential, and signs what
 * it forwards with the insurer node key, which the sequencer's D1 gate admits as the plan for any member. Anyone who
 * could reach the insurer port, which also serves the marketplace to employers, got any enrolled member's quote: its
 * plan's coverage of a drug, its phase, and at a large quantity its exact remaining deductible. An unknown wallet
 * answered "not a member enrolled with the engine", so the proxy was also an enrollment oracle.
 *
 * Now a node's proxy forwards a read of a member's data (the D1 table, src/l2/member-data-methods.ts) only for its own
 * administrator; a member node's proxy answers only the device's session, as before. And since the owner's decision of
 * 2026-10-19 the insurer, pharmacy and prescriber proxies do not forward l2_estimateCost at all, for anyone: the
 * insurer's Cost Estimator reaches a quote through the node's own POST /pricing/estimate, behind its admin credential
 * (tests/insurer-pricing-route.test.ts). The node-credential rule stays for any member-data read a non-member node's
 * proxy is configured to forward.
 *
 * The sweep of the open routes (2026-10-24) put the member's attestation (l2_getAttestation) in the table: it is the
 * tap that opens the member's drug history, and it had answered anyone who named the wallet. A proxy configured to
 * forward it then forwarded it only for the node's administrator, and the sequencer read it under the node's key as the
 * plan. The security review of the sweep fixes (2026-10-24) found that no node's key should read it: the plan's key and
 * the operator's credentials took the member's identity at the counter, though A10b refuses them one when they ask the
 * sequencer to issue it. Now the attestation answers only the wallet's own signature, as issuing one does, and has left
 * the table, so no node's proxy can lend it: the sequencer refuses the node's key whoever reached the port, the node's
 * administrator included. No role's own list forwards it but the member's, whose proxy answers only the device and signs
 * as the wallet (tests/attestation-read-gate.test.ts). The same review put the duplicate-claims check in the table, since
 * its groups name wallets (tests/duplicate-claims-read-gate.test.ts).
 *
 * A real sequencer RPC server with a stand-in engine quote behind it, an insurer node configured as
 * start-insurer-nautilus.ts configures it (proxy on by default, its node key registered with the insurer role), and a
 * second insurer node whose proxy is configured to forward the quote, to show the node-credential rule itself, and the
 * attestation, to show that no node's credential opens it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(120_000);

const OPERATOR = 'operator-token-for-proxy-reads';
const INSURER_ADMIN = 'insurer-admin-token-for-proxy-reads';
const MEMBER = '79000000000000000001';
const UNKNOWN = '79000000000000009999';
const ABACAVIR = '00378410591';

let rpcServer: any;
let insurer: any;
let insurerUrl: string;
let forwarding: any;
let forwardingUrl: string;
let ndcHash: string;
let L2RpcServerClass: any;
const asked: Array<Record<string, unknown>> = [];
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
  const { resolveRpcProxyPolicy } = await import('../src/security/network-policy.js');
  const { LIFECYCLE_ELIGIBLE } = await import('../src/engine/lifecycle.js');
  L2RpcServerClass = L2RpcServer;
  ndcHash = hashString(ABACAVIR).toString();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-proxy-reads' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  node.getSequencer().getFormularyService().loadFromNadac(formularyRaw);
  // The member holds a registration on the ledger and an attestation the sequencer signed for it. Issued in-process:
  // over RPC it answers only the member's own signature (A10b), and this file has no member key.
  await node.enableAttestations();
  node.getSequencer().adminMutate('test: provision the member', ({ provision }) => { provision(Field(BigInt(MEMBER)), LIFECYCLE_ELIGIBLE); });
  if (node.requestAttestation(MEMBER)?.w !== MEMBER) throw new Error('the fixture attestation was not issued');
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-reads-'));
  dirs.push(dir);
  insurer = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: INSURER_ADMIN, nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
    rpcProxy: resolveRpcProxyPolicy({}, 'insurer node'),
  } as any);
  await insurer.start();
  insurerUrl = `http://127.0.0.1:${insurer.getPort()}`;

  // An insurer node whose proxy is configured to forward the quote, a member-data read (the A-49 rule itself), and the
  // member's attestation, which answers only the wallet's own signature
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-reads-'));
  dirs.push(dir2);
  forwarding = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir2, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: INSURER_ADMIN, nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
    rpcProxy: { enabled: true, allowed: new Set(['l2_estimateCost', 'l2_getAttestation']) },
  } as any);
  await forwarding.start();
  forwardingUrl = `http://127.0.0.1:${forwarding.getPort()}`;
});

afterAll(async () => {
  await forwarding?.stop();
  await insurer?.stop();
  await rpcServer?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/**
 * POST l2_estimateCost to a node's /rpc as a page on an allowed origin would. A page on any other site used to send it
 * as text/plain, which needs no CORS preflight; the node now refuses that before the proxy sees it (A-82).
 */
async function quoteVia(nodeUrl: string, params: Record<string, unknown>, headers: Record<string, string> = {}, type = 'application/json'): Promise<{ status: number; json: any }> {
  const r = await fetch(`${nodeUrl}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': type, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_estimateCost', params }),
  });
  return { status: r.status, json: await r.json() };
}
/** POST the attestation read to a node's /rpc, as a page on an allowed origin would. */
async function attestationVia(nodeUrl: string, params: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(`${nodeUrl}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getAttestation', params }),
  });
  return { status: r.status, json: await r.json() };
}
const viaInsurer = (params: Record<string, unknown>, headers: Record<string, string> = {}) => quoteVia(insurerUrl, params, headers);

describe('the insurer node\'s /rpc proxy forwards no quote (owner decision 2026-10-19)', () => {
  test('a caller with no credential gets no member\'s quote, and the engine is not asked', async () => {
    asked.length = 0;
    const r = await viaInsurer({ walletId: MEMBER, ndcHash, quantity: 30 });
    expect(r.json.result).toBeUndefined();               // before A-49: the member's phase and share
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: -32601 });
    expect(r.json.error.message).toMatch(/not available through this node's proxy/);
    // Sent as another site's page sends it, without asking first, it does not reach the proxy (A-82).
    expect((await quoteVia(insurerUrl, { walletId: MEMBER, ndcHash, quantity: 30 }, {}, 'text/plain')).status).toBe(415);
    expect(asked).toEqual([]);
  });

  test('a wallet that is not enrolled gets the same refusal, so the proxy is no enrollment oracle', async () => {
    const r = await viaInsurer({ walletId: UNKNOWN, ndcHash, quantity: 30 });
    expect(r.status).toBe(403);
    expect(r.json.error.message).not.toMatch(/not a member/); // before A-49: "This wallet is not a member enrolled with the engine"
  });

  test('the insurer node\'s own administrator gets no quote through it either: the Cost Estimator has its own route', async () => {
    asked.length = 0;
    for (const headers of [{ Authorization: `Bearer ${INSURER_ADMIN}` }, { Authorization: 'Bearer not-the-token' }]) {
      const r = await viaInsurer({ walletId: MEMBER, ndcHash, quantity: 30 }, headers);
      expect(r.status).toBe(403);                        // before: 200 for the administrator, as the plan
      expect(r.json.error).toMatchObject({ code: -32601 });
    }
    expect(asked).toEqual([]);
  });

  test('a quote that names no member is not forwarded either', async () => {
    const r = await viaInsurer({ ndcHash, quantity: 30 });
    expect(r.status).toBe(403);                          // before: the list price
    expect(r.json.error).toMatchObject({ code: -32601 });
  });
});

describe('a proxy configured to forward a member-data read forwards it only for the node\'s administrator (A-49)', () => {
  test('no credential: refused before the sequencer is asked', async () => {
    asked.length = 0;
    const r = await quoteVia(forwardingUrl, { walletId: MEMBER, ndcHash, quantity: 30 });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: -32004 });
    expect(r.json.error.message).toMatch(/returns a member's data/);
    expect(asked).toEqual([]);
    const unknown = await quoteVia(forwardingUrl, { walletId: UNKNOWN, ndcHash, quantity: 30 });
    expect(unknown.status).toBe(403);
    expect(unknown.json.error.message).not.toMatch(/not a member/);
  });

  test('the node\'s administrator: forwarded and read as the plan; a wrong token is no credential', async () => {
    asked.length = 0;
    const r = await quoteVia(forwardingUrl, { walletId: MEMBER, ndcHash, quantity: 30 }, { Authorization: `Bearer ${INSURER_ADMIN}` });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ covered: true, phase: 'deductible', memberPayCents: 3051, employerPayCents: 0, totalCostCents: 3051 });
    expect(asked).toEqual([{ walletId: MEMBER, ndcHash, quantity: 30 }]);
    const wrong = await quoteVia(forwardingUrl, { walletId: MEMBER, ndcHash, quantity: 30 }, { Authorization: 'Bearer not-the-token' });
    expect(wrong.status).toBe(403);
  });

  test('a call that names no member is no member-data read: the list price, NADAC x quantity plus the network default fee', async () => {
    const r = await quoteVia(forwardingUrl, { ndcHash, quantity: 30 });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ covered: true, ingredientCostCents: 1801, dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', totalCostCents: 2801 });
  });
});

describe('the member\'s attestation, the tap that opens its drug history, is no node\'s to lend', () => {
  test('a proxy configured to forward it gets the sequencer\'s refusal, for a caller with no credential and for the node\'s administrator alike', async () => {
    const anonymous = await attestationVia(forwardingUrl, { walletId: MEMBER });
    expect(anonymous.json.result).toBeUndefined();       // before the sweep: the member's signed attestation, forwarded under the node's key
    expect(anonymous.json.error).toMatchObject({ code: -32003 }); // before: -32004, the proxy's own refusal of a D1 read
    expect(anonymous.json.error.message).toMatch(/not by wallet 790000000000/); // before: the proxy's refusal, which named no wallet
    const admin = await attestationVia(forwardingUrl, { walletId: MEMBER }, { Authorization: `Bearer ${INSURER_ADMIN}` });
    expect(admin.json.result).toBeUndefined();           // before: the member's attestation, read under the insurer node's key as the plan
    expect(admin.json.error).toMatchObject({ code: -32003 }); // before: no error
    expect(admin.json.error.message).toMatch(/signed by insurer-node, not by wallet 790000000000/); // before: no error
  });
});

describe('the table the proxy reads is the sequencer\'s own', () => {
  test('L2RpcServer enforces the table in member-data-methods.ts, and a call reads member data only when it names one', async () => {
    const { MEMBER_DATA_METHODS, callReadsMemberData } = await import('../src/l2/member-data-methods.js');
    expect(L2RpcServerClass.MEMBER_DATA_METHODS).toBe(MEMBER_DATA_METHODS);
    expect(callReadsMemberData('l2_estimateCost', { walletId: MEMBER, ndcHash })).toBe(true);
    expect(callReadsMemberData('l2_estimateCost', { ndcHash })).toBe(false);
    expect(callReadsMemberData('l2_estimateCost', { walletId: '', ndcHash })).toBe(false);
    expect(callReadsMemberData('l2_getClaimsByMember', { walletId: MEMBER })).toBe(true);
    expect(callReadsMemberData('l2_getAuditLog', {})).toBe(true);
    expect(callReadsMemberData('l2_getAttestation', { walletId: MEMBER })).toBe(false); // before: true, a D1 read the plan's key passes, so the administrator's forward read it
    expect(callReadsMemberData('l2_detectDuplicateClaims', {})).toBe(true); // before: false, though its groups name wallets
    expect(callReadsMemberData('l2_getPlans', {})).toBe(false);
    expect(callReadsMemberData('constructor', {})).toBe(false);
  });
});
