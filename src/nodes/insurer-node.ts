/**
 * InsurerNode — Entity node for insurers / PBMs.
 *
 * Capabilities:
 *   - System-wide queries (all receipts, batches, audit log)
 *   - Entity-filtered claim queries (member/prescriber/pharmacy/drug)
 *   - All 12 report types (wraps stateless ReportingService)
 *   - Full audit suite (wraps stateless AuditService)
 *   - Admin operations (formulary publish, force batch)
 *
 * No wallet ID. No ZkProgram compilation. Signature-gated admin.
 * Runs on: insurer backend server.
 */
import type { L2Receipt, L2Batch, L2ChainProofResponse } from '../l2/l2-types.js';
import type { AuditLog, FullAuditReport, ChainIntegrityResult, FinancialBalanceResult, DuplicateDetectionResult } from '../audit/audit-types.js';
import type { ClaimAccumulatorEntry } from '../l2/claim-accumulator-types.js';
import type { MessageStoreEntry } from '../l2/message-store-types.js';
import type {
  ReportFilter,
  ClaimsRegisterReport,
  PharmacyActivityReport,
  PrescriberActivityReport,
  MemberActivityReport,
  MedicationUtilizationReport,
  FinancialSummaryReport,
  PriorAuthReport,
  PriorAuthContext,
  ReversalReport,
  TierAnalysisReport,
  TherapeuticClassReport,
  TimeBucket,
  TimeSeriesReport,
  CrossTabDimension,
  CrossTabMeasure,
  CrossTabReport,
  VerifiedClaim,
} from '../reporting/report-types.js';
import { ReportingService } from '../reporting/reporting-service.js';
import { AuditService } from '../audit/audit-service.js';
import { EntityNodeBase } from './entity-node-base.js';
import type {
  InsurerNodeConfig,
  EntityClaimView,
} from './entity-node-types.js';

export class InsurerNode extends EntityNodeBase {
  private reportingService: ReportingService;

  constructor(config: InsurerNodeConfig) {
    super({ ...config, role: 'insurer' });
    this.reportingService = new ReportingService();
  }

  // ─── System-Wide Queries ────────────────────────────────

  /** Get all L2 receipts */
  async getAllReceipts(): Promise<L2Receipt[]> {
    return this.client.getAllReceipts();
  }

  /** Get all L2 batches */
  async getAllBatches(): Promise<L2Batch[]> {
    return this.client.getAllBatches();
  }

  /** Get the sequencer's audit log */
  async getAuditLog(): Promise<AuditLog> {
    return this.client.getAuditLog();
  }

  /** Get the latest chain proof for offline verification */
  async getChainProof(): Promise<L2ChainProofResponse> {
    return this.client.getChainProof();
  }

  // ─── Entity-Filtered Queries ────────────────────────────

