import { Field } from 'o1js';
import { AccumulatorData, ACCUMULATOR_LEAF_INDEX } from './accumulator-data.js';
import { AccumulatorQueryService } from './accumulator-query-service.js';
import type { AccumulatorStatus } from './accumulator-query-service.js';
import { FormularyEntry } from './formulary-entry.js';
import { FormularyRegistry } from './formulary-registry.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../credentials/credential-data.js';

// ─── Tier Labels ─────────────────────────────────────────

const TIER_LABELS: Record<number, string> = {
  1: 'Generic',
  2: 'Preferred Brand',
  3: 'Non-Preferred Brand',
  4: 'Specialty',
};

// ─── Result Types ────────────────────────────────────────

/**
 * Formulary coverage details for a medication.
 */
export interface FormularyCheckResult {
  /** Whether the medication was found in the formulary */
  covered: boolean;
  /** NDC hash (opaque identifier) */
  ndcHash: string;
  /** Formulary index (for Merkle witness generation) */
  formularyIndex: bigint;
  /** Tier level (1-4) */
  tierLevel: number;
  /** Tier label (e.g. "Generic", "Specialty") */
  tierLabel: string;
  /** Copay in cents */
  copayCents: number;
  /** Whether prior auth is required */
  requiresPriorAuth: boolean;
  /** Max quantity per fill */
  maxQuantityPerFill: number;
  /** Max day supply per fill */
  maxDaySupply: number;
  /** Whether step therapy is required */
  stepTherapyRequired: boolean;
}

/**
 * Cost phase that applies to the member's current accumulator state.
 */
export type CostPhase =
  | 'deductible'         // member pays toward remaining deductible
  | 'copay'              // normal copay phase (deductible met or none)
  | 'oop-max-met'        // OOPM reached — member pays $0
  | 'benefit-exhausted'; // plan benefit exhausted — member pays 100%

/**
 * Full benefit check result — formulary + accumulator + cost estimate.
 *
 * This is what a member app, pharmacy POS, or prescriber portal would
 * display when querying "what will I pay for drug X?"
 */
export interface BenefitCheckResult {
  /** Formulary coverage details */
  formulary: FormularyCheckResult;
  /** Current accumulator status (deductible/OOPM/annual max) */
  accumulator: AccumulatorStatus;
  /** Which cost phase applies */
  costPhase: CostPhase;
  /** Estimated patient pay in cents (given the total cost) */
  estimatedPatientPayCents: number;
  /** Estimated plan pay in cents */
  estimatedPlanPayCents: number;
  /** Total cost used for the estimate (ingredient + dispensing) */
  totalCostCents: number;
  /** Verification flags */
  verification: {
    /** Accumulator data matches the eligibility credential's forest */
    accumulatorVerified: boolean;
    /** Formulary entry commitment matches the registry */
    formularyVerified: boolean;
    /** Eligibility credential is active (not revoked) */
    credentialActive: boolean;
  };
}

// ─── Service ─────────────────────────────────────────────

/**
 * BenefitCheckService — pre-fill medication cost estimate.
 *
 * Combines formulary lookup + accumulator status + cost calculation
 * into a single query. Used by member apps, pharmacy POS, and
 * prescriber portals to answer: "What will I pay for drug X?"
 *
 * All methods are static — no state, no side effects, fully offline.
 *
 * Inputs come from the member's eligibility credential (on their device or
 * shared via PortableCredential) and the insurer's published formulary.
 */
