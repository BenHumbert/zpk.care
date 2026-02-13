import { Field, Struct, Poseidon } from 'o1js';

/**
 * NFT Type Constants
 *
 * Each NFT type maps to a concrete healthcare credential:
 *
 *   ELIGIBILITY  — Insurer → member's wallet. Proves coverage/benefit status.
 *   PRESCRIPTION — Prescriber → pharmacy's wallet. eScript for dispensing.
 */
export const NFT_TYPE_ELIGIBILITY = Field(1);
export const NFT_TYPE_PRESCRIPTION = Field(2);

/**
 * NftData — the provable Struct for a healthcare credential NFT.
 *
 * Each NFT is a leaf in a wallet's NFT inventory tree (height 7, 64 slots).
 * The leaf value is `nftData.commitment()` — a Poseidon hash of all 7 fields.
 *
 * The `forestRoot` embeds a MerkleForest containing all domain-specific data
 * (member details, medication info, prescriber credentials, etc.) as a single
 * Poseidon hash commitment. No PHI/PII on-chain.
 *
 * Issuance flows:
 *   Eligibility: insurer mints into member's wallet (issuer=admin, subject=member)
 *   eScript:     prescriber mints into pharmacy's wallet (issuer=prescriber, subject=pharmacy)
 */
export class NftData extends Struct({
  /** One of NFT_TYPE_ELIGIBILITY or NFT_TYPE_PRESCRIPTION */
  nftType: Field,
  /** MerkleForest root — composite hash of all domain-specific data trees */
  forestRoot: Field,
  /** Wallet ID of the entity that issued this NFT */
  issuerWalletId: Field,
  /** Wallet ID of the entity that holds this NFT (the wallet it's minted into) */
  subjectWalletId: Field,
  /** Issue date as numeric CCYYMMDD */
  issuedAt: Field,
  /** Expiration date as numeric CCYYMMDD (Field(0) = never expires) */
  expiresAt: Field,
  /** Revocation flag: Field(0) = active, Field(1) = revoked */
  revoked: Field,
}) {
  /**
   * Produces a single commitment representing this NFT.
   * This is the value stored as a Merkle tree leaf in the wallet's NFT inventory.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.nftType,
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
 * Off-chain metadata for local NFT tracking.
 * Stored on device via ILocalStore — never on-chain.
 */
export interface NftLocalMetadata {
  /** Human-readable type label */
  typeLabel: 'eligibility' | 'prescription';
  /** Slot index in the wallet's NFT inventory tree */
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
