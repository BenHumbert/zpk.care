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
 * A provider node registers its entity on the sequencer — plan item A10b, finding A-30.
 *
 * Both public keys travel with the registration: the X25519 encryption key an eScript is encrypted
 * to, and the Ed25519 signing key the node signs wallet-scoped calls with. Before this, the member
 * registered its key at enrollment, the prescriber registered its own only inside the badge-tap
 * handler (through a `require` in an ES module that produced no key), and the pharmacy never did,
 * so an encrypted eScript could not reach a pharmacy by construction.
 *
 * The call is signed with the node's own key (A9) and is idempotent: the sequencer accepts a
 * re-registration that presents the same signing key and refuses one that does not, so a restarted
 * node is fine and a second node claiming the same wallet is not. It does not credential the
 * provider; that is the insurer's decision (`l2_credentialProvider`).
 */
import { deriveEncryptionKeyPair } from '../messaging/encryption.js';
import { deriveWalletSigningKey } from '../security/wallet-key.js';
import type { NautilusAppServer } from './nautilus-app-server.js';

export interface ProviderRegistration {
  walletId: string;
  displayName: string;
  type: 'prescriber' | 'pharmacy';
  npi: string;
  specialty?: string;
  pharmacyType?: string;
  /** The provider's enrollment key; used for the two derivations and not kept. */
  enrollmentKey: string;
}

export interface ProviderRegistrationOutcome {
  ok: boolean;
  /** The sequencer's reason when `ok` is false. */
  error?: string;
}

/** Both public keys a provider registers, derived from its enrollment key. */
export function providerPublicKeys(enrollmentKey: string): { encryptionPublicKeyHex: string; signingPublicKeyHex: string } {
  const enc = deriveEncryptionKeyPair(enrollmentKey);
  try {
    return {
      encryptionPublicKeyHex: enc.publicKey.toString('hex'),
      signingPublicKeyHex: deriveWalletSigningKey(enrollmentKey).publicKeyHex,
    };
  } finally {
    enc.privateKey.fill(0);
  }
}

/** Register (or re-register) this node's provider entity on the sequencer, keys included. */
export async function registerProviderEntity(server: NautilusAppServer, reg: ProviderRegistration): Promise<ProviderRegistrationOutcome> {
  const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
  const keys = providerPublicKeys(reg.enrollmentKey);
  const params: Record<string, unknown> = {
    walletId: reg.walletId,
    displayName: reg.displayName,
    type: reg.type,
    npi: reg.npi,
    ...keys,
  };
  if (reg.specialty) params.specialty = reg.specialty;
  if (reg.pharmacyType) params.pharmacyType = reg.pharmacyType;
  try {
    const resp = await server.signedFetch(`${seqUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_registerEntity', params }),
    });
    const json = await resp.json() as { error?: { message?: string } };
    if (json.error) return { ok: false, error: json.error.message ?? 'registration refused' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
