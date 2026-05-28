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

import { Field, Struct, Poseidon, ZkProgram, Provable } from 'o1js';
import { ProofGateProof } from '../wallets/proof-gate.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../credentials/credential-data.js';
import { ForestMerkleWitness } from '../zkp/merkle-forest.js';
import {
  LifecycleWitness,
  LIFECYCLE_ELIGIBLE,
  LIFECYCLE_ACTIVE,
  lifecycleLeafCommitment,
} from '../engine/lifecycle.js';
import { EligibilityData } from './eligibility-data.js';
import { ForestRoots } from './forest-roots.js';
import { BenefitPlanWitness } from './benefit-plan-registry.js';
import { NetworkMerkleWitness } from './provider-network-registry.js';

// ─── EligibilityProgram ──────────────────────────────────────

/**
 * EligibilityOutput — public output of EligibilityProgram.proveEligibility.
 *
 * Contains the credential commitment, benefit plan commitment, forest root,
 * and coverage type. A verifier can confirm that:
 *   1. The credential contains valid eligibility data
 *   2. The benefit plan exists in the insurer's registry
 *   3. The coverage dates are valid
 */
export class EligibilityOutput extends Struct({
  /** Commitment of the ELIGIBILITY credential */
  credentialCommitment: Field,
  /** Commitment of the eligibility/benefit plan data */
  benefitPlanCommitment: Field,
  /** Forest root from the credential (links to on-chain credential data) */
  forestRoot: Field,
  /** Coverage type for quick inspection */
  coverageType: Field,
}) {}

/**
 * EligibilityProgram — ZkProgram for eligibility rule verification.
 *
 * STANDALONE (no recursive proof) — proves that an ELIGIBILITY credential
 * contains valid eligibility data according to the insurer's benefit
 * plan registry and date constraints.
 *
 * This is NOT about wallet ownership (that's ProofGateProgram/CredentialProgram).
 * It's about verifying the RULES embedded in the credential are valid.
 *
 * Used at pharmacy: member generates this proof alongside CredentialOperationProof
 * to prove both "I hold this credential" AND "the credential contains valid eligibility."
 */
