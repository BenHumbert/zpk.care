/**
 * PCP Assignment — Primary Care Physician Assignment & Verification Tests
 *
 * Tests the PcpAssignmentData Struct, MEMBER tree integration,
 * forest root updates, and PcpVerificationProgram circuit logic.
 *
 * All tests are FAST (no ZkProgram compilation).
 * Circuit constraint logic is tested via direct field assertions.
 *
 * Run: npx jest tests/pcp.test.ts --verbose
 */
import { Field, Poseidon, MerkleTree } from 'o1js';
import { hashString, dateToField } from '../src/zkp/hash-utils.js';
import {
  MerkleForest,
  ForestDomain,
  ForestMerkleWitness,
  TREE_HEIGHT,
} from '../src/zkp/merkle-forest.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import {
  PcpAssignmentData,
  buildPcpAssignmentData,
  PCP_SCOPE_RX_HISTORY,
  PCP_SCOPE_ELIGIBILITY,
  PCP_SCOPE_ACCUMULATORS,
  PCP_SCOPE_ALL,
  PCP_ASSIGNMENT_LEAF_INDEX,
} from '../src/eligibility/pcp-assignment-data.js';
import type { PcpAssignmentLocalData } from '../src/eligibility/pcp-assignment-data.js';
import { PcpVerificationOutput } from '../src/eligibility/pcp-verification-program.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY, CREDENTIAL_TYPE_PRESCRIPTION } from '../src/credentials/credential-data.js';
import {
  EligibilityData,
  buildEligibilityData,
  COVERAGE_PHARMACY,
} from '../src/eligibility/eligibility-data.js';
import {
  AccumulatorData,
  buildAccumulatorData,
  ACCUMULATOR_LEAF_INDEX,
} from '../src/access-control/accumulator-data.js';

// ─── Test Data ─────────────────────────────────────────────

const MEMBER_WALLET_ID = Poseidon.hash([Field(1), Field(100), Field(200)]);
const PCP_WALLET_ID = Poseidon.hash([Field(2), Field(300), Field(400)]);
const OTHER_PRESCRIBER_WALLET_ID = Poseidon.hash([Field(2), Field(500), Field(600)]);
const ADMIN_WALLET_ID = Poseidon.hash([Field(0), Field(999)]);

const TODAY = '20260215';
const PAST_DATE = '20260101';
const FUTURE_DATE = '20261231';
const EXPIRED_DATE = '20250101';

const TEST_LOCAL_DATA: PcpAssignmentLocalData = {
  memberWalletId: MEMBER_WALLET_ID.toBigInt().toString(),
  pcpWalletId: PCP_WALLET_ID.toBigInt().toString(),
  effectiveDate: TODAY,
  terminationDate: '',
  specialty: 'Internal Medicine',
  consentTimestamp: TODAY,
  consentScopeFlags: 7,
};

// ─── PcpAssignmentData Struct ──────────────────────────────

