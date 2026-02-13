import { Field } from 'o1js';
import {
  scrubObject,
  scrubArray,
  isScrubbed,
  secureMemberDerivation,
  securePrescriberDerivation,
  securePharmacyDerivation,
  MIN_PIN_LENGTH,
  exportEnrollmentBackup,
  importEnrollmentBackup,
} from '../src/security/index.js';
import { generateEnrollmentKey } from '../src/wallets/wallet-derivation.js';
import { deriveMemberWalletId } from '../src/wallets/wallet-derivation.js';
import { InMemoryStore } from '../src/storage/index.js';
import type { MemberLocalData } from '../src/models/member.js';
import type { PrescriberLocalData } from '../src/models/prescriber.js';
import type { PharmacyLocalData } from '../src/models/pharmacy.js';

// ─── Test Data (mutable copies created per test) ─────────

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

function freshMember(): MemberLocalData {
  return {
    cardholderId: 'CARD123456789',
    dateOfBirth: '19850315',
    genderCode: 1,
    firstName: 'John',
    lastName: 'Doe',
  };
}

function freshPrescriber(): PrescriberLocalData {
  return {
    prescriberIdQualifier: 1,
    prescriberId: '1234567890',
  };
}

function freshPharmacy(): PharmacyLocalData {
  return {
    serviceProviderIdQualifier: 1,
    serviceProviderId: '9876543210',
  };
}

// ─── Tests ───────────────────────────────────────────────

