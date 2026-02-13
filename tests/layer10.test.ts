import { Field, Poseidon } from 'o1js';
import { ReportingService } from '../src/reporting/reporting-service.js';
import type {
  VerifiedClaim,
  ClaimContext,
  PriorAuthContext,
  DateRange,
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
      });

      // Before settlement: not yet settled
      expect(service.isAlreadySettled(proofOutput, Field(2n))).toBe(false);

      // After settlement: NFT now has the new forest root
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
  });
});
