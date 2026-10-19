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
 * The HR Tool's tabs after the tool changes page by itself.
 *
 * What was wrong: each tab is a link to #page, and the router renders on hashchange. Pages the tool opens by itself
 * (Groups after unlock, the Dashboard once a group is selected, Groups when a group-scoped page has no group) were
 * rendered without touching the address bar. A link to the hash already there fires no hashchange, so the tab for the
 * hash left behind did nothing. The walkthrough rehearsal of 2026-10-19 hit it: Import was clicked while "Initialize
 * & Select" was still making the group's seed, the router sent it back to Groups, the selection then opened the
 * Dashboard, and #import stayed in the address bar, so every later click on Import was ignored. Opening a bookmark
 * to #import with no group selected did the same.
 *
 * Now the router puts the page it renders in the address bar with history.replaceState, which fires no hashchange
 * and adds no history entry, so every tab other than the page on screen is live.
 *
 * The router is lifted out of app.js and run against a stand-in browser that, like a real one, fires hashchange
 * only when a link changes the hash.
 */
import fs from 'fs';

const NL = '\n';
const APP = fs.readFileSync('dashboard-hr-tool/app.js', 'utf8').replace(/\r\n/g, NL);

/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
/** The hashchange listener: from its registration to the first line that is exactly "  });". */
function liftHashListener(): string {
  const at = APP.indexOf(NL + "  window.addEventListener('hashchange'");
  if (at < 0) throw new Error('no hashchange listener');
  const end = APP.indexOf(NL + '  });' + NL, at);
  return APP.slice(at + 1, end + 6);
}
const flush = () => new Promise<void>((r) => setImmediate(r));

interface Session { groupSelected: boolean; groupId?: string; planId?: string }

function tool(session: Session = { groupSelected: false }) {
  const location = { hash: '' };
  const listeners: Array<() => void> = [];
  const rendered: string[] = [];
  const toasts: string[] = [];
  let replaced = 0;
  const history = { replaceState: (_state: unknown, _title: string, url: string) => { replaced++; location.hash = url; } };
  const window = {
    addEventListener: (event: string, fn: () => void) => { if (event === 'hashchange') listeners.push(fn); },
    scrollTo: () => {},
  };
  const navLinks = ['groups', 'dashboard', 'import', 'employees', 'tokens', 'reconcile', 'settings'].map((tab) => {
    const link = { dataset: { tab }, active: false, classList: { toggle: (_c: string, on?: boolean) => { link.active = !!on; return !!on; } } };
    return link;
  });
  const page = (name: string) => () => { rendered.push(name); };
  const scope: Record<string, unknown> = {
    location, history, window, navLinks,
    API: { getSession: async () => session },
    toast: (m: string) => { toasts.push(m); },
    hydrateActiveGroupStats: async () => {},
    renderGroupSelection: page('groups'), renderDashboard: page('dashboard'), renderImport: page('import'),
    renderEmployees: page('employees'), renderTokens: page('tokens'), renderReconcile: page('reconcile'),
    renderSettings: page('settings'),
  };
  const body = [
    "let currentPage = 'dashboard';", 'let activeGroup = null;', 'let _rehydrating = false;',
    lift('navigate'), liftHashListener(), lift('renderPage'),
  ].join(NL);
  const names = Object.keys(scope);
  const api = new Function(...names, `'use strict';\n${body}\nreturn { navigate, selectGroup: (g) => { activeGroup = g; } };`)(
    ...names.map((n) => scope[n])) as { navigate: (p: string) => void; selectGroup: (g: object) => void };
  /** A click on a tab: the browser sets the hash, and fires hashchange only if the hash changed. */
  const click = (tab: string): boolean => {
    if (location.hash === '#' + tab) return false;
    location.hash = '#' + tab;
    for (const fn of listeners) fn();
    return true;
  };
  return { ...api, location, rendered, toasts, click, navLinks, replacedCount: () => replaced };
}

const GROUP = { groupId: 'GRP-FERNHILL-LAB', planId: 'PLAN-STD-RX-2026' };

describe('the HR Tool keeps its tabs live when it changes page by itself', () => {
  test('the rehearsal: Import clicked during "Initialize & Select" works once the group is selected', async () => {
    const t = tool();
    t.navigate('groups');                              // enterApp: after unlock, the Group Selection Screen
    expect(t.location.hash).toBe('#groups');

    // Initialize & Select is in flight (the server is making the group's seed), and Import is clicked
    expect(t.click('import')).toBe(true);
    await flush(); await flush();
    expect(t.toasts).toEqual(['Select a group first']);
    expect(t.rendered.at(-1)).toBe('groups');
    expect(t.location.hash).toBe('#groups');           // before: #import stayed in the address bar

    // the selection lands and opens the Dashboard
    t.selectGroup(GROUP);
    t.navigate('dashboard');
    expect(t.rendered.at(-1)).toBe('dashboard');
    expect(t.location.hash).toBe('#dashboard');

    // Import now opens Import
    expect(t.click('import')).toBe(true);              // before: false, the hash was already #import
    expect(t.rendered.at(-1)).toBe('import');          // before: still the Dashboard
    expect(t.navLinks.filter((l) => l.active).map((l) => l.dataset.tab)).toEqual(['import']);
  });

  test('a bookmark to #import with no group selected leaves Import live after the group is chosen', async () => {
    const t = tool();
    t.location.hash = '#import';                      // the page opens on a bookmark
    t.navigate('import');                             // and routes the hash it found
    await flush(); await flush();
    expect(t.rendered).toEqual(['groups']);
    expect(t.location.hash).toBe('#groups');
    t.selectGroup(GROUP);
    t.navigate('dashboard');
    expect(t.click('import')).toBe(true);
    expect(t.rendered.at(-1)).toBe('import');
  });

  test('a page restored from the server session keeps its tab; the address bar changes only when it differs', async () => {
    const t = tool({ groupSelected: true, ...GROUP });
    expect(t.click('employees')).toBe(true);           // a refresh lost the local group; the server still has it
    await flush(); await flush();
    expect(t.rendered).toEqual(['employees']);
    expect(t.location.hash).toBe('#employees');
    expect(t.replacedCount()).toBe(0);                 // the hash already named the page: no replaceState
    t.navigate('dashboard');
    expect(t.replacedCount()).toBe(1);
  });

  test('each navigation renders once and adds no history entry', () => {
    const t = tool();
    t.selectGroup(GROUP);
    t.navigate('dashboard');
    t.click('import');
    t.navigate('tokens');
    expect(t.rendered).toEqual(['dashboard', 'import', 'tokens']);
    const nav = lift('navigate');
    expect(nav).toContain('history.replaceState(');
    expect(nav).not.toMatch(/location\.hash\s*=[^=]|pushState/);   // either would render twice or add a history entry
  });
});
