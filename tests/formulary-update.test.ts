import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  FormularyUpdateService,
} from '../src/eligibility/formulary-update-service.js';
import type { PublishedFormulary } from '../src/eligibility/formulary-update-service.js';
import {
  EligibilityData,
  COVERAGE_PHARMACY,
} from '../src/eligibility/eligibility-data.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { hashString } from '../src/zkp/hash-utils.js';
import { FormularyRegistry } from '../src/access-control/formulary-registry.js';
import { buildFormularyEntry } from '../src/access-control/formulary-entry.js';
import type { FormularyEntryLocalData } from '../src/access-control/formulary-entry.js';
import { ACCUMULATOR_LEAF_INDEX, buildAccumulatorData } from '../src/access-control/accumulator-data.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { L2Node, DEFAULT_L2_NODE_OPTIONS } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import {
  WalletRegistry,
  WalletState,
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import {
  deriveMemberWalletId,
} from '../src/wallets/index.js';
import type { MemberLocalData } from '../src/models/member.js';
import { PlanTemplate } from '../src/onboarding/plan-template.js';
import { EnrollmentService } from '../src/onboarding/enrollment-service.js';
import { TokenAuthority } from '../src/onboarding/token-authority.js';
import { GroupRegistry, buildGroupConfig } from '../src/onboarding/group-registry.js';
import { OpaqueRoster } from '../src/onboarding/opaque-roster.js';
import { BenefitPlanRegistry } from '../src/eligibility/benefit-plan-registry.js';

// ─── Test Data ───────────────────────────────────────────

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

const testMember1: MemberLocalData = {
  cardholderId: 'CARD-FM-001',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'Alice',
  lastName: 'Smith',
};

const testMember2: MemberLocalData = {
  cardholderId: 'CARD-FM-002',
  dateOfBirth: '19900720',
  genderCode: 2,
  firstName: 'Bob',
  lastName: 'Jones',
};

const member1WalletId = deriveMemberWalletId(testMember1, TEST_ENROLLMENT_KEY);
const member2WalletId = deriveMemberWalletId(testMember2, TEST_ENROLLMENT_KEY);

const adminWalletId = Poseidon.hash([Field(999)]);

const baseFormularyEntries: FormularyEntryLocalData[] = [
  {
    ndc: '00071015523',
    tierLevel: 1,
    copayAmount: 1000,
    requiresPriorAuth: false,
    maxQuantityPerFill: 90,
    maxDaySupply: 90,
    stepTherapyRequired: false,
  },
  {
    ndc: '00002771501',
    tierLevel: 2,
    copayAmount: 3000,
    requiresPriorAuth: false,
    maxQuantityPerFill: 30,
    maxDaySupply: 30,
    stepTherapyRequired: false,
  },
];

const updatedFormularyEntries: FormularyEntryLocalData[] = [
  ...baseFormularyEntries,
  {
    ndc: '00074490202',
    tierLevel: 4,
    copayAmount: 15000,
    requiresPriorAuth: true,
    maxQuantityPerFill: 2,
    maxDaySupply: 28,
    stepTherapyRequired: false,
  },
];

// ─── Tests ───────────────────────────────────────────────

