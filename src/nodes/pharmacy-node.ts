/**
 * PharmacyNode — Entity node for pharmacies (retail, mail-order, specialty).
 *
 * Capabilities:
 *   - Local ZK proof generation (registration + wallet updates)
 *   - Dispensing history queries (claims this pharmacy filled)
 *   - Cross-pharmacy DUR queries (full patient drug history via gossip)
 *   - Active medication checks (for drug interaction screening)
 *   - Prescriber/medication breakdowns
 *   - Proof delegation to faster nodes (optional)
 *
 * Runs on: pharmacy terminal / POS system.
 * Compiles: StateTransitionProgram (~30-120s one-time).
 *
 * CRITICAL DUR method: getPatientFullDrugHistory() returns the patient's
 * COMPLETE history across ALL pharmacies (the sequencer gossips claims
 * from all partitions). This enables drug interaction checks and duplicate
 * therapy detection at point of service.
 */
import { Field } from 'o1js';
import {
  StateTransitionProgram,
  type StateTransitionProof,
} from '../engine/state-transition.js';
import {
  pharmacyTransitionPreimage,
} from '../wallets/wallet-derivation.js';
import type { PharmacyLocalData } from '../models/pharmacy.js';
import { WalletRegistryWitness } from '../wallets/wallet-state.js';
import { LifecycleWitness } from '../engine/lifecycle.js';
import type { L2Receipt } from '../l2/l2-types.js';
import { EntityNodeBase } from './entity-node-base.js';
import type {
  PharmacyNodeConfig,
  EntityClaimView,
  PharmacyActivitySummary,
  MedicationBreakdownEntry,
  PrescriberBreakdownEntry,
  ProofTimingEstimate,
} from './entity-node-types.js';

export class PharmacyNode extends EntityNodeBase {
  private compiled = false;
  private proofTimings: Map<string, number> = new Map();

  constructor(config: PharmacyNodeConfig) {
    if (!config.walletId) {
      throw new Error('walletId is required for PharmacyNode');
    }
    super(config);
  }

  // ─── Program Compilation ────────────────────────────────

  async compilePrograms(): Promise<{ program: string; timeMs: number }[]> {
    const results: { program: string; timeMs: number }[] = [];

    const start = Date.now();
    await StateTransitionProgram.compile();
    const elapsed = Date.now() - start;
    this.proofTimings.set('StateTransitionProgram', elapsed);
    results.push({ program: 'StateTransitionProgram', timeMs: elapsed });

    this.compiled = true;
    return results;
  }

  isCompiled(): boolean {
    return this.compiled;
  }

  // ─── Proof Generation ───────────────────────────────────

  async proveRegistration(
    preimage: Field[],
    registryWitness: WalletRegistryWitness,
    lifecycleWitness: LifecycleWitness,
    currentRegistryRoot: Field,
    currentLifecycleRoot: Field,
  ): Promise<StateTransitionProof> {
    if (!this.compiled) {
      throw new Error('Programs not compiled — call compilePrograms() first');
    }
    const start = Date.now();
    const result = await StateTransitionProgram.proveRegistration(
      preimage[0], preimage[1], preimage[2],
      preimage[3], preimage[4], preimage[5],
      registryWitness,
      lifecycleWitness,
      currentRegistryRoot,
      currentLifecycleRoot,
    );
    this.proofTimings.set('proveRegistration', Date.now() - start);
    return result.proof;
  }

  async proveWalletUpdate(
    preimage: Field[],
    oldCredentialRoot: Field,
    oldNonce: Field,
    newCredentialRoot: Field,
    registryWitness: WalletRegistryWitness,
    lifecycleWitness: LifecycleWitness,
    currentRegistryRoot: Field,
    currentLifecycleRoot: Field,
    currentLifecycle: Field,
  ): Promise<StateTransitionProof> {
    if (!this.compiled) {
      throw new Error('Programs not compiled — call compilePrograms() first');
    }
    const start = Date.now();
    const result = await StateTransitionProgram.proveWalletUpdate(
      preimage[0], preimage[1], preimage[2],
      preimage[3], preimage[4], preimage[5],
      oldCredentialRoot, oldNonce, newCredentialRoot,
      registryWitness,
      lifecycleWitness,
      currentRegistryRoot, currentLifecycleRoot,
      currentLifecycle,
    );
    this.proofTimings.set('proveWalletUpdate', Date.now() - start);
    return result.proof;
  }

