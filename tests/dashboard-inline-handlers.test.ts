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
 * The network screen's batch rows and the HR Tool's page buttons, under the servers' Content-Security-Policy.
 *
 * What was wrong: the sequencer's RPC server serves the network screen (dashboard-leviathan/) with script-src 'self',
 * which refuses every inline event handler attribute. The screen's batch rows, in the Overview's Batch Pipeline and on
 * the Batches tab, and the batch window's close button were wired with onclick attributes, so a click on them did
 * nothing. The walkthrough rehearsal of 2026-10-19 hit it: the batch window never opened. In Chromium against the live
 * network a click on a Batches row logged "Executing inline event handler violates the following Content Security
 * Policy directive 'script-src 'self''... The action has been blocked", while window._showBatchDetail(3) called from
 * script opened the window. The HR Tool (dashboard-hr-tool/) wired its four Quick Actions and both Switch Group
 * buttons the same way. Its server's policy listed 'unsafe-inline' under script-src, so those ran, but only through
 * that keyword; and its esc() did not escape quotes, though it fills data-* attributes with values from the imported
 * roster, so a crafted CSV value could end an attribute and add a handler that the keyword let run.
 *
 * Now neither folder has an inline handler; the network screen's policy is unchanged, the HR Tool's no longer lists
 * 'unsafe-inline' under script-src, and its esc() escapes quotes. A batch row carries its batch number in
 * data-batch, and one listener on each list, which outlives every redraw, opens the batch; the close button has an id
 * and a listener; a button that opens an HR Tool page names it in data-goto, and one listener on #app, into which
 * every page is drawn, sets the hash. The network screen's escape helper now escapes double quotes, since it fills an
 * attribute.
 *
 * The listeners and the markup are lifted out of app.js and run against stand-in elements whose clicks bubble as a
 * browser's do.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const FOLDERS = ['dashboard-leviathan', 'dashboard-hr-tool'];
const NETWORK_APP = read('dashboard-leviathan/app.js');
const HR_APP = read('dashboard-hr-tool/app.js');

