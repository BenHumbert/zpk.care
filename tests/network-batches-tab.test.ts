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
 * The network screen's Batches & Receipts tab, and its batch window, read the batches and receipts the sequencer sends.
 *
 * What was wrong: the tab read fields that no batch or receipt has. The Recent Receipts table read r.id and
 * r.batchIndex, but a receipt carries receiptId and l1BatchNumber, so every ID and every Batch cell showed "--". The
 * Batches table's Root column read b.stateRoot || b.settlementRoot, and a batch carries neither, so every root showed
 * "--". The walkthrough rehearsal of 2026-10-19 filmed both. The batch window's receipt list reached a receipt's fields
 * only through fallbacks (r.id before r.receiptId, r.batchIndex before r.l1BatchNumber, r.status before r.l1Status).
 * And values from the network went into the page unescaped: the window put a receipt's status into a class attribute
 * and its sequence number, claim leaf and hashes into the markup; the tables did the same with a status, a proof count
 * and a wallet ID.
 *
 * Now both tables and the window read L2Receipt and L2Batch (src/l2/l2-types.ts) as l2_getAllReceipts and
 * l2_getAllBatches send them, and escape every value they draw from a receipt, and a batch's status, proof count and
 * root; a status names a class only when it is one of the four the sequencer sends. The Root column shows the batch's
 * newRegistryRoot, headed Registry Root: every batch carries it, and it is the root that settling the batch writes
 * (CareContract.settleBatch sets walletRegistryRoot to it). The window calls globalStateRoot the Global State Root, but
 * a batch carries one only when a chain proof runs, and none runs on this network (chainProofEnabled is false), so a
 * column of it would still read "--".
 *
 * The sequencer's answers are made as the server makes them: L2Batch and L2Receipt objects, sliced as the handlers
 * slice them and written by l2Stringify as sendRpcResult writes them,
 *
 *   case 'l2_getAllReceipts': {
 *     // H9 fix: paginate receipts (default 1000, max 1000)
 *     const allReceipts = this.node instanceof L2Leviathan
 *       ? this.node.getAllReceipts()
 *       : this.node.getSequencer().getAllReceipts();
 *     const rLimit = typeof params.limit === 'number' ? Math.min(params.limit, 1000) : 1000;
 *     const rOffset = typeof params.offset === 'number' ? Math.max(params.offset, 0) : 0;
 *     return allReceipts.slice(rOffset, rOffset + rLimit);
 *   }
 *   (l2_getAllBatches is the same over getAllBatches())
 *
 *   private sendRpcResult(res: ServerResponse, id: string | number, result: unknown): void {
 *     const response: RpcResponse = { jsonrpc: '2.0', id, result };
 *     res.writeHead(200, { 'Content-Type': 'application/json' });
 *     res.end(l2Stringify(response));
 *   }
 *
 * and read through the page's own rpc.js, which strips the bigint prefix, so batchNumber, l1BatchNumber and
 * sequenceNumber reach the page as digit strings. loadBatches and showBatchDetail are lifted out of app.js with the
 * app.js functions they call, and run against a stand-in page.
 */
import fs from 'fs';
import { l2Parse, l2Stringify } from '../src/l2/l2-json.js';
import type { L2Batch, L2Receipt } from '../src/l2/l2-types.js';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const APP = read('dashboard-leviathan/app.js');
const RPC_JS = read('dashboard-leviathan/rpc.js');

/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
/** `name` lifted with every top-level app.js function it calls, and theirs; the names in `given` are stand-ins. */
function liftWithCallees(name: string, given: string[]): string[] {
  const declared = (n: string) => APP.includes(NL + '  function ' + n + '(') || APP.includes(NL + '  async function ' + n + '(');
  const seen = new Set([name, ...given]);
  const pieces: string[] = [];
  for (const queue = [name]; queue.length > 0;) {
    const src = lift(queue.shift()!);
    pieces.push(src);
    for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_][\w$]*)\(/g)) {
      if (!seen.has(m[1]) && declared(m[1])) { seen.add(m[1]); queue.push(m[1]); }
    }
  }
  return pieces;
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}

