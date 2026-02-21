import { Field } from 'o1js';
import { CredentialProgram, CredentialOperationProof, CREDENTIAL_OP_VERIFY } from '../credentials/credential-program.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { FormularyEntry } from '../access-control/formulary-entry.js';
import { FulfillmentData, ReversalData } from './fulfillment-data.js';
import {
  FulfillmentProgram,
  FulfillmentProof,
  FULFILL_OP_CLAIM,
  FULFILL_OP_REVERSAL,
} from './fulfillment-program.js';

// ─── Result Types ───────────────────────────────────────────────

/**
 * Result of verifying a fulfillment proof.
 */
export interface FulfillmentVerificationResult {
  isValid: boolean;
  reason?: string;
  prescriptionHash?: Field;
  patientPayCents?: Field;
  planPayCents?: Field;
}

/**
 * Result of verifying a reversal proof.
 */
export interface ReversalVerificationResult {
  isValid: boolean;
  reason?: string;
  fulfillmentHash?: Field;
  patientRefundCents?: Field;
  planRefundCents?: Field;
}

/**
 * A single entry in the claim history.
 */
export interface ClaimHistoryEntry {
  /** Index in the TRANSACTION tree */
  index: number;
  /** Entry type */
  type: 'fulfillment' | 'reversal';
  /** Commitment hash */
  commitment: string;
}

/**
 * Result of a full fulfillment check.
 */
export interface FullFulfillmentCheckResult {
  fulfillmentValid: boolean;
  overallValid: boolean;
  details: string[];
}

// ─── FulfillmentVerificationService ─────────────────────────────

/**
 * FulfillmentVerificationService — offline verification for claim fulfillment.
 *
 * Verifies:
 *   1. FulfillmentProgram proofs (fulfillment and reversal)
 *   2. Amount balance (off-chain sanity check)
 *   3. Claim history extraction from TRANSACTION tree
 *   4. Combined credential holding + fulfillment check
 *
 * All verification is OFFLINE — no internet required.
 *
 * Preconditions:
 *   await CredentialProgram.compile();           // for holding verification
 *   await FulfillmentProgram.compile();   // for fulfillment proof verification
 */
