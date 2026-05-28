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
 * Provider Registry Types — data structures for the credentialing pipeline.
 *
 * The Provider Registry is a persistent MerkleTree on the L2 sequencer that
 * tracks credentialed prescribers and pharmacies. Providers are registered
 * by the insurer (admin-gated) after NPI/NCPDP verification.
 *
 * The root is stored on each L2Batch, checkpointed for crash recovery,
 * and replicated across leviathans via gossip.
 *
 * Lifecycle: PENDING(0) → VERIFIED(1) → ACTIVE(2) → SUSPENDED(3) → TERMINATED(4)
 */

import { Field, Poseidon } from 'o1js';

// ─── Tree Constants ─────────────────────────────────────────

/** MerkleTree height — 2^(16-1) = 32,768 provider capacity */
export const PROVIDER_TREE_HEIGHT = 16;

// ─── Provider Lifecycle ─────────────────────────────────────

/**
 * Provider lifecycle states.
 *
 * PENDING    — application submitted, not yet verified
 * VERIFIED   — NPI/NCPDP checks passed, awaiting final approval
 * ACTIVE     — credentialed, can operate on the network
 * SUSPENDED  — temporarily deactivated (compliance, license lapse)
 * TERMINATED — permanently removed from network
 */
export enum ProviderLifecycle {
  PENDING = 0,
  VERIFIED = 1,
  ACTIVE = 2,
  SUSPENDED = 3,
  TERMINATED = 4,
}

export const PROVIDER_LIFECYCLE_NAMES: Record<ProviderLifecycle, string> = {
  [ProviderLifecycle.PENDING]: 'pending',
  [ProviderLifecycle.VERIFIED]: 'verified',
  [ProviderLifecycle.ACTIVE]: 'active',
  [ProviderLifecycle.SUSPENDED]: 'suspended',
  [ProviderLifecycle.TERMINATED]: 'terminated',
};

// ─── Provider Type Tags ─────────────────────────────────────

/** Numeric tags for provider types (used in Poseidon hash) */
export const PROVIDER_TYPE_TAG = {
  prescriber: 1,
  pharmacy: 2,
} as const;

export type ProviderType = keyof typeof PROVIDER_TYPE_TAG;

// ─── Provider Leaf ──────────────────────────────────────────

/**
 * ProviderLeaf — the 6 Fields that form a single provider leaf.
 *
 * All values are Field-compatible strings (BigInt decimal representation).
 * The leaf hash is Poseidon.hash of all 6 fields.
 */
export interface ProviderLeaf {
  /** Provider wallet ID (derived from NPI/NCPDP + enrollment key) */
  walletId: string;
  /** Poseidon hash of NPI (10-digit) or NCPDP (7-digit) identifier */
  npiHash: string;
  /** Provider type tag: 1=prescriber, 2=pharmacy */
  providerTypeTag: string;
  /** Credential lifecycle state (0-4) */
  credentialState: string;
  /** Timestamp when first credentialed (epoch seconds) */
  credentialedAt: string;
  /** Poseidon hash of insurer/admin identifier who credentialed */
  credentialedByHash: string;
}

/**
 * Compute the Poseidon hash of a ProviderLeaf (6 Fields → 1 hash).
 * This hash is stored as the leaf value in the MerkleTree.
 */
export function computeProviderLeafHash(leaf: ProviderLeaf): Field {
  return Poseidon.hash([
    Field(BigInt(leaf.walletId)),
    Field(BigInt(leaf.npiHash)),
    Field(BigInt(leaf.providerTypeTag)),
    Field(BigInt(leaf.credentialState)),
    Field(BigInt(leaf.credentialedAt)),
    Field(BigInt(leaf.credentialedByHash)),
  ]);
}

// ─── Provider Metadata ──────────────────────────────────────

/**
 * ProviderMetadata — non-cryptographic display data stored alongside the leaf.
 *
 * NOT hashed into the tree — for human-readable queries and display.
 */
export interface ProviderMetadata {
  /** Human-readable display name (e.g., "Dr. Sarah Chen, MD" or "Main Street Pharmacy") */
  displayName: string;
  /** Provider type: 'prescriber' or 'pharmacy' */
  providerType: ProviderType;
  /** Medical specialty (prescribers only) */
  specialty?: string;
  /** Pharmacy type description (pharmacies only) */
  pharmacyType?: string;
  /** Plaintext NPI (10-digit) or NCPDP (7-digit) — verifiable against npiHash */
  npi?: string;
  /** DEA registration number */
  deaNumber?: string;
  /** State of license */
  stateOfLicense?: string;
  /** How the provider was verified */
  verificationMethod?: 'nppes' | 'ncpdp' | 'manual';
  /** Application ID for tracking the credentialing workflow */
  applicationId?: string;
  /** Timestamp when last status change occurred */
  updatedAt: number;
}

// ─── Provider Registry Entry ────────────────────────────────

/**
 * ProviderRegistryEntry — full provider record (leaf + metadata + position).
 *
 * Returned by query methods. The `leafIndex` can be used to request
 * a Merkle witness for independent verification.
 */
export interface ProviderRegistryEntry {
  /** Position in the MerkleTree (0-indexed) */
  leafIndex: bigint;
  /** The cryptographic leaf data (6 Fields) */
  leaf: ProviderLeaf;
  /** The Poseidon hash of the leaf (what's actually in the tree) */
  leafHash: string;
  /** Non-cryptographic display metadata */
  metadata: ProviderMetadata;
}

// ─── Registry State (Checkpoint) ────────────────────────────

/**
 * Serializable snapshot of the provider registry state.
 * Used for checkpoint export/restore.
 */
export interface ProviderRegistryState {
  /** Next available leaf index */
  nextLeafIndex: bigint;
  /** All entries (leaf + metadata + index) */
  entries: ProviderRegistryEntry[];
  /** Current tree root as decimal string */
  currentRoot: string;
}

// ─── Credentialing Application ──────────────────────────────

/**
 * CredentialingApplication — submitted by a provider requesting network access.
 *
 * This is the input to the credentialing pipeline. The insurer verifies
 * the data and either approves (→ l2_credentialProvider) or denies.
 */
export interface CredentialingApplication {
  /** Unique application ID (UUID) */
  applicationId: string;
  /** Provider type */
  providerType: ProviderType;
  /** NPI (10-digit for prescribers) or NCPDP ID (7-digit for pharmacies) */
  npi: string;
  /** Display name */
  displayName: string;
  /** Specialty (prescribers) */
  specialty?: string;
  /** Pharmacy type (pharmacies) */
  pharmacyType?: string;
  /** DEA number */
  deaNumber?: string;
  /** State of license */
  stateOfLicense?: string;
  /** Applicant-provided wallet ID (optional — can be derived later) */
  walletId?: string;
  /** Timestamp of submission */
  submittedAt: number;
  /** Current status in the credentialing workflow */
  status: 'pending' | 'under_review' | 'approved' | 'denied';
  /** Denial reason (if denied) */
  denialReason?: string;
}
