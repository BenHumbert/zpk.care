/**
 * Family Identity + Accumulator Pooling Tests
 *
 * Tests:
 *   1. FamilyAccumulatorService — stateless family accumulator pooling
 *   2. Demo data — familyId field, getMembersByFamily helper
 *   3. Enrollment token/roster — familyIdHash threading
 *   4. OpaqueRoster — getEntriesByFamily
 *
 * All tests are FAST (no ZkProgram compilation).
 *
 * Run: npx jest tests/family.test.ts --verbose
 */
import { Field, Poseidon } from 'o1js';
import { hashString } from '../src/zkp/hash-utils.js';

import {
  FamilyAccumulatorService,
} from '../src/onboarding/family-accumulator-service.js';
import type {
  FamilyLimits,
  MemberAccumulator,
} from '../src/onboarding/family-accumulator-service.js';

import {
  DEMO_MEMBERS,
  getMembersByFamily,
  getMembersByEmployee,
  getSubscribers,
} from '../src/data/index.js';

import {
  buildGroupEnrollmentToken,
} from '../src/onboarding/group-enrollment-token.js';
import type { GroupEnrollmentTokenLocalData } from '../src/onboarding/group-enrollment-token.js';

import {
  buildRosterEntry,
  OpaqueRoster,
} from '../src/onboarding/opaque-roster.js';

// ─── Test Data ─────────────────────────────────────────────

const FAMILY_LIMITS: FamilyLimits = {
  familyDeductibleAmountCents: 100000,   // $1,000
  familyOopMaxCents: 1600000,            // $16,000
  familyAnnualBenefitMaxCents: 0,        // unlimited
};

const MEMBER_A: MemberAccumulator = {
  deductiblePaidCents: 30000,   // $300
  oopPaidCents: 50000,          // $500
  annualBenefitUsedCents: 200000,
};

const MEMBER_B: MemberAccumulator = {
  deductiblePaidCents: 20000,   // $200
  oopPaidCents: 30000,          // $300
  annualBenefitUsedCents: 100000,
};

const MEMBER_C: MemberAccumulator = {
  deductiblePaidCents: 0,
  oopPaidCents: 0,
  annualBenefitUsedCents: 0,
};

// ─── Tests ─────────────────────────────────────────────────

describe('FamilyAccumulatorService — getFamilyTotals', () => {
  test('sums accumulators across family', () => {
    const totals = FamilyAccumulatorService.getFamilyTotals([MEMBER_A, MEMBER_B, MEMBER_C]);
    expect(totals.deductiblePaidCents).toBe(50000);
    expect(totals.oopPaidCents).toBe(80000);
    expect(totals.annualBenefitUsedCents).toBe(300000);
    expect(totals.memberCount).toBe(3);
  });

  test('single-member family equals individual', () => {
    const totals = FamilyAccumulatorService.getFamilyTotals([MEMBER_A]);
    expect(totals.deductiblePaidCents).toBe(30000);
    expect(totals.oopPaidCents).toBe(50000);
    expect(totals.memberCount).toBe(1);
  });

  test('empty family returns zero totals', () => {
    const totals = FamilyAccumulatorService.getFamilyTotals([]);
    expect(totals.deductiblePaidCents).toBe(0);
    expect(totals.oopPaidCents).toBe(0);
    expect(totals.annualBenefitUsedCents).toBe(0);
    expect(totals.memberCount).toBe(0);
  });
});

describe('FamilyAccumulatorService — deductible checks', () => {
  test('family deductible met when combined exceeds limit', () => {
    const totals = FamilyAccumulatorService.getFamilyTotals([MEMBER_A, MEMBER_B]);
    // Combined: $500 deductible paid vs $1,000 limit
    expect(FamilyAccumulatorService.isFamilyDeductibleMet(totals, FAMILY_LIMITS)).toBe(false);

    // Add enough to exceed
    const bigMember: MemberAccumulator = { deductiblePaidCents: 60000, oopPaidCents: 0, annualBenefitUsedCents: 0 };
    const totals2 = FamilyAccumulatorService.getFamilyTotals([MEMBER_A, MEMBER_B, bigMember]);
    // Combined: $500 + $600 = $1,100 > $1,000
    expect(FamilyAccumulatorService.isFamilyDeductibleMet(totals2, FAMILY_LIMITS)).toBe(true);
  });

  test('returns false when family deductible is 0 (individual only)', () => {
    const noFamilyLimits: FamilyLimits = { familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0 };
    const totals = FamilyAccumulatorService.getFamilyTotals([MEMBER_A, MEMBER_B]);
    expect(FamilyAccumulatorService.isFamilyDeductibleMet(totals, noFamilyLimits)).toBe(false);
  });
});

