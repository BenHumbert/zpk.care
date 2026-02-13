import { Field, Poseidon } from 'o1js';
import { FulfillmentOutput, FULFILL_OP_CLAIM, FULFILL_OP_REVERSAL } from '../fulfillment/fulfillment-program.js';
import type {
  VerifiedClaim,
  ClaimContext,
  PriorAuthContext,
  DateRange,
  CostBreakdown,
  ClaimsRegisterReport,
  PharmacyActivityReport,
  PharmacyActivityEntry,
  PrescriberActivityReport,
  PrescriberActivityEntry,
  MemberActivityReport,
  MemberActivityEntry,
  MedicationUtilizationReport,
  MedicationUtilizationEntry,
  FinancialSummaryReport,
  PriorAuthReport,
  PriorAuthUtilizationEntry,
  ReversalReport,
} from './report-types.js';

// ─── ReportingService ─────────────────────────────────────────

/**
 * ReportingService — stateless reporting for the insurer (PBM).
 *
 * ZERO BACKEND: No constructor state, no persistent storage, no database.
 * The insurer runs only a MINA light client (22kb chain).
 *
 * All methods take VerifiedClaim[] as input and return a report.
 * The caller constructs VerifiedClaim[] transiently from proofs that
 * participants present on demand, then purges after use.
 */
export class ReportingService {
  // ─── Proof Extraction ──────────────────────────────────────

  /**
   * Extract a VerifiedClaim from a verified FulfillmentProof output + pharmacy-provided context.
   *
   * Call this AFTER verifying the proof via FulfillmentProgram.verify().
   */
  extractVerifiedClaim(
    proofOutput: FulfillmentOutput,
    context: ClaimContext,
  ): VerifiedClaim {
    const opType = proofOutput.operationType.toString() === FULFILL_OP_CLAIM.toString()
      ? 'fulfillment' as const
      : 'reversal' as const;

    return {
      prescriptionHash: proofOutput.prescriptionHash.toString(),
      entryCommitment: proofOutput.entryCommitment.toString(),
      patientPayCents: Number(proofOutput.patientPayCents.toBigInt()),
      planPayCents: Number(proofOutput.planPayCents.toBigInt()),
      operationType: opType,
      pharmacyWalletId: context.pharmacyWalletId,
      memberWalletId: context.memberWalletId,
      prescriberWalletId: context.prescriberWalletId,
      ndcHash: context.ndcHash,
      ingredientCostCents: context.ingredientCostCents,
      dispensingFeeCents: context.dispensingFeeCents,
      quantityDispensed: context.quantityDispensed,
      dateOfService: context.dateOfService,
    };
  }

  // ─── Context Verification ──────────────────────────────────

  /**
   * Verify that a ClaimContext is consistent with the proof output.
   *
   * Rebuilds the FulfillmentData commitment from context fields and checks
   * it matches the proof's entryCommitment. This prevents pharmacies from
   * presenting tampered context alongside a valid proof.
   */
  verifyContext(
    proofOutput: FulfillmentOutput,
    context: ClaimContext,
    prescriptionHash: string,
  ): boolean {
    // Rebuild FulfillmentData commitment from context
    const rebuilt = Poseidon.hash([
      Field(BigInt(prescriptionHash)),
      Field(BigInt(context.pharmacyWalletId)),
      Field(BigInt(context.ndcHash)),
      Field(BigInt(context.quantityDispensed)),
      Field(BigInt(context.ingredientCostCents)),
      Field(BigInt(context.dispensingFeeCents)),
      Field(BigInt(context.dateOfService)),
    ]);

    return rebuilt.toString() === proofOutput.entryCommitment.toString();
  }

  // ─── Settlement Verification ───────────────────────────────

  /**
   * Check if a claim has already been settled (double-payment prevention).
   *
   * Compares the proof's newForestRoot against the current on-chain NFT forest root.
   * If the forest root transition has already been applied, the claim is settled.
   */
  isAlreadySettled(
    proofOutput: FulfillmentOutput,
    currentNftForestRoot: Field,
  ): boolean {
    return proofOutput.newForestRoot.toString() === currentNftForestRoot.toString();
  }

  // ─── Report Generation ─────────────────────────────────────

  /**
   * 1. Claims Register — chronological list of all verified claims.
   */
  generateClaimsRegister(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): ClaimsRegisterReport {
    const filtered = this.filterByDate(claims, dateRange);
    const fulfillments = filtered.filter(c => c.operationType === 'fulfillment');
    const reversals = filtered.filter(c => c.operationType === 'reversal');

    return {
      claims: filtered,
      costBreakdown: this.computeCostBreakdown(filtered),
      totalClaimCount: fulfillments.length,
      totalReversalCount: reversals.length,
      dateRange,
    };
  }

