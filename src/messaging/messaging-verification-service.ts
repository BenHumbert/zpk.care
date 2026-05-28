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
import { MessagingProgram, MessagingProof } from './messaging-program.js';

/**
 * Result of verifying a messaging proof.
 */
export interface MessageVerificationResult {
  /** Whether the proof is valid */
  isValid: boolean;
  /** Reason for failure (if invalid) */
  reason?: string;
  /** Sender wallet ID (if valid) */
  senderWalletId?: string;
  /** Recipient wallet ID (if valid) */
  recipientWalletId?: string;
  /** Message type (if valid) */
  messageType?: string;
  /** Content hash (if valid) */
  contentHash?: string;
}

/**
 * Result of verifying a delegation proof.
 */
export interface DelegationVerificationResult {
  /** Whether the proof is valid */
  isValid: boolean;
  /** Reason for failure (if invalid) */
  reason?: string;
  /** Whether the proof's root matches the current on-chain root (undefined if not checked) */
  rootFresh?: boolean;
  /** Delegator wallet ID (if valid) */
  delegatorWalletId?: string;
  /** Delegate wallet ID (if valid) */
  delegateWalletId?: string;
  /** Scope flags (if valid) */
  scopeFlags?: string;
  /** Relationship code (if valid) */
  relationshipCode?: string;
}

/**
 * Result of a root-freshness check.
 */
export interface RootFreshnessResult {
  /** Whether the proof's messagingRoot matches the current on-chain root */
  isFresh: boolean;
  /** The messaging root embedded in the proof */
  proofRoot: string;
  /** The current on-chain messaging root that was compared against */
  currentRoot: string;
}

/**
 * Combined messaging check result.
 */
export interface FullMessagingCheckResult {
  /** Whether the message proof is valid */
  messageValid: boolean;
  /** Whether the delegation proof is valid (undefined if not checked) */
  delegationValid: boolean | undefined;
  /** Whether the delegation proof's root is fresh (undefined if not checked) */
  delegationRootFresh: boolean | undefined;
  /** Overall result — message valid AND (no delegation needed OR delegation valid + fresh) */
  overallValid: boolean;
  /** Detail messages for each check */
  details: string[];
}

/**
 * MessagingVerificationService — point-of-care verification for messaging proofs.
 *
 * Verifies message and delegation proofs OFFLINE.
 * The verifier needs only the MessagingProgram verification key.
 *
 * Preconditions: MessagingProgram must be compiled.
 */
