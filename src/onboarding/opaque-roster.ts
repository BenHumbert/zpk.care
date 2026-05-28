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

import { Field, Struct, Poseidon, MerkleTree, MerkleWitness } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

/**
 * Roster tree height — supports up to 1,024 enrolled members.
 * Same height as the WalletRegistry (1:1 correspondence).
 */
export const ROSTER_TREE_HEIGHT = 11;

/** Maximum number of roster entries (2^(height-1) = 1,024) */
const MAX_ROSTER_ENTRIES = 2 ** (ROSTER_TREE_HEIGHT - 1);

/** Circuit-compatible witness for roster inclusion proofs */
export class RosterMerkleWitness extends MerkleWitness(ROSTER_TREE_HEIGHT) {}

/**
 * Enrollment Status Constants
 */
export const ENROLLMENT_STATUS_ACTIVE = Field(1);
export const ENROLLMENT_STATUS_TERMINATED = Field(2);

/**
 * RosterEntry — the insurer's opaque record of a member enrollment.
 *
 * Maps a walletId to its plan and group WITHOUT any PHI/PII.
 * The insurer knows:
 *   - walletId (opaque Poseidon hash — cannot reverse to identity)
 *   - planIdHash, groupIdHash (the insurer created these)
 *   - enrollment/termination dates
 *   - tokenIdHash (which enrollment token was used)
 *
 * The insurer does NOT know:
 *   - Member name, DOB, address, SSN — nothing
 *   - Enrollment key — never transmitted
 */