describe('Security — PHI/PII Scrubbing', () => {

  describe('scrubObject', () => {
    test('zeroes all string properties', () => {
      const obj: Record<string, unknown> = { name: 'John Doe', id: 'SSN-123' };
      scrubObject(obj);
      expect(obj.name).toBe('');
      expect(obj.id).toBe('');
    });

    test('zeroes all number properties', () => {
      const obj: Record<string, unknown> = { age: 38, code: 5 };
      scrubObject(obj);
      expect(obj.age).toBe(0);
      expect(obj.code).toBe(0);
    });

    test('nullifies nested objects', () => {
      const obj: Record<string, unknown> = {
        name: 'John',
        address: { street: '123 Main', city: 'Boston' },
      };
      scrubObject(obj);
      expect(obj.name).toBe('');
      expect(obj.address).toBeNull();
    });

    test('zeroes typed arrays in place', () => {
      const buffer = new Uint8Array([1, 2, 3, 4, 5]);
      const obj: Record<string, unknown> = { data: buffer };
      scrubObject(obj);
      expect(buffer.every((b) => b === 0)).toBe(true);
      expect(obj.data).toBeNull();
    });

    test('isScrubbed returns true after scrubbing', () => {
      const obj: Record<string, unknown> = { name: 'Jane', dob: '19900101', code: 2 };
      scrubObject(obj);
      expect(isScrubbed(obj)).toBe(true);
    });

    test('isScrubbed returns false on unscrubbed data', () => {
      const obj: Record<string, unknown> = { name: 'Jane', code: 2 };
      expect(isScrubbed(obj)).toBe(false);
    });
  });

  describe('scrubArray', () => {
    test('scrubs all elements and empties the array', () => {
      const arr: unknown[] = [
        { name: 'John' },
        { name: 'Jane' },
      ];
      scrubArray(arr);
      expect(arr).toHaveLength(0);
    });
  });

  describe('secureMemberDerivation — PHI/PII + enrollment key wipe', () => {
    test('returns valid wallet ID', () => {
      const memberData = freshMember();
      const expectedId = deriveMemberWalletId(freshMember(), TEST_ENROLLMENT_KEY);

      const result = secureMemberDerivation(memberData, TEST_ENROLLMENT_KEY);
      expect(result.walletId.toString()).toBe(expectedId.toString());
    });

    test('input object is scrubbed after derivation', () => {
      const memberData = freshMember();
      secureMemberDerivation(memberData, TEST_ENROLLMENT_KEY);

      expect(memberData.cardholderId).toBe('');
      expect(memberData.firstName).toBe('');
      expect(memberData.lastName).toBe('');
      expect(memberData.dateOfBirth).toBe('');
      expect(memberData.genderCode).toBe(0);
      expect(isScrubbed(memberData as unknown as Record<string, unknown>)).toBe(true);
    });

    test('preimage Fields include enrollment key hash (5 Fields for member)', () => {
      const memberData = freshMember();
      const result = secureMemberDerivation(memberData, TEST_ENROLLMENT_KEY);

      expect(result.preimage).toHaveLength(5);
      for (const f of result.preimage) {
        expect(f.toString()).not.toBe('0');
      }
    });

    test('dispose() clears preimage Fields', () => {
      const memberData = freshMember();
      const result = secureMemberDerivation(memberData, TEST_ENROLLMENT_KEY);

      expect(result.preimage.length).toBeGreaterThan(0);
      result.dispose();
      expect(result.preimage).toHaveLength(0);
    });

    test('wallet ID survives scrubbing (it is the permanent identity)', () => {
      const memberData = freshMember();
      const result = secureMemberDerivation(memberData, TEST_ENROLLMENT_KEY);

      expect(result.walletId.toString().length).toBeGreaterThan(0);
      expect(result.walletId.toString()).not.toBe('0');

      result.dispose();
      expect(result.walletId.toString().length).toBeGreaterThan(0);
    });
  });

  describe('securePrescriberDerivation — PHI/PII wipe', () => {
    test('input is scrubbed after derivation', () => {
      const data = freshPrescriber();
      securePrescriberDerivation(data, TEST_ENROLLMENT_KEY);

      expect(data.prescriberId).toBe('');
      expect(data.prescriberIdQualifier).toBe(0);
    });

    test('dispose() clears preimage', () => {
      const data = freshPrescriber();
      const result = securePrescriberDerivation(data, TEST_ENROLLMENT_KEY);
      result.dispose();
      expect(result.preimage).toHaveLength(0);
    });
  });

  describe('securePharmacyDerivation — PHI/PII wipe', () => {
    test('input is scrubbed after derivation', () => {
      const data = freshPharmacy();
      securePharmacyDerivation(data, TEST_ENROLLMENT_KEY);

      expect(data.serviceProviderId).toBe('');
      expect(data.serviceProviderIdQualifier).toBe(0);
    });

    test('dispose() clears preimage', () => {
      const data = freshPharmacy();
      const result = securePharmacyDerivation(data, TEST_ENROLLMENT_KEY);
      result.dispose();
      expect(result.preimage).toHaveLength(0);
    });
  });

  describe('InMemoryStore — no PHI/PII leakage', () => {
    test('store contains only wallet ID and entity type — no raw data', async () => {
      const store = new InMemoryStore();
      const memberData = freshMember();
      const result = secureMemberDerivation(memberData, TEST_ENROLLMENT_KEY);

      await store.saveWallet({
        walletId: result.walletId.toString(),
        entityType: 'member',
      });

      const retrieved = await store.getWallet(result.walletId.toString());
      expect(retrieved).not.toBeNull();

      const serialized = JSON.stringify(retrieved);
      expect(serialized).not.toContain('John');
      expect(serialized).not.toContain('Doe');
      expect(serialized).not.toContain('CARD123456789');
      expect(serialized).not.toContain('19850315');
      expect(serialized).not.toContain(TEST_ENROLLMENT_KEY);

      result.dispose();
    });
  });

  describe('Full secure pipeline: enter data → derive → scrub → store hash only', () => {
    test('end-to-end: no PHI/PII or enrollment key survives after wallet creation', async () => {
      const store = new InMemoryStore();

      let rawInput: MemberLocalData | null = freshMember();
      let enrollmentKey: string | null = TEST_ENROLLMENT_KEY;

      const result = secureMemberDerivation(rawInput, enrollmentKey);

      // Null out caller's references
      rawInput = null;
      enrollmentKey = null;

      await store.saveWallet({
        walletId: result.walletId.toString(),
        entityType: 'member',
      });

      result.dispose();

      const allIds = await store.listWalletIds();
      expect(allIds).toHaveLength(1);

      const storedWallet = await store.getWallet(allIds[0]!);
      expect(storedWallet!.entityType).toBe('member');
      expect(storedWallet!.walletId).not.toContain('John');
      expect(storedWallet!.walletId).not.toContain('Doe');
    });
  });

  describe('Enrollment Backup — NFC Key Export/Import', () => {
    const TEST_PIN = '123456';
    const TEST_WALLET_ID = '28948022309329048855892746252171976963317496166410141009864396001978282409984';

    test('round-trip: export then import recovers original key', () => {
      const key = generateEnrollmentKey();
      const backup = exportEnrollmentBackup(key, TEST_PIN, TEST_WALLET_ID, 0);
      const recovered = importEnrollmentBackup(backup, TEST_PIN);
      expect(recovered).toBe(key);
    });

    test('backup contains correct metadata', () => {
      const key = generateEnrollmentKey();
      const backup = exportEnrollmentBackup(key, TEST_PIN, TEST_WALLET_ID, 1);
      expect(backup.version).toBe(1);
      expect(backup.walletId).toBe(TEST_WALLET_ID);
      expect(backup.domainTag).toBe(1);
      expect(backup.createdAt).toBeGreaterThan(0);
      expect(backup.salt).toBeDefined();
      expect(backup.iv).toBeDefined();
      expect(backup.encryptedKey).toBeDefined();
    });

    test('wrong PIN fails decryption', () => {
      const key = generateEnrollmentKey();
      const backup = exportEnrollmentBackup(key, TEST_PIN, TEST_WALLET_ID, 0);
      expect(() => importEnrollmentBackup(backup, 'wrong-pin-99'))
        .toThrow('Decryption failed');
    });

    test('each export produces unique salt and IV', () => {
      const key = generateEnrollmentKey();
      const b1 = exportEnrollmentBackup(key, TEST_PIN, TEST_WALLET_ID, 0);
      const b2 = exportEnrollmentBackup(key, TEST_PIN, TEST_WALLET_ID, 0);
      expect(b1.salt).not.toBe(b2.salt);
      expect(b1.iv).not.toBe(b2.iv);
    });

    test('different PINs produce different ciphertexts', () => {
      const key = generateEnrollmentKey();
      const b1 = exportEnrollmentBackup(key, TEST_PIN, TEST_WALLET_ID, 0);
      const b2 = exportEnrollmentBackup(key, 'Different#Pin99', TEST_WALLET_ID, 0);
      expect(b1.encryptedKey).not.toBe(b2.encryptedKey);
    });

    test('rejects PIN shorter than minimum', () => {
      const key = generateEnrollmentKey();
      expect(() => exportEnrollmentBackup(key, '123', TEST_WALLET_ID, 0))
        .toThrow(`at least ${MIN_PIN_LENGTH}`);
    });

    test('tampered ciphertext fails', () => {
      const key = generateEnrollmentKey();
      const backup = exportEnrollmentBackup(key, TEST_PIN, TEST_WALLET_ID, 0);
      const tampered = { ...backup, encryptedKey: 'ff' + backup.encryptedKey.slice(2) };
      expect(() => importEnrollmentBackup(tampered, TEST_PIN))
        .toThrow('Decryption failed');
    });

    test('multiple backups of same key all recover correctly', () => {
      const key = generateEnrollmentKey();
      const pins = ['backup-pin-001!', 'backup-pin-002!', 'backup-pin-003!'];
      const backups = pins.map(pin =>
        exportEnrollmentBackup(key, pin, TEST_WALLET_ID, 0),
      );
      for (let i = 0; i < backups.length; i++) {
        expect(importEnrollmentBackup(backups[i], pins[i])).toBe(key);
      }
    });
  });
});
