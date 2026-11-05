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
 * The keys a node derives from its ceremony-made master — A-136, A-142, A-143 and the key ceremony.
 *
 * A node holds one master secret, made at the key ceremony (owner, 2026-11-04). Everything it encrypts
 * or signs uses a key derived from that master for one purpose, by HKDF-SHA256 under a label naming the
 * purpose: one key per store and per employer, the PIN-check peppers, the insurer's signing seed. A key
 * for one purpose says nothing about another's, so the employer node given its own store key learns
 * nothing about the plan's, and the check value the ceremony record publishes says nothing about any.
 */
import { hkdfSync } from 'crypto';

const SALT = Buffer.from('zpk.care/subkey/v1', 'utf8');
const LABEL = /^[A-Za-z0-9._%/-]{1,200}$/;

/** One level of a label. Encoded, so an employer ID with a slash in it cannot reach another label. */
function part(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new Error('subkeys: a label part must be 1 to 100 characters');
  }
  return encodeURIComponent(value);
}

export const SUBKEYS = {
  /** Published in the ceremony record so a rebuilt master can be checked; never used as a key. */
  check: 'check',
  /** The insurer's Ed25519 attestation seed (A9): its public half is in the ceremony record. */
  insurerSigningSeed: 'insurer/signing-seed',
  /** The plan's key over the PIN hashes it keeps (A-143). */
  planPinPepper: 'plan/pin-pepper',
  /** One of the plan's sealed stores (A-142). */
  planStore: (name: string) => `plan/store/${part(name)}`,
  /** An employer tenant's sealed store, handed to that tenant only (A-136). */
  tenantStore: (employerId: string) => `tenant/${part(employerId)}/store`,
  /** An employer tenant's key over the PIN hashes it keeps (A-136). */
  tenantPinPepper: (employerId: string) => `tenant/${part(employerId)}/pin-pepper`,
} as const;

export function deriveSubkey(master: Uint8Array, label: string, length = 32): Buffer {
  if (!(master instanceof Uint8Array) || master.length !== 32) throw new Error('deriveSubkey: the master key must be 32 bytes');
  if (typeof label !== 'string' || !LABEL.test(label)) throw new Error('deriveSubkey: not a subkey label');
  if (!Number.isInteger(length) || length < 16 || length > 64) throw new Error('deriveSubkey: a subkey is 16 to 64 bytes');
  return Buffer.from(hkdfSync('sha256', master, SALT, Buffer.from(label, 'utf8'), length));
}

/**
 * The insurer's attestation signing seed, as the string `insurerSigningSeed` takes (deriveInsurerKeypair hashes it into
 * the Ed25519 key). Made from the master, it is the same after every restart, so the attestations it signed stay valid,
 * and no operator keeps it: until now it was random at each boot unless ZKTRIDENT_INSURER_SIGNING_SEED was set.
 */
export function insurerSigningSeedFrom(master: Uint8Array): string {
  return deriveSubkey(master, SUBKEYS.insurerSigningSeed).toString('base64url');
}

/** The check value the ceremony record carries for a master: rebuilt shares must reproduce it. */
export function masterCheckHex(master: Uint8Array): string {
  return deriveSubkey(master, SUBKEYS.check).toString('hex');
}
