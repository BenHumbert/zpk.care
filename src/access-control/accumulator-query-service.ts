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

import { AccumulatorData, ACCUMULATOR_LEAF_INDEX } from './accumulator-data.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';

/** A member's accumulator in whole cents: its limits (0 = none) and what has been paid against them. */
export interface AccumulatorAmounts {
  deductibleAmountCents: number;
  deductiblePaidCents: number;
  oopMaxCents: number;
  oopPaidCents: number;
  annualBenefitMaxCents: number;
  annualBenefitUsedCents: number;
}

/** B8: the family's totals before a claim and the plan's family limits (0 = none), the six family inputs of the fill circuit. */
export interface FamilyAmounts {
  deductiblePaidCents: number;
  oopPaidCents: number;
  annualBenefitUsedCents: number;
  familyDeductibleAmountCents: number;
  familyOopMaxCents: number;
  familyAnnualBenefitMaxCents: number;
}

/** The rule that decided the member's share of a claim. */
export type ClaimPhase = 'deductible' | 'copay' | 'oop-max-reached' | 'benefit-max-reached';

/** A claim's split between the member and the plan, with the deductible credit the fill records. */
export interface ClaimSplit {
  patientPayCents: number;
  planPayCents: number;
  /** The part of the patient pay that counts toward the deductible */
  deductibleCreditCents: number;
  /** B8, the circuit's familyRule: 0 none, 1 family OOP max met, 2 family benefit exhausted, 3 patient pay capped at the family OOP remaining, 4 plan pay capped at the family benefit remaining */
  familyRule: 0 | 1 | 2 | 3 | 4;
  /** Out-of-pocket max reached (individual or family, met before the claim or reached by it), else benefit max reached, else deductible, else copay */
  phase: ClaimPhase;
}

/** A member's accumulator as whole cents. */
export function accumulatorAmountsOf(acc: AccumulatorData): AccumulatorAmounts {
  return {
    deductibleAmountCents: Number(acc.deductibleAmountCents.toBigInt()),
    deductiblePaidCents: Number(acc.deductiblePaidCents.toBigInt()),
    oopMaxCents: Number(acc.oopMaxCents.toBigInt()),
    oopPaidCents: Number(acc.oopPaidCents.toBigInt()),
    annualBenefitMaxCents: Number(acc.annualBenefitMaxCents.toBigInt()),
    annualBenefitUsedCents: Number(acc.annualBenefitUsedCents.toBigInt()),
  };
}

const NO_FAMILY: FamilyAmounts = {
  deductiblePaidCents: 0, oopPaidCents: 0, annualBenefitUsedCents: 0,
  familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0,
};

/**
 * How a claim splits between the member and the plan: the fill circuit's own rules (AccumulatorFulfillmentProgram,
 * step 16 and the B8 family rules) in plain integers, in the circuit's order, so a quote made before the script equals
 * what the fill proof will commit to for the same accumulators, total and copay.
 *
 *   deductible phase  a deductible is set and not met: the member pays min(total, deductible remaining), plus the
 *                     copay on what is left of the total
 *   copay             otherwise min(total, copay)
 *   benefit max       the plan's share is capped at the annual benefit remaining; the member pays the rest
 *   OOP max           the member's share is capped at the out-of-pocket remaining
 *   family (B8)       family OOP max met: the member pays 0; family benefit exhausted: the member pays the total;
 *                     else the member's share is capped at the family OOP remaining, then the plan's at the family
 *                     benefit remaining
 *
 * A paid total at or over its limit means that limit is met (a limit lowered below what is paid included), as in the
 * circuit, which compares before it subtracts. The deductible credit is min(patient pay, deductible portion).
 */
