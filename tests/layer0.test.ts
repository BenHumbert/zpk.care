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

import { Field, Poseidon } from 'o1js';
import {
  hashString,
  dateToField,
  codeToField,
  centsToField,
  quantityToField,
  buildMemberData,
  buildPrescriberData,
  buildPharmacyData,
  buildMedicationData,
  buildMedicationPricingData,
  buildTransactionHeaderData,
  generateMemberIdentifier,
  MerkleForest,
  ForestDomain,
  ForestMerkleWitness,
} from '../src/zkp/index.js';
import { InMemoryStore } from '../src/storage/index.js';
import type { MemberLocalData } from '../src/models/member.js';
import type { PrescriberLocalData } from '../src/models/prescriber.js';
import type { PharmacyLocalData } from '../src/models/pharmacy.js';
import type { MedicationLocalData } from '../src/models/medication.js';
import type { TransactionHeaderLocalData } from '../src/models/transaction-header.js';

// ─── Test Data ───────────────────────────────────────────

const testMember: MemberLocalData = {
  cardholderId: 'CARD123456789',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'John',
  lastName: 'Doe',
};

const testPrescriber: PrescriberLocalData = {
  prescriberIdQualifier: 1, // NPI
  prescriberId: '1234567890',
};

const testPharmacy: PharmacyLocalData = {
  serviceProviderIdQualifier: 1,
  serviceProviderId: '9876543210',
};

const testMedication: MedicationLocalData = {
  rxServiceRefNumQualifier: 1,
  rxServiceRefNumber: 'RX20240001',
  productServiceIdQualifier: 3, // NDC
  productServiceId: '00071015523',
  quantityDispensed: 30.0,
  fillNumber: 0,
  daysSupply: 30,
  compoundCode: 1,
  dawProductSelectionCode: 0,
};

const testTransactionHeader: TransactionHeaderLocalData = {
  binNumber: '004336',
  versionReleaseNumber: '01',
  transactionCode: 'B1',
  processorControlNumber: 'PCN001',
  dateOfService: '20260206',
};

// ─── Tests ───────────────────────────────────────────────

