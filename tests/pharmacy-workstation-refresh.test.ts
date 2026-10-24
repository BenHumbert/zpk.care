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
 * The pharmacy workstation keeps its cards on screen while it refreshes.
 *
 * What was wrong: loadWorkstation wrote Loading... into all four columns (Adjudicated, Filled, Dispensed, History) at
 * the start of every call, and only the node's answer drew them again. It runs every 10 s, on every proof accepted or
 * rejected anywhere on the network, on Refresh and on each visit to the tab, and each time the cards went blank for a
 * round trip to the node and the engine behind it: their Fill, Verify Member, Dispense and Payment Received buttons
 * went with them, a click could land on an empty column, and a long column jumped back to its top. A refresh that
 * failed or came back empty drew nothing (the guard that keeps the cards when an answer is empty ran after the wipe),
 * so the board stayed on Loading... until a later refresh got an answer. Found by the scene audit of the walkthrough,
 * 2026-10-19: frame by frame, every column read Loading... during the fill, the dispense and the payment, and the
 * click that opened the Workstation tab found an empty board.
 *
 * Now Loading... shows only until the selected pharmacy's scripts are first drawn: when the page opens, and after a
 * switch to another pharmacy. A refresh leaves the board as it is until its answer replaces it, and a refresh that
 * fails or comes back empty leaves the cards drawn.
 *
 * loadWorkstation, the tab entry, the event stream's handler and the pharmacy switch are lifted out of app.js and run
 * against four stand-in columns, a stand-in for renderWorkstationColumns, and a stand-in node that answers when the
 * test says so.
 */
import fs from 'fs';

const NL = '\n';
const APP = fs.readFileSync('dashboard-pharmacy/app.js', 'utf8').replace(/\r\n/g, NL);

/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
/** The workstation's state: what app.js declares from "let allClaims" down to loadWorkstation. */
function liftWorkstationState(): string {
  const at = APP.indexOf(NL + '  let allClaims = [];');
  if (at < 0) throw new Error('no workstation state');
  return APP.slice(at + 1, APP.indexOf(NL + '  async function loadWorkstation(', at));
}
const flush = () => new Promise<void>((r) => setImmediate(r));

const PHARMACIES = [{ npi: '2999000518', name: 'Kettleby Pharmacy' }, { npi: '2999000526', name: 'Wexley Road Pharmacy' }];
const COLUMNS = ['ws-adjudicated-list', 'ws-filled-list', 'ws-dispensed-list', 'ws-history-list'];
/** What an empty column says, and the column a script's status puts it in, as renderColumn and getScriptStatus do. */
const EMPTY = ['No adjudicated scripts — waiting for eScripts from prescribers', 'No scripts awaiting pickup', 'No dispensed scripts', 'No completed scripts'];
const COLUMN_OF: Record<string, number> = { PENDING: 0, ADJUDICATED: 0, FILLED: 1, DISPENSED: 2 };
const LOADING = ['Loading...', 'Loading...', 'Loading...', 'Loading...'];

interface Script { prescriptionId: string; status: string; brandName: string; ndcHash: string; memberWalletId: string; pharmacyWalletId: string; dateOfService: string }
/** The one script in this pharmacy's queue at the engine, as /prescriptions/list passes it on. */
const rx = (status: string): Script => ({
  prescriptionId: 'RX-1', status, brandName: 'ALLOPURINOL (Generic)', ndcHash: '4170552386319254741',
  memberWalletId: '8813290045726171905', pharmacyWalletId: '1592277061840388127', dateOfService: '2026-10-19',
});
/** The board with that script in its status's column. */
const showing = (status: string): string[] => EMPTY.map((empty, i) => (i === COLUMN_OF[status] ? 'ALLOPURINOL (Generic)' : empty));