/**
 * The sequencer's /rpc as the page's rpc.js reaches it. Each answer is what the handler returns, written by l2Stringify;
 * l2_getBatch takes its batchNumber as a string or a bigint and refuses anything else, with the handler's message;
 * l2_getStateDigest names the latest batch number as the sequencer's bigint (l2-rpc-server.ts, case 'l2_getStateDigest':
 * latestBatchNumber: seq.getLatestBatchNumber(), a bigint or null), from which the page fetches the newest page.
 */
const OPERATOR = 'operator-token-for-the-stand-in';

function sequencer(batches: L2Batch[], receipts: L2Receipt[], { token = true }: { token?: boolean } = {}) {
  const wire: string[] = [];
  const answer = (method: string, params: Record<string, unknown>, authorization: string | undefined): unknown => {
    const limit = typeof params.limit === 'number' ? Math.min(params.limit, 1000) : 1000;
    const offset = typeof params.offset === 'number' ? Math.max(params.offset, 0) : 0;
    if (method === 'l2_getAllBatches') return batches.slice(offset, offset + limit);
    if (method === 'l2_getAllReceipts') {
      // D1: an enumeration answers the plan or the operator only (readPrincipal refuses anyone else with -32003)
      if (authorization !== 'Bearer ' + OPERATOR) throw Object.assign(new Error('Unauthorized: l2_getAllReceipts answers the plan or the operator'), { code: -32003 });
      return receipts.slice(offset, offset + limit);
    }
    if (method === 'l2_getStateDigest') {
      return { latestSequenceNumber: BigInt(receipts.length), latestBatchNumber: batches.length ? batches[batches.length - 1].batchNumber : null };
    }
    if (method === 'l2_getBatch') {
      const n = params.batchNumber;
      if (typeof n !== 'string' && typeof n !== 'bigint') throw new Error('Missing or invalid batchNumber parameter');
      return batches.find((b) => b.batchNumber === BigInt(n)) ?? null;
    }
    throw new Error(`Unknown method: ${method}`);
  };
  const fetch = async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const req = l2Parse<{ id: number; method: string; params?: Record<string, unknown> }>(init.body);
    let response: unknown;
    try {
      response = { jsonrpc: '2.0', id: req.id, result: answer(req.method, req.params ?? {}, init.headers?.Authorization) };
    } catch (err) {
      const message = (err as Error).message;
      const code = (err as { code?: number }).code;
      response = { jsonrpc: '2.0', id: req.id, error: { code: code ?? (message.startsWith('Unknown method') ? -32601 : -32602), message } };
    }
    const body = l2Stringify(response);
    wire.push(body);
    return { text: async () => body };
  };
  const RPC = new Function('location', 'fetch', 'EventSource', `${RPC_JS}\nreturn RPC;`)({ origin: 'http://127.0.0.1:3030' }, fetch, undefined);
  if (token) RPC.setAdminToken(OPERATOR);                       // as the Admin tab sets it
  return { RPC, wire };
}

/** The Batches & Receipts tab as loadBatches draws it from the sequencer's answers. */
async function batchesTab(batches: L2Batch[], receipts: L2Receipt[], opts: { token?: boolean } = {}) {
  const { RPC, wire } = sequencer(batches, receipts, opts);
  const els: Record<string, { innerHTML: string }> = {};
  const toasts: string[] = [];
  const load = run(liftWithCallees('loadBatches', ['$', 'toast']), {
    RPC, $: (id: string) => (els[id] = els[id] ?? { innerHTML: '' }), toast: (m: string) => { toasts.push(m); },
  }, 'loadBatches');
  await load();
  expect(toasts).toEqual([]);
  return { batchTable: String(els['batch-table'].innerHTML), receiptTable: String(els['receipt-table'].innerHTML), stats: String(els['batch-stats'].innerHTML), wire };
}

