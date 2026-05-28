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

// ─── Shared Types ──────────────────────────────────────────

/** Date range filter using CCYYMMDD numeric format. */
export interface DateRange {
  startDate: number;
  endDate: number;
}

/** Aggregated cost breakdown across claims. */
export interface CostBreakdown {
  totalIngredientCostCents: number;
  totalDispensingFeeCents: number;
  totalPatientPayCents: number;
  totalPlanPayCents: number;
  totalGrossCostCents: number;
  /** Gross minus reversals. */
  netCostCents: number;
}

// ─── VerifiedClaim ─────────────────────────────────────────

/**
 * Transient data extracted from a verified FulfillmentProof + pharmacy-provided context.
 *
 * NOT stored — constructed in memory, used for report generation, then purged.
 */
export interface VerifiedClaim {
  /** From proof output — PrescriptionData.commitment() */
  prescriptionHash: string;
  /** From proof output — fulfillment or reversal entry commitment */
  entryCommitment: string;
  /** ZK-computed copay (fulfillment) or refund (reversal) in cents */
  patientPayCents: number;
  /** ZK-computed insurer share (fulfillment) or refund (reversal) in cents */
  planPayCents: number;
  /** 'fulfillment' or 'reversal' */
  operationType: 'fulfillment' | 'reversal';

  // From ClaimContext (pharmacy-provided, verifiable against entryCommitment)
  /** Opaque pharmacy wallet hash */
  pharmacyWalletId: string;
  /** Opaque member wallet hash */
  memberWalletId: string;
  /** Opaque prescriber wallet hash */
  prescriberWalletId: string;
  /** Poseidon hash of NDC code */
  ndcHash: string;
  /** Drug ingredient cost in cents */
  ingredientCostCents: number;
  /** Pharmacy dispensing fee in cents */
  dispensingFeeCents: number;
  /** Quantity dispensed — string for BigInt precision (x1000-scaled) */
  quantityDispensed: string;
  /** Date of service as CCYYMMDD numeric */
  dateOfService: number;

  // Drug enrichment (propagated from ClaimContext)
  /** 11-digit NDC code */
  ndc?: string;
  /** 14-digit GPI code */
  gpi?: string;
  /** Days supply */
  daysSupply?: number;
  /** Fill number: 0=original, 1+=refill */
  fillNumber?: number;
  /** Drug brand or generic name */
  brandName?: string;
  /** Therapeutic classification */
  therapeuticClass?: string;
  /** Formulary tier level (1-4) */
  tierLevel?: number;
  /** DAW/product selection code */
  dawCode?: number;
}

// ─── ClaimContext ──────────────────────────────────────────

/**
 * Pharmacy-provided metadata alongside a FulfillmentProof.
 *
 * Verifiable: Poseidon hash of FulfillmentData built from this context
 * must match proof output's entryCommitment.
 */
export interface ClaimContext {
  pharmacyWalletId: string;
  memberWalletId: string;
  prescriberWalletId: string;
  ndcHash: string;
  ingredientCostCents: number;
  dispensingFeeCents: number;
  quantityDispensed: string;
  dateOfService: number;

  // Drug enrichment — NOT PHI/PII (identifies drugs, not people).
  // Pharmacy provides these alongside the claim. Verifiable: hashString(ndc) == ndcHash.
  /** 11-digit NDC code (e.g., "00071015523") */
  ndc?: string;
  /** 14-digit GPI code */
  gpi?: string;
  /** Days supply */
  daysSupply?: number;
  /** Fill number: 0=original, 1+=refill */
  fillNumber?: number;
  /** Drug brand or generic name */
  brandName?: string;
  /** Therapeutic classification */
  therapeuticClass?: string;
  /** Formulary tier level (1=Generic, 2=Preferred, 3=NonPreferred, 4=Specialty) */
  tierLevel?: number;
  /** DAW/product selection code */
  dawCode?: number;
}

// ─── PriorAuthContext ──────────────────────────────────────

/**
 * Insurer-provided prior authorization data for cross-referencing.
 */
export interface PriorAuthContext {
  ndcHash: string;
  memberWalletId: string;
  prescriberWalletId: string;
  approvalDate: number;
  expirationDate: number;
  approvedQuantity: string;
}

// ─── Report Interfaces ─────────────────────────────────────

/** 1. Chronological claims register. */
export interface ClaimsRegisterReport {
  claims: VerifiedClaim[];
  costBreakdown: CostBreakdown;
  totalClaimCount: number;
  totalReversalCount: number;
  dateRange?: DateRange;
}

/** Per-pharmacy activity entry. */
export interface PharmacyActivityEntry {
  pharmacyWalletId: string;
  claimCount: number;
  reversalCount: number;
  uniqueMedications: number;
  uniqueMembers: number;
  costBreakdown: CostBreakdown;
}

/** 2. Pharmacy activity report. */
export interface PharmacyActivityReport {
  pharmacies: PharmacyActivityEntry[];
  dateRange?: DateRange;
}

/** Per-prescriber activity entry. */
export interface PrescriberActivityEntry {
  prescriberWalletId: string;
  prescriptionCount: number;
  claimCount: number;
  uniqueMedications: number;
  uniqueMembers: number;
  costBreakdown: CostBreakdown;
}

