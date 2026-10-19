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
 * NADAC pricing: a fill costs NADAC x quantity plus the plan's dispensing fee (owner decision 2026-10-18).
 *
 * What was wrong: the ingredient cost and the fee came from whoever dispensed. The engine filled in AWP x quantity and
 * a $2.00 fee only when a value was missing, the dashboard sent $0 + $13.00, the estimate added $3.00 and rounded a
 * float, and nothing checked any of it against a price list.
 *
 * Now one module prices every fill: NADAC held exactly in $0.00001, quantity in thousandths, rounded half up to the
 * cent in integers; the fee is the plan's, or a $10.00 network default; a quote taken once stays fixed (the B3 lock);
 * and a cost the pharmacy states must equal the engine's or is refused.
 *
 * Pure TypeScript, no o1js, runs in about a second.
 */
import fs from 'fs';
import {
  NETWORK_DEFAULT_DISPENSING_FEE_CENTS,
  MAX_DISPENSING_FEE_CENTS,
  nadacUnitPriceE5,
  nadacIngredientCents,
  dispensingFeeError,
  dispensingFeeOf,
  quoteNadacPrice,
  priceDispense,
  formatNadacUnitPrice,
  formatFillPrice,
  statedCostMismatch,
} from '../src/fulfillment/nadac-pricing.js';

const ABACAVIR = { ndc: '00378410591', nadacPerUnit: 0.60042, pricingUnit: 'EA', nadacEffectiveDate: '12/18/2024' };

test('the network default fee is $10.00 and a plan may set up to $100.00', () => {
  expect(NETWORK_DEFAULT_DISPENSING_FEE_CENTS).toBe(1000);
  expect(MAX_DISPENSING_FEE_CENTS).toBe(10_000);
});

test('NADAC unit price is held exactly in $0.00001', () => {
  expect(nadacUnitPriceE5(0.60042)).toBe(60042);
  expect(nadacUnitPriceE5(23.69832)).toBe(2369832);
  expect(nadacUnitPriceE5(0.00145)).toBe(145);
  for (const bad of [undefined, NaN, -0.01, '0.6']) expect(() => nadacUnitPriceE5(bad)).toThrow(/no usable NADAC price/);
});

test('ingredient is NADAC x quantity rounded half up, in integers', () => {
  expect(nadacIngredientCents(60042, 30)).toBe(1801);
  expect(nadacIngredientCents(2369832, 30)).toBe(71095);
  expect(nadacIngredientCents(76504, 30)).toBe(2295);
  expect(nadacIngredientCents(81693, 30)).toBe(2451);
  expect(nadacIngredientCents(36315, 30)).toBe(1089);
  expect(nadacIngredientCents(90511, 30)).toBe(2715);
  expect(nadacIngredientCents(1868756, 30)).toBe(56063);   // ABILIFY 10 MG, the harness's tier-2 drug
  // a half cent rounds up, just under it rounds down
  expect(nadacIngredientCents(50, 10)).toBe(1);
  expect(nadacIngredientCents(49, 10)).toBe(0);
  // a fractional quantity, in thousandths
  expect(nadacIngredientCents(100000, 2.5)).toBe(250);
  for (const q of [0, -1, NaN]) expect(() => nadacIngredientCents(60042, q)).toThrow(/quantity must be positive/);
});

test('matches exact decimal arithmetic for every drug in src/data/formulary.json at 1, 7, 30 and 90 units', () => {
  const records = JSON.parse(fs.readFileSync('src/data/formulary.json', 'utf8')) as Array<{ nadacPerUnit: number }>;
  expect(records.length).toBe(32_768);
  /** The published decimal, read digit by digit into $0.00001: no float arithmetic at all. */
  const exactE5 = (x: number): bigint => {
    const s = String(x);
    expect(s).toMatch(/^\d+(\.\d{1,5})?$/);
    const [whole, frac = ''] = s.split('.');
    return BigInt(whole) * 100_000n + BigInt(frac.padEnd(5, '0'));
  };
  let differences = 0;
  for (const r of records) {
    const e5 = exactE5(r.nadacPerUnit);
    for (const q of [1, 7, 30, 90]) {
      const exact = (e5 * BigInt(q) + 500n) / 1000n;
      if (BigInt(nadacIngredientCents(nadacUnitPriceE5(r.nadacPerUnit), q)) !== exact) differences++;
    }
  }
  expect(differences).toBe(0);
});

