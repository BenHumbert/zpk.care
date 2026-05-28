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
 * Provider Badge Types — NFC tap-to-login for prescribers and pharmacies.
 *
 * A ProviderBadge is a slim NFC payload that stores the provider's encrypted
 * credentials on an NTAG216 chip embedded in their ID badge. Tapping the badge
 * reads the payload, decrypts the enrollment key with an optional PIN, derives
 * the walletId, and authenticates against the sequencer's ProviderRegistry.
 *
 * Security model:
 *   - Something you HAVE: the physical badge (encrypted enrollment key on chip)
 *   - Something you KNOW: PIN to decrypt (optional, configurable by insurer policy)
 *   - The sequencer never sees the enrollment key — only the derived walletId (a hash)
 *
 * Badge is written once during credentialing (insurer writes after approval).
 * Reads happen daily (provider taps to start shift / authenticate).
 *
 * Total payload: ~200–350 bytes — well under NTAG216's 888-byte capacity.
 * Leaves room for an NfcCredentialAttestation (~500 bytes) alongside if desired.
 *
 * No o1js dependency — pure Node.js crypto.
 */

import type { ProviderType } from '../l2/provider-registry-types.js';

// ─── Badge Payload ─────────────────────────────────────────

/**
 * ProviderBadge — the NFC payload written to a provider's ID badge.
 *
 * All string fields are hex-encoded for compact NFC NDEF storage.
 */
export interface ProviderBadge {
  /** Format version */
  v: 1;
  /** Payload type discriminator */
  t: 'provider-badge';
  /** Provider type: 'prescriber' or 'pharmacy' */
  pt: ProviderType;
  /** Provider identifier (NPI 10-digit or NCPDP 7-digit) */
  pid: string;
  /** Provider ID qualifier (1=NPI for both prescriber and pharmacy) */
  pq: number;
  /** Pre-derived walletId (Poseidon hash decimal string) — for fast verification */
  w: string;
  /** scrypt salt (hex, 32 chars = 16 bytes) */
  salt: string;
  /** AES-GCM IV (hex, 24 chars = 12 bytes) */
  iv: string;
  /** Encrypted enrollment key (hex) — ciphertext + 16-byte GCM auth tag */
  ek: string;
  /** Display name (for badge UI, e.g., "Dr. Sarah Chen, MD") */
  dn: string;
  /** Sequencer URL (which network to connect to) */
  url?: string;
  /** Timestamp when badge was written (epoch ms) */
  ts: number;
}

// ─── Badge Auth Result ─────────────────────────────────────

/**
 * Result of a badge tap-to-login attempt.
 */
export interface BadgeAuthResult {
  /** Whether authentication succeeded */
  authenticated: boolean;
  /** The provider's walletId (if successful) */
  walletId?: string;
  /** Provider type */
  providerType?: ProviderType;
  /** Provider display name */
  displayName?: string;
  /** Provider NPI/NCPDP */
  providerId?: string;
  /** Credential state from ProviderRegistry (if online check performed) */
  credentialState?: string;
  /** Session token (Ed25519-signed, for subsequent RPC calls) */
  sessionToken?: string;
  /** Session expiry (epoch seconds) */
  sessionExpiry?: number;
  /** Error message (if failed) */
  error?: string;
  /** Time taken for the auth flow (ms) */
  elapsedMs?: number;
}

// ─── Auto-Tap Simulation ───────────────────────────────────

/**
 * Badge tap event emitted during auto-tap simulation.
 */
export interface BadgeTapEvent {
  /** Event type */
  type: 'badge:tap' | 'badge:decrypt' | 'badge:derive' | 'badge:proof' | 'badge:verify' | 'badge:session' | 'badge:error';
  /** Provider index (into PRESCRIBERS or PHARMACIES) */
  providerIndex: number;
  /** Provider type */
  providerType: ProviderType;
  /** Provider display name */
  displayName: string;
  /** Timestamp */
  timestamp: number;
  /** Elapsed ms for this step */
  elapsedMs?: number;
  /** Additional data (e.g., walletId, proof hash, session token) */
  data?: Record<string, unknown>;
  /** Error message if type is badge:error */
  error?: string;
}

// ─── NDEF Payload Extension ────────────────────────────────

/**
 * Extended NdefPayload union to include provider badge type.
 */
export type ProviderBadgeNdefPayload = {
  type: 'provider-badge';
  badge: ProviderBadge;
};

// ─── Type Guard ────────────────────────────────────────────

/** Check if an object is a ProviderBadge */
export function isProviderBadge(obj: unknown): obj is ProviderBadge {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return o.v === 1 && o.t === 'provider-badge' && typeof o.pid === 'string' && typeof o.ek === 'string';
}
