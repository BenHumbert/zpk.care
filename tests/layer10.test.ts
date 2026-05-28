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

import { Field, Poseidon, Encoding } from 'o1js';
import { ReportingService } from '../src/reporting/reporting-service.js';
import { hashString } from '../src/zkp/hash-utils.js';
import type {
  VerifiedClaim,
  ClaimContext,
  PriorAuthContext,
  DateRange,
  ReportFilter,
} from '../src/reporting/report-types.js';
import {
  FulfillmentOutput,
  FULFILL_OP_CLAIM,
  FULFILL_OP_REVERSAL,
} from '../src/fulfillment/fulfillment-program.js';
import {
  MSG_TYPE_SUPPORT,
  MSG_TYPE_SUPPORT_SUMMARY,
  MSG_TYPE_GENERAL,
} from '../src/messaging/message-data.js';

// ─── Test Data ──────────────────────────────────────────────

const pharmacyWalletId1 = '777666555444333222';
const pharmacyWalletId2 = '777666555444333223';
const prescriberWalletId1 = '111222333444555666';
const prescriberWalletId2 = '111222333444555667';
const memberWalletId1 = '999888777666555444';
const memberWalletId2 = '999888777666555445';

const ndcHash1 = Poseidon.hash([Field(12345)]).toString(); // Mock NDC hash
const ndcHash2 = Poseidon.hash([Field(67890)]).toString(); // Another NDC hash

function makeClaim(overrides: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return {
    prescriptionHash: Poseidon.hash([Field(1001)]).toString(),
    entryCommitment: Poseidon.hash([Field(2001)]).toString(),
    patientPayCents: 1000,
    planPayCents: 4000,
    operationType: 'fulfillment',
    pharmacyWalletId: pharmacyWalletId1,
    memberWalletId: memberWalletId1,
    prescriberWalletId: prescriberWalletId1,
    ndcHash: ndcHash1,
    ingredientCostCents: 4500,
    dispensingFeeCents: 500,
    quantityDispensed: '30000', // 30 units x1000
    dateOfService: 20260115,
    ...overrides,
  };
}

function makeReversal(overrides: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return makeClaim({
    operationType: 'reversal',
    entryCommitment: Poseidon.hash([Field(3001)]).toString(),
    ...overrides,
  });
}

// Build a realistic set of claims for report tests
function buildTestClaims(): VerifiedClaim[] {
  return [
    // Claim 1: Pharmacy1, Member1, Prescriber1, NDC1, Jan 15
    makeClaim({
      dateOfService: 20260115,
    }),
    // Claim 2: Pharmacy1, Member2, Prescriber1, NDC2, Jan 20
    makeClaim({
      prescriptionHash: Poseidon.hash([Field(1002)]).toString(),
      entryCommitment: Poseidon.hash([Field(2002)]).toString(),
      memberWalletId: memberWalletId2,
      ndcHash: ndcHash2,
      patientPayCents: 2000,
      planPayCents: 3000,
      ingredientCostCents: 4000,
      dispensingFeeCents: 1000,
      quantityDispensed: '60000',
      dateOfService: 20260120,
    }),
    // Claim 3: Pharmacy2, Member1, Prescriber2, NDC1, Feb 5
    makeClaim({
      prescriptionHash: Poseidon.hash([Field(1003)]).toString(),
      entryCommitment: Poseidon.hash([Field(2003)]).toString(),
      pharmacyWalletId: pharmacyWalletId2,
      prescriberWalletId: prescriberWalletId2,
      patientPayCents: 1000,
      planPayCents: 5500,
      ingredientCostCents: 6000,
      dispensingFeeCents: 500,
      quantityDispensed: '30000',
      dateOfService: 20260205,
    }),
    // Reversal of Claim 2
    makeReversal({
      prescriptionHash: Poseidon.hash([Field(1002)]).toString(),
      entryCommitment: Poseidon.hash([Field(3002)]).toString(),
      memberWalletId: memberWalletId2,
      ndcHash: ndcHash2,
      patientPayCents: 2000,
      planPayCents: 3000,
      ingredientCostCents: 4000,
      dispensingFeeCents: 1000,
      quantityDispensed: '60000',
      dateOfService: 20260125,
    }),
  ];
}

// ─── Tests ──────────────────────────────────────────────────