  /**
   * Submit a proof to the sequencer.
   * Routes to the member wallet's partition (fills modify the MEMBER's wallet).
   */
  async submitProof(
    proof: StateTransitionProof,
    memberWalletId?: string,
  ): Promise<L2Receipt> {
    // Fulfillment proofs target the MEMBER's wallet, not the pharmacy's
    const targetWallet = memberWalletId ?? this.config.walletId!;
    const client = this.getClientForWallet(targetWallet);
    return client.submitProof(proof);
  }

  getProofTimings(): ProofTimingEstimate[] {
    return Array.from(this.proofTimings).map(([name, ms]) => ({
      programName: name,
      estimatedMs: ms,
      lastMeasuredMs: ms,
    }));
  }

  // ─── Dispensing History Queries ──────────────────────────

  /** Get all claims this pharmacy dispensed */
  async getDispensingHistory(): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByPharmacy(
      this.config.walletId!,
    );
    return this.toClaimViews(entries);
  }

  /** Get pharmacy activity summary */
  async getActivitySummary(): Promise<PharmacyActivitySummary> {
    const views = await this.getDispensingHistory();
    const base = this.summarize(views);
    const patientSet = new Set(views.map((v) => v.memberWalletId));
    const prescriberSet = new Set(views.map((v) => v.prescriberWalletId));
    return {
      ...base,
      uniquePatients: patientSet.size,
      uniquePrescribers: prescriberSet.size,
    };
  }

  /** Get dispensing history within a date range */
  async getDispensingHistoryByDateRange(
    start: string,
    end: string,
  ): Promise<EntityClaimView[]> {
    const views = await this.getDispensingHistory();
    return this.filterByDateRange(views, start, end);
  }

  /** Claims this pharmacy dispensed for a specific patient */
  async getPatientHistory(
    memberWalletId: string,
  ): Promise<EntityClaimView[]> {
    const views = await this.getDispensingHistory();
    return views.filter((v) => v.memberWalletId === memberWalletId);
  }

  // ─── DUR (Drug Utilization Review) ──────────────────────

  /**
   * FULL drug history for a patient across ALL pharmacies.
   *
   * Queries the sequencer's gossip-replicated claim accumulator, which
   * has data from all partitions. Enables:
   *   - Drug interaction screening
   *   - Duplicate therapy detection
   *   - Therapeutic substitution verification
   */
  async getPatientFullDrugHistory(
    memberWalletId: string,
  ): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByMember(memberWalletId);
    return this.toClaimViews(entries);
  }

  /**
   * Check if a patient has an active (non-reversed) claim for a medication.
   * An active claim is a fulfillment that has no corresponding reversal.
   */
  async hasActiveClaim(
    memberWalletId: string,
    ndcHash: string,
  ): Promise<boolean> {
    const views = await this.getPatientFullDrugHistory(memberWalletId);
    const forMed = views.filter((v) => v.ndcHash === ndcHash);
    const fills = forMed.filter((v) => v.operationType === 'fulfillment').length;
    const reversals = forMed.filter((v) => v.operationType === 'reversal').length;
    return fills > reversals;
  }

  /**
   * Get a patient's active medications (non-reversed fills).
   * Groups by NDC hash and returns only those with more fills than reversals.
   */
  async getPatientActiveMedications(
    memberWalletId: string,
  ): Promise<EntityClaimView[]> {
    const views = await this.getPatientFullDrugHistory(memberWalletId);

    // Count fills and reversals per NDC
    const ndcCounts = new Map<string, { fills: number; reversals: number; latestFill: EntityClaimView | null }>();
    for (const v of views) {
      const entry = ndcCounts.get(v.ndcHash) ?? { fills: 0, reversals: 0, latestFill: null };
      if (v.operationType === 'fulfillment') {
        entry.fills++;
        if (!entry.latestFill || v.dateOfService > entry.latestFill.dateOfService) {
          entry.latestFill = v;
        }
      } else {
        entry.reversals++;
      }
      ndcCounts.set(v.ndcHash, entry);
    }

    // Return the latest fill for each active medication
    const active: EntityClaimView[] = [];
    for (const [, counts] of ndcCounts) {
      if (counts.fills > counts.reversals && counts.latestFill) {
        active.push(counts.latestFill);
      }
    }

    return active;
  }

  // ─── Filtered Queries ───────────────────────────────────

  /** Get claims prescribed by a specific prescriber */
  async getClaimsByPrescriber(
    prescriberWalletId: string,
  ): Promise<EntityClaimView[]> {
    const views = await this.getDispensingHistory();
    return views.filter((v) => v.prescriberWalletId === prescriberWalletId);
  }

  /** Get claims for a specific medication */
  async getClaimsByMedication(ndcHash: string): Promise<EntityClaimView[]> {
    const views = await this.getDispensingHistory();
    return views.filter((v) => v.ndcHash === ndcHash);
  }

  /** Count unique patients */
  async getUniquePatientCount(): Promise<number> {
    const views = await this.getDispensingHistory();
    return new Set(views.map((v) => v.memberWalletId)).size;
  }

  /** Count unique prescribers */
  async getUniquePrescriberCount(): Promise<number> {
    const views = await this.getDispensingHistory();
    return new Set(views.map((v) => v.prescriberWalletId)).size;
  }

  /** Breakdown by medication */
  async getMedicationBreakdown(): Promise<MedicationBreakdownEntry[]> {
    const views = await this.getDispensingHistory();
    return this.medicationBreakdown(views);
  }

  /** Breakdown by prescriber */
  async getPrescriberBreakdown(): Promise<PrescriberBreakdownEntry[]> {
    const views = await this.getDispensingHistory();
    const map = new Map<
      string,
      {
        prescriberWalletId: string;
        claimCount: number;
        ndcSet: Set<string>;
        totalPatientPayCents: bigint;
        totalPlanPayCents: bigint;
      }
    >();

    for (const v of views) {
      const existing = map.get(v.prescriberWalletId);
      if (existing) {
        existing.claimCount++;
        existing.ndcSet.add(v.ndcHash);
        existing.totalPatientPayCents += BigInt(v.patientPayCents);
        existing.totalPlanPayCents += BigInt(v.planPayCents);
      } else {
        map.set(v.prescriberWalletId, {
          prescriberWalletId: v.prescriberWalletId,
          claimCount: 1,
          ndcSet: new Set([v.ndcHash]),
          totalPatientPayCents: BigInt(v.patientPayCents),
          totalPlanPayCents: BigInt(v.planPayCents),
        });
      }
    }

    return Array.from(map.values())
      .map((e) => ({
        prescriberWalletId: e.prescriberWalletId,
        claimCount: e.claimCount,
        uniqueMedications: e.ndcSet.size,
        totalPatientPayCents: e.totalPatientPayCents,
        totalPlanPayCents: e.totalPlanPayCents,
      }))
      .sort((a, b) => b.claimCount - a.claimCount);
  }

  /** Get all L2 receipts for this pharmacy */
  async getMyReceipts(): Promise<L2Receipt[]> {
    return this.client.getReceiptsByWallet(this.config.walletId!);
  }

  /** Look up a formulary by plan ID hash */
  async getFormulary(planIdHash: string): Promise<{
    formularyRoot: string;
    entriesJson: string;
    publishedAt: number;
    version: number;
  } | null> {
    return this.client.getFormulary(planIdHash);
  }

  /** Get a claim with its Merkle inclusion proof */
  async getClaimWithProof(leafIndex: bigint): Promise<{
    claim: EntityClaimView;
    witnessJson: string;
    root: string;
  } | null> {
    const result = await this.client.getClaimWithProof(leafIndex);
    if (!result) return null;
    const views = this.toClaimViews([result.entry]);
    return {
      claim: views[0],
      witnessJson: result.witnessJson,
      root: result.root,
    };
  }

  // ─── Convenience ────────────────────────────────────────

  static buildPreimage(
    local: PharmacyLocalData,
    enrollmentKey: string,
  ): Field[] {
    return pharmacyTransitionPreimage(local, enrollmentKey);
  }
}
