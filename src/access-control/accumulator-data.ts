import { Field, Struct, Poseidon } from 'o1js';
import { dateToField, centsToField } from '../zkp/hash-utils.js';

/** Reserved leaf index in the ACCESS_CONTROL tree for accumulator data */
export const ACCUMULATOR_LEAF_INDEX = 127n;

/**
 * AccumulatorData — benefit accumulator tracking for a plan year.
 *
 * Stored at leaf 127 in the ELIGIBILITY NFT's ACCESS_CONTROL tree.
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
