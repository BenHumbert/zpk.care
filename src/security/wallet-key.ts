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
 * The wallet's own signing key — plan item A10b, findings A-12, A-15, A-16.
 *
 * A request that speaks for a wallet (a message it sends, a primary-care link it consents to, an
 * attestation it asks for) is signed by that wallet, with a key only the wallet's owner holds.
 * The key is Ed25519, derived from the enrollment key through HKDF under a fixed label, so it is a
 * sibling of the X25519 encryption key that `messaging/encryption.ts` derives from the same root:
 * same secret, different derivation, neither computable from the other's public half.
 *
 * Nothing here is stored. The device derives the key when it needs to sign and lets it go; the
 * enrollment key stays the only secret (I3), and recovering it on a new device reproduces the same
 * signing key, so recovery needs no re-registration. The public half is registered beside the
 * encryption key on the sequencer (`signingPublicKeyHex` in `l2_registerEntity`), where
 * `L2RpcServer.authorizeWallet` verifies against it.
 */
import { hkdfSync, type KeyObject } from 'crypto';
import { privateKeyFromSeedHex } from './signed-request.js';
import { publicKeyHexFromSeed } from './node-roles.js';

/** What `signRequest` needs to sign on someone's behalf: who, and with which private key. */
export interface RequestSigner {
  /** The id the signature is attributed to: a wallet id here, a node id for node keys. */
  signerId: string;
  privateKey: KeyObject;
}

/** The HKDF label. Changing it changes every wallet's signing key; it is part of the format. */
export const WALLET_SIGNING_KEY_INFO = 'zpk.care wallet signing key v1';
const WALLET_SIGNING_KEY_SALT = 'zpk.care';

/** The 32-byte Ed25519 seed for a wallet's signing key, as hex. Deterministic in the enrollment key. */
export function walletSigningSeedHex(enrollmentKey: string): string {
  if (typeof enrollmentKey !== 'string' || enrollmentKey.length === 0) {
    throw new Error('walletSigningSeedHex: an enrollment key is required');
  }
  const okm = hkdfSync(
    'sha256',
    Buffer.from(enrollmentKey, 'utf8'),
    Buffer.from(WALLET_SIGNING_KEY_SALT, 'utf8'),
    Buffer.from(WALLET_SIGNING_KEY_INFO, 'utf8'),
    32,
  );
  return Buffer.from(okm).toString('hex');
}

/** The wallet's signing key pair: the private key as a KeyObject for `signRequest`, the public half as hex. */
export function deriveWalletSigningKey(enrollmentKey: string): { privateKey: KeyObject; publicKeyHex: string } {
  const seedHex = walletSigningSeedHex(enrollmentKey);
  return { privateKey: privateKeyFromSeedHex(seedHex), publicKeyHex: publicKeyHexFromSeed(seedHex) };
}

/** A signer that signs as `walletId` with the key derived from `enrollmentKey`. */
export function walletSigner(enrollmentKey: string, walletId: string): RequestSigner {
  if (typeof walletId !== 'string' || !/^[0-9]+$/.test(walletId)) {
    throw new Error('walletSigner: a wallet id is a decimal string');
  }
  return { signerId: walletId, privateKey: deriveWalletSigningKey(enrollmentKey).privateKey };
}
