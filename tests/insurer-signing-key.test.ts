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
 * The insurer's signing identity — the acceptance test for phase A item A9's third clause,
 * findings A-14 and A-29.
 *
 * Two defects, and they compounded into an employer attestation chain with no integrity at all.
 *
 * **A-14.** Employer attestations were counter-signed with `ZKTRIDENT_ADMIN_TOKEN`. A bearer token
 * reused as a signing seed is worse than one that is merely shared: a bearer token is something
 * you present, a signing key is what makes statements attributable to you. That token is handed to
 * every child node at boot and is the literal string `admin123` in unsecure mode, so anyone
 * holding it could counter-sign as the insurer. The signing helper's own comment already said
 * "NOT the admin token"; only the caller was wrong.
 *
 * **A-29.** The sequencer verified the counter-signature against `att.insurerPublicKeyHex` — the
 * key carried inside the attestation — so the signed document supplied its own trust anchor and
 * anyone could register an arbitrary employer with a keypair they generated.
 *
 * Together: forge a keypair, sign an attestation, register a tenant. Neither defect needed a
 * secret.
 */
import {
  buildAttestationMessage,
  deriveInsurerKeypair,
  insurerPublicKeyFromSeed,
  verifyInsurerSignature,
  verifyEmployerSignature,
} from '../src/onboarding/employer-attestation.js';
import { sign as ed25519Sign } from 'crypto';
import type { EmployerAttestation } from '../src/l2/l2-types.js';

const REAL_SEED = 'insurer-dedicated-seed-for-tests-0001';
const ADMIN_TOKEN = 'admin123';
const ATTACKER_SEED = 'whatever-the-attacker-likes';

function attestationBase(): Omit<
  EmployerAttestation,
  'employerSignature' | 'insurerSignature' | 'insurerPublicKeyHex' | 'applicationId' | 'v'
> & { v: 2 } {
  return {
    v: 2,
    employerId: 'FERNHILL-TEST',
    employerIdHash: '123456789',
    publicKeyHex: 'b'.repeat(64),
    authorizedPlanIds: ['PLAN-TEST-1'],
    enrollmentCap: 10,
    effectiveDate: '20270101',
    attestationSeq: 1,
    ts: 1792200000,
    agreementCommitment: '987654321',
  } as never;
}

/** Sign an attestation with whatever seed is given, as the insurer would. */
function signAs(seed: string): EmployerAttestation {
  const base = attestationBase();
  const message = buildAttestationMessage(base as never);
  const { privateKey, publicKeyHex } = deriveInsurerKeypair(seed);
  return {
    ...(base as object),
    employerSignature: 'a'.repeat(128),
    insurerSignature: Buffer.from(ed25519Sign(null, message, privateKey)).toString('hex'),
    insurerPublicKeyHex: publicKeyHex,
    applicationId: 'EMPAPP-test',
  } as EmployerAttestation;
}

