/**
 * FamilyAccumulatorService — stateless family-level accumulator pooling.
 *
 * Aggregates individual member accumulators into family totals and
 * applies family-level overrides (e.g., family OOPM met → $0 patient pay).
 *
 * Design:
 *   - Service-layer ONLY — no ZK circuit changes
 *   - Individual AccumulatorFulfillmentProgram still proves per-member updates
 *   - This service applies family-level adjustments on top of circuit output
 *   - Stateless: all methods are static (same pattern as ReportingService/AuditService)
 *
 * Family plan defaults (standard 2:1 ratio):
 *   Individual: deductible $500, OOPM $8,000
 *   Family:     deductible $1,000, OOPM $16,000
 */

/**
 * Family accumulator limits — from PlanTemplateConfig.
 */
export interface FamilyLimits {
  /** Family annual deductible in cents (0 = individual only) */
  familyDeductibleAmountCents: number;
  /** Family out-of-pocket maximum in cents (0 = individual only) */
  familyOopMaxCents: number;
  /** Family annual benefit maximum in cents (0 = no family limit) */
  familyAnnualBenefitMaxCents: number;
}

/**
 * Family accumulator totals — sum of all family members' accumulators.
 */
export interface FamilyTotals {
  /** Total deductible paid across all family members (cents) */
  deductiblePaidCents: number;
  /** Total out-of-pocket paid across all family members (cents) */
  oopPaidCents: number;
  /** Total annual benefit used across all family members (cents) */
  annualBenefitUsedCents: number;
  /** Number of family members included in the total */
  memberCount: number;
}

/**
 * Result of family-adjusted payment computation.
 */
export interface FamilyAdjustedPay {
  /** Final patient pay (after family adjustments) in cents */
  patientPayCents: number;
  /** Final plan pay (after family adjustments) in cents */
  planPayCents: number;
  /** Whether family pooling changed the payment */
  familyPoolingApplied: boolean;
  /** Reason for the adjustment (if applied) */
  reason: string;
}

/**
 * Individual member accumulator snapshot (simplified for aggregation).
 */
export interface MemberAccumulator {
  deductiblePaidCents: number;
  oopPaidCents: number;
  annualBenefitUsedCents: number;
}

export class FamilyAccumulatorService {
  /**
   * Sum accumulators across all family members.
   */
  static getFamilyTotals(familyMembers: MemberAccumulator[]): FamilyTotals {
    let deductiblePaidCents = 0;
    let oopPaidCents = 0;
    let annualBenefitUsedCents = 0;

    for (const m of familyMembers) {
      deductiblePaidCents += m.deductiblePaidCents;
      oopPaidCents += m.oopPaidCents;
      annualBenefitUsedCents += m.annualBenefitUsedCents;
    }

    return {
      deductiblePaidCents,
      oopPaidCents,
      annualBenefitUsedCents,
      memberCount: familyMembers.length,
    };
  }

  /**
   * Check if the family deductible has been met.
   */
  static isFamilyDeductibleMet(
    totals: FamilyTotals,
    limits: FamilyLimits,
  ): boolean {
    if (limits.familyDeductibleAmountCents <= 0) return false;
    return totals.deductiblePaidCents >= limits.familyDeductibleAmountCents;
  }

  /**
   * Check if the family out-of-pocket maximum has been met.
   */
  static isFamilyOopMaxMet(
    totals: FamilyTotals,
    limits: FamilyLimits,
  ): boolean {
    if (limits.familyOopMaxCents <= 0) return false;
    return totals.oopPaidCents >= limits.familyOopMaxCents;
  }

  /**
   * Check if the family annual benefit maximum has been exhausted.
   */
  static isFamilyBenefitExhausted(
    totals: FamilyTotals,
    limits: FamilyLimits,
  ): boolean {
    if (limits.familyAnnualBenefitMaxCents <= 0) return false;
    return totals.annualBenefitUsedCents >= limits.familyAnnualBenefitMaxCents;
  }

  /**
   * Compute family-adjusted patient/plan pay.
   *
   * Priority (same as individual copay priority):
   *   1. Family OOPM met → patient pays $0
   *   2. Family benefit exhausted → patient pays full cost
   *   3. Family deductible met but individual not → skip deductible phase
   *   4. Otherwise → use individual circuit-computed amounts
   *
   * @param individualPatientPayCents — patient pay from AccumulatorFulfillmentProgram
   * @param totalCostCents — total claim cost
   * @param familyTotals — current family accumulator totals
   * @param familyLimits — family-level limits from plan
   */
  static computeFamilyAdjustedPay(
    individualPatientPayCents: number,
    totalCostCents: number,
    familyTotals: FamilyTotals,
    familyLimits: FamilyLimits,
  ): FamilyAdjustedPay {
    // 1. Family OOPM met → $0 patient pay
    if (this.isFamilyOopMaxMet(familyTotals, familyLimits)) {
      return {
        patientPayCents: 0,
        planPayCents: totalCostCents,
        familyPoolingApplied: true,
        reason: 'Family out-of-pocket maximum met',
      };
    }

    // 2. Family benefit exhausted → patient pays full cost
    if (this.isFamilyBenefitExhausted(familyTotals, familyLimits)) {
      return {
        patientPayCents: totalCostCents,
        planPayCents: 0,
        familyPoolingApplied: true,
        reason: 'Family annual benefit maximum exhausted',
      };
    }

    // 3. Check if family OOPM would be exceeded by this claim
    if (familyLimits.familyOopMaxCents > 0) {
      const newFamilyOop = familyTotals.oopPaidCents + individualPatientPayCents;
      if (newFamilyOop > familyLimits.familyOopMaxCents) {
        // Cap patient pay to reach family OOPM exactly
        const remainingOop = familyLimits.familyOopMaxCents - familyTotals.oopPaidCents;
        const cappedPatientPay = Math.max(0, remainingOop);
        return {
          patientPayCents: cappedPatientPay,
          planPayCents: totalCostCents - cappedPatientPay,
          familyPoolingApplied: true,
          reason: 'Patient pay capped at family out-of-pocket maximum',
        };
      }
    }

    // 3b. M6 fix: Check if family benefit max would be exceeded by this claim
    //     Same partial-claim capping as OOPM: cap plan pay at remaining benefit.
    if (familyLimits.familyAnnualBenefitMaxCents > 0) {
      const individualPlanPay = totalCostCents - individualPatientPayCents;
      const newFamilyBenefit = familyTotals.annualBenefitUsedCents + individualPlanPay;
      if (newFamilyBenefit > familyLimits.familyAnnualBenefitMaxCents) {
        const remainingBenefit = familyLimits.familyAnnualBenefitMaxCents - familyTotals.annualBenefitUsedCents;
        const cappedPlanPay = Math.max(0, remainingBenefit);
        return {
          patientPayCents: totalCostCents - cappedPlanPay,
          planPayCents: cappedPlanPay,
          familyPoolingApplied: true,
          reason: 'Plan pay capped at family annual benefit maximum',
        };
      }
    }

    // 4. No family adjustment needed — use individual amounts
    return {
      patientPayCents: individualPatientPayCents,
      planPayCents: totalCostCents - individualPatientPayCents,
      familyPoolingApplied: false,
      reason: 'Individual accumulator rules applied',
    };
  }
}
