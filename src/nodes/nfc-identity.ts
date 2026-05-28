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
 * NFC Identity — NDEF payload formatting for member identification.
 *
 * Generates NDEF-ready payloads that mobile apps (Android/iOS) can write
 * to physical NFC tags or emulate via Host Card Emulation (HCE).
 *
 * At a pharmacy, the flow is:
 *   1. Member taps phone or NFC card/wristband on pharmacy reader
 *   2. Pharmacy reads the walletId from the NDEF payload
 *   3. Pharmacy POS calls DUR endpoints with the walletId
 *   4. Cross-pharmacy drug history is returned for interaction screening
 *
 * The walletId is already public (it's on-chain as a Poseidon hash).
 * Sharing it reveals zero PHI. It's analogous to showing an insurance
 * card with an opaque member number.
 *
 * NDEF format:
 *   - Type: NFC Forum External Type (TNF=0x04)
 *   - Domain: zktrident.care
 *   - Type name: member-id
 *   - Payload: JSON { v, t, w, ts }
 *
 * Tag compatibility:
 *   - NTAG213: 144 bytes — sufficient (payload ~120 bytes)
 *   - NTAG215: 504 bytes — comfortable
 *   - NTAG216: 888 bytes — plenty
 *
 * Mobile platform APIs:
 *   - Android: android.nfc.NdefMessage + HostApduService (HCE)
 *   - iOS: CoreNFC NFCNDEFMessage + NFCNDEFReaderSession
 */

/** Version of the NFC identity payload format */
const NFC_IDENTITY_VERSION = 1;

/** NDEF External Type domain */
export const NDEF_DOMAIN = 'zktrident.care';

/** NDEF External Type name for member identification */
export const NDEF_TYPE_MEMBER_ID = 'member-id';

// ─── Payload Types ───────────────────────────────────────────

/**
 * NFC identity payload — the JSON structure written to/emulated on NFC.
 *
 * Compact field names to minimize NFC tag storage:
 *   v = version, t = type, w = walletId, ts = timestamp
 */
export interface NfcIdentityPayload {
  /** Format version */
  v: number;
  /** Payload type */
  t: 'member-id';
  /** Wallet ID (Poseidon hash decimal string) */
  w: string;
  /** Timestamp (Unix seconds) — when the payload was generated */
  ts: number;
}

/**
 * Full NFC identity record — includes NDEF metadata for the mobile app.
 *
 * The mobile app uses this to construct the platform-specific NDEF record:
 *   Android: new NdefRecord(NdefRecord.TNF_EXTERNAL_TYPE, type, null, payloadBytes)
 *   iOS: NFCNDEFPayload(format: .nfcExternal, type: type, identifier: Data(), payload: payloadData)
 */
export interface NfcIdentityRecord {
  /** NDEF Type Name Format (4 = External Type) */
  tnf: 4;
  /** NDEF External Type: "zktrident.care:member-id" */
  type: string;
  /** Structured payload (for mobile app consumption) */
  payload: NfcIdentityPayload;
  /** Raw JSON string of the payload (ready for NFC tag writing) */
  payloadJson: string;
  /** Estimated size in bytes (for tag capacity check) */
  sizeBytes: number;
  /** Base64-encoded payload (for QR code fallback) */
  payloadBase64: string;
}

// ─── Build / Parse ───────────────────────────────────────────

/**
 * Build an NFC identity record for a member wallet.
 *
 * @param walletId — the member's walletId (Poseidon hash decimal string)
 * @returns NFC identity record ready for mobile app consumption
 */
export function buildNfcIdentityRecord(walletId: string): NfcIdentityRecord {
  if (!isValidWalletId(walletId)) {
    throw new Error('Invalid wallet ID');
  }

  const payload: NfcIdentityPayload = {
    v: NFC_IDENTITY_VERSION,
    t: 'member-id',
    w: walletId,
    ts: Math.floor(Date.now() / 1000),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson, 'utf8').toString('base64url');

  return {
    tnf: 4,
    type: `${NDEF_DOMAIN}:${NDEF_TYPE_MEMBER_ID}`,
    payload,
    payloadJson,
    sizeBytes: Buffer.byteLength(payloadJson, 'utf8'),
    payloadBase64,
  };
}

/**
 * Parse an NFC identity payload from a scanned NFC tag.
 * Accepts either a raw JSON string or a pre-parsed object.
 *
 * @returns The walletId if the payload is valid, null otherwise
 */
export function parseNfcIdentityPayload(
  raw: string | Record<string, unknown>,
): string | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (parsed.v !== NFC_IDENTITY_VERSION) return null;
    if (parsed.t !== 'member-id') return null;
    if (typeof parsed.w !== 'string' || parsed.w.length === 0) return null;
    if (typeof parsed.ts !== 'number') return null;

    // Validate the walletId format
    if (!isValidWalletId(parsed.w)) return null;

    return parsed.w;
  } catch {
    return null;
  }
}

/**
 * Parse an NFC identity payload from a base64url-encoded string.
 * Used for QR code fallback where the payload is base64url-encoded.
 */
export function parseNfcIdentityBase64(encoded: string): string | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    return parseNfcIdentityPayload(json);
  } catch {
    return null;
  }
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate that a string looks like a valid Poseidon hash wallet ID.
 *
 * Poseidon hashes in o1js are decimal representations of ~254-bit field elements.
 * Valid range: 1 to 28948022309329048855892746252171976963317496166410141009864396001978282409983
 * Max length: 77 decimal digits.
 */
export function isValidWalletId(walletId: string): boolean {
  if (!walletId || walletId.length === 0 || walletId.length > 78) return false;
  if (!/^\d+$/.test(walletId)) return false;
  if (walletId === '0') return false;
  // Leading zeros not allowed (canonical form)
  if (walletId.length > 1 && walletId[0] === '0') return false;
  return true;
}

// ─── Tag Compatibility ───────────────────────────────────────

/** Known NFC tag types and their user memory capacity */
export const NFC_TAG_CAPACITY = {
  NTAG213: 144,
  NTAG215: 504,
  NTAG216: 888,
  MIFARE_CLASSIC_1K: 716,
} as const;

/**
 * Check if a payload fits on a specific NFC tag type.
 *
 * NDEF overhead is ~10 bytes (header + type length + payload length).
 * The NDEF type string "zktrident.care:member-id" is 24 bytes.
 * Total overhead: ~34 bytes.
 */
export function fitsOnTag(
  record: NfcIdentityRecord,
  tagType: keyof typeof NFC_TAG_CAPACITY,
): boolean {
  const overhead = 34; // NDEF header + type string
  return record.sizeBytes + overhead <= NFC_TAG_CAPACITY[tagType];
}
