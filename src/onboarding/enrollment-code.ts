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
 * Enrollment codes — phase A item A6, findings AUTH-13 and C-2 (FIG. 4 `456`).
 *
 * The enrollment code is the first secret in the whole system: an employee types it, with an
 * 8-digit PIN from a second channel, and a wallet comes into existence. Until this item the code
 * was `TOKEN-<ms clock>-<counter>`, which is a serial number, and nothing ever marked one used.
 *
 * What a code is now:
 *
 *   - **Random.** 80 bits from the OS pool, in Crockford base32 (no I, L, O or U, so what people
 *     type can be repaired rather than refused). Guessing is not a strategy at 2^80, and the
 *     oracle that checks a code is signed-insurer-only and rate-limited besides.
 *   - **Self-routing.** The first group is a prefix derived from the issuing employer's ID. The
 *     insurer uses it to ask the ONE employer that issued the code, instead of fanning the code
 *     and the member's PIN hash out to every tenant on the network — any of which could have
 *     brute-forced an 8-digit PIN offline from that hash and enrolled first. The prefix tells
 *     nobody anything they could not already read from the sequencer's tenant registry.
 *   - **Canonical.** `PPPP-XXXX-XXXX-XXXX-XXXX`, upper case, five groups. Everything that hashes a
 *     code (the HR Tool at PIN binding, the member node at enrollment) hashes this exact string,
 *     so the canonical form is computed once, where the code is typed.
 *
 * A code is single-use: the employer consumes it the moment its PIN verifies, which lives in
 * `TokenAuthority.redeemTokenWithPin`, not here. This module has no dependencies beyond
 * `node:crypto` so every side of the exchange can import it.
 */
import { createHash, randomBytes } from 'crypto';

/** Crockford's base32 alphabet: digits and letters without I, L, O and U. */
export const ENROLLMENT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Characters of the routing prefix, the first group. */
export const ROUTING_PREFIX_LENGTH = 4;
/** Random characters after the prefix: 16 × 5 bits = 80 bits. */
export const RANDOM_CHARS = 16;
/** Characters per dash-separated group. */
export const GROUP_LENGTH = 4;

const FLAT_LENGTH = ROUTING_PREFIX_LENGTH + RANDOM_CHARS;
const CANONICAL_RE = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
const ROUTING_DOMAIN = 'zpk.care/enrollment-code/routing/v1\n';

/** Base32 (Crockford, unpadded) over whole bytes, most significant bit first. */
function encodeBase32(bytes: Buffer): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    // Keep only the bits not yet emitted before shifting, so `acc` never exceeds 13 bits.
    acc = ((acc & ((1 << bits) - 1)) << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENROLLMENT_CODE_ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += ENROLLMENT_CODE_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function groupCode(flat: string): string {
  const groups: string[] = [];
  for (let i = 0; i < flat.length; i += GROUP_LENGTH) groups.push(flat.slice(i, i + GROUP_LENGTH));
  return groups.join('-');
}

/**
 * The routing prefix for an employer: the first four base32 characters of
 * SHA-256(domain ‖ employerId). Deterministic, so the insurer can compute it for every tenant in
 * the registry and match a presented code to its issuer without asking anyone.
 */
export function enrollmentCodeRoutingPrefix(employerId: string): string {
  if (typeof employerId !== 'string' || employerId.length === 0) {
    throw new Error('enrollmentCodeRoutingPrefix: employerId is required');
  }
  const digest = createHash('sha256').update(ROUTING_DOMAIN + employerId, 'utf8').digest();
  return encodeBase32(digest).slice(0, ROUTING_PREFIX_LENGTH);
}

/**
 * Generate a fresh code for an employer. 10 random bytes are exactly 16 base32 characters, so no
 * bit is wasted and no character is biased.
 */
export function generateEnrollmentCode(
  employerId: string,
  rng: (bytes: number) => Buffer = randomBytes,
): string {
  const prefix = enrollmentCodeRoutingPrefix(employerId);
  const random = encodeBase32(rng(10)).slice(0, RANDOM_CHARS);
  return groupCode(prefix + random);
}

/**
 * Repair what a person typed into the canonical form, or return `null` when it cannot be a code.
 *
 * Lower case becomes upper case; spaces, dashes and anything else that is not a letter or digit
 * are dropped; `O` is read as `0` and `I` and `L` as `1`, which is Crockford's decoding rule and
 * covers the confusions a phone keyboard produces. `U` is not in the alphabet and is not repaired.
 */
export function canonicalizeEnrollmentCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const flat = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (flat.length !== FLAT_LENGTH) return null;
  for (const ch of flat) if (!ENROLLMENT_CODE_ALPHABET.includes(ch)) return null;
  return groupCode(flat);
}

/** True when `s` is already in canonical form. */
export function isEnrollmentCode(s: string): boolean {
  return typeof s === 'string' && CANONICAL_RE.test(s);
}

/** The routing prefix carried by a canonical code, or `null` for anything else. */
export function routingPrefixOf(code: string): string | null {
  return isEnrollmentCode(code) ? code.slice(0, ROUTING_PREFIX_LENGTH) : null;
}

/**
 * What a node stores and hashes for whatever a caller presented as a token ID: the canonical code
 * when it is one, otherwise the trimmed string as given. Identifiers that are not codes still
 * exist (tests, the in-process service, migrations) and the authority decides whether they are
 * valid; this only makes sure a real code is never stored in two spellings.
 */
export function normalizeTokenId(input: string): string {
  return canonicalizeEnrollmentCode(input) ?? String(input ?? '').trim();
}
