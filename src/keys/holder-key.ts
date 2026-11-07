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
 * A key holder's own keys — the key ceremony (owner, 2026-11-04).
 *
 * The holders play the part of the DNS root ceremony's crypto officers. Each makes their own keys on their own device:
 * an Ed25519 key to sign the ceremony record and the shares they release, and an X25519 key the ceremony seals their
 * share to. The private halves are kept in a file encrypted under the holder's passphrase (scrypt, AES-256-GCM), with
 * the public halves and the label bound into its authenticated data. These are software keys because the owner put
 * hardware purchases off (2026-10-18); a smartcard can hold them later without changing anything else.
 *
 * A holder's card is the public half: the label, an optional group (the ceremony refuses a split in which one group,
 * such as the people who run the servers, holds enough shares to rebuild a key alone) and the two public keys. Cards are
 * published in the ceremony record, so a label need not be a full name.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  scryptSync,
  sign,
  verify,
  type KeyObject,
} from 'crypto';
import { privateKeyFromSeedHex } from '../security/signed-request.js';
import { publicKeyHexFromSeed } from '../security/node-roles.js';
import { generateBoxKeyPair, boxPrivateKeyFromHex, boxPublicKeyHexOf } from './seal.js';

export const MIN_HOLDER_PASSPHRASE = 12;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;
const GROUP = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DEFAULT_SCRYPT_N = 2 ** 17;

export interface HolderCard {
  label: string;
  /** The holder's team; no group may hold enough shares to rebuild a key alone. */
  group?: string;
  /** Ed25519: signs the ceremony record and the holder's share releases. */
  signPublicKeyHex: string;
  /** X25519: the ceremony seals the holder's shares to it. */
  boxPublicKeyHex: string;
}

export interface HolderKeyFile {
  v: 1;
  kind: 'zpk.care key holder';
  label: string;
  group?: string;
  createdAt: string;
  signPublicKeyHex: string;
  boxPublicKeyHex: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface UnlockedHolder {
  card: HolderCard;
  boxPrivateKey: KeyObject;
  /** An Ed25519 signature over `message`, as hex. */
  sign(message: Buffer): string;
}

export function isHolderCard(value: unknown): value is HolderCard {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.label === 'string' &&
    LABEL.test(c.label) &&
    (c.group === undefined || (typeof c.group === 'string' && GROUP.test(c.group))) &&
    typeof c.signPublicKeyHex === 'string' &&
    HEX32.test(c.signPublicKeyHex) &&
    typeof c.boxPublicKeyHex === 'string' &&
    HEX32.test(c.boxPublicKeyHex)
  );
}

/** A card's fingerprint, to read aloud at the ceremony: 16 hex digits of the SHA-256 of its two public keys. */
export function holderFingerprint(card: HolderCard): string {
  const digest = createHash('sha256')
    .update(Buffer.from(card.signPublicKeyHex, 'hex'))
    .update(Buffer.from(card.boxPublicKeyHex, 'hex'))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return digest.match(/.{4}/g)!.join('-');
}

