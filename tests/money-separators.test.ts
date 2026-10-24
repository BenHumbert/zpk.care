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
 * Dollar amounts on the insurer dashboard and the marketplace have thousands separators, as the member app's do.
 *
 * What was wrong: both pages wrote cents as '$' + (cents / 100).toFixed(2), so a plan's limits read "$7800.00",
 * "$16000.00" and "$100000.00", hard to read at a glance, where the member app shows "$7,800.00". Found by the QA of
 * the walkthrough's first voiced take, 2026-10-23: the insurer's Registered Plans table showed "$6000.00" and
 * "$100000.00", and the marketplace's plan cards "$7800.00", "$100000.00" and "$16000.00".
 *
 * Now fmtCents on both pages writes whole cents as dollars with separators, in the member app's own form; the amounts
 * are the same. tests/plan-terms-screens.test.ts and tests/insurer-cost-estimator.test.ts read the new form, the second
 * through the page's own fmtCents instead of a copy of the old one.
 *
 * The table and the cards are drawn by renderPlanList and renderPlanCards with the helpers they call, lifted out of
 * app.js.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const INSURER = read('dashboard-insurer/app.js');
const MARKETPLACE = read('dashboard-marketplace/app.js');
const MEMBER = read('dashboard-member/app.js');

/** A top-level function of an IIFE dashboard: its one line, or from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const line = src.slice(at + 1, src.indexOf(NL, at + 1));
  if (line.trimEnd().endsWith('}')) return line;
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtCentsOf = (src: string): ((c: unknown) => string) => run([lift(src, 'fmtCents')], {}, 'fmtCents');

// The two plans of the insurer and the marketplace, with their terms as published
const STANDARD = {
  planId: 'PLAN-STD-RX-2026', name: 'Standard Rx 2026', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000,
  oopMaxCents: 780000, annualBenefitMaxCents: 10000000, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000,
  dispensingFeeCents: 1300, dispensingFeeSource: 'plan', published: true,
};
const LOW_DEDUCTIBLE = {
  ...STANDARD, planId: 'PLAN-LOWDED-RX-2026', name: 'Low Deductible Rx 2026', copayAmountCents: 2500, deductibleAmountCents: 20000,
  oopMaxCents: 600000, familyDeductibleAmountCents: 40000, familyOopMaxCents: 1200000,
};

describe('fmtCents writes dollars with thousands separators, as the member app does', () => {
  const member = fmtCentsOf(MEMBER);
  test.each([['the insurer', INSURER], ['the marketplace', MARKETPLACE]])('on %s', (_page, src) => {
    const fmtCents = fmtCentsOf(src);
    expect(fmtCents(780000)).toBe('$7,800.00');                       // before: $7800.00
    expect(fmtCents(10000000)).toBe('$100,000.00');                   // before: $100000.00
    expect(fmtCents(1418)).toBe('$14.18');
    expect(fmtCents(5)).toBe('$0.05');
    expect(fmtCents(0)).toBe('$0.00');
    expect(fmtCents('1600000')).toBe('$16,000.00');                   // a digit string, as some answers carry cents
    for (const c of [0, 5, 1418, 780000, 10000000, 123456789, -1500]) expect([c, fmtCents(c)]).toEqual([c, member(c)]);
  });

  test('the insurer still shows no amount as "--"', () => {
    expect(fmtCentsOf(INSURER)(null)).toBe('--');
    expect(fmtCentsOf(INSURER)(undefined)).toBe('--');
  });
});

describe('the insurer\'s Registered Plans table', () => {
  test('shows a plan\'s limits with separators', () => {
    const container: Record<string, any> = { innerHTML: '', querySelectorAll: () => [] };
    const render = run(['fmtCents', 'fmtLimit', 'coverageLabel', 'planPublishedTerms', 'planPublishState', 'planStatusBadge', 'publishOutcome', 'renderPlanList'].map((n) => lift(INSURER, n)), {
      $: (id: string) => (id === 'plan-list-container' ? container : null),
      esc: escHtml, planData: [LOW_DEDUCTIBLE], API: {}, toast: () => undefined, fetchPlans: async () => undefined,
      confirm: () => false, openPlanDetail: () => undefined,
    }, 'renderPlanList');
    render();
    const cells = [...String(container.innerHTML).matchAll(/<td style="font-family:var\(--font-mono\)">([^<]*)<\/td>/g)].map((m) => m[1]);
    expect(cells.slice(0, 5)).toEqual(['$25.00', '$200.00', '$6,000.00', '$100,000.00', '$13.00']);   // before: $6000.00, $100000.00
  });
});

describe('the marketplace\'s plan cards', () => {
  test('show each plan\'s amounts with separators', () => {
    const grid: Record<string, any> = { innerHTML: '', querySelectorAll: () => [] };
    const render = run(['fmtCents', 'fmtLimit', 'fmtFee', 'renderPlanCards'].map((n) => lift(MARKETPLACE, n)), {
      document: { getElementById: (id: string) => (id === 'plans-grid' ? grid : null) },
      esc: escHtml, plans: [LOW_DEDUCTIBLE, STANDARD], selectedPlanIds: [], navigate: () => undefined,
    }, 'renderPlanCards');
    render();
    const cards = String(grid.innerHTML).split('<div class="plan-card').slice(1);
    const values = (cardHtml: string) => [...cardHtml.matchAll(/<span class="plan-detail-value">([^<]*)<\/span>/g)].map((m) => m[1]);
    // Deductible, Out-of-Pocket Max, Annual Benefit Max, Family Deductible, Family OOP Max, Dispensing Fee
    expect(values(cards[0])).toEqual(['$200.00', '$6,000.00', '$100,000.00', '$400.00', '$12,000.00', '$13.00']);
    expect(values(cards[1])).toEqual(['$500.00', '$7,800.00', '$100,000.00', '$1,000.00', '$16,000.00', '$13.00']);   // before: $7800.00, $100000.00, $1000.00, $16000.00
    expect(cards[1]).toContain('<div class="plan-price">$10.00 <span>base copay</span></div>');
  });
});
