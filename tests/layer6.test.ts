import { Field, Poseidon } from 'o1js';
import {
  FormularyEntry,
  TIER_GENERIC,
  TIER_PREFERRED,
  TIER_NON_PREFERRED,
  TIER_SPECIALTY,
  buildFormularyEntry,
} from '../src/access-control/formulary-entry.js';
import type { FormularyEntryLocalData } from '../src/access-control/formulary-entry.js';
import {
  PriorAuthData,
  buildPriorAuthData,
} from '../src/access-control/prior-auth-data.js';
import type { PriorAuthLocalData } from '../src/access-control/prior-auth-data.js';
import { FormularyRegistry, FORMULARY_TREE_HEIGHT } from '../src/access-control/formulary-registry.js';
import {
  AccessControlProgram,
  AccessControlOutput,
} from '../src/access-control/access-control-program.js';
import { AccessControlService } from '../src/access-control/access-control-service.js';
import { AccessVerificationService } from '../src/access-control/access-verification-service.js';
import { NftData, NFT_TYPE_ELIGIBILITY, NFT_TYPE_PRESCRIPTION } from '../src/nft/nft-data.js';
import { EligibilityData, COVERAGE_PHARMACY } from '../src/eligibility/eligibility-data.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { hashString, quantityToField } from '../src/zkp/hash-utils.js';
import { InMemoryStore } from '../src/storage/local-store.js';

// ─── Test Data ───────────────────────────────────────────

/** Lisinopril — generic, no PA required */
const lisinoprilLocal: FormularyEntryLocalData = {
  ndc: '00071015523',
  tierLevel: 1,
  copayAmount: 1000,  // $10
  requiresPriorAuth: false,
  maxQuantityPerFill: 90,
  maxDaySupply: 90,
  stepTherapyRequired: false,
};

/** Ozempic — non-preferred, requires PA */
const ozempicLocal: FormularyEntryLocalData = {
  ndc: '00169416212',
  tierLevel: 3,
  copayAmount: 5000,  // $50
  requiresPriorAuth: true,
  maxQuantityPerFill: 4,
  maxDaySupply: 28,
  stepTherapyRequired: true,
};

const samplePALocal: PriorAuthLocalData = {
  ndc: '00169416212',  // matches Ozempic
  memberWalletId: '12345678901234567890',
  prescriberWalletId: '98765432109876543210',
  approvalDate: '20260101',
  expirationDate: '20261231',
  approvedQuantity: 12,  // 12 units approved for the year
  authorizationCode: 'PA-2026-OZEM-001',
};

/** Helper: create a FormularyRegistry with test entries */
function createTestFormulary(): { registry: FormularyRegistry; lisinoprilIdx: bigint; ozempicIdx: bigint } {
  const registry = new FormularyRegistry();
  const { index: lisinoprilIdx } = registry.addEntry(buildFormularyEntry(lisinoprilLocal));
  const { index: ozempicIdx } = registry.addEntry(buildFormularyEntry(ozempicLocal));
  return { registry, lisinoprilIdx, ozempicIdx };
}

/** Helper: create EligibilityData with a real formulary root */
function createTestEligibilityData(formularyRoot: Field): EligibilityData {
  return new EligibilityData({
    planIdHash: hashString('PLAN-RX-2026'),
    groupIdHash: hashString('GRP-ACME-001'),
    effectiveDate: Field(20260101),
    terminationDate: Field(20261231),
    copayAmountCents: Field(2000),
    coverageType: COVERAGE_PHARMACY,
    formularyRoot,
  });
}

/** Helper: create a MerkleForest with eligibility data and optional PA */
function createTestForest(
  eligData: EligibilityData,
  paData?: PriorAuthData,
): MerkleForest {
  const forest = new MerkleForest();
  forest.setLeaf(ForestDomain.MEMBER, 0n, Poseidon.hash([Field(42)]));
  forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligData.commitment());
  if (paData) {
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, 1n, paData.commitment());
  }
  return forest;
}