export function splitClaimCost(input: {
  totalCostCents: number;
  copayCents: number;
  accumulator: AccumulatorAmounts;
  family?: FamilyAmounts | null;
}): ClaimSplit {
  const total = input.totalCostCents;
  const copay = input.copayCents;
  const a = input.accumulator;
  const f = input.family ?? NO_FAMILY;

  // 16a: the deductible
  const inDeductiblePhase = a.deductibleAmountCents > 0 && a.deductiblePaidCents < a.deductibleAmountCents;
  const remainingDeductible = inDeductiblePhase ? a.deductibleAmountCents - a.deductiblePaidCents : 0;
  const deductiblePay = total < remainingDeductible ? total : remainingDeductible;
  const afterDeductible = total - deductiblePay;

  // 16b: the copay, on what the deductible leaves in the deductible phase
  const copayOnRemainder = afterDeductible < copay ? afterDeductible : copay;
  const normalPay = total < copay ? total : copay;
  const basePay = inDeductiblePhase ? deductiblePay + copayOnRemainder : normalPay;

  // 16c: the annual benefit maximum caps the plan's share
  const hasBenefitMax = a.annualBenefitMaxCents > 0;
  const benefitExhausted = hasBenefitMax && a.annualBenefitUsedCents >= a.annualBenefitMaxCents;
  const basePlanPay = total - basePay;
  const remainingBenefit = benefitExhausted ? 0 : hasBenefitMax ? a.annualBenefitMaxCents - a.annualBenefitUsedCents : basePlanPay;
  const benefitCapApplies = hasBenefitMax && basePlanPay > remainingBenefit;
  const postBenefitPay = total - (benefitCapApplies ? remainingBenefit : basePlanPay);

  // 16d: the out-of-pocket maximum caps the member's share
  const hasOopMax = a.oopMaxCents > 0;
  const oopMet = hasOopMax && a.oopPaidCents >= a.oopMaxCents;
  const remainingOop = oopMet ? 0 : hasOopMax ? a.oopMaxCents - a.oopPaidCents : postBenefitPay;
  const oopCapApplies = hasOopMax && postBenefitPay > remainingOop;
  const individualPatientPay = oopCapApplies ? remainingOop : postBenefitPay;
  const individualPlanPay = total - individualPatientPay;

  // B8: family pooling, from the family's totals before this claim and the plan's family limits
  const hasFamilyOopMax = f.familyOopMaxCents > 0;
  const familyOopMet = hasFamilyOopMax && f.oopPaidCents >= f.familyOopMaxCents;
  const hasFamilyBenefitMax = f.familyAnnualBenefitMaxCents > 0;
  const familyBenefitExhausted = hasFamilyBenefitMax && f.annualBenefitUsedCents >= f.familyAnnualBenefitMaxCents;
  const familyOopRemaining = familyOopMet ? 0 : hasFamilyOopMax ? f.familyOopMaxCents - f.oopPaidCents : individualPatientPay;
  const familyOopCapApplies = hasFamilyOopMax && !familyOopMet && individualPatientPay > familyOopRemaining;
  const familyBenefitRemaining = familyBenefitExhausted ? 0 : hasFamilyBenefitMax ? f.familyAnnualBenefitMaxCents - f.annualBenefitUsedCents : individualPlanPay;
  const familyBenefitCapApplies = hasFamilyBenefitMax && !familyBenefitExhausted && individualPlanPay > familyBenefitRemaining;
  const familyRule: ClaimSplit['familyRule'] = familyOopMet ? 1 : familyBenefitExhausted ? 2 : familyOopCapApplies ? 3 : familyBenefitCapApplies ? 4 : 0;
  const patientPay = familyRule === 1 ? 0
    : familyRule === 2 ? total
      : familyRule === 3 ? familyOopRemaining
        : familyRule === 4 ? total - familyBenefitRemaining
          : individualPatientPay;

  // 16e: only the deductible portion counts toward the deductible
  const deductibleCredit = patientPay < deductiblePay ? patientPay : deductiblePay;

  let phase: ClaimPhase;
  if (familyRule === 1 || familyRule === 3 || (familyRule === 0 && (oopMet || oopCapApplies))) phase = 'oop-max-reached';
  else if (familyRule === 2 || familyRule === 4 || (familyRule === 0 && (benefitExhausted || benefitCapApplies))) phase = 'benefit-max-reached';
  else if (inDeductiblePhase) phase = 'deductible';
  else phase = 'copay';

  return { patientPayCents: patientPay, planPayCents: total - patientPay, deductibleCreditCents: deductibleCredit, familyRule, phase };
}

/**
 * Current accumulator status for a member — human-readable metrics.
 *
 * All monetary values are in cents. Remaining values are computed
 * (limit - paid/used). Boolean flags indicate threshold states.
 */
export interface AccumulatorStatus {
  /** Plan year as CCYY0101 string (e.g. "20260101") */
  planYear: string;

  /** Deductible limit in cents (0 = no deductible) */
  deductibleAmountCents: number;
  /** Amount paid toward deductible so far */
  deductiblePaidCents: number;
  /** Remaining deductible before copay phase begins */
  deductibleRemainingCents: number;
  /** True if deductible is fully met */
  isDeductibleMet: boolean;

  /** Out-of-pocket maximum in cents (0 = no OOPM) */
  oopMaxCents: number;
  /** Amount paid out-of-pocket so far */
  oopPaidCents: number;
  /** Remaining before OOPM is met ($0 patient cost after) */
  oopRemainingCents: number;
  /** True if OOPM is met — patient pays $0 on all subsequent claims */
  isOopMaxMet: boolean;

