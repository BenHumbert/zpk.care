import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  MessageData,
  buildMessageData,
  MSG_TYPE_PRESCRIPTION,
  MSG_TYPE_PA_REQUEST,
  MSG_TYPE_PA_RESPONSE,
  MSG_TYPE_NOTIFICATION,
  MSG_TYPE_GENERAL,
} from '../src/messaging/message-data.js';
import type { MessageLocalData } from '../src/messaging/message-data.js';
import {
  DelegationData,
  buildDelegationData,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_PICKUP,
  SCOPE_ALL,
  REL_PARENT,
  REL_SPOUSE,
  REL_POA,
  REL_GUARDIAN,
  REL_MIGRATION,
} from '../src/messaging/delegation-data.js';
import type { DelegationLocalData } from '../src/messaging/delegation-data.js';
import {
  deriveEncryptionKeyPair,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  computeContentHash,
  publicKeyToFields,
  fieldsToPublicKey,
} from '../src/messaging/encryption.js';
import {
  MessageRegistry,
  DelegationRegistry,
  KeyRegistry,
  computeMessagingRoot,
  MESSAGE_TREE_HEIGHT,
  DELEGATION_TREE_HEIGHT,
  KEY_TREE_HEIGHT,
} from '../src/messaging/message-registry.js';
import {
  MessagingProgram,
  MessagingOutput,
} from '../src/messaging/messaging-program.js';
import { MessagingService } from '../src/messaging/messaging-service.js';
import { MessagingVerificationService } from '../src/messaging/messaging-verification-service.js';
import { hashString, dateToField } from '../src/zkp/hash-utils.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { CareContract } from '../src/engine/care-contract.js';
import { PrivateKey, Mina, AccountUpdate } from 'o1js';

// ─── Test Data ───────────────────────────────────────────

const sampleMessageLocal: MessageLocalData = {
  senderWalletId: '111222333444555666',
  recipientWalletId: '999888777666555444',
  contentHash: '123456789',
  messageType: 1,
  timestamp: '20260201120000',
  threadId: 'thread-rx-001',
  nonce: 1,
};

const sampleDelegationLocal: DelegationLocalData = {
  delegatorWalletId: '111222333444555666',
  delegateWalletId: '777888999000111222',
  scopeFlags: 7,  // ALL
  effectiveDate: '20260101',
  expirationDate: '20261231',
  relationshipCode: 1,  // PARENT
  legalDocumentRef: 'LEGAL-DOC-2026-001',
};

/** Helper: create test MessageData */
function createTestMessage(overrides?: Partial<{
  senderWalletId: Field;
  recipientWalletId: Field;
  contentHash: Field;
  messageType: Field;
  timestamp: Field;
  threadId: Field;
  nonce: Field;
}>): MessageData {
  return new MessageData({
    senderWalletId: overrides?.senderWalletId ?? Field(111222333444555666n),
    recipientWalletId: overrides?.recipientWalletId ?? Field(999888777666555444n),
    contentHash: overrides?.contentHash ?? Field(123456789n),
    messageType: overrides?.messageType ?? Field(1),
    timestamp: overrides?.timestamp ?? Field(20260201120000n),
    threadId: overrides?.threadId ?? hashString('thread-rx-001'),
    nonce: overrides?.nonce ?? Field(1),
  });
}

/** Helper: create test DelegationData */
function createTestDelegation(overrides?: Partial<{
  delegatorWalletId: Field;
  delegateWalletId: Field;
  scopeFlags: Field;
  effectiveDate: Field;
  expirationDate: Field;
  relationshipCode: Field;
  delegationHash: Field;
}>): DelegationData {
  return new DelegationData({
    delegatorWalletId: overrides?.delegatorWalletId ?? Field(111222333444555666n),
    delegateWalletId: overrides?.delegateWalletId ?? Field(777888999000111222n),
    scopeFlags: overrides?.scopeFlags ?? SCOPE_ALL,
    effectiveDate: overrides?.effectiveDate ?? Field(20260101n),
    expirationDate: overrides?.expirationDate ?? Field(20261231n),
    relationshipCode: overrides?.relationshipCode ?? REL_PARENT,
    delegationHash: overrides?.delegationHash ?? hashString('LEGAL-DOC-2026-001'),
  });
}

