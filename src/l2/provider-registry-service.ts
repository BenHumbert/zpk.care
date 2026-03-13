/**
 * Provider Registry Service — MerkleTree-backed credentialing registry.
 *
 * Maintains a persistent MerkleTree(16) on the L2 sequencer that tracks
 * all credentialed prescribers and pharmacies. Provides:
 *   - O(1) registration of new providers (admin-gated)
 *   - O(1) index lookups by walletId, npiHash, providerType, or lifecycle state
 *   - Lifecycle state transitions (PENDING → VERIFIED → ACTIVE → SUSPENDED → TERMINATED)
 *   - Merkle inclusion proofs for any provider (verifiable off-chain)
 *   - Full export/restore for checkpoint persistence
 *
 * The tree root is stored on each L2Batch, checkpointed for crash recovery,
 * and replicated across leviathans via gossip.
 */

import { MerkleTree, MerkleWitness } from 'o1js';
import {
  PROVIDER_TREE_HEIGHT,
  ProviderLifecycle,
  PROVIDER_LIFECYCLE_NAMES,
  computeProviderLeafHash,
  type ProviderType,
  type ProviderLeaf,
  type ProviderMetadata,
  type ProviderRegistryEntry,
  type ProviderRegistryState,
} from './provider-registry-types.js';

/** Merkle witness for the provider registry tree */
export class ProviderRegistryWitness extends MerkleWitness(PROVIDER_TREE_HEIGHT) {}

export class ProviderRegistryService {
  /** The backing Merkle tree */
  private tree: MerkleTree;

  /** Next available leaf index */
  private nextLeafIndex: bigint = 0n;

  /** Full entries by leaf index */
  private entries: Map<bigint, ProviderRegistryEntry> = new Map();

  // ─── Indexes ──────────────────────────────────────────────

  /** walletId → leaf index (1:1 — a provider has one entry) */
  private walletIndex: Map<string, bigint> = new Map();

  /** npiHash → leaf index (1:1 — NPI/NCPDP is unique) */
  private npiIndex: Map<string, bigint> = new Map();

  /** providerType → leaf indices */
  private typeIndex: Map<string, bigint[]> = new Map();

  /** credentialState → leaf indices */
  private stateIndex: Map<string, bigint[]> = new Map();

  constructor() {
    this.tree = new MerkleTree(PROVIDER_TREE_HEIGHT);
  }

  // ─── Write ────────────────────────────────────────────────

  /**
   * Register a new provider in the registry.
   *
   * @param leaf  The 6-Field provider leaf (all values as decimal strings)
   * @param metadata  Non-cryptographic display metadata
   * @returns The ProviderRegistryEntry with assigned leafIndex
   * @throws If walletId or npiHash is already registered
   */
  /** Maximum leaf capacity: 2^(PROVIDER_TREE_HEIGHT - 1) */
  private static readonly MAX_LEAVES = 2n ** BigInt(PROVIDER_TREE_HEIGHT - 1);

  registerProvider(leaf: ProviderLeaf, metadata: ProviderMetadata): ProviderRegistryEntry {
    // Enforce capacity
    if (this.nextLeafIndex >= ProviderRegistryService.MAX_LEAVES) {
      throw new Error(`Provider registry full — maximum ${ProviderRegistryService.MAX_LEAVES} providers reached`);
    }

    // Enforce uniqueness
    if (this.walletIndex.has(leaf.walletId)) {
      throw new Error(`Provider already registered: walletId ${leaf.walletId.slice(0, 16)}...`);
    }
    if (this.npiIndex.has(leaf.npiHash)) {
      throw new Error(`NPI already registered: npiHash ${leaf.npiHash.slice(0, 16)}...`);
    }

    const leafIndex = this.nextLeafIndex;
    const leafHash = computeProviderLeafHash(leaf);

    // Store in Merkle tree
    this.tree.setLeaf(leafIndex, leafHash);

    // Build entry
    const entry: ProviderRegistryEntry = {
      leafIndex,
      leaf,
      leafHash: leafHash.toString(),
      metadata,
    };

    // Store entry
    this.entries.set(leafIndex, entry);

    // Update indexes
    this.walletIndex.set(leaf.walletId, leafIndex);
    this.npiIndex.set(leaf.npiHash, leafIndex);
    this.addToMultiIndex(this.typeIndex, metadata.providerType, leafIndex);
    this.addToMultiIndex(this.stateIndex, leaf.credentialState, leafIndex);

    this.nextLeafIndex++;
    return entry;
  }