describe('PcpAssignmentData', () => {
  test('constructs from Field values', () => {
    const data = new PcpAssignmentData({
      memberWalletId: MEMBER_WALLET_ID,
      pcpWalletId: PCP_WALLET_ID,
      effectiveDate: dateToField(TODAY),
      terminationDate: Field(0),
      specialtyHash: hashString('Internal Medicine'),
      consentTimestamp: dateToField(TODAY),
      consentScopeFlags: PCP_SCOPE_ALL,
    });

    expect(data.memberWalletId.toBigInt()).toEqual(MEMBER_WALLET_ID.toBigInt());
    expect(data.pcpWalletId.toBigInt()).toEqual(PCP_WALLET_ID.toBigInt());
    expect(data.terminationDate.toBigInt()).toEqual(0n);
    expect(data.consentScopeFlags.toBigInt()).toEqual(7n);
  });

  test('commitment is deterministic', () => {
    const data = buildPcpAssignmentData(TEST_LOCAL_DATA);
    const c1 = data.commitment();
    const c2 = data.commitment();
    expect(c1.toBigInt()).toEqual(c2.toBigInt());
  });

  test('commitment is a Poseidon hash of all 7 fields', () => {
    const data = buildPcpAssignmentData(TEST_LOCAL_DATA);
    const expected = Poseidon.hash([
      data.memberWalletId,
      data.pcpWalletId,
      data.effectiveDate,
      data.terminationDate,
      data.specialtyHash,
      data.consentTimestamp,
      data.consentScopeFlags,
    ]);
    expect(data.commitment().toBigInt()).toEqual(expected.toBigInt());
  });

  test('different PCP wallet produces different commitment', () => {
    const data1 = buildPcpAssignmentData(TEST_LOCAL_DATA);
    const data2 = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      pcpWalletId: OTHER_PRESCRIBER_WALLET_ID.toBigInt().toString(),
    });
    expect(data1.commitment().toBigInt()).not.toEqual(data2.commitment().toBigInt());
  });

  test('different scope flags produce different commitment', () => {
    const data1 = buildPcpAssignmentData(TEST_LOCAL_DATA);
    const data2 = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      consentScopeFlags: 1, // RX_HISTORY only
    });
    expect(data1.commitment().toBigInt()).not.toEqual(data2.commitment().toBigInt());
  });

  test('different specialty produces different commitment', () => {
    const data1 = buildPcpAssignmentData(TEST_LOCAL_DATA);
    const data2 = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      specialty: 'Family Medicine',
    });
    expect(data1.commitment().toBigInt()).not.toEqual(data2.commitment().toBigInt());
  });

  test('open-ended terminationDate builds as Field(0)', () => {
    const data = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      terminationDate: '',
    });
    expect(data.terminationDate.toBigInt()).toEqual(0n);
  });

  test('explicit terminationDate builds as date Field', () => {
    const data = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      terminationDate: FUTURE_DATE,
    });
    expect(data.terminationDate.toBigInt()).toEqual(BigInt(FUTURE_DATE));
  });
});

// ─── Scope Constants ───────────────────────────────────────

describe('PCP Scope Constants', () => {
  test('PCP_SCOPE_RX_HISTORY is Field(1)', () => {
    expect(PCP_SCOPE_RX_HISTORY.toBigInt()).toEqual(1n);
  });

  test('PCP_SCOPE_ELIGIBILITY is Field(2)', () => {
    expect(PCP_SCOPE_ELIGIBILITY.toBigInt()).toEqual(2n);
  });

  test('PCP_SCOPE_ACCUMULATORS is Field(4)', () => {
    expect(PCP_SCOPE_ACCUMULATORS.toBigInt()).toEqual(4n);
  });

  test('PCP_SCOPE_ALL is Field(7) — all bits set', () => {
    expect(PCP_SCOPE_ALL.toBigInt()).toEqual(7n);
  });

  test('PCP_ASSIGNMENT_LEAF_INDEX is 0n — leaf 0 of MEMBER tree', () => {
    expect(PCP_ASSIGNMENT_LEAF_INDEX).toEqual(0n);
  });
});

// ─── Builder ───────────────────────────────────────────────

describe('buildPcpAssignmentData', () => {
  test('converts local data to on-chain Struct', () => {
    const data = buildPcpAssignmentData(TEST_LOCAL_DATA);
    expect(data.memberWalletId.toBigInt()).toEqual(MEMBER_WALLET_ID.toBigInt());
    expect(data.pcpWalletId.toBigInt()).toEqual(PCP_WALLET_ID.toBigInt());
    expect(data.effectiveDate.toBigInt()).toEqual(BigInt(TODAY));
    expect(data.specialtyHash.toBigInt()).toEqual(hashString('Internal Medicine').toBigInt());
    expect(data.consentTimestamp.toBigInt()).toEqual(BigInt(TODAY));
    expect(data.consentScopeFlags.toBigInt()).toEqual(7n);
  });

  test('hashes specialty string via Poseidon', () => {
    const data = buildPcpAssignmentData(TEST_LOCAL_DATA);
    const expectedHash = hashString('Internal Medicine');
    expect(data.specialtyHash.toBigInt()).toEqual(expectedHash.toBigInt());
  });
});

// ─── MEMBER Tree Integration ───────────────────────────────

