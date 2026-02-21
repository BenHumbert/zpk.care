/**
 * PrescriberNode — Entity node for prescribers (doctors, NPs, PAs).
 *
 * Capabilities:
 *   - Local ZK proof generation (registration + wallet updates + identity)
 *   - Prescribing history queries (claims where this prescriber is listed)
 *   - Patient/medication/pharmacy breakdowns
 *   - Proof delegation to faster nodes (optional)
 *
 * Runs on: prescriber's hospital workstation or office PC.
 * Compiles: StateTransitionProgram (~30-120s one-time).
 */
import { Field } from 'o1js';
import {
  StateTransitionProgram,
  type StateTransitionProof,
} from '../engine/state-transition.js';
import {
  prescriberTransitionPreimage,
} from '../wallets/wallet-derivation.js';
import type { PrescriberLocalData } from '../models/prescriber.js';
import { WalletRegistryWitness } from '../wallets/wallet-state.js';
import { LifecycleWitness } from '../engine/lifecycle.js';
import type { L2Receipt } from '../l2/l2-types.js';
import { EntityNodeBase } from './entity-node-base.js';
import type {
  PrescriberNodeConfig,
  EntityClaimView,
  PrescriberActivitySummary,
  MedicationBreakdownEntry,
  ProofTimingEstimate,
} from './entity-node-types.js';

export class PrescriberNode extends EntityNodeBase {
  private compiled = false;
  private proofTimings: Map<string, number> = new Map();

  constructor(config: PrescriberNodeConfig) {
    if (!config.walletId) {
      throw new Error('walletId is required for PrescriberNode');
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

  async submitProof(proof: StateTransitionProof): Promise<L2Receipt> {
    const client = this.getClientForWallet(this.config.walletId!);
    return client.submitProof(proof);
  }

  getProofTimings(): ProofTimingEstimate[] {
    return Array.from(this.proofTimings).map(([name, ms]) => ({
      programName: name,
      estimatedMs: ms,
      lastMeasuredMs: ms,
    }));
  }

  // ─── Prescribing History Queries ────────────────────────

  /** Get all claims where this prescriber is listed */
  async getPrescribingHistory(): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByPrescriber(
      this.config.walletId!,
    );
    return this.toClaimViews(entries);
  }

  /** Get prescriber activity summary */
  async getActivitySummary(): Promise<PrescriberActivitySummary> {
    const views = await this.getPrescribingHistory();
    const base = this.summarize(views);
    const patientSet = new Set(views.map((v) => v.memberWalletId));
    const pharmacySet = new Set(views.map((v) => v.pharmacyWalletId));
    return {
      ...base,
      uniquePatients: patientSet.size,
      uniquePharmacies: pharmacySet.size,
    };
  }

  /** Get prescribing history within a date range */
  async getPrescribingHistoryByDateRange(
    start: string,
    end: string,
  ): Promise<EntityClaimView[]> {
    const views = await this.getPrescribingHistory();
    return this.filterByDateRange(views, start, end);
  }

  /** Get claims for a specific patient */
  async getClaimsByPatient(memberWalletId: string): Promise<EntityClaimView[]> {
    const views = await this.getPrescribingHistory();
    return views.filter((v) => v.memberWalletId === memberWalletId);
  }

  /** Get claims for a specific medication */
  async getClaimsByMedication(ndcHash: string): Promise<EntityClaimView[]> {
    const views = await this.getPrescribingHistory();
    return views.filter((v) => v.ndcHash === ndcHash);
  }

  /** Get claims dispensed by a specific pharmacy */
  async getClaimsByPharmacy(
    pharmacyWalletId: string,
  ): Promise<EntityClaimView[]> {
    const views = await this.getPrescribingHistory();
    return views.filter((v) => v.pharmacyWalletId === pharmacyWalletId);
  }

  /** Count unique patients */
  async getUniquePatientCount(): Promise<number> {
    const views = await this.getPrescribingHistory();
    return new Set(views.map((v) => v.memberWalletId)).size;
  }

  /** Count unique pharmacies */
  async getUniquePharmacyCount(): Promise<number> {
    const views = await this.getPrescribingHistory();
    return new Set(views.map((v) => v.pharmacyWalletId)).size;
  }

  /** Breakdown by medication (sorted by claim count descending) */
  async getMedicationBreakdown(): Promise<MedicationBreakdownEntry[]> {
    const views = await this.getPrescribingHistory();
    return this.medicationBreakdown(views);
  }

  /** Get all L2 receipts for this prescriber */
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

  // ─── Convenience ────────────────────────────────────────

  static buildPreimage(
    local: PrescriberLocalData,
    enrollmentKey: string,
  ): Field[] {
    return prescriberTransitionPreimage(local, enrollmentKey);
  }
}
