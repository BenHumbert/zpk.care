import { Field, Struct, Poseidon } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

// ─── Scope Constants (bitfield) ─────────────────────────────

/** Read access — view messages and records */
export const SCOPE_READ = Field(1);
/** Write access — send messages on behalf of delegator */
export const SCOPE_WRITE = Field(2);
/** Pickup access — pick up prescriptions at pharmacy */
export const SCOPE_PICKUP = Field(4);
/** Full access — READ + WRITE + PICKUP (1 | 2 | 4 = 7) */
export const SCOPE_ALL = Field(7);

// ─── Relationship Constants ─────────────────────────────────

/** Parent accessing child's healthcare */
export const REL_PARENT = Field(1);
/** Spouse / domestic partner */
export const REL_SPOUSE = Field(2);
/** Power of Attorney */
export const REL_POA = Field(3);
/** Legal guardian */
export const REL_GUARDIAN = Field(4);
/** Insurer-initiated wallet migration (credential recovery) */
export const REL_MIGRATION = Field(5);
/** Appointed Representative (CMS-1696 AOR) */
export const REL_APPOINTED_REPRESENTATIVE = Field(6);

// ─── DelegationData ─────────────────────────────────────────

/**
 * DelegationData — a delegation (proxy access) commitment.
 *
 * Stored as a leaf in the delegation registry Merkle tree.
 * Allows one wallet owner to grant access to another wallet.
 *
 * Use cases:
 *   - Parent managing child's healthcare
 *   - Power of attorney for elderly/incapacitated member
 *   - Spouse picking up prescriptions
 *   - Insurer migrating wallet (credential recovery)
 *   - Appointed representative (CMS-1696 AOR)
 *
 * No PHI/PII — only wallet IDs (already hashes), scope, dates,
 * and relationship code.
 */
export class DelegationData extends Struct({
  /** Wallet ID of the member granting access */
  delegatorWalletId: Field,
  /** Wallet ID of the person receiving access */
  delegateWalletId: Field,
  /** Bitfield: 1=read, 2=write, 4=pickup */
  scopeFlags: Field,
  /** Effective date (CCYYMMDD) */
  effectiveDate: Field,
  /** Expiration date (CCYYMMDD) */
  expirationDate: Field,
  /** Relationship code: 1=parent, 2=spouse, 3=POA, 4=guardian, 5=migration, 6=appointedRep */
  relationshipCode: Field,
  /** Hash of legal document reference (e.g., POA document hash) */
  delegationHash: Field,
}) {
  /**
   * Produces a single commitment representing this delegation.
   * Stored as a Merkle leaf in the delegation registry.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.delegatorWalletId,
      this.delegateWalletId,
      this.scopeFlags,
      this.effectiveDate,
      this.expirationDate,
      this.relationshipCode,
      this.delegationHash,
    ]);
  }
}

// ─── Local Interface + Builder ──────────────────────────────

/**
 * Raw delegation data before on-chain encoding.
 */
export interface DelegationLocalData {
  /** Delegator wallet ID as bigint string */
  delegatorWalletId: string;
  /** Delegate wallet ID as bigint string */
  delegateWalletId: string;
  /** Scope flags (bitfield: 1=read, 2=write, 4=pickup) */
  scopeFlags: number;
  /** Effective date as CCYYMMDD string */
  effectiveDate: string;
  /** Expiration date as CCYYMMDD string */
  expirationDate: string;
  /** Relationship code (1-6) */
  relationshipCode: number;
  /** Legal document reference string (will be hashed) */
  legalDocumentRef: string;
}

/**
 * Build a DelegationData from raw local data.
 */
export function buildDelegationData(local: DelegationLocalData): DelegationData {
  return new DelegationData({
    delegatorWalletId: Field(BigInt(local.delegatorWalletId)),
    delegateWalletId: Field(BigInt(local.delegateWalletId)),
    scopeFlags: Field(BigInt(local.scopeFlags)),
    effectiveDate: dateToField(local.effectiveDate),
    expirationDate: dateToField(local.expirationDate),
    relationshipCode: Field(BigInt(local.relationshipCode)),
    delegationHash: hashString(local.legalDocumentRef),
  });
}