describe('FamilyAccumulatorService — OOPM checks', () => {
  test('family OOPM met when combined exceeds limit', () => {
    // Need $16,000 combined OOP
    const highOop: MemberAccumulator = { deductiblePaidCents: 0, oopPaidCents: 1600000, annualBenefitUsedCents: 0 };
    const totals = FamilyAccumulatorService.getFamilyTotals([highOop]);
    expect(FamilyAccumulatorService.isFamilyOopMaxMet(totals, FAMILY_LIMITS)).toBe(true);
  });

  test('family OOPM not met when below limit', () => {
    const totals = FamilyAccumulatorService.getFamilyTotals([MEMBER_A, MEMBER_B]);
    // Combined: $800 OOP vs $16,000 limit
    expect(FamilyAccumulatorService.isFamilyOopMaxMet(totals, FAMILY_LIMITS)).toBe(false);
  });
});

describe('FamilyAccumulatorService — computeFamilyAdjustedPay', () => {
  test('family OOPM met → patient pays $0', () => {
    const highOopTotals = FamilyAccumulatorService.getFamilyTotals([
      { deductiblePaidCents: 50000, oopPaidCents: 1600000, annualBenefitUsedCents: 0 },
    ]);
    const result = FamilyAccumulatorService.computeFamilyAdjustedPay(3000, 10000, highOopTotals, FAMILY_LIMITS);
    expect(result.patientPayCents).toBe(0);
    expect(result.planPayCents).toBe(10000);
    expect(result.familyPoolingApplied).toBe(true);
    expect(result.reason).toContain('out-of-pocket maximum met');
  });

  test('family benefit exhausted → patient pays full cost', () => {
    const limits: FamilyLimits = { familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 500000 };
    const totals = FamilyAccumulatorService.getFamilyTotals([
      { deductiblePaidCents: 0, oopPaidCents: 0, annualBenefitUsedCents: 500000 },
    ]);
    const result = FamilyAccumulatorService.computeFamilyAdjustedPay(3000, 10000, totals, limits);
    expect(result.patientPayCents).toBe(10000);
    expect(result.planPayCents).toBe(0);
    expect(result.familyPoolingApplied).toBe(true);
    expect(result.reason).toContain('benefit maximum exhausted');
  });

  test('caps patient pay when claim would exceed family OOPM', () => {
    // Family has $15,900 OOP, limit is $16,000, individual claim would be $200
    const totals = FamilyAccumulatorService.getFamilyTotals([
      { deductiblePaidCents: 50000, oopPaidCents: 1590000, annualBenefitUsedCents: 0 },
    ]);
    const result = FamilyAccumulatorService.computeFamilyAdjustedPay(20000, 30000, totals, FAMILY_LIMITS);
    // Should cap at $100 remaining OOP
    expect(result.patientPayCents).toBe(10000); // $100.00
    expect(result.planPayCents).toBe(20000);    // $200.00
    expect(result.familyPoolingApplied).toBe(true);
    expect(result.reason).toContain('capped');
  });

  test('no adjustment when below limits', () => {
    const totals = FamilyAccumulatorService.getFamilyTotals([MEMBER_A, MEMBER_B]);
    const result = FamilyAccumulatorService.computeFamilyAdjustedPay(3000, 10000, totals, FAMILY_LIMITS);
    expect(result.patientPayCents).toBe(3000);
    expect(result.planPayCents).toBe(7000);
    expect(result.familyPoolingApplied).toBe(false);
    expect(result.reason).toContain('Individual');
  });

  test('no adjustment when family limits are 0 (individual only)', () => {
    const noFamilyLimits: FamilyLimits = { familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0 };
    const totals = FamilyAccumulatorService.getFamilyTotals([MEMBER_A]);
    const result = FamilyAccumulatorService.computeFamilyAdjustedPay(3000, 10000, totals, noFamilyLimits);
    expect(result.patientPayCents).toBe(3000);
    expect(result.familyPoolingApplied).toBe(false);
  });
});

describe('Demo Data — familyId', () => {
  test('all members have a familyId', () => {
    for (const m of DEMO_MEMBERS) {
      expect(m.familyId).toBeDefined();
      expect(m.familyId.length).toBeGreaterThan(0);
    }
  });

  test('familyId is consistent within families', () => {
    // Carol, Daniel, Emma Williams share FAM-ACME-10003
    const carol = DEMO_MEMBERS.find(m => m.localData.firstName === 'Carol')!;
    const daniel = DEMO_MEMBERS.find(m => m.localData.firstName === 'Daniel')!;
    const emma = DEMO_MEMBERS.find(m => m.localData.firstName === 'Emma')!;
    expect(carol.familyId).toBe('FAM-ACME-10003');
    expect(daniel.familyId).toBe('FAM-ACME-10003');
    expect(emma.familyId).toBe('FAM-ACME-10003');
  });

  test('single members have unique familyIds', () => {
    const alice = DEMO_MEMBERS.find(m => m.localData.firstName === 'Alice')!;
    const bob = DEMO_MEMBERS.find(m => m.localData.firstName === 'Bob')!;
    expect(alice.familyId).not.toBe(bob.familyId);
    expect(alice.familyId).toBe('FAM-ACME-10001');
    expect(bob.familyId).toBe('FAM-ACME-10002');
  });

  test('Williams family has 3 members', () => {
    const family = getMembersByFamily('FAM-ACME-10003');
    expect(family.length).toBe(3);

    const relationships = family.map(m => m.relationship).sort();
    expect(relationships).toEqual(['CHILD', 'SELF', 'SPOUSE']);
  });

  test('getMembersByFamily returns correct members', () => {
    // Single-person family
    const aliceFamily = getMembersByFamily('FAM-ACME-10001');
    expect(aliceFamily.length).toBe(1);
    expect(aliceFamily[0]!.localData.firstName).toBe('Alice');

    // Empty lookup
    const none = getMembersByFamily('FAM-NONEXISTENT');
    expect(none.length).toBe(0);

    // Globex single
    const frank = getMembersByFamily('FAM-GX-50001');
    expect(frank.length).toBe(1);
    expect(frank[0]!.localData.firstName).toBe('Frank');
  });

  test('familyId aligns with employeeId grouping', () => {
    // Members with same employeeId should have same familyId
    const emp10003 = getMembersByEmployee('EMP-10003');
    const familyIds = new Set(emp10003.map(m => m.familyId));
    expect(familyIds.size).toBe(1);
    expect(familyIds.has('FAM-ACME-10003')).toBe(true);
  });
});

