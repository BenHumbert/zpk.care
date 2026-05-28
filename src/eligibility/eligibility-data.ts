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
import { hashString, dateToField, centsToField, codeToField } from '../zkp/hash-utils.js';

/**
 * Coverage Type Constants
 *
 * Each coverage type maps to a healthcare benefit category:
 *   PHARMACY — prescription drug coverage
 *   MEDICAL  — medical/hospital coverage
 *   DENTAL   — dental coverage
 */
export const COVERAGE_PHARMACY = Field(1);
export const COVERAGE_MEDICAL = Field(2);
export const COVERAGE_DENTAL = Field(3);

/**
 * EligibilityData — the provable Struct for benefit plan eligibility.
 *
 * Each EligibilityData represents a specific coverage configuration.
 * The commitment is stored as a leaf in:
 *   1. The MerkleForest ACCESS_CONTROL tree (inside a credential's forest)
 *   2. The BenefitPlanRegistry (insurer's master plan list)
 *
 * The commitment links a credential to a specific, auditable benefit plan.
 * No PHI/PII — only hashes, dates-as-numbers, and coverage codes.
 */
export class EligibilityData extends Struct({
  /** Poseidon hash of plan ID (carrier/plan identifier) */
  planIdHash: Field,
  /** Poseidon hash of group/employer ID */
  groupIdHash: Field,
  /** Effective date as numeric CCYYMMDD */
  effectiveDate: Field,
  /** Termination date as numeric CCYYMMDD (Field(0) = no end date) */
  terminationDate: Field,
  /** Copay amount in cents (integer) */
  copayAmountCents: Field,
  /** Coverage type: COVERAGE_PHARMACY, COVERAGE_MEDICAL, COVERAGE_DENTAL */
  coverageType: Field,
  /** Merkle root of covered medications (formulary) */
  formularyRoot: Field,
  /** Merkle root of in-network providers (Field(0) = all providers accepted) */
  networkRoot: Field,
}) {
  /**
   * Produces a single commitment representing this eligibility configuration.
   * Stored as a Merkle leaf in the ACCESS_CONTROL tree and BenefitPlanRegistry.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.planIdHash,
      this.groupIdHash,
      this.effectiveDate,
      this.terminationDate,
      this.copayAmountCents,
      this.coverageType,
      this.formularyRoot,
      this.networkRoot,
    ]);
  }
}

/**
 * Raw eligibility/benefit plan data that lives on the insurer's system.
 * Used to generate EligibilityData commitments.
 */
export interface EligibilityLocalData {
  /** Plan ID string (carrier/plan identifier) */
  planId: string;
  /** Group/employer ID string */
  groupId: string;
  /** Effective date as CCYYMMDD string */
  effectiveDate: string;
  /** Termination date as CCYYMMDD string (empty = no end date) */
  terminationDate: string;
  /** Copay amount in cents */
  copayAmount: number;
  /** Coverage type code (1=pharmacy, 2=medical, 3=dental) */
  coverageType: number;
  /** Formulary Merkle root as string (pre-computed from medication list) */
  formularyRoot: string;
  /** Network Merkle root as string (pre-computed from provider list, "0" = all accepted) */
  networkRoot?: string;
}

/**
 * Build an EligibilityData from raw local data.
 * Hashes string fields, converts dates/amounts to Fields.
 */
export function buildEligibilityData(local: EligibilityLocalData): EligibilityData {
  return new EligibilityData({
    planIdHash: hashString(local.planId),
    groupIdHash: hashString(local.groupId),
    effectiveDate: dateToField(local.effectiveDate),
    terminationDate: local.terminationDate
      ? dateToField(local.terminationDate)
      : Field(0),
    copayAmountCents: centsToField(local.copayAmount),
    coverageType: codeToField(local.coverageType),
    formularyRoot: Field(BigInt(local.formularyRoot)),
    networkRoot: local.networkRoot ? Field(BigInt(local.networkRoot)) : Field(0),
  });
}
