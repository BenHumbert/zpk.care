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

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /**
   * Unlock with a PIN. Derives the encryption key via scrypt.
   * Must be called before load() or save().
   *
   * The PIN is consumed immediately — only the derived key is retained.
   */
  async unlock(pin: string): Promise<void> {
    if (!pin || pin.length < MIN_PIN_LENGTH) {
      throw new Error(
        `PIN must be at least ${MIN_PIN_LENGTH} characters`,
      );
    }

    // Load existing salt from file, or generate a new one
    const filePath = path.join(this.stateDir, STATE_FILENAME);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const envelope = JSON.parse(raw) as EncryptedStateFile;
      this.salt = Buffer.from(envelope.salt, 'hex');
    } catch {
      this.salt = randomBytes(SALT_LENGTH);
    }

    this.derivedKey = scryptSync(pin, this.salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }) as Buffer;
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
    this.state = null;
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

  /** Check if unlocked */
  isUnlocked(): boolean {
    return this.derivedKey !== null;
  }

  /** Get the state directory path */
  getStateDir(): string {
    return this.stateDir;
  }
}