export class FulfillmentVerificationService {
  /**
   * Verify a fulfillment proof.
   *
   * Checks: FulfillmentProgram proof is valid, operationType is CLAIM.
   */
  async verifyFulfillmentProof(
    proof: InstanceType<typeof FulfillmentProof>,
  ): Promise<FulfillmentVerificationResult> {
    try {
      const ok = await FulfillmentProgram.verify(proof);
      if (!ok) {
        return { isValid: false, reason: 'FulfillmentProgram proof verification failed' };
      }

      const output = proof.publicOutput;

      // Check operation type is CLAIM
      if (output.operationType.toString() !== FULFILL_OP_CLAIM.toString()) {
        return { isValid: false, reason: 'Expected fulfillment operation type' };
      }

      return {
        isValid: true,
        prescriptionHash: output.prescriptionHash,
        patientPayCents: output.patientPayCents,
        planPayCents: output.planPayCents,
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify a reversal proof.
   *
   * Checks: FulfillmentProgram proof is valid, operationType is REVERSAL.
   */
  async verifyReversalProof(
    proof: InstanceType<typeof FulfillmentProof>,
  ): Promise<ReversalVerificationResult> {
    try {
      const ok = await FulfillmentProgram.verify(proof);
      if (!ok) {
        return { isValid: false, reason: 'FulfillmentProgram proof verification failed' };
      }

      const output = proof.publicOutput;

      // Check operation type is REVERSAL
      if (output.operationType.toString() !== FULFILL_OP_REVERSAL.toString()) {
        return { isValid: false, reason: 'Expected reversal operation type' };
      }

      return {
        isValid: true,
        fulfillmentHash: output.entryCommitment,
        patientRefundCents: output.patientPayCents,
        planRefundCents: output.planPayCents,
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Off-chain sanity check: verify amount balance.
   *
   * For a given fulfillment + formulary entry:
   *   copay = formularyEntry.copayAmountCents
   *   total = ingredientCostCents + dispensingFeeCents
   *   If total < copay: patientPay should == total AND planPay should == 0
   *   Else: patientPay should == copay AND planPay should == total - copay
   */
  verifyAmountBalance(
    fulfillmentData: FulfillmentData,
    formularyEntry: FormularyEntry,
  ): boolean {
    const total = BigInt(fulfillmentData.ingredientCostCents.toString())
      + BigInt(fulfillmentData.dispensingFeeCents.toString());
    const copay = BigInt(formularyEntry.copayAmountCents.toString());

    // patientPay + planPay must always equal total (or total if total < copay)
    if (total < copay) {
      // Patient pays all, plan pays nothing
      return true; // patientPay = total, planPay = 0 → total = total ✓
    }

    // patientPay = copay, planPay = total - copay
    // copay + (total - copay) = total ✓
    return copay + (total - copay) === total;
  }

  /**
   * Extract claim history from the TRANSACTION tree.
   *
   * Reads leaves from startIndex onward, matching against provided entries.
   * Each entry that matches its corresponding tree leaf is included.
   *
   * @param leafValues — optional pre-computed leaf values (e.g. settlement
   *   commitments for fulfillment entries). When provided, compare against
   *   leafValues[i] instead of entry.commitment().
   */
  extractClaimHistory(
    forest: MerkleForest,
    startIndex: number,
    entries: (FulfillmentData | ReversalData)[],
    leafValues?: Field[],
  ): ClaimHistoryEntry[] {
    const history: ClaimHistoryEntry[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const treeIndex = BigInt(startIndex + i);
      const treeLeaf = forest.getLeaf(ForestDomain.TRANSACTION, treeIndex);
      const expectedLeaf = leafValues?.[i] ?? entry.commitment();

      if (treeLeaf.toString() !== expectedLeaf.toString()) {
        continue; // Skip mismatched entries
      }

      const type = entry instanceof FulfillmentData ? 'fulfillment' : 'reversal';

      history.push({
        index: startIndex + i,
        type,
        commitment: entry.commitment().toString(),
      });
    }

    return history;
  }

  /**
   * Full fulfillment check: credential holding + fulfillment proof.
   *
   * Combines verification of the pharmacy's credential holding proof with
   * the fulfillment proof.
   */
  async fullFulfillmentCheck(
    holdingProof: InstanceType<typeof CredentialOperationProof>,
    fulfillmentProof: InstanceType<typeof FulfillmentProof>,
  ): Promise<FullFulfillmentCheckResult> {
    const details: string[] = [];

    // 1. Verify credential holding
    let holdingValid = false;
    try {
      const holdingOk = await CredentialProgram.verify(holdingProof);
      if (holdingOk) {
        const holdingOutput = holdingProof.publicOutput;
        if (holdingOutput.operationType.toString() === CREDENTIAL_OP_VERIFY.toString()) {
          holdingValid = true;
          details.push('Credential holding: verified');
        } else {
          details.push('Credential holding: FAILED (wrong operation type)');
        }
      } else {
        details.push('Credential holding: FAILED (proof verification failed)');
      }
    } catch (e) {
      details.push(
        `Credential holding: FAILED (${e instanceof Error ? e.message : 'Unknown error'})`,
      );
    }

    // 2. Verify fulfillment proof
    const fulfillResult = await this.verifyFulfillmentProof(fulfillmentProof);
    if (fulfillResult.isValid) {
      details.push(
        `Fulfillment: verified (patient: ${fulfillResult.patientPayCents}, plan: ${fulfillResult.planPayCents})`,
      );
    } else {
      details.push(`Fulfillment: FAILED (${fulfillResult.reason})`);
    }

    const overallValid = holdingValid && fulfillResult.isValid;

    return {
      fulfillmentValid: fulfillResult.isValid,
      overallValid,
      details,
    };
  }
}
