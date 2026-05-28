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

import { Field, JsonProof } from 'o1js';
import { CredentialOperationOutput, CredentialOperationProof, CredentialProgram } from './credential-program.js';

/**
 * PortableCredential — serialized proof for NFC/RFID/QR offline transport.
 *
 * This is the data structure that goes onto an NFC tag, RFID card, or QR code.
 * A verifier with the verification key can validate the proof without internet.
 */
export interface PortableCredential {
  /** Protocol version (currently 1) */
  version: number;
  /** Type of proof contained */
  proofType: 'credential-mint' | 'credential-holding' | 'credential-type-holding';
  /** JSON-serialized proof (from proof.toJSON()) */
  proofJson: JsonProof;
  /** Extracted public output for quick inspection (before full verification) */
  publicOutput: {
    walletId: string;
    operationType: string;
    credentialCommitment: string;
    oldInventoryRoot: string;
    newInventoryRoot: string;
  };
  /** Hash of the verification key needed to verify this proof */
  verificationKeyHash: string;
  /** Creation timestamp (unix ms) */
  createdAt: number;
  /** Expiration timestamp (unix ms, 0 = never) */
  expiresAt: number;
}

/**
 * Serialize a proof into a PortableCredential for offline transport.
 *
 * @param proof — the CredentialOperationProof or any proof with toJSON()
 * @param proofType — which CredentialProgram method generated this proof
 * @param vkHash — verification key hash (for verifier to confirm they have correct VK)
 * @param expiresAt — optional expiration timestamp (0 = never)
 */
export function serializeCredential(
  proof: { toJSON(): JsonProof; publicOutput: CredentialOperationOutput },
  proofType: PortableCredential['proofType'],
  vkHash: Field,
  expiresAt: number = 0,
): PortableCredential {
  const output = proof.publicOutput;

  return {
    version: 1,
    proofType,
    proofJson: proof.toJSON(),
    publicOutput: {
      walletId: output.walletId.toString(),
      operationType: output.operationType.toString(),
      credentialCommitment: output.credentialCommitment.toString(),
      oldInventoryRoot: output.oldInventoryRoot.toString(),
      newInventoryRoot: output.newInventoryRoot.toString(),
    },
    verificationKeyHash: vkHash.toString(),
    createdAt: Date.now(),
    expiresAt,
  };
}

/**
 * Deserialize a PortableCredential from JSON string.
 */
export function deserializeCredential(json: string): PortableCredential {
  return JSON.parse(json) as PortableCredential;
}

/**
 * Verify a portable credential offline.
 *
 * Reconstructs the proof from JSON and verifies it against the provided
 * verification key. This is the core of the NFC/RFID/QR verification flow.
 *
 * @param credential — the portable credential to verify
 * @param verificationKey — the CredentialProgram verification key (stored on verifier device)
 * @returns true if the proof is valid
 */
export async function verifyCredentialOffline(
  credential: PortableCredential,
  verificationKey: string,
): Promise<boolean> {
  try {
    // Check expiration
    if (credential.expiresAt > 0 && Date.now() > credential.expiresAt) {
      return false;
    }

    // Reconstruct proof from JSON and verify using the ZkProgram
    const proof = await CredentialOperationProof.fromJSON(credential.proofJson);
    return CredentialProgram.verify(proof);
  } catch {
    return false;
  }
}

// ─── Portable Delegation Credential ─────────────────────────

/**
 * PortableDelegationCredential — offline-verifiable delegation proof.
 *
 * Used by representatives to prove delegation at pharmacies.
 * The pharmacy verifies the Merkle witness against their cached
 * chain state (messagingRoot).
 *
 * TTL enforcement:
 *   READ:   72h — low risk
 *   WRITE:  24h — medium risk
 *   PICKUP:  4h — high risk (medication dispensing)
 *
 * See AorService.isOfflineCredentialValid() for TTL validation.
 */
export interface PortableDelegationCredential {
  /** Protocol version */
  version: number;
  /** Credential type identifier */
  credentialType: 'delegation';

  /** The delegation data (7 Fields as strings) */
  delegation: {
    delegatorWalletId: string;
    delegateWalletId: string;
    scopeFlags: string;
    effectiveDate: string;
    expirationDate: string;
    relationshipCode: string;
    delegationHash: string;
  };

  /** Delegation index in the DelegationRegistry */
  delegationIndex: string;

  /**
   * Merkle witness path (serialized sibling hashes).
   * Used to verify delegation inclusion in the delegationRoot.
   */
  witnessPath: string[];
  /** Left/right flags for each witness level */
  witnessIsLefts: boolean[];

  /** Delegation registry root at time of credential generation */
  delegationRegistryRoot: string;
  /** Packed messaging root (= Poseidon.hash([msgRoot, delRoot, keyRoot])) */
  messagingRoot: string;

  /** When the pharmacy last synced chain state (unix ms) */
  chainStateTimestamp: number;
  /** When this credential was generated (unix ms) */
  createdAt: number;
}

/**
 * Serialize a delegation into a portable credential for QR/NFC.
 */
export function serializeDelegationCredential(
  delegationData: {
    delegatorWalletId: Field;
    delegateWalletId: Field;
    scopeFlags: Field;
    effectiveDate: Field;
    expirationDate: Field;
    relationshipCode: Field;
    delegationHash: Field;
  },
  delegationIndex: bigint,
  witnessPath: Field[],
  witnessIsLefts: boolean[],
  delegationRegistryRoot: Field,
  messagingRoot: Field,
  chainStateTimestamp: number,
): PortableDelegationCredential {
  return {
    version: 1,
    credentialType: 'delegation',
    delegation: {
      delegatorWalletId: delegationData.delegatorWalletId.toString(),
      delegateWalletId: delegationData.delegateWalletId.toString(),
      scopeFlags: delegationData.scopeFlags.toString(),
      effectiveDate: delegationData.effectiveDate.toString(),
      expirationDate: delegationData.expirationDate.toString(),
      relationshipCode: delegationData.relationshipCode.toString(),
      delegationHash: delegationData.delegationHash.toString(),
    },
    delegationIndex: delegationIndex.toString(),
    witnessPath: witnessPath.map((f) => f.toString()),
    witnessIsLefts,
    delegationRegistryRoot: delegationRegistryRoot.toString(),
    messagingRoot: messagingRoot.toString(),
    chainStateTimestamp,
    createdAt: Date.now(),
  };
}

/**
 * Deserialize a PortableDelegationCredential from JSON string.
 */
export function deserializeDelegationCredential(
  json: string,
): PortableDelegationCredential {
  return JSON.parse(json) as PortableDelegationCredential;
}
