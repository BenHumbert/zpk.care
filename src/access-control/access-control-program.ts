import { Field, Struct, Poseidon, ZkProgram } from 'o1js';
import { NftData, NFT_TYPE_ELIGIBILITY } from '../nft/nft-data.js';
import { EligibilityData } from '../eligibility/eligibility-data.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { ForestMerkleWitness } from '../zkp/merkle-forest.js';
import { FormularyEntry } from './formulary-entry.js';
import { FormularyMerkleWitness } from './formulary-registry.js';
import { PriorAuthData } from './prior-auth-data.js';

// ─── AccessControlOutput ────────────────────────────────────

/**
 * AccessControlOutput — public output of AccessControlProgram methods.
 *
 * Contains medication access verification results.
 * A verifier can confirm that:
 *   1. The medication is on the formulary
 *   2. The quantity/day supply is within limits
 *   3. Prior auth exists if required
 */
export class AccessControlOutput extends Struct({
  /** Commitment of the ELIGIBILITY NFT */
  nftCommitment: Field,
  /** NDC hash of the medication being accessed */
  medicationHash: Field,
  /** Formulary tree root (links to insurer's drug list) */
  formularyRoot: Field,
  /** Tier level of this medication */
  tierLevel: Field,
  /** Copay amount for this medication (cents) */
  copayAmount: Field,
  /** Whether PA is required: Field(0) or Field(1) */
  priorAuthRequired: Field,
}) {}

// ─── AccessControlProgram ───────────────────────────────────

/**
 * AccessControlProgram — ZkProgram for medication access rules (Use Case B).
 *
 * STANDALONE (no recursion) — proves medication access permissions
 * within the formulary framework. Two methods:
 *
 *   1. proveFormularyAccess — medication is on formulary, quantity within limits
 *   2. provePriorAuth — valid prior authorization exists for PA-required medication
 *
 * Independent of ProofGateProgram chain — pharmacy verifies this
 * alongside EligibilityProof and NftOperationProof.
 */