  /**
   * Update a provider's lifecycle state.
   *
   * Rebuilds the leaf hash and updates the Merkle tree + state index.
   *
   * @param walletId  The provider's walletId
   * @param newState  The new lifecycle state
   * @returns The updated entry
   * @throws If provider not found or invalid state transition
   */
  updateProviderStatus(walletId: string, newState: ProviderLifecycle): ProviderRegistryEntry {
    const leafIndex = this.walletIndex.get(walletId);
    if (leafIndex === undefined) {
      throw new Error(`Provider not found: walletId ${walletId.slice(0, 16)}...`);
    }

    const entry = this.entries.get(leafIndex)!;
    const oldState = parseInt(entry.leaf.credentialState, 10) as ProviderLifecycle;

    // Validate state transitions
    this.validateTransition(oldState, newState);

    // Remove from old state index
    this.removeFromMultiIndex(this.stateIndex, entry.leaf.credentialState, leafIndex);

    // Update leaf
    entry.leaf.credentialState = String(newState);
    entry.metadata.updatedAt = Date.now();

    // Recompute hash and update tree
    const newHash = computeProviderLeafHash(entry.leaf);
    entry.leafHash = newHash.toString();
    this.tree.setLeaf(leafIndex, newHash);

    // Add to new state index
    this.addToMultiIndex(this.stateIndex, entry.leaf.credentialState, leafIndex);

    return entry;
  }

  // ─── Read ─────────────────────────────────────────────────

  /** Current Merkle root of the provider registry tree */
  getRoot(): bigint {
    return this.tree.getRoot().toBigInt();
  }

  /** Merkle witness for a specific leaf index */
  getWitness(leafIndex: bigint): ProviderRegistryWitness {
    return new ProviderRegistryWitness(this.tree.getWitness(leafIndex));
  }

  /** Number of providers registered */
  getProviderCount(): bigint {
    return this.nextLeafIndex;
  }

  /** Get a single entry by leaf index */
  getEntry(leafIndex: bigint): ProviderRegistryEntry | undefined {
    return this.entries.get(leafIndex);
  }

  // ─── Index Queries ────────────────────────────────────────

  /** Get provider by walletId (unique lookup) */
  getProviderByWallet(walletId: string): ProviderRegistryEntry | undefined {
    const idx = this.walletIndex.get(walletId);
    return idx !== undefined ? this.entries.get(idx) : undefined;
  }

  /** Get provider by NPI hash (unique lookup) */
  getProviderByNpi(npiHash: string): ProviderRegistryEntry | undefined {
    const idx = this.npiIndex.get(npiHash);
    return idx !== undefined ? this.entries.get(idx) : undefined;
  }

  /** All providers of a given type */
  getProvidersByType(providerType: ProviderType): ProviderRegistryEntry[] {
    return this.getEntriesByMultiIndex(this.typeIndex, providerType);
  }

  /** All providers in a given lifecycle state */
  getProvidersByState(state: ProviderLifecycle): ProviderRegistryEntry[] {
    return this.getEntriesByMultiIndex(this.stateIndex, String(state));
  }

  /**
   * Get all active providers, optionally filtered by type.
   * This is the primary query for network participants.
   */
  getActiveProviders(providerType?: ProviderType): ProviderRegistryEntry[] {
    const active = this.getProvidersByState(ProviderLifecycle.ACTIVE);
    if (!providerType) return active;
    return active.filter((e) => e.metadata.providerType === providerType);
  }

  /**
   * Get a provider with its Merkle inclusion proof.
   */
  getProviderWithProof(walletId: string): {
    entry: ProviderRegistryEntry;
    witnessJson: string;
    root: string;
  } | undefined {
    const idx = this.walletIndex.get(walletId);
    if (idx === undefined) return undefined;
    const entry = this.entries.get(idx);
    if (!entry) return undefined;

    const witness = this.getWitness(idx);
    return {
      entry,
      witnessJson: JSON.stringify(witness.toJSON()),
      root: this.getRoot().toString(),
    };
  }

  // ─── Checkpoint Export / Restore ──────────────────────────

  /**
   * Export full registry state for checkpoint persistence.
   */
  exportState(): ProviderRegistryState {
    const entries: ProviderRegistryEntry[] = [];
    for (let i = 0n; i < this.nextLeafIndex; i++) {
      const entry = this.entries.get(i);
      if (entry) entries.push(entry);
    }

    return {
      nextLeafIndex: this.nextLeafIndex,
      entries,
      currentRoot: this.getRoot().toString(),
    };
  }