function workstation() {
  const columns = COLUMNS.map(() => ({ innerHTML: '' }));
  const waiting: Array<{ path: string; resolve: (answer: unknown) => void; reject: (err: Error) => void }> = [];
  const call = (path: string) => new Promise((resolve, reject) => { waiting.push({ path, resolve, reject }); });
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  let onEvent: (ev: { type: string }) => void = () => {};
  let pharmacy = PHARMACIES[0];
  const toasts: string[] = [];
  const scope: Record<string, unknown> = {
    window: {},
    document: { getElementById: (id: string) => columns[COLUMNS.indexOf(id)] ?? null },
    API: {
      onboarding: { status: async () => ({ walletId: '6025189344170086253' }) },
      prescriptions: { list: () => call('/prescriptions/list') },
      dispensing: { list: () => call('/dispensing') },
      sse: { connect: () => {}, onEvent: (fn: typeof onEvent) => { onEvent = fn; } },
    },
    getSelectedPharmacy: () => pharmacy,
    setSelectedPharmacy: (npi: string) => { pharmacy = PHARMACIES.find((p) => p.npi === npi)!; },
    setVerifiedMemberWallet: () => {},
    setText: () => {}, truncate: (s: unknown) => String(s ?? ''), timeStr: () => '17:30:00', $: () => null,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    toast: (message: string) => { toasts.push(message); },
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
    loadHistory: () => {}, loadMessaging: () => {}, loadOnboarding: () => {}, loadProofs: () => {},
    /** What renderWorkstationColumns draws: each card in its status's column, and an empty column's message. */
    draw: (claims: Script[]) => columns.forEach((col, i) => {
      const cards = claims.filter((c) => (COLUMN_OF[c.status] ?? 3) === i);
      col.innerHTML = cards.length
        ? cards.map((c) => '<div class="script-card">' + c.brandName + '</div>').join('')
        : '<div class="ws-empty">' + EMPTY[i] + '</div>';
    }),
  };
  const body = [
    "let currentTab = 'workstation';", 'let onboardingStatus = null;', 'let sseEvents = [];', 'const MAX_EVENTS = 200;',
    'let scriptWorkflow = {};', liftWorkstationState(), 'function renderWorkstationColumns() { draw(allClaims); }',
    lift('resetWorkflow'), lift('scriptKey'), lift('onTabEnter'), lift('initSSE'), lift('loadWorkstation'), lift('switchPharmacy'),
    lift('findClaimByKey'), lift('confirmPayment'),
  ].join(NL);
  const names = Object.keys(scope);
  const page = new Function(...names, `'use strict';\n${body}\nreturn { loadWorkstation, onTabEnter, initSSE, switchPharmacy, confirmPayment, scriptKey };`)(
    ...names.map((n) => scope[n])) as {
      loadWorkstation: () => Promise<void>; onTabEnter: (tab: string) => void; initSSE: () => void; switchPharmacy: (npi: string) => void;
      confirmPayment: (key: string) => void; scriptKey: (s: Script) => string;
    };
  page.initSSE();
  return {
    ...page,
    intervals, toasts,
    /** What each column reads, Adjudicated to History. */
    board: () => columns.map((col) => col.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()),
    /** The calls waiting at the node. */
    waiting: () => waiting.map((w) => w.path).sort(),
    /** The node answers every waiting call: the queue for /prescriptions/list, no ledger claims for /dispensing. */
    answer: (queue: Script[]) => { for (const w of waiting.splice(0)) w.resolve(w.path === '/prescriptions/list' ? { prescriptions: queue } : []); },
    /** The node fails every waiting call, as when the engine is out of reach. */
    fail: () => { for (const w of waiting.splice(0)) w.reject(new Error('The engine could not resolve this pharmacy (HTTP 502)')); },
    /** An event on the node's stream. */
    event: (type: string) => onEvent({ type }),
  };
}
type Workstation = ReturnType<typeof workstation>;

/** A workstation that has opened on its tab and drawn the node's first answer. */
async function opened(queue: Script[]): Promise<Workstation> {
  const w = workstation();
  w.onTabEnter('workstation');
  await flush();
  w.answer(queue);
  await flush();
  return w;
}