describe('MEMBER Tree Integration', () => {
  let forest: MerkleForest;
  let pcpData: PcpAssignmentData;

  beforeEach(() => {
    forest = new MerkleForest();
    pcpData = buildPcpAssignmentData(TEST_LOCAL_DATA);
  });

  test('MEMBER tree starts empty', () => {
    const leaf = forest.getLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);
    expect(leaf.toBigInt()).toEqual(0n);
  });

  test('writing PCP data changes the MEMBER tree root', () => {
    const rootBefore = forest.getTreeRoot(ForestDomain.MEMBER);
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());
    const rootAfter = forest.getTreeRoot(ForestDomain.MEMBER);
    expect(rootBefore.toBigInt()).not.toEqual(rootAfter.toBigInt());
  });

  test('writing PCP data changes the forest root', () => {
    const forestRootBefore = forest.getForestRoot();
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());
    const forestRootAfter = forest.getForestRoot();
    expect(forestRootBefore.toBigInt()).not.toEqual(forestRootAfter.toBigInt());
  });

  test('Merkle witness verifies PCP data in MEMBER tree', () => {
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());
    const witness = forest.getWitness(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);
    const computedRoot = witness.calculateRoot(pcpData.commitment());
    const treeRoot = forest.getTreeRoot(ForestDomain.MEMBER);
    expect(computedRoot.toBigInt()).toEqual(treeRoot.toBigInt());
  });

  test('ForestRoots.fromForest matches forest after PCP write', () => {
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());
    const forestRoots = ForestRoots.fromForest(forest);
    expect(forestRoots.memberRoot.toBigInt()).toEqual(
      forest.getTreeRoot(ForestDomain.MEMBER).toBigInt()
    );
    const computedForestRoot = forestRoots.computeForestRoot();
    expect(computedForestRoot.toBigInt()).toEqual(forest.getForestRoot().toBigInt());
  });

  test('other domain trees are unaffected by MEMBER tree write', () => {
    const prescriberBefore = forest.getTreeRoot(ForestDomain.PRESCRIBER);
    const pharmacyBefore = forest.getTreeRoot(ForestDomain.PHARMACY);
    const medicationBefore = forest.getTreeRoot(ForestDomain.MEDICATION);
    const accessControlBefore = forest.getTreeRoot(ForestDomain.ACCESS_CONTROL);
    const transactionBefore = forest.getTreeRoot(ForestDomain.TRANSACTION);

    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());

    expect(forest.getTreeRoot(ForestDomain.PRESCRIBER).toBigInt()).toEqual(prescriberBefore.toBigInt());
    expect(forest.getTreeRoot(ForestDomain.PHARMACY).toBigInt()).toEqual(pharmacyBefore.toBigInt());
    expect(forest.getTreeRoot(ForestDomain.MEDICATION).toBigInt()).toEqual(medicationBefore.toBigInt());
    expect(forest.getTreeRoot(ForestDomain.ACCESS_CONTROL).toBigInt()).toEqual(accessControlBefore.toBigInt());
    expect(forest.getTreeRoot(ForestDomain.TRANSACTION).toBigInt()).toEqual(transactionBefore.toBigInt());
  });
});

// ─── Credential Update Flow ───────────────────────────────────────

