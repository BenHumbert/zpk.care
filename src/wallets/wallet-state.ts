import { Field, Struct, Poseidon, MerkleTree, MerkleWitness } from 'o1js';

/**
 * Wallet State
 *
 * Represents what a proof-gated wallet "contains" in the zkApp.
 * The zkApp maintains a Merkle tree of all wallet states.
 * Each leaf is a WalletState commitment.
 *
 * A wallet holds:
 *   - Its identity (the wallet "address")
 *   - An NFT inventory root (Merkle root of NFTs owned by this wallet)
 *   - A nonce (prevents replay attacks on wallet operations)
 */

/** Height of the wallet registry tree (supports 1024 wallets) */
export const WALLET_TREE_HEIGHT = 11;

/** Circuit-compatible witness for the wallet registry tree */
export class WalletRegistryWitness extends MerkleWitness(WALLET_TREE_HEIGHT) {}

/** Height of per-wallet NFT inventory tree (supports 64 NFTs per wallet) */
export const NFT_INVENTORY_HEIGHT = 7;

/** Circuit-compatible witness for a wallet's NFT inventory */
export class NftInventoryWitness extends MerkleWitness(NFT_INVENTORY_HEIGHT) {}

/**
 * WalletState — on-chain representation of a single wallet.
 *
 * This is the leaf value in the wallet registry Merkle tree.
 */
export class WalletState extends Struct({
  /** The wallet identity (derived from entity data + domain tag) */
  walletId: Field,
  /** Merkle root of NFTs held by this wallet */
  nftInventoryRoot: Field,
  /** Monotonically increasing nonce — prevents replay of wallet operations */
  nonce: Field,
}) {
  /** Compute the commitment stored as a Merkle leaf */
  commitment(): Field {
    return Poseidon.hash([
      this.walletId,
      this.nftInventoryRoot,
      this.nonce,
    ]);
  }

  /** Create a new wallet with an empty NFT inventory for a given identity */
  static init(walletId: Field): WalletState {
    // Empty NFT inventory tree root (all leaves are Field(0))
    const emptyTree = new MerkleTree(NFT_INVENTORY_HEIGHT);
    return new WalletState({
      walletId,
      nftInventoryRoot: emptyTree.getRoot(),
      nonce: Field(0),
    });
  }
}

/**
 * WalletRegistry — manages all wallet states in a single Merkle tree.
 *
 * The zkApp stores only the registry root on-chain.
 * Individual wallet lookups happen off-chain with Merkle witnesses.
 */
export class WalletRegistry {
  private tree: MerkleTree;
  private walletIndices: Map<string, bigint>;
  private walletStates: Map<string, WalletState>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(WALLET_TREE_HEIGHT);
    this.walletIndices = new Map();
    this.walletStates = new Map();
    this.nextIndex = 0n;
  }

  /** Register a new wallet. Returns the assigned index. */
  register(walletId: Field): bigint {
    const key = walletId.toString();
    if (this.walletIndices.has(key)) {
      throw new Error(`Wallet already registered: ${key}`);
    }

    const index = this.nextIndex++;
    const state = WalletState.init(walletId);

    this.walletIndices.set(key, index);
    this.walletStates.set(key, state);
    this.tree.setLeaf(index, state.commitment());

    return index;
  }

  /** Check if a wallet is registered */
  isRegistered(walletId: Field): boolean {
    return this.walletIndices.has(walletId.toString());
  }

  /** Get the current state of a wallet */
  getState(walletId: Field): WalletState {
    const state = this.walletStates.get(walletId.toString());
    if (!state) throw new Error('Wallet not registered');
    return state;
  }

  /** Update wallet state (e.g., after receiving an NFT) */
  updateState(walletId: Field, newState: WalletState): void {
    const key = walletId.toString();
    const index = this.walletIndices.get(key);
    if (index === undefined) throw new Error('Wallet not registered');

    this.walletStates.set(key, newState);
    this.tree.setLeaf(index, newState.commitment());
  }

  /** Get the index of a wallet in the registry tree */
  getIndex(walletId: Field): bigint {
    const index = this.walletIndices.get(walletId.toString());
    if (index === undefined) throw new Error('Wallet not registered');
    return index;
  }

  /** Get a circuit-compatible witness for a wallet's position in the registry */
  getWitness(walletId: Field): WalletRegistryWitness {
    const index = this.getIndex(walletId);
    return new WalletRegistryWitness(this.tree.getWitness(index));
  }

  /** Get the registry Merkle root (this is what goes on-chain) */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get total number of registered wallets */
  get count(): number {
    return this.walletIndices.size;
  }
}
