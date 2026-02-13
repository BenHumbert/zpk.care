import { Field, MerkleTree } from 'o1js';
import {
  NFT_INVENTORY_HEIGHT,
  NftInventoryWitness,
} from '../wallets/wallet-state.js';
import { NftData } from './nft-data.js';

/** Maximum number of NFTs per wallet (2^(height-1) = 2^6 = 64) */
const MAX_NFTS = 2 ** (NFT_INVENTORY_HEIGHT - 1);

/**
 * NftInventory — off-chain manager for a wallet's NFT inventory tree.
 *
 * Each wallet has a MerkleTree(7) with 64 leaf slots. Each leaf holds
 * an NFT commitment (Poseidon hash of NftData fields).
 *
 * This class mirrors the on-chain state locally so the user can:
 *   1. Mint new NFTs (insert commitment at next slot)
 *   2. Generate circuit-compatible witnesses for ZK proofs
 *   3. Retrieve NFT data by slot index
 *   4. Revoke NFTs (mark revoked + update tree)
 *
 * Modeled after WalletRegistry in src/wallets/wallet-state.ts.
 */
export class NftInventory {
  private tree: MerkleTree;
  private nfts: Map<bigint, NftData>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(NFT_INVENTORY_HEIGHT);
    this.nfts = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current inventory Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of NFTs in this inventory */
  get count(): number {
    return this.nfts.size;
  }

  /**
   * Mint a new NFT into the inventory.
   * Inserts the NFT commitment at the next available slot.
   *
   * @returns The assigned slot index and the new inventory root
   */
  mint(nft: NftData): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_NFTS)) {
      throw new Error(
        `NFT inventory full: cannot exceed ${MAX_NFTS} NFTs per wallet`,
      );
    }

    const index = this.nextIndex++;
    const commitment = nft.commitment();

    this.nfts.set(index, nft);
    this.tree.setLeaf(index, commitment);

    return { index, newRoot: this.tree.getRoot() };
  }

  /**
   * Get a circuit-compatible witness for an NFT slot.
   * Used in NftProgram to prove inclusion/exclusion.
   */
  getWitness(index: bigint): NftInventoryWitness {
    return new NftInventoryWitness(this.tree.getWitness(index));
  }

  /**
   * Retrieve the NftData stored at a given slot.
   * Returns undefined if the slot is empty.
   */
  getNft(index: bigint): NftData | undefined {
    return this.nfts.get(index);
  }

  /**
   * Update an NFT at an existing slot (in-place replacement).
   * Used when the NFT's forestRoot changes (e.g., status update in TRANSACTION tree).
   *
   * @returns The new inventory root after update
   */
  updateNft(index: bigint, newNft: NftData): Field {
    const existing = this.nfts.get(index);
    if (!existing) {
      throw new Error(`No NFT at index ${index}`);
    }

    this.nfts.set(index, newNft);
    this.tree.setLeaf(index, newNft.commitment());

    return this.tree.getRoot();
  }

  /**
   * Remove an NFT from a slot (set leaf to empty).
   * Used when transferring a prescription to another pharmacy.
   *
   * @returns The new inventory root after removal
   */
  removeNft(index: bigint): Field {
    const existing = this.nfts.get(index);
    if (!existing) {
      throw new Error(`No NFT at index ${index}`);
    }

    this.nfts.delete(index);
    this.tree.setLeaf(index, Field(0));

    return this.tree.getRoot();
  }

  /**
   * Revoke an NFT by index.
   * Creates a new NftData with revoked=1 and updates the tree.
   *
   * @returns The new inventory root after revocation
   */
  revoke(index: bigint): Field {
    const nft = this.nfts.get(index);
    if (!nft) {
      throw new Error(`No NFT at index ${index}`);
    }

    const revokedNft = new NftData({
      nftType: nft.nftType,
      forestRoot: nft.forestRoot,
      issuerWalletId: nft.issuerWalletId,
      subjectWalletId: nft.subjectWalletId,
      issuedAt: nft.issuedAt,
      expiresAt: nft.expiresAt,
      revoked: Field(1),
    });

    this.nfts.set(index, revokedNft);
    this.tree.setLeaf(index, revokedNft.commitment());

    return this.tree.getRoot();
  }
}