describe('Credential Forest Root Update', () => {
  let forest: MerkleForest;
  let pcpData: PcpAssignmentData;

  beforeEach(() => {
    forest = new MerkleForest();
    pcpData = buildPcpAssignmentData(TEST_LOCAL_DATA);
  });

  test('credential forestRoot must be updated after MEMBER tree write', () => {
    // Create initial credential with empty forest
    const credentialBefore = new CredentialData({
      credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: ADMIN_WALLET_ID,
      subjectWalletId: MEMBER_WALLET_ID,
      issuedAt: dateToField(TODAY),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // Write PCP data to MEMBER tree
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());

    // Forest root changed — old credential no longer matches
    expect(credentialBefore.forestRoot.toBigInt()).not.toEqual(forest.getForestRoot().toBigInt());

    // Update credential with new forest root
    const credentialAfter = new CredentialData({
      credentialType: credentialBefore.credentialType,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: credentialBefore.issuerWalletId,
      subjectWalletId: credentialBefore.subjectWalletId,
      issuedAt: credentialBefore.issuedAt,
      expiresAt: credentialBefore.expiresAt,
      revoked: credentialBefore.revoked,
    });

    // Updated credential matches forest
    expect(credentialAfter.forestRoot.toBigInt()).toEqual(forest.getForestRoot().toBigInt());

    // Credential commitment changed (different forestRoot)
    expect(credentialBefore.commitment().toBigInt()).not.toEqual(credentialAfter.commitment().toBigInt());
  });

  test('ForestRoots verification chain — full pipeline', () => {
    // Populate ACCESS_CONTROL tree like real enrollment does
    const eligData = buildEligibilityData({
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-001',
      coverageType: 1,
      copayAmount: 3000,
      effectiveDate: '20260101',
      terminationDate: '20261231',
      formularyRoot: '0',
    });
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligData.commitment());

    const accumData = buildAccumulatorData({
      planYear: '20260101',
      deductibleAmountCents: 50000,
      deductiblePaidCents: 0,
      oopMaxCents: 500000,
      oopPaidCents: 0,
      annualBenefitMaxCents: 0,
      annualBenefitUsedCents: 0,
    });
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accumData.commitment());

    // Record forest root BEFORE PCP assignment
    const forestRootBefore = forest.getForestRoot();

    // PCP assignment
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());
    const forestRootAfter = forest.getForestRoot();

    // Create updated credential
    const credential = new CredentialData({
      credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
      forestRoot: forestRootAfter,
      issuerWalletId: ADMIN_WALLET_ID,
      subjectWalletId: MEMBER_WALLET_ID,
      issuedAt: dateToField(TODAY),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // Verify full chain: ForestRoots → computeForestRoot → credential.forestRoot
    const forestRoots = ForestRoots.fromForest(forest);
    expect(forestRoots.computeForestRoot().toBigInt()).toEqual(credential.forestRoot.toBigInt());

    // Verify Merkle witness for PCP data
    const witness = forest.getWitness(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);
    const computedMemberRoot = witness.calculateRoot(pcpData.commitment());
    expect(computedMemberRoot.toBigInt()).toEqual(forestRoots.memberRoot.toBigInt());
  });
});

// ─── PcpVerificationOutput ─────────────────────────────────

describe('PcpVerificationOutput', () => {
  test('constructs with all fields', () => {
    const output = new PcpVerificationOutput({
      credentialCommitment: Field(123),
      memberWalletId: MEMBER_WALLET_ID,
      pcpWalletId: PCP_WALLET_ID,
      forestRoot: Field(456),
      consentScopeFlags: PCP_SCOPE_ALL,
    });
    expect(output.credentialCommitment.toBigInt()).toEqual(123n);
    expect(output.memberWalletId.toBigInt()).toEqual(MEMBER_WALLET_ID.toBigInt());
    expect(output.pcpWalletId.toBigInt()).toEqual(PCP_WALLET_ID.toBigInt());
    expect(output.forestRoot.toBigInt()).toEqual(456n);
    expect(output.consentScopeFlags.toBigInt()).toEqual(7n);
  });
});

// ─── Circuit Constraint Logic (fast, no compile) ───────────

