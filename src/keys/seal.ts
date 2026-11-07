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
 * Sealing a secret to one recipient's X25519 key — the key ceremony (owner, 2026-11-04).
 *
 * The ceremony seals each holder's share to that holder's key; a holder releasing a share seals it
 * again to the one-time key of the node being provisioned. An envelope is an ephemeral X25519 key, a
 * key agreed with the recipient's, HKDF-SHA256 over that and AES-256-GCM. Its context names what it
 * is for (ceremony, node, share, start) and is bound into both the derived key and the authenticated
 * data, so an envelope opens only for the purpose it was sealed for: a share sealed for one node,
 * holder or start cannot be presented as another's.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'crypto';

export const SEAL_ALG = 'X25519-HKDF-SHA256-AES-256-GCM';
const LABEL = 'zpk.care/seal/v1';
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const HEX32 = /^[0-9a-f]{64}$/;
const CONTEXT = /^[\x21-\x7e]{1,256}$/;

export interface BoxKeyPair {
  privateKey: KeyObject;
  /** The raw 32-byte public key, as hex. */
  publicKeyHex: string;
  /** The raw 32-byte private key, as hex, for a holder key file to encrypt. Never log it. */
  privateKeyHex: string;
}

export interface SealedEnvelope {
  v: 1;
  alg: typeof SEAL_ALG;
  /** What the envelope is for; bound into its key and its tag. */
  context: string;
  /** The recipient's raw public key, as hex. */
  recipient: string;
  /** The sender's one-time public key, as hex. */
  ephemeral: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

function rawPublicHex(publicKey: KeyObject): string {
  return Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))
    .subarray(X25519_SPKI_PREFIX.length)
    .toString('hex');
}

function publicKeyFromHex(hex: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

export function generateBoxKeyPair(): BoxKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    privateKey,
    publicKeyHex: rawPublicHex(publicKey),
    privateKeyHex: Buffer.from(String(jwk.d), 'base64url').toString('hex'),
  };
}

export function boxPrivateKeyFromHex(hex: string): KeyObject {
  if (typeof hex !== 'string' || !HEX32.test(hex)) throw new Error('boxPrivateKeyFromHex: an X25519 private key is 32 bytes of hex');
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'pkcs8' });
}

export function boxPublicKeyHexOf(privateKey: KeyObject): string {
  return rawPublicHex(createPublicKey(privateKey));
}

function checkContext(context: string): void {
  if (typeof context !== 'string' || !CONTEXT.test(context)) {
    throw new Error('seal: the context must be 1 to 256 printable characters, without spaces or line breaks');
  }
}

function agree(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch {
    throw new Error('seal: the recipient key is not a usable X25519 key');
  }
  if (shared.every((b) => b === 0)) throw new Error('seal: the recipient key is not a usable X25519 key');
  return shared;
}

function envelopeKey(shared: Buffer, ephemeralHex: string, recipientHex: string, context: string): Buffer {
  const salt = Buffer.concat([Buffer.from(ephemeralHex, 'hex'), Buffer.from(recipientHex, 'hex')]);
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(`${LABEL}\n${context}`, 'utf8'), 32));
}

function additionalData(context: string, recipientHex: string, ephemeralHex: string): Buffer {
  return Buffer.from(`${LABEL}\n${context}\n${recipientHex}\n${ephemeralHex}`, 'utf8');
}

/** Seal `plaintext` so that only the holder of `recipientPublicKeyHex`'s private key can open it, and only for `context`. */
export function sealTo(recipientPublicKeyHex: string, plaintext: Uint8Array, context: string): SealedEnvelope {
  if (typeof recipientPublicKeyHex !== 'string' || !HEX32.test(recipientPublicKeyHex)) {
    throw new Error('sealTo: the recipient key must be 32 bytes of hex');
  }
  checkContext(context);
  const recipient = publicKeyFromHex(recipientPublicKeyHex);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralHex = rawPublicHex(ephemeral.publicKey);
  const shared = agree(ephemeral.privateKey, recipient);
  const key = envelopeKey(shared, ephemeralHex, recipientPublicKeyHex, context);
  shared.fill(0);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData(context, recipientPublicKeyHex, ephemeralHex));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  key.fill(0);
  return {
    v: 1,
    alg: SEAL_ALG,
    context,
    recipient: recipientPublicKeyHex,
    ephemeral: ephemeralHex,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

export function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === 1 &&
    e.alg === SEAL_ALG &&
    typeof e.context === 'string' &&
    typeof e.recipient === 'string' &&
    HEX32.test(e.recipient) &&
    typeof e.ephemeral === 'string' &&
    HEX32.test(e.ephemeral) &&
    typeof e.iv === 'string' &&
    /^[0-9a-f]{24}$/.test(e.iv) &&
    typeof e.ciphertext === 'string' &&
    /^(?:[0-9a-f]{2})+$/.test(e.ciphertext) &&
    typeof e.tag === 'string' &&
    /^[0-9a-f]{32}$/.test(e.tag)
  );
}

/** Open an envelope sealed to `privateKey` for `expectedContext`. Throws for anything else. */
export function openSealed(privateKey: KeyObject, envelope: SealedEnvelope, expectedContext: string): Buffer {
  if (!isSealedEnvelope(envelope)) throw new Error('openSealed: this is not a sealed envelope');
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') {
    throw new Error('openSealed: the key is not an X25519 private key');
  }
  checkContext(expectedContext);
  if (envelope.recipient !== boxPublicKeyHexOf(privateKey)) throw new Error('openSealed: this envelope was not sealed to this key');
  if (envelope.context !== expectedContext) throw new Error('openSealed: this envelope was sealed for another purpose');
  let shared: Buffer;
  try {
    shared = agree(privateKey, publicKeyFromHex(envelope.ephemeral));
  } catch {
    throw new Error('openSealed: the envelope could not be opened (wrong key, or changed)');
  }
  const key = envelopeKey(shared, envelope.ephemeral, envelope.recipient, envelope.context);
  shared.fill(0);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(additionalData(envelope.context, envelope.recipient, envelope.ephemeral));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]);
  } catch {
    throw new Error('openSealed: the envelope could not be opened (wrong key, or changed)');
  } finally {
    key.fill(0);
  }
}
