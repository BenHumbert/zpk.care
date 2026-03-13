/**
 * Provider Badge Service — Write, read, and authenticate provider NFC badges.
 *
 * Handles the full badge lifecycle:
 *   1. WRITE: Insurer writes badge during credentialing approval
 *   2. READ:  Provider taps badge → decrypt enrollment key → derive walletId
 *   3. AUTH:  Verify walletId against ProviderRegistry → issue session
 *
 * Also provides the auto-tap simulation that generates real ZK ProofGate
 * proofs for each demo provider, demonstrating the full authentication flow.
 *
 * Encryption: AES-256-GCM with scrypt KDF (same parameters as RecoveryCard).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import type { ProviderBadge, BadgeAuthResult, BadgeTapEvent } from './provider-badge-types.js';
import type { ProviderType } from '../l2/provider-registry-types.js';
import {
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
} from '../wallets/wallet-derivation.js';
import type { PrescriberLocalData } from '../models/prescriber.js';
import type { PharmacyLocalData } from '../models/pharmacy.js';

// ─── Encryption Constants (same as RecoveryCard) ───────────

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Default PIN for demo badges — NEVER use in production */
export const DEMO_BADGE_PIN = '000000';

/**
 * Validate PIN strength for badge creation.
 *
 * In production mode (NODE_ENV=production), enforces:
 *   - Minimum 8 characters
 *   - At least one letter and one digit (not all-same-char)
 *
 * In demo/dev mode, allows any PIN >= 6 characters (including DEMO_BADGE_PIN).
 */
export function validateBadgePin(pin: string): void {
  if (!pin || pin.length < 6) {
    throw new Error('PIN must be at least 6 characters');
  }
  if (process.env.NODE_ENV === 'production') {
    if (pin.length < 8) {
      throw new Error('Production PIN must be at least 8 characters');
    }
    const hasLetter = /[a-zA-Z]/.test(pin);
    const hasDigit = /[0-9]/.test(pin);
    if (!hasLetter || !hasDigit) {
      throw new Error('Production PIN must contain both letters and digits');
    }
    if (pin === DEMO_BADGE_PIN) {
      throw new Error('Demo PIN cannot be used in production');
    }
  }
}

// ─── Badge Write ───────────────────────────────────────────

/**
 * Create a ProviderBadge payload ready for NFC write.
 *
 * Called by the insurer during credentialing approval. The enrollment key
 * is encrypted with the provider's chosen PIN (or demo PIN for simulation).
 *
 * @param enrollmentKey — the provider's secret enrollment key
 * @param pin — PIN to encrypt with (minimum 6 characters)
 * @param providerType — 'prescriber' or 'pharmacy'
 * @param providerId — NPI (10-digit) or NCPDP (7-digit)
 * @param providerIdQualifier — qualifier code (1=NPI)
 * @param walletId — pre-derived walletId (Poseidon hash decimal string)
 * @param displayName — human-readable name for badge display
 * @param sequencerUrl — optional URL of the sequencer to connect to
 */
export function createProviderBadge(
  enrollmentKey: string,
  pin: string,
  providerType: ProviderType,
  providerId: string,
  providerIdQualifier: number,
  walletId: string,
  displayName: string,
  sequencerUrl?: string,
): ProviderBadge {
  validateBadgePin(pin);

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

    const badge: ProviderBadge = {
      v: 1,
      t: 'provider-badge',
      pt: providerType,
      pid: providerId,
      pq: providerIdQualifier,
      w: walletId,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      ek: Buffer.concat([encrypted, authTag]).toString('hex'),
      dn: displayName,
      ts: Date.now(),
    };

    if (sequencerUrl) {
      badge.url = sequencerUrl;
    }

    return badge;
  } finally {
    derivedKey.fill(0);
  }
}

// ─── Badge Read (Decrypt) ──────────────────────────────────

/**
 * Decrypt a ProviderBadge to recover the enrollment key.
 *
 * @param badge — the badge payload read from NFC
 * @param pin — the PIN used during badge creation
 * @returns The decrypted enrollment key
 * @throws If PIN is wrong or badge is corrupted
 */