export class RosterEntry extends Struct({
  /** The member's wallet ID (opaque Poseidon hash) */
  walletId: Field,
  /** Poseidon hash of benefit plan ID */
  planIdHash: Field,
  /** Poseidon hash of employer group ID */
  groupIdHash: Field,
  /** Poseidon hash of family ID (groups subscriber + dependents) */
  familyIdHash: Field,
  /** Enrollment date as numeric CCYYMMDD */
  enrolledDate: Field,
  /** Termination date as numeric CCYYMMDD (Field(0) = active) */
  terminatedDate: Field,
  /** Enrollment status: ACTIVE or TERMINATED */
  status: Field,
  /** Poseidon hash of the enrollment token used */
  tokenIdHash: Field,
}) {
  /**
   * Produces a single commitment representing this roster entry.
   * Stored as a Merkle leaf in the OpaqueRoster tree.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.walletId,
      this.planIdHash,
      this.groupIdHash,
      this.familyIdHash,
      this.enrolledDate,
      this.terminatedDate,
      this.status,
      this.tokenIdHash,
    ]);
  }
}

/**
 * Raw roster entry data for building a RosterEntry.
 * walletId is passed separately as a Field (already hashed).
 */
export interface RosterEntryLocalData {
  /** Benefit plan ID */
  planId: string;
  /** Employer group ID */
  groupId: string;
  /** Family ID — groups subscriber + dependents */
  familyId: string;
  /** Enrollment date as CCYYMMDD string */
  enrolledDate: string;
  /** Enrollment token ID */
  tokenId: string;
}

/**
 * Build a RosterEntry from a wallet ID and raw local data.
 * Initializes as ACTIVE with no termination date.
 *
 * @param walletId — the member's wallet ID (already a Field/hash)
 * @param local — raw plan/group/date identifiers
 */
export function buildRosterEntry(
  walletId: Field,
  local: RosterEntryLocalData,
): RosterEntry {
  return new RosterEntry({
    walletId,
    planIdHash: hashString(local.planId),
    groupIdHash: hashString(local.groupId),
    familyIdHash: hashString(local.familyId),
    enrolledDate: dateToField(local.enrolledDate),
    terminatedDate: Field(0),
    status: ENROLLMENT_STATUS_ACTIVE,
    tokenIdHash: hashString(local.tokenId),
  });
}

/**
 * OpaqueRoster — the insurer's enrollment ledger with zero PHI.
 *
 * Maps walletId → (plan, group, dates, token) using only opaque hashes.
 * Supports lookups by walletId and by group (for group termination).
 *
 * If the insurer's system is breached, the attacker gets:
 *   - A Merkle tree of opaque Poseidon hashes
 *   - Plan and group identifiers the insurer already knows
 *   - No member names, DOBs, or other PHI
 *
 * Pattern: modeled after WalletRegistry in src/wallets/wallet-state.ts
 */
export class OpaqueRoster {
  private tree: MerkleTree;
  private entries: Map<bigint, RosterEntry>;
  private walletIndices: Map<string, bigint>;
  private groupMembers: Map<string, Set<bigint>>;
  private familyMembers: Map<string, Set<bigint>>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(ROSTER_TREE_HEIGHT);
    this.entries = new Map();
    this.walletIndices = new Map();
    this.groupMembers = new Map();
    this.familyMembers = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current roster Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of enrolled members */
  get count(): number {
    return this.entries.size;
  }

  /**
   * Add a member enrollment to the roster.
   * Prevents duplicate walletId enrollment.
   *
   * @returns The assigned index and the new roster root
   */
  addEntry(entry: RosterEntry): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_ROSTER_ENTRIES)) {
      throw new Error(
        `Roster full: cannot exceed ${MAX_ROSTER_ENTRIES} entries`,
      );
    }

    const walletKey = entry.walletId.toString();
    if (this.walletIndices.has(walletKey)) {
      throw new Error(`Wallet already enrolled: ${walletKey}`);
    }

    const index = this.nextIndex++;
    this.entries.set(index, entry);
    this.walletIndices.set(walletKey, index);
    this.tree.setLeaf(index, entry.commitment());

    // Index by group for group-level operations
    const groupKey = entry.groupIdHash.toString();
    if (!this.groupMembers.has(groupKey)) {
      this.groupMembers.set(groupKey, new Set());
    }
    this.groupMembers.get(groupKey)!.add(index);

    // Index by family for family-level operations
    const familyKey = entry.familyIdHash.toString();
    if (!this.familyMembers.has(familyKey)) {
      this.familyMembers.set(familyKey, new Set());
    }
    this.familyMembers.get(familyKey)!.add(index);

    return { index, newRoot: this.tree.getRoot() };
  }

  /** Get the RosterEntry at a given index */
  getEntry(index: bigint): RosterEntry | undefined {
    return this.entries.get(index);
  }

  /** Look up a roster entry by walletId */
  getEntryByWallet(
    walletId: Field,
  ): { entry: RosterEntry; index: bigint } | undefined {
    const key = walletId.toString();
    const index = this.walletIndices.get(key);
    if (index === undefined) return undefined;
    const entry = this.entries.get(index);
    if (!entry) return undefined;
    return { entry, index };
  }

  /** Check if a wallet is enrolled */
  isEnrolled(walletId: Field): boolean {
    return this.walletIndices.has(walletId.toString());
  }

  /** Get all roster entries for a given group (for group-level operations) */
  getEntriesByGroup(
    groupIdHash: Field,
  ): { entry: RosterEntry; index: bigint }[] {
    const groupKey = groupIdHash.toString();
    const indices = this.groupMembers.get(groupKey);
    if (!indices) return [];
    return Array.from(indices)
      .map((index) => ({
        entry: this.entries.get(index)!,
        index,
      }))
      .filter((r) => r.entry !== undefined);
  }

  /** Get all roster entries for a given family (for family-level operations) */
  getEntriesByFamily(
    familyIdHash: Field,
  ): { entry: RosterEntry; index: bigint }[] {
    const familyKey = familyIdHash.toString();
    const indices = this.familyMembers.get(familyKey);
    if (!indices) return [];
    return Array.from(indices)
      .map((index) => ({
        entry: this.entries.get(index)!,
        index,
      }))
      .filter((r) => r.entry !== undefined);
  }

  /**
   * Update a roster entry at an existing index.
   * Used for termination (setting terminatedDate and status).
   */
  updateEntry(index: bigint, newEntry: RosterEntry): void {
    const existing = this.entries.get(index);
    if (!existing) throw new Error(`No roster entry at index ${index}`);

    this.entries.set(index, newEntry);
    this.tree.setLeaf(index, newEntry.commitment());
  }

  /** Get a circuit-compatible witness for a roster entry */
  getEntryWitness(index: bigint): RosterMerkleWitness {
    return new RosterMerkleWitness(this.tree.getWitness(index));
  }

  /** Get all roster entries (for bulk operations like formulary updates) */
  getAllEntries(): { entry: RosterEntry; index: bigint }[] {
    return Array.from(this.entries.entries()).map(([index, entry]) => ({
      entry,
      index,
    }));
  }
}
