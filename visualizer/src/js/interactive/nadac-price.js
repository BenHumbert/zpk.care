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
 * NADAC prices on the operator console, computed the way the engine prices a fill (src/fulfillment/nadac-pricing.ts
 * is the source of truth, and tests/console-nadac-preview.test.ts holds the two to the same results): the ingredient
 * is NADAC per pricing unit (EA, ML or GM) times the quantity, rounded half up to the cent in exact integer arithmetic.
 *
 * Before a fill the console shows only that ingredient, as a preview. The dispensing fee is the member's plan fee,
 * which the engine looks up and adds at the fill; after the fill the console shows the engine's own numbers.
 *
 * Quantities are in the drug's pricing unit to thousandths, as the engine takes them (quantityError in
 * nadac-pricing.ts): a 40 MG/0.4 ML pen is 0.4 ML. The console parses and subtracts them in exact thousandths.
 */

/** A quantity typed in the drug's pricing unit: greater than 0 with at most three decimals, or NaN (never rounded). */
export function parseQuantity(text) {
  const s = String(text == null ? '' : text).trim();
  if (!/^(\d+(\.\d{0,3})?|\.\d{1,3})$/.test(s)) return NaN;
  const q = Number(s);
  return q > 0 && q <= 9999999.999 ? q : NaN;
}

/** A quantity in exact thousandths of its unit: 0.4 -> 400. */
export function quantityMilli(q) {
  return Math.round(Number(q) * 1000);
}

/** What is left to dispense, in exact thousandths: 0.3 - 0.1 is 0.2, not 0.19999999999999998. Never below 0. */
export function remainingQuantity(prescribed, dispensed) {
  return Math.max(0, quantityMilli(prescribed || 0) - quantityMilli(dispensed || 0)) / 1000;
}

/** A quantity with the drug's pricing unit: "30 EA", "0.4 ML"; the bare number when the unit is unknown. */
export function formatQuantity(quantity, med) {
  const unit = med && typeof med.pricingUnit === 'string' && med.pricingUnit.trim() !== '' ? med.pricingUnit : '';
  return unit ? quantity + ' ' + unit : String(quantity);
}

const dollars = (cents) => '$' + (cents / 100).toFixed(2);

/** NADAC dollars per unit as whole $0.00001 (0.60042 -> 60042), or null when the drug has no usable NADAC price. */
export function nadacUnitPriceE5(nadacPerUnit) {
  if (typeof nadacPerUnit !== 'number' || !Number.isFinite(nadacPerUnit) || nadacPerUnit < 0) return null;
  const e5 = Math.round(nadacPerUnit * 100000);
  return Number.isSafeInteger(e5) ? e5 : null;
}

/** NADAC x quantity in cents, rounded half up: floor((nadacE5 * quantityMilli + 500000) / 1000000). Null when it cannot be priced. */
export function nadacIngredientCents(nadacPerUnit, quantity) {
  const e5 = nadacUnitPriceE5(nadacPerUnit);
  if (e5 === null || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  const quantityMilli = BigInt(Math.round(quantity * 1000));
  return Number((BigInt(e5) * quantityMilli + BigInt(500000)) / BigInt(1000000));
}

/** A NADAC unit price in whole $0.00001 as published: 60042 -> "$0.60042". */
export function formatNadacE5(e5) {
  const s = String(e5).padStart(6, '0');
  return '$' + s.slice(0, -5) + '.' + s.slice(-5);
}

/** The drug's NADAC price per pricing unit, "$0.60042/EA", or "No NADAC price". */
export function nadacPerUnitLabel(med) {
  const e5 = nadacUnitPriceE5(med && med.nadacPerUnit);
  if (e5 === null) return 'No NADAC price';
  return formatNadacE5(e5) + '/' + ((med && med.pricingUnit) || 'unit');
}

/**
 * The preview of a fill's ingredient cost: { cents, text }, text reading "NADAC $0.60042/EA x 30 EA = $18.01". cents is
 * null, and text says why, when the drug has no NADAC price or pricing unit or the quantity is not positive.
 */
export function nadacIngredientPreview(med, quantity) {
  const e5 = nadacUnitPriceE5(med && med.nadacPerUnit);
  const unit = med && typeof med.pricingUnit === 'string' && med.pricingUnit.trim() !== '' ? med.pricingUnit : null;
  if (e5 === null || unit === null) return { cents: null, text: 'This drug has no NADAC price, so the engine cannot price a fill of it' };
  const cents = nadacIngredientCents(med.nadacPerUnit, quantity);
  if (cents === null) return { cents: null, text: 'Enter a quantity to see the NADAC ingredient cost' };
  return { cents, text: 'NADAC ' + formatNadacE5(e5) + '/' + unit + ' x ' + quantity + ' ' + unit + ' = ' + dollars(cents) };
}

/**
 * The engine's price of a fill (the fill result's adjudication.pricing) as one line, "NADAC $0.60042/EA x 30 = $18.01 +
 * dispensing fee $10.00 (network default) = $28.01", or '' when the result carries no pricing.
 */
export function engineFillPriceLine(pricing) {
  if (!pricing || typeof pricing.nadacUnitPriceE5 !== 'number' || typeof pricing.totalCostCents !== 'number') return '';
  const source = pricing.dispensingFeeSource === 'plan' ? 'plan' : 'network default';
  return 'NADAC ' + formatNadacE5(pricing.nadacUnitPriceE5) + '/' + pricing.pricingUnit + ' x ' + pricing.quantity + ' = ' + dollars(pricing.ingredientCostCents)
    + ' + dispensing fee ' + dollars(pricing.dispensingFeeCents) + ' (' + source + ') = ' + dollars(pricing.totalCostCents);
}
