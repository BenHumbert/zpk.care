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
import { hashString, centsToField, codeToField, quantityToField } from '../zkp/hash-utils.js';

/**
 * Tier Level Constants — formulary drug tiers.
 *
 * Standard pharmacy benefit tiers:
 *   TIER_GENERIC        — lowest copay (generic medications)
 *   TIER_PREFERRED       — preferred brand-name medications
 *   TIER_NON_PREFERRED   — non-preferred brand-name medications
 *   TIER_SPECIALTY       — specialty medications (highest copay)
 */
export const TIER_GENERIC = Field(1);
export const TIER_PREFERRED = Field(2);
export const TIER_NON_PREFERRED = Field(3);
export const TIER_SPECIALTY = Field(4);

/**
 * FormularyEntry — a single medication's coverage rules in the formulary.
 *
 * Each FormularyEntry is a leaf in the formulary Merkle tree.
 * The formulary tree root is stored in EligibilityData.formularyRoot.
 *
 * No PHI/PII — only NDC hashes, tier codes, and numeric limits.
 */
export class FormularyEntry extends Struct({
  /** Poseidon hash of NDC code (medication identity) */
  ndcHash: Field,
  /** Tier level: 1=Generic, 2=Preferred, 3=NonPreferred, 4=Specialty */
  tierLevel: Field,
  /** Medication-specific copay in cents */
  copayAmountCents: Field,
  /** Field(1) if prior authorization required, Field(0) if not */
  requiresPriorAuth: Field,
  /** Max quantity per fill (scaled x1000 via quantityToField) */
  maxQuantityPerFill: Field,
  /** Max days supply per fill */
  maxDaySupply: Field,
  /** Field(1) if step therapy required, Field(0) if not */
  stepTherapyRequired: Field,
}) {
  /**
   * Produces a single commitment representing this formulary entry.
   * Stored as a Merkle leaf in the formulary tree.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.ndcHash,
      this.tierLevel,
      this.copayAmountCents,
      this.requiresPriorAuth,
      this.maxQuantityPerFill,
      this.maxDaySupply,
      this.stepTherapyRequired,
    ]);
  }
}

/**
 * Raw formulary entry data from the insurer's system.
 */
export interface FormularyEntryLocalData {
  /** NDC code (e.g., "00071015523") */
  ndc: string;
  /** Tier level (1-4) */
  tierLevel: number;
  /** Copay amount in cents */
  copayAmount: number;
  /** Whether prior authorization is required */
  requiresPriorAuth: boolean;
  /** Max quantity per fill (will be scaled x1000) */
  maxQuantityPerFill: number;
  /** Max days supply per fill */
  maxDaySupply: number;
  /** Whether step therapy is required */
  stepTherapyRequired: boolean;
}

/**
 * Build a FormularyEntry from raw local data.
 */
export function buildFormularyEntry(local: FormularyEntryLocalData): FormularyEntry {
  return new FormularyEntry({
    ndcHash: hashString(local.ndc),
    tierLevel: codeToField(local.tierLevel),
    copayAmountCents: centsToField(local.copayAmount),
    requiresPriorAuth: local.requiresPriorAuth ? Field(1) : Field(0),
    maxQuantityPerFill: quantityToField(local.maxQuantityPerFill),
    maxDaySupply: Field(BigInt(local.maxDaySupply)),
    stepTherapyRequired: local.stepTherapyRequired ? Field(1) : Field(0),
  });
}
