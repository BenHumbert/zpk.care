import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import type { EnrollmentBackup } from './enrollment-backup.js';
import { MIN_PIN_LENGTH } from './enrollment-backup.js';

/**
 * Recovery Card — Enhanced NFC Key Backup with Insurer Identification
 *
 * Extends the v1 EnrollmentBackup with employer/group metadata so the
 * insurer can identify the member during wallet migration. The card is
 * designed for cold storage (firebox, safe deposit box) — a Ledger-style
 * physical backup that bridges old wallet → new wallet.
 *
 * v2 adds three opaque hash fields (~200 extra bytes):
 *   - tokenIdHash — insurer looks up consumed token → confirms identity
 *   - employeeIdHash — employer's internal employee ID hash
 *   - groupIdHash — employer group hash (plan lookup)
 *
 * Total payload: ~400 bytes — well under NTAG216's 888 byte capacity.
 *
 * Recovery flow:
 *   1. Member scans NFC card + enters PIN → recovers old enrollment key
 *   2. Device derives oldWalletId from entity data + old enrollment key
 *   3. Device generates new enrollment key → new walletId
 *   4. WalletMigrationProgram proves identity continuity (ZK)
 *   5. Insurer verifies tokenIdHash → processes migration
 *   6. Sequencer reconstructs accumulator from claim history
 *   7. Old wallet revoked, new wallet registered with migrated accumulator
 */

// ─── Constants ──────────────────────────────────────────

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** NTAG216 NFC tag capacity in bytes */
export const NFC_CAPACITY_BYTES = 888;

// ─── Types ──────────────────────────────────────────────

/**
 * RecoveryCard — v2 NFC backup with insurer identification.
 *
 * All fields are hex-encoded strings or numbers for easy NFC NDEF storage.
 */
export interface RecoveryCard {
  /** Format version — always 2 for recovery cards */
  version: 2;
  /** Wallet ID (not secret — public hash on-chain) */
  walletId: string;
  /** Domain tag: 0=member, 1=prescriber, 2=pharmacy */
  domainTag: number;
  /** scrypt salt (hex) */
  salt: string;
  /** AES-GCM IV (hex) */
  iv: string;
  /** Encrypted enrollment key (hex) — ciphertext + auth tag */
  encryptedKey: string;
  /** Hash of original enrollment tokenId (insurer can look up consumed token) */
  tokenIdHash: string;
  /** Hash of employer's employee ID (insurer can cross-reference) */
  employeeIdHash: string;
  /** Hash of employer group ID (plan lookup) */
  groupIdHash: string;
  /** Timestamp when card was created */
  createdAt: number;
}

// ─── Type Guard ─────────────────────────────────────────

/**
 * Discriminate between v1 EnrollmentBackup and v2 RecoveryCard.
 */
export function isRecoveryCard(
  backup: EnrollmentBackup | RecoveryCard,
): backup is RecoveryCard {
  return backup.version === 2;
}

// ─── Export / Import ────────────────────────────────────

/**
 * Export a recovery card — encrypted enrollment key with insurer identification.
 *
 * Called once during the enrollment ceremony, after the insurer has processed
 * enrollment and the member has their walletId. The card is written to an NFC
 * chip and stored in a firebox or safe.
 *
 * @param enrollmentKey — the secret to back up
 * @param pin — user-chosen PIN (minimum 6 characters)
 * @param walletId — wallet ID (public hash, for identification)
 * @param domainTag — 0=member, 1=prescriber, 2=pharmacy
 * @param tokenIdHash — Poseidon hash of the enrollment tokenId
 * @param employeeIdHash — Poseidon hash of the employee ID
 * @param groupIdHash — Poseidon hash of the employer group ID
 * @returns RecoveryCard ready for NFC storage
 */
export function exportRecoveryCard(
  enrollmentKey: string,
  pin: string,
  walletId: string,
  domainTag: number,
  tokenIdHash: string,
  employeeIdHash: string,
  groupIdHash: string,
): RecoveryCard {
  validatePin(pin);

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const derivedKey = scryptSync(pin, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  try {
    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(enrollmentKey, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return {
      version: 2,
      walletId,
      domainTag,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      encryptedKey: Buffer.concat([encrypted, authTag]).toString('hex'),
      tokenIdHash,
      employeeIdHash,
      groupIdHash,
      createdAt: Date.now(),
    };
  } finally {
    derivedKey.fill(0);
  }
}

/**
 * Import (decrypt) an enrollment key from a v2 recovery card.
 *
 * @param card — the recovery card from NFC chip
 * @param pin — the PIN used during export
 * @returns The decrypted enrollment key
 * @throws If PIN is wrong or card is corrupted
 */
export function importRecoveryCard(card: RecoveryCard, pin: string): string {
  validatePin(pin);

  if (card.version !== 2) {
    throw new Error(`Expected recovery card version 2, got ${card.version}`);
  }

  const salt = Buffer.from(card.salt, 'hex');
  const iv = Buffer.from(card.iv, 'hex');
  const encryptedWithTag = Buffer.from(card.encryptedKey, 'hex');

  const ciphertext = encryptedWithTag.subarray(
    0,
    encryptedWithTag.length - AUTH_TAG_LENGTH,
  );
  const authTag = encryptedWithTag.subarray(
    encryptedWithTag.length - AUTH_TAG_LENGTH,
  );

  const derivedKey = scryptSync(pin, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  try {
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      throw new Error('Decryption failed — wrong PIN or corrupted recovery card');
    }
  } finally {
    derivedKey.fill(0);
  }
}

/**
 * Estimate the JSON-serialized size of a recovery card in bytes.
 *
 * Must be under 888 bytes to fit NTAG216 NFC tag.
 */
export function estimateRecoveryCardSize(card: RecoveryCard): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

// ─── Helpers ────────────────────────────────────────────

function validatePin(pin: string): void {
  if (!pin || pin.length < MIN_PIN_LENGTH) {
    throw new Error(
      `PIN must be at least ${MIN_PIN_LENGTH} characters (got ${pin?.length ?? 0})`,
    );
  }
}