export class MessagingVerificationService {
  /**
   * Verify a message proof.
   *
   * Checks that the message is well-formed, committed to the registry,
   * and the messaging root is valid.
   */
  async verifyMessage(
    proof: InstanceType<typeof MessagingProof>,
  ): Promise<MessageVerificationResult> {
    try {
      const ok = await MessagingProgram.verify(proof);
      if (!ok) {
        return {
          isValid: false,
          reason: 'Message proof verification failed',
        };
      }

      const output = proof.publicOutput;

      // Verify this is a send operation (not a delegation)
      if (output.operationType.toString() !== '1') {
        return {
          isValid: false,
          reason: 'Proof is not a message operation (operationType != 1)',
        };
      }

      return {
        isValid: true,
        senderWalletId: output.senderWalletId.toString(),
        recipientWalletId: output.recipientWalletId.toString(),
        messageType: output.messageType.toString(),
        contentHash: output.contentHash.toString(),
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify a delegation proof.
   *
   * Checks that the delegation is well-formed, committed to the registry,
   * date-valid, and has at least one scope permission.
   *
   * If `currentMessagingRoot` is provided, also checks that the proof's
   * embedded messagingRoot matches the current on-chain root. A mismatch
   * means the delegation registry has changed since the proof was generated
   * (e.g., a revocation occurred), and the proof should not be trusted.
   *
   * @param proof — the delegation proof to verify
   * @param currentMessagingRoot — optional current on-chain messagingRoot for freshness check
   */
  async verifyDelegation(
    proof: InstanceType<typeof MessagingProof>,
    currentMessagingRoot?: Field,
  ): Promise<DelegationVerificationResult> {
    try {
      const ok = await MessagingProgram.verify(proof);
      if (!ok) {
        return {
          isValid: false,
          reason: 'Delegation proof verification failed',
        };
      }

      const output = proof.publicOutput;

      // Verify this is a delegation operation
      if (output.operationType.toString() !== '2') {
        return {
          isValid: false,
          reason: 'Proof is not a delegation operation (operationType != 2)',
        };
      }

      // Root-freshness check (if current root provided)
      let rootFresh: boolean | undefined;
      if (currentMessagingRoot !== undefined) {
        rootFresh = output.messagingRoot.toString() === currentMessagingRoot.toString();
        if (!rootFresh) {
          return {
            isValid: false,
            rootFresh: false,
            reason: 'Delegation proof root is stale (registry has changed since proof generation)',
            delegatorWalletId: output.senderWalletId.toString(),
            delegateWalletId: output.recipientWalletId.toString(),
            scopeFlags: output.contentHash.toString(),
            relationshipCode: output.messageType.toString(),
          };
        }
      }

      return {
        isValid: true,
        rootFresh,
        delegatorWalletId: output.senderWalletId.toString(),
        delegateWalletId: output.recipientWalletId.toString(),
        scopeFlags: output.contentHash.toString(),
        relationshipCode: output.messageType.toString(),
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Standalone root-freshness check for a delegation proof.
   *
   * Compares the messagingRoot embedded in the proof against the current
   * on-chain root. Does NOT verify the proof cryptographically — call
   * verifyDelegation() first for full verification.
   *
   * Use this for fast stale-proof detection without re-running verification.
   *
   * @param proof — the delegation proof to check
   * @param currentMessagingRoot — the current on-chain messagingRoot
   */
  checkDelegationFreshness(
    proof: InstanceType<typeof MessagingProof>,
    currentMessagingRoot: Field,
  ): RootFreshnessResult {
    const proofRoot = proof.publicOutput.messagingRoot.toString();
    const currentRoot = currentMessagingRoot.toString();
    return {
      isFresh: proofRoot === currentRoot,
      proofRoot,
      currentRoot,
    };
  }

  /**
   * Full messaging check — verifies message + optional delegation.
   *
   * If the reader is a delegate (not the direct recipient), a delegation
   * proof must also be provided for the overall check to pass.
   *
   * If `currentMessagingRoot` is provided, the delegation proof's root
   * is also checked for freshness. A stale root fails the overall check.
   *
   * @param messageProof — the message proof to verify
   * @param delegationProof — optional delegation proof
   * @param currentMessagingRoot — optional current on-chain messagingRoot for freshness check
   */
  async fullMessagingCheck(
    messageProof: InstanceType<typeof MessagingProof>,
    delegationProof?: InstanceType<typeof MessagingProof>,
    currentMessagingRoot?: Field,
  ): Promise<FullMessagingCheckResult> {
    const details: string[] = [];

    // 1. Verify message
    const msgResult = await this.verifyMessage(messageProof);
    details.push(
      msgResult.isValid
        ? `Message: verified (type ${msgResult.messageType}, sender ${msgResult.senderWalletId})`
        : `Message: FAILED (${msgResult.reason})`,
    );

    // 2. Verify delegation if provided
    let delegationValid: boolean | undefined;
    let delegationRootFresh: boolean | undefined;
    if (delegationProof) {
      const delResult = await this.verifyDelegation(delegationProof, currentMessagingRoot);
      delegationValid = delResult.isValid;
      delegationRootFresh = delResult.rootFresh;
      details.push(
        delResult.isValid
          ? `Delegation: verified (${delResult.delegatorWalletId} → ${delResult.delegateWalletId}, scope ${delResult.scopeFlags})`
          : `Delegation: FAILED (${delResult.reason})`,
      );
    }

    // 3. Overall: message valid AND (no delegation needed OR delegation valid)
    const overallValid =
      msgResult.isValid &&
      (delegationValid === undefined || delegationValid === true);

    return {
      messageValid: msgResult.isValid,
      delegationValid,
      delegationRootFresh,
      overallValid,
      details,
    };
  }
}
