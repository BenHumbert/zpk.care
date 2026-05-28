/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Field } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import { MessageData } from './message-data.js';
import {
  DelegationData,
  SCOPE_ALL,
  REL_MIGRATION,
} from './delegation-data.js';
import {
  MessageRegistry,
  DelegationRegistry,
  KeyRegistry,
  computeMessagingRoot,
} from './message-registry.js';
import { MessagingProgram } from './messaging-program.js';
import {
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  computeContentHash,
  publicKeyToFields,
  fieldsToPublicKey,
} from './encryption.js';
import { hashString } from '../zkp/hash-utils.js';
import { MSG_TYPE_AOR_REVOKE } from './aor-data.js';
import type { StoredMessage, MessagePayload } from '../l2/message-store-types.js';

/**
 * MessagingService — orchestration layer for the messaging system.
 *
 * Manages message sending, delegation creation, key registration,
 * and message decryption. Generates ZK proofs for message/delegation
 * integrity.
 *
 * Preconditions:
 *   await MessagingProgram.compile();
 */
export class MessagingService {
  private store: ILocalStore;
  private messageRegistry: MessageRegistry;
  private delegationRegistry: DelegationRegistry;
  private keyRegistry: KeyRegistry;
  /** Public key buffers indexed by wallet index (for encryption lookups) */
  private publicKeyStore: Map<bigint, Buffer>;
  /** Track sender nonces */
  private nonces: Map<string, number>;

  constructor(
    store: ILocalStore,
    messageRegistry: MessageRegistry,
    delegationRegistry: DelegationRegistry,
    keyRegistry: KeyRegistry,
  ) {
    this.store = store;
    this.messageRegistry = messageRegistry;
    this.delegationRegistry = delegationRegistry;
    this.keyRegistry = keyRegistry;
    this.publicKeyStore = new Map();
    this.nonces = new Map();
  }

  // ─── Key Management ─────────────────────────────────────

  /**
   * Register an encryption public key for a wallet.
   *
   * Stores the key commitment in the on-chain key registry and
   * caches the raw public key buffer for encryption lookups.
   *
   * @param walletIndex — the wallet's index (same as wallet registry)
   * @param walletId — the wallet ID
   * @param publicKey — 32-byte X25519 public key
   * @returns The new messaging root
   */
  registerEncryptionKey(
    walletIndex: bigint,
    walletId: Field,
    publicKey: Buffer,
  ): Field {
    const { pubKeyX, pubKeyY } = publicKeyToFields(publicKey);
    this.keyRegistry.registerKey(walletIndex, walletId, pubKeyX, pubKeyY);
    this.publicKeyStore.set(walletIndex, publicKey);
    return this.getMessagingRoot();
  }

  /**
   * Look up a recipient's public key by wallet index.
   */
  getRecipientPublicKey(walletIndex: bigint): Buffer | undefined {
    return this.publicKeyStore.get(walletIndex);
  }

  // ─── Send Message ───────────────────────────────────────