/** 3. Prescriber activity report. */
export interface PrescriberActivityReport {
  prescribers: PrescriberActivityEntry[];
  dateRange?: DateRange;
}

/** Per-member activity entry. */
export interface MemberActivityEntry {
  memberWalletId: string;
  claimCount: number;
  reversalCount: number;
  /** NDC hashes of medications with active (non-reversed) claims. */
  currentMedications: string[];
  costBreakdown: CostBreakdown;
}

/** 4. Member activity report. */
export interface MemberActivityReport {
  members: MemberActivityEntry[];
  dateRange?: DateRange;
}

/** Per-medication utilization entry. */
export interface MedicationUtilizationEntry {
  ndcHash: string;
  totalClaimCount: number;
  totalReversalCount: number;
  totalQuantity: string;
  uniquePharmacies: number;
  uniquePrescribers: number;
  uniqueMembers: number;
}

/** 5. Medication utilization report (sorted by claim count descending). */
export interface MedicationUtilizationReport {
  medications: MedicationUtilizationEntry[];
  dateRange?: DateRange;
}

/** 6. Financial summary report. */
export interface FinancialSummaryReport {
  costBreakdown: CostBreakdown;
  totalClaimCount: number;
  totalReversalCount: number;
  averageClaimCost: number;
  averagePatientPay: number;
  averagePlanPay: number;
  dateRange?: DateRange;
}

/** Per-PA utilization entry. */
export interface PriorAuthUtilizationEntry {
  ndcHash: string;
  memberWalletId: string;
  prescriberWalletId: string;
  approvalDate: number;
  expirationDate: number;
  approvedQuantity: string;
  utilizedQuantity: string;
  utilizationRate: number;
  hasClaimActivity: boolean;
}

/** 7. Prior authorization report. */
export interface PriorAuthReport {
  priorAuths: PriorAuthUtilizationEntry[];
  dateRange?: DateRange;
}

/** 8. Reversal report. */
export interface ReversalReport {
  reversals: VerifiedClaim[];
  totalPatientRefundCents: number;
  totalPlanRefundCents: number;
  dateRange?: DateRange;
}

// ─── Multi-Dimensional Filtering (GAP 4) ─────────────────

/**
 * Multi-dimensional filter for QLIK-style reporting.
 *
 * All dimensions are optional — unset dimensions pass all claims.
 * Array dimensions use OR semantics (claim matches if it's in the array).
 */
export interface ReportFilter {
  dateRange?: DateRange;
  pharmacyWalletIds?: string[];
  memberWalletIds?: string[];
  prescriberWalletIds?: string[];
  ndcs?: string[];
  gpis?: string[];
  tierLevels?: number[];
  therapeuticClasses?: string[];
  operationTypes?: ('fulfillment' | 'reversal')[];
}

// ─── Dimensional Reports (GAP 4) ─────────────────────────

/** Per-tier analysis entry. */
export interface TierAnalysisEntry {
  tierLevel: number;
  tierLabel: string;
  claimCount: number;
  reversalCount: number;
  uniqueMembers: number;
  uniqueMedications: number;
  costBreakdown: CostBreakdown;
}

/** 9. Tier analysis report — breakdown by formulary tier. */
export interface TierAnalysisReport {
  tiers: TierAnalysisEntry[];
  filter?: ReportFilter;
}

/** Per-therapeutic-class entry. */
export interface TherapeuticClassEntry {
  therapeuticClass: string;
  claimCount: number;
  reversalCount: number;
  uniqueMembers: number;
  uniqueMedications: number;
  costBreakdown: CostBreakdown;
}

/** 10. Therapeutic class report — breakdown by therapeutic classification. */
export interface TherapeuticClassReport {
  classes: TherapeuticClassEntry[];
  filter?: ReportFilter;
}

/** Time bucket granularity for time series reports. */
export type TimeBucket = 'daily' | 'weekly' | 'monthly';

/** Per-time-bucket entry. */
export interface TimeSeriesEntry {
  bucketKey: string;
  claimCount: number;
  reversalCount: number;
  costBreakdown: CostBreakdown;
}

/** 11. Time series report — claims aggregated by time bucket. */
export interface TimeSeriesReport {
  bucket: TimeBucket;
  entries: TimeSeriesEntry[];
  filter?: ReportFilter;
}

/** Dimensions available for cross-tab pivoting. */
export type CrossTabDimension =
  | 'pharmacyWalletId'
  | 'memberWalletId'
  | 'prescriberWalletId'
  | 'tierLevel'
  | 'therapeuticClass'
  | 'operationType'
  | 'ndc'
  | 'gpi';

/** Measures available for cross-tab aggregation. */
export type CrossTabMeasure =
  | 'claimCount'
  | 'totalPatientPayCents'
  | 'totalPlanPayCents'
  | 'totalGrossCostCents';

/** A single row in a cross-tab report. */
export interface CrossTabRow {
  rowKey: string;
  values: number[];
}

/** 12. Cross-tab (pivot table) report — any two dimensions against any measure. */
export interface CrossTabReport {
  rowDimension: CrossTabDimension;
  colDimension: CrossTabDimension;
  measure: CrossTabMeasure;
  columnHeaders: string[];
  rows: CrossTabRow[];
  filter?: ReportFilter;
}