export function verifyHolderSignature(signPublicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  if (!HEX32.test(signPublicKeyHex) || typeof signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signPublicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, message, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

function aad(file: Pick<HolderKeyFile, 'label' | 'group' | 'signPublicKeyHex' | 'boxPublicKeyHex'>): Buffer {
  return Buffer.from(
    `zpk.care/holder-key/v1\n${file.label}\n${file.group ?? ''}\n${file.signPublicKeyHex}\n${file.boxPublicKeyHex}`,
    'utf8',
  );
}

function passphraseKey(passphrase: string, kdf: HolderKeyFile['kdf']): Buffer {
  return scryptSync(passphrase.normalize('NFC'), Buffer.from(kdf.salt, 'hex'), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r + 32 * 1024 * 1024,
  });
}

/** Make a holder's keys and the file that keeps them under `passphrase`. `scryptN` is lowered for tests only. */
export function createHolderKey(
  label: string,
  passphrase: string,
  opts: { group?: string; scryptN?: number; now?: Date } = {},
): { file: HolderKeyFile; card: HolderCard } {
  if (typeof label !== 'string' || !LABEL.test(label)) {
    throw new Error(
      'createHolderKey: a label is 1 to 48 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit',
    );
  }
  if (opts.group !== undefined && !GROUP.test(opts.group))
    throw new Error('createHolderKey: a group is 1 to 32 lower-case letters, digits, dashes or underscores');
  if (typeof passphrase !== 'string' || passphrase.length < MIN_HOLDER_PASSPHRASE) {
    throw new Error(`createHolderKey: the passphrase must be at least ${MIN_HOLDER_PASSPHRASE} characters`);
  }
  const signSeed = randomBytes(32);
  const box = generateBoxKeyPair();
  const card: HolderCard = {
    label,
    ...(opts.group ? { group: opts.group } : {}),
    signPublicKeyHex: publicKeyHexFromSeed(signSeed.toString('hex')),
    boxPublicKeyHex: box.publicKeyHex,
  };
  const kdf = { name: 'scrypt' as const, N: opts.scryptN ?? DEFAULT_SCRYPT_N, r: 8, p: 1, salt: randomBytes(16).toString('hex') };
  const key = passphraseKey(passphrase, kdf);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(card));
  const plain = Buffer.from(JSON.stringify({ signSeedHex: signSeed.toString('hex'), boxPrivateHex: box.privateKeyHex }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  signSeed.fill(0);
  key.fill(0);
  const file: HolderKeyFile = {
    v: 1,
    kind: 'zpk.care key holder',
    label,
    ...(opts.group ? { group: opts.group } : {}),
    createdAt: (opts.now ?? new Date()).toISOString(),
    signPublicKeyHex: card.signPublicKeyHex,
    boxPublicKeyHex: card.boxPublicKeyHex,
    kdf,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('hex'),
  };
  return { file, card };
}

/** Open a holder's key file with their passphrase. Throws for a wrong passphrase or a changed file. */
export function unlockHolderKey(file: HolderKeyFile, passphrase: string): UnlockedHolder {
  if (!file || file.v !== 1 || file.kind !== 'zpk.care key holder' || file.kdf?.name !== 'scrypt') {
    throw new Error('unlockHolderKey: this is not a holder key file');
  }
  const card: HolderCard = {
    label: file.label,
    ...(file.group ? { group: file.group } : {}),
    signPublicKeyHex: file.signPublicKeyHex,
    boxPublicKeyHex: file.boxPublicKeyHex,
  };
  if (!isHolderCard(card)) throw new Error('unlockHolderKey: this is not a holder key file');
  if (!Number.isInteger(file.kdf.N) || file.kdf.N < 2 ** 12 || file.kdf.N > 2 ** 20)
    throw new Error('unlockHolderKey: the key file asks for an unusable scrypt cost');
  const key = passphraseKey(String(passphrase ?? ''), file.kdf);
  let secrets: { signSeedHex: string; boxPrivateHex: string };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'hex'));
    decipher.setAAD(aad(file));
    decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'base64')), decipher.final()]);
    secrets = JSON.parse(plain.toString('utf8'));
    plain.fill(0);
  } catch {
    throw new Error('unlockHolderKey: wrong passphrase, or the key file was changed');
  } finally {
    key.fill(0);
  }
  if (publicKeyHexFromSeed(secrets.signSeedHex) !== card.signPublicKeyHex) throw new Error('unlockHolderKey: the key file was changed');
  const boxPrivateKey = boxPrivateKeyFromHex(secrets.boxPrivateHex);
  if (boxPublicKeyHexOf(boxPrivateKey) !== card.boxPublicKeyHex) throw new Error('unlockHolderKey: the key file was changed');
  const signKey = privateKeyFromSeedHex(secrets.signSeedHex);
  return {
    card,
    boxPrivateKey,
    sign: (message: Buffer) => sign(null, message, signKey).toString('hex'),
  };
}
