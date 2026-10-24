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
 * The duplicate-claims and balance checks read every member's fills, so they answer the plan and the operator only, as
 * the audit log they read does (the security review of the sweep fixes, and the review of round eight of the security
 * fixes, 2026-10-24).
 *
 * What was wrong: l2_detectDuplicateClaims was in neither the sequencer's admin list nor the D1 table, so it answered
 * anyone. It groups the audit log's fills by wallet, drug (the NDC's hash, and the sequencer carries drug data in the
 * open), date of service and fill number, and it returned each group keyed by those four, so anyone learned that a
 * wallet filled a drug on a day, out of the very log D1 opens only to the plan and the operator (l2_getAuditLog). The
 * explorer's proxy forwarded it. The security review of the sweep fixes reproduced it on a real sequencer: an anonymous
 * call returned the group for the same fill at two pharmacies on one day, while the same caller's l2_getAuditLog was
 * refused.
 *
 * Now the check is a D1 enumeration, as the audit log is. It answers the plan (a node key with the insurer role) and the
 * operator (the bearer, or a node key with the operator role); it refuses an anonymous caller and a wrong bearer with
 * 401, and the member itself, a provider and a member node with 403. A node's proxy forwards it only for the node's
 * administrator, as it does every read of a member's data. The explorer's page sends the operator token it holds for it,
 * as it does for the audit log, and the explorer's proxy relays that token to the sequencer.
 *
 * The review of round eight of the security fixes found the balance check, left open beside it, giving the members away
 * by another road. l2_verifyFinancialBalance returns running totals over every claim (patient pay, plan pay, ingredient
 * cost and dispensing fee, with the receipt IDs of fills that do not add up), and they move by one claim's amounts each
 * time the sequencer accepts a proof. The sequencer's event stream announces each accepted proof with its wallet and its
 * receipt, and every member, prescriber and pharmacy node key may open it (D2), so a key that read the totals before and
 * after each event had each wallet's claim amounts, and the receipts that do not add up named their wallets. The review
 * reproduced it with a pharmacy key. It also found the operator's network screen calling the duplicate check without its
 * token, so the gate above refused the screen even with the token set, while the audit log two lines up sent it.
 *
 * Now the balance check is a D1 enumeration too, refused to the same callers with the same codes and answered to the
 * plan and the operator. The explorer's page sends its operator token for it, and the network screen for it and for the
 * duplicate check. The chain-integrity check stays open: the number of audit events it returns is what the stream and
 * the sequencer's status publish anyway, and the sequence numbers of links that do not hash carry no amount, drug or day.
 *
 * The review of round nine of the security fixes (2026-10-24) found that the explorer's page never holds a token: nothing
 * in its page or its scripts sets one, and the explorer adds none, so the page's rpc.js has none to send. In a browser
 * the balance and duplicate cards answered ERROR to every viewer, the operator included, as though the checks had
 * broken, and the audit log beneath them said it was unavailable. The explorer's tests passed only because they set a
 * token on the page's rpc.js themselves.
 *
 * The explorer is the public view, so it still takes no token. When the sequencer refuses one of those reads for want of
 * a credential (-32003, or -32004 for a credential whose role does not reach it), the card says the check is the plan's
 * and the operator's and where each runs it (the plan on its Audit tab, the operator on its network screen), and the
 * audit log says the same of itself; a card keeps saying it through the tab's refresh, since asking again is refused
 * again. Any other failure still shows as an error, and the chain-integrity card still answers. The explorer's proxy
 * still relays a credential that a request carries, which the tests show with the operator's bearer sent through it.
 *
 * A real sequencer RPC server with the accept-all transition verifier, holding the same fill at two pharmacies on one day
 * and a fill whose split does not add up; the explorer as its own process, as the launcher runs it, relaying to that
 * server, with the explorer's rpc.js as its page loads it, and its Audit tab's code as app.js has it, run against
 * stand-ins for the tab's cards and panels; and the network screen's rpc.js as that server serves it. No compile, no
 * proof.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { Field, Poseidon } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_UNAUTHORIZED, RPC_FORBIDDEN, RPC_INTERNAL_ERROR, RPC_METHOD_NOT_FOUND } from '../src/l2/l2-rpc-server.js';
