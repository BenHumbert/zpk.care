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
 * NADAC-plus-fee pricing (owner decision 2026-10-18).
 *
 * A fill costs the drug's NADAC price per unit times the quantity dispensed, plus a dispensing fee. The engine
 * computes it; the pharmacy sets neither amount, and costs a request states are only compared with these.
 *
 *   ingredient cents = NADAC x quantity, rounded half up to the cent, in exact integer arithmetic:
 *                      floor((nadacE5 * quantityMilli + 500_000) / 1_000_000), where nadacE5 is NADAC in whole
 *                      $0.00001 (CMS publishes NADAC to 5 decimals, so this is exact) and quantityMilli is the
 *                      quantity in thousandths of NADAC's pricing unit (EA, ML or GM), the scaling quantityToField
 *                      gives the circuits.
 *   dispensing fee   = the plan's dispensingFeeCents, or NETWORK_DEFAULT_DISPENSING_FEE_CENTS when the plan has none.
 *   total            = ingredient + fee.
 *
 * Two steps, so B3 can lock a price at prescribing without changing either: quoteNadacPrice() captures the price list
 * for one drug under one plan, and priceDispense() applies a quote to the quantity dispensed. No o1js here: the
 * sequencer's estimate and the insurer route import this too.
 */

/**
 * The dispensing fee when a plan sets none: $10.00. A pharmacy paid NADAC gets no markup on the drug, so the fee is its
 * whole margin; state Medicaid programs that pay NADAC pair it with a professional fee of about this size or more.
 * A plan sets its own with BenefitPlanConfig.dispensingFeeCents.
 */
export const NETWORK_DEFAULT_DISPENSING_FEE_CENTS = 1000;

/** The largest fee a plan may set, $100.00: a typo guard, since the fee is added to every fill on the plan. */
export const MAX_DISPENSING_FEE_CENTS = 10_000;

/** The price list for one drug under one plan: what B3 will lock on a prescription. */
export interface PriceQuote {
  basis: 'NADAC';
  /** The 11-digit NDC the price is for */
  ndc: string;
  /** NADAC per pricing unit, in whole $0.00001 (0.60042 -> 60042) */
  nadacUnitPriceE5: number;
  /** The unit NADAC is quoted per (EA, ML or GM); the quantity dispensed is counted in it */
  pricingUnit: string;
  /** The NADAC week the price is from, as published (MM/DD/YYYY), when the source carries it */
  nadacEffectiveDate?: string;
  dispensingFeeCents: number;
  dispensingFeeSource: 'plan' | 'network-default';
}

/** A quote applied to the quantity dispensed. */
export interface FillPrice extends PriceQuote {
  quantity: number;
  ingredientCostCents: number;
  totalCostCents: number;
}

/** NADAC dollars per unit as whole $0.00001. A missing, negative or non-finite price throws: no fill is priced at $0 by accident. */
export function nadacUnitPriceE5(nadacPerUnit: unknown): number {
  if (typeof nadacPerUnit !== 'number' || !Number.isFinite(nadacPerUnit) || nadacPerUnit < 0) {
    throw new Error(`This drug has no usable NADAC price (${String(nadacPerUnit)}); the fill cannot be priced`);
  }
  const e5 = Math.round(nadacPerUnit * 100_000);
  if (!Number.isSafeInteger(e5)) throw new Error(`NADAC price out of range: ${nadacPerUnit}`);
  return e5;
}

/** NADAC x quantity in cents, rounded half up, in exact integer arithmetic (see the module comment). */
export function nadacIngredientCents(nadacE5: number, quantity: number): number {
  if (!Number.isSafeInteger(nadacE5) || nadacE5 < 0) throw new Error(`The NADAC price must be whole $0.00001 (got ${nadacE5})`);
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) throw new Error(`The quantity must be positive (got ${quantity})`);
  const quantityMilli = BigInt(Math.round(quantity * 1000));
  const cents = (BigInt(nadacE5) * quantityMilli + 500_000n) / 1_000_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Ingredient cost out of range');
  return Number(cents);
}

const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** Why v cannot be a plan's fee, or null when it can: absent or null (the network default applies), or whole cents from 0 to MAX_DISPENSING_FEE_CENTS. */
export function dispensingFeeError(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_DISPENSING_FEE_CENTS) return null;
  return `dispensingFeeCents must be whole cents from 0 to ${MAX_DISPENSING_FEE_CENTS}, or absent for the network default (got ${show(v)})`;
}