describe('Layer 0 — ZK Primitives & Data Models', () => {

  describe('Hash Utilities', () => {
    test('hashString produces deterministic Field output', () => {
      const h1 = hashString('test');
      const h2 = hashString('test');
      expect(h1.toString()).toBe(h2.toString());
    });

    test('hashString produces different output for different input', () => {
      const h1 = hashString('alice');
      const h2 = hashString('bob');
      expect(h1.toString()).not.toBe(h2.toString());
    });

    test('dateToField converts CCYYMMDD string to Field', () => {
      const f = dateToField('20260206');
      expect(f.toString()).toBe('20260206');
    });

    test('codeToField converts small integer', () => {
      const f = codeToField(1);
      expect(f.toString()).toBe('1');
    });

    test('centsToField converts dollar cents', () => {
      const f = centsToField(1599); // $15.99
      expect(f.toString()).toBe('1599');
    });

    test('quantityToField scales by 1000', () => {
      const f = quantityToField(30.5);
      expect(f.toString()).toBe('30500');
    });
  });

  describe('Data Model Commitments', () => {
    test('MemberData commitment is deterministic', () => {
      const m1 = buildMemberData(testMember);
      const m2 = buildMemberData(testMember);
      expect(m1.commitment().toString()).toBe(m2.commitment().toString());
    });

    test('MemberData commitment changes when data changes', () => {
      const m1 = buildMemberData(testMember);
      const m2 = buildMemberData({ ...testMember, firstName: 'Jane' });
      expect(m1.commitment().toString()).not.toBe(m2.commitment().toString());
    });

    test('PrescriberData commitment is deterministic', () => {
      const p1 = buildPrescriberData(testPrescriber);
      const p2 = buildPrescriberData(testPrescriber);
      expect(p1.commitment().toString()).toBe(p2.commitment().toString());
    });

    test('PharmacyData commitment is deterministic', () => {
      const p1 = buildPharmacyData(testPharmacy);
      const p2 = buildPharmacyData(testPharmacy);
      expect(p1.commitment().toString()).toBe(p2.commitment().toString());
    });

    test('MedicationData commitment is deterministic', () => {
      const m1 = buildMedicationData(testMedication);
      const m2 = buildMedicationData(testMedication);
      expect(m1.commitment().toString()).toBe(m2.commitment().toString());
    });

    test('TransactionHeaderData commitment is deterministic', () => {
      const t1 = buildTransactionHeaderData(testTransactionHeader);
      const t2 = buildTransactionHeaderData(testTransactionHeader);
      expect(t1.commitment().toString()).toBe(t2.commitment().toString());
    });

    test('generateMemberIdentifier is deterministic', () => {
      const id1 = generateMemberIdentifier(testMember);
      const id2 = generateMemberIdentifier(testMember);
      expect(id1.toString()).toBe(id2.toString());
    });

    test('generateMemberIdentifier differs per member', () => {
      const id1 = generateMemberIdentifier(testMember);
      const id2 = generateMemberIdentifier({ ...testMember, cardholderId: 'DIFFERENT' });
      expect(id1.toString()).not.toBe(id2.toString());
    });
  });

  describe('Merkle Forest', () => {
    test('empty forest produces a deterministic root', () => {
      const f1 = new MerkleForest();
      const f2 = new MerkleForest();
      expect(f1.getForestRoot().toString()).toBe(f2.getForestRoot().toString());
    });

    test('inserting a member leaf changes the forest root', () => {
      const forest = new MerkleForest();
      const rootBefore = forest.getForestRoot().toString();

      const memberData = buildMemberData(testMember);
      forest.setLeaf(ForestDomain.MEMBER, 0n, memberData.commitment());

      const rootAfter = forest.getForestRoot().toString();
      expect(rootBefore).not.toBe(rootAfter);
    });

    test('Merkle witness validates leaf inclusion', () => {
      const forest = new MerkleForest();
      const memberData = buildMemberData(testMember);
      const leaf = memberData.commitment();

      forest.setLeaf(ForestDomain.MEMBER, 0n, leaf);

      const witness = forest.getWitness(ForestDomain.MEMBER, 0n);
      const computedRoot = witness.calculateRoot(leaf);
      const actualRoot = forest.getTreeRoot(ForestDomain.MEMBER);

      expect(computedRoot.toString()).toBe(actualRoot.toString());
    });

    test('different domain trees are independent', () => {
      const forest = new MerkleForest();

      const memberData = buildMemberData(testMember);
      forest.setLeaf(ForestDomain.MEMBER, 0n, memberData.commitment());

      const prescriberData = buildPrescriberData(testPrescriber);
      forest.setLeaf(ForestDomain.PRESCRIBER, 0n, prescriberData.commitment());

      // Member tree root should differ from prescriber tree root
      const memberRoot = forest.getTreeRoot(ForestDomain.MEMBER);
      const prescriberRoot = forest.getTreeRoot(ForestDomain.PRESCRIBER);
      expect(memberRoot.toString()).not.toBe(prescriberRoot.toString());
    });

    test('forest root changes when any domain tree changes', () => {
      const forest = new MerkleForest();
      const memberData = buildMemberData(testMember);
      forest.setLeaf(ForestDomain.MEMBER, 0n, memberData.commitment());
      const rootAfterMember = forest.getForestRoot().toString();

      const prescriberData = buildPrescriberData(testPrescriber);
      forest.setLeaf(ForestDomain.PRESCRIBER, 0n, prescriberData.commitment());
      const rootAfterPrescriber = forest.getForestRoot().toString();

      expect(rootAfterMember).not.toBe(rootAfterPrescriber);
    });

    test('getTreeRoots returns all domain roots', () => {
      const forest = new MerkleForest();
      const roots = forest.getTreeRoots();
      expect(roots.size).toBe(6); // MEMBER, PRESCRIBER, PHARMACY, MEDICATION, ACCESS_CONTROL, TRANSACTION
    });
  });

  describe('Full Pipeline: Local Data → Commitment → Merkle Forest', () => {
    test('end-to-end: build forest from local data and verify inclusion', () => {
      const forest = new MerkleForest();

      // Build commitments from local data
      const memberCommitment = buildMemberData(testMember).commitment();
      const prescriberCommitment = buildPrescriberData(testPrescriber).commitment();
      const pharmacyCommitment = buildPharmacyData(testPharmacy).commitment();
      const medicationCommitment = buildMedicationData(testMedication).commitment();

      // Insert into forest
      forest.setLeaf(ForestDomain.MEMBER, 0n, memberCommitment);
      forest.setLeaf(ForestDomain.PRESCRIBER, 0n, prescriberCommitment);
      forest.setLeaf(ForestDomain.PHARMACY, 0n, pharmacyCommitment);
      forest.setLeaf(ForestDomain.MEDICATION, 0n, medicationCommitment);

      // Verify each inclusion
      const memberWitness = forest.getWitness(ForestDomain.MEMBER, 0n);
      expect(memberWitness.calculateRoot(memberCommitment).toString())
        .toBe(forest.getTreeRoot(ForestDomain.MEMBER).toString());

      const prescriberWitness = forest.getWitness(ForestDomain.PRESCRIBER, 0n);
      expect(prescriberWitness.calculateRoot(prescriberCommitment).toString())
        .toBe(forest.getTreeRoot(ForestDomain.PRESCRIBER).toString());

      const pharmacyWitness = forest.getWitness(ForestDomain.PHARMACY, 0n);
      expect(pharmacyWitness.calculateRoot(pharmacyCommitment).toString())
        .toBe(forest.getTreeRoot(ForestDomain.PHARMACY).toString());

      const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
      expect(medicationWitness.calculateRoot(medicationCommitment).toString())
        .toBe(forest.getTreeRoot(ForestDomain.MEDICATION).toString());

      // Forest root should be non-trivial
      const forestRoot = forest.getForestRoot();
      expect(forestRoot.toString()).not.toBe('0');
    });
  });

  describe('InMemoryStore (hash-only — no raw PHI/PII)', () => {
    test('save and retrieve wallet record (hash only)', async () => {
      const store = new InMemoryStore();
      const walletId = generateMemberIdentifier(testMember).toString();

      await store.saveWallet({
        walletId,
        entityType: 'member',
      });

      const retrieved = await store.getWallet(walletId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.walletId).toBe(walletId);
      expect(retrieved!.entityType).toBe('member');
      // Verify: NO raw PHI/PII properties exist on the record
      expect((retrieved as any).firstName).toBeUndefined();
      expect((retrieved as any).lastName).toBeUndefined();
      expect((retrieved as any).dateOfBirth).toBeUndefined();
    });

    test('list wallet IDs', async () => {
      const store = new InMemoryStore();
      const id1 = generateMemberIdentifier(testMember).toString();
      const id2 = generateMemberIdentifier({ ...testMember, cardholderId: 'OTHER' }).toString();

      await store.saveWallet({ walletId: id1, entityType: 'member' });
      await store.saveWallet({ walletId: id2, entityType: 'member' });

      const ids = await store.listWalletIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });

    test('delete wallet record', async () => {
      const store = new InMemoryStore();
      const walletId = generateMemberIdentifier(testMember).toString();

      await store.saveWallet({ walletId, entityType: 'member' });
      await store.deleteWallet(walletId);

      const retrieved = await store.getWallet(walletId);
      expect(retrieved).toBeNull();
    });

    test('save and retrieve proof data', async () => {
      const store = new InMemoryStore();
      await store.saveProof('proof-001', '{"proof":"base64data"}');
      const proof = await store.getProof('proof-001');
      expect(proof).toBe('{"proof":"base64data"}');
    });
  });
});