import { MEMBER_DATA_METHODS, callReadsMemberData } from '../src/l2/member-data-methods.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';
import { generateNodeKey, roleMayCall } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';
import type { ClaimSubmissionMetadata } from '../src/l2/l2-types.js';

jest.setTimeout(120_000);

const REPO = path.resolve(__dirname, '..');
const OPERATOR = 'operator-token-for-duplicate-claims';
const REG_ROOT = [Field(1000), Field(1001), Field(1002), Field(1003)];
const LC_ROOT = Field(2000);
const MEMBER = '79000000000000000123';
const EK_MEMBER = 'ek-member-' + 'm'.repeat(32);
const PHARMACY_A = '79000000000000005001';
const PHARMACY_B = '79000000000000005002';
const PRESCRIBER = '79000000000000006001';
const DAY = '20261018';
const ABACAVIR = Poseidon.hash([Field(BigInt('00378410591'))]).toString();
const LAMIVUDINE = Poseidon.hash([Field(BigInt('00093721510'))]).toString();
/** The group the check returns for the two fills: the member's wallet, the drug, the day and the fill number. */
const GROUP_KEY = `${MEMBER}|${ABACAVIR}|${DAY}|0`;
const memberNodeKey = generateNodeKey('member-node');
const pharmacyNodeKey = generateNodeKey('pharmacy-node');
const prescriberNodeKey = generateNodeKey('prescriber-node');
const insurerNodeKey = generateNodeKey('insurer-node');
const operatorNodeKey = generateNodeKey('operator-node');

function mockProof(walletId: string, oldRoot: Field, newRoot: Field) {
  return { verify: () => {}, publicOutput: { walletId: Field(BigInt(walletId)), oldRegistryRoot: oldRoot, newRegistryRoot: newRoot, oldLifecycleRoot: LC_ROOT, newLifecycleRoot: LC_ROOT }, toJSON: () => ({}) } as any;
}
function fill(overrides: Partial<ClaimSubmissionMetadata>): ClaimSubmissionMetadata {
  return {
    ndcHash: ABACAVIR, memberWalletId: MEMBER, pharmacyWalletId: PHARMACY_A, prescriberWalletId: PRESCRIBER, dateOfService: DAY,
    patientPayCents: '1000', planPayCents: '3700', operationType: '1', ingredientCostCents: 4500, dispensingFeeCents: 200, quantityDispensed: 30, fillNumber: 0,
    ...overrides,
  };
}

let node: L2Node;
let server: L2RpcServer;
let url: string;
/** The receipt of the fill whose split does not add up. */
let imbalancedReceipt: string;

