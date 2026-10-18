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
 * The wallet's own signing key — plan item A10b.
 *
 * Deterministic in the enrollment key (so recovery reproduces it), different for different keys,
 * separate from the X25519 encryption key derived from the same root, and usable with the one
 * signed-request format every server verifies.
 */
import { createHash } from 'crypto';
import { deriveWalletSigningKey, walletSigner, walletSigningSeedHex, WALLET_SIGNING_KEY_INFO } from '../src/security/wallet-key.js';
import { deriveEncryptionKeyPair } from '../src/messaging/encryption.js';
import { signRequest, verifySignedRequest, ReplayCache } from '../src/security/signed-request.js';

const EK_A = 'enrollment-key-of-alice-0123456789abcdef';
const EK_B = 'enrollment-key-of-bob-0123456789abcdef';
const WALLET_A = '123456789012345678901234567890';

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

describe('deriveWalletSigningKey', () => {
  test('is deterministic in the enrollment key and differs between keys', () => {
    const once = deriveWalletSigningKey(EK_A);
    const again = deriveWalletSigningKey(EK_A);
    const other = deriveWalletSigningKey(EK_B);
    expect(once.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(again.publicKeyHex).toBe(once.publicKeyHex);
    expect(other.publicKeyHex).not.toBe(once.publicKeyHex);
    expect(walletSigningSeedHex(EK_A)).toBe(walletSigningSeedHex(EK_A));
  });

  test('is a different key from the encryption key derived from the same enrollment key', () => {
    const signing = deriveWalletSigningKey(EK_A);
    const enc = deriveEncryptionKeyPair(EK_A);
    expect(signing.publicKeyHex).not.toBe(enc.publicKey.toString('hex'));
    // the encryption seed is sha256(enrollmentKey); the signing seed is HKDF under its own label
    expect(walletSigningSeedHex(EK_A)).not.toBe(createHash('sha256').update(EK_A).digest('hex'));
    expect(WALLET_SIGNING_KEY_INFO).toContain('wallet signing key');
  });

  test('refuses an empty enrollment key and a wallet id that is not decimal', () => {
    expect(() => walletSigningSeedHex('')).toThrow(/enrollment key/);
    expect(() => walletSigner(EK_A, '0xabc')).toThrow(/decimal/);
  });
});

describe('a request signed as the wallet', () => {
  test('verifies against the wallet\'s public key, and against nothing else', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_storeMessage', params: {} });
    const headers = lower(signRequest({ ...walletSigner(EK_A, WALLET_A), method: 'POST', path: '/rpc', body }));
    const mine = deriveWalletSigningKey(EK_A).publicKeyHex;
    const theirs = deriveWalletSigningKey(EK_B).publicKeyHex;
    const ok = verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: WALLET_A, publicKeyHex: mine, body, replayCache: new ReplayCache() });
    expect(ok.ok).toBe(true);
    const wrongKey = verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: WALLET_A, publicKeyHex: theirs, body, replayCache: new ReplayCache() });
    expect(wrongKey.ok).toBe(false);
    const wrongBody = verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: WALLET_A, publicKeyHex: mine, body: body + ' ', replayCache: new ReplayCache() });
    expect(wrongBody.ok).toBe(false);
    const cache = new ReplayCache();
    expect(verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: WALLET_A, publicKeyHex: mine, body, replayCache: cache }).ok).toBe(true);
    const replayed = verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: WALLET_A, publicKeyHex: mine, body, replayCache: cache });
    expect(replayed.ok).toBe(false);
  });
});
