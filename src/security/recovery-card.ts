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
 * v2 adds four opaque hash fields (~250 extra bytes):
 *   - tokenIdHash — insurer looks up consumed token → confirms identity
 *   - employeeIdHash — employer's internal employee ID hash
 *   - groupIdHash — employer group hash (plan lookup)
 *   - planIdHash — benefit plan hash (accumulator limit resolution)
 *
 * Total payload: ~450 bytes — well under NTAG216's 888 byte capacity.
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
  /** Hash of benefit plan ID (accumulator limit resolution during migration). May be absent on cards created before this field was added. */
  planIdHash?: string;
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
 * @param planIdHash — Poseidon hash of the benefit plan ID
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
  planIdHash: string,
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
      planIdHash,
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

// ─── Recovery card v3 — plan item A12b, risk PRD-1 ──────────────────────────────
//
// PRD-1, read exactly: a card must yield nothing to unlimited offline compute, so nothing on it
// depends on the PIN. The enrollment key is split with a one-time pad; the card carries one share
// and a random id, about ninety bytes, and the other share goes to the insurer in a deposit together
// with the identity salt, the group and plan hashes and a PIN verifier computed on the device. The
// insurer releases the deposit only to a caller presenting the matching verifier, attempt-limited
// per card. A found card reveals nothing: no wallet ID, no hash of anything, no ciphertext to test
// a PIN against. Two cards are issued at enrollment, each with its own id and shares, so one can be
// revoked without the other. The v2 format above remains for the migration service until C3.

export interface RecoveryCardV3 {
  v: 3;
  /** 8 random bytes, hex: the handle the insurer files the deposit under. Carries no meaning. */
  id: string;
  /** One share of the enrollment key's bytes, hex. Useless without the deposited share. */
  s: string;
}

/** What the device deposits with the insurer for one card; the device keeps none of it. */
export interface RecoveryDeposit {
  cardId: string;
  share2Hex: string;
  /** scrypt(recoveryPin, cardId), hex, computed on the device; the insurer never sees the PIN. */
  pinVerifier: string;
  identitySalt: string;
  groupIdHash: string;
  planIdHash: string;
  domainTag: number;
}

export const RECOVERY_CARD_ID_BYTES = 8;
export const RECOVERY_PIN_MIN_LENGTH = 6;
export const RECOVERY_PIN_MAX_LENGTH = 32;

export function isRecoveryCardV3(value: unknown): value is RecoveryCardV3 {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return c.v === 3
    && typeof c.id === 'string' && /^[0-9a-f]{16}$/i.test(c.id)
    && typeof c.s === 'string' && /^[0-9a-f]+$/i.test(c.s) && c.s.length % 2 === 0 && c.s.length >= 32;
}

export function validateRecoveryPin(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || pin.length < RECOVERY_PIN_MIN_LENGTH || pin.length > RECOVERY_PIN_MAX_LENGTH) {
    throw new Error(`The recovery PIN must be ${RECOVERY_PIN_MIN_LENGTH} to ${RECOVERY_PIN_MAX_LENGTH} characters`);
  }
}

/** Split the enrollment key for one card. Each call makes an independent pair. */
export function splitEnrollmentKey(enrollmentKey: string, rng: (n: number) => Buffer = randomBytes): { card: RecoveryCardV3; share2Hex: string } {
  const keyBytes = Buffer.from(enrollmentKey, 'utf8');
  if (keyBytes.length < 16) throw new Error('splitEnrollmentKey: the enrollment key is too short to be real');
  const share1 = rng(keyBytes.length);
  const share2 = Buffer.alloc(keyBytes.length);
  for (let i = 0; i < keyBytes.length; i++) share2[i] = keyBytes[i] ^ share1[i];
  return {
    card: { v: 3, id: rng(RECOVERY_CARD_ID_BYTES).toString('hex'), s: share1.toString('hex') },
    share2Hex: share2.toString('hex'),
  };
}

/** The enrollment key from a card and its released share. */
export function combineEnrollmentKey(card: RecoveryCardV3, share2Hex: string): string {
  const share1 = Buffer.from(card.s, 'hex');
  const share2 = Buffer.from(share2Hex, 'hex');
  if (share1.length !== share2.length || share1.length === 0) throw new Error('combineEnrollmentKey: the shares do not belong together');
  const key = Buffer.alloc(share1.length);
  for (let i = 0; i < share1.length; i++) key[i] = share1[i] ^ share2[i];
  return key.toString('utf8');
}

/** The verifier the insurer stores and the device presents: a slow hash of the PIN under the card id. */
export function recoveryPinVerifier(pin: string, cardId: string): string {
  validateRecoveryPin(pin);
  const derived = scryptSync(pin, Buffer.from('zpk.care/recovery-pin/v1\n' + cardId, 'utf8'), SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  try {
    return derived.toString('hex');
  } finally {
    derived.fill(0);
  }
}

/** Both cards and both deposits for one enrollment, in one call so they are issued together. */
export function issueRecoveryCards(opts: {
  enrollmentKey: string;
  recoveryPin: string;
  identitySalt: string;
  groupIdHash: string;
  planIdHash: string;
  domainTag: number;
  count?: number;
  rng?: (n: number) => Buffer;
}): { cards: RecoveryCardV3[]; deposits: RecoveryDeposit[] } {
  validateRecoveryPin(opts.recoveryPin);
  const cards: RecoveryCardV3[] = [];
  const deposits: RecoveryDeposit[] = [];
  for (let i = 0; i < (opts.count ?? 2); i++) {
    const { card, share2Hex } = splitEnrollmentKey(opts.enrollmentKey, opts.rng);
    cards.push(card);
    deposits.push({
      cardId: card.id,
      share2Hex,
      pinVerifier: recoveryPinVerifier(opts.recoveryPin, card.id),
      identitySalt: opts.identitySalt,
      groupIdHash: opts.groupIdHash,
      planIdHash: opts.planIdHash,
      domainTag: opts.domainTag,
    });
  }
  return { cards, deposits };
}

/** Bytes of a v3 card as written to a tag. */
export function recoveryCardBytes(card: RecoveryCardV3): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}