let rpcId = 0;
/** Each envelope has its own id, so two identical calls signed in the same millisecond are not one replayed signature. */
const envelope = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
async function rpcWith(headers: Record<string, string>, body: string) {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return (await r.json()) as { result?: any; error?: { code: number; message: string } };
}
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const byNode = (key: ReturnType<typeof generateNodeKey>, body: string) => signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body });
const byMember = (body: string) => signRequest({ ...walletSigner(EK_MEMBER, MEMBER), method: 'POST', path: '/rpc', body });
const duplicates = () => envelope('l2_detectDuplicateClaims');
const balance = () => envelope('l2_verifyFinancialBalance');
/** What the balance check answers over the three fills: two that add up, and one whose plan pay is 700 short. */
const TOTALS = { balanced: false, reconciled: true, totalClaims: 3, totalPatientPayCents: 3000, totalPlanPayCents: 10400, totalIngredientCostCents: 13500, totalDispensingFeeCents: 600 };

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-duplicate-claims' }, new InMemoryStore(), REG_ROOT[0], LC_ROOT, Field(0));
  node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/duplicate-claims-read-gate.test.ts'));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNodeKey.nodeId, memberNodeKey.publicKeyHex, 'member');
  server.registerNodeKey(pharmacyNodeKey.nodeId, pharmacyNodeKey.publicKeyHex, 'pharmacy');
  server.registerNodeKey(prescriberNodeKey.nodeId, prescriberNodeKey.publicKeyHex, 'prescriber');
  server.registerNodeKey(insurerNodeKey.nodeId, insurerNodeKey.publicKeyHex, 'insurer');
  server.registerNodeKey(operatorNodeKey.nodeId, operatorNodeKey.publicKeyHex, 'operator');
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
  const register = envelope('l2_registerEntity', { walletId: MEMBER, displayName: 'Member', type: 'member', signingPublicKeyHex: deriveWalletSigningKey(EK_MEMBER).publicKeyHex });
  const registered = await rpcWith(byNode(memberNodeKey, register), register);
  if (registered.error) throw new Error(`fixture registration of the member failed: ${registered.error.message}`);
  // The same fill at two pharmacies on one day: the ledger takes both, since its key holds the pharmacy, and the audit
  // check groups them, since its key does not. Then another drug, whose split does not add up to its costs.
  const seq = node.getSequencer();
  await seq.submitProof(mockProof(MEMBER, REG_ROOT[0], REG_ROOT[1]), fill({ pharmacyWalletId: PHARMACY_A }));
  await seq.submitProof(mockProof(MEMBER, REG_ROOT[1], REG_ROOT[2]), fill({ pharmacyWalletId: PHARMACY_B }));
  const imbalanced = await seq.submitProof(mockProof(MEMBER, REG_ROOT[2], REG_ROOT[3]), fill({ ndcHash: LAMIVUDINE, planPayCents: '3000' }));
  imbalancedReceipt = imbalanced.receiptId;
});

afterAll(async () => { await server?.stop(); });

describe('the D1 table', () => {
  test('the duplicate-claims and balance checks are enumerations, as the audit log they read is; the chain check is not a read of a member\'s data', () => {
    expect(MEMBER_DATA_METHODS.l2_detectDuplicateClaims).toEqual({ subject: 'enumeration', readers: [] }); // before: undefined, so the read gate never saw the call
    expect(MEMBER_DATA_METHODS.l2_detectDuplicateClaims).toEqual(MEMBER_DATA_METHODS.l2_getAuditLog);       // before: undefined
    expect(callReadsMemberData('l2_detectDuplicateClaims', {})).toBe(true); // before: false, so a node's proxy forwarded it for anyone
    expect(MEMBER_DATA_METHODS.l2_verifyFinancialBalance).toEqual({ subject: 'enumeration', readers: [] }); // before: undefined, so the read gate never saw the call
    expect(callReadsMemberData('l2_verifyFinancialBalance', {})).toBe(true); // before: false
    expect(callReadsMemberData('l2_verifyChainIntegrity', {})).toBe(false);
  });
});

