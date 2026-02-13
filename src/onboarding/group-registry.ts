import { Field, Struct, Poseidon, MerkleTree, MerkleWitness } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

/**
 * Group registry tree height — supports up to 128 employer groups.
 * Each leaf holds a GroupConfig commitment (Poseidon hash).
 */
export const GROUP_TREE_HEIGHT = 8;

/** Maximum number of groups (2^(height-1) = 128) */
const MAX_GROUPS = 2 ** (GROUP_TREE_HEIGHT - 1);

/** Circuit-compatible witness for group registry inclusion proofs */
export class GroupRegistryWitness extends MerkleWitness(GROUP_TREE_HEIGHT) {}

/**
 * Group Status Constants
 */
export const GROUP_STATUS_ACTIVE = Field(1);
export const GROUP_STATUS_TERMINATED = Field(2);

/**
 * GroupConfig — on-chain representation of an employer group.
 *
 * Tracks the group's association to a plan, enrollment limits,
 * and active status. No PHI/PII — only hashed identifiers and counts.
 */
export class GroupConfig extends Struct({
  /** Poseidon hash of employer group ID */
  groupIdHash: Field,
  /** Poseidon hash of benefit plan ID */
  planIdHash: Field,
  /** Effective date as numeric CCYYMMDD */
  effectiveDate: Field,
  /** Termination date as numeric CCYYMMDD (Field(0) = no end date) */
  terminationDate: Field,
  /** Max members allowed to enroll (Field(0) = unlimited) */
  enrollmentCap: Field,
  /** Current number of enrolled members */
  enrolledCount: Field,
  /** Group status: GROUP_STATUS_ACTIVE or GROUP_STATUS_TERMINATED */
  status: Field,
}) {
  /**
   * Produces a single commitment representing this group config.
   * Stored as a Merkle leaf in the GroupRegistry tree.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.groupIdHash,
      this.planIdHash,
      this.effectiveDate,
      this.terminationDate,
      this.enrollmentCap,
      this.enrolledCount,
      this.status,
    ]);
  }
}

/**
 * Raw group configuration data from the insurer's system.
 */
export interface GroupConfigLocalData {
  /** Employer group ID (e.g., "ACME-CORP-001") */
  groupId: string;
  /** Benefit plan ID (e.g., "PLAN-GOLD-2026") */
  planId: string;
  /** Group effective date as CCYYMMDD string */
  effectiveDate: string;
  /** Group termination date as CCYYMMDD string (empty = no end date) */
  terminationDate: string;
  /** Max members allowed (0 = unlimited) */
  enrollmentCap: number;
}

/**
 * Build a GroupConfig from raw local data.
 * Initializes enrolledCount to 0 and status to ACTIVE.
 */
export function buildGroupConfig(local: GroupConfigLocalData): GroupConfig {
  return new GroupConfig({
    groupIdHash: hashString(local.groupId),
    planIdHash: hashString(local.planId),
    effectiveDate: dateToField(local.effectiveDate),
    terminationDate: local.terminationDate
      ? dateToField(local.terminationDate)
      : Field(0),
    enrollmentCap: Field(BigInt(local.enrollmentCap)),
    enrolledCount: Field(0),
    status: GROUP_STATUS_ACTIVE,
  });
}

/**
 * GroupRegistry — off-chain manager for employer group configurations.
 *
 * Each leaf holds a GroupConfig commitment (Poseidon hash of group fields).
 * Tracks groups by both index and groupIdHash for efficient lookups.
 *
 * Pattern: modeled after BenefitPlanRegistry in src/eligibility/benefit-plan-registry.ts
 */
export class GroupRegistry {
  private tree: MerkleTree;
  private groups: Map<bigint, GroupConfig>;
  private groupLocalData: Map<bigint, GroupConfigLocalData>;
  private groupIndices: Map<string, bigint>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(GROUP_TREE_HEIGHT);
    this.groups = new Map();
    this.groupLocalData = new Map();
    this.groupIndices = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current registry Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of registered groups */
  get count(): number {
    return this.groups.size;
  }

  /**
   * Add an employer group to the registry.
   *
   * @returns The assigned index and the new registry root
   */
  addGroup(
    config: GroupConfig,
    localData: GroupConfigLocalData,
  ): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_GROUPS)) {
      throw new Error(
        `Group registry full: cannot exceed ${MAX_GROUPS} groups`,
      );
    }

    const key = config.groupIdHash.toString();
    if (this.groupIndices.has(key)) {
      throw new Error(`Group already registered: ${localData.groupId}`);
    }

    const index = this.nextIndex++;
    this.groups.set(index, config);
    this.groupLocalData.set(index, localData);
    this.groupIndices.set(key, index);
    this.tree.setLeaf(index, config.commitment());

    return { index, newRoot: this.tree.getRoot() };
  }

  /** Get the GroupConfig at a given index */
  getGroup(index: bigint): GroupConfig | undefined {
    return this.groups.get(index);
  }

  /** Get the raw local data at a given index */
  getGroupLocalData(index: bigint): GroupConfigLocalData | undefined {
    return this.groupLocalData.get(index);
  }

  /**
   * Look up a group by its hashed group ID.
   * Returns the config, local data, and index.
   */
  getGroupByHash(
    groupIdHash: Field,
  ): { config: GroupConfig; localData: GroupConfigLocalData; index: bigint } | undefined {
    const key = groupIdHash.toString();
    const index = this.groupIndices.get(key);
    if (index === undefined) return undefined;
    const config = this.groups.get(index);
    const localData = this.groupLocalData.get(index);
    if (!config || !localData) return undefined;
    return { config, localData, index };
  }

  /**
   * Update a group config at an existing index.
   * Used for incrementing enrolledCount or changing status.
   */
  updateGroup(index: bigint, newConfig: GroupConfig): void {
    const existing = this.groups.get(index);
    if (!existing) throw new Error(`No group at index ${index}`);

    this.groups.set(index, newConfig);
    this.tree.setLeaf(index, newConfig.commitment());
  }

  /** Get a circuit-compatible witness for a group's position */
  getGroupWitness(index: bigint): GroupRegistryWitness {
    return new GroupRegistryWitness(this.tree.getWitness(index));
  }
}
