import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Enrollment Backup — Encrypted NFC Key Export / Import
 *
 * Allows users to back up their enrollment key to a physical NFC chip
 * (or any offline storage) encrypted with a PIN. Multiple copies can
 * be created for redundancy (home safe, trusted family member, etc.).
 *
 * Security model:
 *   - Enrollment key encrypted with AES-256-GCM
 *   - Encryption key derived from PIN via scrypt (N=2^15, r=8, p=1)
 *   - Each backup includes a unique salt and IV
 *   - Physical possession + PIN required for decryption (two-factor)
 *
 * Recovery tiers:
 *   Tier 1 (self-service): Member taps NFC chip + enters PIN → original wallet
 *   Tier 2 (employer-assisted): Re-enrollment with new key → new wallet + migration
 */

// ─── Constants ──────────────────────────────────────────

/** Minimum PIN length */
export const MIN_PIN_LENGTH = 6;

/** Salt length in bytes */
const SALT_LENGTH = 16;

/** IV length for AES-256-GCM */
const IV_LENGTH = 12;

/** Auth tag length for AES-256-GCM */
const AUTH_TAG_LENGTH = 16;

/** scrypt parameters — N=2^15 is ~100ms on modern hardware */
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MiB — needed because N=2^15,r=8 uses 32 MiB (Node default limit)

// ─── Types ──────────────────────────────────────────────

/**
 * EnrollmentBackup — the encrypted payload stored on an NFC chip.
 *
 * All fields are hex-encoded strings for easy NFC NDEF record storage.
 * Total size: ~200 bytes — well within NFC tag capacity (NTAG216 = 888 bytes).
 */
export interface EnrollmentBackup {
  /** Format version for forward compatibility */
  version: 1;
  /** Wallet ID (not secret — it's a public hash on-chain) */
  walletId: string;
  /** Domain tag: 0=member, 1=prescriber, 2=pharmacy */
  domainTag: number;
  /** scrypt salt (hex) */
  salt: string;
  /** AES-GCM IV (hex) */
  iv: string;
  /** Encrypted enrollment key (hex) — ciphertext + auth tag */
  encryptedKey: string;
  /** Timestamp when backup was created */
  createdAt: number;
}

// ─── Export / Import ────────────────────────────────────

/**
 * Export an enrollment key as an encrypted backup.
 *
 * The enrollment key is encrypted with AES-256-GCM using a key derived
 * from the user's PIN via scrypt. The result can be written to an NFC chip.
 *
 * @param enrollmentKey — the secret to back up
 * @param pin — user-chosen PIN (minimum 6 characters)
 * @param walletId — the wallet ID (for identification, not secret)
 * @param domainTag — 0=member, 1=prescriber, 2=pharmacy
 * @returns EnrollmentBackup ready for NFC storage
 */
export function exportEnrollmentBackup(
  enrollmentKey: string,
  pin: string,
  walletId: string,
  domainTag: number,
): EnrollmentBackup {
  validatePin(pin);

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const derivedKey = scryptSync(pin, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(enrollmentKey, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    walletId,
    domainTag,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    encryptedKey: Buffer.concat([encrypted, authTag]).toString('hex'),
    createdAt: Date.now(),
  };
}

/**
 * Import an enrollment key from an encrypted backup.
 *
 * Decrypts the enrollment key using the user's PIN. Returns the
 * original enrollment key string if the PIN is correct.
 *
 * @param backup — the encrypted backup from NFC chip
 * @param pin — the PIN used during export
 * @returns The decrypted enrollment key
 * @throws If PIN is wrong or backup is corrupted
 */
export function importEnrollmentBackup(
  backup: EnrollmentBackup,
  pin: string,
): string {
  validatePin(pin);

  if (backup.version !== 1) {
    throw new Error(`Unsupported backup version: ${backup.version}`);
  }

  const salt = Buffer.from(backup.salt, 'hex');
  const iv = Buffer.from(backup.iv, 'hex');
  const encryptedWithTag = Buffer.from(backup.encryptedKey, 'hex');

  // Split ciphertext and auth tag
  const ciphertext = encryptedWithTag.subarray(0, encryptedWithTag.length - AUTH_TAG_LENGTH);
  const authTag = encryptedWithTag.subarray(encryptedWithTag.length - AUTH_TAG_LENGTH);

  const derivedKey = scryptSync(pin, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Decryption failed — wrong PIN or corrupted backup');
  }
}

// ─── Helpers ────────────────────────────────────────────

function validatePin(pin: string): void {
  if (!pin || pin.length < MIN_PIN_LENGTH) {
    throw new Error(
      `PIN must be at least ${MIN_PIN_LENGTH} characters (got ${pin?.length ?? 0})`,
    );
  }
}