describe('l2_detectDuplicateClaims at the sequencer', () => {
  test('answers no anonymous caller and no wrong bearer, and names nothing of the member, the drug or the day', async () => {
    const anonymous = await rpcWith({}, duplicates());
    expect(anonymous.result).toBeUndefined();             // before: { hasDuplicates: true, duplicates: [{ key: wallet|drug|day|fill, receiptIds }] }
    expect(anonymous.error?.code).toBe(RPC_UNAUTHORIZED); // before: no error
    expect(JSON.stringify(anonymous)).not.toContain(MEMBER); // before: the member's wallet, in the group's key
    expect(JSON.stringify(anonymous)).not.toContain(ABACAVIR); // before: the drug, beside it
    const wrong = await rpcWith({ Authorization: 'Bearer not-the-operator' }, duplicates());
    expect(wrong.result).toBeUndefined();                 // before: the group; the method checked no credential
    expect(wrong.error?.code).toBe(RPC_UNAUTHORIZED);     // before: no error
  });

  test('answers neither the member itself nor a pharmacy, a prescriber or a member node: it reads across members', async () => {
    const own = duplicates();
    const member = await rpcWith(byMember(own), own);
    expect(member.result).toBeUndefined();                // before: the group, as for anyone
    expect(member.error?.code).toBe(RPC_FORBIDDEN);       // before: no error
    expect(member.error?.message).toMatch(/across members and answers the plan or the operator only$/); // before: no error
    for (const key of [pharmacyNodeKey, prescriberNodeKey, memberNodeKey]) {
      const body = duplicates();
      const r = await rpcWith(byNode(key, body), body);
      expect([key.nodeId, r.result]).toEqual([key.nodeId, undefined]); // before: the group
      expect([key.nodeId, r.error?.code]).toEqual([key.nodeId, RPC_FORBIDDEN]); // before: no error
    }
  });

  test('answers the plan and the operator, the bearer or an operator key, with the group for the same fill at two pharmacies', async () => {
    const plan = duplicates();
    const asPlan = await rpcWith(byNode(insurerNodeKey, plan), plan);
    expect(asPlan.result).toMatchObject({ hasDuplicates: true, totalDuplicates: 2, duplicates: [{ key: GROUP_KEY }] });
    expect(asPlan.result.duplicates[0].receiptIds).toHaveLength(2);
    expect((await rpcWith(bearer, duplicates())).result).toEqual(asPlan.result);
    const ops = duplicates();
    expect((await rpcWith(byNode(operatorNodeKey, ops), ops)).result).toEqual(asPlan.result);
    // the readers of the audit log the groups come from, which refuses the anonymous caller just the same
    expect((await rpcWith({}, envelope('l2_getAuditLog'))).error?.code).toBe(RPC_UNAUTHORIZED);
    expect((await rpcWith(bearer, envelope('l2_getAuditLog'))).result.events).toHaveLength(3);
  });
});

describe('l2_verifyFinancialBalance at the sequencer', () => {
  test('answers no anonymous caller and no wrong bearer, and gives none of the totals or the receipt that does not add up', async () => {
    const anonymous = await rpcWith({}, balance());
    expect(anonymous.result).toBeUndefined();             // before: the totals over every claim and the receipt of the fill that does not add up
    expect(anonymous.error?.code).toBe(RPC_UNAUTHORIZED); // before: no error
    expect(JSON.stringify(anonymous)).not.toContain(imbalancedReceipt); // before: the receipt, in imbalancedClaims
    expect(JSON.stringify(anonymous)).not.toContain('totalPatientPayCents'); // before: the running total of patient pay
    const wrong = await rpcWith({ Authorization: 'Bearer not-the-operator' }, balance());
    expect(wrong.result).toBeUndefined();                 // before: the totals; the method checked no credential
    expect(wrong.error?.code).toBe(RPC_UNAUTHORIZED);     // before: no error
  });

  test('answers no pharmacy key, which may open the event stream that names each claim\'s wallet, nor a prescriber key, a member node or the member itself', async () => {
    // The key the review used: it may subscribe to the stream, so the totals read around each event it sees would be
    // that event's wallet's claim amounts.
    expect(roleMayCall('pharmacy', { kind: 'route', method: 'GET', path: '/events' })).toBe(true);
    for (const key of [pharmacyNodeKey, prescriberNodeKey, memberNodeKey]) {
      const body = balance();
      const r = await rpcWith(byNode(key, body), body);
      expect([key.nodeId, r.result]).toEqual([key.nodeId, undefined]); // before: the totals
      expect([key.nodeId, r.error?.code]).toEqual([key.nodeId, RPC_FORBIDDEN]); // before: no error
      expect([key.nodeId, r.error?.message]).toEqual([key.nodeId, 'Forbidden — l2_verifyFinancialBalance reads across members and answers the plan or the operator only']); // before: no error
    }
    const own = balance();
    const member = await rpcWith(byMember(own), own);
    expect(member.result).toBeUndefined();                // before: the totals over every member's claims
    expect(member.error?.code).toBe(RPC_FORBIDDEN);       // before: no error
  });

  test('answers the plan and the operator, the bearer or an operator key, with the totals and the receipt of the fill that does not add up', async () => {
    const plan = balance();
    const asPlan = await rpcWith(byNode(insurerNodeKey, plan), plan);
    expect(asPlan.result).toMatchObject({ ...TOTALS, imbalancedClaims: [imbalancedReceipt] });
    expect((await rpcWith(bearer, balance())).result).toEqual(asPlan.result);
    const ops = balance();
    expect((await rpcWith(byNode(operatorNodeKey, ops), ops)).result).toEqual(asPlan.result);
  });

  test('a receipt ID it names opens nothing of the member to an anonymous caller: the receipt is a read of the member\'s data', async () => {
    const receipt = await rpcWith({}, envelope('l2_getReceipt', { receiptId: imbalancedReceipt }));
    expect(receipt.result).toBeUndefined();
    expect(receipt.error?.code).toBe(RPC_UNAUTHORIZED);
  });
});