describe('PcpVerification Constraint Logic', () => {
  let forest: MerkleForest;
  let pcpData: PcpAssignmentData;
  let credential: CredentialData;
  let forestRoots: ForestRoots;
  let memberWitness: ForestMerkleWitness;

  beforeEach(() => {
    forest = new MerkleForest();
    pcpData = buildPcpAssignmentData(TEST_LOCAL_DATA);

    // Write PCP to MEMBER tree
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());

    // Build credential with current forest root
    credential = new CredentialData({
      credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: ADMIN_WALLET_ID,
      subjectWalletId: MEMBER_WALLET_ID,
      issuedAt: dateToField(TODAY),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    forestRoots = ForestRoots.fromForest(forest);
    memberWitness = forest.getWitness(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);
  });

  test('constraint 1: credential type must be ELIGIBILITY', () => {
    expect(credential.credentialType.toBigInt()).toEqual(CREDENTIAL_TYPE_ELIGIBILITY.toBigInt());
    // A PRESCRIPTION credential would fail
    const rxCredential = new CredentialData({
      ...credential,
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
    });
    expect(rxCredential.credentialType.toBigInt()).not.toEqual(CREDENTIAL_TYPE_ELIGIBILITY.toBigInt());
  });

  test('constraint 2: credential must not be revoked', () => {
    expect(credential.revoked.toBigInt()).toEqual(0n);
    const revokedCredential = new CredentialData({
      ...credential,
      revoked: Field(1),
    });
    expect(revokedCredential.revoked.toBigInt()).not.toEqual(0n);
  });

  test('constraint 3: forest root integrity', () => {
    const computedForestRoot = forestRoots.computeForestRoot();
    expect(computedForestRoot.toBigInt()).toEqual(credential.forestRoot.toBigInt());
  });

  test('constraint 3 fails: tampered forest roots', () => {
    const tampered = new ForestRoots({
      ...forestRoots,
      memberRoot: Field(999),
    });
    const computedForestRoot = tampered.computeForestRoot();
    expect(computedForestRoot.toBigInt()).not.toEqual(credential.forestRoot.toBigInt());
  });

  test('constraint 4: PCP data exists in MEMBER tree', () => {
    const computedMemberRoot = memberWitness.calculateRoot(pcpData.commitment());
    expect(computedMemberRoot.toBigInt()).toEqual(forestRoots.memberRoot.toBigInt());
  });

  test('constraint 4 fails: wrong PCP data', () => {
    const wrongPcpData = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      pcpWalletId: OTHER_PRESCRIBER_WALLET_ID.toBigInt().toString(),
    });
    const computedRoot = memberWitness.calculateRoot(wrongPcpData.commitment());
    expect(computedRoot.toBigInt()).not.toEqual(forestRoots.memberRoot.toBigInt());
  });

  test('constraint 5: claimed PCP matches assigned PCP', () => {
    expect(PCP_WALLET_ID.toBigInt()).toEqual(pcpData.pcpWalletId.toBigInt());
  });

  test('constraint 5 fails: wrong prescriber claims PCP', () => {
    expect(OTHER_PRESCRIBER_WALLET_ID.toBigInt()).not.toEqual(
      pcpData.pcpWalletId.toBigInt()
    );
  });

  test('constraint 6: effective date <= current date', () => {
    const currentDate = dateToField(TODAY);
    const effective = pcpData.effectiveDate;
    expect(effective.toBigInt() <= currentDate.toBigInt()).toBe(true);
  });

  test('constraint 6 fails: future effective date', () => {
    const futurePcpData = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      effectiveDate: FUTURE_DATE,
    });
    const currentDate = dateToField(TODAY);
    expect(futurePcpData.effectiveDate.toBigInt() <= currentDate.toBigInt()).toBe(false);
  });

  test('constraint 7: open-ended terminationDate (Field(0)) always valid', () => {
    expect(pcpData.terminationDate.toBigInt()).toEqual(0n);
    // Convention: terminationDate == 0 means no end date
    const noEndDate = pcpData.terminationDate.toBigInt() === 0n;
    expect(noEndDate).toBe(true);
  });

  test('constraint 7: currentDate within termination range', () => {
    const terminatedPcpData = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      terminationDate: FUTURE_DATE,
    });
    const currentDate = dateToField(TODAY);
    const beforeTermination = currentDate.toBigInt() <= terminatedPcpData.terminationDate.toBigInt();
    expect(beforeTermination).toBe(true);
  });

  test('constraint 7 fails: expired PCP assignment', () => {
    const expiredPcpData = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      effectiveDate: EXPIRED_DATE,
      terminationDate: EXPIRED_DATE,
    });
    const currentDate = dateToField(TODAY);
    const noEndDate = expiredPcpData.terminationDate.toBigInt() === 0n;
    const beforeTermination = currentDate.toBigInt() <= expiredPcpData.terminationDate.toBigInt();
    expect(noEndDate || beforeTermination).toBe(false);
  });

  test('constraint 8: consent scope must be non-empty', () => {
    expect(pcpData.consentScopeFlags.toBigInt() > 0n).toBe(true);
  });

  test('constraint 8 fails: empty consent scope', () => {
    const noConsentData = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      consentScopeFlags: 0,
    });
    expect(noConsentData.consentScopeFlags.toBigInt() > 0n).toBe(false);
  });

  test('public output correctness', () => {
    const output = new PcpVerificationOutput({
      credentialCommitment: credential.commitment(),
      memberWalletId: pcpData.memberWalletId,
      pcpWalletId: pcpData.pcpWalletId,
      forestRoot: credential.forestRoot,
      consentScopeFlags: pcpData.consentScopeFlags,
    });
    expect(output.credentialCommitment.toBigInt()).toEqual(credential.commitment().toBigInt());
    expect(output.memberWalletId.toBigInt()).toEqual(MEMBER_WALLET_ID.toBigInt());
    expect(output.pcpWalletId.toBigInt()).toEqual(PCP_WALLET_ID.toBigInt());
    expect(output.forestRoot.toBigInt()).toEqual(forest.getForestRoot().toBigInt());
    expect(output.consentScopeFlags.toBigInt()).toEqual(7n);
  });
});