/** The fee a fill on this plan is charged, and where it came from. A stored fee that is not usable throws rather than fall back. */
export function dispensingFeeOf(
  plan: { dispensingFeeCents?: number | null } | null | undefined,
): Pick<PriceQuote, 'dispensingFeeCents' | 'dispensingFeeSource'> {
  const fee = plan?.dispensingFeeCents;
  if (fee === undefined || fee === null) {
    return { dispensingFeeCents: NETWORK_DEFAULT_DISPENSING_FEE_CENTS, dispensingFeeSource: 'network-default' };
  }
  const err = dispensingFeeError(fee);
  if (err) throw new Error(`The plan's ${err}; the fill cannot be priced`);
  return { dispensingFeeCents: fee, dispensingFeeSource: 'plan' };
}

/**
 * The price list for one drug under one plan: the drug's NADAC record and the plan's fee. The drug's NADAC fields are
 * optional on the type (a SeedMedication literal need not carry them) and checked here: a drug with no usable NADAC
 * price or no pricing unit cannot be priced, and throws rather than bill $0.
 */
export function quoteNadacPrice(
  drug: { ndc: string; nadacPerUnit?: unknown; pricingUnit?: string; nadacEffectiveDate?: string },
  plan: { dispensingFeeCents?: number | null } | null | undefined,
): PriceQuote {
  if (typeof drug.pricingUnit !== 'string' || drug.pricingUnit.trim() === '') {
    throw new Error(`Drug ${drug.ndc} has no NADAC pricing unit; the fill cannot be priced`);
  }
  return {
    basis: 'NADAC',
    ndc: drug.ndc,
    nadacUnitPriceE5: nadacUnitPriceE5(drug.nadacPerUnit),
    pricingUnit: drug.pricingUnit,
    ...(drug.nadacEffectiveDate ? { nadacEffectiveDate: drug.nadacEffectiveDate } : {}),
    ...dispensingFeeOf(plan),
  };
}

/** A quote applied to the quantity dispensed. Nothing is re-read, so a quote locked at prescribing (B3) stays fixed. */
export function priceDispense(quote: PriceQuote, quantity: number): FillPrice {
  const ingredientCostCents = nadacIngredientCents(quote.nadacUnitPriceE5, quantity);
  return { ...quote, quantity, ingredientCostCents, totalCostCents: ingredientCostCents + quote.dispensingFeeCents };
}

/** A NADAC unit price as published: 60042 -> "$0.60042". */
export function formatNadacUnitPrice(nadacE5: number): string {
  const s = String(nadacE5).padStart(6, '0');
  return `$${s.slice(0, -5)}.${s.slice(-5)}`;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** "NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $12.50 (plan) = $30.51" */
export function formatFillPrice(p: FillPrice): string {
  return `NADAC ${formatNadacUnitPrice(p.nadacUnitPriceE5)}/${p.pricingUnit} x ${p.quantity} = ${dollars(p.ingredientCostCents)}`
    + ` + dispensing fee ${dollars(p.dispensingFeeCents)} (${p.dispensingFeeSource === 'plan' ? 'plan' : 'network default'})`
    + ` = ${dollars(p.totalCostCents)}`;
}

/**
 * The pharmacy does not set the price. A request may leave the costs out (the normal case) or state them to confirm the
 * price it was shown; stated amounts must equal the engine's exactly, as numbers in whole cents. Returns why the
 * request is refused, or null when it may go on.
 */
export function statedCostMismatch(
  price: FillPrice,
  stated: { ingredientCostCents?: unknown; dispensingFeeCents?: unknown },
): string | null {
  const wrong: string[] = [];
  if (stated.ingredientCostCents != null && stated.ingredientCostCents !== price.ingredientCostCents) wrong.push(`ingredient ${show(stated.ingredientCostCents)}`);
  if (stated.dispensingFeeCents != null && stated.dispensingFeeCents !== price.dispensingFeeCents) wrong.push(`dispensing fee ${show(stated.dispensingFeeCents)}`);
  if (wrong.length === 0) return null;
  return `The pharmacy does not set the price: this fill costs ${formatFillPrice(price)}, and the request stated ${wrong.join(' and ')} (cents). Send no costs, or exactly these.`;
}
