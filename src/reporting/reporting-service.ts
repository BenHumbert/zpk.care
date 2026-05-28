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

import { Field, Poseidon } from 'o1js';
import { hashString } from '../zkp/hash-utils.js';
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
  ReportFilter,
  TierAnalysisReport,
  TierAnalysisEntry,
  TherapeuticClassReport,
  TherapeuticClassEntry,
  TimeBucket,
  TimeSeriesReport,
  TimeSeriesEntry,
  CrossTabDimension,
  CrossTabMeasure,
  CrossTabReport,
  CrossTabRow,
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

      // Drug enrichment (propagated from pharmacy-provided context)
      ndc: context.ndc,
      gpi: context.gpi,
      daysSupply: context.daysSupply,
      fillNumber: context.fillNumber,
      brandName: context.brandName,
      therapeuticClass: context.therapeuticClass,
      tierLevel: context.tierLevel,
      dawCode: context.dawCode,
    };
  }

  // ─── Context Verification ──────────────────────────────────

  /**
   * Verify that a plaintext NDC hashes to the committed ndcHash.
   *
   * Uses the same hashString() function as buildFulfillmentData().
   * Returns true if ndc is undefined (no enrichment to verify).
   */
  verifyNdc(context: ClaimContext): boolean {
    if (!context.ndc) return true;
    const computedHash = hashString(context.ndc);
    return computedHash.toString() === context.ndcHash;
  }

  /**
   * Verify that a ClaimContext is consistent with the proof output.
   *
   * Rebuilds the FulfillmentData commitment from context fields and checks
   * it matches the proof's entryCommitment. This prevents pharmacies from
   * presenting tampered context alongside a valid proof.
   *
   * Also verifies plaintext NDC (if provided) hashes to ndcHash.
   */
  verifyContext(
    proofOutput: FulfillmentOutput,
    context: ClaimContext,
    prescriptionHash: string,
  ): boolean {
    // Verify plaintext NDC matches ndcHash (if enrichment provided)
    if (context.ndc && !this.verifyNdc(context)) {
      return false;
    }

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
   * Compares the proof's newForestRoot against the current on-chain credential forest root.
   * If the forest root transition has already been applied, the claim is settled.
   */
  isAlreadySettled(
    proofOutput: FulfillmentOutput,
    currentCredentialForestRoot: Field,
  ): boolean {
    return proofOutput.newForestRoot.toString() === currentCredentialForestRoot.toString();
  }

  // ─── Report Generation ─────────────────────────────────────

  /**
   * 1. Claims Register — chronological list of all verified claims.
   */
  generateClaimsRegister(
    claims: VerifiedClaim[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): ClaimsRegisterReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);
    const fulfillments = filtered.filter(c => c.operationType === 'fulfillment');
    const reversals = filtered.filter(c => c.operationType === 'reversal');

    return {
      claims: filtered,
      costBreakdown: this.computeCostBreakdown(filtered),
      totalClaimCount: fulfillments.length,
      totalReversalCount: reversals.length,
      dateRange: filter?.dateRange,
    };
  }

  /**
   * 2. Pharmacy Activity — per-pharmacy breakdown.
   */
  generatePharmacyActivity(
    claims: VerifiedClaim[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): PharmacyActivityReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);
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

    return { pharmacies, dateRange: filter?.dateRange };
  }

  /**
   * 3. Prescriber Activity — per-prescriber breakdown.
   */
  generatePrescriberActivity(
    claims: VerifiedClaim[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): PrescriberActivityReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);
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

    return { prescribers, dateRange: filter?.dateRange };
  }

  /**
   * 4. Member Activity — per-member breakdown.
   */
  generateMemberActivity(
    claims: VerifiedClaim[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): MemberActivityReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);
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

    return { members, dateRange: filter?.dateRange };
  }

  /**
   * 5. Medication Utilization — per-NDC breakdown, sorted by claim count descending.
   */
  generateMedicationUtilization(
    claims: VerifiedClaim[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): MedicationUtilizationReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);
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

    return { medications, dateRange: filter?.dateRange };
  }

  /**
   * 6. Financial Summary — totals and averages.
   */
  generateFinancialSummary(
    claims: VerifiedClaim[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): FinancialSummaryReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);
    const fulfillments = filtered.filter(c => c.operationType === 'fulfillment');
    const reversals = filtered.filter(c => c.operationType === 'reversal');
    const costBreakdown = this.computeCostBreakdown(filtered);

    // H7 fix: Compute averages from fulfillments only (not net after reversals).
    // The cost breakdown includes net totals (fulfillments minus reversals) which
    // is correct for overall financial reporting, but dividing net amounts by
    // fulfillment count produces incorrect per-claim averages.
    const claimCount = fulfillments.length;
    const fulfillmentCosts = this.computeCostBreakdown(fulfillments);

    return {
      costBreakdown,
      totalClaimCount: claimCount,
      totalReversalCount: reversals.length,
      averageClaimCost: claimCount > 0
        ? fulfillmentCosts.totalGrossCostCents / claimCount
        : 0,
      averagePatientPay: claimCount > 0
        ? fulfillmentCosts.totalPatientPayCents / claimCount
        : 0,
      averagePlanPay: claimCount > 0
        ? fulfillmentCosts.totalPlanPayCents / claimCount
        : 0,
      dateRange: filter?.dateRange,
    };
  }

  /**
   * 7. Prior Auth Report — cross-reference PAs with claims.
   */
  generatePriorAuthReport(
    claims: VerifiedClaim[],
    priorAuths: PriorAuthContext[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): PriorAuthReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);

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

    return { priorAuths: priorAuthEntries, dateRange: filter?.dateRange };
  }

  /**
   * 8. Reversal Report — only reversals.
   */
  generateReversalReport(
    claims: VerifiedClaim[],
    filterOrDateRange?: ReportFilter | DateRange,
  ): ReversalReport {
    const filter = this.normalizeFilter(filterOrDateRange);
    const filtered = this.applyFilters(claims, filter);
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
      dateRange: filter?.dateRange,
    };
  }

  // ─── Dimensional Reports (GAP 4) ──────────────────────────

  /** Tier label map for display. */
  private static readonly TIER_LABELS: Record<number, string> = {
    1: 'Generic',
    2: 'Preferred Brand',
    3: 'Non-Preferred Brand',
    4: 'Specialty',
  };

  /**
   * 9. Tier Analysis — breakdown by formulary tier level.
   */
  generateTierAnalysis(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): TierAnalysisReport {
    const filtered = this.applyFilters(claims, filter);
    // Only include claims with tierLevel set
    const tiered = filtered.filter(c => c.tierLevel !== undefined);
    const grouped = this.groupBy(tiered, c => String(c.tierLevel));

    const tiers: TierAnalysisEntry[] = [];
    for (const [tierStr, tierClaims] of grouped.entries()) {
      const tierLevel = Number(tierStr);
      const fulfillments = tierClaims.filter(c => c.operationType === 'fulfillment');
      const reversals = tierClaims.filter(c => c.operationType === 'reversal');

      tiers.push({
        tierLevel,
        tierLabel: ReportingService.TIER_LABELS[tierLevel] || `Tier ${tierLevel}`,
        claimCount: fulfillments.length,
        reversalCount: reversals.length,
        uniqueMembers: this.uniqueCount(tierClaims, c => c.memberWalletId),
        uniqueMedications: this.uniqueCount(tierClaims, c => c.ndcHash),
        costBreakdown: this.computeCostBreakdown(tierClaims),
      });
    }

    // Sort by tier level ascending
    tiers.sort((a, b) => a.tierLevel - b.tierLevel);

    return { tiers, filter };
  }

  /**
   * 10. Therapeutic Class Report — breakdown by therapeutic classification.
   */
  generateTherapeuticClassReport(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): TherapeuticClassReport {
    const filtered = this.applyFilters(claims, filter);
    const classified = filtered.filter(c => c.therapeuticClass !== undefined);
    const grouped = this.groupBy(classified, c => c.therapeuticClass!);

    const classes: TherapeuticClassEntry[] = [];
    for (const [therapeuticClass, classClaims] of grouped.entries()) {
      const fulfillments = classClaims.filter(c => c.operationType === 'fulfillment');
      const reversals = classClaims.filter(c => c.operationType === 'reversal');

      classes.push({
        therapeuticClass,
        claimCount: fulfillments.length,
        reversalCount: reversals.length,
        uniqueMembers: this.uniqueCount(classClaims, c => c.memberWalletId),
        uniqueMedications: this.uniqueCount(classClaims, c => c.ndcHash),
        costBreakdown: this.computeCostBreakdown(classClaims),
      });
    }

    // Sort by claim count descending
    classes.sort((a, b) => b.claimCount - a.claimCount);

    return { classes, filter };
  }

  /**
   * 11. Time Series — claims aggregated by time bucket (daily/weekly/monthly).
   */
  generateTimeSeries(
    claims: VerifiedClaim[],
    bucket: TimeBucket,
    filter?: ReportFilter,
  ): TimeSeriesReport {
    const filtered = this.applyFilters(claims, filter);
    const grouped = this.groupBy(filtered, c => this.toBucketKey(c.dateOfService, bucket));

    const entries: TimeSeriesEntry[] = [];
    for (const [bucketKey, bucketClaims] of grouped.entries()) {
      const fulfillments = bucketClaims.filter(c => c.operationType === 'fulfillment');
      const reversals = bucketClaims.filter(c => c.operationType === 'reversal');

      entries.push({
        bucketKey,
        claimCount: fulfillments.length,
        reversalCount: reversals.length,
        costBreakdown: this.computeCostBreakdown(bucketClaims),
      });
    }

    // Sort by bucket key ascending (chronological)
    entries.sort((a, b) => a.bucketKey.localeCompare(b.bucketKey));

    return { bucket, entries, filter };
  }

  /**
   * 12. Cross-Tab (Pivot Table) — any two dimensions pivoted against any measure.
   *
   * Example: pharmacy x tier with claimCount shows how many claims each pharmacy
   * filled per formulary tier.
   */
  generateCrossTab(
    claims: VerifiedClaim[],
    rowDimension: CrossTabDimension,
    colDimension: CrossTabDimension,
    measure: CrossTabMeasure,
    filter?: ReportFilter,
  ): CrossTabReport {
    const filtered = this.applyFilters(claims, filter);

    // Collect unique column values
    const colSet = new Set<string>();
    for (const c of filtered) {
      const colVal = this.getDimensionValue(c, colDimension);
      if (colVal !== undefined) colSet.add(colVal);
    }
    const columnHeaders = [...colSet].sort();

    // Group by row dimension
    const rowGroups = new Map<string, Map<string, VerifiedClaim[]>>();
    for (const c of filtered) {
      const rowVal = this.getDimensionValue(c, rowDimension);
      const colVal = this.getDimensionValue(c, colDimension);
      if (rowVal === undefined || colVal === undefined) continue;

      if (!rowGroups.has(rowVal)) rowGroups.set(rowVal, new Map());
      const colMap = rowGroups.get(rowVal)!;
      if (!colMap.has(colVal)) colMap.set(colVal, []);
      colMap.get(colVal)!.push(c);
    }

    // Build rows
    const rows: CrossTabRow[] = [];
    for (const [rowKey, colMap] of rowGroups.entries()) {
      const values = columnHeaders.map(col => {
        const cellClaims = colMap.get(col) || [];
        return this.computeMeasure(cellClaims, measure);
      });
      rows.push({ rowKey, values });
    }

    // Sort rows by key
    rows.sort((a, b) => a.rowKey.localeCompare(b.rowKey));

    return { rowDimension, colDimension, measure, columnHeaders, rows, filter };
  }

  // ─── Private Helpers ───────────────────────────────────────

  /**
   * Normalize a DateRange or ReportFilter into a ReportFilter.
   * Provides backward compatibility — existing callers passing DateRange still work.
   */
  private normalizeFilter(input?: ReportFilter | DateRange): ReportFilter | undefined {
    if (!input) return undefined;
    // Duck-type: DateRange has startDate+endDate but not the ReportFilter-specific fields
    if ('startDate' in input && 'endDate' in input && !('dateRange' in input)) {
      return { dateRange: input as DateRange };
    }
    return input as ReportFilter;
  }

  /**
   * Apply multi-dimensional filters to claims.
   * Each dimension uses OR within its array; all dimensions use AND across them.
   */
  private applyFilters(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): VerifiedClaim[] {
    if (!filter) return claims;

    return claims.filter(c => {
      // Date range
      if (filter.dateRange) {
        if (c.dateOfService < filter.dateRange.startDate || c.dateOfService > filter.dateRange.endDate) {
          return false;
        }
      }
      // Pharmacy
      if (filter.pharmacyWalletIds && !filter.pharmacyWalletIds.includes(c.pharmacyWalletId)) {
        return false;
      }
      // Member
      if (filter.memberWalletIds && !filter.memberWalletIds.includes(c.memberWalletId)) {
        return false;
      }
      // Prescriber
      if (filter.prescriberWalletIds && !filter.prescriberWalletIds.includes(c.prescriberWalletId)) {
        return false;
      }
      // NDC (plaintext)
      if (filter.ndcs && (!c.ndc || !filter.ndcs.includes(c.ndc))) {
        return false;
      }
      // GPI
      if (filter.gpis && (!c.gpi || !filter.gpis.includes(c.gpi))) {
        return false;
      }
      // Tier level
      if (filter.tierLevels && (c.tierLevel === undefined || !filter.tierLevels.includes(c.tierLevel))) {
        return false;
      }
      // Therapeutic class
      if (filter.therapeuticClasses && (!c.therapeuticClass || !filter.therapeuticClasses.includes(c.therapeuticClass))) {
        return false;
      }
      // Operation type
      if (filter.operationTypes && !filter.operationTypes.includes(c.operationType)) {
        return false;
      }
      return true;
    });
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
        // M5 fix: Reversals subtract from ALL totals (not just patient/plan).
        // This ensures ingredient, dispensing, patient, and plan are all on the
        // same NET basis. Gross values remain available via totalGrossCostCents.
        totalIngredient -= c.ingredientCostCents;
        totalDispensing -= c.dispensingFeeCents;
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

  /**
   * Convert CCYYMMDD date to a bucket key for time-series aggregation.
   */
  private toBucketKey(date: number, bucket: TimeBucket): string {
    const dateStr = String(date);
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);

    switch (bucket) {
      case 'daily':
        return `${year}-${month}-${day}`;
      case 'monthly':
        return `${year}-${month}`;
      case 'weekly': {
        // ISO week: convert to Date, get ISO week number
        const d = new Date(Number(year), Number(month) - 1, Number(day));
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000) + 1;
        const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);
        return `${year}-W${String(weekNum).padStart(2, '0')}`;
      }
    }
  }

  /**
   * Extract a dimension value from a claim for cross-tab grouping.
   */
  private getDimensionValue(claim: VerifiedClaim, dim: CrossTabDimension): string | undefined {
    switch (dim) {
      case 'pharmacyWalletId': return claim.pharmacyWalletId;
      case 'memberWalletId': return claim.memberWalletId;
      case 'prescriberWalletId': return claim.prescriberWalletId;
      case 'tierLevel': return claim.tierLevel !== undefined ? String(claim.tierLevel) : undefined;
      case 'therapeuticClass': return claim.therapeuticClass;
      case 'operationType': return claim.operationType;
      case 'ndc': return claim.ndc;
      case 'gpi': return claim.gpi;
    }
  }

  /**
   * Compute a measure value for a set of claims in a cross-tab cell.
   */
  private computeMeasure(claims: VerifiedClaim[], measure: CrossTabMeasure): number {
    switch (measure) {
      case 'claimCount':
        return claims.filter(c => c.operationType === 'fulfillment').length;
      case 'totalPatientPayCents': {
        let total = 0;
        for (const c of claims) {
          total += c.operationType === 'fulfillment' ? c.patientPayCents : -c.patientPayCents;
        }
        return total;
      }
      case 'totalPlanPayCents': {
        let total = 0;
        for (const c of claims) {
          total += c.operationType === 'fulfillment' ? c.planPayCents : -c.planPayCents;
        }
        return total;
      }
      case 'totalGrossCostCents': {
        let total = 0;
        for (const c of claims) {
          if (c.operationType === 'fulfillment') {
            total += c.ingredientCostCents + c.dispensingFeeCents;
          }
        }
        return total;
      }
    }
  }
}