export const AccessControlProgram = ZkProgram({
  name: 'AccessControl',
  publicOutput: AccessControlOutput,

  methods: {
    /**
     * Prove a medication is on the formulary with valid quantity limits.
     *
     * Verification chain:
     *   1. NFT type is ELIGIBILITY, not revoked
     *   2. Forest root integrity (6 roots → forestRoot)
     *   3. EligibilityData in ACCESS_CONTROL tree
     *   4. FormularyEntry in formulary tree (pointed to by eligData.formularyRoot)
     *   5. NDC hash matches FormularyEntry
     *   6. Requested quantity <= max per fill
     *   7. Requested day supply <= max day supply
     */
    proveFormularyAccess: {
      privateInputs: [
        NftData,
        EligibilityData,
        ForestRoots,
        ForestMerkleWitness,        // elig in ACCESS_CONTROL tree
        FormularyEntry,
        FormularyMerkleWitness,     // entry in formulary tree
        Field,                       // ndcHash (medication being requested)
        Field,                       // requestedQuantity (scaled x1000)
        Field,                       // requestedDaySupply
      ],
      async method(
        nftData: NftData,
        eligibilityData: EligibilityData,
        forestRoots: ForestRoots,
        eligForestWitness: ForestMerkleWitness,
        formularyEntry: FormularyEntry,
        formularyWitness: FormularyMerkleWitness,
        ndcHash: Field,
        requestedQuantity: Field,
        requestedDaySupply: Field,
      ) {
        // 1. NFT type is ELIGIBILITY
        nftData.nftType.assertEquals(
          NFT_TYPE_ELIGIBILITY,
          'NFT type must be ELIGIBILITY',
        );

        // 2. NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          nftData.forestRoot,
          'Forest root mismatch',
        );

        // 4. Eligibility data in ACCESS_CONTROL tree
        const eligCommitment = eligibilityData.commitment();
        const computedACRoot = eligForestWitness.calculateRoot(eligCommitment);
        computedACRoot.assertEquals(
          forestRoots.accessControlRoot,
          'Eligibility data not in ACCESS_CONTROL tree',
        );

        // 5. Formulary entry in formulary tree
        const entryCommitment = formularyEntry.commitment();
        const computedFormRoot = formularyWitness.calculateRoot(entryCommitment);
        computedFormRoot.assertEquals(
          eligibilityData.formularyRoot,
          'Formulary entry not in formulary tree',
        );

        // 6. NDC hash matches
        formularyEntry.ndcHash.assertEquals(
          ndcHash,
          'Medication NDC does not match formulary entry',
        );

        // 7. Quantity within limits
        requestedQuantity
          .lessThanOrEqual(formularyEntry.maxQuantityPerFill)
          .assertTrue('Requested quantity exceeds max per fill');

        // 8. Day supply within limits
        requestedDaySupply
          .lessThanOrEqual(formularyEntry.maxDaySupply)
          .assertTrue('Requested day supply exceeds max');

        return {
          publicOutput: new AccessControlOutput({
            nftCommitment: nftData.commitment(),
            medicationHash: ndcHash,
            formularyRoot: eligibilityData.formularyRoot,
            tierLevel: formularyEntry.tierLevel,
            copayAmount: formularyEntry.copayAmountCents,
            priorAuthRequired: formularyEntry.requiresPriorAuth,
          }),
        };
      },
    },

    /**
     * Prove a valid prior authorization exists for a PA-required medication.
     *
     * Used when FormularyEntry.requiresPriorAuth == Field(1).
     * Verifies the PA is in the ACCESS_CONTROL tree, not expired,
     * medication matches, and approved quantity is sufficient.
     */
    provePriorAuth: {
      privateInputs: [
        NftData,
        EligibilityData,
        ForestRoots,
        ForestMerkleWitness,       // elig in ACCESS_CONTROL tree
        ForestMerkleWitness,       // PA in ACCESS_CONTROL tree
        PriorAuthData,
        FormularyEntry,
        FormularyMerkleWitness,    // entry in formulary tree
        Field,                      // currentDate (CCYYMMDD)
        Field,                      // requestedQuantity (scaled x1000)
      ],
      async method(
        nftData: NftData,
        eligibilityData: EligibilityData,
        forestRoots: ForestRoots,
        eligForestWitness: ForestMerkleWitness,
        paForestWitness: ForestMerkleWitness,
        priorAuthData: PriorAuthData,
        formularyEntry: FormularyEntry,
        formularyWitness: FormularyMerkleWitness,
        currentDate: Field,
        requestedQuantity: Field,
      ) {
        // 1. NFT type is ELIGIBILITY
        nftData.nftType.assertEquals(
          NFT_TYPE_ELIGIBILITY,
          'NFT type must be ELIGIBILITY',
        );

        // 2. NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          nftData.forestRoot,
          'Forest root mismatch',
        );

        // 4. Eligibility data in ACCESS_CONTROL tree
        const eligCommitment = eligibilityData.commitment();
        eligForestWitness
          .calculateRoot(eligCommitment)
          .assertEquals(
            forestRoots.accessControlRoot,
            'Eligibility data not in ACCESS_CONTROL tree',
          );

        // 5. Formulary entry in formulary tree
        formularyWitness
          .calculateRoot(formularyEntry.commitment())
          .assertEquals(
            eligibilityData.formularyRoot,
            'Formulary entry not in formulary tree',
          );

        // 6. Formulary entry requires PA
        formularyEntry.requiresPriorAuth.assertEquals(
          Field(1),
          'Formulary entry does not require prior auth',
        );

        // 7. PA in ACCESS_CONTROL tree
        const paCommitment = priorAuthData.commitment();
        paForestWitness
          .calculateRoot(paCommitment)
          .assertEquals(
            forestRoots.accessControlRoot,
            'Prior auth not in ACCESS_CONTROL tree',
          );

        // 8. PA medication matches formulary entry medication
        priorAuthData.ndcHash.assertEquals(
          formularyEntry.ndcHash,
          'PA medication does not match formulary entry',
        );

        // 9. PA not expired: currentDate <= expirationDate
        currentDate
          .lessThanOrEqual(priorAuthData.expirationDate)
          .assertTrue('Prior authorization has expired');

        // 10. PA approval date <= currentDate
        priorAuthData.approvalDate
          .lessThanOrEqual(currentDate)
          .assertTrue('Prior authorization not yet effective');

        // 11. Approved quantity sufficient
        requestedQuantity
          .lessThanOrEqual(priorAuthData.approvedQuantity)
          .assertTrue('Requested quantity exceeds PA approved quantity');

        return {
          publicOutput: new AccessControlOutput({
            nftCommitment: nftData.commitment(),
            medicationHash: formularyEntry.ndcHash,
            formularyRoot: eligibilityData.formularyRoot,
            tierLevel: formularyEntry.tierLevel,
            copayAmount: formularyEntry.copayAmountCents,
            priorAuthRequired: formularyEntry.requiresPriorAuth,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility */
export class AccessControlProof extends ZkProgram.Proof(AccessControlProgram) {}
