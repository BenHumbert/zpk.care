import { Field, Poseidon } from 'o1js';
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  DOMAIN_TAG_MEMBER,
  DOMAIN_TAG_PRESCRIBER,
  DOMAIN_TAG_PHARMACY,
  MIN_ENROLLMENT_KEY_LENGTH,
  generateEnrollmentKey,
  validateEnrollmentKey,
  ProofGateProgram,
  WalletState,
  WalletRegistry,
} from '../src/wallets/index.js';
import type { MemberLocalData } from '../src/models/member.js';
import type { PrescriberLocalData } from '../src/models/prescriber.js';
import type { PharmacyLocalData } from '../src/models/pharmacy.js';

// ─── Test Data ───────────────────────────────────────────

const testMember: MemberLocalData = {
  cardholderId: 'CARD123456789',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'John',
  lastName: 'Doe',
};

const testPrescriber: PrescriberLocalData = {
  prescriberIdQualifier: 1,
  prescriberId: '1234567890',
};

const testPharmacy: PharmacyLocalData = {
  serviceProviderIdQualifier: 1,
  serviceProviderId: '9876543210',
};

/** Simulates a user-generated enrollment key (like a seed phrase or 2FA secret) */
const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';
const ALT_ENROLLMENT_KEY = 'aB4@cD6!eF8#gH0$iJ2%';

// ─── Tests ───────────────────────────────────────────────