export const EligibilityProgram = ZkProgram({
  name: 'Eligibility',
  publicOutput: EligibilityOutput,

  methods: {
    /**
     * Prove that an ELIGIBILITY credential contains valid benefit plan data.
     *
     * Verifies:
     *   1. Credential type is ELIGIBILITY
     *   2. Credential is not revoked
     *   3. Forest root integrity (6 tree roots hash to credential's forestRoot)
     *   4. Eligibility data exists in the ACCESS_CONTROL tree
     *   5. Benefit plan exists in the insurer's registry
     *   6. Current date is within effective/termination date range
     */
    proveEligibility: {
      privateInputs: [
        CredentialData,
        EligibilityData,
        ForestRoots,
        ForestMerkleWitness,  // witness for eligibility data in ACCESS_CONTROL tree
        BenefitPlanWitness,   // witness for plan in benefit plan registry
        Field,                // benefitPlanRoot (on-chain state)
        Field,                // currentDate (CCYYMMDD as number)
      ],
      async method(
        credentialData: CredentialData,
        eligibilityData: EligibilityData,
        forestRoots: ForestRoots,
        forestWitness: ForestMerkleWitness,
        benefitPlanWitness: BenefitPlanWitness,
        benefitPlanRoot: Field,
        currentDate: Field,
      ) {
        // 1. Verify credential type is ELIGIBILITY
        credentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_ELIGIBILITY,
          'Credential type must be ELIGIBILITY',
        );

        // 2. Verify credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        // 2b. M1 fix: Verify credential is not expired
        //     expiresAt == 0 means never expires; otherwise currentDate <= expiresAt
        const credentialNoExpiry = credentialData.expiresAt.equals(Field(0));
        const credentialNotExpired = currentDate.lessThanOrEqual(credentialData.expiresAt);
        credentialNoExpiry.or(credentialNotExpired).assertTrue('Credential has expired');

        // 3. Verify forest root integrity
        //    Reconstruct forest root from 6 individual tree roots
        //    and verify it matches the credential's embedded forestRoot.
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          credentialData.forestRoot,
          'Forest root mismatch — tree roots do not compose to credential forestRoot',
        );

        // 4. Verify eligibility data exists in the ACCESS_CONTROL tree
        const eligCommitment = eligibilityData.commitment();
        const computedAccessRoot = forestWitness.calculateRoot(eligCommitment);
        computedAccessRoot.assertEquals(
          forestRoots.accessControlRoot,
          'Eligibility data not found in ACCESS_CONTROL tree',
        );

        // 5. Verify benefit plan exists in the insurer's registry
        const computedPlanRoot = benefitPlanWitness.calculateRoot(eligCommitment);
        computedPlanRoot.assertEquals(
          benefitPlanRoot,
          'Benefit plan not found in registry',
        );

        // 6. Verify date range: effectiveDate <= currentDate
        eligibilityData.effectiveDate
          .lessThanOrEqual(currentDate)
          .assertTrue('Eligibility not yet effective');

        // 7. Verify date range: currentDate <= terminationDate OR terminationDate == 0
        const noEndDate = eligibilityData.terminationDate.equals(Field(0));
        const beforeTermination = currentDate.lessThanOrEqual(
          eligibilityData.terminationDate,
        );
        noEndDate.or(beforeTermination).assertTrue('Eligibility has expired');

        return {
          publicOutput: new EligibilityOutput({
            credentialCommitment: credentialData.commitment(),
            benefitPlanCommitment: eligCommitment,
            forestRoot: credentialData.forestRoot,
            coverageType: eligibilityData.coverageType,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility */
export class EligibilityProof extends ZkProgram.Proof(EligibilityProgram) {}

// ─── InNetworkProgram ────────────────────────────────────────

/**
 * InNetworkOutput — public output of InNetworkProgram.proveInNetwork.
 *
 * Contains the wallet ID, lifecycle root, and network root used for verification.
 * A verifier can confirm that the wallet owner's lifecycle state
 * indicates they are in-network (ELIGIBLE or ACTIVE) AND they are
 * in the plan's provider network tree.
 */
export class InNetworkOutput extends Struct({
  /** The wallet proven to be in-network */
  walletId: Field,
  /** The lifecycle root used for verification (anchors to on-chain state) */
  lifecycleRoot: Field,
  /** The network root verified against (anchors to plan's provider network) */
  networkRoot: Field,
}) {}

/**
 * InNetworkProgram — ZkProgram for in-network recognition (Use Case C).
 *
 * RECURSIVE — verifies a ProofGateProof to bind wallet ownership to
 * the in-network status check. This prevents anyone from claiming
 * another wallet is in-network.
 *
 * In-network = lifecycle state is ELIGIBLE(2) or ACTIVE(3)
 *   AND wallet exists in the plan's provider network tree.
 *
 * When networkRoot == Field(0), the network check is skipped (all providers accepted).
 * This preserves backward compatibility for plans without explicit networks.
 *
 * Used by prescribers/pharmacies to prove their in-network status
 * at point-of-care or during eligibility verification.
 */
export const InNetworkProgram = ZkProgram({
  name: 'InNetwork',
  publicOutput: InNetworkOutput,

  methods: {
    /**
     * Prove that a wallet owner is in-network.
     *
     * Verifies:
     *   1. Wallet ownership (recursive ProofGateProof)
     *   2. Lifecycle state matches the lifecycle tree
     *   3. Lifecycle is ELIGIBLE or ACTIVE (in-network)
     *   4. Wallet exists in plan's network tree (if networkRoot != 0)
     */
    proveInNetwork: {
      privateInputs: [
        ProofGateProof,
        Field,                // lifecycle value
        LifecycleWitness,     // witness for lifecycle tree
        Field,                // lifecycleRoot (on-chain state)
        Field,                // networkRoot (from EligibilityData)
        NetworkMerkleWitness, // witness for network tree
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        lifecycle: Field,
        lifecycleWitness: LifecycleWitness,
        lifecycleRoot: Field,
        networkRoot: Field,
        networkWitness: NetworkMerkleWitness,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify lifecycle state matches the tree
        const lifecycleLeaf = lifecycleLeafCommitment(walletId, lifecycle);
        const computedRoot = lifecycleWitness.calculateRoot(lifecycleLeaf);
        computedRoot.assertEquals(
          lifecycleRoot,
          'Lifecycle state mismatch',
        );

        // 3. Verify in-network: lifecycle == ELIGIBLE or lifecycle == ACTIVE
        const isEligible = lifecycle.equals(LIFECYCLE_ELIGIBLE);
        const isActive = lifecycle.equals(LIFECYCLE_ACTIVE);
        isEligible.or(isActive).assertTrue(
          'Wallet is not in-network (requires ELIGIBLE or ACTIVE)',
        );

        // 4. Verify provider is in plan's network tree (if network is defined)
        //    networkRoot == 0 means "all providers accepted" (no network restriction)
        const hasNetwork = networkRoot.equals(Field(0)).not();
        const computedNetworkRoot = networkWitness.calculateRoot(walletId);
        const networkValid = computedNetworkRoot.equals(networkRoot);
        // Must be valid if network is defined; always passes if no network
        hasNetwork.implies(networkValid).assertTrue(
          'Provider not in plan network',
        );

        return {
          publicOutput: new InNetworkOutput({
            walletId,
            lifecycleRoot,
            networkRoot,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility */
export class InNetworkProof extends ZkProgram.Proof(InNetworkProgram) {}
