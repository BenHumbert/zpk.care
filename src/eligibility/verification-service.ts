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

import type { PortableCredential } from '../credentials/portable-credential.js';
import { CredentialProgram, CredentialOperationProof } from '../credentials/credential-program.js';
import {
  EligibilityProgram,
  EligibilityProof,
  InNetworkProgram,
  InNetworkProof,
} from './eligibility-program.js';

/**
 * Result of verifying eligibility data.
 */
export interface VerificationResult {
  /** Whether the eligibility proof is valid */
  isValid: boolean;
  /** Reason for failure (if invalid) */
  reason?: string;
  /** Credential commitment (if valid) */
  credentialCommitment?: string;
  /** Coverage type (if valid) */
  coverageType?: string;
}

/**
 * Result of a full point-of-care verification.
 */
export interface FullVerificationResult {
  /** Whether the member holds a valid credential */
  holdingValid: boolean;
  /** Whether the eligibility data is valid */
  eligibilityValid: boolean;
  /** Whether the prescriber is in-network (undefined if not checked) */
  prescriberInNetwork?: boolean;
  /** Whether the pharmacy is in-network (undefined if not checked) */
  pharmacyInNetwork?: boolean;
  /** Overall result — all checks passed */
  overallValid: boolean;
  /** Detail messages for each check */
  details: string[];
}

/**
 * VerificationService — pharmacy-side point-of-care verification.
 *
 * This service verifies the proof chain presented by a member at the pharmacy:
 *
 *   1. CredentialOperationProof — member holds a valid ELIGIBILITY credential (L4)
 *   2. EligibilityProof         — credential contains valid benefit plan data (L5)
 *   3. InNetworkProof           — prescriber/pharmacy is in-network (L5)
 *
 * All verification is OFFLINE — no internet connection required.
 * The pharmacy needs only the verification keys (stored on device).
 *
 * Preconditions: All relevant ZkPrograms must be compiled.
 */
export class VerificationService {
  /**
   * Verify a CredentialOperationProof from a PortableCredential.
   *
   * Checks that the member holds a valid credential in their wallet.
   * Delegates to CredentialProgram.verify().
   */
  async verifyHoldingProof(credential: PortableCredential): Promise<boolean> {
    try {
      // Check expiration
      if (credential.expiresAt > 0 && Date.now() > credential.expiresAt) {
        return false;
      }

      const proof = await CredentialOperationProof.fromJSON(credential.proofJson);
      return CredentialProgram.verify(proof);
    } catch {
      return false;
    }
  }

  /**
   * Verify an EligibilityProof.
   *
   * Checks that the credential contains valid eligibility data:
   * correct type, not revoked, data in forest, plan in registry, dates valid.
   */
  async verifyEligibilityData(
    proof: InstanceType<typeof EligibilityProof>,
  ): Promise<VerificationResult> {
    try {
      const ok = await EligibilityProgram.verify(proof);
      if (!ok) {
        return { isValid: false, reason: 'Eligibility proof verification failed' };
      }

      const output = proof.publicOutput;
      return {
        isValid: true,
        credentialCommitment: output.credentialCommitment.toString(),
        coverageType: output.coverageType.toString(),
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify an InNetworkProof.
   *
   * Checks that a prescriber or pharmacy wallet is in-network
   * (lifecycle state is ELIGIBLE or ACTIVE).
   */
  async verifyInNetwork(
    proof: InstanceType<typeof InNetworkProof>,
  ): Promise<boolean> {
    try {
      return InNetworkProgram.verify(proof);
    } catch {
      return false;
    }
  }

  /**
   * Full point-of-care verification.
   *
   * Checks all proofs presented by the member and optionally
   * prescriber/pharmacy in-network proofs. Returns a detailed result.
   *
   * @param holdingCredential — PortableCredential with CredentialOperationProof
   * @param eligibilityProof — EligibilityProof for benefit plan validation
   * @param prescriberInNetworkProof — optional prescriber in-network proof
   * @param pharmacyInNetworkProof — optional pharmacy in-network proof
   */
  async fullPointOfCareCheck(
    holdingCredential: PortableCredential,
    eligibilityProof: InstanceType<typeof EligibilityProof>,
    prescriberInNetworkProof?: InstanceType<typeof InNetworkProof>,
    pharmacyInNetworkProof?: InstanceType<typeof InNetworkProof>,
  ): Promise<FullVerificationResult> {
    const details: string[] = [];

    // 1. Verify credential holding
    const holdingValid = await this.verifyHoldingProof(holdingCredential);
    details.push(
      holdingValid
        ? 'Credential holding: verified'
        : 'Credential holding: FAILED',
    );

    // 2. Verify eligibility data
    const eligResult = await this.verifyEligibilityData(eligibilityProof);
    details.push(
      eligResult.isValid
        ? `Eligibility: verified (coverage type ${eligResult.coverageType})`
        : `Eligibility: FAILED (${eligResult.reason})`,
    );

    // 3. Verify prescriber in-network (optional)
    let prescriberInNetwork: boolean | undefined;
    if (prescriberInNetworkProof) {
      prescriberInNetwork = await this.verifyInNetwork(prescriberInNetworkProof);
      details.push(
        prescriberInNetwork
          ? 'Prescriber in-network: verified'
          : 'Prescriber in-network: FAILED',
      );
    }

    // 4. Verify pharmacy in-network (optional)
    let pharmacyInNetwork: boolean | undefined;
    if (pharmacyInNetworkProof) {
      pharmacyInNetwork = await this.verifyInNetwork(pharmacyInNetworkProof);
      details.push(
        pharmacyInNetwork
          ? 'Pharmacy in-network: verified'
          : 'Pharmacy in-network: FAILED',
      );
    }

    // Overall: all required checks must pass
    const overallValid =
      holdingValid &&
      eligResult.isValid &&
      (prescriberInNetwork === undefined || prescriberInNetwork) &&
      (pharmacyInNetwork === undefined || pharmacyInNetwork);

    return {
      holdingValid,
      eligibilityValid: eligResult.isValid,
      prescriberInNetwork,
      pharmacyInNetwork,
      overallValid,
      details,
    };
  }
}