describe('Layer 2 — Proof-Gated Wallets', () => {

  describe('Wallet Derivation', () => {
    test('member wallet ID is deterministic', () => {
      const id1 = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const id2 = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      expect(id1.toString()).toBe(id2.toString());
    });

    test('member wallet ID changes when data changes', () => {
      const id1 = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const id2 = deriveMemberWalletId({ ...testMember, cardholderId: 'DIFFERENT' }, TEST_ENROLLMENT_KEY);
      expect(id1.toString()).not.toBe(id2.toString());
    });

    test('member wallet ID changes when enrollment key changes', () => {
      const id1 = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const id2 = deriveMemberWalletId(testMember, ALT_ENROLLMENT_KEY);
      expect(id1.toString()).not.toBe(id2.toString());
    });

    test('same PHI without enrollment key produces different wallet', () => {
      // This is the key security property: knowing PHI alone is not enough
      const id1 = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const id2 = deriveMemberWalletId(testMember, ALT_ENROLLMENT_KEY);
      expect(id1.toString()).not.toBe(id2.toString());
    });

    test('prescriber wallet ID is deterministic', () => {
      const id1 = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
      const id2 = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
      expect(id1.toString()).toBe(id2.toString());
    });

    test('pharmacy wallet ID is deterministic', () => {
      const id1 = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);
      const id2 = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);
      expect(id1.toString()).toBe(id2.toString());
    });

    test('domain tags prevent cross-type collisions', () => {
      const memberId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const prescriberId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
      const pharmacyId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);

      expect(memberId.toString()).not.toBe(prescriberId.toString());
      expect(memberId.toString()).not.toBe(pharmacyId.toString());
      expect(prescriberId.toString()).not.toBe(pharmacyId.toString());
    });

    test('memberWalletPreimage produces correct Fields', () => {
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      expect(preimage).toHaveLength(5);

      const reconstructed = Poseidon.hash([DOMAIN_TAG_MEMBER, ...preimage]);
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      expect(reconstructed.toString()).toBe(walletId.toString());
    });

    test('prescriberWalletPreimage produces correct Fields', () => {
      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);
      expect(preimage).toHaveLength(3);

      const reconstructed = Poseidon.hash([DOMAIN_TAG_PRESCRIBER, ...preimage]);
      const walletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
      expect(reconstructed.toString()).toBe(walletId.toString());
    });

    test('pharmacyWalletPreimage produces correct Fields', () => {
      const preimage = pharmacyWalletPreimage(testPharmacy, TEST_ENROLLMENT_KEY);
      expect(preimage).toHaveLength(3);

      const reconstructed = Poseidon.hash([DOMAIN_TAG_PHARMACY, ...preimage]);
      const walletId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);
      expect(reconstructed.toString()).toBe(walletId.toString());
    });
  });

  describe('ProofGate ZkProgram', () => {
    beforeAll(async () => {
      await ProofGateProgram.compile();
    });

    test('verifyMember: valid preimage produces valid proof', async () => {
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      const proof = await ProofGateProgram.verifyMember(
        walletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      expect(proof).toBeDefined();
      expect(proof.proof.publicInput.toString()).toBe(walletId.toString());
    });

    test('verifyPrescriber: valid preimage produces valid proof', async () => {
      const walletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);

      const proof = await ProofGateProgram.verifyPrescriber(
        walletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      expect(proof).toBeDefined();
      expect(proof.proof.publicInput.toString()).toBe(walletId.toString());
    });

    test('verifyPharmacy: valid preimage produces valid proof', async () => {
      const walletId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);
      const preimage = pharmacyWalletPreimage(testPharmacy, TEST_ENROLLMENT_KEY);

      const proof = await ProofGateProgram.verifyPharmacy(
        walletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      expect(proof).toBeDefined();
      expect(proof.proof.publicInput.toString()).toBe(walletId.toString());
    });

    test('verifyMember: wrong enrollment key fails', async () => {
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const wrongPreimage = memberWalletPreimage(testMember, 'wrong-key');

      await expect(
        ProofGateProgram.verifyMember(
          walletId,
          wrongPreimage[0]!, wrongPreimage[1]!, wrongPreimage[2]!,
          wrongPreimage[3]!, wrongPreimage[4]!,
        ),
      ).rejects.toThrow();
    });

    test('verifyMember: wrong PHI fails', async () => {
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const wrongPreimage = memberWalletPreimage(
        { ...testMember, firstName: 'Jane' },
        TEST_ENROLLMENT_KEY,
      );

      await expect(
        ProofGateProgram.verifyMember(
          walletId,
          wrongPreimage[0]!, wrongPreimage[1]!, wrongPreimage[2]!,
          wrongPreimage[3]!, wrongPreimage[4]!,
        ),
      ).rejects.toThrow();
    });

    test('verifyPrescriber: wrong enrollment key fails', async () => {
      const walletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
      const wrongPreimage = prescriberWalletPreimage(testPrescriber, 'wrong-key');

      await expect(
        ProofGateProgram.verifyPrescriber(
          walletId,
          wrongPreimage[0]!, wrongPreimage[1]!, wrongPreimage[2]!,
        ),
      ).rejects.toThrow();
    });

    test('proof verification succeeds with verification key', async () => {
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      const result = await ProofGateProgram.verifyMember(
        walletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const isValid = await ProofGateProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });
  });

  describe('WalletState', () => {
    test('init creates wallet with correct ID and zero nonce', () => {
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const state = WalletState.init(walletId);

      expect(state.walletId.toString()).toBe(walletId.toString());
      expect(state.nonce.toString()).toBe('0');
    });

    test('commitment is deterministic', () => {
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const s1 = WalletState.init(walletId);
      const s2 = WalletState.init(walletId);
      expect(s1.commitment().toString()).toBe(s2.commitment().toString());
    });

    test('commitment changes when nonce changes', () => {
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const s1 = WalletState.init(walletId);
      const s2 = new WalletState({
        walletId,
        credentialInventoryRoot: s1.credentialInventoryRoot,
        nonce: Field(1),
      });
      expect(s1.commitment().toString()).not.toBe(s2.commitment().toString());
    });
  });

  describe('WalletRegistry', () => {
    test('register a wallet and verify it exists', () => {
      const registry = new WalletRegistry();
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);

      registry.register(walletId);

      expect(registry.isRegistered(walletId)).toBe(true);
      expect(registry.count).toBe(1);
    });

    test('registering the same wallet twice throws', () => {
      const registry = new WalletRegistry();
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);

      registry.register(walletId);
      expect(() => registry.register(walletId)).toThrow('already registered');
    });

    test('multiple wallet types coexist in registry', () => {
      const registry = new WalletRegistry();

      const memberId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      const prescriberId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
      const pharmacyId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);

      registry.register(memberId);
      registry.register(prescriberId);
      registry.register(pharmacyId);

      expect(registry.count).toBe(3);
      expect(registry.isRegistered(memberId)).toBe(true);
      expect(registry.isRegistered(prescriberId)).toBe(true);
      expect(registry.isRegistered(pharmacyId)).toBe(true);
    });

    test('getState returns initial wallet state', () => {
      const registry = new WalletRegistry();
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      registry.register(walletId);

      const state = registry.getState(walletId);
      expect(state.walletId.toString()).toBe(walletId.toString());
      expect(state.nonce.toString()).toBe('0');
    });

    test('updateState changes the registry root', () => {
      const registry = new WalletRegistry();
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      registry.register(walletId);

      const rootBefore = registry.getRoot().toString();

      const currentState = registry.getState(walletId);
      const newState = new WalletState({
        walletId,
        credentialInventoryRoot: currentState.credentialInventoryRoot,
        nonce: Field(1),
      });
      registry.updateState(walletId, newState);

      const rootAfter = registry.getRoot().toString();
      expect(rootBefore).not.toBe(rootAfter);
    });

    test('Merkle witness validates wallet inclusion in registry', () => {
      const registry = new WalletRegistry();
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      registry.register(walletId);

      const state = registry.getState(walletId);
      const witness = registry.getWitness(walletId);

      const computedRoot = witness.calculateRoot(state.commitment());
      expect(computedRoot.toString()).toBe(registry.getRoot().toString());
    });

    test('Merkle witness still validates after state update', () => {
      const registry = new WalletRegistry();
      const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
      registry.register(walletId);

      const currentState = registry.getState(walletId);
      const newState = new WalletState({
        walletId,
        credentialInventoryRoot: currentState.credentialInventoryRoot,
        nonce: Field(1),
      });
      registry.updateState(walletId, newState);

      const witness = registry.getWitness(walletId);
      const computedRoot = witness.calculateRoot(newState.commitment());
      expect(computedRoot.toString()).toBe(registry.getRoot().toString());
    });
  });

  describe('Enrollment Key Generation & Validation', () => {
    test('generateEnrollmentKey produces valid key', () => {
      const key = generateEnrollmentKey();
      expect(() => validateEnrollmentKey(key)).not.toThrow();
    });

    test('generateEnrollmentKey produces unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(generateEnrollmentKey());
      }
      expect(keys.size).toBe(100);
    });

    test('generateEnrollmentKey produces keys >= MIN_ENROLLMENT_KEY_LENGTH', () => {
      const key = generateEnrollmentKey();
      expect(key.length).toBeGreaterThanOrEqual(MIN_ENROLLMENT_KEY_LENGTH);
    });

    test('validateEnrollmentKey rejects empty string', () => {
      expect(() => validateEnrollmentKey('')).toThrow('at least');
    });

    test('validateEnrollmentKey rejects too-short key', () => {
      expect(() => validateEnrollmentKey('abc123!')).toThrow('at least');
    });

    test('validateEnrollmentKey rejects low-entropy key (only lowercase)', () => {
      expect(() => validateEnrollmentKey('abcdefghijklmnopqrst')).toThrow('character classes');
    });

    test('validateEnrollmentKey rejects low-entropy key (only digits)', () => {
      expect(() => validateEnrollmentKey('1234567890123456')).toThrow('character classes');
    });

    test('validateEnrollmentKey accepts key with 3+ character classes', () => {
      expect(() => validateEnrollmentKey('xK9#mP2$vL5nQ8wR3jF7')).not.toThrow();
    });

    test('validateEnrollmentKey accepts key with letters + digits + symbols', () => {
      expect(() => validateEnrollmentKey('abcdef123456!@#$')).not.toThrow();
    });

    test('deriveMemberWalletId rejects weak key', () => {
      expect(() => deriveMemberWalletId(testMember, 'weak'))
        .toThrow('at least');
    });

    test('derivePrescriberWalletId rejects weak key', () => {
      expect(() => derivePrescriberWalletId(testPrescriber, '1234'))
        .toThrow('at least');
    });

    test('derivePharmacyWalletId rejects weak key', () => {
      expect(() => derivePharmacyWalletId(testPharmacy, ''))
        .toThrow('at least');
    });

    test('generated key works with derivation', () => {
      const key = generateEnrollmentKey();
      const id1 = deriveMemberWalletId(testMember, key);
      const id2 = deriveMemberWalletId(testMember, key);
      expect(id1.toString()).toBe(id2.toString());
    });
  });
});
