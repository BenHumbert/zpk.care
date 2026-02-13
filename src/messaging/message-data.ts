import { Field, Struct, Poseidon } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

// ─── Message Type Constants ─────────────────────────────────

/** Prescription message (prescriber → pharmacy) */
export const MSG_TYPE_PRESCRIPTION = Field(1);
/** Prior authorization request (prescriber → insurer) */
export const MSG_TYPE_PA_REQUEST = Field(2);
/** Prior authorization response (insurer → prescriber) */
export const MSG_TYPE_PA_RESPONSE = Field(3);
/** Notification (system → any party) */
export const MSG_TYPE_NOTIFICATION = Field(4);
/** General-purpose message (any → any) */
export const MSG_TYPE_GENERAL = Field(5);
/** Customer service request (member → insurer) */
export const MSG_TYPE_SUPPORT = Field(6);
/** Support interaction summary (insurer → member) */
export const MSG_TYPE_SUPPORT_SUMMARY = Field(7);

// ─── MessageData ────────────────────────────────────────────

/**
 * MessageData — an on-chain message commitment.
 *
 * Stored as a leaf in the message registry Merkle tree.
 * The actual encrypted content lives off-chain; only the
 * commitment (Poseidon hash of all 7 fields) goes on-chain.
 *
 * No PHI/PII — only wallet IDs (already hashes), content hash,
 * and metadata fields.
 */
export class MessageData extends Struct({
  /** Sender's proof-gated wallet ID */
  senderWalletId: Field,
  /** Recipient's proof-gated wallet ID */
  recipientWalletId: Field,
  /** Poseidon hash of encrypted content bytes */
  contentHash: Field,
  /** Message type: 1-7 per constants above */
  messageType: Field,
  /** Timestamp as numeric CCYYMMDDHHMMSS */
  timestamp: Field,
  /** Hash of thread identifier (conversation grouping) */
  threadId: Field,
  /** Monotonic per sender — prevents replay */
  nonce: Field,
}) {
  /**
   * Produces a single commitment representing this message.
   * Stored as a Merkle leaf in the message registry.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.senderWalletId,
      this.recipientWalletId,
      this.contentHash,
      this.messageType,
      this.timestamp,
      this.threadId,
      this.nonce,
    ]);
  }
}

// ─── Local Interface + Builder ──────────────────────────────

/**
 * Raw message data before on-chain encoding.
 */
export interface MessageLocalData {
  /** Sender wallet ID as bigint string */
  senderWalletId: string;
  /** Recipient wallet ID as bigint string */
  recipientWalletId: string;
  /** Poseidon hash of encrypted content as bigint string */
  contentHash: string;
  /** Message type (1-5) */
  messageType: number;
  /** Timestamp as CCYYMMDDHHMMSS string */
  timestamp: string;
  /** Thread identifier string (will be hashed) */
  threadId: string;
  /** Nonce (monotonic per sender) */
  nonce: number;
}

/**
 * Build a MessageData from raw local data.
 */
export function buildMessageData(local: MessageLocalData): MessageData {
  return new MessageData({
    senderWalletId: Field(BigInt(local.senderWalletId)),
    recipientWalletId: Field(BigInt(local.recipientWalletId)),
    contentHash: Field(BigInt(local.contentHash)),
    messageType: Field(BigInt(local.messageType)),
    timestamp: Field(BigInt(local.timestamp)),
    threadId: hashString(local.threadId),
    nonce: Field(BigInt(local.nonce)),
  });
}
