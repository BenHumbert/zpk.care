import { Field, MerkleTree } from 'o1js';
import {
  CREDENTIAL_INVENTORY_HEIGHT,
  CredentialInventoryWitness,
} from '../wallets/wallet-state.js';
import { CredentialData } from './credential-data.js';

/** Maximum number of credentials per wallet (2^(height-1) = 2^6 = 64) */
const MAX_CREDENTIALS = 2 ** (CREDENTIAL_INVENTORY_HEIGHT - 1);

/**
 * CredentialInventory — off-chain manager for a wallet's credential inventory tree.
 *
 * Each wallet has a MerkleTree(7) with 64 leaf slots. Each leaf holds
 * a credential commitment (Poseidon hash of CredentialData fields).
 *
 * This class mirrors the on-chain state locally so the user can:
 *   1. Issue new credentials (insert commitment at next slot)
 *   2. Generate circuit-compatible witnesses for ZK proofs
 *   3. Retrieve credential data by slot index
 *   4. Revoke credentials (mark revoked + update tree)
 *
 * Modeled after WalletRegistry in src/wallets/wallet-state.ts.
 */
export class CredentialInventory {
  private tree: MerkleTree;
  private credentials: Map<bigint, CredentialData>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(CREDENTIAL_INVENTORY_HEIGHT);
    this.credentials = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current inventory Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of credentials in this inventory */
  get count(): number {
    return this.credentials.size;
  }

  /**
   * Issue a new credential into the inventory.
   * Inserts the credential commitment at the next available slot.
   *
   * @returns The assigned slot index and the new inventory root
   */
  mint(credential: CredentialData): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_CREDENTIALS)) {
      throw new Error(
        `Credential inventory full: cannot exceed ${MAX_CREDENTIALS} credentials per wallet`,
      );
    }

    const index = this.nextIndex++;
    const commitment = credential.commitment();

    this.credentials.set(index, credential);
    this.tree.setLeaf(index, commitment);

    return { index, newRoot: this.tree.getRoot() };
  }

  /**
   * Get a circuit-compatible witness for a credential slot.
   * Used in CredentialProgram to prove inclusion/exclusion.
   */
  getWitness(index: bigint): CredentialInventoryWitness {
    return new CredentialInventoryWitness(this.tree.getWitness(index));
  }

  /**
   * Retrieve the CredentialData stored at a given slot.
   * Returns undefined if the slot is empty.
   */
  getCredential(index: bigint): CredentialData | undefined {
    return this.credentials.get(index);
  }

  /**
   * Update a credential at an existing slot (in-place replacement).
   * Used when the credential's forestRoot changes (e.g., status update in TRANSACTION tree).
   *
   * @returns The new inventory root after update
   */
  updateCredential(index: bigint, newCredential: CredentialData): Field {
    const existing = this.credentials.get(index);
    if (!existing) {
      throw new Error(`No credential at index ${index}`);
    }

    this.credentials.set(index, newCredential);
    this.tree.setLeaf(index, newCredential.commitment());

    return this.tree.getRoot();
  }

  /**
   * Remove a credential from a slot (set leaf to empty).
   * Used when transferring a prescription to another pharmacy.
   *
   * @returns The new inventory root after removal
   */
  removeCredential(index: bigint): Field {
    const existing = this.credentials.get(index);
    if (!existing) {
      throw new Error(`No credential at index ${index}`);
    }

    this.credentials.delete(index);
    this.tree.setLeaf(index, Field(0));

    return this.tree.getRoot();
  }

  /**
   * Revoke a credential by index.
   * Creates a new CredentialData with revoked=1 and updates the tree.
   *
   * @returns The new inventory root after revocation
   */
  revoke(index: bigint): Field {
    const credential = this.credentials.get(index);
    if (!credential) {
      throw new Error(`No credential at index ${index}`);
    }

    const revokedCredential = new CredentialData({
      credentialType: credential.credentialType,
      forestRoot: credential.forestRoot,
      issuerWalletId: credential.issuerWalletId,
      subjectWalletId: credential.subjectWalletId,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
      revoked: Field(1),
    });

    this.credentials.set(index, revokedCredential);
    this.tree.setLeaf(index, revokedCredential.commitment());

    return this.tree.getRoot();
  }
}