describe('the chain-integrity check', () => {
  test('stays open and names no member, drug, day, pharmacy, prescriber or receipt: the number of events and the links that do not hash', async () => {
    const chain = await rpcWith({}, envelope('l2_verifyChainIntegrity'));
    expect(chain.result).toEqual({ valid: true, integrity: true, totalEvents: 3, brokenLinks: [] });
    const text = JSON.stringify(chain);
    for (const named of [MEMBER, ABACAVIR, LAMIVUDINE, DAY, PHARMACY_A, PHARMACY_B, PRESCRIBER, imbalancedReceipt]) {
      expect([named, text.includes(named)]).toEqual([named, false]);
    }
  });
});

describe('the explorer', () => {
  interface Explorer { child: ChildProcess; port: number; stderr: () => string }
  let explorer: Explorer | null = null;

  async function freePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
    });
  }

  beforeAll(async () => {
    // The explorer as the launcher starts it, relaying to the sequencer above; ready once it serves its pages.
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'nodes', 'start-explorer.ts')], {
      cwd: REPO,
      env: { ...process.env, ZKTRIDENT_EXPLORER_PORT: String(port), ZKTRIDENT_SEQUENCER_URL: url, ZKTRIDENT_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    explorer = { child, port, stderr: () => stderr };
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { const r = await fetch(`http://127.0.0.1:${port}/index.html`); if (r.status > 0) break; } catch { /* not yet */ }
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('explorer did not start: ' + stderr);
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 90_000);

  afterAll(() => {
    if (explorer && explorer.child.exitCode === null) { try { explorer.child.kill(); } catch { /* best effort */ } }
  });

  /** The explorer's rpc.js as its page loads it from the explorer's origin, keeping the headers of each request it sends. */
  function explorerPage() {
    const sent: Array<Record<string, string>> = [];
    const recording = (target: string, init: { headers: Record<string, string> }) => { sent.push(init.headers); return fetch(target, init as RequestInit); };
    const RPC = new Function('location', 'fetch', 'EventSource', `${fs.readFileSync(path.join(REPO, 'explorer', 'rpc.js'), 'utf8')}\nreturn RPC;`)(
      { origin: `http://127.0.0.1:${explorer!.port}` }, recording, undefined);
    return { RPC, sent };
  }

  /** A request to the explorer's /rpc carrying the given headers, as any client that reaches the explorer may send one. */
  async function throughExplorer(headers: Record<string, string>, body: string) {
    const r = await fetch(`http://127.0.0.1:${explorer!.port}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return (await r.json()) as { result?: any; error?: { code: number; message: string } };
  }

  test('its proxy relays a credential a request carries: the operator\'s bearer sent through it is answered with the group, the totals and the audit log', async () => {
    const groups = await throughExplorer(bearer, duplicates());
    expect(groups.result.duplicates.map((g: { key: string }) => g.key)).toEqual([GROUP_KEY]);
    expect((await throughExplorer(bearer, balance())).result).toMatchObject({ ...TOTALS, imbalancedClaims: [imbalancedReceipt] });
    expect((await throughExplorer(bearer, envelope('l2_getAuditLog', { limit: 10 }))).result.events).toHaveLength(3);
    // the sequencer decides what the relayed credential opens: a wrong bearer is refused through the proxy as at the sequencer
    expect((await throughExplorer({ Authorization: 'Bearer not-the-operator' }, duplicates())).error?.code).toBe(RPC_UNAUTHORIZED);
  });

  test('a page with no token gets the refusals through the proxy, not the member\'s group or the totals, and the chain check\'s answer', async () => {
    const { RPC, sent } = explorerPage();
    await expect(RPC.detectDuplicateClaims()).rejects.toThrow(/Unauthorized/); // before: the group, to any page that reached the explorer
    await expect(RPC.verifyFinancialBalance()).rejects.toThrow(/Unauthorized/); // before: the totals, to any page that reached the explorer
    expect(sent.map((h) => h.Authorization)).toEqual([undefined, undefined]);
    expect(await RPC.verifyChainIntegrity()).toMatchObject({ valid: true, totalEvents: 3 });
  });

  describe('its Audit tab', () => {
    const EXPLORER_APP = fs.readFileSync(path.join(REPO, 'explorer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

    /** A top-level function of app.js: from its declaration to the first line that is exactly "  }". */
    function lift(name: string): string {
      const at = EXPLORER_APP.indexOf('\n  function ' + name + '(');
      if (at < 0) throw new Error('no function ' + name);
      return EXPLORER_APP.slice(at + 1, EXPLORER_APP.indexOf('\n  }\n', at) + 4);
    }
    /** The Audit tab's code, as app.js has it between its AUDIT and NETWORK banners. */
    function auditSection(): string {
      const start = EXPLORER_APP.indexOf('\n  //  AUDIT\n');
      const end = EXPLORER_APP.indexOf('\n  //  NETWORK\n');
      if (start < 0 || end < start) throw new Error('no Audit section in explorer/app.js');
      return EXPLORER_APP.slice(start + 1, end);
    }

    /** A stand-in for an element of the tab: what its code reads and sets of a card, a card's value or note, and a panel. */
    class Stand {
      className: string;
      textContent = '';
      innerHTML = '';
      parent: Stand | null = null;
      children: Stand[] = [];
      clicks: Array<(this: Stand) => unknown> = [];
      constructor(className = '') { this.className = className; }
      /** The one selector form the tab's code uses: a class name. */
      matches(selector: string): boolean { return this.className.split(/\s+/).includes(selector.replace(/^\./, '')); }
      closest(selector: string): Stand | null {
        for (let n: Stand | null = this; n; n = n.parent) if (n.matches(selector)) return n;
        return null;
      }
      querySelector(selector: string): Stand | null {
        for (const child of this.children) {
          const hit = child.matches(selector) ? child : child.querySelector(selector);
          if (hit) return hit;
        }
        return null;
      }
      appendChild(child: Stand): Stand { child.parent = this; this.children.push(child); return child; }
      remove(): void {
        if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
      }
      addEventListener(type: string, fn: (this: Stand) => unknown): void { if (type === 'click') this.clicks.push(fn); }
    }

    type Check = 'chain' | 'finance' | 'dup';
    /**
     * The tab's code as app.js has it, with app.js's own helpers, against stand-ins for its three check cards and its two
     * panels, as index.html lays them out, and with the RPC given: by default the explorer's rpc.js as its page loads it,
     * holding no token, as the page never does, and relaying through the explorer to the sequencer.
     */
    function auditTab(RPC: Record<string, unknown> = explorerPage().RPC) {
      const els: Record<string, Stand> = {};
      for (const check of ['chain', 'finance', 'dup']) {
        const card = (els[`audit-${check}-card`] = new Stand('stat-card stat-clickable'));
        card.appendChild(new Stand('stat-label'));
        const value = (els[`audit-${check}-val`] = card.appendChild(new Stand('stat-value')));
        value.textContent = 'Check';
      }
      els['audit-log-container'] = new Stand('panel-body flush');
      els['audit-proof-container'] = new Stand('panel-body');
      const helpers = ['esc', 'shortHash', 'fmtTime', 'fmtCents', 'typeBadge', 'detailRow'].map(lift);
      const tab = new Function('$', 'RPC', 'document', `'use strict';\n${helpers.join('\n')}\n${auditSection()}\nreturn { loadAudit, setupAuditChecks };`)(
        (id: string) => els[id], RPC, { createElement: () => new Stand() }) as { loadAudit: () => Promise<void>; setupAuditChecks: () => void };
      tab.setupAuditChecks();
      /** What a check card shows: its value, its classes, and the note beneath the value when it carries one. */
      const card = (check: Check) => {
        const c = els[`audit-${check}-card`];
        const note = c.querySelector('.stat-detail');
        return { value: els[`audit-${check}-val`].textContent, classes: c.className, note: note ? note.textContent : null };
      };
      /** Clicks a check card as a viewer does, and waits until it has stopped asking. */
      const click = async (check: Check) => {
        const c = els[`audit-${check}-card`];
        await Promise.all(c.clicks.map((fn) => fn.call(c)));
        for (const deadline = Date.now() + 10_000; els[`audit-${check}-val`].textContent === '...' && Date.now() < deadline;) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return card(check);
      };
      return { loadAudit: tab.loadAudit, click, card, log: () => els['audit-log-container'].innerHTML };
    }

    test('holding no token, as the page never does, it says the balance and duplicate checks are the plan\'s and the operator\'s and where they run them, not ERROR; the chain check still answers', async () => {
      // nothing in the page sets a token and the explorer adds none, so every viewer, the operator included, asks anonymously
      for (const file of ['index.html', 'app.js']) {
        expect([file, fs.readFileSync(path.join(REPO, 'explorer', file), 'utf8').includes('setAdminToken')]).toEqual([file, false]);
      }
      const page = explorerPage();
      const tab = auditTab(page.RPC);
      for (const check of ['finance', 'dup'] as const) {
        const shown = await tab.click(check);
        expect([check, shown.value]).toEqual([check, 'Plan & operator']);              // before: 'ERROR', to every viewer, as though the check had broken
        expect([check, shown.classes]).toEqual([check, 'stat-card stat-clickable']);   // before: 'stat-card stat-clickable check-fail', a failed check's red
        expect([check, shown.note]).toEqual([check, expect.stringContaining('the sequencer answers it to the plan and the operator only')]); // before: null, nothing said whose check it is
        expect([check, shown.note]).toEqual([check, expect.stringContaining('the plan runs it on its Audit tab, the operator on its network screen, under Audit & Chain')]); // before: null, nor where they run it
      }
      expect(await tab.click('chain')).toEqual({ value: 'PASS', classes: 'stat-card stat-clickable check-pass', note: null });
      expect(page.sent.map((h) => h.Authorization)).toEqual([undefined, undefined, undefined]);
    });

    test('its audit log, refused to the page as to any anonymous caller, says whose it is and where they read it, not that it is unavailable', async () => {
      const tab = auditTab();
      await tab.loadAudit();
      expect(tab.log()).toContain('so the sequencer gives it to the plan and the operator only'); // before: 'Audit log unavailable', as though it were down
      expect(tab.log()).toContain('the plan reads it on its Audit tab, the operator on its network screen, under Audit &amp; Chain'); // before: 'Audit log unavailable'
      expect(tab.log()).not.toContain(MEMBER);
    });

    test('a card that says so keeps saying it through the tab\'s refresh, which resets an answered check, and asking again clears it once the check answers', async () => {
      const real = explorerPage().RPC;
      let answers = false;
      const tab = auditTab({ ...real, verifyFinancialBalance: () => (answers ? Promise.resolve({ balanced: true }) : real.verifyFinancialBalance()) });
      await tab.click('finance');
      await tab.click('chain');
      await tab.loadAudit();                               // the refresh the page runs on this tab every three seconds
      expect(tab.card('finance')).toEqual({ value: 'Plan & operator', classes: 'stat-card stat-clickable', note: expect.stringContaining('the plan and the operator only') }); // before: { value: 'Check', note: null }, gone within three seconds
      expect(tab.card('chain')).toEqual({ value: 'Check', classes: 'stat-card stat-clickable', note: null });
      answers = true;
      expect(await tab.click('finance')).toEqual({ value: 'PASS', classes: 'stat-card stat-clickable check-pass', note: null });
    });

    test('a refusal to a credential whose role does not reach a check says the same; any other failure is still ERROR, and the log still unavailable', async () => {
      const failing = (message: string, code?: number) => () => Promise.reject(Object.assign(new Error(message), code === undefined ? {} : { code }));
      const tab = auditTab({
        verifyFinancialBalance: failing('Forbidden — l2_verifyFinancialBalance reads across members and answers the plan or the operator only', RPC_FORBIDDEN),
        detectDuplicateClaims: failing('"Sequencer unreachable: fetch failed"'),   // the explorer's 502, which carries no code
        verifyChainIntegrity: failing('Internal error', RPC_INTERNAL_ERROR),
        getAuditLog: failing('Method not available through the explorer: l2_getAuditLog', RPC_METHOD_NOT_FOUND),
        getChainProof: () => Promise.resolve(null),
      });
      expect((await tab.click('finance')).value).toBe('Plan & operator');     // before: 'ERROR'
      expect(await tab.click('dup')).toEqual({ value: 'ERROR', classes: 'stat-card stat-clickable check-fail', note: null });
      expect(await tab.click('chain')).toEqual({ value: 'ERROR', classes: 'stat-card stat-clickable check-fail', note: null });
      await tab.loadAudit();
      expect(tab.log()).toBe('<div class="empty-state">Audit log unavailable</div>');
    });
  });
});

describe('the network screen', () => {
  /** The network screen's rpc.js as the sequencer serves it, from the sequencer's own origin, keeping the headers of each request it sends. */
  function networkScreen() {
    const sent: Array<Record<string, string>> = [];
    const recording = (target: string, init: { headers: Record<string, string> }) => { sent.push(init.headers); return fetch(target, init as RequestInit); };
    const RPC = new Function('location', 'fetch', 'EventSource', `${fs.readFileSync(path.join(REPO, 'dashboard-leviathan', 'rpc.js'), 'utf8')}\nreturn RPC;`)(
      { origin: url }, recording, undefined);
    return { RPC, sent };
  }

  test('sends the operator token set on its Admin tab for the duplicate and balance checks, as for the audit log', async () => {
    const { RPC, sent } = networkScreen();
    RPC.setAdminToken(OPERATOR);
    const groups = await RPC.detectDuplicateClaims().catch((err: Error) => ({ refused: err.message }));
    expect(sent[sent.length - 1].Authorization).toBe(`Bearer ${OPERATOR}`); // before: no Authorization header, so the gated check refused the screen with its token set
    expect(groups.duplicates.map((g: { key: string }) => g.key)).toEqual([GROUP_KEY]); // before: { refused: 'Unauthorized — l2_detectDuplicateClaims returns a member's data …' }
    const money = await RPC.verifyFinancialBalance();
    expect(sent[sent.length - 1].Authorization).toBe(`Bearer ${OPERATOR}`); // before: no Authorization header, which the gated check refuses
    expect(money).toMatchObject({ ...TOTALS, imbalancedClaims: [imbalancedReceipt] });
    expect((await RPC.getAuditLog(10)).events).toHaveLength(3);
  });

  test('without a token it gets both checks\' refusals and the chain check\'s answer', async () => {
    const { RPC, sent } = networkScreen();
    await expect(RPC.detectDuplicateClaims()).rejects.toThrow(/Unauthorized/);
    await expect(RPC.verifyFinancialBalance()).rejects.toThrow(/Unauthorized/); // before: the totals over every claim
    expect(sent.map((h) => h.Authorization)).toEqual([undefined, undefined]);
    expect(await RPC.verifyChainIntegrity()).toMatchObject({ valid: true, totalEvents: 3 });
  });
});