  /** Get all claims for a specific member */
  async getMemberClaims(memberWalletId: string): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByMember(memberWalletId);
    return this.toClaimViews(entries);
  }

  /** Get all claims for a specific prescriber */
  async getPrescriberClaims(
    prescriberWalletId: string,
  ): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByPrescriber(prescriberWalletId);
    return this.toClaimViews(entries);
  }

  /** Get all claims for a specific pharmacy */
  async getPharmacyClaims(
    pharmacyWalletId: string,
  ): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByPharmacy(pharmacyWalletId);
    return this.toClaimViews(entries);
  }

  /** Get all claims for a specific drug (NDC hash) */
  async getDrugClaims(ndcHash: string): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByNdc(ndcHash);
    return this.toClaimViews(entries);
  }

  // ─── Messaging (System-Wide) ────────────────────────────

  /** Get all messages for any wallet (insurer system-wide query) */
  async getMessagesByWallet(walletId: string): Promise<MessageStoreEntry[]> {
    return this.client.getMessagesByWallet(walletId);
  }

  // ─── Reporting (12 types) ───────────────────────────────

  /**
   * Build VerifiedClaim[] from ClaimAccumulatorEntries.
   * Maps the on-chain leaf + metadata into the ReportingService input format.
   */
  private buildVerifiedClaims(entries: ClaimAccumulatorEntry[]): VerifiedClaim[] {
    return entries.map((e) => ({
      prescriptionHash: '0', // Not available from claim accumulator
      entryCommitment: e.leafHash,
      patientPayCents: Number(BigInt(e.leaf.patientPayCents)),
      planPayCents: Number(BigInt(e.leaf.planPayCents)),
      operationType:
        e.leaf.operationType === '2'
          ? ('reversal' as const)
          : ('fulfillment' as const),
      pharmacyWalletId: e.leaf.pharmacyWalletId,
      memberWalletId: e.leaf.memberWalletId,
      prescriberWalletId: e.leaf.prescriberWalletId,
      ndcHash: e.leaf.ndcHash,
      ingredientCostCents: 0, // Not stored in claim accumulator
      dispensingFeeCents: 0,
      quantityDispensed: '0',
      dateOfService: Number(e.leaf.dateOfService),
      ndc: e.metadata.ndc,
      gpi: e.metadata.gpi,
      daysSupply: e.metadata.daysSupply,
      fillNumber: e.metadata.fillNumber,
      brandName: e.metadata.brandName,
      therapeuticClass: e.metadata.therapeuticClass,
      tierLevel: e.metadata.tierLevel,
    }));
  }

  /** 1. Claims register — chronological list of all claims */
  generateClaimsRegister(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): ClaimsRegisterReport {
    return this.reportingService.generateClaimsRegister(claims, filter);
  }

  /** 2. Pharmacy activity report */
  generatePharmacyReport(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): PharmacyActivityReport {
    return this.reportingService.generatePharmacyActivity(claims, filter);
  }

  /** 3. Prescriber activity report */
  generatePrescriberReport(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): PrescriberActivityReport {
    return this.reportingService.generatePrescriberActivity(claims, filter);
  }

  /** 4. Member activity report */
  generateMemberReport(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): MemberActivityReport {
    return this.reportingService.generateMemberActivity(claims, filter);
  }

  /** 5. Medication utilization report */
  generateMedicationUtilization(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): MedicationUtilizationReport {
    return this.reportingService.generateMedicationUtilization(claims, filter);
  }

  /** 6. Financial summary report */
  generateFinancialSummary(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): FinancialSummaryReport {
    return this.reportingService.generateFinancialSummary(claims, filter);
  }

  /** 7. Prior authorization report */
  generatePriorAuthReport(
    claims: VerifiedClaim[],
    priorAuths: PriorAuthContext[],
    filter?: ReportFilter,
  ): PriorAuthReport {
    return this.reportingService.generatePriorAuthReport(
      claims,
      priorAuths,
      filter,
    );
  }

  /** 8. Reversal report */
  generateReversalReport(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): ReversalReport {
    return this.reportingService.generateReversalReport(claims, filter);
  }

  /** 9. Tier analysis report */
  generateTierAnalysis(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): TierAnalysisReport {
    return this.reportingService.generateTierAnalysis(claims, filter);
  }

  /** 10. Therapeutic class report */
  generateTherapeuticClassReport(
    claims: VerifiedClaim[],
    filter?: ReportFilter,
  ): TherapeuticClassReport {
    return this.reportingService.generateTherapeuticClassReport(claims, filter);
  }

  /** 11. Time series report */
  generateTimeSeries(
    claims: VerifiedClaim[],
    bucket?: TimeBucket,
    filter?: ReportFilter,
  ): TimeSeriesReport {
    return this.reportingService.generateTimeSeries(
      claims,
      bucket ?? 'daily',
      filter,
    );
  }

  /** 12. Cross-tab (pivot table) report */
  generateCrossTab(
    claims: VerifiedClaim[],
    row: CrossTabDimension,
    col: CrossTabDimension,
    measure: CrossTabMeasure,
    filter?: ReportFilter,
  ): CrossTabReport {
    return this.reportingService.generateCrossTab(
      claims,
      row,
      col,
      measure,
      filter,
    );
  }

  // ─── Audit ──────────────────────────────────────────────

  /** Verify Poseidon hash chain integrity */
  async verifyChainIntegrity(): Promise<ChainIntegrityResult> {
    const log = await this.client.getAuditLog();
    return AuditService.verifyReceiptChain(log);
  }

  /** Verify financial balance (patientPay + planPay == cost) */
  async verifyFinancialBalance(): Promise<FinancialBalanceResult> {
    const log = await this.client.getAuditLog();
    return AuditService.verifyFinancialBalance(log.events);
  }

  /** Detect duplicate claims */
  async detectDuplicateClaims(): Promise<DuplicateDetectionResult> {
    const log = await this.client.getAuditLog();
    return AuditService.detectDuplicateClaims(log.events);
  }

  /** Run full audit (requires on-chain state + roster data) */
  async runFullAudit(
    onChainState: { walletRegistryRoot: string; lifecycleRoot: string; walletCount: bigint },
    rosterEntries: { walletId: string }[],
  ): Promise<FullAuditReport> {
    const log = await this.client.getAuditLog();
    const batches = await this.client.getAllBatches();
    return AuditService.runFullAudit(
      log,
      batches,
      onChainState,
      rosterEntries,
    );
  }

  // ─── Admin Operations ───────────────────────────────────

  /** Publish a formulary update */
  async publishFormulary(
    planIdHash: string,
    formularyRoot: string,
    entriesJson: string,
  ): Promise<{ success: boolean; planIdHash: string; formularyRoot: string }> {
    return this.client.storeFormulary(planIdHash, formularyRoot, entriesJson);
  }

  /** Force a batch build on the sequencer */
  async forceBatch(): Promise<L2Batch | null> {
    return this.client.forceBatch();
  }
}