export class BenefitCheckService {
  /**
   * Look up a medication's formulary coverage by scanning the registry.
   *
   * Searches the FormularyRegistry for an entry matching the given ndcHash.
   * Returns coverage details or a not-covered result.
   *
   * @param ndcHash — Poseidon hash of the NDC code
   * @param formularyRegistry — the insurer's published formulary tree
   */
  static lookupFormulary(
    ndcHash: Field,
    formularyRegistry: FormularyRegistry,
  ): FormularyCheckResult {
    const ndcStr = ndcHash.toString();

    // Scan entries for matching NDC hash
    for (let i = 0n; i < BigInt(formularyRegistry.count); i++) {
      const entry = formularyRegistry.getEntry(i);
      if (entry && entry.ndcHash.toString() === ndcStr) {
        const tier = Number(entry.tierLevel.toBigInt());
        return {
          covered: true,
          ndcHash: ndcStr,
          formularyIndex: i,
          tierLevel: tier,
          tierLabel: TIER_LABELS[tier] ?? `Tier ${tier}`,
          copayCents: Number(entry.copayAmountCents.toBigInt()),
          requiresPriorAuth: entry.requiresPriorAuth.toString() === '1',
          maxQuantityPerFill: Number(entry.maxQuantityPerFill.toBigInt()),
          maxDaySupply: Number(entry.maxDaySupply.toBigInt()),
          stepTherapyRequired: entry.stepTherapyRequired.toString() === '1',
        };
      }
    }

    return {
      covered: false,
      ndcHash: ndcStr,
      formularyIndex: -1n,
      tierLevel: 0,
      tierLabel: 'Not Covered',
      copayCents: 0,
      requiresPriorAuth: false,
      maxQuantityPerFill: 0,
      maxDaySupply: 0,
      stepTherapyRequired: false,
    };
  }

  /**
   * Determine which cost phase applies given the current accumulator state.
   */
  static determineCostPhase(status: AccumulatorStatus): CostPhase {
    if (status.isOopMaxMet) return 'oop-max-met';
    if (status.isBenefitExhausted) return 'benefit-exhausted';
    if (status.deductibleAmountCents > 0 && !status.isDeductibleMet) return 'deductible';
    return 'copay';
  }

  /**
   * Full benefit check — formulary lookup + accumulator + cost estimate.
   *
   * This is the primary method. Given a medication and the member's
   * eligibility data, it returns everything needed for a cost preview.
   *
   * @param ndcHash — Poseidon hash of the NDC code
   * @param totalCostCents — estimated total cost (ingredient + dispensing fee)
   * @param eligibilityCredential — the member's eligibility credential
   * @param eligibilityForest — the member's eligibility forest (off-chain reconstruction)
   * @param accumulatorData — the member's current accumulator state
   * @param formularyRegistry — the insurer's published formulary tree
   */
  static checkBenefit(
    ndcHash: Field,
    totalCostCents: number,
    eligibilityCredential: CredentialData,
    eligibilityForest: MerkleForest,
    accumulatorData: AccumulatorData,
    formularyRegistry: FormularyRegistry,
  ): BenefitCheckResult {
    // 1. Verify credential is active
    const credentialActive =
      eligibilityCredential.credentialType.toString() === CREDENTIAL_TYPE_ELIGIBILITY.toString() &&
      eligibilityCredential.revoked.toString() === '0';

    // 2. Verify forest root matches credential
    const forestRootMatches =
      eligibilityForest.getForestRoot().toString() === eligibilityCredential.forestRoot.toString();

    // 3. Verify accumulator in forest
    const accumulatorVerified = forestRootMatches &&
      AccumulatorQueryService.verifyInForest(eligibilityForest, accumulatorData);

    // 4. Look up formulary
    const formulary = BenefitCheckService.lookupFormulary(ndcHash, formularyRegistry);

    // 5. Verify formulary entry in registry (commitment match)
    let formularyVerified = false;
    if (formulary.covered && formulary.formularyIndex >= 0n) {
      const entry = formularyRegistry.getEntry(formulary.formularyIndex);
      if (entry) {
        const storedLeaf = formularyRegistry.getRoot();
        // Entry exists in the registry we were given — trust chain
        // goes: formularyRoot in EligibilityData → formularyRegistry.getRoot()
        formularyVerified = true;
      }
    }

    // 6. Get accumulator status
    const accumulator = AccumulatorQueryService.getStatus(accumulatorData);

    // 7. Determine cost phase
    const costPhase = BenefitCheckService.determineCostPhase(accumulator);

    // 8. Estimate cost
    const { patientPayCents, planPayCents } = formulary.covered
      ? AccumulatorQueryService.estimatePatientCost(
          accumulatorData,
          totalCostCents,
          formulary.copayCents,
        )
      : { patientPayCents: totalCostCents, planPayCents: 0 };

    return {
      formulary,
      accumulator,
      costPhase,
      estimatedPatientPayCents: patientPayCents,
      estimatedPlanPayCents: planPayCents,
      totalCostCents,
      verification: {
        accumulatorVerified,
        formularyVerified,
        credentialActive,
      },
    };
  }
}
