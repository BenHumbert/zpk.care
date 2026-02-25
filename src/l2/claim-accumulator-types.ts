/**
 * Claim Accumulator Types — data structures for the NDC drug history tree.
 *
 * The Claim Accumulator is a global MerkleTree on the L2 sequencer that
 * tracks every fulfilled claim with drug identity (ndcHash). Any node
 * can query the tree for a member/pharmacy/prescriber's drug history
 * and receive a Merkle inclusion proof verifiable against the root.
 *
 * The root is stored on each L2Batch, and the ndcHash is committed
 * in the audit Poseidon hash chain (GlobalState → ChainProof → on-chain).
 */

import { Field, Poseidon, MerkleTree, MerkleWitness } from 'o1js';

// ─── Tree Constants ─────────────────────────────────────────

/** MerkleTree height — 2^24 = 16,777,216 leaf capacity */
export const CLAIM_TREE_HEIGHT = 24;

/** Merkle witness for the claim accumulator tree */
export class ClaimAccumulatorWitness extends MerkleWitness(CLAIM_TREE_HEIGHT) {}

// ─── Claim Leaf ─────────────────────────────────────────────

/**
 * ClaimLeaf — the 9 Fields that form a single claim leaf.
 *
 * All values are Field-compatible strings (BigInt decimal representation).
 * The leaf hash is Poseidon.hash of all 9 fields.
 */
export interface ClaimLeaf {
  /** Member wallet ID (Poseidon hash) */
  memberWalletId: string;
  /** NDC hash (Poseidon hash of 11-digit NDC code) */
  ndcHash: string;
  /** Pharmacy wallet ID (Poseidon hash) */
  pharmacyWalletId: string;
  /** Prescriber wallet ID (Poseidon hash) */
  prescriberWalletId: string;
  /** Date of service as CCYYMMDD numeric */
  dateOfService: string;
  /** Patient pay in cents (from ZK proof output) */
  patientPayCents: string;
  /** Plan pay in cents (from ZK proof output) */
  planPayCents: string;
  /** Operation type: '1' = fulfillment, '2' = reversal */
  operationType: string;
  /** Deductible credit in cents (portion of patient pay credited toward deductible) */
  deductibleCreditCents: string;
}

/**
 * Compute the Poseidon hash of a ClaimLeaf (9 Fields → 1 hash).
 * This hash is stored as the leaf value in the MerkleTree.
 */
export function computeClaimLeafHash(leaf: ClaimLeaf): Field {
  return Poseidon.hash([
    Field(BigInt(leaf.memberWalletId)),
    Field(BigInt(leaf.ndcHash)),
    Field(BigInt(leaf.pharmacyWalletId)),
    Field(BigInt(leaf.prescriberWalletId)),
    Field(BigInt(leaf.dateOfService)),
    Field(BigInt(leaf.patientPayCents)),
    Field(BigInt(leaf.planPayCents)),
    Field(BigInt(leaf.operationType)),
    Field(BigInt(leaf.deductibleCreditCents)),
  ]);
}

// ─── Claim Metadata ─────────────────────────────────────────

/**
 * ClaimMetadata — non-cryptographic metadata stored alongside the leaf.
 *
 * This data is NOT hashed into the tree — it's for human-readable
 * queries and display. The pharmacy provides it alongside the proof.
 */
export interface ClaimMetadata {
  /** L2 receipt ID that submitted this claim */
  receiptId: string;
  /** Timestamp when the claim was accepted */
  timestamp: number;
  /** Plaintext 11-digit NDC code (verifiable: hashString(ndc) == ndcHash) */
  ndc?: string;
  /** Drug brand or generic name */
  brandName?: string;
  /** Formulary tier level (1=Generic, 2=Preferred, 3=NonPreferred, 4=Specialty) */
  tierLevel?: number;
  /** 14-digit GPI code */
  gpi?: string;
  /** Therapeutic classification */
  therapeuticClass?: string;
  /** Days supply */
  daysSupply?: number;
  /** Fill number: 0=original, 1+=refill */
  fillNumber?: number;
}

// ─── Claim Accumulator Entry ────────────────────────────────

/**
 * ClaimAccumulatorEntry — full claim record (leaf + metadata + position).
 *
 * Returned by query methods. The `leafIndex` can be used to request
 * a Merkle witness for independent verification.
 */
export interface ClaimAccumulatorEntry {
  /** Position in the MerkleTree (0-indexed) */
  leafIndex: bigint;
  /** The cryptographic leaf data (8 Fields) */
  leaf: ClaimLeaf;
  /** The Poseidon hash of the leaf (what's actually in the tree) */
  leafHash: string;
  /** Non-cryptographic display metadata */
  metadata: ClaimMetadata;
}

// ─── Accumulator State (Checkpoint) ─────────────────────────

/**
 * Serializable snapshot of the claim accumulator state.
 * Used for checkpoint export/restore.
 */
export interface ClaimAccumulatorState {
  /** Next available leaf index */
  nextLeafIndex: bigint;
  /** All entries (leaf + metadata + index) */
  entries: ClaimAccumulatorEntry[];
  /** Current tree root as decimal string */
  currentRoot: string;
}
