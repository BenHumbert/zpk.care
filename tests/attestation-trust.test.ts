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
 * Who signed it — the acceptance test for the first half of phase A item A10, finding A-12.
 *
 * `verifyAttestation` verified an attestation against `att.pk`, the public key carried **inside
 * the attestation itself**. That verifies nothing. An attacker generates a keypair, signs an
 * attestation naming any wallet, embeds their own public key, and it comes back valid; the
 * pharmacy's `/nfc/scan` then displays that wallet as a verified member. Forging needed no secret
 * at all, which makes it a worse hole than the public literal seed the finding also mentions.
 *
 * A signature is only evidence if you already know whose signature it should be. So the verifier
 * now takes the key the verifier trusts, obtained out of band, and refuses when it has none.
 *
 * What this does **not** fix, and is not claimed to: `l2_requestAttestation` is still open, so the
 * sequencer will sign for any wallet it knows if asked. That is the remaining half of A-12 and it
 * needs an ownership proof, which is the same machinery as item D1.
 */
import {
  SequencerAttestationAuthority,
  type NfcCredentialAttestation,
} from '../src/credentials/nfc-attestation.js';

/** The real authority: the one a pharmacy would learn about from the sequencer. */
const authority = new SequencerAttestationAuthority();
/** An attacker's authority. No secrets needed; anyone can make one. */
const attacker = new SequencerAttestationAuthority();

const WALLET = '20558123456789012345678901234567890';

function attestFrom(
  auth: SequencerAttestationAuthority,
  walletId = WALLET,
): NfcCredentialAttestation {
  return auth.createAttestation({
    walletId,
    credentialCommitment: '111222333444555666777888999',
    forestRoot: '999888777666555444333222111',
    lifecycleState: 3,
    expirySeconds: 24 * 3600,
  });
}

describe('an attestation is only valid against a key the verifier already trusts', () => {
  test('the real authority verifies against its own key', () => {
    const att = attestFrom(authority);
    const res = SequencerAttestationAuthority.verifyAttestation(att, authority.publicKeyHex);
    expect(res.valid).toBe(true);
    expect(res.expired).toBe(false);
  });

  test('an attacker signing their own attestation is REFUSED', () => {
    // This is the whole finding. Before the fix this returned valid, because the verifier used
    // the attacker's own embedded key to check the attacker's own signature.
    const forged = attestFrom(attacker);
    const res = SequencerAttestationAuthority.verifyAttestation(forged, authority.publicKeyHex);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/does not trust/i);
  });

  test('the forged attestation is internally consistent, so only the pinned key catches it', () => {
    // Proof that the refusal comes from the key check and not from a malformed object: the
    // forgery verifies perfectly against its own author's key.
    const forged = attestFrom(attacker);
    const selfCheck = SequencerAttestationAuthority.verifyAttestation(forged, attacker.publicKeyHex);
    expect(selfCheck.valid).toBe(true);
  });

  test('a forged attestation for someone else’s wallet is refused', () => {
    const forged = attestFrom(attacker, '99999999999999999999');
    const res = SequencerAttestationAuthority.verifyAttestation(forged, authority.publicKeyHex);
    expect(res.valid).toBe(false);
  });

  test('swapping the embedded key to the trusted one does not help, because the signature then fails', () => {
    const forged = attestFrom(attacker);
    const spoofed: NfcCredentialAttestation = { ...forged, pk: authority.publicKeyHex };
    const res = SequencerAttestationAuthority.verifyAttestation(spoofed, authority.publicKeyHex);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/signature/i);
  });

  test('a tampered field is refused even from the real authority', () => {
    const att = attestFrom(authority);
    const tampered: NfcCredentialAttestation = { ...att, w: '12121212121212121212' };
    const res = SequencerAttestationAuthority.verifyAttestation(tampered, authority.publicKeyHex);
    expect(res.valid).toBe(false);
  });
});

describe('a verifier with no trusted key refuses rather than trusting the tag', () => {
  test.each([
    ['an empty string', ''],
    ['a short key', 'abcd'],
    ['a 63-character key', 'a'.repeat(63)],
  ])('%s is refused', (_label, key) => {
    const att = attestFrom(authority);
    const res = SequencerAttestationAuthority.verifyAttestation(att, key);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/no trusted attestation key/i);
  });

  test('undefined is refused, which is what an un-updated caller would pass', () => {
    const att = attestFrom(authority);
    const res = SequencerAttestationAuthority.verifyAttestation(
      att,
      undefined as unknown as string,
    );
    expect(res.valid).toBe(false);
  });

  test('a valid attestation is still rejected without a key, so there is no fallback path', () => {
    const att = attestFrom(authority);
    expect(SequencerAttestationAuthority.verifyAttestation(att, '').valid).toBe(false);
    // And works the moment the right key is supplied, so the refusal is about the key and not
    // about the attestation.
    expect(SequencerAttestationAuthority.verifyAttestation(att, authority.publicKeyHex).valid)
      .toBe(true);
  });
});

describe('expiry is still reported independently of who signed it', () => {
  test('an expired attestation from the real authority is invalid and marked expired', () => {
    const att = authority.createAttestation({
      walletId: WALLET,
      credentialCommitment: '1',
      forestRoot: '2',
      lifecycleState: 3,
      expirySeconds: -10,
    });
    const res = SequencerAttestationAuthority.verifyAttestation(att, authority.publicKeyHex);
    expect(res.expired).toBe(true);
  });

  test('an expired forgery is refused on the key, not merely on expiry', () => {
    const forged = attacker.createAttestation({
      walletId: WALLET,
      credentialCommitment: '1',
      forestRoot: '2',
      lifecycleState: 3,
      expirySeconds: -10,
    });
    const res = SequencerAttestationAuthority.verifyAttestation(forged, authority.publicKeyHex);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/does not trust/i);
  });
});

describe('the pharmacy pins the key rather than reading it from the tag', () => {
  test('the scan handler fetches a trusted key and passes it to every verification', () => {
    // Structural: five verification call sites sit in one handler, and one of them keeping the
    // old single-argument form would be a silently trusting path that no probe might hit.
    const src = require('fs').readFileSync('src/nodes/routes/pharmacy-routes.ts', 'utf-8') as string;
    const calls = src.match(/SequencerAttestationAuthority\.verifyAttestation\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call).toContain('trustedKey');
    }
    expect(src).toContain('getTrustedAttestationKey');
  });

  test('the engine verifies against its own authority key', () => {
    const src = require('fs')
      .readFileSync('src/adjudication/interactive-service.ts', 'utf-8') as string;
    expect(src).toContain('this.attestationAuthority.publicKeyHex');
  });
});