  /**
   * Send an encrypted message.
   *
   * 1. Encrypts the plaintext with the ECDH shared secret
   * 2. Computes the content hash for on-chain commitment
   * 3. Builds MessageData and adds to the message registry
   * 4. Generates a MessagingProof
   *
   * @returns The proof, encrypted payload, and message data
   */
  async sendMessage(
    senderWalletId: Field,
    recipientWalletId: Field,
    plaintext: string,
    messageType: Field,
    threadId: Field,
    senderPrivateKey: Buffer,
    recipientPublicKey: Buffer,
  ) {
    // Encrypt the message
    const sharedSecret = deriveSharedSecret(senderPrivateKey, recipientPublicKey);
    const encrypted = encryptMessage(plaintext, sharedSecret);
    const contentHash = computeContentHash(encrypted.ciphertext, encrypted.iv, encrypted.tag);

    // Track nonce per sender
    const senderKey = senderWalletId.toString();
    const currentNonce = (this.nonces.get(senderKey) ?? 0) + 1;
    this.nonces.set(senderKey, currentNonce);

    // Build message data
    const timestamp = Field(BigInt(Date.now()));
    const messageData = new MessageData({
      senderWalletId,
      recipientWalletId,
      contentHash,
      messageType,
      timestamp,
      threadId,
      nonce: Field(currentNonce),
    });

    // Add to registry
    const { index } = this.messageRegistry.addMessage(messageData);
    const messageWitness = this.messageRegistry.getWitness(index);

    // Generate proof
    const result = await MessagingProgram.proveSendMessage(
      messageData,
      messageWitness,
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    );

    // Store proof
    const proofId = `msg-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    // Build StoredMessage + MessagePayload for sequencer submission
    const storedMessage: StoredMessage = {
      messageCommitment: contentHash.toString(),
      senderWalletId: senderWalletId.toString(),
      recipientWalletId: recipientWalletId.toString(),
      messageType: messageType.toString(),
      threadIdHash: threadId.toString(),
    };

    const messagePayload: MessagePayload = {
      ciphertext: encrypted.ciphertext.toString('hex'),
      iv: encrypted.iv.toString('hex'),
      tag: encrypted.tag.toString('hex'),
      timestamp: Date.now(),
    };

    return {
      proof: result.proof,
      encryptedContent: encrypted,
      messageData,
      messageIndex: index,
      storedMessage,
      messagePayload,
    };
  }

  // ─── Create Delegation ──────────────────────────────────

  /**
   * Create a delegation and generate a proof.
   *
   * @param delegationData — the delegation data to register
   * @param currentDate — current date as Field (CCYYMMDD)
   * @returns The proof and delegation index
   */
  async createDelegation(
    delegationData: DelegationData,
    currentDate: Field,
  ) {
    // Add to registry
    const { index } = this.delegationRegistry.addDelegation(delegationData);
    const delegationWitness = this.delegationRegistry.getWitness(index);

    // Generate proof
    const result = await MessagingProgram.proveDelegate(
      delegationData,
      delegationWitness,
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
      currentDate,
    );

    // Store proof
    const proofId = `del-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      delegationIndex: index,
    };
  }

  // ─── Migration Delegation ───────────────────────────────

  /**
   * Create a migration delegation (insurer-initiated wallet recovery).
   *
   * Links an old wallet to a new wallet with SCOPE_ALL and no expiration.
   * The admin (insurer) calls this after verifying the user's identity
   * through out-of-band means.
   *
   * @param oldWalletId — the wallet being migrated from
   * @param newWalletId — the new wallet being migrated to
   * @param effectiveDate — when the migration takes effect (CCYYMMDD)
   */
  async createMigrationDelegation(
    oldWalletId: Field,
    newWalletId: Field,
    effectiveDate: Field,
  ) {
    const delegationData = new DelegationData({
      delegatorWalletId: oldWalletId,
      delegateWalletId: newWalletId,
      scopeFlags: SCOPE_ALL,
      effectiveDate,
      expirationDate: Field(BigInt(99991231)), // no practical expiration
      relationshipCode: REL_MIGRATION,
      delegationHash: hashString('MIGRATION'),
    });

    return this.createDelegation(delegationData, effectiveDate);
  }

  // ─── Read / Decrypt Message ─────────────────────────────

  /**
   * Read and decrypt a message from the registry.
   *
   * @param messageIndex — the message's index in the registry
   * @param readerPrivateKey — reader's X25519 private key (32 bytes)
   * @param senderPublicKey — sender's X25519 public key (32 bytes)
   * @returns The decrypted plaintext and message metadata
   */
  readMessage(
    messageIndex: bigint,
    readerPrivateKey: Buffer,
    senderPublicKey: Buffer,
    encryptedPayload: { ciphertext: Buffer; iv: Buffer; tag: Buffer },
  ): { plaintext: string; messageData: MessageData } {
    const messageData = this.messageRegistry.getMessage(messageIndex);
    if (!messageData) {
      throw new Error(`No message at index ${messageIndex}`);
    }

    const sharedSecret = deriveSharedSecret(readerPrivateKey, senderPublicKey);
    const plaintext = decryptMessage(
      encryptedPayload.ciphertext,
      encryptedPayload.iv,
      encryptedPayload.tag,
      sharedSecret,
    );

    return { plaintext, messageData };
  }

  // ─── Revocation Notification ────────────────────────────

  /**
   * Send a revocation notification message and compute the new messaging root.
   *
   * Called AFTER AorService.revokeAor() has zeroed the delegation leaf.
   * Adds an MSG_TYPE_AOR_REVOKE message to the message registry as an
   * audit trail, then computes the updated messagingRoot (which reflects
   * both the zeroed delegation leaf and the new message).
   *
   * The returned messagingRoot is ready for on-chain commit via
   * CareContract.revokeDelegation().
   *
   * @param revokerWalletId — who revoked (member or admin)
   * @param memberWalletId — the member's wallet ID
   * @param repWalletId — the representative's wallet ID
   * @param revokedDelegationCommitment — commitment of the delegation before revocation
   * @returns The new messaging root and the revoke message index
   */
  sendRevocationNotification(
    revokerWalletId: Field,
    memberWalletId: Field,
    repWalletId: Field,
    revokedDelegationCommitment: Field,
  ): { newMessagingRoot: Field; messageIndex: bigint; messageData: MessageData } {
    // Track nonce per sender
    const senderKey = revokerWalletId.toString();
    const currentNonce = (this.nonces.get(senderKey) ?? 0) + 1;
    this.nonces.set(senderKey, currentNonce);

    // Build the revocation message
    const messageData = new MessageData({
      senderWalletId: revokerWalletId,
      recipientWalletId: memberWalletId,
      contentHash: revokedDelegationCommitment,
      messageType: MSG_TYPE_AOR_REVOKE,
      timestamp: Field(BigInt(Date.now())),
      threadId: repWalletId, // thread links to the rep being revoked
      nonce: Field(currentNonce),
    });

    // Add to message registry
    const { index } = this.messageRegistry.addMessage(messageData);

    return {
      newMessagingRoot: this.getMessagingRoot(),
      messageIndex: index,
      messageData,
    };
  }

  // ─── Root ───────────────────────────────────────────────

  /**
   * Compute the current packed messaging root.
   * This is the value stored in CareContract slot 7.
   */
  getMessagingRoot(): Field {
    return computeMessagingRoot(
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    );
  }
}