// ─── PCP Reassignment ──────────────────────────────────────

describe('PCP Reassignment', () => {
  test('overwriting MEMBER tree leaf changes commitment and forest root', () => {
    const forest = new MerkleForest();

    // First PCP assignment
    const pcp1 = buildPcpAssignmentData(TEST_LOCAL_DATA);
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcp1.commitment());
    const root1 = forest.getForestRoot();

    // Reassign to a different PCP
    const pcp2 = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      pcpWalletId: OTHER_PRESCRIBER_WALLET_ID.toBigInt().toString(),
      specialty: 'Family Medicine',
    });
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcp2.commitment());
    const root2 = forest.getForestRoot();

    expect(root1.toBigInt()).not.toEqual(root2.toBigInt());
    expect(pcp1.commitment().toBigInt()).not.toEqual(pcp2.commitment().toBigInt());

    // Witness for new PCP data is valid
    const witness = forest.getWitness(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);
    const computedRoot = witness.calculateRoot(pcp2.commitment());
    expect(computedRoot.toBigInt()).toEqual(
      forest.getTreeRoot(ForestDomain.MEMBER).toBigInt()
    );
  });

  test('old witness is invalid after reassignment', () => {
    const forest = new MerkleForest();

    // First PCP
    const pcp1 = buildPcpAssignmentData(TEST_LOCAL_DATA);
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcp1.commitment());
    const oldWitness = forest.getWitness(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);

    // Reassign
    const pcp2 = buildPcpAssignmentData({
      ...TEST_LOCAL_DATA,
      pcpWalletId: OTHER_PRESCRIBER_WALLET_ID.toBigInt().toString(),
    });
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcp2.commitment());

    // Old witness + old data doesn't match new MEMBER root
    const computedRoot = oldWitness.calculateRoot(pcp1.commitment());
    expect(computedRoot.toBigInt()).not.toEqual(
      forest.getTreeRoot(ForestDomain.MEMBER).toBigInt()
    );
  });
});

// ─── Coexistence with ACCESS_CONTROL Data ──────────────────

describe('MEMBER + ACCESS_CONTROL Coexistence', () => {
  test('PCP write to MEMBER tree does not affect ACCESS_CONTROL tree', () => {
    const forest = new MerkleForest();

    // Simulate enrollment: populate ACCESS_CONTROL
    const eligData = buildEligibilityData({
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-001',
      coverageType: 1,
      copayAmount: 3000,
      effectiveDate: '20260101',
      terminationDate: '20261231',
      formularyRoot: '0',
    });
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligData.commitment());

    const accumData = buildAccumulatorData({
      planYear: '20260101',
      deductibleAmountCents: 50000,
      deductiblePaidCents: 0,
      oopMaxCents: 500000,
      oopPaidCents: 0,
      annualBenefitMaxCents: 0,
      annualBenefitUsedCents: 0,
    });
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accumData.commitment());

    const accessControlRootBefore = forest.getTreeRoot(ForestDomain.ACCESS_CONTROL);

    // PCP assignment in MEMBER tree
    const pcpData = buildPcpAssignmentData(TEST_LOCAL_DATA);
    forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());

    // ACCESS_CONTROL tree unchanged
    expect(forest.getTreeRoot(ForestDomain.ACCESS_CONTROL).toBigInt()).toEqual(
      accessControlRootBefore.toBigInt()
    );

    // Both trees' witnesses remain valid
    const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
    expect(eligWitness.calculateRoot(eligData.commitment()).toBigInt()).toEqual(
      accessControlRootBefore.toBigInt()
    );

    const pcpWitness = forest.getWitness(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);
    expect(pcpWitness.calculateRoot(pcpData.commitment()).toBigInt()).toEqual(
      forest.getTreeRoot(ForestDomain.MEMBER).toBigInt()
    );
  });
});
