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
 * NFC Credential Attestation — Sequencer-Signed Compact Credential.
 *
 * After the sequencer verifies a ZK proof during credential generation,
 * it signs the credential's public output fields with Ed25519. The NFC tag
 * carries this compact signed receipt (~500 bytes, fits NTAG216's 888-byte limit).
 *
 * The pharmacy verifies the Ed25519 signature instantly (< 1ms) without
 * needing the full Pickles ZK proof or an online connection.
 *
 * Security model:
 *   - Nothing on the NFC tag is secret (passive tags have no access control)
 *   - Security comes from Ed25519 signature integrity, not confidentiality
 *   - Time-limited via expiresAt (default 24h)
 *   - Revocable via nonce (sequencer maintains revocation set)
 *   - Nonce is a revocation handle, NOT an authentication factor
 *
 * No o1js dependency — pure Node.js crypto module.
 */

import {
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
  createPrivateKey,
  createPublicKey,
  createHash,
  type KeyObject,
} from 'crypto';

// ─── Types ──────────────────────────────────────────────────

/**
 * NFC Credential Attestation — the payload written to the NFC tag.
 *
 * ~500 bytes JSON, fits comfortably in NTAG216's 888-byte user memory.
 */
export interface NfcCredentialAttestation {
  /** Format version (2 = attestation; 1 = legacy member-id) */
  v: 2;
  /** Payload type discriminator */
  t: 'credential-attestation';
  /** Wallet ID (Poseidon hash decimal string) */
  w: string;
  /** Credential commitment (Poseidon hash decimal string) */
  cc: string;
  /** Lifecycle state (3 = ACTIVE) */
  ls: number;
  /** Forest root (Poseidon hash decimal string) */
  fr: string;
  /** Issued at (Unix seconds) */
  ts: number;
  /** Expires at (Unix seconds) */
  exp: number;
  /** Revocation nonce (32 hex chars = 16 random bytes) */
  n: string;
  /** Sequencer Ed25519 public key (64 hex chars = 32 bytes) */
  pk: string;
  /** Ed25519 signature over canonical message (128 hex chars = 64 bytes) */
  sig: string;
}

/** Result of attestation verification */
export interface AttestationVerifyResult {
  /** Whether the Ed25519 signature is valid */
  valid: boolean;
  /** Whether the attestation has expired */
  expired: boolean;
  /** Human-readable reason if invalid */
  reason?: string;
}

// ─── Canonical Message ──────────────────────────────────────

/**
 * Build the canonical message string that is signed/verified.
 * Pipe-delimited, deterministic, no JSON ambiguity.
 *
 * Format: "zkpcare-attestation-v2|{w}|{cc}|{ls}|{fr}|{ts}|{exp}|{n}"
 */
export function buildAttestationMessage(att: {
  w: string;
  cc: string;
  ls: number;
  fr: string;
  ts: number;
  exp: number;
  n: string;
}): Buffer {
  const msg = `zkpcare-attestation-v2|${att.w}|${att.cc}|${att.ls}|${att.fr}|${att.ts}|${att.exp}|${att.n}`;
  return Buffer.from(msg, 'utf8');
}

// ─── Type Guard ─────────────────────────────────────────────

/** Check if an object is an NfcCredentialAttestation */
export function isAttestation(obj: unknown): obj is NfcCredentialAttestation {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return o.v === 2 && o.t === 'credential-attestation' && typeof o.w === 'string' && typeof o.sig === 'string';
}

// ─── Ed25519 DER Helpers ────────────────────────────────────

// Ed25519 OID: 1.3.101.112 → 06 03 2b 65 70

/** PKCS8 DER prefix for Ed25519 private key (32-byte seed follows) */
const ED25519_PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e,       // SEQUENCE (46 bytes)
  0x02, 0x01, 0x00, // INTEGER 0 (version)
  0x30, 0x05,       // SEQUENCE (5 bytes)
  0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
  0x04, 0x22,       // OCTET STRING (34 bytes)
  0x04, 0x20,       // OCTET STRING (32 bytes) — the raw seed
]);

/** Build an Ed25519 KeyObject from a 32-byte seed */
function ed25519PrivateKeyFromSeed(seed: Buffer): KeyObject {
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
}

/** Extract raw 32-byte public key from an Ed25519 KeyObject */
function extractRawPublicKey(publicKey: KeyObject): Buffer {
  // SPKI DER for Ed25519 is: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(spkiDer.subarray(12)); // skip 12-byte SPKI header
}