/** The batch window, opened as a row of the Batches table opens it: with the batch number as a number. */
async function batchWindow(batches: L2Batch[], receipts: L2Receipt[], batchNumber: number, opts: { token?: boolean } = {}): Promise<string> {
  const { RPC } = sequencer(batches, receipts, opts);
  const batchCache = await RPC.getBatches(5);                    // as loadBatchCache keeps it
  const els: Record<string, any> = {};
  const show = run(liftWithCallees('showBatchDetail', ['$']), {
    RPC, batchCache, $: (id: string) => (els[id] = els[id] ?? { id, style: {}, innerHTML: '', textContent: '' }),
  }, 'showBatchDetail');
  await show(batchNumber);
  return String(els['bm-body'].innerHTML);
}

// Wallet IDs and roots are Poseidon hashes, sent as decimal strings
const INSURER = '14602955305174928112620372950417253370561208473351624830917665210347715230018';
const PHARMACY = '23561871040652207148911675832047729918834103765212470057839254611008742266395';
const AVERY = '9381224457710346852390047761129805573218846620937754101284439652070185531147';
/** Registry roots: R[0] is the empty registry, then one after each accepted transition */
const R = [
  '24788165130318436427406127548399402722383373227706040567117858806745727393584',
  '11054739298461272330765148024867359026514718850234016721470896347262089450113',
  '19862357094480336918105127464922658117440051982306657114389076515537720938276',
  '6042511986620574813739270385546125901839975640186117348852095123300418892052',
  '27153340661187309823584125704369981234061278519066337940025478861233009461789',
  '15287930416735482903346581024960271125937402018462337958119044236071982224160',
];
/** Lifecycle roots, likewise */
const L = [
  '8125306619045387245109925437062915578206415637190087453206118439510238847215',
  '20019477361148805392716658014327796421100594762873501123498653307428810926561',
  '3312985760214568034477213590864231287659920013457812246690735518220931487706',
  '17760432981246650079318254003369472105556819387403628971125490073618534410392',
  '25503841719968021233758120461347765220913384057196120389174520316447019831147',
  '12298405617729530048162734455098216370041962288405316689920273456711230095518',
];
const AUDIT = [
  '4987125530918264473019283746650192837465501928374661029384756610293847565012',
  '21093847561029384756610293847561029384756102938475610293847561029384756102215',
  '16620193847561029384756102938475610293847561029384756102938475610293847561044',
  '7718293746501928374650192837465019283746501928374650192837465019283746501977',
  '26601928374650192837465019283746501928374650192837465019283746501928374650130',
];
const CLAIMS = ['22704163598314276251864937095512836140278953642019876543210987654321012345678', '5530912876543210987654321098765432109876543210987654321098765432109876543219'];
const MESSAGES = '18827465019283746501928374650192837465019283746501928374650192837465019283700';
const PROVIDERS = '9902837465019283746501928374650192837465019283746501928374650192837465019281';
const PROOF = JSON.stringify({ publicInput: [], publicOutput: [R[0], R[2], L[0], L[2], '2', '2'], maxProofsVerified: 2, proof: 'KChzdGF0ZW1lbnQgKHByb29mLXN5c3RlbSkp' });
const T0 = Date.UTC(2026, 9, 19, 14, 2, 11);

