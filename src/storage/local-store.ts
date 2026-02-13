/**
 * Local Store — Off-chain storage for cryptographic state ONLY.
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  CRITICAL SECURITY INVARIANT                                ║
 * ║                                                             ║
 * ║  This store NEVER holds raw PHI/PII.                        ║
 * ║  No names. No DOBs. No cardholder IDs. No addresses.        ║
 * ║                                                             ║
 * ║  It stores ONLY:                                            ║
 * ║    - Wallet IDs (Poseidon hashes)                           ║
 * ║    - Merkle tree state (roots + leaf indices — all hashes)  ║
 * ║    - Proof metadata (opaque cryptographic blobs)            ║
 * ║                                                             ║
 * ║  Raw PHI/PII is the user's responsibility. Our system       ║
 * ║  only touches it transiently via SecureContext, then         ║
 * ║  scrubs it immediately from memory.                         ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Concrete implementations will vary by platform:
 *   - Desktop: encrypted file system (e.g., SQLite + AES-256)
 *   - Mobile: secure enclave / keychain storage
 *   - Browser: IndexedDB + Web Crypto API
 */

/** Wallet record — contains ONLY the wallet identity hash and entity type */
export interface WalletRecord {
  walletId: string;
  entityType: 'member' | 'prescriber' | 'pharmacy';
}

/** Merkle tree state — all values are Poseidon hashes, never raw data */
export interface LocalMerkleState {
  walletId: string;
  forestRoot: string;
  treeRoots: {
    member: string;
    prescriber: string;
    pharmacy: string;
    medication: string;
    accessControl: string;
    transaction: string;
  };
  leafIndices: Record<string, string>;
}

/**
 * ILocalStore — interface for local cryptographic state persistence.
 *
 * No raw PHI/PII passes through this interface. Only hashes, roots, and proofs.
 */
export interface ILocalStore {
  // Wallet records (hash-only identities)
  saveWallet(record: WalletRecord): Promise<void>;
  getWallet(walletId: string): Promise<WalletRecord | null>;
  deleteWallet(walletId: string): Promise<void>;
  listWalletIds(): Promise<string[]>;

  // Merkle state (all hashes — tracks forest structure)
  saveMerkleState(state: LocalMerkleState): Promise<void>;
  getMerkleState(walletId: string): Promise<LocalMerkleState | null>;

  // Proof metadata (opaque proof strings)
  saveProof(proofId: string, proofData: string): Promise<void>;
  getProof(proofId: string): Promise<string | null>;
}

/**
 * InMemoryStore — reference implementation for testing.
 * NOT for production use. No encryption, no persistence.
 * Stores only cryptographic artifacts — never raw PHI/PII.
 */
export class InMemoryStore implements ILocalStore {
  private wallets = new Map<string, WalletRecord>();
  private merkleStates = new Map<string, LocalMerkleState>();
  private proofs = new Map<string, string>();

  async saveWallet(record: WalletRecord): Promise<void> {
    this.wallets.set(record.walletId, record);
  }

  async getWallet(walletId: string): Promise<WalletRecord | null> {
    return this.wallets.get(walletId) ?? null;
  }

  async deleteWallet(walletId: string): Promise<void> {
    this.wallets.delete(walletId);
  }

  async listWalletIds(): Promise<string[]> {
    return Array.from(this.wallets.keys());
  }

  async saveMerkleState(state: LocalMerkleState): Promise<void> {
    this.merkleStates.set(state.walletId, state);
  }

  async getMerkleState(walletId: string): Promise<LocalMerkleState | null> {
    return this.merkleStates.get(walletId) ?? null;
  }

  async saveProof(proofId: string, proofData: string): Promise<void> {
    this.proofs.set(proofId, proofData);
  }

  async getProof(proofId: string): Promise<string | null> {
    return this.proofs.get(proofId) ?? null;
  }
}
