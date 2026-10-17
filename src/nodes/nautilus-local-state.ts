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

/**
 * NautilusLocalState — Encrypted local state persistence.
 *
 * Stores the entity node's critical local state encrypted at rest:
 *   - Enrollment key (the 256-bit secret that NEVER leaves the device)
 *   - Wallet ID (Poseidon hash — public, but stored for convenience)
 *   - Onboarding phase/progress
 *   - Preimage Fields (for proof generation without re-entering PHI)
 *
 * Security model:
 *   - State file encrypted with AES-256-GCM
 *   - Encryption key derived from device PIN via scrypt (N=2^15, r=8, p=1)
 *   - PIN is entered at startup, held in memory, never persisted
 *   - If device is stolen, attacker gets an encrypted blob
 *   - NFC backup (enrollment-backup.ts) serves as offline recovery tier
 *
 * File format: Single JSON file, AES-256-GCM encrypted.
 * Location: {stateDir}/nautilus-state.enc
 *
 * Zero external dependencies — uses Node.js crypto module.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { ObfuscatedKey } from '../security/obfuscated-key.js';

// ─── Constants (matching enrollment-backup.ts) ────────────────

const MIN_PIN_LENGTH = 6;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const STATE_FILENAME = 'nautilus-state.enc';
const STATE_VERSION = 1;

/*
 * ── PIN attempt limiting (phase A item A4, findings A-20 and MEM-M2) ──────────────────────
 *
 * A six-digit PIN is a million guesses. scrypt at N=2^15 costs about a tenth of a second, so an
 * unbounded attacker finishes the whole space in roughly a day. Nothing bounded the attempts
 * before this, so the only cost of guessing was time nobody was measuring.
 *
 * The counter has to live **outside** the encrypted state file, because that file is encrypted
 * under the very PIN being guessed; a counter inside it could not be read until the guess had
 * already succeeded. So it is a small plaintext sidecar, mode 0600, beside the state.
 *
 * **Backoff, never a wipe.** The obvious "wipe after N failures" would turn finding A-20 — a
 * device wipeable by an unauthenticated caller — from a bug into a feature reachable by anyone
 * who can send ten requests. Delay is the only safe lever here.
 *
 * Known limit, recorded rather than hidden: the delay is wall-clock, so moving the device clock
 * forward skips it. Whoever can set the clock already holds the device, which is not a threat
 * this mechanism can address; a monotonic counter would survive a clock change but not a file
 * delete, and the same holder can delete the file.
 */

/** Failures allowed before any delay applies. */
const PIN_FREE_ATTEMPTS = 3;
/** First delay, in milliseconds, applied on the failure after the free ones. */
const PIN_BACKOFF_BASE_MS = 2_000;
/** Ceiling on the delay, so a device is slowed rather than permanently bricked. */
const PIN_BACKOFF_MAX_MS = 15 * 60_000;
const PIN_ATTEMPTS_FILENAME = 'nautilus-pin-attempts.json';

/** The sidecar's contents. Plaintext on purpose; it holds no secret. */
interface PinAttemptRecord {
  /** Consecutive failures since the last success. */
  failures: number;
  /** When the most recent failure happened, ISO 8601. */
  lastFailureAt: string;
  /** No further attempt is accepted before this instant, ISO 8601. */
  lockedUntil: string;
}

/** Thrown when an attempt arrives inside the backoff window. */
export class PinAttemptThrottled extends Error {
  constructor(readonly retryAfterMs: number, readonly failures: number) {
    super(
      `Too many incorrect PIN attempts. Wait ${Math.ceil(retryAfterMs / 1000)} s before trying again.`,
    );
    this.name = 'PinAttemptThrottled';
  }
}

/** How long to refuse attempts after `failures` consecutive wrong PINs. */
function backoffForFailures(failures: number): number {
  if (failures <= PIN_FREE_ATTEMPTS) return 0;
  const steps = failures - PIN_FREE_ATTEMPTS - 1;
  return Math.min(PIN_BACKOFF_BASE_MS * 2 ** steps, PIN_BACKOFF_MAX_MS);
}

// ─── State Schema ─────────────────────────────────────────────

/** The plaintext state that gets encrypted */
export interface NautilusStateData {
  version: number;
  role: 'member' | 'prescriber' | 'pharmacy' | 'insurer' | 'employer';
  /** Wallet ID (Poseidon hash decimal string) */
  walletId?: string;
  /** Enrollment key (base64url, 43 chars) */
  enrollmentKey?: string;
  /** Preimage Field decimal strings (for proof generation) */
  preimageFields?: string[];
  /** Domain tag (0=member, 1=prescriber, 2=pharmacy) */
  domainTag?: number;
  /** Onboarding state */
  onboarding: {
    phase: string;
    tokenId?: string;
    tokenData?: {
      groupId: string;
      planId: string;
      validUntil: string;
    };
    enrollmentTimestamp?: number;
    compilationStatus?: { program: string; timeMs: number }[];
  };
  /** Sequencer URL this node last connected to */
  lastSequencerUrl?: string;
  /** ISO timestamp of last state save */
  lastSavedAt: string;
}