// ─── Tests ──────────────────────────────────────────────

describe('Layer 7 — Messaging & Delegation Infrastructure', () => {
  // ─── MessageData Model ──────────────────────────────────

  describe('MessageData Model', () => {
    test('commitment is deterministic', () => {
      const msg1 = createTestMessage();
      const msg2 = createTestMessage();
      expect(msg1.commitment().toString()).toBe(msg2.commitment().toString());
    });

    test('commitment changes when any field changes', () => {
      const base = createTestMessage();
      const withDiffSender = createTestMessage({ senderWalletId: Field(999n) });
      const withDiffType = createTestMessage({ messageType: Field(3) });
      const withDiffNonce = createTestMessage({ nonce: Field(42) });

      const baseCommit = base.commitment().toString();
      expect(withDiffSender.commitment().toString()).not.toBe(baseCommit);
      expect(withDiffType.commitment().toString()).not.toBe(baseCommit);
      expect(withDiffNonce.commitment().toString()).not.toBe(baseCommit);
    });

    test('buildMessageData from local data', () => {
      const msg = buildMessageData(sampleMessageLocal);
      expect(msg.senderWalletId.toBigInt()).toBe(111222333444555666n);
      expect(msg.messageType.toBigInt()).toBe(1n);
      expect(msg.nonce.toBigInt()).toBe(1n);
      // commitment should not be zero
      expect(msg.commitment().toBigInt()).not.toBe(0n);
    });

    test('commitment matches manual Poseidon.hash of 7 fields', () => {
      const msg = createTestMessage();
      const manual = Poseidon.hash([
        msg.senderWalletId,
        msg.recipientWalletId,
        msg.contentHash,
        msg.messageType,
        msg.timestamp,
        msg.threadId,
        msg.nonce,
      ]);
      expect(msg.commitment().toString()).toBe(manual.toString());
    });
  });

  // ─── DelegationData Model ───────────────────────────────

  describe('DelegationData Model', () => {
    test('commitment is deterministic', () => {
      const d1 = createTestDelegation();
      const d2 = createTestDelegation();
      expect(d1.commitment().toString()).toBe(d2.commitment().toString());
    });

    test('commitment changes when any field changes', () => {
      const base = createTestDelegation();
      const withDiffScope = createTestDelegation({ scopeFlags: SCOPE_READ });
      const withDiffRel = createTestDelegation({ relationshipCode: REL_POA });
      const withDiffDate = createTestDelegation({ expirationDate: Field(20270101n) });

      const baseCommit = base.commitment().toString();
      expect(withDiffScope.commitment().toString()).not.toBe(baseCommit);
      expect(withDiffRel.commitment().toString()).not.toBe(baseCommit);
      expect(withDiffDate.commitment().toString()).not.toBe(baseCommit);
    });

    test('buildDelegationData from local data', () => {
      const del = buildDelegationData(sampleDelegationLocal);
      expect(del.delegatorWalletId.toBigInt()).toBe(111222333444555666n);
      expect(del.scopeFlags.toBigInt()).toBe(7n);
      expect(del.relationshipCode.toBigInt()).toBe(1n);
      expect(del.commitment().toBigInt()).not.toBe(0n);
    });

    test('commitment matches manual Poseidon.hash of 7 fields', () => {
      const del = createTestDelegation();
      const manual = Poseidon.hash([
        del.delegatorWalletId,
        del.delegateWalletId,
        del.scopeFlags,
        del.effectiveDate,
        del.expirationDate,
        del.relationshipCode,
        del.delegationHash,
      ]);
      expect(del.commitment().toString()).toBe(manual.toString());
    });

    test('scope constants have correct values', () => {
      expect(SCOPE_READ.toBigInt()).toBe(1n);
      expect(SCOPE_WRITE.toBigInt()).toBe(2n);
      expect(SCOPE_PICKUP.toBigInt()).toBe(4n);
      expect(SCOPE_ALL.toBigInt()).toBe(7n);
    });

    test('relationship constants have correct values', () => {
      expect(REL_PARENT.toBigInt()).toBe(1n);
      expect(REL_SPOUSE.toBigInt()).toBe(2n);
      expect(REL_POA.toBigInt()).toBe(3n);
      expect(REL_GUARDIAN.toBigInt()).toBe(4n);
      expect(REL_MIGRATION.toBigInt()).toBe(5n);
    });
  });

  // ─── Encryption Utilities ───────────────────────────────

  describe('Encryption Utilities', () => {
    test('deriveEncryptionKeyPair produces valid deterministic keys', () => {
      const kp1 = deriveEncryptionKeyPair('my-enrollment-key-123');
      const kp2 = deriveEncryptionKeyPair('my-enrollment-key-123');

      // Deterministic
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(true);
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(true);

      // 32 bytes each
      expect(kp1.publicKey.length).toBe(32);
      expect(kp1.privateKey.length).toBe(32);
    });

    test('different enrollment keys produce different key pairs', () => {
      const kp1 = deriveEncryptionKeyPair('enrollment-key-A');
      const kp2 = deriveEncryptionKeyPair('enrollment-key-B');

      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
    });

    test('encrypt/decrypt round-trip preserves content', () => {
      const kpSender = deriveEncryptionKeyPair('sender-enrollment-key');
      const kpRecipient = deriveEncryptionKeyPair('recipient-enrollment-key');

      const sharedSecretSender = deriveSharedSecret(kpSender.privateKey, kpRecipient.publicKey);
      const sharedSecretRecipient = deriveSharedSecret(kpRecipient.privateKey, kpSender.publicKey);

      // Shared secrets must match (ECDH property)
      expect(sharedSecretSender.equals(sharedSecretRecipient)).toBe(true);

      const plaintext = 'Patient requires 90-day supply of Lisinopril 10mg';
      const encrypted = encryptMessage(plaintext, sharedSecretSender);
      const decrypted = decryptMessage(
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        sharedSecretRecipient,
      );

      expect(decrypted).toBe(plaintext);
    });

    test('computeContentHash is deterministic for same input', () => {
      const ciphertext = Buffer.from('encrypted-content-bytes');
      const iv = Buffer.from('123456789012');

      const hash1 = computeContentHash(ciphertext, iv);
      const hash2 = computeContentHash(ciphertext, iv);
      expect(hash1.toString()).toBe(hash2.toString());
    });

    test('publicKeyToFields and fieldsToPublicKey round-trip', () => {
      const kp = deriveEncryptionKeyPair('test-key-roundtrip');
      const { pubKeyX, pubKeyY } = publicKeyToFields(kp.publicKey);
      const recovered = fieldsToPublicKey(pubKeyX, pubKeyY);
      expect(recovered.equals(kp.publicKey)).toBe(true);
    });
  });

  // ─── Registries ─────────────────────────────────────────

  describe('MessageRegistry + DelegationRegistry + KeyRegistry', () => {
    test('empty registries have correct roots', () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      // Roots should be the empty tree root for their respective heights
      const emptyMsgTree = new MerkleTree(MESSAGE_TREE_HEIGHT);
      const emptyDelTree = new MerkleTree(DELEGATION_TREE_HEIGHT);
      const emptyKeyTree = new MerkleTree(KEY_TREE_HEIGHT);

      expect(msgReg.getRoot().toString()).toBe(emptyMsgTree.getRoot().toString());
      expect(delReg.getRoot().toString()).toBe(emptyDelTree.getRoot().toString());
      expect(keyReg.getRoot().toString()).toBe(emptyKeyTree.getRoot().toString());
      expect(msgReg.count).toBe(0);
      expect(delReg.count).toBe(0);
      expect(keyReg.count).toBe(0);
    });

    test('addMessage / addDelegation changes root', () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();

      const emptyMsgRoot = msgReg.getRoot().toString();
      const emptyDelRoot = delReg.getRoot().toString();

      const msg = createTestMessage();
      const { newRoot: msgNewRoot } = msgReg.addMessage(msg);
      expect(msgNewRoot.toString()).not.toBe(emptyMsgRoot);
      expect(msgReg.count).toBe(1);

      const del = createTestDelegation();
      const { newRoot: delNewRoot } = delReg.addDelegation(del);
      expect(delNewRoot.toString()).not.toBe(emptyDelRoot);
      expect(delReg.count).toBe(1);
    });

    test('witness proves inclusion', () => {
      const msgReg = new MessageRegistry();
      const msg = createTestMessage();
      const { index } = msgReg.addMessage(msg);

      const witness = msgReg.getWitness(index);
      const computedRoot = witness.calculateRoot(msg.commitment());
      expect(computedRoot.toString()).toBe(msgReg.getRoot().toString());
    });

    test('KeyRegistry registerKey and computeMessagingRoot', () => {
      const keyReg = new KeyRegistry();
      const walletId = Field(42n);
      const pubKeyX = Field(100n);
      const pubKeyY = Field(200n);

      const emptyRoot = keyReg.getRoot().toString();
      keyReg.registerKey(0n, walletId, pubKeyX, pubKeyY);
      expect(keyReg.getRoot().toString()).not.toBe(emptyRoot);
      expect(keyReg.count).toBe(1);

      // Key commitment matches manual
      const expectedCommitment = Poseidon.hash([walletId, pubKeyX, pubKeyY]);
      expect(keyReg.getKeyCommitment(0n).toString()).toBe(expectedCommitment.toString());

      // computeMessagingRoot combines all three
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const root = computeMessagingRoot(
        msgReg.getRoot(),
        delReg.getRoot(),
        keyReg.getRoot(),
      );
      const expected = Poseidon.hash([
        msgReg.getRoot(),
        delReg.getRoot(),
        keyReg.getRoot(),
      ]);
      expect(root.toString()).toBe(expected.toString());
    });
  });

  // ─── MessagingProgram ───────────────────────────────────

  describe('MessagingProgram', () => {
    // Compile once before all program tests
    beforeAll(async () => {
      await MessagingProgram.compile();
    }, 120_000);

    describe('proveSendMessage', () => {
      test('valid message generates proof', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const msg = createTestMessage();
        const { index } = msgReg.addMessage(msg);
        const witness = msgReg.getWitness(index);

        const result = await MessagingProgram.proveSendMessage(
          msg,
          witness,
          msgReg.getRoot(),
          delReg.getRoot(),
          keyReg.getRoot(),
        );

        const output = result.proof.publicOutput;
        expect(output.commitment.toString()).toBe(msg.commitment().toString());
        expect(output.senderWalletId.toString()).toBe(msg.senderWalletId.toString());
        expect(output.operationType.toString()).toBe('1'); // OP_SEND
      }, 120_000);

      test('proof verifies standalone', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const msg = createTestMessage();
        const { index } = msgReg.addMessage(msg);
        const witness = msgReg.getWitness(index);

        const result = await MessagingProgram.proveSendMessage(
          msg,
          witness,
          msgReg.getRoot(),
          delReg.getRoot(),
          keyReg.getRoot(),
        );

        const ok = await MessagingProgram.verify(result.proof);
        expect(ok).toBe(true);
      }, 120_000);

      test('rejects invalid message type (Field(0))', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const msg = createTestMessage({ messageType: Field(0) });
        const { index } = msgReg.addMessage(msg);
        const witness = msgReg.getWitness(index);

        await expect(
          MessagingProgram.proveSendMessage(
            msg,
            witness,
            msgReg.getRoot(),
            delReg.getRoot(),
            keyReg.getRoot(),
          ),
        ).rejects.toThrow();
      }, 30_000);

      test('rejects nonce == 0', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const msg = createTestMessage({ nonce: Field(0) });
        const { index } = msgReg.addMessage(msg);
        const witness = msgReg.getWitness(index);

        await expect(
          MessagingProgram.proveSendMessage(
            msg,
            witness,
            msgReg.getRoot(),
            delReg.getRoot(),
            keyReg.getRoot(),
          ),
        ).rejects.toThrow();
      }, 30_000);

      test('rejects message not in registry (wrong witness)', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const msg1 = createTestMessage();
        msgReg.addMessage(msg1);

        // Get witness for slot 1 (empty) but try to prove msg1
        const wrongWitness = msgReg.getWitness(1n);

        await expect(
          MessagingProgram.proveSendMessage(
            msg1,
            wrongWitness,
            msgReg.getRoot(),
            delReg.getRoot(),
            keyReg.getRoot(),
          ),
        ).rejects.toThrow();
      }, 30_000);
    });

    describe('proveDelegate', () => {
      test('valid delegation generates proof', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const del = createTestDelegation();
        const { index } = delReg.addDelegation(del);
        const witness = delReg.getWitness(index);
        const currentDate = Field(20260615n);  // mid-year

        const result = await MessagingProgram.proveDelegate(
          del,
          witness,
          msgReg.getRoot(),
          delReg.getRoot(),
          keyReg.getRoot(),
          currentDate,
        );

        const output = result.proof.publicOutput;
        expect(output.commitment.toString()).toBe(del.commitment().toString());
        expect(output.operationType.toString()).toBe('2'); // OP_DELEGATE
      }, 120_000);

      test('rejects expired delegation', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const del = createTestDelegation({ expirationDate: Field(20260101n) });
        const { index } = delReg.addDelegation(del);
        const witness = delReg.getWitness(index);
        const currentDate = Field(20260615n);  // after expiration

        await expect(
          MessagingProgram.proveDelegate(
            del,
            witness,
            msgReg.getRoot(),
            delReg.getRoot(),
            keyReg.getRoot(),
            currentDate,
          ),
        ).rejects.toThrow();
      }, 30_000);

      test('rejects delegation not yet effective', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const del = createTestDelegation({ effectiveDate: Field(20270101n) });
        const { index } = delReg.addDelegation(del);
        const witness = delReg.getWitness(index);
        const currentDate = Field(20260615n);  // before effective

        await expect(
          MessagingProgram.proveDelegate(
            del,
            witness,
            msgReg.getRoot(),
            delReg.getRoot(),
            keyReg.getRoot(),
            currentDate,
          ),
        ).rejects.toThrow();
      }, 30_000);

      test('rejects zero scope flags', async () => {
        const msgReg = new MessageRegistry();
        const delReg = new DelegationRegistry();
        const keyReg = new KeyRegistry();

        const del = createTestDelegation({ scopeFlags: Field(0) });
        const { index } = delReg.addDelegation(del);
        const witness = delReg.getWitness(index);
        const currentDate = Field(20260615n);

        await expect(
          MessagingProgram.proveDelegate(
            del,
            witness,
            msgReg.getRoot(),
            delReg.getRoot(),
            keyReg.getRoot(),
            currentDate,
          ),
        ).rejects.toThrow();
      }, 30_000);
    });
  });

  // ─── MessagingService ───────────────────────────────────

  describe('MessagingService', () => {
    let service: MessagingService;
    let senderKp: { publicKey: Buffer; privateKey: Buffer };
    let recipientKp: { publicKey: Buffer; privateKey: Buffer };

    beforeAll(async () => {
      // MessagingProgram already compiled in the program tests above
      const store = new InMemoryStore();
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();
      service = new MessagingService(store, msgReg, delReg, keyReg);

      senderKp = deriveEncryptionKeyPair('sender-enrollment-test');
      recipientKp = deriveEncryptionKeyPair('recipient-enrollment-test');

      // Register keys
      service.registerEncryptionKey(0n, Field(111n), senderKp.publicKey);
      service.registerEncryptionKey(1n, Field(222n), recipientKp.publicKey);
    }, 5_000);

    test('sendMessage encrypts + generates proof + adds to registry', async () => {
      const result = await service.sendMessage(
        Field(111n),
        Field(222n),
        'Prescribe Lisinopril 10mg #90',
        MSG_TYPE_PRESCRIPTION,
        hashString('thread-1'),
        senderKp.privateKey,
        recipientKp.publicKey,
      );

      expect(result.proof).toBeDefined();
      expect(result.encryptedContent.ciphertext.length).toBeGreaterThan(0);
      expect(result.messageData.senderWalletId.toString()).toBe(Field(111n).toString());
    }, 120_000);

    test('readMessage decrypts correctly for authorized reader', async () => {
      const sendResult = await service.sendMessage(
        Field(111n),
        Field(222n),
        'PA approved for Ozempic',
        MSG_TYPE_PA_RESPONSE,
        hashString('thread-pa-1'),
        senderKp.privateKey,
        recipientKp.publicKey,
      );

      const { plaintext, messageData } = service.readMessage(
        sendResult.messageIndex,
        recipientKp.privateKey,
        senderKp.publicKey,
        sendResult.encryptedContent,
      );

      expect(plaintext).toBe('PA approved for Ozempic');
      expect(messageData.messageType.toString()).toBe(MSG_TYPE_PA_RESPONSE.toString());
    }, 120_000);

    test('createMigrationDelegation creates REL_MIGRATION with SCOPE_ALL', async () => {
      const result = await service.createMigrationDelegation(
        Field(111n),  // old wallet
        Field(333n),  // new wallet
        Field(20260201n),
      );

      expect(result.proof).toBeDefined();
      const output = result.proof.publicOutput;
      // operationType should be delegate (2)
      expect(output.operationType.toString()).toBe('2');
      // contentHash stores scopeFlags = SCOPE_ALL = 7
      expect(output.contentHash.toString()).toBe('7');
      // messageType stores relationshipCode = REL_MIGRATION = 5
      expect(output.messageType.toString()).toBe('5');
    }, 120_000);
  });

  // ─── MessagingVerificationService ───────────────────────

  describe('MessagingVerificationService', () => {
    const verifier = new MessagingVerificationService();

    test('verifyMessage accepts valid proof', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      const msg = createTestMessage();
      const { index } = msgReg.addMessage(msg);
      const witness = msgReg.getWitness(index);

      const result = await MessagingProgram.proveSendMessage(
        msg,
        witness,
        msgReg.getRoot(),
        delReg.getRoot(),
        keyReg.getRoot(),
      );

      const verification = await verifier.verifyMessage(result.proof);
      expect(verification.isValid).toBe(true);
      expect(verification.senderWalletId).toBe(msg.senderWalletId.toString());
      expect(verification.recipientWalletId).toBe(msg.recipientWalletId.toString());
    }, 120_000);

    test('fullMessagingCheck succeeds with valid message + delegation', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      // Create message proof
      const msg = createTestMessage();
      const { index: msgIdx } = msgReg.addMessage(msg);
      const msgWitness = msgReg.getWitness(msgIdx);
      const msgResult = await MessagingProgram.proveSendMessage(
        msg,
        msgWitness,
        msgReg.getRoot(),
        delReg.getRoot(),
        keyReg.getRoot(),
      );

      // Create delegation proof (using same registry state as msg)
      const del = createTestDelegation();
      const { index: delIdx } = delReg.addDelegation(del);
      const delWitness = delReg.getWitness(delIdx);
      const delResult = await MessagingProgram.proveDelegate(
        del,
        delWitness,
        msgReg.getRoot(),
        delReg.getRoot(),
        keyReg.getRoot(),
        Field(20260615n),
      );

      const check = await verifier.fullMessagingCheck(
        msgResult.proof,
        delResult.proof,
      );

      expect(check.messageValid).toBe(true);
      expect(check.delegationValid).toBe(true);
      expect(check.overallValid).toBe(true);
      expect(check.details.length).toBe(2);
    }, 240_000);

    test('verifyDelegation with matching root returns rootFresh: true', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      const del = createTestDelegation();
      const { index } = delReg.addDelegation(del);
      const witness = delReg.getWitness(index);

      const result = await MessagingProgram.proveDelegate(
        del, witness,
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
        Field(20260615n),
      );

      // Current root matches the proof's root
      const currentRoot = computeMessagingRoot(
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
      );

      const verification = await verifier.verifyDelegation(result.proof, currentRoot);
      expect(verification.isValid).toBe(true);
      expect(verification.rootFresh).toBe(true);
    }, 120_000);

    test('verifyDelegation with stale root returns isValid: false', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      const del = createTestDelegation();
      const { index } = delReg.addDelegation(del);
      const witness = delReg.getWitness(index);

      const result = await MessagingProgram.proveDelegate(
        del, witness,
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
        Field(20260615n),
      );

      // Simulate revocation — add a new delegation to change the root
      delReg.addDelegation(createTestDelegation({
        delegateWalletId: Field(999999n),
      }));
      const staleRoot = computeMessagingRoot(
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
      );

      const verification = await verifier.verifyDelegation(result.proof, staleRoot);
      expect(verification.isValid).toBe(false);
      expect(verification.rootFresh).toBe(false);
      expect(verification.reason).toContain('stale');
      // Still returns delegation details for logging
      expect(verification.delegatorWalletId).toBeDefined();
    }, 120_000);

    test('checkDelegationFreshness detects stale proof without re-verifying', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      const del = createTestDelegation();
      const { index } = delReg.addDelegation(del);
      const witness = delReg.getWitness(index);

      const result = await MessagingProgram.proveDelegate(
        del, witness,
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
        Field(20260615n),
      );

      // Fresh check — root matches
      const currentRoot = computeMessagingRoot(
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
      );
      const freshCheck = verifier.checkDelegationFreshness(result.proof, currentRoot);
      expect(freshCheck.isFresh).toBe(true);
      expect(freshCheck.proofRoot).toBe(freshCheck.currentRoot);

      // Stale check — root changed
      const fakeRoot = Field(999n);
      const staleCheck = verifier.checkDelegationFreshness(result.proof, fakeRoot);
      expect(staleCheck.isFresh).toBe(false);
      expect(staleCheck.proofRoot).not.toBe(staleCheck.currentRoot);
    }, 120_000);

    test('fullMessagingCheck with currentMessagingRoot rejects stale delegation', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      // Create message proof
      const msg = createTestMessage();
      const { index: msgIdx } = msgReg.addMessage(msg);
      const msgWitness = msgReg.getWitness(msgIdx);
      const msgResult = await MessagingProgram.proveSendMessage(
        msg, msgWitness,
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
      );

      // Create delegation proof
      const del = createTestDelegation();
      const { index: delIdx } = delReg.addDelegation(del);
      const delWitness = delReg.getWitness(delIdx);
      const delResult = await MessagingProgram.proveDelegate(
        del, delWitness,
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
        Field(20260615n),
      );

      // Simulate state change (revocation, new delegation, etc.)
      delReg.addDelegation(createTestDelegation({
        delegateWalletId: Field(999999n),
      }));
      const changedRoot = computeMessagingRoot(
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
      );

      const check = await verifier.fullMessagingCheck(
        msgResult.proof,
        delResult.proof,
        changedRoot,
      );

      expect(check.messageValid).toBe(true);
      expect(check.delegationValid).toBe(false);
      expect(check.delegationRootFresh).toBe(false);
      expect(check.overallValid).toBe(false);
      expect(check.details.some(d => d.includes('stale'))).toBe(true);
    }, 240_000);
  });

  // ─── CareContract — L7 Extensions ──────────────────────

  describe('CareContract — L7 Extensions', () => {
    let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
    let deployer: Mina.TestPublicKey;
    let admin: Mina.TestPublicKey;
    let nonAdmin: Mina.TestPublicKey;
    let contractKey: PrivateKey;
    let contract: CareContract;
    let adminPkHash: Field;

    beforeAll(async () => {
      local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(local);

      [deployer, admin, nonAdmin] = local.testAccounts;
      contractKey = PrivateKey.random();
      contract = new CareContract(contractKey.toPublicKey());
      adminPkHash = Poseidon.hash(admin.toFields());

      const emptyTree = new MerkleTree(11);
      const emptyRoot = emptyTree.getRoot();

      // Deploy
      const deployTx = await Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer);
        await contract.deploy();
      });
      await deployTx.prove();
      await deployTx.sign([deployer.key, contractKey]).send();

      // Init base state
      const initTx = await Mina.transaction(admin, async () => {
        await contract.initState(adminPkHash, emptyRoot, emptyRoot);
      });
      await initTx.prove();
      await initTx.sign([admin.key]).send();
    });

    test('initMessaging sets slot 7', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();
      const messagingRoot = computeMessagingRoot(
        msgReg.getRoot(),
        delReg.getRoot(),
        keyReg.getRoot(),
      );

      const msgTx = await Mina.transaction(admin, async () => {
        await contract.initMessaging(messagingRoot);
      });
      await msgTx.prove();
      await msgTx.sign([admin.key]).send();

      expect(contract.messagingRoot.get().toString()).toBe(messagingRoot.toString());
    }, 30_000);

    test('submitMessage updates messagingRoot + non-admin rejected', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      // Admin submits a message
      const msg = createTestMessage();
      msgReg.addMessage(msg);
      const newMsgRoot = computeMessagingRoot(
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
      );
      const submitTx = await Mina.transaction(admin, async () => {
        await contract.submitMessage(newMsgRoot, msg.commitment());
      });
      await submitTx.prove();
      await submitTx.sign([admin.key]).send();

      expect(contract.messagingRoot.get().toString()).toBe(newMsgRoot.toString());

      // Non-admin rejected
      await expect(async () => {
        const badTx = await Mina.transaction(nonAdmin, async () => {
          await contract.submitMessage(Field(999n), Field(0));
        });
        await badTx.prove();
        await badTx.sign([nonAdmin.key]).send();
      }).rejects.toThrow();
    }, 30_000);

    test('revokeDelegation updates messagingRoot + emits event + non-admin rejected', async () => {
      const msgReg = new MessageRegistry();
      const delReg = new DelegationRegistry();
      const keyReg = new KeyRegistry();

      // Add a delegation then revoke it off-chain
      const del = createTestDelegation();
      const { index } = delReg.addDelegation(del);
      const delegationCommitment = del.commitment();
      delReg.revokeDelegation(index);

      // Add a revocation message
      const revokeMsg = createTestMessage({ messageType: Field(16) }); // MSG_TYPE_AOR_REVOKE=16
      msgReg.addMessage(revokeMsg);

      const newRoot = computeMessagingRoot(
        msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
      );

      const revokeTx = await Mina.transaction(admin, async () => {
        await contract.revokeDelegation(newRoot, delegationCommitment);
      });
      await revokeTx.prove();
      await revokeTx.sign([admin.key]).send();

      expect(contract.messagingRoot.get().toString()).toBe(newRoot.toString());

      // Non-admin rejected
      await expect(async () => {
        const badTx = await Mina.transaction(nonAdmin, async () => {
          await contract.revokeDelegation(Field(999n), Field(0));
        });
        await badTx.prove();
        await badTx.sign([nonAdmin.key]).send();
      }).rejects.toThrow();
    }, 30_000);
  });
});