  /**
   * 2. Pharmacy Activity — per-pharmacy breakdown.
   */
  generatePharmacyActivity(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): PharmacyActivityReport {
    const filtered = this.filterByDate(claims, dateRange);
    const grouped = this.groupBy(filtered, c => c.pharmacyWalletId);

    const pharmacies: PharmacyActivityEntry[] = [];
    for (const [pharmacyWalletId, pharmacyClaims] of grouped.entries()) {
      const fulfillments = pharmacyClaims.filter(c => c.operationType === 'fulfillment');
      const reversals = pharmacyClaims.filter(c => c.operationType === 'reversal');

      pharmacies.push({
        pharmacyWalletId,
        claimCount: fulfillments.length,
        reversalCount: reversals.length,
        uniqueMedications: this.uniqueCount(pharmacyClaims, c => c.ndcHash),
        uniqueMembers: this.uniqueCount(pharmacyClaims, c => c.memberWalletId),
        costBreakdown: this.computeCostBreakdown(pharmacyClaims),
      });
    }

    return { pharmacies, dateRange };
  }

  /**
   * 3. Prescriber Activity — per-prescriber breakdown.
   */
  generatePrescriberActivity(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): PrescriberActivityReport {
    const filtered = this.filterByDate(claims, dateRange);
    const grouped = this.groupBy(filtered, c => c.prescriberWalletId);

    const prescribers: PrescriberActivityEntry[] = [];
    for (const [prescriberWalletId, prescriberClaims] of grouped.entries()) {
      const fulfillments = prescriberClaims.filter(c => c.operationType === 'fulfillment');

      prescribers.push({
        prescriberWalletId,
        prescriptionCount: this.uniqueCount(prescriberClaims, c => c.prescriptionHash),
        claimCount: fulfillments.length,
        uniqueMedications: this.uniqueCount(prescriberClaims, c => c.ndcHash),
        uniqueMembers: this.uniqueCount(prescriberClaims, c => c.memberWalletId),
        costBreakdown: this.computeCostBreakdown(prescriberClaims),
      });
    }

    return { prescribers, dateRange };
  }

  /**
   * 4. Member Activity — per-member breakdown.
   */
  generateMemberActivity(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): MemberActivityReport {
    const filtered = this.filterByDate(claims, dateRange);
    const grouped = this.groupBy(filtered, c => c.memberWalletId);

    const members: MemberActivityEntry[] = [];
    for (const [memberWalletId, memberClaims] of grouped.entries()) {
      const fulfillments = memberClaims.filter(c => c.operationType === 'fulfillment');
      const reversals = memberClaims.filter(c => c.operationType === 'reversal');

      // Current medications = fulfilled NDCs minus reversed NDCs
      const fulfilledNdcs = new Set(fulfillments.map(c => c.ndcHash));
      const reversedPrescriptions = new Set(reversals.map(c => c.prescriptionHash));
      const currentMedications = [...fulfilledNdcs].filter(ndc => {
        // Keep NDC if at least one fulfillment for it is NOT reversed
        return fulfillments.some(f =>
          f.ndcHash === ndc && !reversedPrescriptions.has(f.prescriptionHash),
        );
      });

      members.push({
        memberWalletId,
        claimCount: fulfillments.length,
        reversalCount: reversals.length,
        currentMedications,
        costBreakdown: this.computeCostBreakdown(memberClaims),
      });
    }

    return { members, dateRange };
  }

  /**
   * 5. Medication Utilization — per-NDC breakdown, sorted by claim count descending.
   */
  generateMedicationUtilization(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): MedicationUtilizationReport {
    const filtered = this.filterByDate(claims, dateRange);
    const grouped = this.groupBy(filtered, c => c.ndcHash);

    const medications: MedicationUtilizationEntry[] = [];
    for (const [ndcHash, ndcClaims] of grouped.entries()) {
      const fulfillments = ndcClaims.filter(c => c.operationType === 'fulfillment');
      const reversals = ndcClaims.filter(c => c.operationType === 'reversal');

      // Sum quantities from fulfillments only
      let totalQty = 0n;
      for (const f of fulfillments) {
        totalQty += BigInt(f.quantityDispensed);
      }

      medications.push({
        ndcHash,
        totalClaimCount: fulfillments.length,
        totalReversalCount: reversals.length,
        totalQuantity: totalQty.toString(),
        uniquePharmacies: this.uniqueCount(ndcClaims, c => c.pharmacyWalletId),
        uniquePrescribers: this.uniqueCount(ndcClaims, c => c.prescriberWalletId),
        uniqueMembers: this.uniqueCount(ndcClaims, c => c.memberWalletId),
      });
    }

    // Sort by total claim count descending
    medications.sort((a, b) => b.totalClaimCount - a.totalClaimCount);

    return { medications, dateRange };
  }

