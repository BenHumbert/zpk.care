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
    const status = AccumulatorQueryService.getStatus(accumulatorData);

    // 16a: Deductible phase
    const inDeductiblePhase = status.deductibleAmountCents > 0 && !status.isDeductibleMet;
    const deductiblePay = inDeductiblePhase
      ? Math.min(status.deductibleRemainingCents, totalCostCents)
      : 0;
    const afterDeductible = totalCostCents - deductiblePay;

    // 16b: Copay on post-deductible amount (split payment)
    const copayOnRemainder = Math.min(afterDeductible, copayCents);
    const normalPay = Math.min(copayCents, totalCostCents);
    const basePay = inDeductiblePhase ? deductiblePay + copayOnRemainder : normalPay;

    // 16c: Benefit maximum mid-claim cap
    let basePlanPay = totalCostCents - basePay;
    if (status.annualBenefitMaxCents > 0) {
      const remainingBenefit = Math.max(0, status.benefitRemainingCents);
      if (basePlanPay > remainingBenefit) {
        basePlanPay = remainingBenefit;
      }
    }
    let patientPay = totalCostCents - basePlanPay;

    // 16d: OOPM mid-claim cap
    if (status.oopMaxCents > 0) {
      const remainingOopm = Math.max(0, status.oopRemainingCents);
      if (patientPay > remainingOopm) {
        patientPay = remainingOopm;
      }
    }

    return {
      patientPayCents: patientPay,
      planPayCents: totalCostCents - patientPay,
    };
  }
}
