import {
  AccessControlProgram,
  AccessControlProof,
} from './access-control-program.js';

/**
 * Result of verifying an access control proof.
 */
export interface AccessVerificationResult {
  /** Whether the proof is valid */
  isValid: boolean;
  /** Reason for failure (if invalid) */
  reason?: string;
  /** NDC hash of the medication (if valid) */
  medicationHash?: string;
  /** Tier level (if valid) */
  tierLevel?: string;
  /** Copay amount in cents (if valid) */
  copayAmount?: string;
  /** Whether PA is required (if valid) */
  priorAuthRequired?: boolean;
}

/**
 * Combined access check result.
 */
export interface FullAccessCheckResult {
  /** Whether the formulary access proof is valid */
  formularyAccessValid: boolean;
  /** Whether the prior auth proof is valid (undefined if not checked) */
  priorAuthValid: boolean | undefined;
  /** Whether PA is needed based on formulary */
  priorAuthNeeded: boolean;
  /** Overall result — all required checks passed */
  overallValid: boolean;
  /** Detail messages for each check */
  details: string[];
}

/**
 * AccessVerificationService — pharmacy-side point-of-care verification.
 *
 * Verifies formulary access and prior auth proofs OFFLINE.
 * The pharmacy needs only the verification keys (stored on device).
 *
 * Preconditions: AccessControlProgram must be compiled.
 */
export class AccessVerificationService {
  /**
   * Verify a formulary access proof.
   *
   * Checks that the medication is on the formulary and quantity limits
   * are satisfied. Returns tier/copay information for the pharmacy POS.
   */
  async verifyFormularyAccess(
    proof: InstanceType<typeof AccessControlProof>,
  ): Promise<AccessVerificationResult> {
    try {
      const ok = await AccessControlProgram.verify(proof);
      if (!ok) {
        return {
          isValid: false,
          reason: 'Formulary access proof verification failed',
        };
      }

      const output = proof.publicOutput;
      return {
        isValid: true,
        medicationHash: output.medicationHash.toString(),
        tierLevel: output.tierLevel.toString(),
        copayAmount: output.copayAmount.toString(),
        priorAuthRequired: output.priorAuthRequired.toString() === '1',
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify a prior auth proof.
   *
   * Checks that a valid prior authorization exists for the medication.
   */
  async verifyPriorAuth(
    proof: InstanceType<typeof AccessControlProof>,
  ): Promise<AccessVerificationResult> {
    try {
      const ok = await AccessControlProgram.verify(proof);
      if (!ok) {
        return {
          isValid: false,
          reason: 'Prior auth proof verification failed',
        };
      }

      const output = proof.publicOutput;
      return {
        isValid: true,
        medicationHash: output.medicationHash.toString(),
        tierLevel: output.tierLevel.toString(),
        copayAmount: output.copayAmount.toString(),
        priorAuthRequired: true,
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Full access check — verifies formulary + optional PA proof.
   *
   * If the formulary proof indicates PA is required, a PA proof
   * must also be provided for the overall check to pass.
   */
  async fullAccessCheck(
    formularyProof: InstanceType<typeof AccessControlProof>,
    priorAuthProof?: InstanceType<typeof AccessControlProof>,
  ): Promise<FullAccessCheckResult> {
    const details: string[] = [];

    // 1. Verify formulary access
    const formResult = await this.verifyFormularyAccess(formularyProof);
    details.push(
      formResult.isValid
        ? `Formulary: verified (tier ${formResult.tierLevel}, copay ${formResult.copayAmount} cents)`
        : `Formulary: FAILED (${formResult.reason})`,
    );

    // 2. Determine if PA is needed
    const priorAuthNeeded = formResult.priorAuthRequired === true;
    if (priorAuthNeeded) {
      details.push('Prior auth: REQUIRED');
    }

    // 3. Verify PA if provided
    let priorAuthValid: boolean | undefined;
    if (priorAuthProof) {
      const paResult = await this.verifyPriorAuth(priorAuthProof);
      priorAuthValid = paResult.isValid;
      details.push(
        paResult.isValid
          ? 'Prior auth: verified'
          : `Prior auth: FAILED (${paResult.reason})`,
      );
    } else if (priorAuthNeeded) {
      details.push('Prior auth: MISSING (required but not provided)');
    }

    // 4. Overall: formulary valid AND (PA not needed OR PA valid)
    const overallValid =
      formResult.isValid &&
      (!priorAuthNeeded || priorAuthValid === true);

    return {
      formularyAccessValid: formResult.isValid,
      priorAuthValid,
      priorAuthNeeded,
      overallValid,
      details,
    };
  }
}