/** A top-level function of an IIFE dashboard: from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
/** The HR Tool's listener on #app: from its registration to the first line that is exactly "  });". */
function liftGotoListener(): string {
  const at = HR_APP.indexOf(NL + "  app.addEventListener('click'");
  if (at < 0) throw new Error('no click listener on #app');
  const end = HR_APP.indexOf(NL + '  });' + NL, at);
  return HR_APP.slice(at + 1, end + 6);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The Content-Security-Policy a server sets on every response, as directive name -> sources. */
function policyOf(file: string): Record<string, string[]> {
  const set = [...read(file).matchAll(/setHeader\('Content-Security-Policy', "([^"]+)"\)/g)].map((m) => m[1]);
  expect(set).toHaveLength(1);
  const policy: Record<string, string[]> = {};
  for (const directive of set[0].split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) policy[name] = sources;
  }
  return policy;
}
/** Whether an inline event handler runs under a policy: the directive that governs it (script-src-attr, else
 *  script-src, else default-src) must list 'unsafe-inline', and a nonce or a hash beside it cancels that. */
function inlineHandlersRun(policy: Record<string, string[]>): boolean {
  const sources = policy['script-src-attr'] ?? policy['script-src'] ?? policy['default-src'];
  if (!sources) return true;
  return sources.includes("'unsafe-inline'") && !sources.some((s) => /^'(nonce-|sha(256|384|512)-)/.test(s));
}
/** The sources a policy allows a script file from: script-src-elem, else script-src, else default-src. */
const scriptFileSources = (policy: Record<string, string[]>): string[] =>
  policy['script-src-elem'] ?? policy['script-src'] ?? policy['default-src'] ?? [];
/** Every script and page under a folder. */
const pageFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? pageFiles(`${dir}/${d.name}`) : /\.(js|html)$/.test(d.name) ? [`${dir}/${d.name}`] : []);
/** Markup that runs as inline script: a handler attribute (in index.html, or in an HTML string in a script), a
 *  javascript: URL, or a handler set through setAttribute. */
const INLINE: Array<[string, RegExp]> = [
  ['inline handler', /<[a-z][\w-]*(?:[^<>]*?[\s"'\/])?on[a-z]+\s*=/gi],
  ['javascript: URL', /\b(?:href|src|action|formaction)\s*=\s*\\?["']?\s*javascript:/gi],
  ['handler set by setAttribute', /setAttribute\(\s*["']on/gi],
];

/** A stand-in element: its data-* attributes, its parent, and what the listeners use of an element. */
interface Stub {
  dataset: Record<string, string>;
  parent: Stub | null;
  style: Record<string, string>;
  listeners: Array<(e: { target: Stub }) => void>;
  closest(selector: string): Stub | null;
  addEventListener(type: string, fn: (e: { target: Stub }) => void): void;
}
function stub(dataset: Record<string, string> = {}, parent: Stub | null = null): Stub {
  const node: Stub = {
    dataset, parent, style: {}, listeners: [],
    closest(selector) {                                   // the one form the listeners use: [data-name]
      const key = /^\[data-([a-z]+)\]$/.exec(selector)?.[1];
      if (!key) throw new Error('unsupported selector ' + selector);
      for (let n: Stub | null = node; n; n = n.parent) if (key in n.dataset) return n;
      return null;
    },
    addEventListener(type, fn) { if (type === 'click') node.listeners.push(fn); },
  };
  return node;
}
/** A click on `target`, which bubbles through its ancestors as a browser's does. */
function click(target: Stub): void {
  for (let n: Stub | null = target; n; n = n.parent) for (const fn of n.listeners) fn({ target });
}

describe('no inline script on the network screen or the HR Tool', () => {
  test('neither folder has an inline handler, neither policy runs one, and both pages run their own files', () => {
    const network = policyOf('src/l2/l2-rpc-server.ts');
    const hrTool = policyOf('src/tools/hr-tool-server.ts');
    expect(inlineHandlersRun(network)).toBe(false);                 // script-src 'self': why the batch rows did nothing
    expect(inlineHandlersRun(hrTool)).toBe(false);                  // before: script-src 'self' 'unsafe-inline'
    for (const policy of [network, hrTool]) expect(scriptFileSources(policy)).toContain("'self'");

    const found: string[] = [];
    for (const dir of FOLDERS) {
      for (const file of pageFiles(dir)) {
        const src = read(file);
        for (const [what, re] of INLINE) {
          for (const m of src.matchAll(re)) found.push(`${file}:${src.slice(0, m.index).split(NL).length} ${what}`);
        }
      }
      // each page's scripts are its own files, which 'self' allows: no inline block, no other origin
      const scripts = [...read(`${dir}/index.html`).matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const attrs of scripts) expect([dir, attrs]).toEqual([dir, expect.stringMatching(/\ssrc="(?![a-z]+:|\/\/)[^"]+"/i)]);
    }
    expect(found).toEqual([]);   // before: the network screen's two batch rows and close button, the HR Tool's six buttons
  });
});

describe('the network screen opens a batch from either list, and the batch window closes', () => {
  /** setupBatchDetail, run against the screen's two lists, the batch window and its close button. */
  function screen() {
    const els: Record<string, Stub> = {};
    for (const id of ['cc-batch-list', 'batch-table', 'batch-modal', 'bm-close']) els[id] = stub();
    els['batch-modal'].style.display = 'flex';
    const opened: unknown[] = [];
    run([lift(NETWORK_APP, 'setupBatchDetail')], {
      $: (id: string) => els[id], showBatchDetail: (n: unknown) => { opened.push(n); },
    }, 'setupBatchDetail')();
    return { els, opened };
  }

  test('a click on a row with data-batch="3", or on a cell in it, opens batch 3, in a row drawn after the wiring', () => {
    const { els, opened } = screen();
    const row = stub({ batch: '3' }, els['batch-table']);           // loadBatches redraws the table after init
    click(stub({}, row));                                             // the click lands on a cell
    expect(opened).toEqual([3]);                                      // before: nothing; the browser refused onclick="..."
    click(stub({ batch: '0' }, els['cc-batch-list']));                // the Overview's Batch Pipeline; batch 0 is a batch
    expect(opened).toEqual([3, 0]);
    click(stub({}, els['batch-table']));                              // the header row, or the space around the rows
    expect(opened).toEqual([3, 0]);
  });

  test('the close button, the one in the batch window\'s header, closes the window', () => {
    const { els } = screen();
    click(els['bm-close']);
    expect(els['batch-modal'].style.display).toBe('none');           // before: refused too; only a click outside closed it
    expect(read('dashboard-leviathan/index.html')).toMatch(
      /<div class="batch-modal-header">\s*<h2 id="bm-title">[^<]*<\/h2>\s*<button class="btn btn-sm" id="bm-close">&times;<\/button>/);
  });

  test('both lists draw each batch\'s number into data-batch, escaped', async () => {
    const list = { innerHTML: '' };
    run([lift(NETWORK_APP, 'renderBatchPanel'), lift(NETWORK_APP, 'escHtml'), lift(NETWORK_APP, 'statusClass')], {
      $: () => list, fmtTime: () => '12:00:00',
      batchCache: [{ batchNumber: '3', l1Status: 'settled', transitionCount: 2 }, { batchNumber: '0', l1Status: 'pending' }],
    }, 'renderBatchPanel')();
    expect([...list.innerHTML.matchAll(/<div class="cc-batch-item [a-z]+" data-batch="([^"]*)">/g)].map((m) => m[1])).toEqual(['3', '0']);
    expect(list.innerHTML).not.toContain('onclick');                // before: onclick="window._showBatchDetail(3)"
    // the Batches tab draws its rows in loadBatches, run here with the sequencer's answers stubbed; a replica keeps what
    // it is gossiped verbatim, so a batch number is escaped like anything else
    const els: Record<string, { innerHTML: string }> = {};
    const loadBatches = run(['statCard', 'shortHash', 'fmtTime', 'escHtml', 'statusClass', 'isRefusal', 'receiptsRefusedNote', 'settlementBadge', 'loadBatches'].map((n) => lift(NETWORK_APP, n)), {
      $: (id: string) => (els[id] = els[id] ?? { innerHTML: '' }), toast: () => {},
      RPC: {
        getLatestBatches: async () => [{ batchNumber: '7" onmouseover="x', l1Status: 'settled', transitionCount: 1 }, { batchNumber: '3', l1Status: 'settled', transitionCount: 2 }],
        getRecentReceipts: async () => [],
      },
    }, 'loadBatches');
    await loadBatches();
    expect([...els['batch-table'].innerHTML.matchAll(/<tr data-batch="([^"]*)"/g)].map((m) => m[1])).toEqual(['7&quot; onmouseover=&quot;x', '3']);
    expect(els['batch-table'].innerHTML).not.toMatch(/onclick|onmouseover="/);   // before: onclick="window._showBatchDetail(7)"
    const esc = run([lift(NETWORK_APP, 'escHtml')], {}, 'escHtml');
    expect(esc('7" onmouseover="x')).toBe('7&quot; onmouseover=&quot;x');   // before: the quote ended the attribute
  });
});

describe('the HR Tool\'s page buttons', () => {
  /** The listener on #app, run against a stand-in #app and address bar. */
  function tool() {
    const app = stub();
    const location = { hash: '#dashboard' };
    run([liftGotoListener()], { app, location }, 'null');
    return { app, location };
  }
  const gotos = (html: string): string[] => [...html.matchAll(/<button [^>]*data-goto="([^"]*)"/g)].map((m) => m[1]);

  test('a click on a data-goto button, or on its label, sets location.hash; a click elsewhere in #app does not', () => {
    const { app, location } = tool();
    const actions = stub({}, app);                                    // #dash-actions, drawn after the wiring
    click(stub({}, stub({ goto: 'import' }, actions)));
    expect(location.hash).toBe('import');                             // before: no listener; the button carried onclick="..."
    click(stub({}, app));
    expect(location.hash).toBe('import');
    click(stub({ goto: 'groups' }, app));
    expect(location.hash).toBe('groups');
  });

  test('the Quick Actions and both Switch Group buttons name their page in data-goto, a page the router renders', async () => {
    const actions = { innerHTML: '' };
    run([lift(HR_APP, 'renderQuickActions')], { document: { getElementById: () => actions } }, 'renderQuickActions')();
    const banner: string = run([lift(HR_APP, 'activeGroupBanner')], {
      activeGroup: { groupId: 'GRP-FERNHILL-LAB', planId: 'PLAN-STD-RX-2026', enrollmentCap: 50, enrolledCount: 3 }, esc: escHtml,
    }, 'activeGroupBanner')();
    const settings = { innerHTML: '' };
    await run([lift(HR_APP, 'renderSettings')], {
      API: { getSession: async () => ({ workspaceActive: true, groupSelected: true, groupId: 'GRP-FERNHILL-LAB' }) },
      app: settings, activeGroupBanner: () => '', detailRow: () => '', loading: () => '',
      document: { getElementById: () => ({}) }, loadSettingsNode: () => undefined, toast: () => undefined, showLockScreen: () => undefined,
    }, 'renderSettings')();
    expect(gotos(actions.innerHTML)).toEqual(['import', 'employees', 'reconcile', 'tokens']);   // before: []
    expect(gotos(banner)).toEqual(['groups']);
    expect(gotos(settings.innerHTML)).toEqual(['groups']);
    const router = lift(HR_APP, 'renderPage');
    for (const page of ['import', 'employees', 'reconcile', 'tokens', 'groups']) expect(router).toContain(`case '${page}':`);
  });
});

describe('the HR Tool escapes what it puts into attributes', () => {
  test('esc() escapes quotes as well as markup, since roster fields fill data-* attributes', () => {
    // a stand-in element whose innerHTML escapes its text as a browser's does (&, < and >; never quotes)
    const document = { createElement: () => { let t = ''; return { set textContent(v: string) { t = v; }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; } };
    const esc = run([lift(HR_APP, 'esc')], { document }, 'esc');
    expect(esc('E-1" onmouseover="steal()')).toBe('E-1&quot; onmouseover=&quot;steal()');   // before: the quote ended data-id
    expect(esc("O'Brien <b>")).toBe('O&#39;Brien &lt;b&gt;');
    expect(esc(null)).toBe('');
    // where that matters: the employee list writes a CSV value into an attribute
    expect(lift(HR_APP, 'loadEmployeeTable')).toContain(`data-id="' + esc(e.employeeId) + '"`);
  });
});
