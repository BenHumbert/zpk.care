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

/**
 * Onboarding — Three-Party Enrollment Ceremony Tests
 *
 * Tests the full insurer onboarding flow:
 *   1. GroupEnrollmentToken — data model + builder
 *   2. PlanTemplate — benefit plan factory
 *   3. GroupRegistry — employer group management
 *   4. OpaqueRoster — walletId → plan/group mapping (zero PHI)
 *   5. TokenAuthority — employer-side token lifecycle
 *   6. EnrollmentService — terminating a console fixture member (all that is left of the in-process ceremony)
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
import { lifecycleLeafCommitment, LIFECYCLE_ELIGIBLE, LIFECYCLE_REVOKED } from '../src/engine/lifecycle.js';
import { BenefitPlanRegistry } from '../src/eligibility/benefit-plan-registry.js';
import { CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { MerkleForest, ForestDomain, TREE_HEIGHT } from '../src/zkp/merkle-forest.js';
import { ACCUMULATOR_LEAF_INDEX } from '../src/access-control/accumulator-data.js';
import {
  deriveMemberWalletId,
} from '../src/wallets/wallet-derivation.js';
import type { MemberLocalData } from '../src/models/member.js';
import { fixtureIdentitySalt } from '../src/data/index.js';

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

    expect(tokenId).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
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
    const { token } = authority.generateToken(
      'ACME-CORP-001',
      'PLAN-GOLD-2026',
      'EMP-12345',
      'FAM-TEST-001',
      '20260228',
      'TOKEN-A',
    );

    // since A-109 an invite carries the group's and the plan's hashes, never the IDs
    const result = authority.validateToken('TOKEN-A', '20260115');
    expect(result.valid).toBe(true);
    expect(result.groupIdHash).toBe(token.groupIdHash.toString());
    expect(result.planIdHash).toBe(token.planIdHash.toString());
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

describe('Onboarding — terminating a fixture member (EnrollmentService)', () => {
  // A fixture member is put on the trees the way the engine does it (AdjudicationService's fixture enrollment):
  // registered, ELIGIBLE, on the roster, counted in its group. Enrollment over the network never uses this service.
  function setupEnrolled(memberCount: number) {
    const walletRegistry = new WalletRegistry();
    const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const groupRegistry = new GroupRegistry();
    const opaqueRoster = new OpaqueRoster();
    groupRegistry.addGroup(buildGroupConfig(TEST_GROUP_LOCAL), TEST_GROUP_LOCAL);
    const walletIds: Field[] = [];
    for (let i = 1; i <= memberCount; i++) {
      const walletId = Poseidon.hash([Field(i * 1000)]);
      walletRegistry.register(walletId);
      lifecycleTree.setLeaf(walletRegistry.getIndex(walletId), lifecycleLeafCommitment(walletId, LIFECYCLE_ELIGIBLE));
      opaqueRoster.addEntry(buildRosterEntry(walletId, {
        planId: 'PLAN-GOLD-2026', groupId: 'ACME-CORP-001', familyId: `FAM-ACME-${i}`, enrolledDate: '20260115', tokenId: `TOKEN-${i}`,
      }));
      walletIds.push(walletId);
    }
    const group = groupRegistry.getGroupByHash(hashString('ACME-CORP-001'))!;
    groupRegistry.updateGroup(group.index, new GroupConfig({ ...group.config, enrolledCount: Field(memberCount) }));
    const service = new EnrollmentService(walletRegistry, lifecycleTree, groupRegistry, opaqueRoster);
    return { service, walletRegistry, lifecycleTree, groupRegistry, opaqueRoster, walletIds };
  }

  test('terminateMember: revokes the lifecycle, terminates the roster entry and counts the group down', () => {
    const ctx = setupEnrolled(2);
    const [walletId, other] = ctx.walletIds;
    const termResult = ctx.service.terminateMember(walletId, '20260630');

    expect(termResult.walletId.toString()).toBe(walletId.toString());
    expect(termResult.newLifecycleRoot.toString()).toBe(ctx.lifecycleTree.getRoot().toString());
    const index = ctx.walletRegistry.getIndex(walletId);
    expect(ctx.lifecycleTree.getNode(0, index).toString()).toBe(lifecycleLeafCommitment(walletId, LIFECYCLE_REVOKED).toString());

    const rosterEntry = ctx.opaqueRoster.getEntryByWallet(walletId)!;
    expect(rosterEntry.entry.status.toString()).toBe(ENROLLMENT_STATUS_TERMINATED.toString());
    expect(rosterEntry.entry.terminatedDate.toString()).toBe('20260630');
    // the other member is untouched
    expect(ctx.opaqueRoster.getEntryByWallet(other)!.entry.status.toString()).toBe(ENROLLMENT_STATUS_ACTIVE.toString());

    const group = ctx.groupRegistry.getGroupByHash(hashString('ACME-CORP-001'))!;
    expect(group.config.enrolledCount.toString()).toBe('1');
    expect(group.config.status.toString()).toBe(GROUP_STATUS_ACTIVE.toString());
  });

  test('terminateMember: rejects an unknown wallet', () => {
    const ctx = setupEnrolled(1);
    expect(() => ctx.service.terminateMember(Poseidon.hash([Field(9999)]), '20260630')).toThrow('Wallet not registered');
  });

  test('terminateMember: rejects a registered wallet that is not on the roster', () => {
    const ctx = setupEnrolled(1);
    const stranger = Poseidon.hash([Field(4242)]);
    ctx.walletRegistry.register(stranger);
    expect(() => ctx.service.terminateMember(stranger, '20260630')).toThrow('Wallet not in roster');
  });
});
