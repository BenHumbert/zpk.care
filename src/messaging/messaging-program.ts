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

import { Field, Struct, Poseidon, ZkProgram } from 'o1js';
import { MessageData } from './message-data.js';
import { DelegationData } from './delegation-data.js';
import { MessageRegistryWitness } from './message-registry.js';
import { DelegationRegistryWitness } from './message-registry.js';

// ─── Operation Type Constants ───────────────────────────────

/** Operation type: send message */
const OP_SEND = Field(1);
/** Operation type: create delegation */
const OP_DELEGATE = Field(2);

// ─── MessagingOutput ────────────────────────────────────────

/**
 * MessagingOutput — public output of MessagingProgram methods.
 *
 * A verifier can confirm that:
 *   1. A message is well-formed and committed to the registry, OR
 *   2. A delegation is well-formed and committed to the registry
 *
 * The operationType field distinguishes between the two.
 */
export class MessagingOutput extends Struct({
  /** Message or delegation commitment */
  commitment: Field,
  /** Sender wallet ID (message) or delegator wallet ID (delegation) */
  senderWalletId: Field,
  /** Recipient wallet ID (message) or delegate wallet ID (delegation) */
  recipientWalletId: Field,
  /** Content hash (message) or scope flags (delegation) */
  contentHash: Field,
  /** Message type (message) or relationship code (delegation) */
  messageType: Field,
  /** Field(1)=send, Field(2)=delegate */
  operationType: Field,
  /** Poseidon.hash([messageRegistryRoot, delegationRegistryRoot, keyRegistryRoot]) */
  messagingRoot: Field,
}) {}

// ─── MessagingProgram ───────────────────────────────────────

/**
 * MessagingProgram — standalone ZkProgram for message and delegation proofs.
 *
 * No recursion — fast compile (~1 min). Sender/delegator identity
 * is proved separately via ProofGateProgram (verified by admin before
 * committing the message/delegation on-chain).
 *
 * Two methods:
 *   1. proveSendMessage — proves a message is well-formed and in the registry
 *   2. proveDelegate — proves a delegation is well-formed and in the registry
 */
export const MessagingProgram = ZkProgram({
  name: 'Messaging',
  publicOutput: MessagingOutput,

  methods: {
    /**
     * Prove a message is well-formed and committed to the message registry.
     *
     * Verifications:
     *   1. Message commitment is correctly computed
     *   2. Message commitment is in the message registry (Merkle witness)
     *   3. messagingRoot = Poseidon.hash([messageRegistryRoot, delegationRegistryRoot, keyRegistryRoot])
     *   4. Message type is valid (1-5)
     *   5. Nonce > 0 (prevents replay)
     */
    proveSendMessage: {
      privateInputs: [
        MessageData,
        MessageRegistryWitness,
        Field,  // messageRegistryRoot
        Field,  // delegationRegistryRoot
        Field,  // keyRegistryRoot
      ],
      async method(
        messageData: MessageData,
        messageWitness: MessageRegistryWitness,
        messageRegistryRoot: Field,
        delegationRegistryRoot: Field,
        keyRegistryRoot: Field,
      ) {
        // 1. Verify message commitment
        const commitment = messageData.commitment();

        // 2. Verify message is in the registry
        const computedRoot = messageWitness.calculateRoot(commitment);
        computedRoot.assertEquals(
          messageRegistryRoot,
          'Message not in registry',
        );

        // 3. Compute messaging root
        const messagingRoot = Poseidon.hash([
          messageRegistryRoot,
          delegationRegistryRoot,
          keyRegistryRoot,
        ]);

        // 4. Message type is valid (1-7: prescription, PA req/resp, notification, general, support, support summary)
        messageData.messageType
          .greaterThanOrEqual(Field(1))
          .assertTrue('Message type must be >= 1');
        messageData.messageType
          .lessThanOrEqual(Field(7))
          .assertTrue('Message type must be <= 7');

        // 5. Nonce > 0
        messageData.nonce
          .greaterThan(Field(0))
          .assertTrue('Nonce must be > 0');

        return {
          publicOutput: new MessagingOutput({
            commitment,
            senderWalletId: messageData.senderWalletId,
            recipientWalletId: messageData.recipientWalletId,
            contentHash: messageData.contentHash,
            messageType: messageData.messageType,
            operationType: OP_SEND,
            messagingRoot,
          }),
        };
      },
    },

    /**
     * Prove a delegation is well-formed and committed to the delegation registry.
     *
     * Verifications:
     *   1. Delegation commitment is correctly computed
     *   2. Delegation commitment is in the delegation registry (Merkle witness)
     *   3. messagingRoot = Poseidon.hash([messageRegistryRoot, delegationRegistryRoot, keyRegistryRoot])
     *   4. effectiveDate <= currentDate <= expirationDate
     *   5. scopeFlags > 0 (at least one permission granted)
     */
    proveDelegate: {
      privateInputs: [
        DelegationData,
        DelegationRegistryWitness,
        Field,  // messageRegistryRoot
        Field,  // delegationRegistryRoot
        Field,  // keyRegistryRoot
        Field,  // currentDate (CCYYMMDD)
      ],
      async method(
        delegationData: DelegationData,
        delegationWitness: DelegationRegistryWitness,
        messageRegistryRoot: Field,
        delegationRegistryRoot: Field,
        keyRegistryRoot: Field,
        currentDate: Field,
      ) {
        // 1. Verify delegation commitment
        const commitment = delegationData.commitment();

        // 2. Verify delegation is in the registry
        const computedRoot = delegationWitness.calculateRoot(commitment);
        computedRoot.assertEquals(
          delegationRegistryRoot,
          'Delegation not in registry',
        );

        // 3. Compute messaging root
        const messagingRoot = Poseidon.hash([
          messageRegistryRoot,
          delegationRegistryRoot,
          keyRegistryRoot,
        ]);

        // 4. Date validity: effectiveDate <= currentDate <= expirationDate
        delegationData.effectiveDate
          .lessThanOrEqual(currentDate)
          .assertTrue('Delegation not yet effective');
        currentDate
          .lessThanOrEqual(delegationData.expirationDate)
          .assertTrue('Delegation has expired');

        // 5. scopeFlags > 0
        delegationData.scopeFlags
          .greaterThan(Field(0))
          .assertTrue('Scope flags must grant at least one permission');

        return {
          publicOutput: new MessagingOutput({
            commitment,
            senderWalletId: delegationData.delegatorWalletId,
            recipientWalletId: delegationData.delegateWalletId,
            contentHash: delegationData.scopeFlags,
            messageType: delegationData.relationshipCode,
            operationType: OP_DELEGATE,
            messagingRoot,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility */
export class MessagingProof extends ZkProgram.Proof(MessagingProgram) {}
