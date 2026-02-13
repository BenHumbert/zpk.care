import { Field, Struct, Poseidon, ZkProgram, Provable } from 'o1js';
import { ProofGateProof } from '../wallets/proof-gate.js';
import { NftData, NFT_TYPE_ELIGIBILITY } from '../nft/nft-data.js';
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

// ─── EligibilityProgram ──────────────────────────────────────

/**
 * EligibilityOutput — public output of EligibilityProgram.proveEligibility.
 *
 * Contains the NFT commitment, benefit plan commitment, forest root,
 * and coverage type. A verifier can confirm that:
 *   1. The NFT contains valid eligibility data
 *   2. The benefit plan exists in the insurer's registry
 *   3. The coverage dates are valid
 */
export class EligibilityOutput extends Struct({
  /** Commitment of the ELIGIBILITY NFT */
  nftCommitment: Field,
  /** Commitment of the eligibility/benefit plan data */
  benefitPlanCommitment: Field,
  /** Forest root from the NFT (links to on-chain NFT data) */
  forestRoot: Field,
  /** Coverage type for quick inspection */
  coverageType: Field,
}) {}

/**
 * EligibilityProgram — ZkProgram for eligibility rule verification.
 *
 * STANDALONE (no recursive proof) — proves that an ELIGIBILITY NFT
 * contains valid eligibility data according to the insurer's benefit
 * plan registry and date constraints.
 *
 * This is NOT about wallet ownership (that's ProofGateProgram/NftProgram).
 * It's about verifying the RULES embedded in the NFT are valid.
 *
 * Used at pharmacy: member generates this proof alongside NftOperationProof
 * to prove both "I hold this NFT" AND "the NFT contains valid eligibility."
 */
export const EligibilityProgram = ZkProgram({
  name: 'Eligibility',
  publicOutput: EligibilityOutput,

  methods: {
    /**
     * Prove that an ELIGIBILITY NFT contains valid benefit plan data.
     *
     * Verifies:
     *   1. NFT type is ELIGIBILITY
     *   2. NFT is not revoked
     *   3. Forest root integrity (6 tree roots hash to NFT's forestRoot)
     *   4. Eligibility data exists in the ACCESS_CONTROL tree
     *   5. Benefit plan exists in the insurer's registry
     *   6. Current date is within effective/termination date range
     */
    proveEligibility: {
      privateInputs: [
        NftData,
        EligibilityData,
        ForestRoots,
        ForestMerkleWitness,  // witness for eligibility data in ACCESS_CONTROL tree
        BenefitPlanWitness,   // witness for plan in benefit plan registry
        Field,                // benefitPlanRoot (on-chain state)
        Field,                // currentDate (CCYYMMDD as number)
      ],
      async method(
        nftData: NftData,
        eligibilityData: EligibilityData,
        forestRoots: ForestRoots,
        forestWitness: ForestMerkleWitness,
        benefitPlanWitness: BenefitPlanWitness,
        benefitPlanRoot: Field,
        currentDate: Field,
      ) {
        // 1. Verify NFT type is ELIGIBILITY
        nftData.nftType.assertEquals(
          NFT_TYPE_ELIGIBILITY,
          'NFT type must be ELIGIBILITY',
        );

        // 2. Verify NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 3. Verify forest root integrity
        //    Reconstruct forest root from 6 individual tree roots
        //    and verify it matches the NFT's embedded forestRoot.
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          nftData.forestRoot,
          'Forest root mismatch — tree roots do not compose to NFT forestRoot',
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
            nftCommitment: nftData.commitment(),
            benefitPlanCommitment: eligCommitment,
            forestRoot: nftData.forestRoot,
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
 * Contains the wallet ID and lifecycle root used for verification.
 * A verifier can confirm that the wallet owner's lifecycle state
 * indicates they are in-network (ELIGIBLE or ACTIVE).
 */
export class InNetworkOutput extends Struct({
  /** The wallet proven to be in-network */
  walletId: Field,
  /** The lifecycle root used for verification (anchors to on-chain state) */
  lifecycleRoot: Field,
}) {}

/**
 * InNetworkProgram — ZkProgram for in-network recognition (Use Case C).
 *
 * RECURSIVE — verifies a ProofGateProof to bind wallet ownership to
 * the in-network status check. This prevents anyone from claiming
 * another wallet is in-network.
 *
 * In-network = lifecycle state is ELIGIBLE(2) or ACTIVE(3).
 * The insurer (admin) sets these states via CareContract.updateLifecycle.
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
     */
    proveInNetwork: {
      privateInputs: [
        ProofGateProof,
        Field,             // lifecycle value
        LifecycleWitness,  // witness for lifecycle tree
        Field,             // lifecycleRoot (on-chain state)
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        lifecycle: Field,
        lifecycleWitness: LifecycleWitness,
        lifecycleRoot: Field,
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

        return {
          publicOutput: new InNetworkOutput({
            walletId,
            lifecycleRoot,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility */
export class InNetworkProof extends ZkProgram.Proof(InNetworkProgram) {}
