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

import { Field } from 'o1js';
import { EligibilityData, buildEligibilityData } from '../eligibility/eligibility-data.js';
import { AccumulatorData, buildAccumulatorData } from '../access-control/accumulator-data.js';
import { FormularyEntry, buildFormularyEntry } from '../access-control/formulary-entry.js';
import type { FormularyEntryLocalData } from '../access-control/formulary-entry.js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';
import { ProviderNetworkRegistry } from '../eligibility/provider-network-registry.js';

/**
 * Plan template configuration — the insurer's definition of a benefit plan.
 *
 * Contains all the parameters needed to mint eligibility credentials for members.
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
  /** Family annual deductible in cents (0 = individual only, no family pooling) */
  familyDeductibleAmountCents?: number;
  /** Family out-of-pocket maximum in cents (0 = individual only) */
  familyOopMaxCents?: number;
  /** Family annual benefit maximum in cents (0 = no family limit) */
  familyAnnualBenefitMaxCents?: number;
  /** Medications covered by this plan */
  formularyEntries: FormularyEntryLocalData[];
  /** In-network provider wallet IDs (optional — omit for "all providers accepted") */
  providerWalletIds?: Field[];
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
  readonly networkRegistry: ProviderNetworkRegistry;
  readonly networkRoot: Field;

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

    // Build provider network registry (if provider list is specified)
    this.networkRegistry = new ProviderNetworkRegistry();
    if (config.providerWalletIds) {
      for (const walletId of config.providerWalletIds) {
        this.networkRegistry.addProvider(walletId);
      }
    }
    // Field(0) means "all providers accepted" when no providers specified
    this.networkRoot = config.providerWalletIds && config.providerWalletIds.length > 0
      ? this.networkRegistry.getRoot()
      : Field(0);
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
      networkRoot: this.networkRoot.toString(),
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
