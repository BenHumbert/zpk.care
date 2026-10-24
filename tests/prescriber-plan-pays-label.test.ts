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
 * The prescriber's Cost Estimate says what the plan pays in words that hold for the quote.
 *
 * What was wrong: the Plan Pays tile printed the quote's employerPayCents above a fixed "Plan covers remainder". In the
 * deductible phase the plan pays nothing, the member paying the whole fill toward her deductible, so the tile read
 * "$0.00" over "Plan covers remainder"; the same was wrong within the copay and past the annual benefit max. Found by
 * the QA of the walkthrough's first voiced take, 2026-10-23: through the prescribe scene the tile read "$0.00, Plan
 * covers remainder" beside "Patient Pays $14.18, Deductible phase", while the narration said she pays all of it toward
 * her deductible.
 *
 * Now the line under the plan's amount follows the quote's phase and amounts (planPaysLabel): "Deductible phase: the
 * plan pays nothing yet" when the plan pays nothing in the deductible phase, and a line of its own for each split the
 * fill circuit makes, escaped into the card.
 *
 * Each quote here is split by the engine's own rule (splitClaimCost), and the card is estimateCardHtml with the helpers
 * it calls, lifted out of app.js.
 */
import fs from 'fs';
import { splitClaimCost, type AccumulatorAmounts } from '../src/access-control/accumulator-query-service.js';

const NL = '\n';
const APP = fs.readFileSync('dashboard-prescriber/app.js', 'utf8').replace(/\r\n/g, NL);

const has = (name: string): boolean => APP.includes(NL + '  function ' + name + '(');
/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  const at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
/** A top-level `var NAME = { ... };` of the page, closed by a line that is exactly "  };". */
function liftVar(name: string): string {
  const at = APP.indexOf(NL + '  var ' + name + ' = ');
  if (at < 0) throw new Error('no var ' + name);
  const end = APP.indexOf(NL + '  };' + NL, at);
  return APP.slice(at + 1, end + 5);
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const WALLET = '79000000000000000001';
/** The card for a patient's own quote; a helper the fix added is absent from the page before it. */
function card(quote: Record<string, unknown>, esc: (s: unknown) => string = escHtml): string {
  const pieces = [liftVar('PHASE_LABELS'), liftVar('PA_LABELS'),
    ...['memberPaysLabel', 'planPaysLabel', 'coverageLine', 'priorAuthBlock', 'estimateCardHtml'].filter(has).map(lift)];
  const estimateCardHtml = new Function('esc', `'use strict';\n${pieces.join(NL)}\nreturn estimateCardHtml;`)(esc);
  return estimateCardHtml(quote, WALLET, null, 30).html;
}
/** The Plan Pays tile: its amount and the line under it. */
function planTile(html: string): { amount: string; line: string } {
  const m = html.match(/id="rx-est-plan-pays" data-cents="[^"]*"[^>]*>([^<]*)<\/div><div[^>]*>([^<]*)<\/div>/);
  if (!m) throw new Error('no Plan Pays tile');
  return { amount: m[1], line: m[2] };
}

// Standard Rx 2026: $500 deductible, $7,800 OOP max, $100,000 annual benefit max, $10 copay
const accumulator = (paid: Partial<AccumulatorAmounts> = {}): AccumulatorAmounts => ({
  deductibleAmountCents: 50000, deductiblePaidCents: 0, oopMaxCents: 780000, oopPaidCents: 0,
  annualBenefitMaxCents: 10000000, annualBenefitUsedCents: 0, ...paid,
});
/** l2_estimateCost for ALLOPURINOL x 30 EA, its total and split as the engine makes them for these accumulators. */
function quote(totalCostCents: number, paid: Partial<AccumulatorAmounts>) {
  const split = splitClaimCost({ totalCostCents, copayCents: 1000, accumulator: accumulator(paid) });
  return {
    covered: true, drugName: 'ALLOPURINOL', ndcHash: '1111', nadacPerUnit: 0.0394, pricingUnit: 'EA', quantity: 30, tierLevel: 1,
    ingredientCostCents: totalCostCents - 1300, dispensingFeeCents: 1300, dispensingFeeSource: 'plan', totalCostCents,
    copayAmountCents: 1000, copayBasis: 'plan', phase: split.phase, memberPayCents: split.patientPayCents, employerPayCents: split.planPayCents,
    priorAuthRequired: false, stepTherapyRequired: false, maxQuantityPerFill: 90,
  };
}

describe('the Plan Pays tile says what the plan pays', () => {
  test('in the deductible phase, with the whole fill hers, it says the plan pays nothing yet', () => {
    const q = quote(1418, {});                                         // the walkthrough's fill: $14.18, deductible not met
    expect([q.phase, q.memberPayCents, q.employerPayCents]).toEqual(['deductible', 1418, 0]);
    const tile = planTile(card(q));
    expect(tile).toEqual({ amount: '$0.00', line: 'Deductible phase: the plan pays nothing yet' });   // before: Plan covers remainder
  });

  test.each([
    ['a fill that finishes the deductible', 7159750, { deductiblePaidCents: 2000 }, 'deductible', 'The rest, after the deductible and the copay'],
    ['the copay phase, the total over the copay', 1418, { deductiblePaidCents: 50000 }, 'copay', 'The rest, after the copay'],
    ['the copay phase, the total within the copay', 800, { deductiblePaidCents: 50000 }, 'copay', 'Total within the copay: the plan pays nothing'],
    ['the out-of-pocket max met before the fill', 1418, { deductiblePaidCents: 50000, oopPaidCents: 780000 }, 'oop-max-reached', 'Out-of-pocket max reached: the plan pays it all'],
    ['the out-of-pocket max reached by the fill', 1418, { deductiblePaidCents: 50000, oopPaidCents: 779700 }, 'oop-max-reached', 'The rest, past the out-of-pocket max'],
    ['the annual benefit max used up', 1418, { deductiblePaidCents: 50000, annualBenefitUsedCents: 10000000 }, 'benefit-max-reached', 'Annual benefit max reached: the plan pays nothing more'],
    ['the annual benefit max nearly used', 1418, { deductiblePaidCents: 50000, annualBenefitUsedCents: 9999800 }, 'benefit-max-reached', 'What is left of the annual benefit max'],
  ])('%s', (_case, total, paid, phase, line) => {
    const q = quote(total as number, paid as Partial<AccumulatorAmounts>);
    expect(q.phase).toBe(phase);
    expect(planTile(card(q)).line).toBe(line);                        // before: Plan covers remainder, whatever the split
  });

  test('the plan never "covers the remainder" of a fill it pays nothing of', () => {
    for (const paid of [{}, { deductiblePaidCents: 50000, annualBenefitUsedCents: 10000000 }]) {
      const q = quote(1418, paid);
      expect(q.employerPayCents).toBe(0);
      expect(card(q)).not.toContain('covers remainder');
    }
  });

  test('the line reaches the card through esc', () => {
    const marked = (s: unknown) => '[' + escHtml(s) + ']';
    expect(planTile(card(quote(1418, {}), marked)).line).toBe('[Deductible phase: the plan pays nothing yet]');
  });
});