describe('GroupEnrollmentToken — familyIdHash', () => {
  test('token includes familyIdHash', () => {
    const local: GroupEnrollmentTokenLocalData = {
      tokenId: 'TOKEN-F1',
      groupId: 'ACME-CORP',
      planId: 'PLAN-GOLD',
      employeeId: 'EMP-10003',
      familyId: 'FAM-ACME-10003',
      validUntil: '20261231',
      issuer: 'ACME Corp',
      nonce: 0,
    };
    const token = buildGroupEnrollmentToken(local);
    expect(token.familyIdHash.toString()).toBe(hashString('FAM-ACME-10003').toString());
  });

  test('different familyIds produce different commitments', () => {
    const base: GroupEnrollmentTokenLocalData = {
      tokenId: 'TOKEN-F2',
      groupId: 'ACME-CORP',
      planId: 'PLAN-GOLD',
      employeeId: 'EMP-10003',
      familyId: 'FAM-A',
      validUntil: '20261231',
      issuer: 'ACME Corp',
      nonce: 0,
    };
    const tokenA = buildGroupEnrollmentToken(base);
    const tokenB = buildGroupEnrollmentToken({ ...base, familyId: 'FAM-B' });
    expect(tokenA.commitment().toString()).not.toBe(tokenB.commitment().toString());
  });
});

describe('OpaqueRoster — family indexing', () => {
  test('getEntriesByFamily returns correct members', () => {
    const roster = new OpaqueRoster();

    const wallet1 = Poseidon.hash([Field(1001)]);
    const wallet2 = Poseidon.hash([Field(1002)]);
    const wallet3 = Poseidon.hash([Field(1003)]);

    // Two members in same family
    roster.addEntry(buildRosterEntry(wallet1, {
      planId: 'PLAN-GOLD', groupId: 'ACME', familyId: 'FAM-001',
      enrolledDate: '20260101', tokenId: 'T1',
    }));
    roster.addEntry(buildRosterEntry(wallet2, {
      planId: 'PLAN-GOLD', groupId: 'ACME', familyId: 'FAM-001',
      enrolledDate: '20260102', tokenId: 'T2',
    }));
    // One member in different family
    roster.addEntry(buildRosterEntry(wallet3, {
      planId: 'PLAN-GOLD', groupId: 'ACME', familyId: 'FAM-002',
      enrolledDate: '20260103', tokenId: 'T3',
    }));

    const fam1 = roster.getEntriesByFamily(hashString('FAM-001'));
    expect(fam1.length).toBe(2);

    const fam2 = roster.getEntriesByFamily(hashString('FAM-002'));
    expect(fam2.length).toBe(1);

    const fam3 = roster.getEntriesByFamily(hashString('FAM-999'));
    expect(fam3.length).toBe(0);
  });

  test('family members share same familyIdHash', () => {
    const roster = new OpaqueRoster();
    const wallet1 = Poseidon.hash([Field(2001)]);
    const wallet2 = Poseidon.hash([Field(2002)]);

    roster.addEntry(buildRosterEntry(wallet1, {
      planId: 'PLAN-GOLD', groupId: 'ACME', familyId: 'FAM-SHARED',
      enrolledDate: '20260101', tokenId: 'T10',
    }));
    roster.addEntry(buildRosterEntry(wallet2, {
      planId: 'PLAN-GOLD', groupId: 'ACME', familyId: 'FAM-SHARED',
      enrolledDate: '20260102', tokenId: 'T11',
    }));

    const entry1 = roster.getEntryByWallet(wallet1)!;
    const entry2 = roster.getEntryByWallet(wallet2)!;
    expect(entry1.entry.familyIdHash.toString()).toBe(
      entry2.entry.familyIdHash.toString(),
    );
    expect(entry1.entry.familyIdHash.toString()).toBe(
      hashString('FAM-SHARED').toString(),
    );
  });
});
