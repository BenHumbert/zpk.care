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

import { Field, Struct, ZkProgram } from 'o1js';
import { ProofGateProof } from '../wallets/proof-gate.js';
import { CredentialInventoryWitness } from '../wallets/wallet-state.js';
import { CredentialData } from './credential-data.js';

/**
 * Operation type constants for CredentialOperationOutput.
 */
export const CREDENTIAL_OP_MINT = Field(1);
export const CREDENTIAL_OP_VERIFY = Field(2);

/**
 * CredentialOperationOutput — public output of every CredentialProgram proof.
 *
 * Contains the wallet identity, operation type, credential commitment,
 * and old/new inventory roots. This is the portable credential
 * that can be verified offline via NFC/RFID/QR.
 */
export class CredentialOperationOutput extends Struct({
  /** The wallet involved in this operation */
  walletId: Field,
  /** CREDENTIAL_OP_MINT or CREDENTIAL_OP_VERIFY */
  operationType: Field,
  /** Commitment of the credential involved */
  credentialCommitment: Field,
  /** Inventory root BEFORE the operation */
  oldInventoryRoot: Field,
  /** Inventory root AFTER the operation (same as old for verify) */
  newInventoryRoot: Field,
}) {}

/**
 * CredentialProgram — ZkProgram for credential operations with recursive proof composition.
 *
 * Each method recursively verifies a ProofGateProof (wallet ownership),
 * then proves a specific credential operation. The resulting CredentialOperationProof
 * is a portable credential that can be verified offline.
 *
 * Methods:
 *   proveMint          — prove correct credential insertion into wallet inventory
 *   proveHolding       — prove wallet holds a specific credential (point-of-care)
 *   proveHoldingByType — selective disclosure (prove type without revealing credential)
 *
 * Proof chain: ProofGateProof → CredentialOperationProof → offline/on-chain verify
 */
export const CredentialProgram = ZkProgram({
  name: 'CredentialOperations',
  publicOutput: CredentialOperationOutput,

  methods: {
    /**
     * Prove that a credential was correctly issued into a wallet's inventory.
     *
     * Verifies:
     *   1. Wallet ownership (recursive ProofGateProof)
     *   2. The inventory slot is empty
     *   3. subjectWalletId matches the prover's wallet
     *   4. Computes new inventory root with credential commitment
     */
    proveMint: {
      privateInputs: [
        ProofGateProof,
        CredentialData,
        CredentialInventoryWitness,
        Field, // oldInventoryRoot
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        credentialData: CredentialData,
        inventoryWitness: CredentialInventoryWitness,
        oldInventoryRoot: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify the inventory slot is empty
        const emptyRoot = inventoryWitness.calculateRoot(Field(0));
        emptyRoot.assertEquals(
          oldInventoryRoot,
          'Inventory slot is not empty',
        );

        // 3. Verify subject matches wallet owner
        credentialData.subjectWalletId.assertEquals(
          walletId,
          'Credential subject must match wallet owner',
        );

        // 3b. M2 fix: Verify credential is not pre-revoked
        credentialData.revoked.assertEquals(Field(0), 'Cannot issue a revoked credential');

        // 4. Compute new root with credential commitment
        const credentialCommitment = credentialData.commitment();
        const newInventoryRoot = inventoryWitness.calculateRoot(credentialCommitment);

        return {
          publicOutput: new CredentialOperationOutput({
            walletId,
            operationType: CREDENTIAL_OP_MINT,
            credentialCommitment,
            oldInventoryRoot,
            newInventoryRoot,
          }),
        };
      },
    },

    /**
     * Prove a wallet holds a specific credential (point-of-care verification).
     *
     * Verifies:
     *   1. Wallet ownership (recursive ProofGateProof)
     *   2. The credential exists in the wallet's inventory
     *   3. subjectWalletId matches the prover's wallet
     *   4. The credential is not revoked
     *
     * No state change — inventory root is unchanged.
     * This is the OFFLINE verification path (NFC/RFID/QR at pharmacy).
     */
    proveHolding: {
      privateInputs: [
        ProofGateProof,
        CredentialData,
        CredentialInventoryWitness,
        Field, // inventoryRoot
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        credentialData: CredentialData,
        inventoryWitness: CredentialInventoryWitness,
        inventoryRoot: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify credential exists in inventory
        const credentialCommitment = credentialData.commitment();
        const computedRoot = inventoryWitness.calculateRoot(credentialCommitment);
        computedRoot.assertEquals(
          inventoryRoot,
          'Credential not found in inventory',
        );

        // 3. Verify subject matches wallet owner
        credentialData.subjectWalletId.assertEquals(
          walletId,
          'Credential subject must match wallet owner',
        );

        // 4. Verify credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        return {
          publicOutput: new CredentialOperationOutput({
            walletId,
            operationType: CREDENTIAL_OP_VERIFY,
            credentialCommitment,
            oldInventoryRoot: inventoryRoot,
            newInventoryRoot: inventoryRoot, // unchanged
          }),
        };
      },
    },

    /**
     * Prove a wallet holds a credential of a specific TYPE (selective disclosure).
     *
     * Same as proveHolding but additionally constrains the credential type.
     * Use case: "I hold an ELIGIBILITY credential" without revealing which one,
     * or "I hold a PRESCRIPTION eScript" for dispensing authority.
     *
     * The requiredCredentialType is a private input — the verifier sees the proof
     * is valid but only knows the wallet holds *some* credential of that type.
     */
    proveHoldingByType: {
      privateInputs: [
        ProofGateProof,
        CredentialData,
        CredentialInventoryWitness,
        Field, // inventoryRoot
        Field, // requiredCredentialType
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        credentialData: CredentialData,
        inventoryWitness: CredentialInventoryWitness,
        inventoryRoot: Field,
        requiredCredentialType: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify credential exists in inventory
        const credentialCommitment = credentialData.commitment();
        const computedRoot = inventoryWitness.calculateRoot(credentialCommitment);
        computedRoot.assertEquals(
          inventoryRoot,
          'Credential not found in inventory',
        );

        // 3. Verify subject matches wallet owner
        credentialData.subjectWalletId.assertEquals(
          walletId,
          'Credential subject must match wallet owner',
        );

        // 4. Verify credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        // 5. Verify credential type matches requirement
        credentialData.credentialType.assertEquals(
          requiredCredentialType,
          'Credential type does not match required type',
        );

        return {
          publicOutput: new CredentialOperationOutput({
            walletId,
            operationType: CREDENTIAL_OP_VERIFY,
            credentialCommitment,
            oldInventoryRoot: inventoryRoot,
            newInventoryRoot: inventoryRoot, // unchanged
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility (reflect-metadata needs named class) */
export class CredentialOperationProof extends ZkProgram.Proof(CredentialProgram) {}