/** Encrypted state file envelope */
interface EncryptedStateFile {
  version: number;
  salt: string;
  iv: string;
  data: string;
}

// ─── NautilusLocalState ───────────────────────────────────────

/**
 * Encrypted local state manager for Nautilus Node Apps.
 *
 * Usage:
 *   const state = new NautilusLocalState('./nautilus-data');
 *   await state.unlock('123456');
 *   const data = await state.load();
 *   // ... modify data ...
 *   await state.save(data);
 *   state.lock(); // zeros derived key
 */
export class NautilusLocalState {
  private stateDir: string;
  private derivedKey: Buffer | null = null;
  private salt: Buffer | null = null;
  private state: NautilusStateData | null = null;
  private obfuscatedKey: ObfuscatedKey | null = null;
  /**
   * Whether a PIN has actually been *verified*, as opposed to merely having had a key derived
   * from it. `isUnlocked()` reports this. See `unlock()` for why the distinction matters.
   */
  private pinVerified = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /**
   * Unlock with a PIN, and **prove the PIN is right before reporting success**.
   *
   * This used to derive the scrypt key and return. Deriving a key always succeeds — it is a
   * key-derivation function, not a check — so `isUnlocked()` became true for any PIN at all,
   * including six characters of junk. That flag was the only gate on the route that deletes the
   * device state, which is how an unauthenticated caller could wipe a phone (A-20, MEM-H3).
   *
   * Now, when a state file exists, the derived key must actually decrypt it. If it does not, the
   * key is wiped, the attempt is counted against the backoff, and this throws. A wrong PIN
   * leaves the device exactly as locked as it was.
   *
   * When no state file exists there is nothing to verify against, so a first run is accepted.
   * That is not a hole: there is no secret on the device yet to protect.
   *
   * The PIN is consumed immediately — only the derived key is retained.
   *
   * @throws PinAttemptThrottled while inside the backoff window
   * @throws Error on a wrong PIN, a too-short PIN, or a corrupted state file
   */
  async unlock(pin: string): Promise<void> {
    if (!pin || pin.length < MIN_PIN_LENGTH) {
      throw new Error(
        `PIN must be at least ${MIN_PIN_LENGTH} characters`,
      );
    }

    await this.assertNotThrottled();

    // Load existing salt from file, or generate a new one
    const filePath = path.join(this.stateDir, STATE_FILENAME);
    let envelope: EncryptedStateFile | null = null;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      envelope = JSON.parse(raw) as EncryptedStateFile;
      this.salt = Buffer.from(envelope.salt, 'hex');
    } catch {
      envelope = null;
      this.salt = randomBytes(SALT_LENGTH);
    }