describe('the insurer signs with a dedicated key, not its bearer token', () => {
  test('the dedicated seed and the admin token produce different identities', () => {
    // If these matched, the split would be cosmetic.
    expect(insurerPublicKeyFromSeed(REAL_SEED)).not.toBe(insurerPublicKeyFromSeed(ADMIN_TOKEN));
  });

  test('a key derived from the admin token no longer verifies as the insurer', () => {
    // This is A-14 stated as a test: holding admin123 must not let you speak as the insurer.
    const forged = signAs(ADMIN_TOKEN);
    expect(verifyInsurerSignature(forged, insurerPublicKeyFromSeed(REAL_SEED))).toBe(false);
  });

  test('the derivation is deterministic, so a configured seed survives a restart', () => {
    expect(insurerPublicKeyFromSeed(REAL_SEED)).toBe(insurerPublicKeyFromSeed(REAL_SEED));
  });

  test('an empty seed is refused rather than producing a key', () => {
    expect(() => deriveInsurerKeypair('')).toThrow(/signing seed/i);
  });

  test('the public key is 64 hex characters, which is what a verifier pins', () => {
    expect(insurerPublicKeyFromSeed(REAL_SEED)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a counter-signature is verified against a pinned key, not the attestation’s own', () => {
  test('the real insurer verifies against the pinned key', () => {
    const att = signAs(REAL_SEED);
    expect(verifyInsurerSignature(att, insurerPublicKeyFromSeed(REAL_SEED))).toBe(true);
  });

  test('an attacker signing their own attestation is REFUSED', () => {
    // A-29 stated as a test. Before the fix this returned true, because the verifier used the
    // attacker's own embedded key to check the attacker's own signature.
    const forged = signAs(ATTACKER_SEED);
    expect(verifyInsurerSignature(forged, insurerPublicKeyFromSeed(REAL_SEED))).toBe(false);
  });

  test('the forgery is internally consistent, so only the pinned key catches it', () => {
    const forged = signAs(ATTACKER_SEED);
    expect(verifyInsurerSignature(forged, insurerPublicKeyFromSeed(ATTACKER_SEED))).toBe(true);
  });

  test('swapping the embedded key to the trusted one does not help', () => {
    const forged = signAs(ATTACKER_SEED);
    const spoofed = { ...forged, insurerPublicKeyHex: insurerPublicKeyFromSeed(REAL_SEED) };
    expect(verifyInsurerSignature(spoofed, insurerPublicKeyFromSeed(REAL_SEED))).toBe(false);
  });

  test.each([
    ['an empty pinned key', ''],
    ['a short pinned key', 'abcd'],
  ])('%s is refused, so there is no fallback to the embedded one', (_label, pinned) => {
    const att = signAs(REAL_SEED);
    expect(verifyInsurerSignature(att, pinned)).toBe(false);
  });

  test('a tampered field is refused even from the real insurer', () => {
    const att = signAs(REAL_SEED);
    const tampered = { ...att, enrollmentCap: 99999 };
    expect(verifyInsurerSignature(tampered, insurerPublicKeyFromSeed(REAL_SEED))).toBe(false);
  });
});

describe('the employer signature is checked, and why reading its embedded key is sound here', () => {
  test('a bogus employer signature is refused', () => {
    const att = signAs(REAL_SEED);
    expect(verifyEmployerSignature(att)).toBe(false);
  });

  test('it reads the embedded key on purpose, which is only safe beside the pinned check', () => {
    // Documented rather than silent: the insurer verifies the employer's signature against the
    // key in its own approved application record before counter-signing, so the insurer's
    // counter-signature is what attests that this key is the right one. A caller checking only
    // the employer signature is checking nothing, which is why the sequencer checks both.
    const src = require('fs')
      .readFileSync('src/onboarding/employer-attestation.ts', 'utf-8') as string;
    expect(src).toContain('A caller that checks only this function is checking nothing');
  });
});

describe('the wiring that keeps the signer and the verifier in step', () => {
  test('the sequencer refuses employer registration with no pinned key', () => {
    const src = require('fs').readFileSync('src/l2/l2-rpc-server.ts', 'utf-8') as string;
    expect(src).toContain('no insurer attestation key is pinned');
    // And it must pass the pinned key rather than the attestation's.
    expect(src).toContain('verifyInsurerSignature(att, pinnedInsurerKey)');
  });

  test('the insurer refuses to sign with the admin token', () => {
    const src = require('fs')
      .readFileSync('src/nodes/routes/marketplace-routes.ts', 'utf-8') as string;
    expect(src).toContain('insurerSigningSeed');
    expect(src).toContain('must not be the admin token');
    // The old wiring must be gone.
    expect(src).not.toContain('const signingSecret = server.getConfig().adminToken');
  });

  test('the boot derives the pinned key from the same seed it gives the insurer', () => {
    const src = require('fs').readFileSync('src/nodes/start-leviathan.ts', 'utf-8') as string;
    expect(src).toContain('insurerPublicKeyFromSeed(insurerSigningSeed)');
    expect(src).toContain('ZKTRIDENT_INSURER_SIGNING_SEED: insurerSigningSeed');
    expect(src).toContain('insurerAttestationPublicKeyHex,');
  });
});