test('the fee is the plan\'s when set, 0 included, otherwise the network default', () => {
  for (const plan of [undefined, null, {}, { dispensingFeeCents: null }]) {
    expect(dispensingFeeOf(plan)).toEqual({ dispensingFeeCents: 1000, dispensingFeeSource: 'network-default' });
  }
  expect(dispensingFeeOf({ dispensingFeeCents: 0 })).toEqual({ dispensingFeeCents: 0, dispensingFeeSource: 'plan' });
  expect(dispensingFeeOf({ dispensingFeeCents: 1250 })).toEqual({ dispensingFeeCents: 1250, dispensingFeeSource: 'plan' });
  for (const fee of [-1, 12.5, '1250', 10001]) {
    expect(() => dispensingFeeOf({ dispensingFeeCents: fee as unknown as number })).toThrow(/cannot be priced/);
  }
  for (const ok of [undefined, null, 0, 10000]) expect(dispensingFeeError(ok)).toBeNull();
  for (const bad of [-1, 12.5, '1250', 10001, NaN]) expect(dispensingFeeError(bad)).toMatch(/dispensingFeeCents must be whole cents from 0 to 10000/);
});

test('quote then price', () => {
  expect(priceDispense(quoteNadacPrice(ABACAVIR, { dispensingFeeCents: 1250 }), 30)).toEqual({
    basis: 'NADAC', ndc: '00378410591', nadacUnitPriceE5: 60042, pricingUnit: 'EA', nadacEffectiveDate: '12/18/2024',
    dispensingFeeCents: 1250, dispensingFeeSource: 'plan', quantity: 30, ingredientCostCents: 1801, totalCostCents: 3051,
  });
  expect(priceDispense(quoteNadacPrice(ABACAVIR, null), 30).totalCostCents).toBe(2801);
});

test('a drug with no NADAC price or no pricing unit cannot be priced', () => {
  expect(() => quoteNadacPrice({ ndc: '1', pricingUnit: 'EA' }, null)).toThrow(/no usable NADAC price/);
  expect(() => quoteNadacPrice({ ndc: '1', nadacPerUnit: 0.5 }, null)).toThrow(/no NADAC pricing unit/);
  expect(() => quoteNadacPrice({ ndc: '1', nadacPerUnit: 0.5, pricingUnit: ' ' }, null)).toThrow(/no NADAC pricing unit/);
});

test('a quote stays fixed once taken (the B3 lock)', () => {
  const plan = { dispensingFeeCents: 1250 };
  const quote = quoteNadacPrice(ABACAVIR, plan);
  plan.dispensingFeeCents = 9999;
  expect(priceDispense(quote, 30).dispensingFeeCents).toBe(1250);
});

test('stated costs: absent or equal pass, anything else is refused', () => {
  const p = priceDispense(quoteNadacPrice(ABACAVIR, { dispensingFeeCents: 1250 }), 30);
  expect(statedCostMismatch(p, {})).toBeNull();
  expect(statedCostMismatch(p, { ingredientCostCents: 1801, dispensingFeeCents: 1250 })).toBeNull();
  const zero = statedCostMismatch(p, { ingredientCostCents: 0 });
  expect(zero).toMatch(/does not set the price/);
  expect(zero).toContain('$18.01');
  expect(zero).toContain('$12.50 (plan)');
  expect(statedCostMismatch(p, { dispensingFeeCents: 1300 })).toMatch(/does not set the price/);
  expect(statedCostMismatch(p, { ingredientCostCents: '1801' })).toMatch(/does not set the price/);   // a numeric string is refused, never added
});

test('formatting', () => {
  expect(formatNadacUnitPrice(60042)).toBe('$0.60042');
  expect(formatNadacUnitPrice(2369832)).toBe('$23.69832');
  expect(formatNadacUnitPrice(145)).toBe('$0.00145');
  expect(formatFillPrice(priceDispense(quoteNadacPrice(ABACAVIR, { dispensingFeeCents: 1250 }), 30)))
    .toBe('NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $12.50 (plan) = $30.51');
  expect(formatFillPrice(priceDispense(quoteNadacPrice(ABACAVIR, null), 30)))
    .toBe('NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $10.00 (network default) = $28.01');
});