const receipts: L2Receipt[] = [
  { receiptId: 'l2-00000000', walletId: INSURER, sequenceNumber: 0n, oldRegistryRoot: R[0], newRegistryRoot: R[1], oldLifecycleRoot: L[0], newLifecycleRoot: L[1],
    isRegistration: true, l2BlockNumber: 0n, acceptedAt: T0, l1Status: 'settled', l1BatchNumber: 0n, auditEventHash: AUDIT[0] },
  { receiptId: 'l2-00000001', walletId: PHARMACY, sequenceNumber: 1n, oldRegistryRoot: R[1], newRegistryRoot: R[2], oldLifecycleRoot: L[1], newLifecycleRoot: L[2],
    isRegistration: true, l2BlockNumber: 0n, acceptedAt: T0 + 4_000, l1Status: 'settled', l1BatchNumber: 0n, auditEventHash: AUDIT[1] },
  { receiptId: 'l2-00000002', walletId: AVERY, sequenceNumber: 2n, oldRegistryRoot: R[2], newRegistryRoot: R[3], oldLifecycleRoot: L[2], newLifecycleRoot: L[3],
    isRegistration: true, l2BlockNumber: 1n, acceptedAt: T0 + 95_000, l1Status: 'settled', l1BatchNumber: 1n, auditEventHash: AUDIT[2] },
  // Avery's wallet update for the claim
  { receiptId: 'l2-00000003', walletId: AVERY, sequenceNumber: 3n, oldRegistryRoot: R[3], newRegistryRoot: R[4], oldLifecycleRoot: L[3], newLifecycleRoot: L[4],
    isRegistration: false, l2BlockNumber: 1n, acceptedAt: T0 + 96_000, l1Status: 'settled', l1BatchNumber: 1n, auditEventHash: AUDIT[3], claimLeafIndex: 0n },
  // accepted and not batched yet: no block, no batch
  { receiptId: 'l2-00000004', walletId: AVERY, sequenceNumber: 4n, oldRegistryRoot: R[4], newRegistryRoot: R[5], oldLifecycleRoot: L[4], newLifecycleRoot: L[5],
    isRegistration: false, acceptedAt: T0 + 140_000, l1Status: 'pending', auditEventHash: AUDIT[4] },
];
// L2-only: settled when built; no chain proof runs, so no globalStateRoot or blockHeight
const batches: L2Batch[] = [
  { batchNumber: 0n, blockNumbers: [0n], registrationCount: 2, transitionCount: 2, oldRegistryRoot: R[0], newRegistryRoot: R[2], oldLifecycleRoot: L[0], newLifecycleRoot: L[2],
    batchProofJson: PROOF, createdAt: T0 + 30_000, l1Status: 'settled', l1TxHash: 'l2-final-0', claimAccumulatorRoot: CLAIMS[0], messageStoreRoot: MESSAGES,
    providerRegistryRoot: PROVIDERS, workerId: 0, proveTimeMs: 41_250 },
  { batchNumber: 1n, blockNumbers: [1n], registrationCount: 1, transitionCount: 2, oldRegistryRoot: R[2], newRegistryRoot: R[4], oldLifecycleRoot: L[2], newLifecycleRoot: L[4],
    batchProofJson: PROOF, createdAt: T0 + 120_000, l1Status: 'settled', l1TxHash: 'l2-final-1', claimAccumulatorRoot: CLAIMS[1], messageStoreRoot: MESSAGES,
    providerRegistryRoot: PROVIDERS, workerId: 1, proveTimeMs: 38_900 },
];

/** app.js's shortHash */
const short = (h: string) => h.slice(0, 8) + '…' + h.slice(-6);
const hash = (h: string) => `<span class="hash">${short(h)}</span>`;
/** app.js's fmtTime */
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const SETTLED = '<span class="badge badge-ready">settled</span>';
/** The body rows of a table, each as its cells' inner HTML. */
const rows = (html: string): string[][] => html.split('<tr').slice(1).filter((r) => r.includes('<td'))
  .map((r) => [...r.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]));