export function decryptBadge(badge: ProviderBadge, pin: string): string {
  if (!pin || pin.length < 6) {
    throw new Error('Invalid PIN');
  }
  if (badge.v !== 1 || badge.t !== 'provider-badge') {
    throw new Error('Not a valid provider badge');
  }

  const salt = Buffer.from(badge.salt, 'hex');
  const iv = Buffer.from(badge.iv, 'hex');
  const encryptedWithTag = Buffer.from(badge.ek, 'hex');

  const ciphertext = encryptedWithTag.subarray(0, encryptedWithTag.length - AUTH_TAG_LENGTH);
  const authTag = encryptedWithTag.subarray(encryptedWithTag.length - AUTH_TAG_LENGTH);

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
      throw new Error('Badge decryption failed — wrong PIN or corrupted badge');
    }
  } finally {
    derivedKey.fill(0);
  }
}

// ─── Badge Auth Flow ───────────────────────────────────────

/**
 * Full badge authentication flow: decrypt → derive walletId → verify match.
 *
 * This is the local-only portion. The caller can then check the walletId
 * against the ProviderRegistry (via RPC) and optionally generate a ProofGate proof.
 *
 * @param badge — the badge payload from NFC
 * @param pin — the PIN to decrypt
 * @returns BadgeAuthResult with walletId if successful
 */
export function authenticateFromBadge(badge: ProviderBadge, pin: string): BadgeAuthResult {
  const start = Date.now();

  try {
    // Step 1: Decrypt enrollment key
    const enrollmentKey = decryptBadge(badge, pin);

    // Step 2: Derive walletId from provider credentials + enrollment key
    let derivedWalletId: string;

    if (badge.pt === 'prescriber') {
      const localData: PrescriberLocalData = {
        prescriberIdQualifier: badge.pq,
        prescriberId: badge.pid,
      };
      derivedWalletId = derivePrescriberWalletId(localData, enrollmentKey).toString();
    } else {
      const localData: PharmacyLocalData = {
        serviceProviderIdQualifier: badge.pq,
        serviceProviderId: badge.pid,
      };
      derivedWalletId = derivePharmacyWalletId(localData, enrollmentKey).toString();
    }

    // Step 3: Verify derived walletId matches badge walletId
    if (derivedWalletId !== badge.w) {
      return {
        authenticated: false,
        error: 'Wallet ID mismatch — badge may be corrupted or tampered with',
        elapsedMs: Date.now() - start,
      };
    }

    return {
      authenticated: true,
      walletId: derivedWalletId,
      providerType: badge.pt,
      displayName: badge.dn,
      providerId: badge.pid,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    return {
      authenticated: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - start,
    };
  }
}

// ─── Badge Preimage Helpers ────────────────────────────────

/**
 * Get the ProofGate preimage fields for a badge's provider.
 * Used to generate the ZK proof that the badge holder knows the wallet preimage.
 */
export function badgePreimage(badge: ProviderBadge, enrollmentKey: string) {
  if (badge.pt === 'prescriber') {
    const localData: PrescriberLocalData = {
      prescriberIdQualifier: badge.pq,
      prescriberId: badge.pid,
    };
    return {
      preimage: prescriberWalletPreimage(localData, enrollmentKey),
      method: 'verifyPrescriber' as const,
    };
  } else {
    const localData: PharmacyLocalData = {
      serviceProviderIdQualifier: badge.pq,
      serviceProviderId: badge.pid,
    };
    return {
      preimage: pharmacyWalletPreimage(localData, enrollmentKey),
      method: 'verifyPharmacy' as const,
    };
  }
}

// ─── Badge Size Estimation ─────────────────────────────────

/** Estimate serialized badge size in bytes (must fit NTAG216's 888 bytes) */
export function estimateBadgeSize(badge: ProviderBadge): number {
  return Buffer.byteLength(JSON.stringify(badge), 'utf8');
}