  /**
   * 6. Financial Summary — totals and averages.
   */
  generateFinancialSummary(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): FinancialSummaryReport {
    const filtered = this.filterByDate(claims, dateRange);
    const fulfillments = filtered.filter(c => c.operationType === 'fulfillment');
    const reversals = filtered.filter(c => c.operationType === 'reversal');
    const costBreakdown = this.computeCostBreakdown(filtered);

    const claimCount = fulfillments.length;

    return {
      costBreakdown,
      totalClaimCount: claimCount,
      totalReversalCount: reversals.length,
      averageClaimCost: claimCount > 0
        ? costBreakdown.totalGrossCostCents / claimCount
        : 0,
      averagePatientPay: claimCount > 0
        ? costBreakdown.totalPatientPayCents / claimCount
        : 0,
      averagePlanPay: claimCount > 0
        ? costBreakdown.totalPlanPayCents / claimCount
        : 0,
      dateRange,
    };
  }

  /**
   * 7. Prior Auth Report — cross-reference PAs with claims.
   */
  generatePriorAuthReport(
    claims: VerifiedClaim[],
    priorAuths: PriorAuthContext[],
    dateRange?: DateRange,
  ): PriorAuthReport {
    const filtered = this.filterByDate(claims, dateRange);

    const priorAuthEntries: PriorAuthUtilizationEntry[] = priorAuths.map(pa => {
      // Find fulfillment claims matching this PA (same NDC + member)
      const matchingClaims = filtered.filter(
        c =>
          c.operationType === 'fulfillment' &&
          c.ndcHash === pa.ndcHash &&
          c.memberWalletId === pa.memberWalletId,
      );

      let utilizedQty = 0n;
      for (const c of matchingClaims) {
        utilizedQty += BigInt(c.quantityDispensed);
      }

      const approvedQty = BigInt(pa.approvedQuantity);
      const utilizationRate = approvedQty > 0n
        ? Number(utilizedQty * 10000n / approvedQty) / 10000
        : 0;

      return {
        ndcHash: pa.ndcHash,
        memberWalletId: pa.memberWalletId,
        prescriberWalletId: pa.prescriberWalletId,
        approvalDate: pa.approvalDate,
        expirationDate: pa.expirationDate,
        approvedQuantity: pa.approvedQuantity,
        utilizedQuantity: utilizedQty.toString(),
        utilizationRate,
        hasClaimActivity: matchingClaims.length > 0,
      };
    });

    return { priorAuths: priorAuthEntries, dateRange };
  }

  /**
   * 8. Reversal Report — only reversals.
   */
  generateReversalReport(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): ReversalReport {
    const filtered = this.filterByDate(claims, dateRange);
    const reversals = filtered.filter(c => c.operationType === 'reversal');

    let totalPatientRefund = 0;
    let totalPlanRefund = 0;
    for (const r of reversals) {
      totalPatientRefund += r.patientPayCents;
      totalPlanRefund += r.planPayCents;
    }

    return {
      reversals,
      totalPatientRefundCents: totalPatientRefund,
      totalPlanRefundCents: totalPlanRefund,
      dateRange,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────

  private filterByDate(
    claims: VerifiedClaim[],
    dateRange?: DateRange,
  ): VerifiedClaim[] {
    if (!dateRange) return claims;
    return claims.filter(
      c => c.dateOfService >= dateRange.startDate && c.dateOfService <= dateRange.endDate,
    );
  }

  private computeCostBreakdown(claims: VerifiedClaim[]): CostBreakdown {
    let totalIngredient = 0;
    let totalDispensing = 0;
    let totalPatient = 0;
    let totalPlan = 0;

    // Track fulfillment vs reversal separately for net
    let grossFulfillmentCost = 0;
    let grossReversalCost = 0;

    for (const c of claims) {
      if (c.operationType === 'fulfillment') {
        totalIngredient += c.ingredientCostCents;
        totalDispensing += c.dispensingFeeCents;
        totalPatient += c.patientPayCents;
        totalPlan += c.planPayCents;
        grossFulfillmentCost += c.ingredientCostCents + c.dispensingFeeCents;
      } else {
        // Reversals: subtract from totals
        totalPatient -= c.patientPayCents;
        totalPlan -= c.planPayCents;
        grossReversalCost += c.ingredientCostCents + c.dispensingFeeCents;
      }
    }

    return {
      totalIngredientCostCents: totalIngredient,
      totalDispensingFeeCents: totalDispensing,
      totalPatientPayCents: totalPatient,
      totalPlanPayCents: totalPlan,
      totalGrossCostCents: grossFulfillmentCost,
      netCostCents: grossFulfillmentCost - grossReversalCost,
    };
  }

  private groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = keyFn(item);
      const arr = map.get(key);
      if (arr) {
        arr.push(item);
      } else {
        map.set(key, [item]);
      }
    }
    return map;
  }

  private uniqueCount<T>(items: T[], keyFn: (item: T) => string): number {
    return new Set(items.map(keyFn)).size;
  }
}
