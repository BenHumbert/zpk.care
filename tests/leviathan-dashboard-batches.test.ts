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
 * The network screen's Batches tab, its batch window and the Overview's batch pipeline show the sequencer's batches.
 *
 * What was wrong: the batch window asked l2_getBatch for the batch with a JSON number (a row's onclick writes the
 * number as a literal), and the sequencer takes a batch number only as a decimal string, as it takes every chain
 * number; L2Client, the e2e harness and tests/l2-network.test.ts all send one. The refusal was swallowed and the window
 * fell back to the Overview's cache, which held the five oldest batches, so from batch #5 on it said "Batch not found".
 * The Latest Batch card read batches[0].index: l2_getAllBatches pages from the oldest and a batch has no index field,
 * so the card said #0 however many batches there were. The tab listed the oldest 30 of the oldest 50 batches, and the
 * pipeline the oldest five. Found by the scene audit of the walkthrough, 2026-10-19: the batch scene opens the claim's
 * batch from this tab, and the window of a claim in batch #5 or later would have said "Batch not found". (In the browser
 * a row's inline onclick did not run at all under the page's policy, script-src 'self': tests/dashboard-inline-handlers.test.ts.)
 *
 * Now the window asks for the batch by its number as a string, and the tab, its Latest Batch card and the pipeline
 * read the newest batches, newest first: the page of l2_getAllBatches that ends at the state digest's latestBatchNumber.
 *
 * A real sequencer (L2Node and L2RpcServer on a free port) holds empty batches made with buildBatch(); rpc.js runs
 * against it as the page runs it, and the screen's functions are lifted out of app.js and run with stand-in elements.
 * A click goes through the page's own listener (setupBatchDetail), which reads the clicked row's data-batch.
 */
import fs from 'fs';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(120_000);

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
const SCREEN_FUNCTIONS = ['shortHash', 'fmtTime', 'statCard', 'escHtml', 'bmRow', 'bmRootRow',
  'statusClass', 'isRefusal', 'receiptsRefusedNote', 'settlementBadge', 'renderBatchPanel', 'showBatchDetail', 'setupBatchDetail',
  'loadBatchCache', 'loadBatches'];

const OPERATOR = 'operator-network-screen';

/** A sequencer on a free port; buildTo(n) makes it hold batches #0 to #n-1, empty ones, so nothing is proved. */
async function sequencer() {
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-network-screen' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  const rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  await rpcServer.start();
  const seq = node.getSequencer();
  return {
    origin: `http://127.0.0.1:${rpcServer.getPort()}`,
    buildTo: async (n: number) => { while (seq.getAllBatches().length < n) await seq.buildBatch(); },
    stop: () => rpcServer.stop(),
  };
}
type Sequencer = Awaited<ReturnType<typeof sequencer>>;

interface Exchange { method: string; params: any; error?: { code: number; message: string }; result?: any }
interface ScreenFunctions {
  loadBatches(): Promise<void>;
  loadBatchCache(): Promise<void>;
  renderBatchPanel(): void;
  showBatchDetail(batchIdx: number): Promise<void>;
}

/** The screen's batch code against the sequencer at `origin`: rpc.js as the page loads it, app.js's functions with stand-in elements. */
function screen(origin: string) {
  const exchanges: Exchange[] = [];
  const RPC = new Function('location', 'fetch', 'EventSource', `${RPC_JS}\nreturn RPC;`)(
    { origin },
    async (url: string, init: any) => {
      const res = await fetch(url, init);
      const sent = JSON.parse(init.body);
      const answer = JSON.parse(await res.clone().text());
      exchanges.push({ method: sent.method, params: sent.params, error: answer.error, result: answer.result });
      return res;
    },
    undefined,
  );
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] = els[id] ?? {
    id, innerHTML: '', textContent: '', style: {}, listeners: [] as Array<(e: unknown) => void>,
    addEventListener(type: string, fn: (e: unknown) => void) { if (type === 'click') this.listeners.push(fn); },
  });
  const toasts: string[] = [];
  const window: Record<string, unknown> = {};
  const fns: ScreenFunctions = new Function('RPC', '$', 'window', 'diagLog', 'toast',
    `'use strict';\nvar batchCache = [];\n${SCREEN_FUNCTIONS.map(lift).join(NL)}\nwindow._showBatchDetail = showBatchDetail;\n` +
    'setupBatchDetail();\nreturn { loadBatches, loadBatchCache, renderBatchPanel, showBatchDetail };',
  )(RPC, $, window, () => undefined, (m: string) => { toasts.push(m); });
  const html = (id: string): string => String($(id).innerHTML);
  return {
    ...fns, $, html, exchanges, toasts,
    /** The operator's token, set as the Admin tab sets it: the receipt list answers only the plan or the operator (D1). */
    signIn: () => RPC.setAdminToken(OPERATOR),
    /** The data-batch of each row of the Batches table, top to bottom. */
    rows: (): number[] => [...html('batch-table').matchAll(/<tr data-batch="([^"]*)"/g)].map((m) => Number(m[1])),
    /**
     * A click on the row of `list` drawn with data-batch="n": the list's own listener gets an event whose target sits in
     * that row, as the browser hands it over. Resolves once the batch window has drawn.
     */
    click: async (list: string, n: number): Promise<void> => {
      const drawn = [...html(list).matchAll(/data-batch="([^"]*)"/g)].map((m) => m[1]);
      if (!drawn.includes(String(n))) throw new Error(`no row with data-batch="${n}" in #${list}`);
      const row = { dataset: { batch: String(n) } };
      const event = { target: { closest: (sel: string) => (sel === '[data-batch]' ? row : null) } };
      for (const fn of $(list).listeners) fn(event);
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 50 && /Loading batch details/.test(html('bm-body')); i++) await new Promise((r) => setTimeout(r, 20));
    },
    /** The value of the Batches tab's stat card with this label. */
    stat: (label: string): string | undefined =>
      html('batch-stats').match(new RegExp(`<span class="stat-label">${label}</span><span class="stat-value">([^<]*)</span>`))?.[1],
  };
}
const batchNumberRow = (n: number) => `<span class="bm-label">Batch Number</span><span class="bm-value">#${n}</span>`;