describe('the pharmacy workstation keeps its cards on screen while it refreshes', () => {
  test('the first load says Loading... in every column until the node answers, then draws the scripts', async () => {
    const w = workstation();
    w.onTabEnter('workstation');                                   // the page opens on the Workstation
    await flush();
    expect(w.waiting()).toEqual(['/dispensing', '/prescriptions/list']);
    expect(w.board()).toEqual(LOADING);
    w.answer([rx('ADJUDICATED')]);
    await flush();
    expect(w.board()).toEqual(showing('ADJUDICATED'));
    expect(w.intervals.map((t) => t.ms)).toEqual([10000]);         // the refresh every 10 s, set once
  });

  test('a pharmacy with no scripts gets its empty columns, not a Loading... that stays', async () => {
    const w = await opened([]);
    expect(w.board()).toEqual(EMPTY);
  });

  test.each([
    ['the 10 s timer', (w: Workstation) => { w.intervals[0].fn(); }],
    ['a proof accepted anywhere on the network', (w: Workstation) => { w.event('proof:accepted'); }],
    ['a proof rejected anywhere on the network', (w: Workstation) => { w.event('proof:rejected'); }],
    ['Refresh', (w: Workstation) => { void w.loadWorkstation(); }],
    ['a return to the tab', (w: Workstation) => { w.onTabEnter('workstation'); }],
  ])('a refresh by %s leaves the board as it was until its answer replaces it', async (_refresh, start) => {
    const w = await opened([rx('ADJUDICATED')]);
    start(w);
    await flush();
    expect(w.waiting()).toEqual(['/dispensing', '/prescriptions/list']);   // the refresh is out at the node
    expect(w.board()).toEqual(showing('ADJUDICATED'));                     // before: Loading... in all four columns
    w.answer([rx('FILLED')]);                                              // the fill the pharmacist just made
    await flush();
    expect(w.board()).toEqual(showing('FILLED'));
  });

  test('the Refresh button\'s listener is loadWorkstation itself', () => {
    expect(APP).toContain("$('#ws-refresh-btn').addEventListener('click', loadWorkstation);");
  });

  test.each([
    ['fails', (w: Workstation) => { w.fail(); }],
    ['comes back empty', (w: Workstation) => { w.answer([]); }],
  ])('a refresh that %s leaves the cards drawn', async (_outcome, settle) => {
    const w = await opened([rx('DISPENSED')]);
    w.intervals[0].fn();
    await flush();
    settle(w);
    await flush();
    expect(w.board()).toEqual(showing('DISPENSED'));                       // before: Loading... until a later refresh got an answer
  });

  test.each([
    ['fails', (w: Workstation) => { w.fail(); }],
    ['comes back empty', (w: Workstation) => { w.answer([]); }],
  ])('after a refresh that %s, the cards\' buttons still find their scripts', async (_outcome, settle) => {
    const w = await opened([rx('DISPENSED')]);
    w.intervals[0].fn();
    await flush();
    settle(w);
    await flush();
    w.confirmPayment(w.scriptKey(rx('DISPENSED')));                         // Payment Received on the card still drawn
    expect(w.toasts).toEqual(['Payment recorded']);                        // before: nothing, the list behind the board was empty
    expect(w.board()).toEqual(showing('DISPENSED'));
  });

  test('after a switch whose first load fails, nothing of the first pharmacy is kept behind its board', async () => {
    const w = await opened([rx('FILLED')]);
    w.switchPharmacy('2999000526');
    await flush();
    w.fail();
    await flush();
    w.confirmPayment(w.scriptKey(rx('FILLED')));                            // a key from the first pharmacy's board
    expect(w.toasts).toEqual([]);
    expect(w.board()).toEqual(LOADING);
  });

  test('after a switch to another pharmacy its columns say Loading... until its scripts are drawn, and its refreshes keep them', async () => {
    const w = await opened([rx('FILLED')]);
    w.switchPharmacy('2999000526');
    await flush();
    expect(w.board()).toEqual(LOADING);                                    // the first pharmacy's cards are not left up meanwhile
    w.answer([rx('FILLED')]);
    await flush();
    expect(w.board()).toEqual(showing('FILLED'));
    w.intervals[0].fn();
    await flush();
    expect(w.board()).toEqual(showing('FILLED'));                          // before: Loading... again
  });
});
