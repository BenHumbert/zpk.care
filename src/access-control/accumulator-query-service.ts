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
 * status from the ACCESS_CONTROL tree leaf 127 of a member's eligibility NFT.
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
   * Applies the same copay priority logic as AccumulatorFulfillmentProgram:
   *   1. If OOPM is met → patient pays $0
   *   2. If benefit is exhausted → patient pays 100%
   *   3. If in deductible phase → patient pays min(remaining deductible, total)
   *   4. Otherwise → patient pays min(copay, total)
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

    let patientPay: number;

    if (status.isOopMaxMet) {
      // OOPM met — patient pays nothing
      patientPay = 0;
    } else if (status.isBenefitExhausted) {
      // Benefit exhausted — patient pays everything
      patientPay = totalCostCents;
    } else if (status.deductibleAmountCents > 0 && !status.isDeductibleMet) {
      // Deductible phase — patient pays toward remaining deductible
      patientPay = Math.min(status.deductibleRemainingCents, totalCostCents);
    } else {
      // Normal copay phase
      patientPay = Math.min(copayCents, totalCostCents);
    }

    return {
      patientPayCents: patientPay,
      planPayCents: totalCostCents - patientPay,
    };
  }
}
