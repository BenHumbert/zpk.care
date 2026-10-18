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
import { ProofGateProgram, ProofGateProof } from '../wallets/proof-gate.js';
import { CredentialProgram } from '../credentials/credential-program.js';
import { CREDENTIAL_TYPE_ELIGIBILITY, type CredentialData } from '../credentials/credential-data.js';
import type { CredentialInventory } from '../credentials/credential-inventory.js';
import { serializeCredential, type PortableCredential } from '../credentials/portable-credential.js';
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
  /** CredentialProgram's verification key hash, kept at compile; it travels inside each portable credential. */
  private credentialVkHash: Field | null = null;

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
    // B2: the device proves it owns its wallet (ProofGate.verifyMember) instead of sending the preimage.
    const pgStart = Date.now();
    await ProofGateProgram.compile();
    const pgElapsed = Date.now() - pgStart;
    this.proofTimings.set('ProofGateProgram', pgElapsed);
    results.push({ program: 'ProofGateProgram', timeMs: pgElapsed });
    // B1 step two (A-17): the device proves its own portable credential; the engine mints none for it.
    const credStart = Date.now();
    const credCompiled = await CredentialProgram.compile();
    this.credentialVkHash = Field(credCompiled.verificationKey.hash);
    const credElapsed = Date.now() - credStart;
    this.proofTimings.set('CredentialProgram', credElapsed);
    results.push({ program: 'CredentialProgram', timeMs: credElapsed });

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
   * @param preimage — 7-element array from memberTransitionPreimage()
   * @param registryWitness — Merkle witness for the empty registry slot
   * @param lifecycleWitness — Merkle witness for the empty lifecycle slot
   * @param currentRegistryRoot — current on-chain registry root
   * @param currentLifecycleRoot — current on-chain lifecycle root
   */
  /**
   * Prove this wallet is ours — ProofGate.verifyMember over the six salted fields — for the engine's
   * record (B2). The proof says the wallet id is the hash of six fields we know; the fields stay here.
   * Returns the proof as JSON, which is what travels.
   */
  async proveOwnership(walletId: Field, fields: Field[]): Promise<string> {
    if (!this.compiled) {
      throw new Error('Programs not compiled — call compilePrograms() first');
    }
    if (fields.length !== 6) {
      throw new Error(`proveOwnership: six fields expected, got ${fields.length}`);
    }
    const start = Date.now();
    const result = await ProofGateProgram.verifyMember(walletId, fields[0], fields[1], fields[2], fields[3], fields[4], fields[5]);
    this.proofTimings.set('proveOwnership', Date.now() - start);
    return JSON.stringify(result.proof.toJSON());
  }

  /**
   * The portable credential, proved here (B1 step two, A-17): the device holds an eligibility
   * credential in its wallet's inventory — Credential.proveHoldingByType over the ownership proof,
   * the credential as the engine last handed it, and the inventory witness. The result verifies
   * offline against CredentialProgram's key; nothing in it identifies a person.
   */
  async proveCredentialHolding(ownershipProofJson: string, credential: CredentialData, inventory: CredentialInventory): Promise<PortableCredential> {
    if (!this.compiled || !this.credentialVkHash) {
      throw new Error('Programs not compiled — call compilePrograms() first');
    }
    const start = Date.now();
    const ownership = await ProofGateProof.fromJSON(JSON.parse(ownershipProofJson));
    const result = await CredentialProgram.proveHoldingByType(ownership, credential, inventory.getWitness(0n), inventory.getRoot(), CREDENTIAL_TYPE_ELIGIBILITY);
    this.proofTimings.set('proveCredentialHolding', Date.now() - start);
    return serializeCredential(result.proof, 'credential-type-holding', this.credentialVkHash, 0);
  }

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
      preimage[5], // f4 (enrollmentKeyHash)
      preimage[6], // f5 (groupIdHash)
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
      preimage[5], // f4 (enrollmentKeyHash)
      preimage[6], // f5 (groupIdHash)
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
  async submitProof(proof: StateTransitionProof, opts?: { newCredentialInventoryRoot?: string }): Promise<L2Receipt> {
    return this.withPartitionRetry(
      this.config.walletId!,
      (client) => client.submitProof(proof, opts),
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
    const entries = await this.client.getClaimsByMember(this.config.walletId!, this.walletSigner() ?? undefined);
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
    return this.client.getReceiptsByWallet(this.config.walletId!, this.walletSigner() ?? undefined);
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
   * Returns a 7-element Field array: [domainTag, f0, f1, f2, f3, f4, f5]
   * f5 = groupIdHash (binds wallet to employer group).
   */
  static buildPreimage(
    local: MemberLocalData,
    enrollmentKey: string,
    identitySalt: string,
    groupIdHash: Field = Field(0),
  ): Field[] {
    return memberTransitionPreimage(local, enrollmentKey, groupIdHash, identitySalt);
  }
}
