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
 * What the pricing fixes left on the plan store and the insurer and pharmacy screens.
 *
 * What was wrong:
 *  1. The sequencer's plan store (planStoreError) checked a plan's live copay but none of its six live limits: a plan
 *     stored straight through l2_storePlan could hold a negative or fractional deductible that the insurer's own
 *     POST and PUT /plans refuse.
 *  2. The insurer's Formulary page read its copay inputs as `Number(x) || 1000`: a typed 0, in the manual entry or in an
 *     uploaded CSV, became a $10.00 copay. The plan form had been fixed (A-54); this page had not.
 *  3. The visualizer's pharmacy dashboard listed each drug's AWP, which prices nothing: a fill costs NADAC per unit
 *     times the quantity plus the plan's fee. Its Tier column read a field /node/state does not send.
 *  4. The insurer dashboard's handler object had two `denyApp` keys, so the credentialing deny replaced the employer
 *     application's: Deny on an employer application posted to the credentialing route, which has no such application.
 *  5. The Employers & Groups page polls its applications every 10 s and read `currentTab`, which nothing declared; in
 *     the page's strict mode every poll threw, so the list never refreshed itself and the poll never stopped.
 *
 * Now the store holds the live limits to the insurer routes' rule; the Formulary page keeps a typed 0 (blank takes
 * $10.00) and refuses anything but whole cents; the pharmacy list shows NADAC per unit with its unit, computed as the
 * engine computes it; the credentialing deny has its own name; and the router keeps the tab on screen.
 */
