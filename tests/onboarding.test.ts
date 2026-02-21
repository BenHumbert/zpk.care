/**
 * Onboarding — Three-Party Enrollment Ceremony Tests
 *
 * Tests the full insurer onboarding flow:
 *   1. GroupEnrollmentToken — data model + builder
 *   2. PlanTemplate — benefit plan factory
 *   3. GroupRegistry — employer group management
 *   4. OpaqueRoster — walletId → plan/group mapping (zero PHI)
 *   5. TokenAuthority — employer-side token lifecycle
 *   6. EnrollmentService — insurer-side enrollment ceremony
 *
 * All tests are FAST (no ZkProgram compilation).
 * The enrollment service uses admin-path operations (signature-gated),
 * not proof-gated, so no proof generation is needed.
 *
 * Run: npx jest tests/onboarding.test.ts --verbose
 */
import { Field, Poseidon, MerkleTree } from 'o1js';
import { hashString, dateToField } from '../src/zkp/hash-utils.js';

// ─── GroupEnrollmentToken ──────────────────────────────────
import {
  GroupEnrollmentToken,
  buildGroupEnrollmentToken,
  TOKEN_STATUS_UNUSED,
  TOKEN_STATUS_CONSUMED,
  TOKEN_STATUS_EXPIRED,
  TOKEN_STATUS_REVOKED,
} from '../src/onboarding/group-enrollment-token.js';
import type { GroupEnrollmentTokenLocalData } from '../src/onboarding/group-enrollment-token.js';

// ─── PlanTemplate ──────────────────────────────────────────
import { PlanTemplate } from '../src/onboarding/plan-template.js';
import type { PlanTemplateConfig } from '../src/onboarding/plan-template.js';

// ─── GroupRegistry ─────────────────────────────────────────
import {
  GroupConfig,
  buildGroupConfig,
  GroupRegistry,
  GROUP_STATUS_ACTIVE,
  GROUP_STATUS_TERMINATED,
  GROUP_TREE_HEIGHT,
} from '../src/onboarding/group-registry.js';
import type { GroupConfigLocalData } from '../src/onboarding/group-registry.js';

// ─── OpaqueRoster ──────────────────────────────────────────
import {
  RosterEntry,
  buildRosterEntry,
  OpaqueRoster,
  ENROLLMENT_STATUS_ACTIVE,
  ENROLLMENT_STATUS_TERMINATED,
  ROSTER_TREE_HEIGHT,
} from '../src/onboarding/opaque-roster.js';

// ─── TokenAuthority ────────────────────────────────────────
import { TokenAuthority } from '../src/onboarding/token-authority.js';

// ─── EnrollmentService ─────────────────────────────────────
import { EnrollmentService } from '../src/onboarding/enrollment-service.js';