const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('the Batches & Receipts tab reads the batches and receipts the sequencer sends', () => {
  test('Recent Receipts: each receipt\'s ID, status, wallet, batch number and time, newest first', async () => {
    const tab = await batchesTab(batches, receipts);
    expect(tab.wire.join(NL)).toContain('"receiptId":"l2-00000003","walletId":"' + AVERY + '","sequenceNumber":"__bigint__:3"');
    expect(rows(tab.receiptTable)).toEqual([
      ['l2-00000004', '<span class="badge badge-pending">pending</span>', hash(AVERY), '--', time(T0 + 140_000)],   // before: last
      ['l2-00000003', SETTLED, hash(AVERY), '#1', time(T0 + 96_000)],                          // before: ['--', ..., '--', ...]
      ['l2-00000002', SETTLED, hash(AVERY), '#1', time(T0 + 95_000)],
      ['l2-00000001', SETTLED, hash(PHARMACY), '#0', time(T0 + 4_000)],
      ['l2-00000000', SETTLED, hash(INSURER), '#0', time(T0)],
    ]);
  });

  test('Batches: each batch\'s number, status, proof count, the registry root it settles to, and time', async () => {
    const tab = await batchesTab(batches, receipts);
    expect(tab.batchTable).toContain('<th>Registry Root</th>');                                 // before: Root
    const got = rows(tab.batchTable);
    expect(got.map((cells) => text(cells[0]).replace(/^#/, ''))).toEqual(['1', '0']);                       // newest first
    expect(got.map((cells) => cells.slice(1))).toEqual([
      [SETTLED, '2', hash(R[4]), time(T0 + 120_000)],
      [SETTLED, '2', hash(R[2]), time(T0 + 30_000)],                                          // before: the root was "--"
    ]);
    expect(tab.batchTable).not.toContain('<span class="hash">--</span>');
  });

  test('a batch with no proofs shows 0, and a status the sequencer may send has its own badge', async () => {
    const empty: L2Batch = { ...batches[0], batchNumber: 2n, blockNumbers: [], registrationCount: 0, transitionCount: 0, batchProofJson: '', l1TxHash: 'empty-2' };
    const inFlight: L2Batch = { ...batches[1], batchNumber: 3n, l1Status: 'batched' };
    const failed: L2Batch = { ...batches[1], batchNumber: 4n, l1Status: 'failed', failureReason: 'proving failed' };
    const got = rows((await batchesTab([empty, inFlight, failed], [])).batchTable);
    expect(got.map((cells) => cells.slice(1, 3))).toEqual([
      ['<span class="badge badge-error">failed</span>', '2'],
      ['<span class="badge badge-info">batched</span>', '2'],
      [SETTLED, '0'],                                                                          // before: "--"
    ]);
  });
});

describe('the receipt lists answer the operator, and say so when refused', () => {
  test('more than thirty receipts: the thirty newest, newest first, as one page holds every receipt the sequencer keeps', async () => {
    const many: L2Receipt[] = Array.from({ length: 40 }, (_, n) => ({ ...receipts[4], receiptId: `l2-${String(n).padStart(8, '0')}`, sequenceNumber: BigInt(n), acceptedAt: T0 + n * 1000 }));
    const got = rows((await batchesTab(batches, many)).receiptTable).map((cells) => cells[0]);
    expect(got.length).toBe(30);
    expect(got.slice(0, 2)).toEqual(['l2-00000039', 'l2-00000038']);                             // before: l2-00000000 first
    expect(got[29]).toBe('l2-00000010');
  });

  test('without the operator\'s token the lists say why they are empty, not "No receipts"', async () => {
    const tab = await batchesTab(batches, receipts, { token: false });
    expect(text(tab.receiptTable)).toBe('Receipts answer the plan or the operator: set the operator token on the Admin tab');   // before: No receipts
    expect(tab.stats).toContain('<span class="stat-label">Receipts</span><span class="stat-value">--</span>');
    expect(rows(tab.batchTable).length).toBe(2);                                                   // the batches still answer
    const body = await batchWindow(batches, receipts, 1, { token: false });
    expect(body).toContain('Receipts answer the plan or the operator');                           // before: No receipts found for this batch
    expect(body).not.toContain('No receipts found for this batch');
  });
});

describe('the batch window lists a batch\'s receipts by their own fields', () => {
  test('the receipts whose l1BatchNumber is the batch\'s number, each with its ID, status, wallet, sequence number, roots and claim leaf', async () => {
    const body = await batchWindow(batches, receipts, 1);
    expect([...body.matchAll(/<span class="bm-receipt-id">(.*?)<\/span>/g)].map((m) => m[1])).toEqual(['l2-00000002', 'l2-00000003']);
    expect(body).toContain('Transactions (2)');
    expect(body).toContain('<span class="bm-badge bm-receipt-badge settled">settled</span>');
    expect(body).toContain(`<span>Wallet: <b class="bm-hash">${short(AVERY)}</b></span><span>Seq: <b>3</b></span><span>Type: <b>Transition</b></span>`);
    expect(body).toContain(`<b class="bm-hash">${short(R[3])}</b><span class="bm-arrow">→</span><b class="bm-hash">${short(R[4])}</b>`);
    expect(body).toContain(`<span>Audit Hash: <b class="bm-hash">${short(AUDIT[3])}</b></span>`);
    expect(body).toContain('<span>Claim Leaf: <b>0</b></span>');
    expect(await batchWindow(batches, receipts, 0)).toContain('Transactions (2)');           // batch 0: the two registrations
  });
});

describe('every value from the network is escaped', () => {
  // A replica keeps the receipts and batches a peer gossips as they arrive (applyReplicatedReceipt,
  // applyReplicatedBatch), so the page draws whatever its node was sent.
  const MARKUP = '<img src=x onerror=steal()>';
  const STATUS = 'settled" onmouseover="steal()';
  const hostileReceipt = {
    ...receipts[3], receiptId: MARKUP, l1Status: STATUS, walletId: MARKUP + '7'.repeat(50), sequenceNumber: MARKUP,
    oldRegistryRoot: MARKUP + '1'.repeat(50), newRegistryRoot: MARKUP + '2'.repeat(50), auditEventHash: MARKUP + '3'.repeat(50), claimLeafIndex: MARKUP,
  } as unknown as L2Receipt;
  const hostileBatch = { ...batches[1], l1Status: STATUS, transitionCount: MARKUP, newRegistryRoot: MARKUP + '4'.repeat(50) } as unknown as L2Batch;
  const handlers = (html: string) => (html.match(/<[^>]*>/g) ?? []).filter((tag) => /\bon(error|load|mouseover)=/.test(tag));
  // a status badge as drawn: its class, and its text as the browser reads it, whatever entities the page chose
  const decode = (t: string) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const badge = (html: string) => { const m = /^<span class="([^"]*)">([^<]*)<\/span>$/.exec(html); return m && { cls: m[1], text: decode(m[2]) }; };

  test('in both tables', async () => {
    const tab = await batchesTab([batches[0], hostileBatch], [receipts[0], hostileReceipt, { ...receipts[4], l1BatchNumber: '1' + MARKUP } as unknown as L2Receipt]);
    for (const html of [tab.batchTable, tab.receiptTable]) {
      expect(html).not.toContain('<img');                                                      // before: the proof count and the wallet
      expect(handlers(html)).toEqual([]);
    }
    const [id, status] = rows(tab.receiptTable)[1];
    expect(id).toBe('&lt;img src=x onerror=steal()&gt;');
    expect(badge(status)).toEqual({ cls: 'badge badge-pending', text: STATUS });              // a fixed class; the status only as text
    expect(rows(tab.receiptTable)[2][3]).toBe('#1&lt;img src=x onerror=steal()&gt;');
    const [, batchStatus, proofs, root] = rows(tab.batchTable)[0];
    expect(badge(batchStatus)).toEqual({ cls: 'badge badge-pending', text: STATUS });
    expect([proofs, root]).toEqual(['&lt;img src=x onerror=steal()&gt;', '<span class="hash">&lt;img src…444444</span>']);
  });

  test('in the batch window\'s receipt list, and the status names no class it was not given', async () => {
    const body = await batchWindow(batches, [receipts[2], hostileReceipt], 1);
    const list = body.slice(body.indexOf('Transactions ('));
    expect(list).not.toContain('<img');                                                        // before: the sequence number, claim leaf and hashes
    expect(handlers(list)).toEqual([]);                                                        // before: class="bm-badge bm-receipt-badge settled" onmouseover="steal()"
    const head = /<span class="bm-receipt-id">&lt;img src=x onerror=steal\(\)&gt;<\/span>(<span class="[^"]*">[^<]*<\/span>)/.exec(list);
    expect(head && badge(head[1])).toEqual({ cls: 'bm-badge bm-receipt-badge ', text: STATUS });
    expect(list).toContain('<span>Seq: <b>&lt;img src=x onerror=steal()&gt;</b></span>');
    expect(list).toContain('<span>Claim Leaf: <b>&lt;img src=x onerror=steal()&gt;</b></span>');
    expect(list).toContain('<span class="bm-badge bm-receipt-badge settled">settled</span>');  // Avery's registration, untouched
  });

  test('in the batch window\'s own fields, and the status names a class only from the sequencer\'s four', async () => {
    const hostile = { ...batches[1], l1Status: STATUS, registrationCount: MARKUP, workerId: MARKUP, blockHeight: MARKUP, globalStateRoot: MARKUP,
      claimAccumulatorRoot: MARKUP + '5'.repeat(50), oldRegistryRoot: MARKUP + '6'.repeat(50) } as unknown as L2Batch;
    const body = await batchWindow([batches[0], hostile], receipts, 1);
    const overview = body.slice(0, body.indexOf('Transactions ('));
    expect(overview).not.toContain('<img');                                                     // before: every one of those fields
    expect(handlers(overview)).toEqual([]);
    const status = /<span class="bm-label">Status<\/span><span class="bm-value">(<span class="[^"]*">[^<]*<\/span>)/.exec(overview);
    expect(status && badge(status[1])).toEqual({ cls: 'bm-badge ', text: STATUS });
  });

  test('in the Overview\'s batch pipeline', () => {
    const list = { innerHTML: '' };
    run([lift('statusClass'), lift('escHtml'), lift('renderBatchPanel')], {
      $: () => list, fmtTime: () => '12:00:00',
      batchCache: [{ batchNumber: '1', l1Status: STATUS, transitionCount: MARKUP }, { batchNumber: '0', l1Status: 'settled', transitionCount: 2 }],
    }, 'renderBatchPanel')();
    expect(list.innerHTML).not.toContain('<img');
    expect(handlers(list.innerHTML)).toEqual([]);                                                // before: class="cc-batch-status settled" onmouseover=...
    expect(list.innerHTML).toContain('<div class="cc-batch-item " data-batch="1">');           // no class from the network
    expect(list.innerHTML).toContain('<div class="cc-batch-item settled" data-batch="0">');
  });
});

describe('the fields are the ones the server declares', () => {
  // ts-jest only transpiles here, so the types above are not checked: the declarations are read from source instead.
  const TYPES = read('src/l2/l2-types.ts');
  const declared = (name: string): string[] => {
    const at = TYPES.indexOf(`export interface ${name} {`);
    if (at < 0) throw new Error('no interface ' + name);
    return [...TYPES.slice(at, TYPES.indexOf(NL + '}' + NL, at)).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  };

  test('the answers above carry only fields of L2Receipt and L2Batch, and the page reads no receipt field L2Receipt lacks', () => {
    const receiptFields = declared('L2Receipt');
    const batchFields = declared('L2Batch');
    expect(receiptFields).toEqual(expect.arrayContaining(['receiptId', 'l1Status', 'walletId', 'l1BatchNumber', 'acceptedAt', 'sequenceNumber']));
    expect(batchFields).toEqual(expect.arrayContaining(['batchNumber', 'l1Status', 'transitionCount', 'newRegistryRoot', 'createdAt']));
    expect(batchFields.filter((f) => f === 'stateRoot' || f === 'settlementRoot')).toEqual([]);   // what the Root column read
    for (const r of receipts) expect(Object.keys(r).filter((k) => !receiptFields.includes(k))).toEqual([]);
    for (const b of batches) expect(Object.keys(b).filter((k) => !batchFields.includes(k))).toEqual([]);
    // every r.<field> in the Recent Receipts rows and the batch window's receipt list
    const reads = new Set([...(lift('loadBatches') + lift('showBatchDetail')).matchAll(/\br\.(\w+)/g)].map((m) => m[1]));
    expect([...reads].filter((f) => !receiptFields.includes(f))).toEqual([]);                  // before: id, status, batchIndex, timestamp, seqNum
  });
});
