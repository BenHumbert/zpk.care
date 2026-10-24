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
 * Every dashboard's escape helper escapes both quotes, as the HR Tool's (A-66) and the prescriber's (A-73) do.
 *
 * What was wrong: the insurer, employer and marketplace dashboards' esc() escaped <, > and & but not quotes, and each
 * writes values into quoted attributes: the insurer's roster puts a member's wallet ID in title="...", the employer's
 * group list a group ID in data-gid="...", the marketplace a plan ID in data-plan="...". On the insurer's roster a
 * wallet ID registered with a quote in it (A-74) ended the attribute and added a handler, on a page that holds the
 * insurer's admin token. The member dashboard's and the network screen's helpers escaped double quotes but not single
 * ones; the pharmacy's, the explorer's and the unused shared helper escaped neither. The insurer's group list also put
 * each group ID inside an inline onclick handler, where no escaping helps: the browser decodes &#39; back to a quote
 * before the script runs. A member's node registers its entity's group with l2_registerEntity, and the insurer's
 * roster reads the group from there for any wallet it holds no enrollment record for (all of them, after an insurer
 * restart). Found by the security posture check of 2026-10-24, which chained the gap to A-74 (report sections 3 to 5).
 *
 * Now every dashboard's and the explorer's helper escapes & < > " and ', so a value placed in a quoted attribute stays
 * inside it, and the insurer's group list carries the group ID in data-gid, read by a listener.
 *
 * The helpers, and a renderer of each of the three dashboards that uses one in an attribute, are lifted out of their
 * files and run against a stand-in element whose innerHTML escapes its text as a browser's does (&, < and >; never
 * quotes).
 */
import fs from 'fs';
import path from 'path';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);