// ─── Dependencies from existing layers ─────────────────────
import { WalletRegistry, WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { BenefitPlanRegistry } from '../src/eligibility/benefit-plan-registry.js';
import { CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { MerkleForest, ForestDomain, TREE_HEIGHT } from '../src/zkp/merkle-forest.js';
import { ACCUMULATOR_LEAF_INDEX } from '../src/access-control/accumulator-data.js';
import {
  deriveMemberWalletId,
} from '../src/wallets/wallet-derivation.js';
import type { MemberLocalData } from '../src/models/member.js';

// ─── Test Data ─────────────────────────────────────────────

const TEST_TOKEN_LOCAL: GroupEnrollmentTokenLocalData = {
  tokenId: 'TOKEN-001',
  groupId: 'ACME-CORP-001',
  planId: 'PLAN-GOLD-2026',
  employeeId: 'EMP-12345',
  familyId: 'FAM-TEST-001',
  validUntil: '20260228',
  issuer: 'ACME Corporation',
  nonce: 0,
};

const TEST_GROUP_LOCAL: GroupConfigLocalData = {
  groupId: 'ACME-CORP-001',
  planId: 'PLAN-GOLD-2026',
  effectiveDate: '20260101',
  terminationDate: '20261231',
  enrollmentCap: 100,
};

const TEST_PLAN_CONFIG: PlanTemplateConfig = {
  planId: 'PLAN-GOLD-2026',
  copayAmountCents: 3000,
  coverageType: 1,
  deductibleAmountCents: 50000,
  oopMaxCents: 800000,
  annualBenefitMaxCents: 10000000,
  formularyEntries: [
    {
      ndc: '00071015523',
      tierLevel: 2,
      copayAmount: 2000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 30,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
    {
      ndc: '00069015401',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 90,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  ],
};

const TEST_MEMBER: MemberLocalData = {
  cardholderId: 'CARD123456789',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'John',
  lastName: 'Doe',
};

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

// ─── Tests ─────────────────────────────────────────────────

describe('Onboarding — GroupEnrollmentToken', () => {
  test('commitment is deterministic', () => {
    const token1 = buildGroupEnrollmentToken(TEST_TOKEN_LOCAL);
    const token2 = buildGroupEnrollmentToken(TEST_TOKEN_LOCAL);
    expect(token1.commitment().toString()).toBe(
      token2.commitment().toString(),
    );
  });

  test('commitment changes when any field changes', () => {
    const token1 = buildGroupEnrollmentToken(TEST_TOKEN_LOCAL);
    const token2 = buildGroupEnrollmentToken({
      ...TEST_TOKEN_LOCAL,
      tokenId: 'TOKEN-002',
    });
    const token3 = buildGroupEnrollmentToken({
      ...TEST_TOKEN_LOCAL,
      employeeId: 'EMP-99999',
    });

    expect(token1.commitment().toString()).not.toBe(
      token2.commitment().toString(),
    );
    expect(token1.commitment().toString()).not.toBe(
      token3.commitment().toString(),
    );
  });

  test('buildGroupEnrollmentToken hashes all string fields', () => {
    const token = buildGroupEnrollmentToken(TEST_TOKEN_LOCAL);

    expect(token.tokenIdHash.toString()).toBe(
      hashString('TOKEN-001').toString(),
    );
    expect(token.groupIdHash.toString()).toBe(
      hashString('ACME-CORP-001').toString(),
    );
    expect(token.planIdHash.toString()).toBe(
      hashString('PLAN-GOLD-2026').toString(),
    );
    expect(token.employeeIdHash.toString()).toBe(
      hashString('EMP-12345').toString(),
    );
    expect(token.validUntil.toString()).toBe(
      dateToField('20260228').toString(),
    );
    expect(token.issuerHash.toString()).toBe(
      hashString('ACME Corporation').toString(),
    );
    expect(token.nonce.toString()).toBe('0');
  });

  test('token status constants are distinct', () => {
    const statuses = [
      TOKEN_STATUS_UNUSED,
      TOKEN_STATUS_CONSUMED,
      TOKEN_STATUS_EXPIRED,
      TOKEN_STATUS_REVOKED,
    ];
    const values = statuses.map((s) => s.toString());
    expect(new Set(values).size).toBe(4);
  });
});

describe('Onboarding — PlanTemplate', () => {
  test('constructor builds formulary from entries', () => {
    const plan = new PlanTemplate(TEST_PLAN_CONFIG);

    expect(plan.formularyRegistry.count).toBe(2);
    expect(plan.formularyEntries.length).toBe(2);
    expect(plan.formularyRoot.toString()).not.toBe(Field(0).toString());
  });

  test('buildEligibilityData produces correct EligibilityData', () => {
    const plan = new PlanTemplate(TEST_PLAN_CONFIG);
    const eligData = plan.buildEligibilityData(
      'ACME-CORP-001',
      '20260101',
      '20261231',
    );

    expect(eligData.planIdHash.toString()).toBe(
      hashString('PLAN-GOLD-2026').toString(),
    );
    expect(eligData.groupIdHash.toString()).toBe(
      hashString('ACME-CORP-001').toString(),
    );
    expect(eligData.effectiveDate.toString()).toBe('20260101');
    expect(eligData.terminationDate.toString()).toBe('20261231');
    expect(eligData.copayAmountCents.toString()).toBe('3000');
    expect(eligData.coverageType.toString()).toBe('1');
    expect(eligData.formularyRoot.toString()).toBe(
      plan.formularyRoot.toString(),
    );
  });

  test('buildAccumulatorData produces fresh accumulators', () => {
    const plan = new PlanTemplate(TEST_PLAN_CONFIG);
    const accData = plan.buildAccumulatorData('20260101');

    expect(accData.planYear.toString()).toBe('20260101');
    expect(accData.deductibleAmountCents.toString()).toBe('50000');
    expect(accData.deductiblePaidCents.toString()).toBe('0');
    expect(accData.oopMaxCents.toString()).toBe('800000');
    expect(accData.oopPaidCents.toString()).toBe('0');
    expect(accData.annualBenefitMaxCents.toString()).toBe('10000000');
    expect(accData.annualBenefitUsedCents.toString()).toBe('0');
  });

  test('formulary root matches manual construction', () => {
    const plan = new PlanTemplate(TEST_PLAN_CONFIG);

    // Manually build the same formulary
    const { FormularyRegistry } = require('../src/access-control/formulary-registry.js');
    const { buildFormularyEntry } = require('../src/access-control/formulary-entry.js');
    const manualReg = new FormularyRegistry();
    for (const e of TEST_PLAN_CONFIG.formularyEntries) {
      manualReg.addEntry(buildFormularyEntry(e));
    }

    expect(plan.formularyRoot.toString()).toBe(
      manualReg.getRoot().toString(),
    );
  });

  test('different plans produce different formulary roots', () => {
    const gold = new PlanTemplate(TEST_PLAN_CONFIG);
    const silver = new PlanTemplate({
      ...TEST_PLAN_CONFIG,
      planId: 'PLAN-SILVER-2026',
      copayAmountCents: 5000,
      formularyEntries: [TEST_PLAN_CONFIG.formularyEntries[0]!],
    });

    expect(gold.formularyRoot.toString()).not.toBe(
      silver.formularyRoot.toString(),
    );
  });
});

describe('Onboarding — GroupRegistry', () => {
  test('addGroup registers a group and returns root', () => {
    const registry = new GroupRegistry();
    const config = buildGroupConfig(TEST_GROUP_LOCAL);
    const { index, newRoot } = registry.addGroup(config, TEST_GROUP_LOCAL);

    expect(index).toBe(0n);
    expect(registry.count).toBe(1);
    expect(newRoot.toString()).not.toBe(Field(0).toString());
  });

  test('commitment is deterministic', () => {
    const config1 = buildGroupConfig(TEST_GROUP_LOCAL);
    const config2 = buildGroupConfig(TEST_GROUP_LOCAL);
    expect(config1.commitment().toString()).toBe(
      config2.commitment().toString(),
    );
  });

  test('prevents duplicate group registration', () => {
    const registry = new GroupRegistry();
    const config = buildGroupConfig(TEST_GROUP_LOCAL);
    registry.addGroup(config, TEST_GROUP_LOCAL);

    expect(() => registry.addGroup(config, TEST_GROUP_LOCAL)).toThrow(
      'Group already registered',
    );
  });

  test('getGroupByHash finds registered group', () => {
    const registry = new GroupRegistry();
    const config = buildGroupConfig(TEST_GROUP_LOCAL);
    registry.addGroup(config, TEST_GROUP_LOCAL);

    const result = registry.getGroupByHash(hashString('ACME-CORP-001'));
    expect(result).toBeDefined();
    expect(result!.config.groupIdHash.toString()).toBe(
      hashString('ACME-CORP-001').toString(),
    );
    expect(result!.localData.groupId).toBe('ACME-CORP-001');
    expect(result!.index).toBe(0n);
  });

  test('getGroupByHash returns undefined for unknown group', () => {
    const registry = new GroupRegistry();
    const result = registry.getGroupByHash(hashString('UNKNOWN'));
    expect(result).toBeUndefined();
  });

  test('updateGroup changes config in tree', () => {
    const registry = new GroupRegistry();
    const config = buildGroupConfig(TEST_GROUP_LOCAL);
    const { index } = registry.addGroup(config, TEST_GROUP_LOCAL);

    const rootBefore = registry.getRoot().toString();

    const updated = new GroupConfig({
      groupIdHash: config.groupIdHash,
      planIdHash: config.planIdHash,
      effectiveDate: config.effectiveDate,
      terminationDate: config.terminationDate,
      enrollmentCap: config.enrollmentCap,
      enrolledCount: Field(5),
      status: config.status,
    });
    registry.updateGroup(index, updated);

    expect(registry.getRoot().toString()).not.toBe(rootBefore);
    expect(registry.getGroup(index)!.enrolledCount.toString()).toBe('5');
  });

  test('buildGroupConfig initializes with zero count and ACTIVE', () => {
    const config = buildGroupConfig(TEST_GROUP_LOCAL);
    expect(config.enrolledCount.toString()).toBe('0');
    expect(config.status.toString()).toBe(GROUP_STATUS_ACTIVE.toString());
  });
});

describe('Onboarding — OpaqueRoster', () => {
  const testWalletId = Poseidon.hash([Field(42)]);

  test('addEntry registers a member and returns root', () => {
    const roster = new OpaqueRoster();
    const entry = buildRosterEntry(testWalletId, {
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP-001',
      familyId: 'FAM-TEST-001',
      enrolledDate: '20260115',
      tokenId: 'TOKEN-001',
    });
    const { index, newRoot } = roster.addEntry(entry);

    expect(index).toBe(0n);
    expect(roster.count).toBe(1);
    expect(newRoot.toString()).not.toBe(Field(0).toString());
  });

  test('commitment is deterministic', () => {
    const entry1 = buildRosterEntry(testWalletId, {
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP-001',
      familyId: 'FAM-TEST-001',
      enrolledDate: '20260115',
      tokenId: 'TOKEN-001',
    });
    const entry2 = buildRosterEntry(testWalletId, {
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP-001',
      familyId: 'FAM-TEST-001',
      enrolledDate: '20260115',
      tokenId: 'TOKEN-001',
    });
    expect(entry1.commitment().toString()).toBe(
      entry2.commitment().toString(),
    );
  });

  test('prevents duplicate wallet enrollment', () => {
    const roster = new OpaqueRoster();
    const entry = buildRosterEntry(testWalletId, {
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP-001',
      familyId: 'FAM-TEST-001',
      enrolledDate: '20260115',
      tokenId: 'TOKEN-001',
    });
    roster.addEntry(entry);

    expect(() => roster.addEntry(entry)).toThrow('Wallet already enrolled');
  });

  test('isEnrolled returns correct status', () => {
    const roster = new OpaqueRoster();
    expect(roster.isEnrolled(testWalletId)).toBe(false);

    const entry = buildRosterEntry(testWalletId, {
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP-001',
      familyId: 'FAM-TEST-001',
      enrolledDate: '20260115',
      tokenId: 'TOKEN-001',
    });
    roster.addEntry(entry);

    expect(roster.isEnrolled(testWalletId)).toBe(true);
  });

  test('getEntryByWallet finds enrolled member', () => {
    const roster = new OpaqueRoster();
    const entry = buildRosterEntry(testWalletId, {
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP-001',
      familyId: 'FAM-TEST-001',
      enrolledDate: '20260115',
      tokenId: 'TOKEN-001',
    });
    roster.addEntry(entry);

    const result = roster.getEntryByWallet(testWalletId);
    expect(result).toBeDefined();
    expect(result!.entry.walletId.toString()).toBe(
      testWalletId.toString(),
    );
    expect(result!.entry.status.toString()).toBe(
      ENROLLMENT_STATUS_ACTIVE.toString(),
    );
  });

  test('getEntriesByGroup finds all members in a group', () => {
    const roster = new OpaqueRoster();
    const wallet1 = Poseidon.hash([Field(100)]);
    const wallet2 = Poseidon.hash([Field(200)]);
    const wallet3 = Poseidon.hash([Field(300)]);

    roster.addEntry(
      buildRosterEntry(wallet1, {
        planId: 'PLAN-GOLD',
        groupId: 'ACME',
        familyId: 'FAM-ACME-001',
        enrolledDate: '20260101',
        tokenId: 'T1',
      }),
    );
    roster.addEntry(
      buildRosterEntry(wallet2, {
        planId: 'PLAN-GOLD',
        groupId: 'ACME',
        familyId: 'FAM-ACME-002',
        enrolledDate: '20260102',
        tokenId: 'T2',
      }),
    );
    roster.addEntry(
      buildRosterEntry(wallet3, {
        planId: 'PLAN-SILVER',
        groupId: 'BETA-CORP',
        familyId: 'FAM-BETA-001',
        enrolledDate: '20260103',
        tokenId: 'T3',
      }),
    );

    const acmeMembers = roster.getEntriesByGroup(hashString('ACME'));
    expect(acmeMembers.length).toBe(2);

    const betaMembers = roster.getEntriesByGroup(hashString('BETA-CORP'));
    expect(betaMembers.length).toBe(1);
  });

  test('buildRosterEntry initializes as ACTIVE', () => {
    const entry = buildRosterEntry(testWalletId, {
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP-001',
      familyId: 'FAM-TEST-001',
      enrolledDate: '20260115',
      tokenId: 'TOKEN-001',
    });
    expect(entry.status.toString()).toBe(
      ENROLLMENT_STATUS_ACTIVE.toString(),
    );
    expect(entry.terminatedDate.toString()).toBe('0');
  });
});

describe('Onboarding — TokenAuthority', () => {
  test('generates valid tokens', () => {
    const authority = new TokenAuthority('ACME Corporation');
    const { token, tokenId } = authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
    );

    expect(tokenId).toContain('TOKEN-');
    expect(token.groupIdHash.toString()).toBe(
      hashString('ACME-CORP-001').toString(),
    );
    expect(authority.count).toBe(1);
  });

  test('generates tokens with custom ID', () => {
    const authority = new TokenAuthority('ACME Corporation');
    const { tokenId } = authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'CUSTOM-TOKEN-001',
    );
    expect(tokenId).toBe('CUSTOM-TOKEN-001');
  });

  test('validates unused tokens within date range', () => {
    const authority = new TokenAuthority('ACME Corporation');
    authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-A',
    );

    const result = authority.validateToken('TOKEN-A', '20260115');
    expect(result.valid).toBe(true);
    expect(result.groupId).toBe('ACME-CORP-001');
    expect(result.planId).toBe('PLAN-GOLD-2026');
  });

  test('rejects non-existent tokens', () => {
    const authority = new TokenAuthority('ACME Corporation');
    const result = authority.validateToken('FAKE-TOKEN', '20260115');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Token not found');
  });

  test('rejects expired tokens', () => {
    const authority = new TokenAuthority('ACME Corporation');
    authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-B',
    );

    const result = authority.validateToken('TOKEN-B', '20260301');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Token expired');
  });

  test('rejects consumed tokens', () => {
    const authority = new TokenAuthority('ACME Corporation');
    authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-C',
    );

    authority.consumeToken('TOKEN-C', Poseidon.hash([Field(1)]));

    const result = authority.validateToken('TOKEN-C', '20260115');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Token already consumed');
  });

  test('rejects revoked tokens', () => {
    const authority = new TokenAuthority('ACME Corporation');
    authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-D',
    );

    authority.revokeToken('TOKEN-D');

    const result = authority.validateToken('TOKEN-D', '20260115');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Token already revoked');
  });

  test('cannot revoke consumed tokens', () => {
    const authority = new TokenAuthority('ACME Corporation');
    authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-E',
    );

    authority.consumeToken('TOKEN-E', Poseidon.hash([Field(1)]));
    expect(() => authority.revokeToken('TOKEN-E')).toThrow(
      'Cannot revoke consumed token',
    );
  });

  test('consumeToken records wallet and timestamp', () => {
    const authority = new TokenAuthority('ACME Corporation');
    authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-F',
    );

    const walletId = Poseidon.hash([Field(42)]);
    authority.consumeToken('TOKEN-F', walletId);

    const record = authority.getTokenRecord('TOKEN-F')!;
    expect(record.status).toBe('consumed');
    expect(record.consumedByWalletId).toBe(walletId.toString());
    expect(record.consumedAt).toBeDefined();
  });
});

