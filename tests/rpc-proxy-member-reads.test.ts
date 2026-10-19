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
 * administrator; a member node's proxy answers only the device's session, as before. A quote that names no member
 * stays open.
 *
 * A real sequencer RPC server with a stand-in engine quote behind it, and an insurer node configured as
 * start-insurer-nautilus.ts configures it (proxy on by default, its node key registered with the insurer role).
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
  L2RpcServerClass = L2RpcServer;
  ndcHash = hashString(ABACAVIR).toString();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-proxy-reads' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-reads-'));
  dirs.push(dir);
  insurer = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: INSURER_ADMIN, nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
    rpcProxy: resolveRpcProxyPolicy({}, 'insurer node'),
  } as any);
  await insurer.start();
  insurerUrl = `http://127.0.0.1:${insurer.getPort()}`;
});

afterAll(async () => {
  await insurer?.stop();
  await rpcServer?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** POST to the insurer node's /rpc as a page would: text/plain needs no CORS preflight. */
async function viaInsurer(params: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(`${insurerUrl}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_estimateCost', params }),
  });
  return { status: r.status, json: await r.json() };
}

describe('the insurer node\'s /rpc proxy and a member\'s quote', () => {
  test('a caller with no credential gets no member\'s quote, and the engine is not asked', async () => {
    asked.length = 0;
    const r = await viaInsurer({ walletId: MEMBER, ndcHash, quantity: 30 });
    expect(r.json.result).toBeUndefined();               // before: the member's phase and share
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: -32004 });
    expect(r.json.error.message).toMatch(/returns a member's data/);
    expect(asked).toEqual([]);
  });

  test('a wallet that is not enrolled gets the same refusal, so the proxy is no enrollment oracle', async () => {
    const r = await viaInsurer({ walletId: UNKNOWN, ndcHash, quantity: 30 });
    expect(r.status).toBe(403);
    expect(r.json.error.message).not.toMatch(/not a member/); // before: "This wallet is not a member enrolled with the engine"
  });

  test('the insurer node\'s own administrator still reads a member\'s quote through it, as the plan', async () => {
    asked.length = 0;
    const r = await viaInsurer({ walletId: MEMBER, ndcHash, quantity: 30 }, { Authorization: `Bearer ${INSURER_ADMIN}` });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ covered: true, phase: 'deductible', memberPayCents: 3051, employerPayCents: 0, totalCostCents: 3051 });
    expect(asked).toEqual([{ walletId: MEMBER, ndcHash, quantity: 30 }]);
    // a wrong token is no credential
    const wrong = await viaInsurer({ walletId: MEMBER, ndcHash, quantity: 30 }, { Authorization: 'Bearer not-the-token' });
    expect(wrong.status).toBe(403);
  });

  test('a quote that names no member stays open: the list price, NADAC x quantity plus the network default fee', async () => {
    const r = await viaInsurer({ ndcHash, quantity: 30 });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ covered: true, ingredientCostCents: 1801, dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', totalCostCents: 2801 });
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
    expect(callReadsMemberData('l2_getPlans', {})).toBe(false);
    expect(callReadsMemberData('constructor', {})).toBe(false);
  });
});