/** A function of an IIFE dashboard: its one line, or from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const firstLine = src.slice(at + 1, src.indexOf(NL, at + 1));
  if (firstLine.trimEnd().endsWith('}')) return firstLine;
  return src.slice(at + 1, src.indexOf(NL + '  }' + NL, at) + 4);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
/** An element whose innerHTML escapes the text set on it as a browser's does: &, < and >, never quotes. */
function textElement() {
  let text = '';
  return {
    set textContent(v: unknown) { text = v == null ? '' : String(v); },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}
const document = { createElement: textElement };
/** An attribute value as the browser reads it back out of the markup. */
const unescapeHtml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Every escape helper in the dashboards and the explorer, found by name in their scripts. */
function escapeHelpers(): Array<{ file: string; name: string }> {
  const folders = fs.readdirSync('.').filter((d) => d.startsWith('dashboard-') || d === 'explorer');
  const found: Array<{ file: string; name: string }> = [];
  for (const folder of folders) {
    for (const f of fs.readdirSync(folder).filter((n) => n.endsWith('.js'))) {
      const file = path.posix.join(folder, f);
      for (const m of read(file).matchAll(/\n {2}function (esc|escHtml|escapeHtml)\(/g)) found.push({ file, name: m[1] });
    }
  }
  return found;
}

const ATTR = '1001" onmouseover="steal()';
const ATTR_ESCAPED = '1001&quot; onmouseover=&quot;steal()';

describe('the escape helpers', () => {
  const helpers = escapeHelpers();

  test('one is found in each dashboard and the explorer', () => {
    expect(helpers.map((h) => `${h.file}:${h.name}`).sort()).toEqual([
      'dashboard-employer/app.js:esc', 'dashboard-hr-tool/app.js:esc', 'dashboard-insurer/app.js:esc',
      'dashboard-leviathan/app.js:escHtml', 'dashboard-marketplace/app.js:esc', 'dashboard-member/app.js:esc',
      'dashboard-pharmacy/app.js:escapeHtml', 'dashboard-prescriber/app.js:esc', 'dashboard-shared/utils.js:esc',
      'explorer/app.js:esc',
    ]);
  });

  test('each escapes double and single quotes as well as markup', () => {
    for (const { file, name } of helpers) {
      const esc = run([lift(read(file), name)], { document }, name);
      expect([file, esc(ATTR)]).toEqual([file, ATTR_ESCAPED]);                          // before (insurer, employer, marketplace, pharmacy, explorer): the quote ended the attribute
      expect([file, esc("O'Brien <b>& Sons")]).toEqual([file, 'O&#39;Brien &lt;b&gt;&amp; Sons']);   // before (member, network screen too): the single quote raw
      expect([file, esc(null)]).toEqual([file, '']);
    }
  });
});

describe('a value in a quoted attribute stays inside it', () => {
  test('the insurer\'s roster: a member\'s wallet ID in title=""', () => {
    const INSURER = read('dashboard-insurer/app.js');
    const els: Record<string, { innerHTML: string }> = {};
    const renderGroupDetail = run(['esc', 'truncHash', 'fmtDate', 'renderGroupDetail'].map((n) => lift(INSURER, n)), {
      document, $: (id: string) => (els[id] = els[id] ?? { innerHTML: '' }),
      rosterData: { entries: [{ walletId: ATTR, groupId: 'GRP-1', role: 'member', planId: 'PLAN-1', displayName: "O'Brien", registeredAt: 0 }] },
    }, 'renderGroupDetail');
    renderGroupDetail('GRP-1');
    const html = els['emp-detail-body'].innerHTML;
    expect(html).toContain(`<span class="hash" title="${ATTR_ESCAPED}">`);
    expect(html).not.toContain('onmouseover="');                                        // before: title="1001" onmouseover="steal()"
  });

  test('the employer\'s group list: a group ID in data-gid=""', async () => {
    const EMPLOYER = read('dashboard-employer/app.js');
    const table = { innerHTML: '', querySelectorAll: () => [] };
    const loadGroupsTable = run(['esc', 'fmtDateShort', 'loading', 'emptyState', 'loadGroupsTable'].map((n) => lift(EMPLOYER, n)), {
      document: { ...document, getElementById: () => table },
      API: { listGroups: async () => [{ groupId: 'GRP-1" onmouseover="steal()', planId: "PLAN-'1'", status: 'active', enrollmentCap: 10, enrolledCount: 1, pendingTokens: 0, effectiveDate: '2026-01-01' }] },
      doDeleteGroup: () => undefined,
    }, 'loadGroupsTable');
    await loadGroupsTable();
    expect(table.innerHTML).toContain('data-gid="GRP-1&quot; onmouseover=&quot;steal()"');
    expect(table.innerHTML).toContain('PLAN-&#39;1&#39;');
    expect(table.innerHTML).not.toContain('onmouseover="');                             // before: data-gid="GRP-1" onmouseover="steal()"
  });

  test('the marketplace: a plan ID in data-plan=""', () => {
    const MARKETPLACE = read('dashboard-marketplace/app.js');
    const grid = { innerHTML: '', querySelectorAll: () => [] };
    const renderPlanCards = run(['esc', 'fmtCents', 'fmtLimit', 'fmtFee', 'renderPlanCards'].map((n) => lift(MARKETPLACE, n)), {
      document: { ...document, getElementById: () => grid },
      plans: [{ planId: 'PLAN-1" onmouseover="steal()', name: 'Gold <b>PPO</b>', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 0, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, dispensingFeeCents: 1000 }],
      selectedPlanIds: [],
    }, 'renderPlanCards');
    renderPlanCards();
    expect(grid.innerHTML).toContain('data-plan="PLAN-1&quot; onmouseover=&quot;steal()"');
    expect(grid.innerHTML).not.toContain('onmouseover="');                              // before: data-plan="PLAN-1" onmouseover="steal()"
    expect(grid.innerHTML).toContain('Gold &lt;b&gt;PPO&lt;/b&gt;');
  });
});

describe('the insurer\'s group list', () => {
  test('carries a group ID in data-gid with a listener, never inside an inline handler', async () => {
    const INSURER = read('dashboard-insurer/app.js');
    const GID = "GRP-1');steal();//";
    const items: Array<{ dataset: { gid: string }; onclick: (() => void) | null }> = [];
    const list = {
      innerHTML: '',
      // the items a browser builds from the markup, each data-gid read back as the browser reads it
      querySelectorAll: (selector: string) => (selector !== '.emp-item' ? [] : [...list.innerHTML.matchAll(/<div class="emp-item[^"]*" data-gid="([^"]*)">/g)].map((m) => {
        const item = { dataset: { gid: unescapeHtml(m[1]) }, onclick: null };
        items.push(item);
        return item;
      })),
    };
    const selected: string[] = [];
    const loadRosterData = run(['esc', 'loadRosterData'].map((n) => lift(INSURER, n)), {
      document, $: (id: string) => (id === 'emp-list' ? list : null),
      API: { getRoster: async () => ({ data: { entries: [{ walletId: '1001', groupId: GID }], groupSummary: { [GID]: { count: 1, roles: { member: 1 } } } } }) },
      rosterData: null, selectedGroup: 'GRP-ALREADY-SHOWN', selectGroup: (gid: string) => { selected.push(gid); },
    }, 'loadRosterData');
    await loadRosterData();
    // before: onclick="App.selectGroup('GRP-1&#39;);steal();//')", which the browser runs as App.selectGroup('GRP-1');steal();//')
    expect(list.innerHTML).not.toContain('onclick');
    expect(list.innerHTML).toContain('<div class="emp-item" data-gid="GRP-1&#39;);steal();//">');
    expect(items).toHaveLength(1);
    items[0].onclick!();
    expect(selected).toEqual([GID]);                                                     // the group, exactly as registered
  });
});