    const candidate = scryptSync(pin, this.salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }) as Buffer;

    if (envelope) {
      const verdict = this.tryDecrypt(envelope, candidate);
      if (verdict === 'wrong-pin') {
        candidate.fill(0);
        const record = await this.recordPinFailure();
        throw new Error(
          `Incorrect PIN. ${record.failures} consecutive failed attempt(s).`,
        );
      }
      if (verdict === 'corrupt') {
        // Not a wrong PIN, so it is not counted: the holder of a damaged file should not be
        // locked out of their own device by the damage.
        candidate.fill(0);
        throw new Error(
          'The state file could not be read. It is damaged or was written by another version.',
        );
      }
    }

    this.derivedKey = candidate;
    this.pinVerified = true;
    await this.clearPinFailures();
  }

  /**
   * Check a PIN without changing whether the state is unlocked.
   *
   * This is what a destructive action should ask for: proof that the person at the device knows
   * the PIN *now*, rather than that someone once called unlock. Rate-limited on the same counter
   * as `unlock`, so it cannot be used to sidestep the backoff.
   *
   * @throws PinAttemptThrottled while inside the backoff window
   */
  async verifyPin(pin: string): Promise<boolean> {
    if (!pin || pin.length < MIN_PIN_LENGTH) return false;
    await this.assertNotThrottled();

    const filePath = path.join(this.stateDir, STATE_FILENAME);
    let envelope: EncryptedStateFile;
    try {
      envelope = JSON.parse(await fs.readFile(filePath, 'utf-8')) as EncryptedStateFile;
    } catch {
      // No state file, so there is no PIN to check against and nothing to protect.
      return false;
    }

    const candidate = scryptSync(pin, Buffer.from(envelope.salt, 'hex'), SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }) as Buffer;

    const verdict = this.tryDecrypt(envelope, candidate);
    candidate.fill(0);

    if (verdict === 'ok') {
      await this.clearPinFailures();
      return true;
    }
    if (verdict === 'wrong-pin') {
      await this.recordPinFailure();
      return false;
    }
    return false; // corrupt — not the caller's fault, not counted
  }

  /**
   * Does `key` decrypt `envelope`? Distinguishes a wrong PIN from a damaged file, because only
   * the first should count against the attempt limit.
   */
  private tryDecrypt(
    envelope: EncryptedStateFile,
    key: Buffer,
  ): 'ok' | 'wrong-pin' | 'corrupt' {
    let iv: Buffer;
    let ciphertext: Buffer;
    let authTag: Buffer;
    try {
      iv = Buffer.from(envelope.iv, 'hex');
      const withTag = Buffer.from(envelope.data, 'hex');
      if (iv.length !== IV_LENGTH || withTag.length <= AUTH_TAG_LENGTH) return 'corrupt';
      ciphertext = withTag.subarray(0, withTag.length - AUTH_TAG_LENGTH);
      authTag = withTag.subarray(withTag.length - AUTH_TAG_LENGTH);
    } catch {
      return 'corrupt';
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      // The tag already proves the key; parsing proves the plaintext is state and not something
      // that merely authenticated.
      JSON.parse(plaintext.toString('utf-8'));
      return 'ok';
    } catch {
      // GCM authentication failed, which with a well-formed envelope means the key is wrong.
      return 'wrong-pin';
    }
  }

  // ─── PIN attempt limiting ─────────────────────────────────

  private pinAttemptsPath(): string {
    return path.join(this.stateDir, PIN_ATTEMPTS_FILENAME);
  }

  private async readPinAttempts(): Promise<PinAttemptRecord | null> {
    try {
      const raw = await fs.readFile(this.pinAttemptsPath(), 'utf-8');
      const rec = JSON.parse(raw) as PinAttemptRecord;
      if (typeof rec.failures !== 'number' || !Number.isFinite(rec.failures)) return null;
      return rec;
    } catch {
      return null;
    }
  }

  /** Refuse an attempt that arrives before the backoff has elapsed. */
  private async assertNotThrottled(): Promise<void> {
    const rec = await this.readPinAttempts();
    if (!rec) return;
    const remaining = Date.parse(rec.lockedUntil) - Date.now();
    if (Number.isFinite(remaining) && remaining > 0) {
      throw new PinAttemptThrottled(remaining, rec.failures);
    }
  }

  private async recordPinFailure(): Promise<PinAttemptRecord> {
    const previous = await this.readPinAttempts();
    const failures = (previous?.failures ?? 0) + 1;
    const now = Date.now();
    const record: PinAttemptRecord = {
      failures,
      lastFailureAt: new Date(now).toISOString(),
      lockedUntil: new Date(now + backoffForFailures(failures)).toISOString(),
    };
    try {
      await fs.mkdir(this.stateDir, { recursive: true });
      await fs.writeFile(this.pinAttemptsPath(), JSON.stringify(record), { mode: 0o600 });
    } catch {
      // A counter that cannot be written must not block a legitimate unlock; the attempt still
      // failed, and the caller is still told so.
    }
    return record;
  }

  private async clearPinFailures(): Promise<void> {
    try {
      await fs.unlink(this.pinAttemptsPath());
    } catch {
      /* nothing recorded */
    }
  }

  /** How long until another PIN attempt is accepted, and how many have failed. */
  async pinAttemptStatus(): Promise<{ failures: number; retryAfterMs: number }> {
    const rec = await this.readPinAttempts();
    if (!rec) return { failures: 0, retryAfterMs: 0 };
    const remaining = Date.parse(rec.lockedUntil) - Date.now();
    return {
      failures: rec.failures,
      retryAfterMs: Number.isFinite(remaining) && remaining > 0 ? remaining : 0,
    };
  }

  /** Lock the state — zeroes the derived key and obfuscated key from memory */
  lock(): void {
    if (this.derivedKey) {
      this.derivedKey.fill(0);
      this.derivedKey = null;
    }
    if (this.obfuscatedKey) {
      this.obfuscatedKey.destroy();
      this.obfuscatedKey = null;
    }
    this.state = null;
    this.pinVerified = false;
  }

  /**
   * Load state from disk.
   * Returns null if no state file exists.
   * Throws if PIN is wrong or file is corrupted.
   */
  async load(): Promise<NautilusStateData | null> {
    if (!this.derivedKey) {
      throw new Error('State is locked — call unlock() first');
    }

    const filePath = path.join(this.stateDir, STATE_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    const envelope = JSON.parse(raw) as EncryptedStateFile;
    const iv = Buffer.from(envelope.iv, 'hex');
    const encryptedWithTag = Buffer.from(envelope.data, 'hex');
    const ciphertext = encryptedWithTag.subarray(
      0,
      encryptedWithTag.length - AUTH_TAG_LENGTH,
    );
    const authTag = encryptedWithTag.subarray(
      encryptedWithTag.length - AUTH_TAG_LENGTH,
    );

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.derivedKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      this.state = JSON.parse(decrypted.toString('utf-8')) as NautilusStateData;

      // Wrap enrollment key in XOR-split obfuscation and clear the raw string
      if (this.state.enrollmentKey) {
        this.obfuscatedKey = ObfuscatedKey.wrap(this.state.enrollmentKey);
        this.state.enrollmentKey = undefined;
      }

      return this.state;
    } catch {
      throw new Error('Failed to decrypt state — wrong PIN or corrupted file');
    }
  }

  /** Save state to disk (encrypted). */
  async save(state: NautilusStateData): Promise<void> {
    if (!this.derivedKey || !this.salt) {
      throw new Error('State is locked — call unlock() first');
    }

    state.lastSavedAt = new Date().toISOString();

    // Temporarily inject the obfuscated enrollment key for serialization,
    // then immediately clear it from the state object.
    let plaintext: string;
    if (this.obfuscatedKey && !state.enrollmentKey) {
      plaintext = this.obfuscatedKey.use((key) => {
        state.enrollmentKey = key;
        const json = JSON.stringify(state);
        state.enrollmentKey = undefined;
        return json;
      });
    } else {
      plaintext = JSON.stringify(state);
      // If caller set enrollmentKey directly (e.g. during generate-key),
      // wrap it in obfuscation now
      if (state.enrollmentKey) {
        this.obfuscatedKey = ObfuscatedKey.wrap(state.enrollmentKey);
        state.enrollmentKey = undefined;
      }
    }

    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv('aes-256-gcm', this.derivedKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const envelope: EncryptedStateFile = {
      version: STATE_VERSION,
      salt: this.salt.toString('hex'),
      iv: iv.toString('hex'),
      data: Buffer.concat([encrypted, authTag]).toString('hex'),
    };

    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(
      path.join(this.stateDir, STATE_FILENAME),
      JSON.stringify(envelope),
    );
    this.state = state;
  }

  /** Check if a state file exists on disk */
  async exists(): Promise<boolean> {
    try {
      await fs.access(path.join(this.stateDir, STATE_FILENAME));
      return true;
    } catch {
      return false;
    }
  }

  /** Delete the state file (for full reset) */
  async destroy(): Promise<void> {
    try {
      await fs.unlink(path.join(this.stateDir, STATE_FILENAME));
    } catch {
      /* ignore — file may not exist */
    }
    // The attempt counter belongs to the state that was just removed. Leaving it behind would
    // carry a stale lockout into a fresh enrollment on the same device.
    await this.clearPinFailures();
    this.state = null;
    this.pinVerified = false;
  }

  /**
   * Execute a callback with the enrollment key temporarily reconstructed.
   * The key exists in memory only during the callback execution.
   *
   * @throws Error if no enrollment key is stored
   */
  useEnrollmentKey<T>(fn: (key: string) => T): T {
    if (!this.obfuscatedKey) {
      throw new Error('No enrollment key available');
    }
    return this.obfuscatedKey.use(fn);
  }

  /**
   * Set a new enrollment key (wraps it in XOR-split obfuscation immediately).
   * The caller should discard their reference to the key string after calling this.
   */
  setEnrollmentKey(key: string): void {
    if (this.obfuscatedKey) {
      this.obfuscatedKey.destroy();
    }
    this.obfuscatedKey = ObfuscatedKey.wrap(key);
  }

  /** Check if an enrollment key is available (obfuscated in memory) */
  hasEnrollmentKey(): boolean {
    return this.obfuscatedKey !== null && !this.obfuscatedKey.isDestroyed();
  }

  /** Get the in-memory state (null if not loaded) */
  getState(): NautilusStateData | null {
    return this.state;
  }

  /**
   * Whether a correct PIN has been presented.
   *
   * This used to be `derivedKey !== null`, which was true after any PIN, right or wrong, because
   * deriving a key cannot fail. Anything that treats this as proof of the owner's presence — the
   * eject route did — was therefore gated on nothing. It now means what its name says.
   */
  isUnlocked(): boolean {
    return this.pinVerified && this.derivedKey !== null;
  }

  /** Get the state directory path */
  getStateDir(): string {
    return this.stateDir;
  }
}
