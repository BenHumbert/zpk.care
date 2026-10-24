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
const PHARMACY_APP = read('dashboard-pharmacy/app.js');
const INSURER_APP = read('dashboard-insurer/app.js');
const MEMBER_APP = read('dashboard-member/app.js');
const PRESCRIBER_APP = read('dashboard-prescriber/app.js');
const EXPLORER_APP = read('explorer/app.js');

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
/** An element whose innerHTML escapes the text set on it as a browser's does: &, < and >, never quotes. */
function textElement() {
  let text = '';
  return {
    set textContent(v: unknown) { text = v == null ? '' : String(v); },
    get innerHTML() { return escHtml(text); },
  };
}
/** An attribute value as the browser reads it back out of the markup. */
const unescapeHtml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The names of the attributes on every tag in `html`, read as a browser reads them (values in double quotes). */
function attributeNames(html: string): string[] {
  const names: string[] = [];
  for (const tag of html.matchAll(/<[a-z][\w-]*((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
    for (const a of tag[1].matchAll(/\s+([\w-]+)(?:="[^"]*")?/g)) names.push(a[1].toLowerCase());
  }
  return names;
}
/** The values of one data-* attribute in `html`, as the browser reads them. */
const dataValues = (html: string, name: string): string[] =>
  [...html.matchAll(new RegExp(`\\sdata-${name}="([^"]*)"`, 'g'))].map((m) => unescapeHtml(m[1]));

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
/** The insurer's ID_ACTIONS declaration as app.js writes it, to run beside its onIdAction. */
function insurerIdActions(): string {
  const list = /\n {2}var ID_ACTIONS = (\[[^\]]+\]);/.exec(INSURER_APP);
  if (!list) throw new Error('no ID_ACTIONS');
  return `var ID_ACTIONS = ${list[1]};`;
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

/*
 * A-88. The pharmacy's script cards, script window and DUR history, the insurer's application, credentialing, provider,
 * prior authorization and staged formulary rows, the member's provider cards, the prescriber's formulary rows and the
 * explorer's batch and receipt rows put the value each button acts on inside an inline onclick, as the insurer's group
 * list did (A-87). Escaping cannot protect a value there: the browser decodes &#39; back into a quote before the handler
 * runs. The review of 2026-10-24 traced every value: none can carry a quote from a member, a provider or an applicant,
 * but a sequencer's peers can plant some, since a replica keeps the batch numbers and receipt IDs it is gossiped as they
 * come, and the explorer wrote a batch number into its handler unquoted. The pharmacy's truncate escaped before it cut,
 * so it could cut an entity in half, and several of its callers escaped again; its history and DUR tables drew dates,
 * amounts and wallet IDs from the node unescaped. Now each screen names the action and the value in data-* attributes,
 * one listener per screen reads them, truncate cuts the text itself, and every caller that draws into markup escapes
 * once.
 *
 * The review of that fix, the same day, found these tests short of it and one window it had missed. The pharmacy's
 * listener ran an action list the test built and the insurer's a handler object that answered any name, so an action
 * mapped to the wrong function, or left out, passed; the script window and the tables truncate feeds outside the cards
 * were never drawn; the member card's short wallet was never checked; and the prescriber's proof window drew each
 * witness-path hash from the node unescaped. Now the tests run each screen's own action list against the handlers it
 * names, draw the script window and each of those tables from hostile node answers, and the proof window, built by
 * witnessModalHtml, draws every value as text.
 *
 * A further review of the fix, the same day, found the prescriber's truncHash doing what the pharmacy's truncate had
 * done: it escaped a hash and then cut it, so the cut could split an entity; the callers that escaped again (the
 * network's prescribers on the Overview, the Write Rx options, the onboarding result, a contact's name) showed "&lt;"
 * where the value had a "<", and the callers that set text (the header's wallet, the Overview's detail line, a
 * conversation's header) showed the entities themselves. Now truncHash cuts the text itself, every caller that draws
 * into markup escapes once, and those that set text get the text. Each avatar's initials are escaped too (the patient
 * and contact lists take them from that short wallet when there is no name, the provider list from the name), and so
 * are the prescription and DUR tables' amounts, which formatCents passes through as they came when they are not
 * numbers.
 *
 * A later review, the same day, found the prescriber's coverage check drawing the tier of the formulary entry into its
 * result as markup, an instance of A-90: the plan's entries are a string the sequencer stores and gossips unchecked, so
 * a peer could plant a tag in a tier. Now checkDrugCoverage escapes the tier as it escaped the hash beside it; the
 * copay, which it draws through Number, can only be a number.
 */
describe('no value rides inside an inline handler on the pharmacy, insurer, member and prescriber screens or the explorer (A-88)', () => {
  const SCREENS = ['dashboard-pharmacy/app.js', 'dashboard-insurer/app.js', 'dashboard-member/app.js', 'dashboard-prescriber/app.js', 'explorer/app.js'];
  /** A value that ends a quoted JavaScript string and a quoted attribute alike. */
  const HOSTILE = "K-1');steal();//\" onmouseover=\"steal() & more";
  /** A tag a node's answer can carry, which runs script once it is drawn as markup. */
  const TAG = '<img src=x onerror=steal()>';
  const document = { createElement: textElement };
  /** What the screens' escape helpers write for a value: &, <, > and both quotes escaped. */
  const escAttr = (s: unknown): string => escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  /** A value as the pharmacy draws it cut to n characters: cut, then escaped once. */
  const cut = (s: string, n: number): string => escAttr(s.length <= n ? s : s.slice(0, n) + '\u2026');
  /** A wallet ID a node's answer can carry: a tag, and an ampersand after it. */
  const WALLET = TAG + '&x';
  /** A hash as the prescriber's truncHash shows one longer than n: its first 8 and last 6 characters, the text itself. */
  const hashCut = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, 8) + '...' + s.slice(-6));
  /** The handler attributes on the tags in `html`. */
  const handlers = (html: string): string[] => attributeNames(html).filter((n) => n.startsWith('on'));
  /** The contents of each table cell in `html`. */
  const cells = (html: string): string[] => [...html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  /** Each name a data-act in a screen's markup carries, once each, sorted. */
  const actsDrawn = (src: string): string[] => [...new Set([...src.matchAll(/data-act="([^"]*)"/g)].map((m) => m[1]))].sort();
  /** Whether a dashboard declares a top-level function of this name. */
  const declares = (src: string, name: string): boolean =>
    src.includes(`${NL}  function ${name}(`) || src.includes(`${NL}  async function ${name}(`);
  /**
   * The pharmacy's own SCRIPT_ACTIONS, run with a stand-in under each function name it maps to. Each stand-in records the
   * name it stands in for and the key it is given, so an action mapped to the wrong function, or left out, shows.
   */
  function scriptActions(calls: Array<[string, string]>): Record<string, (key: string) => void> {
    const literal = /\n {2}var SCRIPT_ACTIONS = (\{[^}]*\});/.exec(PHARMACY_APP)?.[1];
    if (!literal) throw new Error('no SCRIPT_ACTIONS');
    const standIns: Record<string, unknown> = {};
    for (const m of literal.matchAll(/:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) standIns[m[1]] = (key: string) => { calls.push([m[1], key]); };
    return run([`var SCRIPT_ACTIONS = ${literal};`], standIns, 'SCRIPT_ACTIONS');
  }

  test('none of the five builds an inline handler from a value', () => {
    for (const file of SCREENS) {
      const built = read(file).split(NL).flatMap((line, i) => (/\bon[a-z]+="[^"]*'\s*\+/.test(line) ? [i + 1] : []));
      expect([file, built]).toEqual([file, []]);   // before: 17 lines in the pharmacy, 14 in the insurer, 2 in the member, 1 in the prescriber, 2 in the explorer
    }
  });

  test('the pharmacy: SCRIPT_ACTIONS maps each action its markup names to the function of that name, which app.js declares', () => {
    const calls: Array<[string, string]> = [];
    const SCRIPT_ACTIONS = scriptActions(calls);
    const names = Object.keys(SCRIPT_ACTIONS).sort();
    expect(actsDrawn(PHARMACY_APP)).toEqual([...names, 'none'].sort());   // before: [] and no SCRIPT_ACTIONS; each button ran App.<action>('<key>') inline
    for (const name of names) expect([name, declares(PHARMACY_APP, name)]).toEqual([name, true]);
    const onScriptAction = run([lift(PHARMACY_APP, 'onScriptAction')], { SCRIPT_ACTIONS, closeModal: () => undefined }, 'onScriptAction');
    const page = stub();
    page.addEventListener('click', onScriptAction);
    for (const name of names) click(stub({ act: name, key: HOSTILE }, page));
    expect(calls).toEqual(names.map((name) => [name, HOSTILE]));             // each reaches the function of its own name, with the key exactly
  });

  test('the pharmacy: a script\'s buttons, its card and the script window\'s buttons act on the key they carry, exactly', () => {
    const calls: Array<[string, string]> = [];
    const onScriptAction = run([lift(PHARMACY_APP, 'onScriptAction')], {
      SCRIPT_ACTIONS: scriptActions(calls), closeModal: () => { calls.push(['closeModal', '']); },
    }, 'onScriptAction');
    const page = stub();
    page.addEventListener('click', onScriptAction);
    const card = stub({ key: HOSTILE, act: 'showScriptDetail' }, page);
    const buttonRow = stub({ act: 'none' }, card);
    click(stub({}, stub({ act: 'fillScript', key: HOSTILE }, buttonRow)));   // on the Fill button's label
    expect(calls).toEqual([['fillScript', HOSTILE]]);                         // the button, not the card under it
    click(buttonRow);                                                          // between the buttons
    click(stub({ act: 'constructor', key: HOSTILE }, page));                   // a name the screen does not act on
    expect(calls).toHaveLength(1);
    click(stub({}, card));                                                     // the card itself
    expect(calls[1]).toEqual(['showScriptDetail', HOSTILE]);
    const modal = stub();
    modal.addEventListener('click', onScriptAction);
    click(stub({ act: 'dispenseScript', key: HOSTILE, close: '' }, modal));
    click(stub({ act: 'flagIssue', key: HOSTILE }, modal));
    expect(calls.slice(2)).toEqual([['dispenseScript', HOSTILE], ['closeModal', ''], ['flagIssue', HOSTILE]]);
  });

  test('the pharmacy: the script window\'s buttons name a SCRIPT_ACTIONS action and the script\'s key, and only the six that closed the window carry data-close', () => {
    const actions = Object.keys(scriptActions([]));
    const escapeHtml = run([lift(PHARMACY_APP, 'escapeHtml')], { document }, 'escapeHtml');
    /** The window showScriptDetail draws for a script in `status`, its member verified or not, and the script's key. */
    function scriptWindow(status: string, verified: boolean): { key: string; html: string } {
      const claim = { status, memberWalletId: HOSTILE, ndcHash: TAG, brandName: TAG, dateOfService: '20261024', quantity: 30 };
      const drawn: Record<string, string> = {};
      const page = run(['scriptKey', 'getScriptStatus', 'fillPricingOf', 'formatNadacUnit', 'formatField', 'formatDate', 'formatCents', 'showScriptDetail'].map((n) => lift(PHARMACY_APP, n)), {
        scriptWorkflow: {}, findClaimByKey: () => claim, getScriptIssue: () => null, isScriptVerified: () => verified, escapeHtml,
        setHTML: (sel: string, html: string) => { drawn[sel] = html; }, showEl: () => undefined,
      }, '{ scriptKey, showScriptDetail }');
      const key: string = page.scriptKey(claim);
      page.showScriptDetail(key);
      return { key, html: drawn['#ws-modal-body'] };
    }
    // each status that shows buttons: [label, data-act, data-close] for each button, in order
    const CASES: Array<[string, boolean, Array<[string, string, boolean]>]> = [
      ['ADJUDICATED', false, [['Fill', 'fillScript', true], ['Reject', 'rejectScript', true], ['Transfer', 'transferScript', true], ['Flag Issue', 'flagIssue', false], ['DUR Lookup', 'durLookupFromScript', false]]],
      ['FILLED', true, [['Dispense 30 (Collect Payment + Settle)', 'dispenseScript', true], ['Flag Issue', 'flagIssue', false], ['DUR Lookup', 'durLookupFromScript', false]]],
      ['FILLED', false, [['Verify Member', 'verifyMemberForScript', true], ['Flag Issue', 'flagIssue', false], ['DUR Lookup', 'durLookupFromScript', false]]],
      ['DISPENSED', false, [['Reverse', 'reverseScript', true], ['DUR Lookup', 'durLookupFromScript', false]]],
    ];
    for (const [status, verified, want] of CASES) {
      const which = status + (verified ? ', member verified' : '');
      const { key, html } = scriptWindow(status, verified);
      const buttons = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => ({
        label: m[2], act: dataValues(m[1], 'act')[0], key: dataValues(m[1], 'key')[0], close: attributeNames(`<button${m[1]}>`).includes('data-close'),
      }));
      expect([which, handlers(html)]).toEqual([which, []]);                                      // before: onclick="App.fillScript('...'); App.closeModal();" and the rest
      expect([which, buttons.map((b) => [b.label, b.act, b.close])]).toEqual([which, want]);    // before: no data-act and no data-close on any
      for (const b of buttons) expect([which, b.label, actions.includes(b.act), b.key]).toEqual([which, b.label, true, key]);
      expect([which, html.includes('<img')]).toEqual([which, false]);                           // the script's fields are drawn as text
    }
  });

  test('the pharmacy\'s cards carry the key in data-key in every column, with no handler, and truncate cuts the text itself', () => {
    const escapeHtml = run([lift(PHARMACY_APP, 'escapeHtml')], { document }, 'escapeHtml');
    const pieces = run(['scriptKey', 'getScriptStatus', 'fillPricingOf', 'formatNadacUnit', 'nadacBreakdown', 'truncate', 'formatDate', 'formatCents', 'renderColumn'].map((n) => lift(PHARMACY_APP, n)), {
      $: () => null, scriptWorkflow: {}, getScriptIssue: () => null, isScriptVerified: () => false, escapeHtml,
    }, '{ scriptKey, renderColumn, truncate }');
    const claim = (status: string) => ({ status, memberWalletId: HOSTILE, ndcHash: '" onmouseover="steal()', dateOfService: '20261024', medication: 'Metformin', quantity: 30 });
    const key = pieces.scriptKey(claim('ADJUDICATED'));
    for (const [status, column, buttons] of [['ADJUDICATED', 'adjudicated', 3], ['FILLED', 'filled', 2], ['DISPENSED', 'dispensed', 2]] as const) {
      const el = { innerHTML: '' };
      pieces.renderColumn(el, [claim(status)], column);
      expect([column, attributeNames(el.innerHTML).filter((n) => n.startsWith('on'))]).toEqual([column, []]);   // before: onclick on the card, its row and every button
      expect([column, dataValues(el.innerHTML, 'key')]).toEqual([column, Array(1 + buttons).fill(key)]);
    }
    expect(pieces.truncate('Tom & Jerry <Pharmacy>', 9)).toBe('Tom & Jer\u2026');   // before: 'Tom &amp;' and a cut entity
  });

  test('the pharmacy\'s history table draws every value from the node as text, escaped once, a long one cut before it is escaped', async () => {
    const escapeHtml = run([lift(PHARMACY_APP, 'escapeHtml')], { document }, 'escapeHtml');
    const tbody = { innerHTML: '' };
    const claim = { leafIndex: TAG, memberWalletId: 'W&1 "a" ' + TAG, ndcHash: "N'1 & " + TAG, prescriberWalletId: 'P&1 ' + TAG, dateOfService: TAG, patientPayCents: TAG, planPayCents: '"&' + TAG, status: 'COMPLETED' };
    await run(['scriptKey', 'getScriptStatus', 'formatField', 'truncate', 'formatDate', 'formatCents', 'loadHistoryTable'].map((n) => lift(PHARMACY_APP, n)), {
      $: () => tbody, setText: () => undefined, escapeHtml, scriptWorkflow: {}, API: { dispensing: { list: async () => [claim] } },
    }, 'loadHistoryTable')();
    expect(tbody.innerHTML).not.toContain('<img');                     // before: the leaf index, the date and both amounts drawn as markup
    expect(handlers(tbody.innerHTML)).toEqual([]);
    expect(tbody.innerHTML).not.toContain('&amp;amp;');
    expect(cells(tbody.innerHTML)).toEqual([
      escAttr(TAG), cut(claim.memberWalletId, 16), cut(claim.ndcHash, 16), cut(claim.prescriberWalletId, 16), escAttr(TAG), escAttr(TAG), escAttr(claim.planPayCents),
      '<span class="script-status-badge status-completed">completed</span>',
    ]);                                                                  // before: the wallets and the drug escaped, then cut, mid-markup
  });

  test('the pharmacy\'s DUR screen draws its medications, its history with the View button\'s key, its alert and its duplicate check as text, escaped once', async () => {
    const escapeHtml = run([lift(PHARMACY_APP, 'escapeHtml')], { document }, 'escapeHtml');
    const drawn: Record<string, string> = {};
    const med = 'M&1 "x" ' + TAG;
    const leaf = "7');steal();//\" & <b>";
    const dur = run(['truncate', 'formatDate', 'formatCents', 'durLookup', 'durCheckDuplicate'].map((n) => lift(PHARMACY_APP, n)), {
      escapeHtml, durCurrentWallet: null, durLookupCount: 0,
      $: () => ({ value: 'N-1' }), showEl: () => undefined, hideEl: () => undefined, setText: () => undefined,
      setHTML: (sel: string, html: string) => { drawn[sel] = html; },
      API: { dur: {
        activeMedications: async () => [{ ndcHash: med, pharmacy: "P'1 & " + TAG, daysRemaining: TAG }],
        fullHistory: async () => [
          { leafIndex: leaf, ndcHash: med, pharmacyWalletId: 'P&1 ' + TAG, dateOfService: TAG, patientPayCents: TAG, planPayCents: TAG },
          { leafIndex: 8, ndcHash: med, pharmacyWalletId: 'P&2 ' + TAG, dateOfService: '20261024', patientPayCents: 500, planPayCents: 1500 },
        ],
        checkDuplicate: async () => ({ duplicate: true, existingClaim: { pharmacyWalletId: 'P&1 ' + TAG, dateOfService: '20261024' } }),
      } },
    }, '{ durLookup, durCheckDuplicate }');
    await dur.durLookup('W-1');
    await dur.durCheckDuplicate();
    const all = Object.values(drawn).join('');
    expect(all).not.toContain('<img');                                  // before: the history's date and amounts drawn as markup
    expect(handlers(all)).toEqual([]);                                  // before: onclick="App.durClaimDetail('7');steal();//...')" on View, unescaped
    expect(all).not.toContain('&amp;amp;');                             // before: the duplicate check's pharmacy escaped by truncate, then again by its caller
    expect(drawn['#dur-active-meds']).toContain('<div class="dur-med-name">' + cut(med, 20) + '</div>');               // before: escaped, then cut
    expect(drawn['#dur-active-meds']).toContain('<div class="dur-med-detail">Pharmacy: ' + cut("P'1 & " + TAG, 16) + '</div>');   // before: escaped, then cut
    expect(drawn['#dur-active-meds']).toContain('<span class="badge badge-green">' + escAttr(TAG + ' days remaining') + '</span>');
    const view = (key: string): string => `<button class="btn btn-sm" data-act="durClaimDetail" data-key="${escAttr(key)}">View</button>`;
    expect(cells(drawn['#dur-history-table'])).toEqual([
      cut(med, 16), cut('P&1 ' + TAG, 16), escAttr(TAG), escAttr(TAG), escAttr(TAG), view(leaf),
      cut(med, 16), cut('P&2 ' + TAG, 16), '2026-10-24', '$5.00', '$15.00', view('8'),
    ]);                                                                  // before: the date and amounts unescaped; View carried an onclick
    expect(dataValues(drawn['#dur-history-table'], 'key')).toEqual([leaf, '8']);   // before: [] (the leaf index rode in the onclick)
    expect(drawn['#dur-alerts']).toContain('[MULTI-PHARMACY]</span> ' + cut(med, 20) + ' dispensed at 2 pharmacies</div>');   // before: escaped, then cut
    expect(drawn['#dur-check-result']).toContain('Active claim exists.' +
      escAttr(' \u2014 Last filled at ' + ('P&1 ' + TAG).slice(0, 16) + '\u2026 on 2026-10-24') + '</div>');   // before: escaped, cut, then escaped again
  });

  test('the pharmacy\'s contact list draws each thread\'s wallet and last message as text, escaped once, and carries the thread in data-thread', async () => {
    const escapeHtml = run([lift(PHARMACY_APP, 'escapeHtml')], { document }, 'escapeHtml');
    const list = { innerHTML: '', querySelectorAll: () => [] };
    const wallet = 'W&1 "a" ' + TAG;
    const message = "Ready & 'waiting' " + TAG;
    await run(['truncate', 'loadMessaging', 'renderContactsList'].map((n) => lift(PHARMACY_APP, n)), {
      escapeHtml, msgContacts: [], msgActiveThread: null, onboardingStatus: { walletId: 'W-ME' },
      $: () => list, setHTML: () => undefined, openThread: () => undefined,
      API: { messaging: {
        inbox: async () => [{ threadIdHash: HOSTILE, senderWalletId: wallet, recipientWalletId: 'W-ME', message, timestamp: 0 }],
        sent: async () => [],
      } },
    }, 'loadMessaging')();
    expect(list.innerHTML).not.toContain('<img');
    expect(handlers(list.innerHTML)).toEqual([]);                       // before: the thread ID's quote ended data-thread and added onmouseover
    expect(list.innerHTML).not.toContain('&amp;amp;');                  // before: the preview escaped by truncate, then again by its caller
    expect(dataValues(list.innerHTML, 'thread')).toEqual([HOSTILE]);   // before: the thread ID up to its first double quote
    expect(list.innerHTML).toContain('<div class="msg-contact-avatar">W&amp;</div>');
    expect(list.innerHTML).toContain('<div class="msg-contact-name">' + cut(wallet, 20) + '</div>');           // before: escaped, then cut
    expect(list.innerHTML).toContain('<div class="msg-contact-preview">' + cut(message, 30) + '</div>');       // before: escaped, cut, then escaped again
  });

  test('the pharmacy\'s proof status draws the node\'s phase, wallet and timings as text, escaped once', async () => {
    const escapeHtml = run([lift(PHARMACY_APP, 'escapeHtml')], { document }, 'escapeHtml');
    const drawn: Record<string, string> = {};
    const wallet = 'W&1 "a" \'b\' ' + TAG;
    await run(['truncate', 'loadProofs'].map((n) => lift(PHARMACY_APP, n)), {
      escapeHtml, setHTML: (sel: string, html: string) => { drawn[sel] = html; },
      API: {
        onboarding: { status: async () => ({ phase: TAG, walletId: wallet, compiled: true }) },
        proof: { timings: async () => [{ name: TAG, ms: 1500 }] },
      },
    }, 'loadProofs')();
    const all = drawn['#proof-status'] + drawn['#proof-timings'];
    expect(all).not.toContain('<img');
    expect(handlers(all)).toEqual([]);
    expect(all).not.toContain('&amp;amp;');                             // before: the wallet escaped by truncate, then again by its caller
    expect(drawn['#proof-status']).toContain('<span class="fw-600 text-accent">' + escAttr(TAG) + '</span>');
    expect(drawn['#proof-status']).toContain('<span class="fw-600 text-mono" style="font-size:11px;">' + cut(wallet, 28) + '</span>');   // before: escaped, cut, then escaped again
    expect(drawn['#proof-timings']).toContain('<div class="timing-label">' + escAttr(TAG) + '</div>');
  });

  test('the insurer: ID_ACTIONS lists window.App handlers and every action the screen draws, and each reaches its handler with the ID exactly', () => {
    const at = INSURER_APP.indexOf(NL + '  window.App = {');
    const block = INSURER_APP.slice(at + 1, INSURER_APP.indexOf(NL + '  };' + NL, at) + 5);
    const keys = [...block.matchAll(/^ {4}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
    const ID_ACTIONS: string[] = run([insurerIdActions()], {}, 'ID_ACTIONS');
    expect(ID_ACTIONS.filter((name) => !keys.includes(name))).toEqual([]);    // each names a handler window.App holds
    expect(actsDrawn(INSURER_APP)).toEqual([...ID_ACTIONS].sort());           // before: [] and no ID_ACTIONS; each button ran App.<action>('<id>') inline
    // window.App as app.js writes it: a stand-in under each function it names, and stubs for what its own functions call
    const calls: unknown[][] = [];
    const standIns: Record<string, unknown> = {};
    for (const m of block.matchAll(/^ {4}[A-Za-z_$][\w$]*: ([A-Za-z_$][\w$]*),$/gm)) standIns[m[1]] = (arg: unknown) => { calls.push([m[1], arg]); };
    const API = Object.fromEntries(['suspendProvider', 'terminateProvider', 'verifyApplication', 'approveApplication', 'denyApplication']
      .map((name) => [name, async (...args: unknown[]) => { calls.push(['API.' + name, ...args]); }]));
    const win: Record<string, unknown> = {};
    run([block], {
      ...standIns, window: win, API, confirm: () => true, prompt: () => 'typed', toast: () => undefined,
      loadProviderRegistry: () => undefined, loadCredentialingApps: () => undefined,
    }, 'null');
    const onIdAction = run([insurerIdActions(), lift(INSURER_APP, 'onIdAction')], { window: win }, 'onIdAction');
    const page = stub();
    page.addEventListener('click', onIdAction);
    for (const name of ID_ACTIONS) click(stub({}, stub({ act: name, arg: name === 'removeFormularyEntry' ? '2' : HOSTILE }, page)));   // on each button's label
    click(stub({ act: 'selectGroup', arg: 'GRP-1' }, page));                  // a handler, but not one a row's button names
    const reaches: Record<string, unknown[]> = {
      removeFormularyEntry: ['removeFormularyEntry', 2], approveApp: ['approveApp', HOSTILE], denyApp: ['denyApp', HOSTILE],
      requestDocs: ['requestDocs', HOSTILE], reviewDoc: ['reviewDoc', HOSTILE], approvePriorAuth: ['approvePriorAuth', HOSTILE],
      denyPriorAuth: ['denyPriorAuth', HOSTILE], suspendProvider: ['API.suspendProvider', HOSTILE], terminateProvider: ['API.terminateProvider', HOSTILE],
      verifyApp: ['API.verifyApplication', HOSTILE], approveCredentialingApp: ['API.approveApplication', HOSTILE, 'typed'],
      denyCredentialingApp: ['API.denyApplication', HOSTILE, 'typed'],
    };
    expect(calls).toEqual(ID_ACTIONS.map((name) => reaches[name]));

    const esc = run([lift(INSURER_APP, 'esc')], { document }, 'esc');
    const pieces = run([lift(INSURER_APP, 'renderAppActions'), lift(INSURER_APP, 'credAppActions')], { esc }, '{ renderAppActions, credAppActions }');
    const html = pieces.renderAppActions({ applicationId: HOSTILE, status: 'submitted', cp575DocumentId: 'doc-1' }) +
      pieces.credAppActions({ applicationId: HOSTILE, status: 'pending' });
    expect(attributeNames(html).filter((n) => n.startsWith('on'))).toEqual([]);   // before: onclick="App.approveApp('...')" and six more
    expect(dataValues(html, 'arg')).toEqual(Array(7).fill(HOSTILE));            // Review PDF, Approve, Request Resubmission, Deny; Verify, Deny, Approve
  });

  test('the insurer: the staged formulary\'s Remove and the provider registry\'s Suspend and Terminate carry their action and value in data-*', async () => {
    const els: Record<string, { innerHTML: string; value: string }> = {};
    const $ = (id: string) => (els[id] = els[id] ?? { innerHTML: '', value: '' });
    const staged = [
      { ndcHash: '1111', brandName: 'Lipitor 20mg', tierLevel: 1, copayAmountCents: 500, requiresPriorAuth: false },
      { ndcHash: '2222', brandName: 'Metformin 500mg', tierLevel: 1, copayAmountCents: 500, requiresPriorAuth: false },
    ];
    run(['esc', 'truncHash', 'fmtCents', 'renderFormularyTable'].map((n) => lift(INSURER_APP, n)), { document, $, formularyData: staged }, 'renderFormularyTable')();
    const formulary = els['form-table-container'].innerHTML;
    expect(handlers(formulary)).toEqual([]);                                     // before: onclick="App.removeFormularyEntry(0)" and (1)
    expect(dataValues(formulary, 'act')).toEqual(['removeFormularyEntry', 'removeFormularyEntry']);   // before: [], the action rode in the onclick
    expect(dataValues(formulary, 'arg')).toEqual(['0', '1']);                     // before: [], and so did the index

    await run(['esc', 'truncHash', 'loadProviderRegistry'].map((n) => lift(INSURER_APP, n)), {
      document, $,
      API: { getProviderRegistry: async () => ({ providers: [{ walletId: HOSTILE, metadata: { displayName: TAG, providerType: 'prescriber', npi: TAG, credentialState: 'active' } }] }) },
    }, 'loadProviderRegistry')();
    const registry = els['cred-registry-container'].innerHTML;
    expect(handlers(registry)).toEqual([]);                                      // before: onclick="App.suspendProvider('...')", and the ID's quote ended it
    expect(registry).not.toContain('<img');
    expect(dataValues(registry, 'act')).toEqual(['suspendProvider', 'terminateProvider']);   // before: []
    expect(dataValues(registry, 'arg')).toEqual([HOSTILE, HOSTILE]);             // before: [], the wallet ID rode in the onclick
  });

  test('the member: a provider card\'s buttons act on the wallet they carry, and the card draws its initials and short wallet as text', () => {
    const calls: unknown[][] = [];
    const win = { _assignPcp: (w: string) => { calls.push(['assignPcp', w]); }, _msgProvider: (w: string) => { calls.push(['msgProvider', w]); } };
    const onProviderAction = run([lift(MEMBER_APP, 'onProviderAction')], { window: win }, 'onProviderAction');
    const page = stub();
    page.addEventListener('click', onProviderAction);
    const card = stub({}, page);
    click(stub({ act: 'assignPcp', wallet: HOSTILE }, card));
    click(stub({}, stub({ act: 'msgProvider', wallet: HOSTILE }, card)));
    click(stub({}, card));
    expect(calls).toEqual([['assignPcp', HOSTILE], ['msgProvider', HOSTILE]]);

    const els: Record<string, { value?: string; innerHTML?: string }> = { 'provider-role-filter': { value: '' }, 'provider-search': { value: '' }, 'provider-list': { innerHTML: '' } };
    const renderProviders = run(['esc', 'shortHash', 'renderProviders'].map((n) => lift(MEMBER_APP, n)), { $: (id: string) => els[id] }, 'renderProviders');
    const wallet = TAG + HOSTILE;                                                 // its short form keeps the tag's opening: '<img src…& more'
    renderProviders([{ walletId: wallet, displayName: '<i>Dr', role: 'prescriber', specialty: 'Family Medicine' }]);
    const html = String(els['provider-list'].innerHTML);
    expect(attributeNames(html).filter((n) => n.startsWith('on'))).toEqual([]);   // before: onclick="window._assignPcp('...')" and Message
    expect(dataValues(html, 'wallet')).toEqual([wallet, wallet]);
    expect(html).not.toContain('<I');                                             // before: the initials '<I' opened a tag
    expect(html).toContain('&lt;I');
    expect(html).not.toContain('<img');                                           // before: the short wallet '<img src…' opened one too
    expect(html).toContain('<span class="hash">&lt;img src\u2026&amp; more</span>');
  });

  test('the prescriber: a formulary row\'s Verify button shows the proof for the hash it carries', () => {
    const shown: string[] = [];
    const onWitnessClick = run([lift(PRESCRIBER_APP, 'onWitnessClick')], { window: { _showWitness: (h: string) => { shown.push(h); } } }, 'onWitnessClick');
    const page = stub();
    page.addEventListener('click', onWitnessClick);
    click(stub({}, stub({ witness: HOSTILE }, page)));                        // on the button's label
    click(stub({}, page));
    expect(shown).toEqual([HOSTILE]);
  });

  test('the prescriber: the proof window draws each witness-path hash, cut to 24 characters, and every other value from the node as text', () => {
    const esc = run([lift(PRESCRIBER_APP, 'esc')], { document }, 'esc');
    const witnessModalHtml = run([lift(PRESCRIBER_APP, 'witnessModalHtml')], { esc }, 'witnessModalHtml');
    const path = [TAG, '"&\'1234567890123456789012345', 42];
    const html: string = witnessModalHtml({ witnessPath: path, witnessIsLeft: [true, false, true], leafIndex: TAG, formularyRoot: TAG, drug: { genericName: TAG } }, HOSTILE);
    expect(html).not.toContain('<img');                                         // before: each path hash drawn as markup, in _showWitness
    expect([...html.matchAll(/<\/span> (.*?)\.\.\.<\/div>/g)].map((m) => m[1])).toEqual(path.map((h) => escAttr(String(h).slice(0, 24))));   // before: h.slice(0, 24), unescaped
    expect(handlers(html)).toEqual(['onclick']);                                // the Close button's, which carries no value
    expect(html).toContain('<button class="btn btn-primary" onclick="this.closest(\'div[style*=fixed]\').remove()"');
    // an answer with no drug: the window names the hash it asked for, as text
    const unnamed: string = witnessModalHtml({ witnessPath: [], witnessIsLeft: [], leafIndex: 0, formularyRoot: '1', drug: null }, HOSTILE);
    expect(unnamed).toContain('<strong>Drug:</strong> ' + escAttr(HOSTILE) + '</div>');
    expect(handlers(unnamed)).toEqual(['onclick']);
  });

  test('the prescriber: the coverage check draws the tier the node answers as text, escaped once, as it draws the hash beside it', async () => {
    const esc = run([lift(PRESCRIBER_APP, 'esc')], { document }, 'esc');
    const tier = '2' + TAG + ' & "3"';
    const els: Record<string, any> = { '#form-check-plan': { value: ' P-1 ' }, '#form-check-ndc': { value: 'N-1' }, '#form-check-result': { innerHTML: '' } };
    const asked: string[][] = [];
    const checkDrugCoverage = run([lift(PRESCRIBER_APP, 'checkDrugCoverage')], {
      esc, $: (sel: string) => els[sel] ?? null, toast: () => undefined,
      API: { checkDrugCoverage: async (plan: string, ndc: string) => { asked.push([plan, ndc]); return { ndcHash: HOSTILE, onFormulary: true, tierLevel: tier, copay: 12.5 }; } },
    }, 'checkDrugCoverage');
    await checkDrugCoverage();
    const html: string = els['#form-check-result'].innerHTML;
    expect(asked).toEqual([['P-1', 'N-1']]);
    expect(html).not.toContain('<img');                                         // before: the tier drawn as markup
    expect(html).not.toContain('&amp;amp;');
    expect(html).toBe('<div class="form-result success"><strong>COVERED</strong> \u2014 NDC: ' + escAttr(HOSTILE) +
      ' | Tier: ' + escAttr(tier) + ' | Copay: $12.50</div>');                 // before: ' | Tier: 2<img src=x onerror=steal()> & "3"', unescaped
  });

  test('the prescriber: truncHash cuts the text itself and leaves the escaping to its caller', () => {
    const esc = run([lift(PRESCRIBER_APP, 'esc')], { document }, 'esc');
    const truncHash = run([lift(PRESCRIBER_APP, 'truncHash')], { esc }, 'truncHash');   // esc as the page has it, which truncHash called before
    expect(truncHash(WALLET, 16)).toBe('<img src...l()>&x');                    // before: '&lt;img ...&amp;x', escaped, then cut
    expect(truncHash('abcdef<ghijklmn&opqr', 16)).toBe('abcdef<g...n&opqr');     // before: 'abcdef&l...p;opqr', an entity cut at each end
    expect(truncHash('Rx & Co', 16)).toBe('Rx & Co');                           // before: 'Rx &amp; Co'
    expect(truncHash('12345678901234567890')).toBe('12345678...567890');        // longer than 16, the length when none is given
    expect(truncHash(null, 16)).toBe('--');
  });

  test('the prescriber: the header and the Overview\'s detail line show a short wallet as text, and the network\'s prescribers and the onboarding result draw it escaped once', async () => {
    const esc = run([lift(PRESCRIBER_APP, 'esc')], { document }, 'esc');
    const texts: Record<string, string> = {};
    const els: Record<string, any> = {
      '#wiz-prescriber-id': { value: '1234567890' }, '#wiz-qualifier': { value: '1' }, '#wiz-btn-2': {}, '#wiz-result-2': { innerHTML: '' },
    };
    const $ = (sel: string) => (els[sel] = els[sel] ?? { innerHTML: '' });
    const page = run(['truncHash', 'initials', 'loadOverview', 'wizardAction'].map((n) => lift(PRESCRIBER_APP, n)), {
      esc, $, setText: (sel: string, text: unknown) => { texts[sel] = String(text); }, setHTML: (sel: string, html: string) => { $(sel).innerHTML = html; },
      toast: () => undefined, onboardingPhase: '', walletId: null, STEP_LABELS: [], window: {}, setInterval: () => 0, clearInterval: () => undefined,
      setTimeout: () => 0, getSelectedPrescriber: () => ({ name: '' }), renderEventLog: () => undefined, loadOnboarding: () => undefined,
      API: {
        getOnboardingStatus: async () => ({ phase: 'ready', walletId: WALLET, displayName: 'Dr. Ines Okafor' }),
        getPrescriptionSummary: async () => ({}), getPatientCount: async () => ({ count: 1 }), getPharmacyCount: async () => ({ count: 1 }),
        getPcpPatients: async () => [], getMedicationBreakdown: async () => [],
        getProviders: async () => [{ displayName: 'Dr. Ade Bello', specialty: 'Family Medicine', walletId: WALLET }],
        deriveWallet: async () => ({ phase: 'wallet_derived', walletId: WALLET }),
      },
    }, '{ loadOverview, wizardAction }');
    await page.loadOverview();
    expect(texts['#header-wallet']).toBe(hashCut(WALLET, 16));                  // before: '&lt;img ...&amp;x', the entities shown as text
    expect(texts['#ov-detail']).toBe('Wallet: ' + hashCut(WALLET, 24));         // before: 'Wallet: &lt;img ...&amp;x'
    const network = els['#ov-providers'].innerHTML;
    expect(network).not.toContain('<img');
    expect(network).toContain('<td><span class="hash">' + escAttr(hashCut(WALLET, 18)) + '</span></td>');   // before: '&amp;lt;img ...&amp;amp;x', escaped twice

    delete texts['#header-wallet'];
    await page.wizardAction(2);                                                  // Derive Wallet
    expect(texts['#header-wallet']).toBe(hashCut(WALLET, 16));                  // before: '&lt;img ...&amp;x'
    expect(els['#wiz-result-2'].innerHTML).toBe(
      '<div class="form-result success">Success! Phase: wallet_derived | Wallet: ' + escAttr(hashCut(WALLET, 24)) + '</div>');   // before: '&amp;lt;img ...&amp;amp;x', escaped twice
  });

  test('the prescriber: the prescription history, a patient\'s DUR history and the patient list draw each short hash, avatar and amount escaped once', async () => {
    const esc = run([lift(PRESCRIBER_APP, 'esc')], { document }, 'esc');
    const els: Record<string, any> = {};
    // no filter fields on the page: the history lists every prescription
    const $ = (sel: string) => (sel.startsWith('#rx-filter') ? null : (els[sel] = els[sel] ?? { innerHTML: '', querySelectorAll: () => [] }));
    const ndc = 'abcdef<ghijklmn&opqr';
    const rx = { dateOfService: '20261024', memberWalletId: WALLET, ndcHash: ndc, pharmacyWalletId: WALLET, patientPayCents: TAG, planPayCents: 1500 };
    const page = run(['truncHash', 'formatCents', 'fmtYMD', 'fmtDate', 'initials', 'loadPrescriptionHistory', 'durLookup', 'loadPatients'].map((n) => lift(PRESCRIBER_APP, n)), {
      esc, $, setText: () => undefined, toast: () => undefined,
      API: {
        getPrescriptions: async () => [rx], getPrescriptionsByPatient: async () => [rx], getInbox: async () => [],
        getPcpPatients: async () => ({ patients: [{ memberWalletId: WALLET }] }),
      },
    }, '{ loadPrescriptionHistory, durLookup, loadPatients }');
    await page.loadPrescriptionHistory();
    await page.durLookup('W-1');
    await page.loadPatients();
    const history: string = els['#rx-table-container'].innerHTML;
    const dur: string = els['#dur-result'].innerHTML;
    const patients: string = els['#pt-list'].innerHTML;
    /** A hash cell as these tables draw it: the hash whole in the title, where the history gives one, and cut, escaped once. */
    const hash = (s: string, title: boolean): string => `<span class="hash"${title ? ` title="${escAttr(s)}"` : ''}>${escAttr(hashCut(s, 16))}</span>`;
    expect(history + dur).not.toContain('<img');                                // before: the patient's pay drawn as markup
    expect(cells(history)).toEqual([
      '2026-10-24', hash(WALLET, true), hash(ndc, true), hash(WALLET, true), escAttr(TAG), '$15.00',
    ]);                                                                          // before: each hash escaped, then cut ('&lt;img ...&amp;x', 'abcdef&l...p;opqr'), the pay unescaped
    expect(cells(dur)).toEqual([
      '2026-10-24', hash(ndc, false), hash(WALLET, false), escAttr(TAG), '$15.00',
    ]);                                                                          // before: the same
    expect(patients).toContain('<div class="patient-avatar">&lt;S</div>');                                    // before: '&.', the initials of the escaped short wallet
    expect(patients).toContain('<div class="provider-name">' + escAttr(hashCut(WALLET, 16)) + '</div>');       // before: '&amp;lt;img ...&amp;amp;x', escaped twice
    expect(patients).toContain('<div class="provider-sub hash">' + escAttr(hashCut(WALLET, 20)) + '</div>');   // before: '&lt;img ...&amp;x', escaped, then cut
    expect(dataValues(patients, 'wallet')).toEqual([WALLET]);
  });

  test('the prescriber: the provider lists and the Write Rx options draw each short wallet, and each avatar, escaped once', async () => {
    const esc = run([lift(PRESCRIBER_APP, 'esc')], { document }, 'esc');
    const els: Record<string, any> = {};
    const $ = (sel: string) => (els[sel] = els[sel] ?? { innerHTML: '', value: '', options: [] });
    const page = run(['truncHash', 'initials', 'loadProviders', 'setSelectOptions', 'populateRxDropdowns'].map((n) => lift(PRESCRIBER_APP, n)), {
      esc, $, setHTML: (sel: string, html: string) => { $(sel).innerHTML = html; }, window: {},
      cachedMembers: [], cachedPharmacies: [], cachedMedications: [],
      API: {
        getProviders: async (role: string) => [role === 'prescriber'
          ? { displayName: TAG, specialty: 'Family Medicine', walletId: WALLET }
          : { pharmacyType: 'Retail', walletId: WALLET }],
        getPcpPatients: async () => ({ patients: [{ memberWalletId: WALLET }] }),
        getFormularyPage: async () => ({ drugs: [{ ndcHash: WALLET, tierLevel: 1, copayAmount: 500 }], total: 1 }),
        getMedicationBreakdown: async () => [],
      },
    }, '{ loadProviders, populateRxDropdowns }');
    await page.loadProviders();
    const prescribers: string = els['#prov-prescriber-list'].innerHTML;
    const pharmacies: string = els['#prov-pharmacy-list'].innerHTML;
    expect(prescribers).not.toContain('<S');                                    // before: the initials of the name '<img src=x ...' opened a tag
    expect(prescribers).toContain('<div class="provider-avatar prescriber">&lt;S</div>');   // before: '<S', drawn as markup
    for (const list of [prescribers, pharmacies]) {
      expect(list).not.toContain('<img');
      expect(list).toContain('<div class="provider-wallet">' + escAttr(hashCut(WALLET, 14)) + '</div>');   // before: '&lt;img ...&amp;x', escaped, then cut
    }

    // the patient, pharmacy and drug have no name, so each option shows the short wallet or hash
    await page.populateRxDropdowns();
    /** What each option of a select after its placeholder carries and shows, as the browser reads them. */
    const options = (sel: string): string[][] => [...String(els[sel].innerHTML).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
      .slice(1).map((m) => [unescapeHtml(m[1]), unescapeHtml(m[2])]);
    for (const sel of ['#rx-patient-select', '#rx-pharmacy-select', '#rx-med-select']) {
      expect([sel, options(sel)]).toEqual([sel, [[WALLET, hashCut(WALLET, 16)]]]);   // before: each showed '&lt;img ...&amp;x', escaped twice
    }
  });

  test('the prescriber: a contact known by its wallet is drawn escaped once in the contact list, its avatar too, and its conversation\'s header shows it as text', async () => {
    const esc = run([lift(PRESCRIBER_APP, 'esc')], { document }, 'esc');
    const texts: Record<string, string> = {};
    const els: Record<string, any> = {};
    const $ = (sel: string) => (els[sel] = els[sel] ?? { innerHTML: '', querySelectorAll: () => [] });
    const entry = {
      message: { senderWalletId: WALLET, recipientWalletId: 'W-ME', threadIdHash: 'T-1' },
      payload: { ciphertext: Buffer.from('Ready & waiting').toString('base64'), iv: '0', timestamp: 1 },
    };
    const pieces = ['truncHash', 'truncate', 'initials', 'decodePayload', 'fmtTime', 'loadMessaging', 'openThread'].map((n) => lift(PRESCRIBER_APP, n));
    const page = run(['var msgContacts = [];', 'var msgActiveThread = null;', ...pieces], {
      esc, $, $$: () => [], setText: (sel: string, text: unknown) => { texts[sel] = String(text); }, showEl: () => undefined, walletId: 'W-ME',
      API: { getInbox: async () => [entry], getSent: async () => [], getThread: async () => [entry] },
    }, '{ loadMessaging, openThread }');
    await page.loadMessaging();
    const list: string = els['#msg-contacts-list'].innerHTML;
    expect(list).not.toContain('<img');
    expect(list).toContain('<div class="msg-contact-avatar">&lt;S</div>');                                 // before: '&.', the initials of the escaped short wallet
    expect(list).toContain('<div class="msg-contact-name">' + escAttr(hashCut(WALLET, 14)) + '</div>');    // before: '&amp;lt;img ...&amp;amp;x', escaped twice
    expect(list).toContain('<div class="msg-contact-preview">Ready &amp; waiting</div>');
    await page.openThread(0);
    expect(texts['#msg-conv-header']).toBe(hashCut(WALLET, 14));                                          // before: '&lt;img ...&amp;x', the entities shown as text
  });

  test('the explorer: a batch row opens its batch, a receipt row its receipt, and both tables escape what a peer can plant', () => {
    const opened: unknown[][] = [];
    const onRowClick = run([lift(EXPLORER_APP, 'onRowClick')], {
      showBatchDetail: (n: unknown) => { opened.push(['batch', n]); }, showReceiptDetail: (id: unknown) => { opened.push(['receipt', id]); },
    }, 'onRowClick');
    const page = stub();
    page.addEventListener('click', onRowClick);
    click(stub({}, stub({ batch: '7' }, page)));
    click(stub({ batch: '0' }, page));                                         // batch 0 is a batch
    click(stub({ batch: '7);steal(' }, page));                                 // not a batch number: nothing opens
    click(stub({}, stub({ receipt: HOSTILE }, page)));
    expect(opened).toEqual([['batch', 7], ['batch', 0], ['receipt', HOSTILE]]);

    const pieces = run(['esc', 'shortHash', 'statusBadge', 'typeBadge', 'fmtTime', 'renderBatchTable', 'renderReceiptTable'].map((n) => lift(EXPLORER_APP, n)), {}, '{ renderBatchTable, renderReceiptTable }');
    const planted = '1);steal();//<img src=x onerror=steal()>';
    const batches = pieces.renderBatchTable([{ batchNumber: planted, registrationCount: '<b>2</b>', transitionCount: 1, l1Status: 'settled', blockHeight: '<i>9</i>', globalStateRoot: '<img src=x>' }], false);
    expect(attributeNames(batches).filter((n) => n.startsWith('on'))).toEqual([]);   // before: onclick="window._showBatch(1);steal();//<img src=x onerror=steal()>)"
    expect(batches).not.toMatch(/<img|<b>|<i>/);
    expect(dataValues(batches, 'batch')).toEqual([planted]);
    const receipts = pieces.renderReceiptTable([{ receiptId: HOSTILE, walletId: '<img src=x>', isRegistration: true, l1Status: 'batched', l1BatchNumber: '<b>3</b>' }], false);
    expect(attributeNames(receipts).filter((n) => n.startsWith('on'))).toEqual([]);
    expect(receipts).not.toMatch(/<img|<b>/);
    expect(dataValues(receipts, 'receipt')).toEqual([HOSTILE]);
  });
});

/*
 * A-91. The insurer's Formulary page numbered each row's Remove by the row's place in the list it drew, and under a
 * search that list is the filtered one, while removeFormularyEntry splices that number out of the whole formulary and
 * publishes what is left to the sequencer. With Lipitor and Metformin staged, a search for "met" drew Metformin first,
 * and its Remove deleted Lipitor and published a formulary without it. Found 2026-10-24 by the review of the A-88 fix,
 * which carried the same number from the inline handler into data-arg. Now each row's Remove carries its entry's place
 * in formularyData, under a search or not.
 *
 * The review of that fix, the same day, found the table redrawn after a Remove without the search while the box kept
 * its text: a Remove under "met" listed the whole formulary beneath a box that still read "met". Now
 * removeFormularyEntry redraws under the box's text, and each Remove it draws carries its entry's place in what is left.
 *
 * A further review, the same day, found every other draw of the table doing the same beneath a box that kept its text:
 * after an Add, after a CSV publish, on the Refresh button and on entering the tab, each listed the whole formulary.
 * Now renderFormularyTable reads the box at every draw, so no draw can leave the search out, and entering the tab keeps
 * the box's text and draws under it. The tests drive the page through its own wiring (the search box, the Add button
 * and the Refresh button as initManualAdd wires them) and check that the search narrows the table only, never the
 * formulary sent to the sequencer.
 */
describe('the insurer\'s staged formulary: a Remove removes the entry on its own row, and every draw of the table keeps to the search box (A-91)', () => {
  const document = { createElement: textElement };
  interface Entry { ndcHash: string; brandName: string; tierLevel: number; copayAmountCents: number; requiresPriorAuth: boolean }
  /** An entry as the Add form and a CSV file stage one. */
  const entry = (ndcHash: string, brandName: string, tierLevel = 1, copayAmountCents = 500): Entry =>
    ({ ndcHash, brandName, tierLevel, copayAmountCents, requiresPriorAuth: false });
  const LIPITOR = entry('1111', 'Lipitor 20mg');
  const METFORMIN = entry('2222', 'Metformin 500mg');
  const METHOTREXATE = entry('3333', 'Methotrexate 2.5mg', 2, 1500);
  const brands = (list: Entry[]): string[] => list.map((e) => e.brandName);

  /**
   * The Formulary page over `staged`, run from app.js's own functions: initManualAdd wires the search box, the Add button
   * and the Refresh button as the screen does, the box keeps what is typed into it, and a row's Remove is clicked through
   * the screen's listener. `sequencer` is the formulary the sequencer answers when the tab is entered; `published`
   * records each formulary the page sends it.
   */
  function formularyPage(staged: Entry[], sequencer?: Entry[]) {
    const table = { innerHTML: '' };
    const search: { value: string; oninput?: () => void } = { value: '' };
    const addButton: { onclick?: () => void } = {};
    const refreshButton: { onclick?: () => void } = {};
    const fields: Record<string, { value: string }> = { 'form-ndc': { value: '' }, 'form-brand': { value: '' }, 'form-tier': { value: '' }, 'form-copay': { value: '' } };
    const els: Record<string, unknown> = { 'form-table-container': table, 'form-search': search, 'form-add-btn': addButton, 'form-refresh-btn': refreshButton, ...fields };
    const published: string[][] = [];
    const toasts: string[] = [];
    const lifted = ['esc', 'truncHash', 'fmtCents', 'copayCentsFromText', 'loadFormularyFromSequencer', 'loadFormularyPage', 'renderFormularyTable',
      'publishUpload', 'initManualAdd', 'addFormularyEntry', 'removeFormularyEntry', 'publishFormularyToSequencer'].map((n) => lift(INSURER_APP, n));
    const page = run(['var csvParsedData = null;', ...lifted], {
      document, formularyData: staged, planData: [], $: (id: string) => els[id] ?? null,
      renderTierStats: () => undefined, initUploadZone: () => undefined, cancelUpload: () => undefined, showResult: () => undefined,
      toast: (msg: string) => { toasts.push(msg); },
      API: {
        getFormulary: async () => (sequencer ? { entriesJson: JSON.stringify(sequencer) } : null),
        publishFormulary: async (_plan: string, _root: string, entriesJson: string) => { published.push(brands(JSON.parse(entriesJson))); },
      },
    }, '{ loadFormularyPage, initManualAdd, publishUpload, removeFormularyEntry, stageCsv: function (entries) { csvParsedData = entries; } }');
    page.initManualAdd();                                                            // as entering the tab wires the page
    const onIdAction = run([insurerIdActions(), lift(INSURER_APP, 'onIdAction')], { window: { App: { removeFormularyEntry: page.removeFormularyEntry } } }, 'onIdAction');
    const doc = stub();
    doc.addEventListener('click', onIdAction);
    return {
      search, published, toasts,
      loadFormularyPage: page.loadFormularyPage as () => Promise<void>,
      publishUpload: page.publishUpload as () => Promise<void>,
      /** The entries a CSV file was read into, waiting for Publish. */
      stageCsv: page.stageCsv as (entries: Entry[]) => void,
      html: (): string => table.innerHTML,
      /** The brand name on each row the table draws. */
      rows: (): string[] => [...table.innerHTML.matchAll(/<tr><td><span class="hash"[^>]*>[^<]*<\/span><\/td><td>([^<]*)<\/td>/g)].map((m) => m[1]),
      /** What each row's Remove carries in data-arg. */
      args: (): string[] => dataValues(table.innerHTML, 'arg'),
      /** Text typed into the search box, which draws the table at each keystroke. */
      type(text: string): void { search.value = text; search.oninput!(); },
      /** The Add form filled in with a hash and a brand, its tier and copay left blank, and its button clicked. */
      add(ndcHash: string, brand: string): void { fields['form-ndc'].value = ndcHash; fields['form-brand'].value = brand; addButton.onclick!(); },
      refresh(): void { refreshButton.onclick!(); },
      /** A click on the Remove of the row that shows `brand`, as the screen's listener reads it. */
      remove(brand: string): void {
        const row = table.innerHTML.split('</tr>').find((r) => r.includes(`<td>${brand}</td>`));
        if (!row) throw new Error('no row shows ' + brand);
        click(stub({ act: 'removeFormularyEntry', arg: dataValues(row, 'arg')[0] }, doc));
      },
    };
  }

  test('with Lipitor and Metformin staged, Remove on Metformin under the search "met" removes Metformin and publishes Lipitor alone', () => {
    const formularyData = [LIPITOR, METFORMIN];
    const page = formularyPage(formularyData);
    page.type('met');
    expect(page.html()).toContain('<td>Metformin 500mg</td>');
    expect(page.html()).not.toContain('Lipitor');
    expect(page.args()).toEqual(['1']);                                              // before: ['0'], Metformin's row in the filtered list
    page.remove('Metformin 500mg');
    expect(brands(formularyData)).toEqual(['Lipitor 20mg']);                        // before: ['Metformin 500mg']; Lipitor was removed
    expect(page.published).toEqual([['Lipitor 20mg']]);                             // before: [['Metformin 500mg']]
    expect(page.toasts).toEqual(['Removed Metformin 500mg']);                      // before: ['Removed Lipitor 20mg']
  });

  test('after a Remove under the search "met", the table still shows only the entries that match "met", each Remove carrying its place in what is left', () => {
    const formularyData = [LIPITOR, METFORMIN, METHOTREXATE];
    const page = formularyPage(formularyData);
    page.type('met');
    expect(page.rows()).toEqual(['Metformin 500mg', 'Methotrexate 2.5mg']);
    page.remove('Metformin 500mg');
    expect(brands(formularyData)).toEqual(['Lipitor 20mg', 'Methotrexate 2.5mg']);
    expect(page.rows()).toEqual(['Methotrexate 2.5mg']);                            // before: ['Lipitor 20mg', 'Methotrexate 2.5mg'], the whole formulary under "met"
    expect(page.args()).toEqual(['1']);                                              // before: ['0', '1']
    page.remove('Methotrexate 2.5mg');
    expect(brands(formularyData)).toEqual(['Lipitor 20mg']);
    expect(page.html()).toBe('<div class="empty-state">No formulary entries matching "met"</div>');   // before: Lipitor's row
  });

  test('after an Add under the search "met", the table still shows only the entries that match "met": a new one that matches joins them, one that does not stays out, and the whole formulary is published', () => {
    const formularyData = [LIPITOR, METFORMIN, METHOTREXATE];
    const page = formularyPage(formularyData);
    page.type('met');
    page.add('4444', 'Metoprolol 25mg');
    expect(page.rows()).toEqual(['Metformin 500mg', 'Methotrexate 2.5mg', 'Metoprolol 25mg']);   // before: the whole formulary, Lipitor 20mg first
    expect(page.args()).toEqual(['1', '2', '3']);                                    // before: ['0', '1', '2', '3']
    page.add('5555', 'Lisinopril 10mg');
    expect(page.rows()).toEqual(['Metformin 500mg', 'Methotrexate 2.5mg', 'Metoprolol 25mg']);   // before: the whole formulary, Lisinopril 10mg last
    expect(page.search.value).toBe('met');
    expect(page.toasts).toEqual(['Entry added to formulary', 'Entry added to formulary']);
    expect(page.published).toEqual([                                                 // the search narrows the table, never what is sent
      ['Lipitor 20mg', 'Metformin 500mg', 'Methotrexate 2.5mg', 'Metoprolol 25mg'],
      ['Lipitor 20mg', 'Metformin 500mg', 'Methotrexate 2.5mg', 'Metoprolol 25mg', 'Lisinopril 10mg'],
    ]);
  });

  test('after the Refresh button under the search "met", the table still shows only the entries that match "met"', () => {
    const page = formularyPage([LIPITOR, METFORMIN, METHOTREXATE]);
    page.type('met');
    page.refresh();
    expect(page.rows()).toEqual(['Metformin 500mg', 'Methotrexate 2.5mg']);         // before: ['Lipitor 20mg', 'Metformin 500mg', 'Methotrexate 2.5mg'], the whole formulary
    expect(page.args()).toEqual(['1', '2']);                                         // before: ['0', '1', '2']
  });

  test('after a CSV publish under the search "met", the table still shows only the entries that match "met", those the file added or replaced among them, and the whole formulary is published', async () => {
    const formularyData = [LIPITOR, METFORMIN, METHOTREXATE];
    const page = formularyPage(formularyData);
    page.type('met');
    page.stageCsv([entry('2222', 'Metformin 1000mg'), entry('6666', 'Metronidazole 500mg'), entry('7777', 'Warfarin 5mg')]);   // one replaced, two added
    await page.publishUpload();
    expect(page.toasts).toEqual(['Published 2 new, 1 updated to sequencer']);
    expect(page.published).toEqual([['Lipitor 20mg', 'Metformin 1000mg', 'Methotrexate 2.5mg', 'Metronidazole 500mg', 'Warfarin 5mg']]);
    expect(page.rows()).toEqual(['Metformin 1000mg', 'Methotrexate 2.5mg', 'Metronidazole 500mg']);   // before: the whole formulary, Lipitor 20mg and Warfarin 5mg among them
    expect(page.args()).toEqual(['1', '2', '3']);                                    // before: ['0', '1', '2', '3', '4']
  });

  test('entering the tab with "met" left in the box keeps it there and draws the formulary the sequencer answers under it', async () => {
    const page = formularyPage([LIPITOR, METFORMIN], [LIPITOR, METFORMIN, METHOTREXATE, entry('8888', 'Losartan 50mg')]);
    page.type('met');                                                                 // typed before another tab was shown
    await page.loadFormularyPage();                                                   // the tab shown again: the formulary read again, then drawn
    expect(page.search.value).toBe('met');
    expect(page.rows()).toEqual(['Metformin 500mg', 'Methotrexate 2.5mg']);          // before: the whole formulary beneath "met", Lipitor 20mg and Losartan 50mg among it
    expect(page.args()).toEqual(['1', '2']);                                          // before: ['0', '1', '2', '3']
    page.type('');                                                                    // the box, wired again on entry, draws at each keystroke
    expect(page.rows()).toEqual(['Lipitor 20mg', 'Metformin 500mg', 'Methotrexate 2.5mg', 'Losartan 50mg']);
  });
});
