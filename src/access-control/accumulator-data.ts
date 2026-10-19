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

import { Field, Struct, Poseidon } from 'o1js';
import { dateToField, centsToField } from '../zkp/hash-utils.js';

/** Reserved leaf index in the ACCESS_CONTROL tree for accumulator data */
export const ACCUMULATOR_LEAF_INDEX = 127n;

/**
 * AccumulatorData — benefit accumulator tracking for a plan year.
 *
 * Stored at leaf 127 in the ELIGIBILITY credential's ACCESS_CONTROL tree.
 * Updated atomically by AccumulatorFulfillmentProgram on each claim/reversal.
 *
 * Three accumulators:
 *   1. Deductible: patient pays full cost until deductible met
 *   2. Out-of-pocket maximum (OOPM): patient pays $0 after OOPM met
 *   3. Annual benefit maximum: plan stops paying after max reached
 *
 * When all limits are zero, the copay calculation degrades gracefully
 * to the simple formulary copay (same as FulfillmentProgram).
 *
 * No PHI/PII — only plan year and monetary amounts in cents.
 */
export class AccumulatorData extends Struct({
  /** Plan year start as CCYY0101 (e.g., 20260101) */
  planYear: Field,
  /** Annual deductible limit in cents (Field(0) = no deductible) */
  deductibleAmountCents: Field,
  /** Running total paid toward deductible in cents */
  deductiblePaidCents: Field,
  /** Out-of-pocket maximum in cents (Field(0) = no OOPM) */
  oopMaxCents: Field,
  /** Running total out-of-pocket spending in cents */
  oopPaidCents: Field,
  /** Annual benefit maximum (plan pays) in cents (Field(0) = no limit) */
  annualBenefitMaxCents: Field,
  /** Running total plan has paid in cents */
  annualBenefitUsedCents: Field,
}) {
  /**
   * Produces a single commitment representing this accumulator state.
   * Stored as a Merkle leaf in the ACCESS_CONTROL tree at ACCUMULATOR_LEAF_INDEX.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.planYear,
      this.deductibleAmountCents,
      this.deductiblePaidCents,
      this.oopMaxCents,
      this.oopPaidCents,
      this.annualBenefitMaxCents,
      this.annualBenefitUsedCents,
    ]);
  }
}

/**
 * Raw accumulator data from the insurer's system.
 */
export interface AccumulatorLocalData {
  /** Plan year start as CCYY0101 string */
  planYear: string;
  /** Annual deductible in cents (0 = no deductible) */
  deductibleAmountCents: number;
  /** Amount already paid toward deductible in cents */
  deductiblePaidCents: number;
  /** Out-of-pocket maximum in cents (0 = no OOPM) */
  oopMaxCents: number;
  /** Amount already paid out-of-pocket in cents */
  oopPaidCents: number;
  /** Annual benefit maximum in cents (0 = no limit) */
  annualBenefitMaxCents: number;
  /** Amount plan has already paid in cents */
  annualBenefitUsedCents: number;
}

/**
 * Build an AccumulatorData from raw local data.
 */
/**
 * A-35: a new accumulator with the same plan year and limits and new amounts paid. The fill and reversal circuits
 * keep the plan year and limits of the accumulator they are given and change only the three paid totals, so the
 * engine's copy must do the same, or its record stops matching the root the proof committed to.
 */
export function withAmountsPaid(
  acc: AccumulatorData,
  paid: { deductiblePaidCents: number; oopPaidCents: number; annualBenefitUsedCents: number },
): AccumulatorData {
  return new AccumulatorData({
    planYear: acc.planYear,
    deductibleAmountCents: acc.deductibleAmountCents,
    deductiblePaidCents: centsToField(paid.deductiblePaidCents),
    oopMaxCents: acc.oopMaxCents,
    oopPaidCents: centsToField(paid.oopPaidCents),
    annualBenefitMaxCents: acc.annualBenefitMaxCents,
    annualBenefitUsedCents: centsToField(paid.annualBenefitUsedCents),
  });
}

/**
 * The same plan year and amounts paid under new limits: a member moved onto its plan's republished deductible, OOP
 * maximum and annual benefit maximum keeps everything it has paid. A limit lowered below what is already paid is met:
 * the fill circuit compares paid >= limit before it subtracts (accumulator-fulfillment-program.ts, step 16).
 */
export function withLimits(
  acc: AccumulatorData,
  limits: { deductibleAmountCents: number; oopMaxCents: number; annualBenefitMaxCents: number },
): AccumulatorData {
  return new AccumulatorData({
    planYear: acc.planYear,
    deductibleAmountCents: centsToField(limits.deductibleAmountCents),
    deductiblePaidCents: acc.deductiblePaidCents,
    oopMaxCents: centsToField(limits.oopMaxCents),
    oopPaidCents: acc.oopPaidCents,
    annualBenefitMaxCents: centsToField(limits.annualBenefitMaxCents),
    annualBenefitUsedCents: acc.annualBenefitUsedCents,
  });
}

/** A-35: the start of a new plan year: the same limits, nothing paid. */
export function forNewPlanYear(acc: AccumulatorData, planYear: string): AccumulatorData {
  return new AccumulatorData({
    planYear: dateToField(planYear),
    deductibleAmountCents: acc.deductibleAmountCents,
    deductiblePaidCents: Field(0),
    oopMaxCents: acc.oopMaxCents,
    oopPaidCents: Field(0),
    annualBenefitMaxCents: acc.annualBenefitMaxCents,
    annualBenefitUsedCents: Field(0),
  });
}

export function buildAccumulatorData(local: AccumulatorLocalData): AccumulatorData {
  return new AccumulatorData({
    planYear: dateToField(local.planYear),
    deductibleAmountCents: centsToField(local.deductibleAmountCents),
    deductiblePaidCents: centsToField(local.deductiblePaidCents),
    oopMaxCents: centsToField(local.oopMaxCents),
    oopPaidCents: centsToField(local.oopPaidCents),
    annualBenefitMaxCents: centsToField(local.annualBenefitMaxCents),
    annualBenefitUsedCents: centsToField(local.annualBenefitUsedCents),
  });
}