  /** Annual benefit maximum in cents (0 = no limit) */
  annualBenefitMaxCents: number;
  /** Amount plan has paid so far */
  annualBenefitUsedCents: number;
  /** Remaining plan benefit before exhaustion */
  benefitRemainingCents: number;
  /** True if benefit is exhausted — patient pays 100% */
  isBenefitExhausted: boolean;
}

/**
 * AccumulatorQueryService — read-only member benefit accumulator queries.
 *
 * Stateless service that extracts deductible, OOPM, and annual benefit max
 * status from the ACCESS_CONTROL tree leaf 127 of a member's eligibility credential.
 *
 * Used by:
 *   - Member app: "How much deductible do I have left?"
 *   - Pharmacy POS: preview patient cost before filling
 *   - Prescriber portal: check if patient has benefit remaining
 *
 * All methods are static — no constructor, no state, no side effects.
 */
export class AccumulatorQueryService {
  /**
   * Extract human-readable accumulator status from AccumulatorData.
   *
   * Converts on-chain Field values to numeric cents and computes
   * remaining amounts and threshold flags.
   */
  static getStatus(accumulatorData: AccumulatorData): AccumulatorStatus {
    const deductibleAmount = Number(accumulatorData.deductibleAmountCents.toBigInt());
    const deductiblePaid = Number(accumulatorData.deductiblePaidCents.toBigInt());
    const oopMax = Number(accumulatorData.oopMaxCents.toBigInt());
    const oopPaid = Number(accumulatorData.oopPaidCents.toBigInt());
    const benefitMax = Number(accumulatorData.annualBenefitMaxCents.toBigInt());
    const benefitUsed = Number(accumulatorData.annualBenefitUsedCents.toBigInt());

    return {
      planYear: accumulatorData.planYear.toBigInt().toString(),
      deductibleAmountCents: deductibleAmount,
      deductiblePaidCents: deductiblePaid,
      deductibleRemainingCents: Math.max(0, deductibleAmount - deductiblePaid),
      isDeductibleMet: deductibleAmount > 0 && deductiblePaid >= deductibleAmount,
      oopMaxCents: oopMax,
      oopPaidCents: oopPaid,
      oopRemainingCents: Math.max(0, oopMax - oopPaid),
      isOopMaxMet: oopMax > 0 && oopPaid >= oopMax,
      annualBenefitMaxCents: benefitMax,
      annualBenefitUsedCents: benefitUsed,
      benefitRemainingCents: Math.max(0, benefitMax - benefitUsed),
      isBenefitExhausted: benefitMax > 0 && benefitUsed >= benefitMax,
    };
  }

  /**
   * Verify that an AccumulatorData matches what's stored in the forest.
   *
   * Checks that `accumulatorData.commitment()` equals the leaf at
   * ACCUMULATOR_LEAF_INDEX (127) in the ACCESS_CONTROL tree.
   *
   * @returns true if the data matches the forest leaf
   */
  static verifyInForest(
    forest: MerkleForest,
    accumulatorData: AccumulatorData,
  ): boolean {
    const storedLeaf = forest.getLeaf(
      ForestDomain.ACCESS_CONTROL,
      ACCUMULATOR_LEAF_INDEX,
    );
    return accumulatorData.commitment().toString() === storedLeaf.toString();
  }

  /**
   * Estimate patient cost for a claim given current accumulator state.
   *
   * Mirrors AccumulatorFulfillmentProgram copay logic exactly:
   *   1. Deductible phase: patient pays deductible portion + copay on remainder
   *   2. Benefit max: cap plan pay at remaining benefit
   *   3. OOPM: cap patient pay at remaining OOPM
   *   4. Normal: patient pays min(copay, total)
   *
   * @param accumulatorData Current accumulator state
   * @param totalCostCents Total drug cost (ingredient + dispensing fee) in cents
   * @param copayCents Formulary copay in cents
   * @returns Estimated patient pay and plan pay in cents
   */
  static estimatePatientCost(
    accumulatorData: AccumulatorData,
    totalCostCents: number,
    copayCents: number,
  ): { patientPayCents: number; planPayCents: number } {
    // One rule for every quote: splitClaimCost, the fill circuit's step 16 with no family
    const { patientPayCents, planPayCents } = splitClaimCost({
      totalCostCents,
      copayCents,
      accumulator: accumulatorAmountsOf(accumulatorData),
    });
    return { patientPayCents, planPayCents };
  }
}
