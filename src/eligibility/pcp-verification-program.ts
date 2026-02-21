import { Field, Struct, ZkProgram } from 'o1js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../credentials/credential-data.js';
import { ForestMerkleWitness } from '../zkp/merkle-forest.js';
import { ForestRoots } from './forest-roots.js';
import { PcpAssignmentData } from './pcp-assignment-data.js';

// ─── PcpVerificationOutput ──────────────────────────────────

/**
 * PcpVerificationOutput — public output of PcpVerificationProgram.
 *
 * Contains the credential commitment, member wallet, verified PCP wallet,
 * and consent scope. A verifier can confirm that:
 *   1. The prescriber is the member's assigned PCP
 *   2. The assignment exists in the member's eligibility credential
 *   3. The member consented to data sharing with specific scope
 */
export class PcpVerificationOutput extends Struct({
  /** Commitment of the ELIGIBILITY credential containing the PCP assignment */
  credentialCommitment: Field,
  /** Member wallet ID (the patient) */
  memberWalletId: Field,
  /** PCP prescriber wallet ID (verified as assigned) */
  pcpWalletId: Field,
  /** Forest root from credential (anchors to on-chain state) */
  forestRoot: Field,
  /** Consent scope flags (what data the PCP can access) */
  consentScopeFlags: Field,
}) {}

// ─── PcpVerificationProgram ─────────────────────────────────

/**
 * PcpVerificationProgram — ZkProgram for PCP assignment verification.
 *
 * STANDALONE (no recursion) — proves that a specific prescriber is
 * the member's assigned PCP by verifying the PcpAssignmentData exists
 * in the MEMBER domain tree of the member's eligibility credential.
 *
 * This proof serves dual purpose:
 *   1. Authorization — the prescriber IS the assigned PCP
 *   2. Consent verification — the member consented to data sharing
 *
 * The ZK proof IS the consent. No separate consent form needed.
 * The consentScopeFlags in the output tell the system what data
 * the PCP is authorized to view.
 *
 * Wallet ownership is NOT verified here — that's ProofGateProgram's job.
 * This program only verifies the PCP assignment relationship.
 */
export const PcpVerificationProgram = ZkProgram({
  name: 'PcpVerification',
  publicOutput: PcpVerificationOutput,

  methods: {
    /**
     * Prove that a prescriber is the member's assigned PCP.
     *
     * Verifies:
     *   1. Credential type is ELIGIBILITY
     *   2. Credential is not revoked
     *   3. Forest root integrity (6 tree roots hash to credential's forestRoot)
     *   4. PCP assignment data exists in the MEMBER domain tree
     *   5. Claimed prescriber wallet matches the assigned PCP
     *   6. Current date is within effective/termination date range
     *   7. Consent scope is non-empty
     */
    verifyPcpAssignment: {
      privateInputs: [
        CredentialData,
        PcpAssignmentData,
        ForestRoots,
        ForestMerkleWitness,   // witness for PCP data in MEMBER tree
        Field,                  // claimedPcpWalletId
        Field,                  // currentDate (CCYYMMDD as number)
      ],
      async method(
        credentialData: CredentialData,
        pcpData: PcpAssignmentData,
        forestRoots: ForestRoots,
        memberWitness: ForestMerkleWitness,
        claimedPcpWalletId: Field,
        currentDate: Field,
      ) {
        // 1. Verify credential type is ELIGIBILITY
        credentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_ELIGIBILITY,
          'Credential type must be ELIGIBILITY',
        );

        // 2. Verify credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        // 3. Verify forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          credentialData.forestRoot,
          'Forest root mismatch — tree roots do not compose to credential forestRoot',
        );

        // 4. Verify PCP assignment data exists in the MEMBER tree
        const pcpCommitment = pcpData.commitment();
        const computedMemberRoot = memberWitness.calculateRoot(pcpCommitment);
        computedMemberRoot.assertEquals(
          forestRoots.memberRoot,
          'PCP assignment data not found in MEMBER tree',
        );

        // 5. Verify claimed prescriber matches the assigned PCP
        claimedPcpWalletId.assertEquals(
          pcpData.pcpWalletId,
          'Prescriber is not the assigned PCP',
        );

        // 6. Verify date range: effectiveDate <= currentDate
        pcpData.effectiveDate
          .lessThanOrEqual(currentDate)
          .assertTrue('PCP assignment not yet effective');

        // 7. Verify date range: currentDate <= terminationDate OR terminationDate == 0
        const noEndDate = pcpData.terminationDate.equals(Field(0));
        const beforeTermination = currentDate.lessThanOrEqual(
          pcpData.terminationDate,
        );
        noEndDate.or(beforeTermination).assertTrue('PCP assignment has expired');

        // 8. Verify consent scope is non-empty
        pcpData.consentScopeFlags.assertGreaterThan(
          Field(0),
          'Consent scope must not be empty',
        );

        return {
          publicOutput: new PcpVerificationOutput({
            credentialCommitment: credentialData.commitment(),
            memberWalletId: pcpData.memberWalletId,
            pcpWalletId: pcpData.pcpWalletId,
            forestRoot: credentialData.forestRoot,
            consentScopeFlags: pcpData.consentScopeFlags,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility */
export class PcpVerificationProof extends ZkProgram.Proof(PcpVerificationProgram) {}
