/**
 * MemberNode — Entity node for members (patients).
 *
 * Capabilities:
 *   - Local ZK proof generation (registration + wallet updates)
 *   - Drug history queries (own claims only)
 *   - Activity summary
 *   - Formulary lookups
 *   - Claim inclusion proofs (verifiable Merkle witness)
 *   - Proof delegation to faster nodes (optional)
 *
 * Runs on: member's phone or personal device.
 * Compiles: StateTransitionProgram (~30-120s one-time).
 */
import { Field } from 'o1js';
import {
  StateTransitionProgram,
  type StateTransitionProof,
} from '../engine/state-transition.js';
import {
  memberTransitionPreimage,
} from '../wallets/wallet-derivation.js';
import type { MemberLocalData } from '../models/member.js';
import { WalletRegistryWitness } from '../wallets/wallet-state.js';
import { LifecycleWitness } from '../engine/lifecycle.js';
import type { L2Receipt } from '../l2/l2-types.js';
import { EntityNodeBase } from './entity-node-base.js';
import type {
  MemberNodeConfig,
  EntityClaimView,
  EntityActivitySummary,
  ProofTimingEstimate,
} from './entity-node-types.js';

export class MemberNode extends EntityNodeBase {
  private compiled = false;
  private proofTimings: Map<string, number> = new Map();

  constructor(config: MemberNodeConfig) {
    if (!config.walletId) {
      throw new Error('walletId is required for MemberNode');
    }
    super(config);
  }

  // ─── Program Compilation ────────────────────────────────

  /**
   * Compile StateTransitionProgram (one-time, ~30-120s).
   * Must be called before generating any proofs.
   */
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

  /** Check if programs are compiled */
  isCompiled(): boolean {
    return this.compiled;
  }

  // ─── Proof Generation ───────────────────────────────────

  /**
   * Generate a registration proof for this member.
   *
   * @param preimage — 6-element array from memberTransitionPreimage()
   * @param registryWitness — Merkle witness for the empty registry slot
   * @param lifecycleWitness — Merkle witness for the empty lifecycle slot
   * @param currentRegistryRoot — current on-chain registry root
   * @param currentLifecycleRoot — current on-chain lifecycle root
   */
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
      preimage[0], // domainTag (DOMAIN_TAG_MEMBER)
      preimage[1], // f0
      preimage[2], // f1
      preimage[3], // f2
      preimage[4], // f3
      preimage[5], // f4
      registryWitness,
      lifecycleWitness,
      currentRegistryRoot,
      currentLifecycleRoot,
    );
    this.proofTimings.set('proveRegistration', Date.now() - start);
    return result.proof;
  }

  /**
   * Generate a wallet update proof (credential mutation, fill, etc.).
   */
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
      preimage[0], // domainTag
      preimage[1], // f0
      preimage[2], // f1
      preimage[3], // f2
      preimage[4], // f3
      preimage[5], // f4
      oldCredentialRoot,
      oldNonce,
      newCredentialRoot,
      registryWitness,
      lifecycleWitness,
      currentRegistryRoot,
      currentLifecycleRoot,
      currentLifecycle,
    );
    this.proofTimings.set('proveWalletUpdate', Date.now() - start);
    return result.proof;
  }

  /**
   * Submit a proof to the sequencer (auto-routes to correct partition).
   */
  async submitProof(proof: StateTransitionProof): Promise<L2Receipt> {
    return this.withPartitionRetry(
      this.config.walletId!,
      (client) => client.submitProof(proof),
    );
  }

  /** Get proof timing estimates for delegation decisions */
  getProofTimings(): ProofTimingEstimate[] {
    const timings: ProofTimingEstimate[] = [];
    for (const [name, ms] of this.proofTimings) {
      timings.push({
        programName: name,
        estimatedMs: ms,
        lastMeasuredMs: ms,
      });
    }
    return timings;
  }

  // ─── Drug History Queries ───────────────────────────────

  /** Get all claims for this member */
  async getDrugHistory(): Promise<EntityClaimView[]> {
    const entries = await this.client.getClaimsByMember(this.config.walletId!);
    return this.toClaimViews(entries);
  }

  /** Get an activity summary for this member */
  async getActivitySummary(): Promise<EntityActivitySummary> {
    const views = await this.getDrugHistory();
    return this.summarize(views);
  }

  /** Get claims within a date range (CCYYMMDD strings) */
  async getDrugHistoryByDateRange(
    start: string,
    end: string,
  ): Promise<EntityClaimView[]> {
    const views = await this.getDrugHistory();
    return this.filterByDateRange(views, start, end);
  }

  /** Get claims for a specific medication (NDC hash) */
  async getClaimsByMedication(ndcHash: string): Promise<EntityClaimView[]> {
    const views = await this.getDrugHistory();
    return views.filter((v) => v.ndcHash === ndcHash);
  }

  /** Get a single claim with its Merkle inclusion proof */
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

  /** Get all L2 receipts for this member */
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

  /** Get the Claim Accumulator Tree status */
  async getClaimTreeStatus(): Promise<{ root: string; leafCount: bigint }> {
    const result = await this.client.getClaimAccumulatorRoot();
    return { root: result.root, leafCount: BigInt(result.leafCount) };
  }

  // ─── Convenience ────────────────────────────────────────

  /**
   * Build the padded preimage array for this member.
   * Returns a 6-element Field array: [domainTag, f0, f1, f2, f3, f4]
   */
  static buildPreimage(
    local: MemberLocalData,
    enrollmentKey: string,
  ): Field[] {
    return memberTransitionPreimage(local, enrollmentKey);
  }
}
