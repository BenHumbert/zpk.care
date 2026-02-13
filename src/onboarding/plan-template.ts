import { Field } from 'o1js';
import { EligibilityData, buildEligibilityData } from '../eligibility/eligibility-data.js';
import { AccumulatorData, buildAccumulatorData } from '../access-control/accumulator-data.js';
import { FormularyEntry, buildFormularyEntry } from '../access-control/formulary-entry.js';
import type { FormularyEntryLocalData } from '../access-control/formulary-entry.js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';

/**
 * Plan template configuration — the insurer's definition of a benefit plan.
 *
 * Contains all the parameters needed to mint eligibility NFTs for members.
 * One PlanTemplate serves N members in the same plan (same copay, deductible, etc.).
 */
export interface PlanTemplateConfig {
  /** Plan identifier (e.g., "PLAN-GOLD-2026") */
  planId: string;
  /** Default copay amount in cents */
  copayAmountCents: number;
  /** Coverage type code (1=pharmacy, 2=medical, 3=dental) */
  coverageType: number;
  /** Annual deductible in cents (0 = no deductible) */
  deductibleAmountCents: number;
  /** Out-of-pocket maximum in cents (0 = no OOPM) */
  oopMaxCents: number;
  /** Annual benefit maximum in cents (0 = no limit) */
  annualBenefitMaxCents: number;
  /** Medications covered by this plan */
  formularyEntries: FormularyEntryLocalData[];
}

/**
 * PlanTemplate — reusable benefit plan factory.
 *
 * Encapsulates the insurer's plan definition and produces:
 *   - EligibilityData (for ACCESS_CONTROL tree leaf 0)
 *   - AccumulatorData (for ACCESS_CONTROL tree leaf 127)
 *   - FormularyRegistry (standalone tree, root in EligibilityData.formularyRoot)
 *
 * Usage:
 *   const gold = new PlanTemplate({ planId: "GOLD", copay: 3000, ... });
 *   const eligData = gold.buildEligibilityData("ACME-CORP", "20260101", "20261231");
 *   const accData = gold.buildAccumulatorData("20260101");
 */
export class PlanTemplate {
  readonly config: PlanTemplateConfig;
  readonly formularyRegistry: FormularyRegistry;
  readonly formularyRoot: Field;
  readonly formularyEntries: FormularyEntry[];

  constructor(config: PlanTemplateConfig) {
    this.config = config;
    this.formularyRegistry = new FormularyRegistry();
    this.formularyEntries = [];

    for (const entryLocal of config.formularyEntries) {
      const entry = buildFormularyEntry(entryLocal);
      this.formularyEntries.push(entry);
      this.formularyRegistry.addEntry(entry);
    }

    this.formularyRoot = this.formularyRegistry.getRoot();
  }

  /**
   * Build EligibilityData for a specific group and date range.
   *
   * The planId and copay come from the template config.
   * The groupId and dates are per-enrollment.
   */
  buildEligibilityData(
    groupId: string,
    effectiveDate: string,
    terminationDate: string,
  ): EligibilityData {
    return buildEligibilityData({
      planId: this.config.planId,
      groupId,
      effectiveDate,
      terminationDate,
      copayAmount: this.config.copayAmountCents,
      coverageType: this.config.coverageType,
      formularyRoot: this.formularyRoot.toString(),
    });
  }

  /**
   * Build fresh AccumulatorData for a new plan year.
   *
   * All running totals start at zero. The limits come from the template config.
   *
   * @param planYear — plan year start as CCYY0101 string (e.g., "20260101")
   */
  buildAccumulatorData(planYear: string): AccumulatorData {
    return buildAccumulatorData({
      planYear,
      deductibleAmountCents: this.config.deductibleAmountCents,
      deductiblePaidCents: 0,
      oopMaxCents: this.config.oopMaxCents,
      oopPaidCents: 0,
      annualBenefitMaxCents: this.config.annualBenefitMaxCents,
      annualBenefitUsedCents: 0,
    });
  }
}
