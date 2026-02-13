import {
  Field,
  Poseidon,
  MerkleTree,
  Mina,
  PrivateKey,
  AccountUpdate,
} from 'o1js';
import {
  EligibilityData,
  COVERAGE_PHARMACY,
  COVERAGE_MEDICAL,
  COVERAGE_DENTAL,
  buildEligibilityData,
} from '../src/eligibility/eligibility-data.js';
import type { EligibilityLocalData } from '../src/eligibility/eligibility-data.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import {
  BenefitPlanRegistry,
  BENEFIT_PLAN_TREE_HEIGHT,
} from '../src/eligibility/benefit-plan-registry.js';
import {
  EligibilityProgram,
  EligibilityOutput,
  InNetworkProgram,
  InNetworkOutput,
} from '../src/eligibility/eligibility-program.js';
import { EligibilityService } from '../src/eligibility/eligibility-service.js';
import { VerificationService } from '../src/eligibility/verification-service.js';
import { NftData, NFT_TYPE_ELIGIBILITY, NFT_TYPE_PRESCRIPTION } from '../src/nft/nft-data.js';
import { NftInventory } from '../src/nft/nft-inventory.js';
import { NftProgram } from '../src/nft/nft-program.js';
import { serializeCredential } from '../src/nft/portable-credential.js';
import { CareContract, NftRegistryWitness } from '../src/engine/care-contract.js';
import {
  LIFECYCLE_REGISTERED,
  LIFECYCLE_ELIGIBLE,
  LIFECYCLE_ACTIVE,
  LIFECYCLE_REVOKED,
  lifecycleLeafCommitment,
  LifecycleWitness,
} from '../src/engine/lifecycle.js';
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  ProofGateProgram,
} from '../src/wallets/index.js';
import {
  WalletRegistry,
  WalletState,
  WalletRegistryWitness,
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { MerkleForest, ForestDomain, ForestMerkleWitness } from '../src/zkp/merkle-forest.js';
import { hashString, dateToField } from '../src/zkp/hash-utils.js';
import type { MemberLocalData } from '../src/models/member.js';
import type { PrescriberLocalData } from '../src/models/prescriber.js';
import type { PharmacyLocalData } from '../src/models/pharmacy.js';

// ─── Test Data ───────────────────────────────────────────

const testMember: MemberLocalData = {
  cardholderId: 'CARD123456789',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'John',
  lastName: 'Doe',
};

const testPrescriber: PrescriberLocalData = {
  prescriberIdQualifier: 1,
  prescriberId: '1234567890',
};

const testPharmacy: PharmacyLocalData = {
  serviceProviderIdQualifier: 1,
  serviceProviderId: '9876543210',
};

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

// Wallet IDs
const memberWalletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
const prescriberWalletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
const pharmacyWalletId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);

// Sample eligibility data
const sampleEligLocalData: EligibilityLocalData = {
  planId: 'PLAN-RX-2026',
  groupId: 'GRP-ACME-001',
  effectiveDate: '20260101',
  terminationDate: '20261231',
  copayAmount: 2000, // $20.00 in cents
  coverageType: 1,   // pharmacy
  formularyRoot: '0', // empty formulary for testing
};

/** Helper: create a standard EligibilityData for tests */
function createTestEligibilityData(): EligibilityData {
  return new EligibilityData({
    planIdHash: hashString('PLAN-RX-2026'),
    groupIdHash: hashString('GRP-ACME-001'),
    effectiveDate: Field(20260101),
    terminationDate: Field(20261231),
    copayAmountCents: Field(2000),
    coverageType: COVERAGE_PHARMACY,
    formularyRoot: Field(0),
  });
}

/** Helper: create a MerkleForest with eligibility data in ACCESS_CONTROL tree */
function createTestForest(eligData: EligibilityData, leafIndex: bigint = 0n): MerkleForest {
  const forest = new MerkleForest();
  // Put member data in MEMBER tree
  forest.setLeaf(ForestDomain.MEMBER, 0n, Poseidon.hash([Field(42)]));
  // Put eligibility data in ACCESS_CONTROL tree
  forest.setLeaf(ForestDomain.ACCESS_CONTROL, leafIndex, eligData.commitment());
  return forest;
}