describe('Onboarding — EnrollmentService', () => {
  // Helper to set up a fully configured EnrollmentService
  function setupService() {
    const walletRegistry = new WalletRegistry();
    const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const tokenAuthority = new TokenAuthority('ACME Corporation');
    const groupRegistry = new GroupRegistry();
    const opaqueRoster = new OpaqueRoster();
    const benefitPlanRegistry = new BenefitPlanRegistry();
    const adminWalletId = Poseidon.hash([Field(999)]);

    // Register plan template
    const planTemplate = new PlanTemplate(TEST_PLAN_CONFIG);
    const planTemplates = new Map<string, PlanTemplate>();
    planTemplates.set('PLAN-GOLD-2026', planTemplate);

    // Register group
    const groupConfig = buildGroupConfig(TEST_GROUP_LOCAL);
    groupRegistry.addGroup(groupConfig, TEST_GROUP_LOCAL);

    const service = new EnrollmentService(
      walletRegistry,
      lifecycleTree,
      tokenAuthority,
      groupRegistry,
      planTemplates,
      opaqueRoster,
      benefitPlanRegistry,
      adminWalletId,
    );

    return {
      service,
      walletRegistry,
      lifecycleTree,
      tokenAuthority,
      groupRegistry,
      opaqueRoster,
      benefitPlanRegistry,
      adminWalletId,
      planTemplate,
    };
  }

  test('processEnrollment: full ceremony end-to-end', () => {
    const ctx = setupService();

    // Step A: Employer generates token
    ctx.tokenAuthority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-001',
    );

    // Step B: Member computes wallet ID on device (simulated)
    const walletId = deriveMemberWalletId(TEST_MEMBER, TEST_ENROLLMENT_KEY);

    // Step C: Insurer processes enrollment with (walletId, tokenId)
    const result = ctx.service.processEnrollment(
      walletId,
      'TOKEN-001',
      '20260115',
    );

    // Verify result
    expect(result.walletId.toString()).toBe(walletId.toString());
    expect(result.groupId).toBe('ACME-CORP-001');
    expect(result.planId).toBe('PLAN-GOLD-2026');
    expect(result.credentialIndex).toBe(0n);
    expect(result.rosterIndex).toBe(0n);

    // Verify credential
    expect(result.credentialData.credentialType.toString()).toBe(
      CREDENTIAL_TYPE_ELIGIBILITY.toString(),
    );
    expect(result.credentialData.subjectWalletId.toString()).toBe(
      walletId.toString(),
    );
    expect(result.credentialData.issuerWalletId.toString()).toBe(
      ctx.adminWalletId.toString(),
    );
    expect(result.credentialData.revoked.toString()).toBe('0');

    // Verify wallet is registered
    expect(ctx.walletRegistry.isRegistered(walletId)).toBe(true);
    expect(ctx.walletRegistry.getState(walletId).nonce.toString()).toBe('1');

    // Verify roster
    expect(ctx.opaqueRoster.isEnrolled(walletId)).toBe(true);

    // Verify token consumed
    const tokenRecord = ctx.tokenAuthority.getTokenRecord('TOKEN-001')!;
    expect(tokenRecord.status).toBe('consumed');
    expect(tokenRecord.consumedByWalletId).toBe(walletId.toString());

    // Verify group enrolled count incremented
    const group = ctx.groupRegistry.getGroupByHash(
      hashString('ACME-CORP-001'),
    )!;
    expect(group.config.enrolledCount.toString()).toBe('1');
  });

  test('processEnrollment: credential has correct forest structure', () => {
    const ctx = setupService();
    ctx.tokenAuthority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-002',
    );

    const walletId = deriveMemberWalletId(TEST_MEMBER, TEST_ENROLLMENT_KEY);
    const result = ctx.service.processEnrollment(
      walletId,
      'TOKEN-002',
      '20260115',
    );

    // Verify the forest root was computed from eligibility + accumulator data
    const forest = ctx.service.getMemberForest(walletId);
    expect(forest).toBeDefined();
    expect(result.credentialData.forestRoot.toString()).toBe(
      forest!.getForestRoot().toString(),
    );

    // Eligibility data at ACCESS_CONTROL leaf 0
    const eligLeaf = forest!.getLeaf(ForestDomain.ACCESS_CONTROL, 0n);
    expect(eligLeaf.toString()).not.toBe(Field(0).toString());

    // Accumulator data at ACCESS_CONTROL leaf 127
    const accLeaf = forest!.getLeaf(
      ForestDomain.ACCESS_CONTROL,
      ACCUMULATOR_LEAF_INDEX,
    );
    expect(accLeaf.toString()).not.toBe(Field(0).toString());
  });

  test('processEnrollment: rejects invalid token', () => {
    const ctx = setupService();
    const walletId = Poseidon.hash([Field(42)]);

    expect(() =>
      ctx.service.processEnrollment(walletId, 'FAKE-TOKEN', '20260115'),
    ).toThrow('Token validation failed: Token not found');
  });

  test('processEnrollment: rejects expired token', () => {
    const ctx = setupService();
    ctx.tokenAuthority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-EXPIRED',
    );

    const walletId = Poseidon.hash([Field(42)]);
    expect(() =>
      ctx.service.processEnrollment(walletId, 'TOKEN-EXPIRED', '20260301'),
    ).toThrow('Token validation failed: Token expired');
  });

  test('processEnrollment: rejects duplicate wallet', () => {
    const ctx = setupService();
    const walletId = deriveMemberWalletId(TEST_MEMBER, TEST_ENROLLMENT_KEY);

    ctx.tokenAuthority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-001',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-DUP1',
    );
    ctx.tokenAuthority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-002',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-DUP2',
    );

    ctx.service.processEnrollment(walletId, 'TOKEN-DUP1', '20260115');

    expect(() =>
      ctx.service.processEnrollment(walletId, 'TOKEN-DUP2', '20260115'),
    ).toThrow('Wallet already registered');
  });

  test('processEnrollment: rejects unknown plan', () => {
    const ctx = setupService();

    // Register a second group with a different plan that has no template
    const otherGroup = buildGroupConfig({
      groupId: 'BETA-CORP',
      planId: 'PLAN-PLATINUM',
      effectiveDate: '20260101',
      terminationDate: '20261231',
      enrollmentCap: 50,
    });
    ctx.groupRegistry.addGroup(otherGroup, {
      groupId: 'BETA-CORP',
      planId: 'PLAN-PLATINUM',
      effectiveDate: '20260101',
      terminationDate: '20261231',
      enrollmentCap: 50,
    });

    ctx.tokenAuthority.generateToken(
      'BETA-CORP',
      'PLAN-PLATINUM',
      'EMP-999',
      'FAM-BETA-001',
      '20260228',
      'TOKEN-NO-PLAN',
    );

    const walletId = Poseidon.hash([Field(77)]);
    expect(() =>
      ctx.service.processEnrollment(walletId, 'TOKEN-NO-PLAN', '20260115'),
    ).toThrow('Plan template not found: PLAN-PLATINUM');
  });

  test('processEnrollment: enforces enrollment cap', () => {
    // Create a group with cap of 2
    const walletRegistry = new WalletRegistry();
    const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const tokenAuthority = new TokenAuthority('ACME Corporation');
    const groupRegistry = new GroupRegistry();
    const opaqueRoster = new OpaqueRoster();
    const benefitPlanRegistry = new BenefitPlanRegistry();
    const adminWalletId = Poseidon.hash([Field(999)]);

    const planTemplate = new PlanTemplate(TEST_PLAN_CONFIG);
    const planTemplates = new Map<string, PlanTemplate>();
    planTemplates.set('PLAN-GOLD-2026', planTemplate);

    const tinyGroup = buildGroupConfig({
      groupId: 'TINY-CORP',
      planId: 'PLAN-GOLD-2026',
      effectiveDate: '20260101',
      terminationDate: '20261231',
      enrollmentCap: 2,
    });
    groupRegistry.addGroup(tinyGroup, {
      groupId: 'TINY-CORP',
      planId: 'PLAN-GOLD-2026',
      effectiveDate: '20260101',
      terminationDate: '20261231',
      enrollmentCap: 2,
    });

    const service = new EnrollmentService(
      walletRegistry,
      lifecycleTree,
      tokenAuthority,
      groupRegistry,
      planTemplates,
      opaqueRoster,
      benefitPlanRegistry,
      adminWalletId,
    );

    // Enroll 2 members
    for (let i = 1; i <= 2; i++) {
      tokenAuthority.generateToken(
        'TINY-CORP',
        'PLAN-GOLD-2026',
        `EMP-${i}`,
        `FAM-TINY-${i}`,
        '20260228',
        `TINY-TOKEN-${i}`,
      );
      service.processEnrollment(
        Poseidon.hash([Field(i)]),
        `TINY-TOKEN-${i}`,
        '20260115',
      );
    }

    // Third enrollment should fail
    tokenAuthority.generateToken(
      'TINY-CORP',
      'PLAN-GOLD-2026',
      'EMP-3',
      'FAM-TINY-3',
      '20260228',
      'TINY-TOKEN-3',
    );
    expect(() =>
      service.processEnrollment(
        Poseidon.hash([Field(3)]),
        'TINY-TOKEN-3',
        '20260115',
      ),
    ).toThrow('Group enrollment cap reached');
  });

  test('terminateMember: revokes credential and updates lifecycle', () => {
    const ctx = setupService();
    ctx.tokenAuthority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-TERM',
    );

    const walletId = deriveMemberWalletId(TEST_MEMBER, TEST_ENROLLMENT_KEY);
    ctx.service.processEnrollment(walletId, 'TOKEN-TERM', '20260115');

    // Verify enrolled
    expect(ctx.opaqueRoster.isEnrolled(walletId)).toBe(true);
    const groupBefore = ctx.groupRegistry.getGroupByHash(
      hashString('ACME-CORP-001'),
    )!;
    expect(groupBefore.config.enrolledCount.toString()).toBe('1');

    // Terminate
    const termResult = ctx.service.terminateMember(walletId, '20260630');

    expect(termResult.walletId.toString()).toBe(walletId.toString());

    // Verify credential revoked
    const inventory = ctx.service.getMemberInventory(walletId);
    const credential = inventory!.getCredential(0n);
    expect(credential!.revoked.toString()).toBe('1');

    // Verify roster updated
    const rosterEntry = ctx.opaqueRoster.getEntryByWallet(walletId)!;
    expect(rosterEntry.entry.status.toString()).toBe(
      ENROLLMENT_STATUS_TERMINATED.toString(),
    );
    expect(rosterEntry.entry.terminatedDate.toString()).toBe('20260630');

    // Verify group count decremented
    const groupAfter = ctx.groupRegistry.getGroupByHash(
      hashString('ACME-CORP-001'),
    )!;
    expect(groupAfter.config.enrolledCount.toString()).toBe('0');
  });

  test('terminateGroup: terminates all members in a group', () => {
    const ctx = setupService();

    // Enroll 3 members
    const walletIds: Field[] = [];
    for (let i = 1; i <= 3; i++) {
      ctx.tokenAuthority.generateToken(
        'ACME-CORP-001',
        'PLAN-GOLD-2026',
        `EMP-${i}`,
        `FAM-ACME-${i}`,
        '20260228',
        `TOKEN-GRP-${i}`,
      );
      const wId = Poseidon.hash([Field(i * 1000)]);
      ctx.service.processEnrollment(wId, `TOKEN-GRP-${i}`, '20260115');
      walletIds.push(wId);
    }

    // Verify all enrolled
    expect(
      ctx.groupRegistry
        .getGroupByHash(hashString('ACME-CORP-001'))!
        .config.enrolledCount.toString(),
    ).toBe('3');

    // Terminate entire group
    const groupResult = ctx.service.terminateGroup(
      'ACME-CORP-001',
      '20260630',
    );

    expect(groupResult.terminatedCount).toBe(3);
    expect(groupResult.terminations.length).toBe(3);

    // Verify group is TERMINATED
    const group = ctx.groupRegistry.getGroupByHash(
      hashString('ACME-CORP-001'),
    )!;
    expect(group.config.status.toString()).toBe(
      GROUP_STATUS_TERMINATED.toString(),
    );
    expect(group.config.enrolledCount.toString()).toBe('0');

    // Verify all members terminated
    for (const wId of walletIds) {
      const roster = ctx.opaqueRoster.getEntryByWallet(wId)!;
      expect(roster.entry.status.toString()).toBe(
        ENROLLMENT_STATUS_TERMINATED.toString(),
      );
    }
  });

  test('terminateMember: rejects unknown wallet', () => {
    const ctx = setupService();
    const unknownWallet = Poseidon.hash([Field(9999)]);

    expect(() =>
      ctx.service.terminateMember(unknownWallet, '20260630'),
    ).toThrow('Wallet not registered');
  });

  test('processEnrollment: multiple members in same group get same plan data', () => {
    const ctx = setupService();

    const results = [];
    for (let i = 1; i <= 3; i++) {
      ctx.tokenAuthority.generateToken(
        'ACME-CORP-001',
        'PLAN-GOLD-2026',
        `EMP-${i}`,
        `FAM-ACME-${i}`,
        '20260228',
        `TOKEN-MULTI-${i}`,
      );
      const wId = Poseidon.hash([Field(i * 100)]);
      results.push(
        ctx.service.processEnrollment(wId, `TOKEN-MULTI-${i}`, '20260115'),
      );
    }

    // All credentials should be ELIGIBILITY type with same issuer
    for (const r of results) {
      expect(r.credentialData.credentialType.toString()).toBe(
        CREDENTIAL_TYPE_ELIGIBILITY.toString(),
      );
      expect(r.credentialData.issuerWalletId.toString()).toBe(
        ctx.adminWalletId.toString(),
      );
      expect(r.planId).toBe('PLAN-GOLD-2026');
      expect(r.groupId).toBe('ACME-CORP-001');
    }

    // Forest roots should be identical (same plan, same data)
    // because each member gets the same eligibility + accumulator config
    expect(results[0]!.credentialData.forestRoot.toString()).toBe(
      results[1]!.credentialData.forestRoot.toString(),
    );
    expect(results[1]!.credentialData.forestRoot.toString()).toBe(
      results[2]!.credentialData.forestRoot.toString(),
    );
  });

  test('processEnrollment: insurer sees only opaque data', () => {
    const ctx = setupService();
    ctx.tokenAuthority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-OPAQUE',
    );

    const walletId = deriveMemberWalletId(TEST_MEMBER, TEST_ENROLLMENT_KEY);
    const result = ctx.service.processEnrollment(
      walletId,
      'TOKEN-OPAQUE',
      '20260115',
    );

    // The insurer received walletId — an opaque Poseidon hash
    // They cannot reverse it to get: name, DOB, enrollment key
    // They only know planId and groupId (they created these)
    const rosterEntry = ctx.opaqueRoster.getEntryByWallet(walletId)!;

    // All fields are either the walletId (opaque) or hashes of insurer-known data
    expect(rosterEntry.entry.walletId.toString()).toBe(
      walletId.toString(),
    );
    expect(rosterEntry.entry.planIdHash.toString()).toBe(
      hashString('PLAN-GOLD-2026').toString(),
    );
    expect(rosterEntry.entry.groupIdHash.toString()).toBe(
      hashString('ACME-CORP-001').toString(),
    );

    // The insurer does NOT have: member name, DOB, cardholder ID, enrollment key
    // There is no way to extract these from walletId — it's a one-way Poseidon hash
  });
});