/** Build an Ed25519 public KeyObject from raw 32 bytes */
function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  const spkiPrefix = Buffer.from([
    0x30, 0x2a,       // SEQUENCE (42 bytes)
    0x30, 0x05,       // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
    0x03, 0x21, 0x00, // BIT STRING (33 bytes, 0 unused bits)
  ]);
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, raw]),
    format: 'der',
    type: 'spki',
  });
}

// ─── SequencerAttestationAuthority ──────────────────────────

/**
 * Sequencer's Ed25519 signing authority for NFC credential attestations.
 *
 * Generates a keypair at construction (random or deterministic from seed).
 * Signs attestations after ZK proof verification.
 * Maintains an in-memory revocation set for nonces.
 */
export class SequencerAttestationAuthority {
  private _privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** Raw 32-byte public key as hex string (64 chars) */
  readonly publicKeyHex: string;

  private revokedNonces: Set<string> = new Set();

  /**
   * @param seed — optional 32-byte seed for deterministic key derivation.
   *               If omitted, generates a random keypair.
   */
  constructor(seed?: Buffer) {
    if (seed) {
      // Deterministic: SHA-256 of seed → Ed25519 private key
      const derivedSeed = createHash('sha256').update(seed).digest();
      this._privateKey = ed25519PrivateKeyFromSeed(derivedSeed);
      this.publicKey = createPublicKey(this._privateKey);
      derivedSeed.fill(0); // scrub
    } else {
      // Random keypair
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      this._privateKey = privateKey;
      this.publicKey = publicKey;
    }

    this.publicKeyHex = extractRawPublicKey(this.publicKey).toString('hex');
  }

  /**
   * Create a signed attestation for an NFC tag.
   *
   * Called after the sequencer has verified the member's ZK credential proof.
   */
  createAttestation(params: {
    walletId: string;
    credentialCommitment: string;
    lifecycleState: number;
    forestRoot: string;
    expirySeconds?: number;
  }): NfcCredentialAttestation {
    const now = Math.floor(Date.now() / 1000);
    const expirySeconds = params.expirySeconds ?? 86400; // default 24h
    const nonce = randomBytes(16).toString('hex');

    const att: Omit<NfcCredentialAttestation, 'sig'> = {
      v: 2,
      t: 'credential-attestation',
      w: params.walletId,
      cc: params.credentialCommitment,
      ls: params.lifecycleState,
      fr: params.forestRoot,
      ts: now,
      exp: now + expirySeconds,
      n: nonce,
      pk: this.publicKeyHex,
    };

    // Sign the canonical message
    const message = buildAttestationMessage(att);
    const signature = sign(null, message, this._privateKey);

    return {
      ...att,
      sig: signature.toString('hex'),
    };
  }

  /**
   * Verify an attestation's Ed25519 signature and expiry.
   *
   * This is a static-compatible method — verification only needs the
   * public key embedded in the attestation. The pharmacy doesn't need
   * access to the sequencer's private key or even this class instance.
   */
  static verifyAttestation(att: NfcCredentialAttestation): AttestationVerifyResult {
    // Check required fields
    if (!isAttestation(att)) {
      return { valid: false, expired: false, reason: 'Not a valid attestation object' };
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    const expired = att.exp > 0 && now > att.exp;

    // Verify Ed25519 signature using the embedded public key
    try {
      const publicKeyRaw = Buffer.from(att.pk, 'hex');
      if (publicKeyRaw.length !== 32) {
        return { valid: false, expired, reason: 'Invalid public key length' };
      }

      const signatureBytes = Buffer.from(att.sig, 'hex');
      if (signatureBytes.length !== 64) {
        return { valid: false, expired, reason: 'Invalid signature length' };
      }

      const publicKey = ed25519PublicKeyFromRaw(publicKeyRaw);
      const message = buildAttestationMessage(att);
      const valid = verify(null, message, publicKey, signatureBytes);

      if (!valid) {
        return { valid: false, expired, reason: 'Ed25519 signature verification failed' };
      }

      if (expired) {
        return { valid: false, expired: true, reason: 'Attestation has expired' };
      }

      return { valid: true, expired: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, expired, reason: `Verification error: ${msg}` };
    }
  }

  /** Add a nonce to the revocation set */
  revokeNonce(nonce: string): void {
    this.revokedNonces.add(nonce);
  }

  /** Check if a nonce has been revoked */
  isRevoked(nonce: string): boolean {
    return this.revokedNonces.has(nonce);
  }
}