import fs from 'fs';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(120_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const INSURER_APP = read('dashboard-insurer/app.js');

/** A top-level function of an IIFE dashboard: from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
/** A top-level function of an ES module: from its declaration to the first line that is exactly "}". */
function liftModule(src: string, name: string): string {
  const at = src.search(new RegExp(`\\n(export )?function ${name}\\(`));
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '}' + NL, at);
  return src.slice(at + 1, end + 2).replace(/^export /, '');
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('1. the plan store holds a plan\'s live limits to the insurer routes\' rule', () => {
  const LIMITS = ['deductibleAmountCents', 'oopMaxCents', 'annualBenefitMaxCents', 'familyDeductibleAmountCents', 'familyOopMaxCents', 'familyAnnualBenefitMaxCents'];
  const plan = (over: Record<string, unknown> = {}) => ({ planId: 'P', name: 'N', copayAmountCents: 1500, ...over });

  test('a negative, fractional, string or null limit is refused, naming the field; 0 and a field left out are not', async () => {
    const { planStoreError } = await import('../src/l2/plan-terms.js');
    for (const field of LIMITS) {
      for (const bad of [-1, 10.5, '500', null, Number.NaN, 2 ** 60]) {
        expect([field, bad, planStoreError(plan({ [field]: bad }))]).toEqual([field, bad, `${field} must be a whole number of cents, 0 or more`]);   // before: null
      }
      expect(planStoreError(plan({ [field]: 0 }))).toBeNull();        // 0 is none, or no limit
      expect(planStoreError(plan({ [field]: 50000 }))).toBeNull();
    }
    expect(planStoreError(plan())).toBeNull();                        // left out: the insurer's routes fill in the defaults
  });

  test('l2_storePlan refuses such a plan, and stores it once the limit is whole cents', async () => {
    const { InMemoryStore } = await import('../src/storage/local-store.js');
    const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
    const { L2Node } = await import('../src/l2/l2-node.js');
    const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
    const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-plan-limits' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    const rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: 'operator-plan-limits', enableSSE: false });
    await rpcServer.start();
    try {
      const store = async (p: Record<string, unknown>) => (await (await fetch(`http://127.0.0.1:${rpcServer.getPort()}/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer operator-plan-limits' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_storePlan', params: { plan: p } }),
      })).json()) as any;
      const refused = await store({ ...plan({ deductibleAmountCents: -50000 }), formularyNdcs: [], networkProviderWalletIds: [], published: false, createdAt: 1, updatedAt: 1 });
      expect(refused.error?.message).toBe('deductibleAmountCents must be a whole number of cents, 0 or more');   // before: stored
      expect(node.getSequencer().getPlan('P')).toBeFalsy();
      const stored = await store({ ...plan({ deductibleAmountCents: 50000 }), formularyNdcs: [], networkProviderWalletIds: [], published: false, createdAt: 1, updatedAt: 1 });
      expect(stored.error).toBeUndefined();
    } finally {
      await rpcServer.stop();
    }
  });
});

describe('2. the insurer\'s Formulary page keeps a typed 0 copay', () => {
  /** The manual entry, with the page's fields set to `values`. */
  function addEntry(values: Record<string, string>) {
    const els: Record<string, any> = {};
    const $ = (id: string) => (els[id] = els[id] ?? { id, value: values[id] ?? '', innerHTML: '' });
    const formularyData: any[] = [];
    const toasts: Array<[string, string]> = [];
    let published = 0;
    const add = run(['copayCentsFromText', 'addFormularyEntry'].map((n) => lift(INSURER_APP, n)), {
      $, formularyData, toast: (m: string, t: string) => { toasts.push([m, t]); }, showResult: () => undefined,
      renderTierStats: () => undefined, renderFormularyTable: () => undefined, publishFormularyToSequencer: () => { published++; },
    }, 'addFormularyEntry');
    add();
    return { formularyData, toasts, published };
  }

  test('manual entry: a typed 0 is a $0 copay, blank takes $10.00, anything but whole cents is refused', () => {
    expect(addEntry({ 'form-ndc': '111', 'form-copay': '0' }).formularyData[0].copayAmountCents).toBe(0);      // before: 1000
    expect(addEntry({ 'form-ndc': '111', 'form-copay': '' }).formularyData[0].copayAmountCents).toBe(1000);
    expect(addEntry({ 'form-ndc': '111', 'form-copay': ' 750 ' }).formularyData[0].copayAmountCents).toBe(750);
    for (const bad of ['-5', '12.5', 'abc']) {
      const r = addEntry({ 'form-ndc': '111', 'form-copay': bad });
      expect([bad, r.formularyData.length, r.published, r.toasts[0]?.[1]]).toEqual([bad, 0, 0, 'error']);      // before: added at $10.00
    }
  });

  test('CSV upload: a 0 copay stays 0, a blank one takes the default, and a row that is not whole cents is named and not read', () => {
    const parse = run(['copayCentsFromText', 'csvFormularyEntries'].map((n) => lift(INSURER_APP, n)), {}, 'csvFormularyEntries');
    const out = parse('ndcHash,tierLevel,copayAmountCents,brandName\r\n111,1,0,Generic\r\n222,2,,Preferred\r\n333,3,750,Brand\r\n444,1,-1,Bad\r\n');
    expect(out.error).toBeNull();
    expect(out.entries.map((e: any) => [e.ndcHash, e.copayAmountCents])).toEqual([['111', 0], ['222', 1000], ['333', 750]]);
    expect(out.errors).toEqual(['Row 4: copayAmountCents must be a whole number of cents, 0 or more']);
    expect(parse('ndcHash\n').error).toMatch(/header row and at least one data row/);
    expect(parse('brandName,tier\nx,1\n').error).toMatch(/ndcHash/);
  });

  test('the page says what 0 and blank mean', () => {
    const html = read('dashboard-insurer/index.html');
    expect(html).toContain('<span class="form-hint">0 = no copay; blank = $10.00</span>');
    expect(html).toContain('A blank copay is $10.00; 0 is no copay.');
  });
});

describe('3. the pharmacy dashboard lists NADAC per unit, as the engine computes it', () => {
  const PHARMACY = read('visualizer/src/js/pharmacy-dashboard.js');
  const NADAC = read('visualizer/src/js/interactive/nadac-price.js');
  const nadac = new Function(`'use strict';\n${NADAC.replace(/^export\s+/gm, '')}\nreturn { nadacPerUnitLabel, nadacUnitPriceE5 };`)();
  const COMMON = read('visualizer/src/js/node-common.js');

  /** The Formulary section rendered from `medications` as /node/state sends them. */
  function formulary(medications: unknown[]): string {
    const els: Record<string, any> = {};
    const render = run([liftModule(PHARMACY, 'tierBadge'), liftModule(PHARMACY, 'renderFormulary'), liftModule(COMMON, 'renderSortableTable')], {
      medications, ...nadac, formatCents: (c: number) => '$' + (c / 100).toFixed(2),
      renderSectionCard: (title: string, _kind: string, body: string) => `<h3>${title}</h3>${body}`,
      document: { getElementById: (id: string) => (els[id] = els[id] ?? { id, innerHTML: '' }) },
    }, 'renderFormulary');
    render();
    return String(els['section-formulary'].innerHTML);
  }

  test('the column is NADAC/Unit with the unit, not AWP; a drug with no NADAC price says so; the tier is the one /node/state sends', () => {
    const html = formulary([
      { index: 0, brandName: 'ABACAVIR', genericName: 'ABACAVIR', strength: '300 MG', ndc: '00378-4105-91', tier: 1, nadacPerUnit: 0.60042, pricingUnit: 'EA', awpCents: 72 },
      { index: 1, brandName: 'NO PRICE', genericName: '', strength: '', ndc: '1', tier: 2 },
    ]);
    expect(html).toContain('>NADAC/Unit</th>');
    expect(html).toContain('$0.60042/EA');
    expect(html).toContain('No NADAC price');
    expect(html).not.toMatch(/AWP/);                     // before: the AWP column
    expect(html).not.toContain('$0.72');
    expect(html).toMatch(/tier-1|Tier 1|T1/);           // before: the tier column read tierLevel, which /node/state does not send
  });

  test('every drug in the catalog shows the price the engine reads: whole $0.00001, as nadac-pricing.ts rounds it', async () => {
    process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
    const engine = await import('../src/fulfillment/nadac-pricing.js');
    const { formularyRaw } = await import('../src/data/formulary-loader.js') as any;
    const meds = (formularyRaw as Array<{ ndc: string; nadacPerUnit: number; pricingUnit: string }>).map((d, i) => ({ index: i, brandName: `D${i}`, ndc: d.ndc, tier: 1, nadacPerUnit: d.nadacPerUnit, pricingUnit: d.pricingUnit }));
    expect(meds.length).toBeGreaterThan(50);
    const html = formulary(meds);
    for (const d of meds) {
      const want = `${engine.formatNadacUnitPrice(engine.nadacUnitPriceE5(d.nadacPerUnit))}/${d.pricingUnit}`;
      expect([d.ndc, html.includes(`>${want}</td>`)]).toEqual([d.ndc, true]);
    }
  });
});

describe('4. the insurer dashboard\'s handlers each have one name', () => {
  test('no key of window.App is given twice, and each Deny reaches its own route', () => {
    const at = INSURER_APP.indexOf('window.App = {');
    const block = INSURER_APP.slice(at, INSURER_APP.indexOf(NL + '  };', at));
    const keys = [...block.matchAll(/^ {4}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);     // before: ['denyApp']
    expect(block).toContain('denyApp: denyApp,');
    // the credentialing list's Deny names the credentialing handler
    const actions = run([lift(INSURER_APP, 'credAppActions')], { esc: escHtml }, 'credAppActions');
    expect(actions({ applicationId: 'CRED-1', status: 'pending' })).toContain("App.denyCredentialingApp('CRED-1')");
    expect(keys).toContain('denyCredentialingApp');
  });
});

describe('5. the Employers & Groups poll knows which tab is on screen', () => {
  test('it refreshes the applications while the tab is shown and stops once another is', () => {
    const start = INSURER_APP.indexOf("  var tabs = document.querySelectorAll('.nav-tab');");
    const navAt = INSURER_APP.indexOf(NL + '  function navigate(', start);
    const router = INSURER_APP.slice(start, INSURER_APP.indexOf(NL + '  }' + NL, navAt) + 4);
    let poll: (() => void) | null = null;
    const loaded: string[] = [];
    let cleared = 0;
    const page = run([router, 'var _appsPollTimer = null;', lift(INSURER_APP, 'loadEmployersPage'), 'function onPageEnter(tab) { if (tab === \'employers\') loadEmployersPage(); }'], {
      document: { querySelectorAll: () => [] },
      window: { location: { hash: '' }, _overviewTimer: null },
      $: () => null,
      loadMarketplaceApplications: () => { loaded.push('applications'); },
      loadRosterData: () => undefined,
      setInterval: (fn: () => void) => { poll = fn; return 1; },
      clearInterval: () => { cleared++; },
    }, '{ navigate }');
    page.navigate('employers');
    expect(loaded).toEqual(['applications']);
    expect(poll).not.toBeNull();
    poll!();                                            // before: ReferenceError, currentTab is not defined
    expect(loaded).toEqual(['applications', 'applications']);
    page.navigate('audit');
    poll!();
    expect(cleared).toBe(1);
    expect(loaded).toHaveLength(2);
  });
});