describe('Layer 10 — On-Chain Reporting', () => {
  let service: ReportingService;

  beforeAll(() => {
    service = new ReportingService();
  });

  // ─── Message Type Constants ─────────────────────────────

  describe('Support Message Type Constants', () => {
    test('MSG_TYPE_SUPPORT is Field(6)', () => {
      expect(MSG_TYPE_SUPPORT.toString()).toBe('6');
    });

    test('MSG_TYPE_SUPPORT_SUMMARY is Field(7)', () => {
      expect(MSG_TYPE_SUPPORT_SUMMARY.toString()).toBe('7');
    });

    test('support types are distinct from existing types', () => {
      const existing = [Field(1), Field(2), Field(3), Field(4), Field(5)];
      for (const t of existing) {
        expect(MSG_TYPE_SUPPORT.toString()).not.toBe(t.toString());
        expect(MSG_TYPE_SUPPORT_SUMMARY.toString()).not.toBe(t.toString());
      }
    });
  });

  // ─── VerifiedClaim Extraction ───────────────────────────

  describe('VerifiedClaim Extraction', () => {
    const context: ClaimContext = {
      pharmacyWalletId: pharmacyWalletId1,
      memberWalletId: memberWalletId1,
      prescriberWalletId: prescriberWalletId1,
      ndcHash: ndcHash1,
      ingredientCostCents: 4500,
      dispensingFeeCents: 500,
      quantityDispensed: '30000',
      dateOfService: 20260115,
    };

    test('extracts fulfillment from proof output + context', () => {
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(12345n),
        oldForestRoot: Field(111n),
        newForestRoot: Field(222n),
        entryCommitment: Field(333n),
        patientPayCents: Field(1000n),
        planPayCents: Field(4000n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      const claim = service.extractVerifiedClaim(proofOutput, context);

      expect(claim.operationType).toBe('fulfillment');
      expect(claim.prescriptionHash).toBe('12345');
      expect(claim.patientPayCents).toBe(1000);
      expect(claim.planPayCents).toBe(4000);
    });

    test('extracts reversal from proof output + context', () => {
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(12345n),
        oldForestRoot: Field(111n),
        newForestRoot: Field(222n),
        entryCommitment: Field(444n),
        patientPayCents: Field(1000n),
        planPayCents: Field(4000n),
        operationType: FULFILL_OP_REVERSAL,
        ndcHash: Field(0),
      });

      const claim = service.extractVerifiedClaim(proofOutput, context);

      expect(claim.operationType).toBe('reversal');
      expect(claim.patientPayCents).toBe(1000);
      expect(claim.planPayCents).toBe(4000);
    });

    test('preserves context fields correctly', () => {
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(99n),
        oldForestRoot: Field(111n),
        newForestRoot: Field(222n),
        entryCommitment: Field(333n),
        patientPayCents: Field(500n),
        planPayCents: Field(2000n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      const claim = service.extractVerifiedClaim(proofOutput, context);

      expect(claim.pharmacyWalletId).toBe(pharmacyWalletId1);
      expect(claim.memberWalletId).toBe(memberWalletId1);
      expect(claim.prescriberWalletId).toBe(prescriberWalletId1);
      expect(claim.ndcHash).toBe(ndcHash1);
      expect(claim.ingredientCostCents).toBe(4500);
      expect(claim.dispensingFeeCents).toBe(500);
      expect(claim.quantityDispensed).toBe('30000');
      expect(claim.dateOfService).toBe(20260115);
    });

    test('handles large BigInt amounts', () => {
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(1n),
        oldForestRoot: Field(2n),
        newForestRoot: Field(3n),
        entryCommitment: Field(4n),
        patientPayCents: Field(9999999n),
        planPayCents: Field(88888888n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      const claim = service.extractVerifiedClaim(proofOutput, context);

      expect(claim.patientPayCents).toBe(9999999);
      expect(claim.planPayCents).toBe(88888888);
    });
  });

  // ─── Context Verification ──────────────────────────────

  describe('Context Verification', () => {
    test('returns true for consistent context', () => {
      // Build a FulfillmentData-like commitment from known values
      const prescriptionHash = '12345';
      const context: ClaimContext = {
        pharmacyWalletId: '777',
        memberWalletId: '888',
        prescriberWalletId: '999',
        ndcHash: '555',
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
      };

      // Build the expected commitment (matches FulfillmentData.commitment())
      const expectedCommitment = Poseidon.hash([
        Field(BigInt(prescriptionHash)),
        Field(BigInt(context.pharmacyWalletId)),
        Field(BigInt(context.ndcHash)),
        Field(BigInt(context.quantityDispensed)),
        Field(BigInt(context.ingredientCostCents)),
        Field(BigInt(context.dispensingFeeCents)),
        Field(BigInt(context.dateOfService)),
      ]);

      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(BigInt(prescriptionHash)),
        oldForestRoot: Field(1n),
        newForestRoot: Field(2n),
        entryCommitment: expectedCommitment,
        patientPayCents: Field(500n),
        planPayCents: Field(4500n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      expect(service.verifyContext(proofOutput, context, prescriptionHash)).toBe(true);
    });

    test('returns false for tampered context', () => {
      const prescriptionHash = '12345';
      const context: ClaimContext = {
        pharmacyWalletId: '777',
        memberWalletId: '888',
        prescriberWalletId: '999',
        ndcHash: '555',
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
      };

      // Build commitment from DIFFERENT data
      const fakeCommitment = Poseidon.hash([Field(999999n)]);

      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(BigInt(prescriptionHash)),
        oldForestRoot: Field(1n),
        newForestRoot: Field(2n),
        entryCommitment: fakeCommitment,
        patientPayCents: Field(500n),
        planPayCents: Field(4500n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      expect(service.verifyContext(proofOutput, context, prescriptionHash)).toBe(false);
    });

    test('detects tampered ingredientCostCents', () => {
      const prescriptionHash = '12345';
      const originalContext: ClaimContext = {
        pharmacyWalletId: '777',
        memberWalletId: '888',
        prescriberWalletId: '999',
        ndcHash: '555',
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
      };

      const expectedCommitment = Poseidon.hash([
        Field(BigInt(prescriptionHash)),
        Field(BigInt(originalContext.pharmacyWalletId)),
        Field(BigInt(originalContext.ndcHash)),
        Field(BigInt(originalContext.quantityDispensed)),
        Field(BigInt(originalContext.ingredientCostCents)),
        Field(BigInt(originalContext.dispensingFeeCents)),
        Field(BigInt(originalContext.dateOfService)),
      ]);

      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(BigInt(prescriptionHash)),
        oldForestRoot: Field(1n),
        newForestRoot: Field(2n),
        entryCommitment: expectedCommitment,
        patientPayCents: Field(500n),
        planPayCents: Field(4500n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      // Tamper with ingredientCostCents
      const tamperedContext = { ...originalContext, ingredientCostCents: 9999 };
      expect(service.verifyContext(proofOutput, tamperedContext, prescriptionHash)).toBe(false);
    });
  });

  // ─── Settlement Verification ───────────────────────────

  describe('Settlement Verification', () => {
    test('isAlreadySettled returns true when forest roots match', () => {
      const forestRoot = Poseidon.hash([Field(42n)]);
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(1n),
        oldForestRoot: Field(2n),
        newForestRoot: forestRoot,
        entryCommitment: Field(4n),
        patientPayCents: Field(1000n),
        planPayCents: Field(4000n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      expect(service.isAlreadySettled(proofOutput, forestRoot)).toBe(true);
    });

    test('isAlreadySettled returns false for new claim', () => {
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(1n),
        oldForestRoot: Field(2n),
        newForestRoot: Field(3n),
        entryCommitment: Field(4n),
        patientPayCents: Field(1000n),
        planPayCents: Field(4000n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      // Current forest root is different from the proof's newForestRoot
      const currentRoot = Field(999n);
      expect(service.isAlreadySettled(proofOutput, currentRoot)).toBe(false);
    });

    test('double-payment prevention with same proof', () => {
      const newRoot = Poseidon.hash([Field(100n), Field(200n)]);
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(1n),
        oldForestRoot: Field(2n),
        newForestRoot: newRoot,
        entryCommitment: Field(4n),
        patientPayCents: Field(500n),
        planPayCents: Field(2500n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      // Before settlement: not yet settled
      expect(service.isAlreadySettled(proofOutput, Field(2n))).toBe(false);

      // After settlement: credential now has the new forest root
      expect(service.isAlreadySettled(proofOutput, newRoot)).toBe(true);
    });
  });

  // ─── Claims Register Report ────────────────────────────

  describe('Claims Register Report', () => {
    test('generates chronological register with cost breakdown', () => {
      const claims = buildTestClaims();
      const report = service.generateClaimsRegister(claims);

      expect(report.claims).toHaveLength(4);
      expect(report.totalClaimCount).toBe(3); // 3 fulfillments
      expect(report.totalReversalCount).toBe(1); // 1 reversal
      expect(report.costBreakdown.totalGrossCostCents).toBe(4500 + 500 + 4000 + 1000 + 6000 + 500);
    });

    test('filters by date range', () => {
      const claims = buildTestClaims();
      const dateRange: DateRange = { startDate: 20260101, endDate: 20260131 };
      const report = service.generateClaimsRegister(claims, dateRange);

      // Only Jan claims (claim 1: Jan 15, claim 2: Jan 20, reversal: Jan 25)
      expect(report.claims).toHaveLength(3);
      expect(report.totalClaimCount).toBe(2);
      expect(report.totalReversalCount).toBe(1);
      expect(report.dateRange).toEqual(dateRange);
    });
  });

  // ─── Pharmacy Activity Report ──────────────────────────

  describe('Pharmacy Activity Report', () => {
    test('groups by pharmacy with unique counts', () => {
      const claims = buildTestClaims();
      const report = service.generatePharmacyActivity(claims);

      expect(report.pharmacies).toHaveLength(2);

      const pharmacy1 = report.pharmacies.find(p => p.pharmacyWalletId === pharmacyWalletId1);
      expect(pharmacy1).toBeDefined();
      expect(pharmacy1!.claimCount).toBe(2); // claims 1 and 2
      expect(pharmacy1!.reversalCount).toBe(1); // reversal of claim 2
      expect(pharmacy1!.uniqueMembers).toBe(2); // member1 and member2

      const pharmacy2 = report.pharmacies.find(p => p.pharmacyWalletId === pharmacyWalletId2);
      expect(pharmacy2).toBeDefined();
      expect(pharmacy2!.claimCount).toBe(1); // claim 3
      expect(pharmacy2!.reversalCount).toBe(0);
    });

    test('computes unique medication counts', () => {
      const claims = buildTestClaims();
      const report = service.generatePharmacyActivity(claims);

      const pharmacy1 = report.pharmacies.find(p => p.pharmacyWalletId === pharmacyWalletId1)!;
      expect(pharmacy1.uniqueMedications).toBe(2); // ndcHash1 and ndcHash2
    });
  });

  // ─── Prescriber Activity Report ────────────────────────

  describe('Prescriber Activity Report', () => {
    test('groups by prescriber with unique counts', () => {
      const claims = buildTestClaims();
      const report = service.generatePrescriberActivity(claims);

      expect(report.prescribers).toHaveLength(2);

      const prescriber1 = report.prescribers.find(p => p.prescriberWalletId === prescriberWalletId1);
      expect(prescriber1).toBeDefined();
      expect(prescriber1!.claimCount).toBe(2);
      expect(prescriber1!.uniqueMembers).toBe(2);
    });

    test('counts unique prescriptions', () => {
      const claims = buildTestClaims();
      const report = service.generatePrescriberActivity(claims);

      const prescriber1 = report.prescribers.find(p => p.prescriberWalletId === prescriberWalletId1)!;
      // Prescriber1 has 3 entries (claim1, claim2, reversal of claim2) with 2 unique prescriptionHashes
      expect(prescriber1.prescriptionCount).toBe(2);
    });
  });

  // ─── Member Activity Report ────────────────────────────

  describe('Member Activity Report', () => {
    test('groups by member with current medications', () => {
      const claims = buildTestClaims();
      const report = service.generateMemberActivity(claims);

      expect(report.members).toHaveLength(2);

      const member1 = report.members.find(m => m.memberWalletId === memberWalletId1);
      expect(member1).toBeDefined();
      expect(member1!.claimCount).toBe(2); // claims 1 and 3
      expect(member1!.reversalCount).toBe(0);
      expect(member1!.currentMedications).toContain(ndcHash1);
    });

    test('excludes reversed medications from current list', () => {
      const claims = buildTestClaims();
      const report = service.generateMemberActivity(claims);

      const member2 = report.members.find(m => m.memberWalletId === memberWalletId2);
      expect(member2).toBeDefined();
      expect(member2!.claimCount).toBe(1); // claim 2
      expect(member2!.reversalCount).toBe(1); // reversal of claim 2
      // ndcHash2 was reversed — should NOT be in current medications
      expect(member2!.currentMedications).not.toContain(ndcHash2);
    });
  });

  // ─── Medication Utilization Report ─────────────────────

  describe('Medication Utilization Report', () => {
    test('ranks medications by claim count descending', () => {
      const claims = buildTestClaims();
      const report = service.generateMedicationUtilization(claims);

      expect(report.medications).toHaveLength(2);
      // ndcHash1 has 2 claims, ndcHash2 has 1 claim
      expect(report.medications[0]!.ndcHash).toBe(ndcHash1);
      expect(report.medications[0]!.totalClaimCount).toBe(2);
      expect(report.medications[1]!.ndcHash).toBe(ndcHash2);
      expect(report.medications[1]!.totalClaimCount).toBe(1);
    });

    test('accumulates quantity from fulfillments only', () => {
      const claims = buildTestClaims();
      const report = service.generateMedicationUtilization(claims);

      const ndc1 = report.medications.find(m => m.ndcHash === ndcHash1)!;
      // Two fulfillments at 30000 each
      expect(ndc1.totalQuantity).toBe('60000');

      const ndc2 = report.medications.find(m => m.ndcHash === ndcHash2)!;
      // One fulfillment at 60000 (reversal doesn't add)
      expect(ndc2.totalQuantity).toBe('60000');
    });
  });

  // ─── Financial Summary Report ──────────────────────────

  describe('Financial Summary Report', () => {
    test('computes totals and averages', () => {
      const claims = buildTestClaims();
      const report = service.generateFinancialSummary(claims);

      expect(report.totalClaimCount).toBe(3);
      expect(report.totalReversalCount).toBe(1);

      // Gross cost from 3 fulfillments
      const grossCost = (4500 + 500) + (4000 + 1000) + (6000 + 500);
      expect(report.costBreakdown.totalGrossCostCents).toBe(grossCost);

      // Average claim cost = gross / 3 fulfillments
      expect(report.averageClaimCost).toBeCloseTo(grossCost / 3, 5);
    });

    test('net cost accounts for reversals', () => {
      const claims = buildTestClaims();
      const report = service.generateFinancialSummary(claims);

      const grossCost = (4500 + 500) + (4000 + 1000) + (6000 + 500);
      const reversalCost = (4000 + 1000); // reversed claim 2
      expect(report.costBreakdown.netCostCents).toBe(grossCost - reversalCost);
    });
  });

  // ─── Prior Auth Report ─────────────────────────────────

  describe('Prior Auth Report', () => {
    test('cross-references PAs with claims', () => {
      const claims = buildTestClaims();
      const priorAuths: PriorAuthContext[] = [{
        ndcHash: ndcHash1,
        memberWalletId: memberWalletId1,
        prescriberWalletId: prescriberWalletId1,
        approvalDate: 20260101,
        expirationDate: 20270101,
        approvedQuantity: '90000', // 90 units x1000
      }];

      const report = service.generatePriorAuthReport(claims, priorAuths);

      expect(report.priorAuths).toHaveLength(1);
      const pa = report.priorAuths[0]!;
      expect(pa.hasClaimActivity).toBe(true);
      // Member1 has claims 1 and 3 (both 30000 qty) matching NDC1
      expect(pa.utilizedQuantity).toBe('60000');
      // 60000 / 90000 = 0.6667
      expect(pa.utilizationRate).toBeCloseTo(0.6667, 3);
    });

    test('reports zero utilization for unused PA', () => {
      const claims = buildTestClaims();
      const priorAuths: PriorAuthContext[] = [{
        ndcHash: Poseidon.hash([Field(99999n)]).toString(), // Non-existent NDC
        memberWalletId: memberWalletId1,
        prescriberWalletId: prescriberWalletId1,
        approvalDate: 20260101,
        expirationDate: 20270101,
        approvedQuantity: '90000',
      }];

      const report = service.generatePriorAuthReport(claims, priorAuths);

      expect(report.priorAuths[0]!.hasClaimActivity).toBe(false);
      expect(report.priorAuths[0]!.utilizedQuantity).toBe('0');
      expect(report.priorAuths[0]!.utilizationRate).toBe(0);
    });
  });

  // ─── Reversal Report ───────────────────────────────────

  describe('Reversal Report', () => {
    test('includes only reversals with refund totals', () => {
      const claims = buildTestClaims();
      const report = service.generateReversalReport(claims);

      expect(report.reversals).toHaveLength(1);
      expect(report.reversals[0]!.operationType).toBe('reversal');
      expect(report.totalPatientRefundCents).toBe(2000);
      expect(report.totalPlanRefundCents).toBe(3000);
    });

    test('filters reversals by date range', () => {
      const claims = buildTestClaims();
      // Only Feb — should have no reversals
      const dateRange: DateRange = { startDate: 20260201, endDate: 20260228 };
      const report = service.generateReversalReport(claims, dateRange);

      expect(report.reversals).toHaveLength(0);
      expect(report.totalPatientRefundCents).toBe(0);
      expect(report.totalPlanRefundCents).toBe(0);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────

  describe('Edge Cases', () => {
    test('all reports handle empty claims array', () => {
      const empty: VerifiedClaim[] = [];

      const register = service.generateClaimsRegister(empty);
      expect(register.claims).toHaveLength(0);
      expect(register.totalClaimCount).toBe(0);
      expect(register.costBreakdown.totalGrossCostCents).toBe(0);

      const pharmacy = service.generatePharmacyActivity(empty);
      expect(pharmacy.pharmacies).toHaveLength(0);

      const prescriber = service.generatePrescriberActivity(empty);
      expect(prescriber.prescribers).toHaveLength(0);

      const member = service.generateMemberActivity(empty);
      expect(member.members).toHaveLength(0);

      const medication = service.generateMedicationUtilization(empty);
      expect(medication.medications).toHaveLength(0);

      const financial = service.generateFinancialSummary(empty);
      expect(financial.totalClaimCount).toBe(0);
      expect(financial.averageClaimCost).toBe(0);

      const reversal = service.generateReversalReport(empty);
      expect(reversal.reversals).toHaveLength(0);
    });

    test('single claim produces valid reports', () => {
      const single = [makeClaim()];

      const register = service.generateClaimsRegister(single);
      expect(register.totalClaimCount).toBe(1);
      expect(register.totalReversalCount).toBe(0);

      const financial = service.generateFinancialSummary(single);
      expect(financial.averageClaimCost).toBe(5000); // 4500 + 500
      expect(financial.averagePatientPay).toBe(1000);
      expect(financial.averagePlanPay).toBe(4000);
    });

    test('only reversals produce valid reports', () => {
      const onlyReversals = [makeReversal(), makeReversal({
        entryCommitment: Poseidon.hash([Field(3003)]).toString(),
        patientPayCents: 500,
        planPayCents: 1500,
      })];

      const register = service.generateClaimsRegister(onlyReversals);
      expect(register.totalClaimCount).toBe(0);
      expect(register.totalReversalCount).toBe(2);

      const reversal = service.generateReversalReport(onlyReversals);
      expect(reversal.reversals).toHaveLength(2);
      expect(reversal.totalPatientRefundCents).toBe(1000 + 500);
      expect(reversal.totalPlanRefundCents).toBe(4000 + 1500);

      const financial = service.generateFinancialSummary(onlyReversals);
      expect(financial.totalClaimCount).toBe(0);
      expect(financial.averageClaimCost).toBe(0);
    });

    test('mixed fulfillments and reversals net correctly', () => {
      const claims = [
        makeClaim({ patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
        makeReversal({ patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
      ];

      const financial = service.generateFinancialSummary(claims);
      // Net patient pay: 1000 - 1000 = 0
      expect(financial.costBreakdown.totalPatientPayCents).toBe(0);
      // Net plan pay: 4000 - 4000 = 0
      expect(financial.costBreakdown.totalPlanPayCents).toBe(0);
      // Net cost: 5000 - 5000 = 0
      expect(financial.costBreakdown.netCostCents).toBe(0);
    });

    test('H7 fix: averages use fulfillment-only data, not net after reversals', () => {
      // 2 fulfillments at $30 patient/$40 plan, 1 reversal refunding $30/$40
      const claims = [
        makeClaim({ patientPayCents: 3000, planPayCents: 4000, ingredientCostCents: 6500, dispensingFeeCents: 500 }),
        makeClaim({
          patientPayCents: 3000, planPayCents: 4000, ingredientCostCents: 6500, dispensingFeeCents: 500,
          entryCommitment: Poseidon.hash([Field(9999)]).toString(),
        }),
        makeReversal({ patientPayCents: 3000, planPayCents: 4000, ingredientCostCents: 6500, dispensingFeeCents: 500 }),
      ];

      const financial = service.generateFinancialSummary(claims);
      expect(financial.totalClaimCount).toBe(2);
      expect(financial.totalReversalCount).toBe(1);

      // Net cost breakdown accounts for reversals
      expect(financial.costBreakdown.totalPatientPayCents).toBe(3000); // 3000+3000-3000
      expect(financial.costBreakdown.totalPlanPayCents).toBe(4000);    // 4000+4000-4000

      // Averages should use fulfillment-only data (not net)
      // Before H7 fix: averagePatientPay = 3000 / 2 = 1500 (net / count, WRONG)
      // After H7 fix: averagePatientPay = 6000 / 2 = 3000 (fulfillment-only / count, CORRECT)
      expect(financial.averagePatientPay).toBe(3000);
      expect(financial.averagePlanPay).toBe(4000);
      expect(financial.averageClaimCost).toBe(7000); // (6500+500) per fulfillment
    });
  });

  // ─── Drug Data Enrichment (GAP 1) ─────────────────────────

  describe('Drug Data Enrichment', () => {
    const testNdc = '00071015523';
    const testNdcHash = hashString(testNdc).toString();

    test('enriched context fields propagate to VerifiedClaim', () => {
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(12345n),
        oldForestRoot: Field(111n),
        newForestRoot: Field(222n),
        entryCommitment: Field(333n),
        patientPayCents: Field(1000n),
        planPayCents: Field(4000n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      const context: ClaimContext = {
        pharmacyWalletId: pharmacyWalletId1,
        memberWalletId: memberWalletId1,
        prescriberWalletId: prescriberWalletId1,
        ndcHash: testNdcHash,
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
        // Drug enrichment
        ndc: testNdc,
        gpi: '27100060100310',
        daysSupply: 30,
        fillNumber: 0,
        brandName: 'Lisinopril',
        therapeuticClass: 'ACE Inhibitors',
        tierLevel: 1,
        dawCode: 0,
      };

      const claim = service.extractVerifiedClaim(proofOutput, context);

      expect(claim.ndc).toBe('00071015523');
      expect(claim.gpi).toBe('27100060100310');
      expect(claim.daysSupply).toBe(30);
      expect(claim.fillNumber).toBe(0);
      expect(claim.brandName).toBe('Lisinopril');
      expect(claim.therapeuticClass).toBe('ACE Inhibitors');
      expect(claim.tierLevel).toBe(1);
      expect(claim.dawCode).toBe(0);
    });

    test('extractVerifiedClaim works without enrichment (backward compat)', () => {
      const proofOutput = new FulfillmentOutput({
        prescriptionHash: Field(12345n),
        oldForestRoot: Field(111n),
        newForestRoot: Field(222n),
        entryCommitment: Field(333n),
        patientPayCents: Field(1000n),
        planPayCents: Field(4000n),
        operationType: FULFILL_OP_CLAIM,
        ndcHash: Field(0),
      });

      const context: ClaimContext = {
        pharmacyWalletId: pharmacyWalletId1,
        memberWalletId: memberWalletId1,
        prescriberWalletId: prescriberWalletId1,
        ndcHash: ndcHash1,
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
        // No drug enrichment fields
      };

      const claim = service.extractVerifiedClaim(proofOutput, context);

      expect(claim.ndc).toBeUndefined();
      expect(claim.gpi).toBeUndefined();
      expect(claim.daysSupply).toBeUndefined();
      expect(claim.tierLevel).toBeUndefined();
    });

    test('verifyNdc returns true for matching NDC', () => {
      const context: ClaimContext = {
        pharmacyWalletId: pharmacyWalletId1,
        memberWalletId: memberWalletId1,
        prescriberWalletId: prescriberWalletId1,
        ndcHash: testNdcHash,
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
        ndc: testNdc,
      };

      expect(service.verifyNdc(context)).toBe(true);
    });

    test('verifyNdc returns false for tampered NDC', () => {
      const context: ClaimContext = {
        pharmacyWalletId: pharmacyWalletId1,
        memberWalletId: memberWalletId1,
        prescriberWalletId: prescriberWalletId1,
        ndcHash: testNdcHash,
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
        ndc: '99999999999', // Wrong NDC
      };

      expect(service.verifyNdc(context)).toBe(false);
    });

    test('verifyNdc returns true when ndc is undefined', () => {
      const context: ClaimContext = {
        pharmacyWalletId: pharmacyWalletId1,
        memberWalletId: memberWalletId1,
        prescriberWalletId: prescriberWalletId1,
        ndcHash: ndcHash1,
        ingredientCostCents: 4500,
        dispensingFeeCents: 500,
        quantityDispensed: '30000',
        dateOfService: 20260115,
        // ndc not provided
      };

      expect(service.verifyNdc(context)).toBe(true);
    });

    test('existing reports work with enriched claims', () => {
      const claims = [
        makeClaim({
          ndc: testNdc,
          gpi: '27100060100310',
          daysSupply: 30,
          tierLevel: 1,
          therapeuticClass: 'ACE Inhibitors',
          brandName: 'Lisinopril',
        }),
        makeClaim({
          prescriptionHash: Poseidon.hash([Field(1002)]).toString(),
          ndcHash: ndcHash2,
          memberWalletId: memberWalletId2,
          ndc: '00002314001',
          gpi: '27700020000320',
          daysSupply: 30,
          tierLevel: 2,
          therapeuticClass: 'SGLT2 Inhibitors',
          brandName: 'Jardiance',
        }),
      ];

      // All existing reports should work without errors
      const register = service.generateClaimsRegister(claims);
      expect(register.totalClaimCount).toBe(2);

      const medUtil = service.generateMedicationUtilization(claims);
      expect(medUtil.medications.length).toBe(2);

      const financial = service.generateFinancialSummary(claims);
      expect(financial.totalClaimCount).toBe(2);
    });

    test('enriched claims preserve drug data through report generation', () => {
      const claims = [
        makeClaim({
          ndc: testNdc,
          gpi: '27100060100310',
          daysSupply: 30,
          tierLevel: 1,
          therapeuticClass: 'ACE Inhibitors',
          brandName: 'Lisinopril',
        }),
      ];

      const register = service.generateClaimsRegister(claims);
      const claim = register.claims[0];
      expect(claim.ndc).toBe(testNdc);
      expect(claim.gpi).toBe('27100060100310');
      expect(claim.tierLevel).toBe(1);
      expect(claim.therapeuticClass).toBe('ACE Inhibitors');
    });
  });

  // ─── QLIK-Style Dimensional Reporting (GAP 4) ─────────────

  describe('Multi-Dimensional Filtering', () => {
    // Build enriched claims for dimensional tests
    function buildEnrichedClaims(): VerifiedClaim[] {
      return [
        // Claim A: Pharmacy1, Member1, Prescriber1, Tier 1 (Generic), ACE Inhibitors, Jan 15
        makeClaim({
          dateOfService: 20260115,
          ndc: '00071015523',
          gpi: '27100060100310',
          tierLevel: 1,
          therapeuticClass: 'ACE Inhibitors',
          brandName: 'Lisinopril',
          patientPayCents: 1000,
          planPayCents: 4000,
          ingredientCostCents: 4500,
          dispensingFeeCents: 500,
        }),
        // Claim B: Pharmacy1, Member2, Prescriber1, Tier 2 (Preferred), SGLT2, Jan 20
        makeClaim({
          prescriptionHash: Poseidon.hash([Field(1002)]).toString(),
          entryCommitment: Poseidon.hash([Field(2002)]).toString(),
          memberWalletId: memberWalletId2,
          ndcHash: ndcHash2,
          dateOfService: 20260120,
          ndc: '00002314001',
          gpi: '27700020000320',
          tierLevel: 2,
          therapeuticClass: 'SGLT2 Inhibitors',
          brandName: 'Jardiance',
          patientPayCents: 3000,
          planPayCents: 7000,
          ingredientCostCents: 9000,
          dispensingFeeCents: 1000,
        }),
        // Claim C: Pharmacy2, Member1, Prescriber2, Tier 1 (Generic), ACE Inhibitors, Feb 5
        makeClaim({
          prescriptionHash: Poseidon.hash([Field(1003)]).toString(),
          entryCommitment: Poseidon.hash([Field(2003)]).toString(),
          pharmacyWalletId: pharmacyWalletId2,
          prescriberWalletId: prescriberWalletId2,
          dateOfService: 20260205,
          ndc: '00071015523',
          gpi: '27100060100310',
          tierLevel: 1,
          therapeuticClass: 'ACE Inhibitors',
          brandName: 'Lisinopril',
          patientPayCents: 1000,
          planPayCents: 5500,
          ingredientCostCents: 6000,
          dispensingFeeCents: 500,
        }),
        // Claim D: Pharmacy2, Member2, Prescriber2, Tier 4 (Specialty), Biologics, Feb 10
        makeClaim({
          prescriptionHash: Poseidon.hash([Field(1004)]).toString(),
          entryCommitment: Poseidon.hash([Field(2004)]).toString(),
          pharmacyWalletId: pharmacyWalletId2,
          memberWalletId: memberWalletId2,
          prescriberWalletId: prescriberWalletId2,
          ndcHash: Poseidon.hash([Field(11111)]).toString(),
          dateOfService: 20260210,
          ndc: '00074905502',
          gpi: '66400020002020',
          tierLevel: 4,
          therapeuticClass: 'TNF Inhibitors',
          brandName: 'Humira',
          patientPayCents: 15000,
          planPayCents: 135000,
          ingredientCostCents: 145000,
          dispensingFeeCents: 5000,
        }),
        // Reversal E: Pharmacy1, Member2, Tier 2, Jan 25 (reversal of Claim B)
        makeReversal({
          prescriptionHash: Poseidon.hash([Field(1002)]).toString(),
          entryCommitment: Poseidon.hash([Field(3002)]).toString(),
          memberWalletId: memberWalletId2,
          ndcHash: ndcHash2,
          dateOfService: 20260125,
          ndc: '00002314001',
          gpi: '27700020000320',
          tierLevel: 2,
          therapeuticClass: 'SGLT2 Inhibitors',
          patientPayCents: 3000,
          planPayCents: 7000,
          ingredientCostCents: 9000,
          dispensingFeeCents: 1000,
        }),
      ];
    }

    test('applyFilters with dateRange only (backward compat via normalizeFilter)', () => {
      const claims = buildEnrichedClaims();
      const dateRange: DateRange = { startDate: 20260101, endDate: 20260131 };
      // Pass DateRange directly — normalizeFilter should convert it
      const report = service.generateClaimsRegister(claims, dateRange);

      // Only Jan claims: A (Jan 15), B (Jan 20), E reversal (Jan 25)
      expect(report.claims).toHaveLength(3);
      expect(report.dateRange).toEqual(dateRange);
    });

    test('applyFilters with ReportFilter.dateRange', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = {
        dateRange: { startDate: 20260201, endDate: 20260228 },
      };
      const report = service.generateClaimsRegister(claims, filter);

      // Only Feb claims: C (Feb 5), D (Feb 10)
      expect(report.claims).toHaveLength(2);
    });

    test('applyFilters by pharmacyWalletIds', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = { pharmacyWalletIds: [pharmacyWalletId2] };
      const report = service.generateClaimsRegister(claims, filter);

      // Pharmacy2: C and D
      expect(report.claims).toHaveLength(2);
      expect(report.claims.every(c => c.pharmacyWalletId === pharmacyWalletId2)).toBe(true);
    });

    test('applyFilters by tierLevels', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = { tierLevels: [1] };
      const report = service.generateClaimsRegister(claims, filter);

      // Tier 1: A, C
      expect(report.claims).toHaveLength(2);
      expect(report.claims.every(c => c.tierLevel === 1)).toBe(true);
    });

    test('applyFilters by therapeuticClasses', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = { therapeuticClasses: ['ACE Inhibitors'] };
      const report = service.generateClaimsRegister(claims, filter);

      // ACE Inhibitors: A, C
      expect(report.claims).toHaveLength(2);
    });

    test('applyFilters by operationTypes (fulfillment only)', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = { operationTypes: ['fulfillment'] };
      const report = service.generateClaimsRegister(claims, filter);

      // 4 fulfillments (A, B, C, D), no reversal (E)
      expect(report.claims).toHaveLength(4);
      expect(report.totalReversalCount).toBe(0);
    });

    test('applyFilters combines multiple dimensions (AND logic)', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = {
        pharmacyWalletIds: [pharmacyWalletId2],
        tierLevels: [1],
        operationTypes: ['fulfillment'],
      };
      const report = service.generateClaimsRegister(claims, filter);

      // Pharmacy2 + Tier 1 + fulfillment = only C
      expect(report.claims).toHaveLength(1);
      expect(report.claims[0].dateOfService).toBe(20260205);
    });

    test('applyFilters by ndcs (plaintext NDC)', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = { ndcs: ['00071015523'] };
      const report = service.generateClaimsRegister(claims, filter);

      // NDC 00071015523: A, C (Lisinopril)
      expect(report.claims).toHaveLength(2);
    });

    test('applyFilters by gpis', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = { gpis: ['66400020002020'] };
      const report = service.generateClaimsRegister(claims, filter);

      // GPI 66400020002020: D (Humira only)
      expect(report.claims).toHaveLength(1);
      expect(report.claims[0].brandName).toBe('Humira');
    });

    test('existing reports accept ReportFilter (backward compat)', () => {
      const claims = buildEnrichedClaims();
      const filter: ReportFilter = { tierLevels: [1, 2] };

      const pharmacy = service.generatePharmacyActivity(claims, filter);
      expect(pharmacy.pharmacies.length).toBeGreaterThan(0);

      const prescriber = service.generatePrescriberActivity(claims, filter);
      expect(prescriber.prescribers.length).toBeGreaterThan(0);

      const member = service.generateMemberActivity(claims, filter);
      expect(member.members.length).toBeGreaterThan(0);

      const medUtil = service.generateMedicationUtilization(claims, filter);
      expect(medUtil.medications.length).toBeGreaterThan(0);

      const financial = service.generateFinancialSummary(claims, filter);
      expect(financial.totalClaimCount).toBeGreaterThan(0);

      const reversal = service.generateReversalReport(claims, filter);
      expect(reversal.reversals).toHaveLength(1); // only tier 2 reversal
    });
  });

  // ─── Tier Analysis Report ─────────────────────────────────

  describe('Tier Analysis Report', () => {
    function buildEnrichedClaims(): VerifiedClaim[] {
      return [
        makeClaim({ tierLevel: 1, therapeuticClass: 'ACE Inhibitors', patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1002)]).toString(), tierLevel: 1, therapeuticClass: 'ACE Inhibitors', patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500, memberWalletId: memberWalletId2 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1003)]).toString(), tierLevel: 2, therapeuticClass: 'SGLT2 Inhibitors', ndcHash: ndcHash2, patientPayCents: 3000, planPayCents: 7000, ingredientCostCents: 9000, dispensingFeeCents: 1000 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1004)]).toString(), tierLevel: 4, therapeuticClass: 'TNF Inhibitors', ndcHash: Poseidon.hash([Field(99)]).toString(), patientPayCents: 15000, planPayCents: 135000, ingredientCostCents: 145000, dispensingFeeCents: 5000 }),
      ];
    }

    test('groups claims by tier level with correct labels', () => {
      const claims = buildEnrichedClaims();
      const report = service.generateTierAnalysis(claims);

      expect(report.tiers).toHaveLength(3); // Tiers 1, 2, 4
      expect(report.tiers[0].tierLevel).toBe(1);
      expect(report.tiers[0].tierLabel).toBe('Generic');
      expect(report.tiers[1].tierLevel).toBe(2);
      expect(report.tiers[1].tierLabel).toBe('Preferred Brand');
      expect(report.tiers[2].tierLevel).toBe(4);
      expect(report.tiers[2].tierLabel).toBe('Specialty');
    });

    test('computes per-tier claim counts and costs', () => {
      const claims = buildEnrichedClaims();
      const report = service.generateTierAnalysis(claims);

      const tier1 = report.tiers.find(t => t.tierLevel === 1)!;
      expect(tier1.claimCount).toBe(2);
      expect(tier1.uniqueMembers).toBe(2);
      expect(tier1.costBreakdown.totalGrossCostCents).toBe(10000); // 2 * 5000

      const tier4 = report.tiers.find(t => t.tierLevel === 4)!;
      expect(tier4.claimCount).toBe(1);
      expect(tier4.costBreakdown.totalGrossCostCents).toBe(150000);
    });

    test('skips claims without tierLevel', () => {
      const claims = [
        makeClaim({ tierLevel: 1 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1005)]).toString() }), // no tierLevel
      ];
      const report = service.generateTierAnalysis(claims);

      expect(report.tiers).toHaveLength(1);
      expect(report.tiers[0].claimCount).toBe(1);
    });

    test('accepts ReportFilter', () => {
      const claims = buildEnrichedClaims();
      const report = service.generateTierAnalysis(claims, { operationTypes: ['fulfillment'] });

      expect(report.tiers.length).toBeGreaterThan(0);
      expect(report.filter).toBeDefined();
    });
  });

  // ─── Therapeutic Class Report ─────────────────────────────

  describe('Therapeutic Class Report', () => {
    test('groups claims by therapeutic class', () => {
      const claims = [
        makeClaim({ therapeuticClass: 'ACE Inhibitors', patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1002)]).toString(), therapeuticClass: 'ACE Inhibitors', patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1003)]).toString(), therapeuticClass: 'SGLT2 Inhibitors', ndcHash: ndcHash2, patientPayCents: 3000, planPayCents: 7000, ingredientCostCents: 9000, dispensingFeeCents: 1000 }),
      ];

      const report = service.generateTherapeuticClassReport(claims);

      expect(report.classes).toHaveLength(2);
      // Sorted by claim count descending
      expect(report.classes[0].therapeuticClass).toBe('ACE Inhibitors');
      expect(report.classes[0].claimCount).toBe(2);
      expect(report.classes[1].therapeuticClass).toBe('SGLT2 Inhibitors');
      expect(report.classes[1].claimCount).toBe(1);
    });

    test('skips claims without therapeuticClass', () => {
      const claims = [
        makeClaim({ therapeuticClass: 'ACE Inhibitors' }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1006)]).toString() }), // no therapeuticClass
      ];
      const report = service.generateTherapeuticClassReport(claims);

      expect(report.classes).toHaveLength(1);
    });
  });

  // ─── Time Series Report ───────────────────────────────────

  describe('Time Series Report', () => {
    test('aggregates by monthly bucket', () => {
      const claims = [
        makeClaim({ dateOfService: 20260115, patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1002)]).toString(), dateOfService: 20260120, patientPayCents: 2000, planPayCents: 3000, ingredientCostCents: 4000, dispensingFeeCents: 1000 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1003)]).toString(), dateOfService: 20260205, patientPayCents: 1000, planPayCents: 5500, ingredientCostCents: 6000, dispensingFeeCents: 500 }),
      ];

      const report = service.generateTimeSeries(claims, 'monthly');

      expect(report.bucket).toBe('monthly');
      expect(report.entries).toHaveLength(2); // Jan and Feb
      expect(report.entries[0].bucketKey).toBe('2026-01');
      expect(report.entries[0].claimCount).toBe(2);
      expect(report.entries[1].bucketKey).toBe('2026-02');
      expect(report.entries[1].claimCount).toBe(1);
    });

    test('aggregates by daily bucket', () => {
      const claims = [
        makeClaim({ dateOfService: 20260115 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1002)]).toString(), dateOfService: 20260115 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1003)]).toString(), dateOfService: 20260120 }),
      ];

      const report = service.generateTimeSeries(claims, 'daily');

      expect(report.entries).toHaveLength(2); // Jan 15 and Jan 20
      expect(report.entries[0].bucketKey).toBe('2026-01-15');
      expect(report.entries[0].claimCount).toBe(2);
      expect(report.entries[1].bucketKey).toBe('2026-01-20');
      expect(report.entries[1].claimCount).toBe(1);
    });

    test('handles reversals in time series', () => {
      const claims = [
        makeClaim({ dateOfService: 20260115 }),
        makeReversal({ dateOfService: 20260115 }),
      ];

      const report = service.generateTimeSeries(claims, 'daily');

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].claimCount).toBe(1);
      expect(report.entries[0].reversalCount).toBe(1);
    });

    test('applies filter to time series', () => {
      const claims = [
        makeClaim({ dateOfService: 20260115, tierLevel: 1 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1002)]).toString(), dateOfService: 20260115, tierLevel: 2 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1003)]).toString(), dateOfService: 20260120, tierLevel: 1 }),
      ];

      const report = service.generateTimeSeries(claims, 'daily', { tierLevels: [1] });

      expect(report.entries).toHaveLength(2);
      expect(report.entries[0].claimCount).toBe(1); // Jan 15 tier 1 only
      expect(report.entries[1].claimCount).toBe(1); // Jan 20 tier 1 only
    });
  });

  // ─── Cross-Tab (Pivot Table) Report ───────────────────────

  describe('Cross-Tab Report', () => {
    function buildCrossTabClaims(): VerifiedClaim[] {
      return [
        makeClaim({ pharmacyWalletId: pharmacyWalletId1, tierLevel: 1, patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1002)]).toString(), pharmacyWalletId: pharmacyWalletId1, tierLevel: 2, patientPayCents: 3000, planPayCents: 7000, ingredientCostCents: 9000, dispensingFeeCents: 1000 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1003)]).toString(), pharmacyWalletId: pharmacyWalletId2, tierLevel: 1, patientPayCents: 1000, planPayCents: 5500, ingredientCostCents: 6000, dispensingFeeCents: 500 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1004)]).toString(), pharmacyWalletId: pharmacyWalletId2, tierLevel: 1, patientPayCents: 1000, planPayCents: 4000, ingredientCostCents: 4500, dispensingFeeCents: 500 }),
      ];
    }

    test('pivot pharmacy x tier with claimCount', () => {
      const claims = buildCrossTabClaims();
      const report = service.generateCrossTab(claims, 'pharmacyWalletId', 'tierLevel', 'claimCount');

      expect(report.rowDimension).toBe('pharmacyWalletId');
      expect(report.colDimension).toBe('tierLevel');
      expect(report.measure).toBe('claimCount');
      expect(report.columnHeaders).toEqual(['1', '2']); // sorted

      // Find rows
      const row1 = report.rows.find(r => r.rowKey === pharmacyWalletId1);
      expect(row1).toBeDefined();
      expect(row1!.values).toEqual([1, 1]); // 1 tier-1 claim, 1 tier-2 claim

      const row2 = report.rows.find(r => r.rowKey === pharmacyWalletId2);
      expect(row2).toBeDefined();
      expect(row2!.values).toEqual([2, 0]); // 2 tier-1 claims, 0 tier-2 claims
    });

    test('pivot pharmacy x tier with totalPlanPayCents', () => {
      const claims = buildCrossTabClaims();
      const report = service.generateCrossTab(claims, 'pharmacyWalletId', 'tierLevel', 'totalPlanPayCents');

      const row1 = report.rows.find(r => r.rowKey === pharmacyWalletId1)!;
      expect(row1.values).toEqual([4000, 7000]); // tier 1: 4000, tier 2: 7000

      const row2 = report.rows.find(r => r.rowKey === pharmacyWalletId2)!;
      expect(row2.values).toEqual([9500, 0]); // tier 1: 5500+4000, tier 2: 0
    });

    test('pivot pharmacy x tier with totalGrossCostCents', () => {
      const claims = buildCrossTabClaims();
      const report = service.generateCrossTab(claims, 'pharmacyWalletId', 'tierLevel', 'totalGrossCostCents');

      const row1 = report.rows.find(r => r.rowKey === pharmacyWalletId1)!;
      expect(row1.values).toEqual([5000, 10000]); // tier 1: 4500+500, tier 2: 9000+1000

      const row2 = report.rows.find(r => r.rowKey === pharmacyWalletId2)!;
      expect(row2.values).toEqual([11500, 0]); // tier 1: (6000+500)+(4500+500), tier 2: 0
    });

    test('pivot with filter applied', () => {
      const claims = buildCrossTabClaims();
      const report = service.generateCrossTab(
        claims, 'pharmacyWalletId', 'tierLevel', 'claimCount',
        { pharmacyWalletIds: [pharmacyWalletId1] },
      );

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].rowKey).toBe(pharmacyWalletId1);
    });

    test('pivot with operationType dimension', () => {
      const claims = [
        makeClaim({ tierLevel: 1 }),
        makeReversal({ tierLevel: 1 }),
        makeClaim({ prescriptionHash: Poseidon.hash([Field(1007)]).toString(), tierLevel: 2 }),
      ];

      const report = service.generateCrossTab(claims, 'operationType', 'tierLevel', 'claimCount');

      expect(report.columnHeaders).toEqual(['1', '2']);
      const fulfillmentRow = report.rows.find(r => r.rowKey === 'fulfillment')!;
      expect(fulfillmentRow.values).toEqual([1, 1]);
      // reversal: claimCount only counts fulfillments, so reversal row has [0, 0]
      const reversalRow = report.rows.find(r => r.rowKey === 'reversal')!;
      expect(reversalRow.values).toEqual([0, 0]);
    });

    test('empty cross-tab for no matching claims', () => {
      const claims = buildCrossTabClaims();
      const report = service.generateCrossTab(
        claims, 'pharmacyWalletId', 'tierLevel', 'claimCount',
        { tierLevels: [3] }, // No tier 3 claims
      );

      expect(report.rows).toHaveLength(0);
      expect(report.columnHeaders).toHaveLength(0);
    });
  });
});
