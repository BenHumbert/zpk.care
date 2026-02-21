import { Field, Struct, Poseidon } from 'o1js';

/**
 * Credential Type Constants
 *
 * Each credential type maps to a concrete healthcare credential:
 *
 *   ELIGIBILITY  — Insurer → member's wallet. Proves coverage/benefit status.
 *   PRESCRIPTION — Prescriber → pharmacy's wallet. eScript for dispensing.
 */
export const CREDENTIAL_TYPE_ELIGIBILITY = Field(1);
export const CREDENTIAL_TYPE_PRESCRIPTION = Field(2);

/**
 * CredentialData — the provable Struct for a healthcare credential.
 *
 * Each credential is a leaf in a wallet's credential inventory tree (height 7, 64 slots).
 * The leaf value is `credentialData.commitment()` — a Poseidon hash of all 7 fields.
 *
 * The `forestRoot` embeds a MerkleForest containing all domain-specific data
 * (member details, medication info, prescriber credentials, etc.) as a single
 * Poseidon hash commitment. No PHI/PII on-chain.
 *
 * Issuance flows:
 *   Eligibility: insurer issues into member's wallet (issuer=admin, subject=member)
 *   eScript:     prescriber issues into pharmacy's wallet (issuer=prescriber, subject=pharmacy)
 */
export class CredentialData extends Struct({
  /** One of CREDENTIAL_TYPE_ELIGIBILITY or CREDENTIAL_TYPE_PRESCRIPTION */
  credentialType: Field,
  /** MerkleForest root — composite hash of all domain-specific data trees */
  forestRoot: Field,
  /** Wallet ID of the entity that issued this credential */
  issuerWalletId: Field,
  /** Wallet ID of the entity that holds this credential (the wallet it's issued into) */
  subjectWalletId: Field,
  /** Issue date as numeric CCYYMMDD */
  issuedAt: Field,
  /** Expiration date as numeric CCYYMMDD (Field(0) = never expires) */
  expiresAt: Field,
  /** Revocation flag: Field(0) = active, Field(1) = revoked */
  revoked: Field,
}) {
  /**
   * Produces a single commitment representing this credential.
   * This is the value stored as a Merkle tree leaf in the wallet's credential inventory.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.credentialType,
      this.forestRoot,
      this.issuerWalletId,
      this.subjectWalletId,
      this.issuedAt,
      this.expiresAt,
      this.revoked,
    ]);
  }
}

/**
 * Off-chain metadata for local credential tracking.
 * Stored on device via ILocalStore — never on-chain.
 */
export interface CredentialLocalMetadata {
  /** Human-readable type label */
  typeLabel: 'eligibility' | 'prescription';
  /** Slot index in the wallet's credential inventory tree */
  slotIndex: number;
  /** Issuer wallet ID as string */
  issuerWalletId: string;
  /** Subject wallet ID as string */
  subjectWalletId: string;
  /** Issue date as CCYYMMDD string */
  issuedAt: string;
  /** Expiration date as CCYYMMDD string (empty = never) */
  expiresAt: string;
  /** Forest root as string (for local verification lookups) */
  forestRoot: string;
}