describe('with batches #0 to #7', () => {
  let s: Sequencer;
  beforeAll(async () => { s = await sequencer(); await s.buildTo(8); });
  afterAll(async () => { await s?.stop(); });

  test('the Batches tab: Latest Batch is the newest batch, and the table lists the newest first', async () => {
    const sc = screen(s.origin);
    await sc.loadBatches();
    expect(sc.stat('Latest Batch')).toBe('#7');                                  // before: #0
    expect(sc.stat('Batches')).toBe('8');
    expect(sc.rows()).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);                          // before: #0 first
    expect(sc.toasts).toEqual([]);
  });

  test('a row opens its batch in the window, #5 and later included: l2_getBatch is asked for the number as a string', async () => {
    const sc = screen(s.origin);
    sc.signIn();
    await sc.loadBatchCache();                                                   // the Overview loads its cache at start
    await sc.loadBatches();
    expect(sc.rows()).toContain(7);
    await sc.click('batch-table', 7);
    expect(sc.$('bm-title').textContent).toBe('Batch #7');
    expect(sc.html('bm-body')).toContain(batchNumberRow(7));                     // before: Batch not found
    const asked = sc.exchanges.filter((x) => x.method === 'l2_getBatch');
    expect(asked.map((x) => x.params)).toEqual([{ batchNumber: '7' }]);          // before: { batchNumber: 7 }
    expect(asked[0].error).toBeUndefined();                                      // before: -32602 Missing or invalid batchNumber parameter
    expect(asked[0].result.batchNumber).toBe('__bigint__:7');
    // with the operator's token every call is answered, the receipt list included (it answers the plan or the operator)
    expect(sc.exchanges.filter((x) => x.error)).toEqual([]);                    // before: l2_getAllReceipts refused, token or not
    expect(sc.exchanges.filter((x) => x.method === 'l2_getAllReceipts').map((x) => x.params)).toEqual([{ limit: 1000, offset: 0 }, { limit: 1000, offset: 0 }]);
  });

  test('without the operator\'s token the window says why it lists no receipts', async () => {
    const sc = screen(s.origin);
    await sc.showBatchDetail(3);
    expect(sc.html('bm-body')).toContain(batchNumberRow(3));
    expect(sc.html('bm-body')).toContain('Receipts answer the plan or the operator: set the operator token on the Admin tab');
    expect(sc.html('bm-body')).not.toContain('No receipts found for this batch');            // before: said there were none
  });

  test('before the Overview has its cache, every batch opens from the sequencer; one it does not hold is not found', async () => {
    const sc = screen(s.origin);
    for (const n of [0, 3, 5, 7]) {
      await sc.showBatchDetail(n);
      expect([n, sc.html('bm-body').includes(batchNumberRow(n))]).toEqual([n, true]);   // before: Batch not found, #0 to #4 too
    }
    await sc.showBatchDetail(8);
    expect(sc.html('bm-body')).toBe('<div class="empty-state">Batch not found</div>');
  });

  test('the Overview\'s batch pipeline shows the five newest batches, newest first, and each opens', async () => {
    const sc = screen(s.origin);
    await sc.loadBatchCache();
    sc.renderBatchPanel();
    const items = [...sc.html('cc-batch-list').matchAll(/data-batch="([^"]*)"><span class="cc-batch-num">([^<]*)<\/span>/g)];
    expect(items.map((m) => m[2])).toEqual(['#7', '#6', '#5', '#4', '#3']);      // before: #0 to #4
    await sc.click('cc-batch-list', Number(items[0][1]));
    expect(sc.html('bm-body')).toContain(batchNumberRow(7));
  });
});

describe('past 50 batches', () => {
  let s: Sequencer;
  beforeAll(async () => { s = await sequencer(); await s.buildTo(60); });
  afterAll(async () => { await s?.stop(); });

  test('the tab shows the newest: Latest Batch #59, rows #59 to #30, and #59 opens', async () => {
    const sc = screen(s.origin);
    await sc.loadBatches();
    expect(sc.stat('Latest Batch')).toBe('#59');                                 // before: #0
    expect(sc.stat('Batches')).toBe('60');                                       // every batch, not the page of 50
    expect(sc.rows()).toEqual(Array.from({ length: 30 }, (_, i) => 59 - i));      // before: #0 to #29
    await sc.click('batch-table', sc.rows()[0]);
    expect(sc.html('bm-body')).toContain(batchNumberRow(59));
  });
});

describe('with no batches', () => {
  let s: Sequencer;
  beforeAll(async () => { s = await sequencer(); });
  afterAll(async () => { await s?.stop(); });

  test('Latest Batch says --, the table No batches and the pipeline No batches yet', async () => {
    const sc = screen(s.origin);
    await sc.loadBatches();
    expect(sc.stat('Latest Batch')).toBe('--');
    expect(sc.html('batch-table')).toBe('<div class="empty-state">No batches</div>');
    await sc.loadBatchCache();
    sc.renderBatchPanel();
    expect(sc.html('cc-batch-list')).toBe('<div class="cc-empty">No batches yet</div>');
  });
});