describe('Formulary Update Push (GAP 3)', () => {
  // ─── FormularyUpdateService ────────────────────────────

  describe('FormularyUpdateService', () => {
    test('buildFormulary creates valid registry from entries', () => {
      const { registry, root, formularyEntries } =
        FormularyUpdateService.buildFormulary(baseFormularyEntries);

      expect(registry.count).toBe(2);
      expect(root.toString()).not.toBe('0');
      expect(formularyEntries.length).toBe(2);

      // Verify entries are in the registry
      const witness = registry.getEntryWitness(0n);
      const computedRoot = witness.calculateRoot(formularyEntries[0]!.commitment());
      expect(computedRoot.toString()).toBe(root.toString());
    });

    test('different entries produce different roots', () => {
      const { root: root1 } =
        FormularyUpdateService.buildFormulary(baseFormularyEntries);
      const { root: root2 } =
        FormularyUpdateService.buildFormulary(updatedFormularyEntries);

      expect(root1.toString()).not.toBe(root2.toString());
    });

    test('rebuildMemberForest updates forest root', () => {
      // Set up initial forest
      const eligData = new EligibilityData({
        planIdHash: hashString('PLAN-1'),
        groupIdHash: hashString('GRP-1'),
        effectiveDate: Field(20260101),
        terminationDate: Field(20261231),
        copayAmountCents: Field(2000),
        coverageType: COVERAGE_PHARMACY,
        formularyRoot: Field(111),
        networkRoot: Field(0),
      });

      const forest = new MerkleForest();
      forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligData.commitment());

      const oldForestRoot = forest.getForestRoot();

      // Rebuild with new formulary root
      const { newEligibilityData, newForestRoot } =
        FormularyUpdateService.rebuildMemberForest(forest, eligData, Field(222));

      expect(newForestRoot.toString()).not.toBe(oldForestRoot.toString());
      expect(newEligibilityData.formularyRoot.toString()).toBe('222');
      // Other fields preserved
      expect(newEligibilityData.planIdHash.toString()).toBe(eligData.planIdHash.toString());
      expect(newEligibilityData.networkRoot.toString()).toBe('0');
    });

    test('rebuildMemberForest preserves accumulator data', () => {
      const eligData = new EligibilityData({
        planIdHash: hashString('PLAN-1'),
        groupIdHash: hashString('GRP-1'),
        effectiveDate: Field(20260101),
        terminationDate: Field(20261231),
        copayAmountCents: Field(2000),
        coverageType: COVERAGE_PHARMACY,
        formularyRoot: Field(111),
        networkRoot: Field(0),
      });

      const accData = buildAccumulatorData({
        planYear: '20260101',
        deductibleAmountCents: 50000,
        deductiblePaidCents: 10000,
        oopMaxCents: 800000,
        oopPaidCents: 20000,
        annualBenefitMaxCents: 0,
        annualBenefitUsedCents: 0,
      });

      const forest = new MerkleForest();
      forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligData.commitment());
      forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accData.commitment());

      // Get accumulator commitment before rebuild
      const accCommitmentBefore = accData.commitment().toString();

      // Rebuild
      FormularyUpdateService.rebuildMemberForest(forest, eligData, Field(333));

      // Accumulator leaf should still be in the tree
      const accWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
      const accRoot = accWitness.calculateRoot(accData.commitment());
      expect(accRoot.toString()).toBe(forest.getTreeRoot(ForestDomain.ACCESS_CONTROL).toString());
    });

    test('diffFormularies identifies added, removed, and changed entries', () => {
      const oldEntries: FormularyEntryLocalData[] = [
        { ...baseFormularyEntries[0]!, copayAmount: 1000 },
        baseFormularyEntries[1]!,
      ];

      const newEntries: FormularyEntryLocalData[] = [
        { ...baseFormularyEntries[0]!, copayAmount: 1500 }, // changed copay
        // removed second entry
        updatedFormularyEntries[2]!, // added Humira entry
      ];

      const diff = FormularyUpdateService.diffFormularies(oldEntries, newEntries);

      expect(diff.added.length).toBe(1);
      expect(diff.added[0]!.ndc).toBe('00074490202');
      expect(diff.removed.length).toBe(1);
      expect(diff.removed[0]!.ndc).toBe('00002771501');
      expect(diff.changed.length).toBe(1);
      expect(diff.changed[0]!.copayAmount).toBe(1500);
    });
  });

  // ─── L2 Sequencer Formulary State ──────────────────────

  describe('L2SequencerService — formulary state', () => {
    let sequencer: L2SequencerService;

    beforeEach(() => {
      const store = new InMemoryStore();
      sequencer = new L2SequencerService(
        store,
        Field(0),
        Field(0),
        Field(0),
        30_000,
      );
    });

    test('storeFormulary and getFormulary', () => {
      const planIdHash = hashString('PLAN-GOLD').toString();
      const formularyRoot = '12345';
      const entriesJson = JSON.stringify(baseFormularyEntries);

      sequencer.storeFormulary(planIdHash, formularyRoot, entriesJson);

      const result = sequencer.getFormulary(planIdHash);
      expect(result).not.toBeNull();
      expect(result!.formularyRoot).toBe('12345');
      expect(result!.version).toBe(1);
      expect(JSON.parse(result!.entriesJson).length).toBe(2);
    });

    test('getFormulary returns null for unknown plan', () => {
      expect(sequencer.getFormulary('unknown')).toBeNull();
    });

    test('storeFormulary increments version', () => {
      const planIdHash = hashString('PLAN-GOLD').toString();

      sequencer.storeFormulary(planIdHash, '111', '[]');
      expect(sequencer.getFormulary(planIdHash)!.version).toBe(1);

      sequencer.storeFormulary(planIdHash, '222', '[]');
      expect(sequencer.getFormulary(planIdHash)!.version).toBe(2);
      expect(sequencer.getFormulary(planIdHash)!.formularyRoot).toBe('222');
    });

    test('formulary state survives export/restore', () => {
      const planIdHash = hashString('PLAN-GOLD').toString();
      sequencer.storeFormulary(planIdHash, '12345', JSON.stringify(baseFormularyEntries));

      // Export
      const state = sequencer.exportState();
      expect(state.formularyStore).toBeDefined();
      expect(state.formularyStore![planIdHash]).toBeDefined();

      // Restore to new sequencer
      const store2 = new InMemoryStore();
      const sequencer2 = new L2SequencerService(store2, Field(0), Field(0), Field(0));
      sequencer2.restoreState(state);

      const restored = sequencer2.getFormulary(planIdHash);
      expect(restored).not.toBeNull();
      expect(restored!.formularyRoot).toBe('12345');
      expect(restored!.version).toBe(1);
    });
  });

  // ─── RPC End-to-End ────────────────────────────────────

  describe('RPC — l2_getFormulary / l2_storeFormulary', () => {
    let node: L2Node;
    let server: L2RpcServer;
    let client: L2Client;
    let port: number;

    beforeAll(async () => {
      const store = new InMemoryStore();
      node = new L2Node(
        { ...DEFAULT_L2_NODE_OPTIONS, autoSettle: false },
        store,
        Field(0),
        Field(0),
        Field(0),
      );
      node.start();

      server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', maxBodyBytes: 10 * 1024 * 1024, enableSSE: false });
      await server.start();
      port = server.getPort();

      client = new L2Client({ sequencerUrl: `http://127.0.0.1:${port}` });
    });

    afterAll(async () => {
      await server.stop();
      await node.stop();
    });

    test('storeFormulary + getFormulary round-trip via RPC', async () => {
      const planIdHash = hashString('PLAN-RPC-TEST').toString();
      const { root } = FormularyUpdateService.buildFormulary(baseFormularyEntries);
      const entriesJson = JSON.stringify(baseFormularyEntries);

      // Store via RPC
      const storeResult = await client.storeFormulary(
        planIdHash,
        root.toString(),
        entriesJson,
      );
      expect(storeResult.success).toBe(true);
      expect(storeResult.planIdHash).toBe(planIdHash);

      // Retrieve via RPC
      const getResult = await client.getFormulary(planIdHash);
      expect(getResult).not.toBeNull();
      expect(getResult!.formularyRoot).toBe(root.toString());
      expect(getResult!.version).toBe(1);
    });

    test('getFormulary returns null for unknown plan via RPC', async () => {
      const result = await client.getFormulary('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── EnrollmentService — bulk formulary update ─────────

  describe('EnrollmentService.updateFormularyForPlan', () => {
    test('updates all active members on a plan', () => {
      // Set up enrollment infrastructure
      const walletRegistry = new WalletRegistry();
      const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      const tokenAuthority = new TokenAuthority();
      const groupRegistry = new GroupRegistry();
      const opaqueRoster = new OpaqueRoster();
      const benefitPlanRegistry = new BenefitPlanRegistry();

      // Create plan template
      const planTemplate = new PlanTemplate({
        planId: 'PLAN-BULK',
        copayAmountCents: 2000,
        coverageType: 1,
        deductibleAmountCents: 50000,
        oopMaxCents: 800000,
        annualBenefitMaxCents: 0,
        formularyEntries: baseFormularyEntries,
      });
      const plans = new Map([['PLAN-BULK', planTemplate]]);

      // Register group
      const groupLocalData = {
        groupId: 'GRP-TEST',
        planId: 'PLAN-BULK',
        effectiveDate: '20260101',
        terminationDate: '20261231',
        enrollmentCap: 100,
      };
      const groupConfig = buildGroupConfig(groupLocalData);
      groupRegistry.addGroup(groupConfig, groupLocalData);

      // Create enrollment service
      const enrollmentService = new EnrollmentService(
        walletRegistry,
        lifecycleTree,
        tokenAuthority,
        groupRegistry,
        plans,
        opaqueRoster,
        benefitPlanRegistry,
        adminWalletId,
      );

      // Enroll 2 members
      const token1 = tokenAuthority.generateToken(
        'GRP-TEST', 'PLAN-BULK', 'EMP-1', 'FAM-1', '20261231',
      );
      const token2 = tokenAuthority.generateToken(
        'GRP-TEST', 'PLAN-BULK', 'EMP-2', 'FAM-2', '20261231',
      );

      enrollmentService.processEnrollment(member1WalletId, token1.tokenId, '20260115');
      enrollmentService.processEnrollment(member2WalletId, token2.tokenId, '20260115');

      // Verify both have forests
      const forest1Before = enrollmentService.getMemberForest(member1WalletId);
      const forest2Before = enrollmentService.getMemberForest(member2WalletId);
      expect(forest1Before).toBeDefined();
      expect(forest2Before).toBeDefined();

      const oldRoot1 = forest1Before!.getForestRoot().toString();
      const oldRoot2 = forest2Before!.getForestRoot().toString();

      // Build new formulary
      const { root: newFormularyRoot } =
        FormularyUpdateService.buildFormulary(updatedFormularyEntries);

      // Bulk update
      const result = enrollmentService.updateFormularyForPlan('PLAN-BULK', newFormularyRoot);
      expect(result.updatedCount).toBe(2);
      expect(result.updatedWalletIds.length).toBe(2);

      // Verify forests changed
      const forest1After = enrollmentService.getMemberForest(member1WalletId);
      const forest2After = enrollmentService.getMemberForest(member2WalletId);
      expect(forest1After!.getForestRoot().toString()).not.toBe(oldRoot1);
      expect(forest2After!.getForestRoot().toString()).not.toBe(oldRoot2);
    });

    test('skips terminated members', () => {
      const walletRegistry = new WalletRegistry();
      const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      const tokenAuthority = new TokenAuthority();
      const groupRegistry = new GroupRegistry();
      const opaqueRoster = new OpaqueRoster();
      const benefitPlanRegistry = new BenefitPlanRegistry();

      const planTemplate = new PlanTemplate({
        planId: 'PLAN-SKIP',
        copayAmountCents: 2000,
        coverageType: 1,
        deductibleAmountCents: 0,
        oopMaxCents: 0,
        annualBenefitMaxCents: 0,
        formularyEntries: baseFormularyEntries,
      });
      const plans = new Map([['PLAN-SKIP', planTemplate]]);

      const groupLocalData = {
        groupId: 'GRP-SKIP',
        planId: 'PLAN-SKIP',
        effectiveDate: '20260101',
        terminationDate: '20261231',
        enrollmentCap: 100,
      };
      const groupConfig = buildGroupConfig(groupLocalData);
      groupRegistry.addGroup(groupConfig, groupLocalData);

      const enrollmentService = new EnrollmentService(
        walletRegistry, lifecycleTree, tokenAuthority, groupRegistry,
        plans, opaqueRoster, benefitPlanRegistry, adminWalletId,
      );

      // Enroll 2 members
      const token1 = tokenAuthority.generateToken(
        'GRP-SKIP', 'PLAN-SKIP', 'EMP-1', 'F1', '20261231',
      );
      const token2 = tokenAuthority.generateToken(
        'GRP-SKIP', 'PLAN-SKIP', 'EMP-2', 'F2', '20261231',
      );

      enrollmentService.processEnrollment(member1WalletId, token1.tokenId, '20260115');
      enrollmentService.processEnrollment(member2WalletId, token2.tokenId, '20260115');

      // Terminate member 2
      enrollmentService.terminateMember(member2WalletId, '20260301');

      // Bulk update — should only update member 1
      const { root: newRoot } = FormularyUpdateService.buildFormulary(updatedFormularyEntries);
      const result = enrollmentService.updateFormularyForPlan('PLAN-SKIP', newRoot);
      expect(result.updatedCount).toBe(1);
      expect(result.updatedWalletIds).toContain(member1WalletId.toString());
      expect(result.updatedWalletIds).not.toContain(member2WalletId.toString());
    });
  });
});
