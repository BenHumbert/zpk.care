import { createHash, createCipheriv, createDecipheriv, diffieHellman } from 'crypto';
import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'crypto';
import { Field, Poseidon, Encoding } from 'o1js';

/**
 * Encryption utilities for the messaging system.
 *
 * Uses X25519 (ECDH) for key exchange and AES-256-GCM for message encryption.
 * All encryption happens off-circuit — ZK circuits verify message INTEGRITY
 * (commitments, Merkle tree inclusion), not encryption.
 *
 * Key derivation is DETERMINISTIC from the enrollment key:
 *   enrollmentKey → SHA-256 seed → X25519 key pair
 * This means: same enrollment key = same key pair = recoverable keys.
 */

// ─── Key Derivation ─────────────────────────────────────────

/**
 * Derive a deterministic X25519 key pair from an enrollment key.
 *
 * The enrollment key (user's 2FA secret) is hashed via SHA-256 to produce
 * a 32-byte seed, which is used as the X25519 private key material.
 * This is deterministic — same enrollment key always produces the same key pair.
 *
 * @param enrollmentKey — the user's enrollment key string
 * @returns { publicKey, privateKey } — raw key buffers for X25519
 */
export function deriveEncryptionKeyPair(enrollmentKey: string): {
  publicKey: Buffer;
  privateKey: Buffer;
} {
  // SHA-256 of enrollment key → 32-byte seed for X25519 private key
  const seed = createHash('sha256').update(enrollmentKey).digest();

  // X25519 requires the private key in PKCS8 DER format
  // Build the DER-encoded PKCS8 structure for X25519
  const pkcs8Prefix = Buffer.from([
    0x30, 0x2e, // SEQUENCE (46 bytes)
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x05, // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x6e, // OID 1.3.101.110 (X25519)
    0x04, 0x22, // OCTET STRING (34 bytes)
    0x04, 0x20, // OCTET STRING (32 bytes) — the raw key
  ]);
  const pkcs8Der = Buffer.concat([pkcs8Prefix, seed]);

  const privateKeyObj = createPrivateKey({
    key: pkcs8Der,
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyObj = createPublicKey(privateKeyObj);

  // Export raw key bytes (32 bytes each)
  const privateKey = Buffer.from(
    privateKeyObj.export({ type: 'pkcs8', format: 'der' }).subarray(pkcs8Prefix.length),
  );
  const publicKey = Buffer.from(
    publicKeyObj.export({ type: 'spki', format: 'der' }).subarray(12), // skip SPKI header
  );

  return { publicKey, privateKey: seed };
}

/**
 * Derive an ECDH shared secret from a sender's private key and recipient's public key.
 *
 * Uses X25519 key agreement. The shared secret is used as the AES-256-GCM key.
 *
 * @param senderPrivateKey — sender's 32-byte X25519 private key
 * @param recipientPublicKey — recipient's 32-byte X25519 public key
 * @returns 32-byte shared secret
 */
export function deriveSharedSecret(
  senderPrivateKey: Buffer,
  recipientPublicKey: Buffer,
): Buffer {
  // Build PKCS8 DER for sender's private key
  const pkcs8Prefix = Buffer.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
  ]);
  const senderKeyObj = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, senderPrivateKey]),
    format: 'der',
    type: 'pkcs8',
  });

  // Build SPKI DER for recipient's public key
  const spkiPrefix = Buffer.from([
    0x30, 0x2a, // SEQUENCE (42 bytes)
    0x30, 0x05, // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x6e, // OID 1.3.101.110 (X25519)
    0x03, 0x21, 0x00, // BIT STRING (33 bytes, 0 unused bits)
  ]);
  const recipientKeyObj = createPublicKey({
    key: Buffer.concat([spkiPrefix, recipientPublicKey]),
    format: 'der',
    type: 'spki',
  });

  return diffieHellman({
    privateKey: senderKeyObj,
    publicKey: recipientKeyObj,
  });
}

// ─── Message Encryption / Decryption ────────────────────────

/** Encrypted message payload */
export interface EncryptedPayload {
  /** AES-256-GCM ciphertext */
  ciphertext: Buffer;
  /** 12-byte initialization vector */
  iv: Buffer;
  /** 16-byte authentication tag */
  tag: Buffer;
}

/**
 * Encrypt a plaintext message using AES-256-GCM.
 *
 * @param plaintext — the message content to encrypt
 * @param sharedSecret — 32-byte ECDH shared secret (used as AES key)
 * @returns { ciphertext, iv, tag }
 */
export function encryptMessage(
  plaintext: string,
  sharedSecret: Buffer,
): EncryptedPayload {
  // Use first 32 bytes of shared secret as AES-256 key
  const key = sharedSecret.subarray(0, 32);
  // 12-byte random IV for GCM
  const iv = Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(12)),
  );

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return { ciphertext: encrypted, iv, tag };
}

/**
 * Decrypt an AES-256-GCM encrypted message.
 *
 * @param ciphertext — the encrypted bytes
 * @param iv — 12-byte initialization vector
 * @param tag — 16-byte authentication tag
 * @param sharedSecret — 32-byte ECDH shared secret (used as AES key)
 * @returns decrypted plaintext string
 */
export function decryptMessage(
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  sharedSecret: Buffer,
): string {
  const key = sharedSecret.subarray(0, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ─── Content Hash ───────────────────────────────────────────

/**
 * Compute a Poseidon hash of encrypted content for on-chain commitment.
 *
 * The hash covers both the ciphertext and IV to ensure integrity.
 * This hash is stored in MessageData.contentHash.
 *
 * @param ciphertext — encrypted message bytes
 * @param iv — 12-byte initialization vector
 * @returns Field — Poseidon hash for on-chain storage
 */
export function computeContentHash(ciphertext: Buffer, iv: Buffer): Field {
  // Convert ciphertext + iv to a combined string for hashing
  const combined = Buffer.concat([ciphertext, iv]).toString('hex');
  const fields = Encoding.stringToFields(combined);
  return Poseidon.hash(fields);
}

// ─── Public Key to Fields ───────────────────────────────────

/**
 * Convert a 32-byte X25519 public key to two o1js Fields.
 *
 * Splits the 32 bytes into two 16-byte halves, each fitting in a Field.
 * Used for storing encryption public keys in the on-chain key registry.
 *
 * @param publicKey — 32-byte X25519 public key buffer
 * @returns { pubKeyX, pubKeyY } — two Field values representing the key
 */
export function publicKeyToFields(publicKey: Buffer): {
  pubKeyX: Field;
  pubKeyY: Field;
} {
  const firstHalf = publicKey.subarray(0, 16);
  const secondHalf = publicKey.subarray(16, 32);
  return {
    pubKeyX: Field(BigInt('0x' + firstHalf.toString('hex'))),
    pubKeyY: Field(BigInt('0x' + secondHalf.toString('hex'))),
  };
}

/**
 * Convert two Field values back to a 32-byte X25519 public key.
 *
 * Inverse of publicKeyToFields.
 *
 * @param pubKeyX — first half of the public key as Field
 * @param pubKeyY — second half of the public key as Field
 * @returns 32-byte Buffer
 */
export function fieldsToPublicKey(pubKeyX: Field, pubKeyY: Field): Buffer {
  const xHex = pubKeyX.toBigInt().toString(16).padStart(32, '0');
  const yHex = pubKeyY.toBigInt().toString(16).padStart(32, '0');
  return Buffer.from(xHex + yHex, 'hex');
}