  /**
   * Restore registry state from a checkpoint.
   * Rebuilds the Merkle tree and all indexes from the entry list,
   * preserving original leaf indices to maintain Merkle proof validity.
   */
  restoreState(state: ProviderRegistryState): void {
    // Reset everything
    this.tree = new MerkleTree(PROVIDER_TREE_HEIGHT);
    this.entries.clear();
    this.walletIndex.clear();
    this.npiIndex.clear();
    this.typeIndex.clear();
    this.stateIndex.clear();

    // Restore each entry at its ORIGINAL leaf index (not re-assigned)
    for (const entry of state.entries) {
      const leafIndex = entry.leafIndex;
      const leafHash = computeProviderLeafHash(entry.leaf);

      // Set leaf in tree at original position
      this.tree.setLeaf(leafIndex, leafHash);

      // Rebuild entry with recomputed hash
      const restored: ProviderRegistryEntry = {
        leafIndex,
        leaf: entry.leaf,
        leafHash: leafHash.toString(),
        metadata: entry.metadata,
      };

      // Rebuild all indexes
      this.entries.set(leafIndex, restored);
      this.walletIndex.set(entry.leaf.walletId, leafIndex);
      this.npiIndex.set(entry.leaf.npiHash, leafIndex);
      this.addToMultiIndex(this.typeIndex, restored.metadata.providerType, leafIndex);
      this.addToMultiIndex(this.stateIndex, entry.leaf.credentialState, leafIndex);
    }

    // Restore nextLeafIndex from checkpoint (not re-derived from count)
    this.nextLeafIndex = state.nextLeafIndex;

    // Verify reconstructed root matches checkpoint (detect corruption)
    const restoredRoot = this.getRoot().toString();
    if (restoredRoot !== state.currentRoot) {
      throw new Error(
        `Provider registry root mismatch after restore: expected ${state.currentRoot.slice(0, 16)}..., got ${restoredRoot.slice(0, 16)}...`,
      );
    }
  }

  // ─── State Transition Validation ──────────────────────────

  /**
   * Valid transitions:
   *   PENDING → VERIFIED, TERMINATED (denied)
   *   VERIFIED → ACTIVE, TERMINATED (denied after verification)
   *   ACTIVE → SUSPENDED, TERMINATED
   *   SUSPENDED → ACTIVE (reinstate), TERMINATED
   *   TERMINATED → (none — terminal state)
   */
  private validateTransition(from: ProviderLifecycle, to: ProviderLifecycle): void {
    const VALID_TRANSITIONS: Record<ProviderLifecycle, ProviderLifecycle[]> = {
      [ProviderLifecycle.PENDING]: [ProviderLifecycle.VERIFIED, ProviderLifecycle.TERMINATED],
      [ProviderLifecycle.VERIFIED]: [ProviderLifecycle.ACTIVE, ProviderLifecycle.TERMINATED],
      [ProviderLifecycle.ACTIVE]: [ProviderLifecycle.SUSPENDED, ProviderLifecycle.TERMINATED],
      [ProviderLifecycle.SUSPENDED]: [ProviderLifecycle.ACTIVE, ProviderLifecycle.TERMINATED],
      [ProviderLifecycle.TERMINATED]: [],
    };

    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      const fromName = PROVIDER_LIFECYCLE_NAMES[from] ?? String(from);
      const toName = PROVIDER_LIFECYCLE_NAMES[to] ?? String(to);
      throw new Error(`Invalid state transition: ${fromName} → ${toName}`);
    }
  }

  // ─── Private Helpers ──────────────────────────────────────

  private addToMultiIndex(index: Map<string, bigint[]>, key: string, leafIndex: bigint): void {
    const existing = index.get(key);
    if (existing) {
      existing.push(leafIndex);
    } else {
      index.set(key, [leafIndex]);
    }
  }

  private removeFromMultiIndex(index: Map<string, bigint[]>, key: string, leafIndex: bigint): void {
    const existing = index.get(key);
    if (!existing) return;
    const filtered = existing.filter((i) => i !== leafIndex);
    if (filtered.length > 0) {
      index.set(key, filtered);
    } else {
      index.delete(key);
    }
  }

  private getEntriesByMultiIndex(index: Map<string, bigint[]>, key: string): ProviderRegistryEntry[] {
    const indices = index.get(key) ?? [];
    return indices
      .map((i) => this.entries.get(i))
      .filter((e): e is ProviderRegistryEntry => e !== undefined);
  }
}