/** Helper: create an NftData from a forest */
function createTestNft(forest: MerkleForest): NftData {
  return new NftData({
    nftType: NFT_TYPE_ELIGIBILITY,
    forestRoot: forest.getForestRoot(),
    issuerWalletId: Field(999),
    subjectWalletId: Field(123),
    issuedAt: Field(20260101),
    expiresAt: Field(0),
    revoked: Field(0),
  });
}

// ─── Tests ───────────────────────────────────────────────

describe('Layer 6 — Access Control / Medication Access (Use Case B)', () => {

  // ─── FormularyEntry Model ───────────────────────────────
  describe('FormularyEntry Model', () => {
    it('commitment is deterministic', () => {
      const a = buildFormularyEntry(lisinoprilLocal);
      const b = buildFormularyEntry(lisinoprilLocal);
      expect(a.commitment().toString()).toBe(b.commitment().toString());
    });

    it('commitment changes when any field changes', () => {
      const base = buildFormularyEntry(lisinoprilLocal);
      const modified = buildFormularyEntry({ ...lisinoprilLocal, tierLevel: 2 });
      expect(base.commitment().toString()).not.toBe(modified.commitment().toString());

      const modified2 = buildFormularyEntry({ ...lisinoprilLocal, copayAmount: 2000 });
      expect(base.commitment().toString()).not.toBe(modified2.commitment().toString());
    });

    it('tier level constants have correct values', () => {
      expect(TIER_GENERIC.toString()).toBe('1');
      expect(TIER_PREFERRED.toString()).toBe('2');
      expect(TIER_NON_PREFERRED.toString()).toBe('3');
      expect(TIER_SPECIALTY.toString()).toBe('4');
    });

    it('buildFormularyEntry from local data', () => {
      const entry = buildFormularyEntry(lisinoprilLocal);
      expect(entry.ndcHash.toString()).toBe(hashString('00071015523').toString());
      expect(entry.tierLevel.toString()).toBe('1');
      expect(entry.copayAmountCents.toString()).toBe('1000');
      expect(entry.requiresPriorAuth.toString()).toBe('0');
      expect(entry.maxQuantityPerFill.toString()).toBe(quantityToField(90).toString());
      expect(entry.maxDaySupply.toString()).toBe('90');
      expect(entry.stepTherapyRequired.toString()).toBe('0');
    });
  });

  // ─── PriorAuthData Model ───────────────────────────────
  describe('PriorAuthData Model', () => {
    it('commitment is deterministic', () => {
      const a = buildPriorAuthData(samplePALocal);
      const b = buildPriorAuthData(samplePALocal);
      expect(a.commitment().toString()).toBe(b.commitment().toString());
    });

    it('commitment changes when any field changes', () => {
      const base = buildPriorAuthData(samplePALocal);
      const modified = buildPriorAuthData({
        ...samplePALocal,
        approvedQuantity: 24,
      });
      expect(base.commitment().toString()).not.toBe(modified.commitment().toString());
    });

    it('buildPriorAuthData from local data', () => {
      const pa = buildPriorAuthData(samplePALocal);
      expect(pa.ndcHash.toString()).toBe(hashString('00169416212').toString());
      expect(pa.memberWalletId.toString()).toBe(
        Field(BigInt('12345678901234567890')).toString(),
      );
      expect(pa.approvalDate.toString()).toBe('20260101');
      expect(pa.expirationDate.toString()).toBe('20261231');
    });

    it('commitment matches manual Poseidon.hash of 7 fields', () => {
      const pa = buildPriorAuthData(samplePALocal);
      const manual = Poseidon.hash([
        pa.ndcHash,
        pa.memberWalletId,
        pa.prescriberWalletId,
        pa.approvalDate,
        pa.expirationDate,
        pa.approvedQuantity,
        pa.authCodeHash,
      ]);
      expect(pa.commitment().toString()).toBe(manual.toString());
    });
  });

  // ─── FormularyRegistry ─────────────────────────────────
  describe('FormularyRegistry', () => {
    it('empty registry has correct root', () => {
      const registry = new FormularyRegistry();
      const { MerkleTree } = require('o1js');
      const emptyTree = new MerkleTree(FORMULARY_TREE_HEIGHT);
      expect(registry.getRoot().toString()).toBe(emptyTree.getRoot().toString());
    });

    it('addEntry changes root', () => {
      const registry = new FormularyRegistry();
      const emptyRoot = registry.getRoot().toString();
      registry.addEntry(buildFormularyEntry(lisinoprilLocal));
      expect(registry.getRoot().toString()).not.toBe(emptyRoot);
    });

    it('witness proves entry inclusion', () => {
      const registry = new FormularyRegistry();
      const entry = buildFormularyEntry(lisinoprilLocal);
      const { index } = registry.addEntry(entry);
      const witness = registry.getEntryWitness(index);
      const computedRoot = witness.calculateRoot(entry.commitment());
      expect(computedRoot.toString()).toBe(registry.getRoot().toString());
    });

    it('count tracks entries correctly', () => {
      const registry = new FormularyRegistry();
      expect(registry.count).toBe(0);
      registry.addEntry(buildFormularyEntry(lisinoprilLocal));
      expect(registry.count).toBe(1);
      registry.addEntry(buildFormularyEntry(ozempicLocal));
      expect(registry.count).toBe(2);
    });
  });

  // ─── AccessControlProgram — proveFormularyAccess ───────
  describe('AccessControlProgram — proveFormularyAccess', () => {
    beforeAll(async () => {
      await AccessControlProgram.compile();
    }, 120_000);

    it('valid formulary access generates proof', async () => {
      const { registry, lisinoprilIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const forest = createTestForest(eligData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const entry = registry.getEntry(lisinoprilIdx)!;
      const formularyWitness = registry.getEntryWitness(lisinoprilIdx);

      const result = await AccessControlProgram.proveFormularyAccess(
        nftData,
        eligData,
        forestRoots,
        eligWitness,
        entry,
        formularyWitness,
        entry.ndcHash,
        quantityToField(30),  // 30 units requested (within 90 max)
        Field(30),            // 30 day supply (within 90 max)
      );

      const output = result.proof.publicOutput;
      expect(output.nftCommitment.toString()).toBe(nftData.commitment().toString());
      expect(output.medicationHash.toString()).toBe(entry.ndcHash.toString());
      expect(output.tierLevel.toString()).toBe('1');
      expect(output.copayAmount.toString()).toBe('1000');
      expect(output.priorAuthRequired.toString()).toBe('0');
    }, 60_000);

    it('proof verifies standalone', async () => {
      const { registry, lisinoprilIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const forest = createTestForest(eligData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const entry = registry.getEntry(lisinoprilIdx)!;
      const formularyWitness = registry.getEntryWitness(lisinoprilIdx);

      const result = await AccessControlProgram.proveFormularyAccess(
        nftData, eligData, forestRoots, eligWitness,
        entry, formularyWitness,
        entry.ndcHash, quantityToField(30), Field(30),
      );

      const ok = await AccessControlProgram.verify(result.proof);
      expect(ok).toBe(true);
    }, 60_000);

    it('rejects wrong NFT type', async () => {
      const { registry, lisinoprilIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const forest = createTestForest(eligData);
      // Create NFT with wrong type
      const nftData = new NftData({
        nftType: NFT_TYPE_PRESCRIPTION,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: Field(999),
        subjectWalletId: Field(123),
        issuedAt: Field(20260101),
        expiresAt: Field(0),
        revoked: Field(0),
      });
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const entry = registry.getEntry(lisinoprilIdx)!;
      const formularyWitness = registry.getEntryWitness(lisinoprilIdx);

      await expect(
        AccessControlProgram.proveFormularyAccess(
          nftData, eligData, forestRoots, eligWitness,
          entry, formularyWitness,
          entry.ndcHash, quantityToField(30), Field(30),
        ),
      ).rejects.toThrow();
    }, 30_000);

    it('rejects quantity exceeding max per fill', async () => {
      const { registry, lisinoprilIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const forest = createTestForest(eligData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const entry = registry.getEntry(lisinoprilIdx)!;
      const formularyWitness = registry.getEntryWitness(lisinoprilIdx);

      // Request 120 units, max is 90
      await expect(
        AccessControlProgram.proveFormularyAccess(
          nftData, eligData, forestRoots, eligWitness,
          entry, formularyWitness,
          entry.ndcHash, quantityToField(120), Field(30),
        ),
      ).rejects.toThrow();
    }, 30_000);

    it('rejects day supply exceeding max', async () => {
      const { registry, lisinoprilIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const forest = createTestForest(eligData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const entry = registry.getEntry(lisinoprilIdx)!;
      const formularyWitness = registry.getEntryWitness(lisinoprilIdx);

      // Request 120 day supply, max is 90
      await expect(
        AccessControlProgram.proveFormularyAccess(
          nftData, eligData, forestRoots, eligWitness,
          entry, formularyWitness,
          entry.ndcHash, quantityToField(30), Field(120),
        ),
      ).rejects.toThrow();
    }, 30_000);
  });

  // ─── AccessControlProgram — provePriorAuth ─────────────
  describe('AccessControlProgram — provePriorAuth', () => {
    it('valid prior auth generates proof', async () => {
      const { registry, ozempicIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const paData = buildPriorAuthData(samplePALocal);
      const forest = createTestForest(eligData, paData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const paWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 1n);
      const entry = registry.getEntry(ozempicIdx)!;
      const formularyWitness = registry.getEntryWitness(ozempicIdx);

      const result = await AccessControlProgram.provePriorAuth(
        nftData, eligData, forestRoots,
        eligWitness, paWitness, paData,
        entry, formularyWitness,
        Field(20260615),  // current date mid-year
        quantityToField(4),  // 4 units (within 12 approved)
      );

      const output = result.proof.publicOutput;
      expect(output.tierLevel.toString()).toBe('3');
      expect(output.priorAuthRequired.toString()).toBe('1');

      const ok = await AccessControlProgram.verify(result.proof);
      expect(ok).toBe(true);
    }, 60_000);

    it('rejects expired PA', async () => {
      const { registry, ozempicIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const paData = buildPriorAuthData(samplePALocal);
      const forest = createTestForest(eligData, paData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const paWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 1n);
      const entry = registry.getEntry(ozempicIdx)!;
      const formularyWitness = registry.getEntryWitness(ozempicIdx);

      // Date past expiration (20270115 > 20261231)
      await expect(
        AccessControlProgram.provePriorAuth(
          nftData, eligData, forestRoots,
          eligWitness, paWitness, paData,
          entry, formularyWitness,
          Field(20270115),
          quantityToField(4),
        ),
      ).rejects.toThrow();
    }, 30_000);

    it('rejects quantity exceeding PA approved quantity', async () => {
      const { registry, ozempicIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const paData = buildPriorAuthData(samplePALocal);
      const forest = createTestForest(eligData, paData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const paWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 1n);
      const entry = registry.getEntry(ozempicIdx)!;
      const formularyWitness = registry.getEntryWitness(ozempicIdx);

      // Request 20 units, only 12 approved
      await expect(
        AccessControlProgram.provePriorAuth(
          nftData, eligData, forestRoots,
          eligWitness, paWitness, paData,
          entry, formularyWitness,
          Field(20260615),
          quantityToField(20),
        ),
      ).rejects.toThrow();
    }, 30_000);

    it('rejects when formulary entry does not require PA', async () => {
      const { registry, lisinoprilIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      // PA for Lisinopril (which does NOT require PA)
      const paLocal: PriorAuthLocalData = {
        ...samplePALocal,
        ndc: '00071015523',  // Lisinopril NDC
      };
      const paData = buildPriorAuthData(paLocal);
      const forest = createTestForest(eligData, paData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const paWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 1n);
      const entry = registry.getEntry(lisinoprilIdx)!;
      const formularyWitness = registry.getEntryWitness(lisinoprilIdx);

      // Lisinopril has requiresPriorAuth = 0 — should reject
      await expect(
        AccessControlProgram.provePriorAuth(
          nftData, eligData, forestRoots,
          eligWitness, paWitness, paData,
          entry, formularyWitness,
          Field(20260615),
          quantityToField(30),
        ),
      ).rejects.toThrow();
    }, 30_000);
  });

  // ─── AccessControlService ──────────────────────────────
  describe('AccessControlService', () => {
    let store: InstanceType<typeof InMemoryStore>;
    let registry: FormularyRegistry;
    let service: AccessControlService;
    let lisinoprilIdx: bigint;
    let ozempicIdx: bigint;

    beforeAll(() => {
      store = new InMemoryStore();
      const result = createTestFormulary();
      registry = result.registry;
      lisinoprilIdx = result.lisinoprilIdx;
      ozempicIdx = result.ozempicIdx;
      service = new AccessControlService(store, registry);
    });

    it('addFormularyEntry updates registry', () => {
      const newRegistry = new FormularyRegistry();
      const newService = new AccessControlService(store, newRegistry);
      const entry = buildFormularyEntry({
        ndc: '12345678901',
        tierLevel: 2,
        copayAmount: 3000,
        requiresPriorAuth: false,
        maxQuantityPerFill: 60,
        maxDaySupply: 30,
        stepTherapyRequired: false,
      });
      const { index, newRoot } = newService.addFormularyEntry(entry);
      expect(index).toBe(0n);
      expect(newRoot.toString()).toBe(newRegistry.getRoot().toString());
      expect(newRegistry.count).toBe(1);
    });

    it('createPriorAuth adds PA to ACCESS_CONTROL tree', () => {
      const eligData = createTestEligibilityData(registry.getRoot());
      const forest = createTestForest(eligData);
      const paData = buildPriorAuthData(samplePALocal);

      const rootBefore = forest.getForestRoot().toString();
      const { paCommitment, newForestRoot } = service.createPriorAuth(paData, forest, 1n);

      expect(paCommitment.toString()).toBe(paData.commitment().toString());
      expect(newForestRoot.toString()).not.toBe(rootBefore);
      // Verify the PA leaf is set
      expect(forest.getLeaf(ForestDomain.ACCESS_CONTROL, 1n).toString())
        .toBe(paData.commitment().toString());
    });

    it('proveFormularyAccess generates verifiable proof', async () => {
      const eligData = createTestEligibilityData(registry.getRoot());
      const forest = createTestForest(eligData);
      const nftData = createTestNft(forest);
      const entry = registry.getEntry(lisinoprilIdx)!;

      const proof = await service.proveFormularyAccess(
        nftData, eligData, forest, 0n, lisinoprilIdx,
        entry.ndcHash, quantityToField(30), Field(30),
      );

      const ok = await AccessControlProgram.verify(proof);
      expect(ok).toBe(true);
    }, 60_000);

    it('provePriorAuth generates verifiable proof', async () => {
      const eligData = createTestEligibilityData(registry.getRoot());
      const paData = buildPriorAuthData(samplePALocal);
      const forest = createTestForest(eligData, paData);
      const nftData = createTestNft(forest);

      const proof = await service.provePriorAuth(
        nftData, eligData, forest, 0n, 1n,
        paData, ozempicIdx,
        Field(20260615),
        quantityToField(4),
      );

      const ok = await AccessControlProgram.verify(proof);
      expect(ok).toBe(true);
    }, 60_000);

    it('full flow: add formulary + create PA + prove access', async () => {
      // Fresh setup
      const freshRegistry = new FormularyRegistry();
      const freshService = new AccessControlService(store, freshRegistry);

      // 1. Add medications to formulary
      const { index: lIdx } = freshService.addFormularyEntry(
        buildFormularyEntry(lisinoprilLocal),
      );
      const { index: oIdx } = freshService.addFormularyEntry(
        buildFormularyEntry(ozempicLocal),
      );

      // 2. Create eligibility data with formulary root
      const eligData = createTestEligibilityData(freshRegistry.getRoot());

      // 3. Build forest with eligibility data
      const forest = createTestForest(eligData);

      // 4. Create PA for Ozempic in ACCESS_CONTROL tree
      const paData = buildPriorAuthData(samplePALocal);
      freshService.createPriorAuth(paData, forest, 1n);

      // 5. Build NFT with updated forest root
      const nftData = createTestNft(forest);

      // 6. Prove formulary access for Lisinopril (no PA needed)
      const lisinoprilEntry = freshRegistry.getEntry(lIdx)!;
      const formularyProof = await freshService.proveFormularyAccess(
        nftData, eligData, forest, 0n, lIdx,
        lisinoprilEntry.ndcHash, quantityToField(30), Field(30),
      );
      expect(formularyProof.publicOutput.priorAuthRequired.toString()).toBe('0');

      // 7. Prove PA for Ozempic
      const paProof = await freshService.provePriorAuth(
        nftData, eligData, forest, 0n, 1n,
        paData, oIdx,
        Field(20260615),
        quantityToField(4),
      );
      expect(paProof.publicOutput.priorAuthRequired.toString()).toBe('1');
    }, 120_000);
  });

  // ─── AccessVerificationService ─────────────────────────
  describe('AccessVerificationService', () => {
    const verifier = new AccessVerificationService();
    let formularyProofNoPA: Awaited<ReturnType<typeof AccessControlProgram.proveFormularyAccess>>['proof'];
    let formularyProofWithPA: Awaited<ReturnType<typeof AccessControlProgram.proveFormularyAccess>>['proof'];
    let paProof: Awaited<ReturnType<typeof AccessControlProgram.provePriorAuth>>['proof'];

    beforeAll(async () => {
      const { registry, lisinoprilIdx, ozempicIdx } = createTestFormulary();
      const eligData = createTestEligibilityData(registry.getRoot());
      const paData = buildPriorAuthData(samplePALocal);
      const forest = createTestForest(eligData, paData);
      const nftData = createTestNft(forest);
      const forestRoots = ForestRoots.fromForest(forest);
      const eligWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const paWitness = forest.getWitness(ForestDomain.ACCESS_CONTROL, 1n);

      // Formulary proof for Lisinopril (no PA required)
      const lisinoprilEntry = registry.getEntry(lisinoprilIdx)!;
      const lisinoprilWitness = registry.getEntryWitness(lisinoprilIdx);
      const r1 = await AccessControlProgram.proveFormularyAccess(
        nftData, eligData, forestRoots, eligWitness,
        lisinoprilEntry, lisinoprilWitness,
        lisinoprilEntry.ndcHash, quantityToField(30), Field(30),
      );
      formularyProofNoPA = r1.proof;

      // Formulary proof for Ozempic (PA required)
      const ozempicEntry = registry.getEntry(ozempicIdx)!;
      const ozempicWitness = registry.getEntryWitness(ozempicIdx);
      const r2 = await AccessControlProgram.proveFormularyAccess(
        nftData, eligData, forestRoots, eligWitness,
        ozempicEntry, ozempicWitness,
        ozempicEntry.ndcHash, quantityToField(2), Field(28),
      );
      formularyProofWithPA = r2.proof;

      // PA proof for Ozempic
      const r3 = await AccessControlProgram.provePriorAuth(
        nftData, eligData, forestRoots,
        eligWitness, paWitness, paData,
        ozempicEntry, ozempicWitness,
        Field(20260615), quantityToField(4),
      );
      paProof = r3.proof;
    }, 180_000);

    it('verifyFormularyAccess accepts valid proof', async () => {
      const result = await verifier.verifyFormularyAccess(formularyProofNoPA);
      expect(result.isValid).toBe(true);
      expect(result.tierLevel).toBe('1');
      expect(result.copayAmount).toBe('1000');
      expect(result.priorAuthRequired).toBe(false);
    });

    it('verifyPriorAuth accepts valid proof', async () => {
      const result = await verifier.verifyPriorAuth(paProof);
      expect(result.isValid).toBe(true);
      expect(result.priorAuthRequired).toBe(true);
    });

    it('fullAccessCheck succeeds without PA when not required', async () => {
      const result = await verifier.fullAccessCheck(formularyProofNoPA);
      expect(result.formularyAccessValid).toBe(true);
      expect(result.priorAuthNeeded).toBe(false);
      expect(result.priorAuthValid).toBeUndefined();
      expect(result.overallValid).toBe(true);
      expect(result.details.length).toBeGreaterThan(0);
    });

    it('fullAccessCheck fails when PA required but not provided', async () => {
      const result = await verifier.fullAccessCheck(formularyProofWithPA);
      expect(result.formularyAccessValid).toBe(true);
      expect(result.priorAuthNeeded).toBe(true);
      expect(result.priorAuthValid).toBeUndefined();
      expect(result.overallValid).toBe(false);
      expect(result.details.some(d => d.includes('MISSING'))).toBe(true);
    });
  });
});
