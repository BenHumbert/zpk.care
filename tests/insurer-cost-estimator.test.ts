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
 * The insurer's Cost Estimator shows the engine's price, not one it computes (review of the pricing fixes, F1).
 *
 * What was wrong: the estimator priced a typed "pharmacy's reported drug cost" (default $50.00) against the drug's
 * catalog tier copay, with no dispensing fee, no deductible, OOP or benefit maximum, and the quantity ignored. That
 * breaks two owner decisions (NADAC plus a dispensing fee; the pharmacy does not set the cost): ABACAVIR x30 for a
 * member of a plan with a $15 copay, a $12.50 fee and a $500 deductible showed $10.00 / $40.00 of $50.00, while the
 * fill charges $30.51, all of it the member's in the deductible phase.
 *
 * Now there is no price input: the estimator asks the engine (l2_estimateCost through the insurer node's /rpc proxy)
 * for a member's own quote, a plan's published price, or the list price, and shows its ingredient, fee, phase and
 * split. A member's quote carries the node's admin token, which the proxy requires for a member's data.
 *
 * The dashboard is a plain browser script: functions are lifted out of app.js and run with stubs, and rpc.js is run
 * with a stand-in fetch, as in tests/plan-terms-screens.test.ts.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const INSURER = read('dashboard-insurer/app.js');
const INSURER_HTML = read('dashboard-insurer/index.html');
const INSURER_RPC = read('dashboard-insurer/rpc.js');

const has = (src: string, name: string): boolean =>
  src.includes(NL + '  function ' + name + '(') || src.includes(NL + '  async function ' + name + '(');
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
const liftAll = (src: string, names: string[]): string[] => names.filter((n) => has(src, n)).map((n) => lift(src, n));
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtCents = (c: number) => '$' + (Number(c) / 100).toFixed(2);

const ABACAVIR_HASH = '7770452185217037457936945884955351010484654540450486511394911988126126761141';
// l2_estimateCost for the run.ts member: plan copay $15, fee $12.50, $500 deductible not yet met
const MEMBER_QUOTE = {
  covered: true, drugName: 'ABACAVIR', ndcHash: ABACAVIR_HASH, classification: 'G', nadacPerUnit: 0.60042, pricingUnit: 'EA', quantity: 30,
  tierLevel: 1, ingredientCostCents: 1801, dispensingFeeCents: 1250, dispensingFeeSource: 'plan', totalCostCents: 3051,
  copayAmountCents: 1500, copayBasis: 'plan', phase: 'deductible', memberPayCents: 3051, employerPayCents: 0,
};

/** The estimator with the page's fields set to `values`; the engine answers `answer`. */
async function estimate(values: Record<string, string>, answer: unknown = MEMBER_QUOTE) {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] = els[id] ?? { id, value: values[id] ?? '', innerHTML: '' });
  const asked: Array<Record<string, unknown>> = [];
  const toasts: Array<[string, string]> = [];
  const doPriceEstimate = run(liftAll(INSURER, ['parseQuantity', 'quotePhaseLabel', 'doPriceEstimate']), {
    $, esc: escHtml, fmtCents, truncHash: (h: string, n: number) => String(h).slice(0, n),
    toast: (m: string, t: string) => { toasts.push([m, t]); },
    API: { estimateCost: async (p: Record<string, unknown>) => { asked.push(p); return answer; } },
    formularyData: [{ ndcHash: ABACAVIR_HASH, brandName: 'ABACAVIR', tierLevel: 1, copayAmountCents: 1000, requiresPriorAuth: false }],
    priceHistory: [], renderPriceHistory: () => undefined,
  }, 'doPriceEstimate');
  await doPriceEstimate();
  return { html: String(els['price-result']?.innerHTML ?? ''), asked, toasts };
}