/** Helper: create an ELIGIBILITY NFT from eligibility data + forest */
function createTestEligibilityNft(
  forest: MerkleForest,
  subject: Field = memberWalletId,
  issuer: Field = prescriberWalletId,
): NftData {
  return new NftData({
    nftType: NFT_TYPE_ELIGIBILITY,
    forestRoot: forest.getForestRoot(),
    issuerWalletId: issuer,
    subjectWalletId: subject,
    issuedAt: Field(20260201),
    expiresAt: Field(20270201),
    revoked: Field(0),
  });
}

// ─── Tests ───────────────────────────────────────────────

describe('Layer 5 — Eligibility Flow (Use Cases A + C)', () => {
  // ─── EligibilityData Model ─────────────────────────────

  describe('EligibilityData Model', () => {
    test('commitment is deterministic', () => {
      const ed1 = createTestEligibilityData();
      const ed2 = createTestEligibilityData();
      expect(ed1.commitment().toString()).toBe(ed2.commitment().toString());
    });

    test('commitment changes when any field changes', () => {
      const base = createTestEligibilityData();
      const baseCommitment = base.commitment().toString();

      // Change planIdHash
      const ed2 = new EligibilityData({ ...base, planIdHash: Field(999) });
      expect(ed2.commitment().toString()).not.toBe(baseCommitment);

      // Change effectiveDate
      const ed3 = new EligibilityData({ ...base, effectiveDate: Field(20250101) });
      expect(ed3.commitment().toString()).not.toBe(baseCommitment);

      // Change copayAmountCents
      const ed4 = new EligibilityData({ ...base, copayAmountCents: Field(5000) });
      expect(ed4.commitment().toString()).not.toBe(baseCommitment);

      // Change coverageType
      const ed5 = new EligibilityData({ ...base, coverageType: COVERAGE_MEDICAL });
      expect(ed5.commitment().toString()).not.toBe(baseCommitment);
    });

    test('coverage type constants have correct values', () => {
      expect(COVERAGE_PHARMACY.toString()).toBe('1');
      expect(COVERAGE_MEDICAL.toString()).toBe('2');
      expect(COVERAGE_DENTAL.toString()).toBe('3');
    });

    test('buildEligibilityData from local data', () => {
      const ed = buildEligibilityData(sampleEligLocalData);
      expect(ed.planIdHash.toString()).toBe(hashString('PLAN-RX-2026').toString());
      expect(ed.groupIdHash.toString()).toBe(hashString('GRP-ACME-001').toString());
      expect(ed.effectiveDate.toString()).toBe('20260101');
      expect(ed.terminationDate.toString()).toBe('20261231');
      expect(ed.copayAmountCents.toString()).toBe('2000');
      expect(ed.coverageType.toString()).toBe('1');
    });

    test('commitment matches manual Poseidon.hash of 7 fields', () => {
      const ed = createTestEligibilityData();
      const manual = Poseidon.hash([
        ed.planIdHash,
        ed.groupIdHash,
        ed.effectiveDate,
        ed.terminationDate,
        ed.copayAmountCents,
        ed.coverageType,
        ed.formularyRoot,
      ]);
      expect(ed.commitment().toString()).toBe(manual.toString());
    });
  });

  // ─── BenefitPlanRegistry ───────────────────────────────

  describe('BenefitPlanRegistry', () => {
    test('empty registry has correct root', () => {
      const registry = new BenefitPlanRegistry();
      const emptyTree = new MerkleTree(BENEFIT_PLAN_TREE_HEIGHT);
      expect(registry.getRoot().toString()).toBe(emptyTree.getRoot().toString());
    });

    test('addPlan changes root', () => {
      const registry = new BenefitPlanRegistry();
      const oldRoot = registry.getRoot();
      const ed = createTestEligibilityData();

      const { index, newRoot } = registry.addPlan(ed);
      expect(index).toBe(0n);
      expect(newRoot.toString()).not.toBe(oldRoot.toString());
      expect(registry.getRoot().toString()).toBe(newRoot.toString());
    });

    test('witness proves plan inclusion', () => {
      const registry = new BenefitPlanRegistry();
      const ed = createTestEligibilityData();
      const { index } = registry.addPlan(ed);

      const witness = registry.getPlanWitness(index);
      const computedRoot = witness.calculateRoot(ed.commitment());
      expect(computedRoot.toString()).toBe(registry.getRoot().toString());
    });

    test('count tracks plans correctly', () => {
      const registry = new BenefitPlanRegistry();
      expect(registry.count).toBe(0);

      registry.addPlan(createTestEligibilityData());
      expect(registry.count).toBe(1);

      const ed2 = new EligibilityData({
        ...createTestEligibilityData(),
        planIdHash: Field(888),
      });
      registry.addPlan(ed2);
      expect(registry.count).toBe(2);
    });
  });

  // ─── ForestRoots ───────────────────────────────────────

  describe('ForestRoots', () => {
    test('computeForestRoot matches MerkleForest.getForestRoot()', () => {
      const forest = new MerkleForest();
      forest.setLeaf(ForestDomain.MEMBER, 0n, Poseidon.hash([Field(42)]));
      forest.setLeaf(ForestDomain.MEDICATION, 0n, Poseidon.hash([Field(99)]));

      const forestRoots = ForestRoots.fromForest(forest);
      const computedRoot = forestRoots.computeForestRoot();

      expect(computedRoot.toString()).toBe(forest.getForestRoot().toString());
    });

    test('different roots produce different forest roots', () => {
      const forest1 = new MerkleForest();
      const forest2 = new MerkleForest();
      forest2.setLeaf(ForestDomain.MEMBER, 0n, Poseidon.hash([Field(42)]));

      const roots1 = ForestRoots.fromForest(forest1);
      const roots2 = ForestRoots.fromForest(forest2);

      expect(roots1.computeForestRoot().toString())
        .not.toBe(roots2.computeForestRoot().toString());
    });

    test('fromForest constructs correctly from MerkleForest', () => {
      const forest = new MerkleForest();
      forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, Poseidon.hash([Field(7)]));

      const roots = ForestRoots.fromForest(forest);
      expect(roots.memberRoot.toString())
        .toBe(forest.getTreeRoot(ForestDomain.MEMBER).toString());
      expect(roots.accessControlRoot.toString())
        .toBe(forest.getTreeRoot(ForestDomain.ACCESS_CONTROL).toString());
      expect(roots.transactionRoot.toString())
        .toBe(forest.getTreeRoot(ForestDomain.TRANSACTION).toString());
    });
  });

  // ─── EligibilityProgram — proveEligibility ─────────────

  describe('EligibilityProgram — proveEligibility', () => {
    beforeAll(async () => {
      // EligibilityProgram is standalone (no recursion) — should compile fast
      await EligibilityProgram.compile();
    });

    test('valid eligibility generates proof', async () => {
      const eligData = createTestEligibilityData();
      const planRegistry = new BenefitPlanRegistry();
      const { index: planIndex } = planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(planIndex);
      const currentDate = Field(20260601); // within effective range

      const result = await EligibilityProgram.proveEligibility(
        nftData,
        eligData,
        forestRoots,
        forestWitness,
        planWitness,
        planRegistry.getRoot(),
        currentDate,
      );

      expect(result.proof).toBeDefined();
      const output = result.proof.publicOutput as unknown as EligibilityOutput;
      expect(output.nftCommitment.toString()).toBe(nftData.commitment().toString());
      expect(output.benefitPlanCommitment.toString()).toBe(eligData.commitment().toString());
      expect(output.forestRoot.toString()).toBe(nftData.forestRoot.toString());
      expect(output.coverageType.toString()).toBe(COVERAGE_PHARMACY.toString());
    });

    test('proof verifies standalone', async () => {
      const eligData = createTestEligibilityData();
      const planRegistry = new BenefitPlanRegistry();
      const { index: planIndex } = planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(planIndex);

      const result = await EligibilityProgram.proveEligibility(
        nftData, eligData, forestRoots, forestWitness,
        planWitness, planRegistry.getRoot(), Field(20260601),
      );

      const isValid = await EligibilityProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });

    test('rejects wrong NFT type', async () => {
      const eligData = createTestEligibilityData();
      const planRegistry = new BenefitPlanRegistry();
      const { index: planIndex } = planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      // Create a PRESCRIPTION NFT instead of ELIGIBILITY
      const wrongNft = new NftData({
        nftType: NFT_TYPE_PRESCRIPTION,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: prescriberWalletId,
        subjectWalletId: pharmacyWalletId,
        issuedAt: Field(20260201),
        expiresAt: Field(20270201),
        revoked: Field(0),
      });

      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(planIndex);

      await expect(
        EligibilityProgram.proveEligibility(
          wrongNft, eligData, forestRoots, forestWitness,
          planWitness, planRegistry.getRoot(), Field(20260601),
        ),
      ).rejects.toThrow();
    });

    test('rejects revoked NFT', async () => {
      const eligData = createTestEligibilityData();
      const planRegistry = new BenefitPlanRegistry();
      const { index: planIndex } = planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      const revokedNft = new NftData({
        nftType: NFT_TYPE_ELIGIBILITY,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: prescriberWalletId,
        subjectWalletId: memberWalletId,
        issuedAt: Field(20260201),
        expiresAt: Field(20270201),
        revoked: Field(1), // REVOKED
      });

      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(planIndex);

      await expect(
        EligibilityProgram.proveEligibility(
          revokedNft, eligData, forestRoots, forestWitness,
          planWitness, planRegistry.getRoot(), Field(20260601),
        ),
      ).rejects.toThrow();
    });

    test('rejects expired eligibility', async () => {
      const eligData = createTestEligibilityData(); // terminationDate = 20261231
      const planRegistry = new BenefitPlanRegistry();
      const { index: planIndex } = planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(planIndex);

      const expiredDate = Field(20270115); // past termination

      await expect(
        EligibilityProgram.proveEligibility(
          nftData, eligData, forestRoots, forestWitness,
          planWitness, planRegistry.getRoot(), expiredDate,
        ),
      ).rejects.toThrow();
    });

    test('rejects plan not in benefit plan tree', async () => {
      const eligData = createTestEligibilityData();
      // Don't add plan to registry — empty registry
      const planRegistry = new BenefitPlanRegistry();

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      // Witness for index 0 in empty tree
      const planWitness = planRegistry.getPlanWitness(0n);

      await expect(
        EligibilityProgram.proveEligibility(
          nftData, eligData, forestRoots, forestWitness,
          planWitness, planRegistry.getRoot(), Field(20260601),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── InNetworkProgram — proveInNetwork ─────────────────

  describe('InNetworkProgram — proveInNetwork', () => {
    beforeAll(async () => {
      // InNetworkProgram is recursive — needs ProofGateProgram compiled first
      await ProofGateProgram.compile();
      await InNetworkProgram.compile();
    });

    /** Helper: set up lifecycle tree with a wallet at a given lifecycle state */
    function setupLifecycleTree(walletId: Field, lifecycle: Field) {
      const tree = new MerkleTree(WALLET_TREE_HEIGHT);
      const leaf = lifecycleLeafCommitment(walletId, lifecycle);
      tree.setLeaf(0n, leaf);
      return tree;
    }

    test('ELIGIBLE lifecycle generates valid proof', async () => {
      const tree = setupLifecycleTree(prescriberWalletId, LIFECYCLE_ELIGIBLE);
      const witness = new LifecycleWitness(tree.getWitness(0n));
      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyPrescriber(
        prescriberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const result = await InNetworkProgram.proveInNetwork(
        pgResult.proof,
        LIFECYCLE_ELIGIBLE,
        witness,
        tree.getRoot(),
      );

      expect(result.proof).toBeDefined();
      const output = result.proof.publicOutput as unknown as InNetworkOutput;
      expect(output.walletId.toString()).toBe(prescriberWalletId.toString());
      expect(output.lifecycleRoot.toString()).toBe(tree.getRoot().toString());
    });

    test('ACTIVE lifecycle generates valid proof', async () => {
      const tree = setupLifecycleTree(pharmacyWalletId, LIFECYCLE_ACTIVE);
      const witness = new LifecycleWitness(tree.getWitness(0n));
      const preimage = pharmacyWalletPreimage(testPharmacy, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const result = await InNetworkProgram.proveInNetwork(
        pgResult.proof,
        LIFECYCLE_ACTIVE,
        witness,
        tree.getRoot(),
      );

      const isValid = await InNetworkProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });

    test('REGISTERED lifecycle rejects (not in-network)', async () => {
      const tree = setupLifecycleTree(prescriberWalletId, LIFECYCLE_REGISTERED);
      const witness = new LifecycleWitness(tree.getWitness(0n));
      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyPrescriber(
        prescriberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      await expect(
        InNetworkProgram.proveInNetwork(
          pgResult.proof,
          LIFECYCLE_REGISTERED,
          witness,
          tree.getRoot(),
        ),
      ).rejects.toThrow();
    });

    test('REVOKED lifecycle rejects', async () => {
      const tree = setupLifecycleTree(prescriberWalletId, LIFECYCLE_REVOKED);
      const witness = new LifecycleWitness(tree.getWitness(0n));
      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyPrescriber(
        prescriberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      await expect(
        InNetworkProgram.proveInNetwork(
          pgResult.proof,
          LIFECYCLE_REVOKED,
          witness,
          tree.getRoot(),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── EligibilityService ────────────────────────────────

  describe('EligibilityService', () => {
    test('buildEligibilityNft creates correct NftData', () => {
      const store = new InMemoryStore();
      const registry = new WalletRegistry();
      const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      const planRegistry = new BenefitPlanRegistry();
      const service = new EligibilityService(
        store, registry, lifecycleTree, planRegistry, prescriberWalletId,
      );

      const eligData = createTestEligibilityData();
      const forest = new MerkleForest();

      const nftData = service.buildEligibilityNft(
        memberWalletId, eligData, forest, 0n, Field(20260201),
      );

      expect(nftData.nftType.toString()).toBe(NFT_TYPE_ELIGIBILITY.toString());
      expect(nftData.subjectWalletId.toString()).toBe(memberWalletId.toString());
      expect(nftData.issuerWalletId.toString()).toBe(prescriberWalletId.toString());
      expect(nftData.revoked.toString()).toBe('0');
      // Forest root should have the eligibility data in it now
      expect(nftData.forestRoot.toString()).toBe(forest.getForestRoot().toString());
    });

    test('mintEligibilityNft updates inventory and registry', async () => {
      const store = new InMemoryStore();
      const registry = new WalletRegistry();
      const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      const planRegistry = new BenefitPlanRegistry();
      const eligData = createTestEligibilityData();
      planRegistry.addPlan(eligData);

      registry.register(memberWalletId);

      const service = new EligibilityService(
        store, registry, lifecycleTree, planRegistry, prescriberWalletId,
      );
      const inventory = new NftInventory();
      const forest = new MerkleForest();

      const result = await service.mintEligibilityNft(
        memberWalletId, eligData, forest, inventory,
        0n, 0n, Field(20260601), Field(20260201),
      );

      expect(result.nftIndex).toBe(0n);
      expect(inventory.count).toBe(1);
      expect(result.newInventoryRoot.toString()).toBe(inventory.getRoot().toString());
      expect(result.nftData.nftType.toString()).toBe(NFT_TYPE_ELIGIBILITY.toString());
    });

    test('proveEligibility generates verifiable proof', async () => {
      const planRegistry = new BenefitPlanRegistry();
      const eligData = createTestEligibilityData();
      const { index: planIndex } = planRegistry.addPlan(eligData);

      const store = new InMemoryStore();
      const registry = new WalletRegistry();
      const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      const service = new EligibilityService(
        store, registry, lifecycleTree, planRegistry, prescriberWalletId,
      );

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);

      const proof = await service.proveEligibility(
        nftData, eligData, forest, 0n, planIndex, Field(20260601),
      );

      const isValid = await EligibilityProgram.verify(proof);
      expect(isValid).toBe(true);
    });

    test('proveInNetwork generates verifiable proof', async () => {
      const store = new InMemoryStore();
      const registry = new WalletRegistry();
      const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      const planRegistry = new BenefitPlanRegistry();

      // Register prescriber and set lifecycle to ELIGIBLE
      const prescriberIndex = registry.register(prescriberWalletId);
      const lifecycleLeaf = lifecycleLeafCommitment(prescriberWalletId, LIFECYCLE_ELIGIBLE);
      lifecycleTree.setLeaf(prescriberIndex, lifecycleLeaf);

      const service = new EligibilityService(
        store, registry, lifecycleTree, planRegistry, prescriberWalletId,
      );

      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);
      const proof = await service.proveInNetwork(
        preimage, 'prescriber', prescriberWalletId, LIFECYCLE_ELIGIBLE,
      );

      const isValid = await InNetworkProgram.verify(proof);
      expect(isValid).toBe(true);
    });

    test('full flow: determine eligibility → mint NFT → verify', async () => {
      const store = new InMemoryStore();
      const registry = new WalletRegistry();
      const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      const planRegistry = new BenefitPlanRegistry();
      const eligData = createTestEligibilityData();
      planRegistry.addPlan(eligData);

      // Register member
      registry.register(memberWalletId);

      const service = new EligibilityService(
        store, registry, lifecycleTree, planRegistry, prescriberWalletId,
      );
      const inventory = new NftInventory();
      const forest = new MerkleForest();

      // Insurer mints eligibility NFT
      const mintResult = await service.mintEligibilityNft(
        memberWalletId, eligData, forest, inventory,
        0n, 0n, Field(20260601), Field(20260201),
      );

      // Verify the eligibility proof
      const isValid = await EligibilityProgram.verify(mintResult.eligibilityProof);
      expect(isValid).toBe(true);

      // Verify NFT is in inventory
      const storedNft = inventory.getNft(mintResult.nftIndex);
      expect(storedNft).toBeDefined();
      expect(storedNft!.nftType.toString()).toBe(NFT_TYPE_ELIGIBILITY.toString());
    });
  });

  // ─── VerificationService ───────────────────────────────

  describe('VerificationService', () => {
    const verificationService = new VerificationService();

    test('verifyEligibilityData accepts valid proof', async () => {
      const eligData = createTestEligibilityData();
      const planRegistry = new BenefitPlanRegistry();
      planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(0n);

      const result = await EligibilityProgram.proveEligibility(
        nftData, eligData, forestRoots, forestWitness,
        planWitness, planRegistry.getRoot(), Field(20260601),
      );

      const verResult = await verificationService.verifyEligibilityData(result.proof);
      expect(verResult.isValid).toBe(true);
      expect(verResult.coverageType).toBe(COVERAGE_PHARMACY.toString());
    });

    test('verifyInNetwork accepts valid proof', async () => {
      const tree = new MerkleTree(WALLET_TREE_HEIGHT);
      const leaf = lifecycleLeafCommitment(prescriberWalletId, LIFECYCLE_ELIGIBLE);
      tree.setLeaf(0n, leaf);
      const witness = new LifecycleWitness(tree.getWitness(0n));

      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyPrescriber(
        prescriberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const result = await InNetworkProgram.proveInNetwork(
        pgResult.proof, LIFECYCLE_ELIGIBLE, witness, tree.getRoot(),
      );

      const isValid = await verificationService.verifyInNetwork(result.proof);
      expect(isValid).toBe(true);
    });

    test('fullPointOfCareCheck succeeds with all proofs', async () => {
      // 1. Build eligibility proof
      const eligData = createTestEligibilityData();
      const planRegistry = new BenefitPlanRegistry();
      planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(0n);

      const eligResult = await EligibilityProgram.proveEligibility(
        nftData, eligData, forestRoots, forestWitness,
        planWitness, planRegistry.getRoot(), Field(20260601),
      );

      // 2. Build NFT holding proof (need NftProgram compiled)
      await NftProgram.compile();

      const inventory = new NftInventory();
      inventory.mint(nftData);
      const memberPreimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        memberPreimage[0]!, memberPreimage[1]!, memberPreimage[2]!,
        memberPreimage[3]!, memberPreimage[4]!,
      );
      const invWitness = inventory.getWitness(0n);
      const holdingResult = await NftProgram.proveHolding(
        pgResult.proof, nftData, invWitness, inventory.getRoot(),
      );

      // 3. Serialize holding proof as PortableCredential
      const credential = serializeCredential(
        holdingResult.proof,
        'nft-holding',
        Field(12345),
      );

      // 4. Full point-of-care check
      const fullResult = await verificationService.fullPointOfCareCheck(
        credential,
        eligResult.proof,
      );

      expect(fullResult.holdingValid).toBe(true);
      expect(fullResult.eligibilityValid).toBe(true);
      expect(fullResult.overallValid).toBe(true);
      expect(fullResult.details.length).toBeGreaterThanOrEqual(2);
    });

    test('fullPointOfCareCheck reports failure details', async () => {
      // Build a valid eligibility proof
      const eligData = createTestEligibilityData();
      const planRegistry = new BenefitPlanRegistry();
      planRegistry.addPlan(eligData);

      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const forestWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const planWitness = planRegistry.getPlanWitness(0n);

      const eligResult = await EligibilityProgram.proveEligibility(
        nftData, eligData, forestRoots, forestWitness,
        planWitness, planRegistry.getRoot(), Field(20260601),
      );

      // Use an expired credential for the holding proof
      const expiredCredential = {
        version: 1 as const,
        proofType: 'nft-holding' as const,
        proofJson: {} as any,
        publicOutput: {
          walletId: '0',
          operationType: '0',
          nftCommitment: '0',
          oldInventoryRoot: '0',
          newInventoryRoot: '0',
        },
        verificationKeyHash: '0',
        createdAt: Date.now() - 100000,
        expiresAt: Date.now() - 50000, // already expired
      };

      const result = await verificationService.fullPointOfCareCheck(
        expiredCredential,
        eligResult.proof,
      );

      expect(result.holdingValid).toBe(false);
      expect(result.eligibilityValid).toBe(true);
      expect(result.overallValid).toBe(false);
      expect(result.details).toContain('NFT holding: FAILED');
    });
  });

  // ─── CareContract Extensions ───────────────────────────

  describe('CareContract — L5 Extensions', () => {
    let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
    let deployer: Mina.TestPublicKey;
    let admin: Mina.TestPublicKey;
    let nonAdmin: Mina.TestPublicKey;
    let contractKey: PrivateKey;
    let contract: CareContract;
    let adminPkHash: Field;
    let registryTree: MerkleTree;
    let lifecycleTree: MerkleTree;
    let nftRegistryTree: MerkleTree;

    beforeAll(async () => {
      local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(local);

      [deployer, admin, nonAdmin] = local.testAccounts;
      contractKey = PrivateKey.random();
      contract = new CareContract(contractKey.toPublicKey());
      adminPkHash = Poseidon.hash(admin.toFields());

      registryTree = new MerkleTree(WALLET_TREE_HEIGHT);
      lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      nftRegistryTree = new MerkleTree(WALLET_TREE_HEIGHT);

      // Deploy + init core state
      const deployTx = await Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer);
        await contract.deploy();
      });
      await deployTx.prove();
      await deployTx.sign([deployer.key, contractKey]).send();

      const initTx = await Mina.transaction(admin, async () => {
        await contract.initState(
          adminPkHash,
          registryTree.getRoot(),
          lifecycleTree.getRoot(),
        );
      });
      await initTx.prove();
      await initTx.sign([admin.key]).send();
    });

    test('initEligibilityState sets slots 4-6', async () => {
      const planRegistry = new BenefitPlanRegistry();
      const vkHash = Field(999999);

      const tx = await Mina.transaction(admin, async () => {
        await contract.initEligibilityState(
          planRegistry.getRoot(),
          nftRegistryTree.getRoot(),
          vkHash,
        );
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      expect(contract.benefitPlanRoot.get().toString())
        .toBe(planRegistry.getRoot().toString());
      expect(contract.nftRegistryRoot.get().toString())
        .toBe(nftRegistryTree.getRoot().toString());
      expect(contract.eligibilityVkHash.get().toString())
        .toBe(vkHash.toString());
    });

    test('updateBenefitPlan changes benefitPlanRoot', async () => {
      const planRegistry = new BenefitPlanRegistry();
      const eligData = createTestEligibilityData();
      planRegistry.addPlan(eligData);
      const newRoot = planRegistry.getRoot();

      const tx = await Mina.transaction(admin, async () => {
        await contract.updateBenefitPlan(newRoot);
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      expect(contract.benefitPlanRoot.get().toString())
        .toBe(newRoot.toString());
    });

    test('registerGlobalNft adds NFT to global registry', async () => {
      const eligData = createTestEligibilityData();
      const forest = createTestForest(eligData);
      const nftData = createTestEligibilityNft(forest);
      const nftCommitment = nftData.commitment();

      const witness = new NftRegistryWitness(nftRegistryTree.getWitness(0n));

      const tx = await Mina.transaction(admin, async () => {
        await contract.registerGlobalNft(nftCommitment, witness);
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      // Update off-chain tree
      nftRegistryTree.setLeaf(0n, nftCommitment);

      expect(contract.nftRegistryRoot.get().toString())
        .toBe(nftRegistryTree.getRoot().toString());
    });

    test('non-admin rejected for all new methods', async () => {
      // initEligibilityState — already initialized, would fail anyway
      // Test updateBenefitPlan with non-admin
      await expect(async () => {
        const tx = await Mina.transaction(nonAdmin, async () => {
          await contract.updateBenefitPlan(Field(0));
        });
        await tx.prove();
        await tx.sign([nonAdmin.key]).send();
      }).rejects.toThrow();

      // Test registerGlobalNft with non-admin
      await expect(async () => {
        const witness = new NftRegistryWitness(nftRegistryTree.getWitness(1n));
        const tx = await Mina.transaction(nonAdmin, async () => {
          await contract.registerGlobalNft(Field(123), witness);
        });
        await tx.prove();
        await tx.sign([nonAdmin.key]).send();
      }).rejects.toThrow();
    });
  });
});
