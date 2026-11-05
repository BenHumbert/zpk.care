/**
 * Sealing a secret to one recipient's key — the key ceremony (owner, 2026-11-04).
 *
 * The ceremony seals each holder's share to that holder's X25519 key, and a holder releasing a share
 * seals it again to the one-time key of the node being provisioned. An envelope opens only with the
 * recipient's private key and only for the purpose it was sealed for: the context is bound into the
 * key derivation and authenticated, so a share sealed for one node, one holder or one start cannot be
 * presented as another. A changed byte anywhere is refused.
 */
import { generateKeyPairSync } from 'crypto';
import {
  generateBoxKeyPair, boxPrivateKeyFromHex, boxPublicKeyHexOf, sealTo, openSealed, isSealedEnvelope,
} from '../src/keys/seal.js';
import type { SealedEnvelope } from '../src/keys/seal.js';

const CONTEXT = 'zpk.care/ceremony/v1/share/2026-11-05-0001/insurer/1';

describe('X25519 box keys', () => {
  test('a key pair round-trips through hex', () => {
    const kp = generateBoxKeyPair();
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    const again = boxPrivateKeyFromHex(kp.privateKeyHex);
    expect(boxPublicKeyHexOf(again)).toBe(kp.publicKeyHex);
  });

  test('refuses a private key that is not 32 bytes of hex', () => {
    expect(() => boxPrivateKeyFromHex('ab')).toThrow(/32 bytes of hex/);
  });
});

describe('sealTo and openSealed', () => {
  const recipient = generateBoxKeyPair();
  const secret = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');

  test('the recipient opens what was sealed to it, for the same purpose', () => {
    const envelope = sealTo(recipient.publicKeyHex, secret, CONTEXT);
    expect(isSealedEnvelope(envelope)).toBe(true);
    expect(envelope.recipient).toBe(recipient.publicKeyHex);
    expect(envelope.context).toBe(CONTEXT);
    expect(openSealed(recipient.privateKey, envelope, CONTEXT).equals(secret)).toBe(true);
  });

  test('an envelope survives JSON', () => {
    const envelope = JSON.parse(JSON.stringify(sealTo(recipient.publicKeyHex, secret, CONTEXT))) as SealedEnvelope;
    expect(openSealed(recipient.privateKey, envelope, CONTEXT).equals(secret)).toBe(true);
  });

  test('the envelope does not carry the secret', () => {
    const text = JSON.stringify(sealTo(recipient.publicKeyHex, secret, CONTEXT));
    expect(text).not.toContain(secret.toString('hex'));
    expect(text).not.toContain(secret.toString('base64'));
  });

  test('each sealing is fresh', () => {
    const a = sealTo(recipient.publicKeyHex, secret, CONTEXT);
    const b = sealTo(recipient.publicKeyHex, secret, CONTEXT);
    expect(a.ephemeral).not.toBe(b.ephemeral);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('another key cannot open it', () => {
    const other = generateBoxKeyPair();
    const envelope = sealTo(recipient.publicKeyHex, secret, CONTEXT);
    expect(() => openSealed(other.privateKey, envelope, CONTEXT)).toThrow(/not sealed to this key/);
    // even with the recipient field rewritten to match
    expect(() => openSealed(other.privateKey, { ...envelope, recipient: other.publicKeyHex }, CONTEXT)).toThrow(/could not be opened/);
  });

  test('it opens only for the purpose it was sealed for', () => {
    const envelope = sealTo(recipient.publicKeyHex, secret, CONTEXT);
    const otherNode = 'zpk.care/ceremony/v1/share/2026-11-05-0001/sequencer-1/1';
    expect(() => openSealed(recipient.privateKey, envelope, otherNode)).toThrow(/sealed for another purpose/);
    // rewriting the context field to match does not help: the context is in the key and the tag
    expect(() => openSealed(recipient.privateKey, { ...envelope, context: otherNode }, otherNode)).toThrow(/could not be opened/);
  });

  test('a changed byte anywhere is refused', () => {
    const envelope = sealTo(recipient.publicKeyHex, secret, CONTEXT);
    const flip = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
    for (const field of ['ciphertext', 'iv', 'tag', 'ephemeral'] as const) {
      const bad = { ...envelope, [field]: flip(envelope[field]) };
      expect(() => openSealed(recipient.privateKey, bad, CONTEXT)).toThrow();
    }
  });

  test('refuses a recipient key that is not 32 bytes of hex, and a low-order point', () => {
    expect(() => sealTo('abcd', secret, CONTEXT)).toThrow(/32 bytes of hex/);
    expect(() => sealTo('00'.repeat(32), secret, CONTEXT)).toThrow(/not a usable X25519 key/);
  });

  test('refuses a context that could be confused with another', () => {
    expect(() => sealTo(recipient.publicKeyHex, secret, '')).toThrow(/context/);
    expect(() => sealTo(recipient.publicKeyHex, secret, 'a\nb')).toThrow(/context/);
    expect(() => sealTo(recipient.publicKeyHex, secret, 'x'.repeat(257))).toThrow(/context/);
  });

  test('refuses something that is not an envelope', () => {
    expect(isSealedEnvelope({ v: 1 })).toBe(false);
    expect(() => openSealed(recipient.privateKey, { v: 2 } as unknown as SealedEnvelope, CONTEXT)).toThrow(/not a sealed envelope/);
  });

  test('refuses a private key of another type', () => {
    const ed = generateKeyPairSync('ed25519').privateKey;
    const envelope = sealTo(recipient.publicKeyHex, secret, CONTEXT);
    expect(() => openSealed(ed, envelope, CONTEXT)).toThrow(/X25519/);
  });
});