describe('the Cost Estimator shows the engine\'s price', () => {
  test('a member\'s quote is the engine\'s: NADAC x 30 + the plan\'s fee, all of it the member\'s in the deductible phase', async () => {
    const { html, asked } = await estimate({ 'price-ndc': ABACAVIR_HASH, 'price-qty': '30', 'price-member': '79000000000000000001', 'price-ingredient': '5000' });
    expect(asked).toEqual([{ ndcHash: ABACAVIR_HASH, quantity: 30, walletId: '79000000000000000001' }]);   // before: nothing asked
    expect(html).toContain('Patient Pays</div><div class="price-item-value patient">$30.51');            // before: $10.00
    expect(html).toContain('Plan Pays</div><div class="price-item-value plan">$0.00');                   // before: $40.00
    expect(html).toContain('Total Cost</div><div class="price-item-value total">$30.51');                // before: $50.00
    expect(html).toContain('NADAC $0.60042/EA x 30 EA = $18.01');
    expect(html).toContain('$12.50 (plan)');
    expect(html).toContain('Deductible phase');
    expect(html).not.toContain('$50.00');
  });

  test('with no member, a plan\'s published price is asked by its plan ID; with neither, the list price', async () => {
    const planQuote = { ...MEMBER_QUOTE, phase: 'copay', memberPayCents: 1500, employerPayCents: 1551 };
    const plan = await estimate({ 'price-ndc': ABACAVIR_HASH, 'price-qty': '30', 'price-plan': 'PLAN-E2E-SILVER' }, planQuote);
    expect(plan.asked).toEqual([{ ndcHash: ABACAVIR_HASH, quantity: 30, planId: 'PLAN-E2E-SILVER' }]);
    expect(plan.html).toContain('Plan copay');
    expect(plan.html).toContain('$15.51');
    const list = await estimate({ 'price-ndc': ABACAVIR_HASH, 'price-qty': '30' }, { ...planQuote, dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', copayBasis: 'tier', copayAmountCents: 1000 });
    expect(list.asked).toEqual([{ ndcHash: ABACAVIR_HASH, quantity: 30 }]);
    expect(list.html).toContain('Tier 1 copay');
    expect(list.html).toContain('(network default)');
  });

  test('a drug off the member\'s plan is shown as not covered, with the engine\'s reason', async () => {
    const { html } = await estimate({ 'price-ndc': '1', 'price-qty': '30', 'price-member': '7' },
      { covered: false, drugName: 'ABACAVIR-LAMIVUDINE', nadacPerUnit: 1.56657, pricingUnit: 'EA', quantity: 30, phase: 'not-covered', reason: 'Not on the formulary of the member\'s plan' });
    expect(html).toContain('Not covered: ABACAVIR-LAMIVUDINE');
    expect(html).toContain('Not on the formulary of the member\'s plan');
  });

  test('quantities are in the pricing unit to thousandths; a fourth decimal asks nothing', async () => {
    const pen = await estimate({ 'price-ndc': ABACAVIR_HASH, 'price-qty': '0.4' });
    expect(pen.asked.map((p) => p.quantity)).toEqual([0.4]);
    const tooFine = await estimate({ 'price-ndc': ABACAVIR_HASH, 'price-qty': '0.0005' });
    expect(tooFine.asked).toEqual([]);
    expect(tooFine.toasts[0]?.[1]).toBe('error');
  });

  test('the page has no price input: the pharmacy does not set the cost', () => {
    expect(INSURER_HTML).not.toContain('id="price-ingredient"');                   // before: "Pharmacy's reported drug cost"
    expect(INSURER_HTML).not.toContain('reported drug cost');
    expect(INSURER_HTML).toContain('id="price-qty" value="30" min="0.001" step="0.001"');
  });
});

describe('the insurer page asks the engine through its node, with the admin token for a member\'s quote', () => {
  test('API.estimateCost posts l2_estimateCost to the node\'s /rpc with the node\'s admin token', async () => {
    const sent: Array<{ url: string; init: any }> = [];
    const API = new Function('location', 'localStorage', 'fetch', 'EventSource', `${INSURER_RPC}\nreturn API;`)(
      { origin: 'http://127.0.0.1:4004' },
      { getItem: () => 'insurer-admin-token', setItem: () => undefined },
      async (url: string, init: any) => { sent.push({ url, init }); return { json: async () => ({ jsonrpc: '2.0', id: 1, result: MEMBER_QUOTE }) }; },
      undefined,
    );
    expect(typeof API.estimateCost).toBe('function');                             // before: no such call
    const q = await API.estimateCost({ ndcHash: ABACAVIR_HASH, quantity: 30, walletId: '79000000000000000001' });
    expect(q.memberPayCents).toBe(3051);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('http://127.0.0.1:4004/rpc');
    expect(sent[0].init.headers.Authorization).toBe('Bearer insurer-admin-token');
    expect(JSON.parse(sent[0].init.body)).toMatchObject({ method: 'l2_estimateCost', params: { walletId: '79000000000000000001', quantity: 30 } });
  });
});
