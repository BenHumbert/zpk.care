/**
 * Claim Accumulator Tests — MerkleTree-backed drug history index.
 *
 * Tests the ClaimAccumulatorService: leaf hashing, tree append,
 * index queries, witness verification, and export/restore round-trip.
 */

import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  CLAIM_TREE_HEIGHT,
  ClaimAccumulatorWitness,
  computeClaimLeafHash,
  type ClaimLeaf,
  type ClaimMetadata,
} from '../src/l2/claim-accumulator-types.js';
import { ClaimAccumulatorService } from '../src/l2/claim-accumulator-service.js';

// ─── Test Data ──────────────────────────────────────────────

const MEMBER_A = '1001';
const MEMBER_B = '1002';
const PHARMACY_X = '2001';
const PHARMACY_Y = '2002';
const PRESCRIBER_P = '3001';
const PRESCRIBER_Q = '3002';
const NDC_LISINOPRIL = Poseidon.hash([Field(BigInt('00378180510'))]).toBigInt().toString();
const NDC_METFORMIN = Poseidon.hash([Field(BigInt('00093721510'))]).toBigInt().toString();
const NDC_ATORVASTATIN = Poseidon.hash([Field(BigInt('00378217710'))]).toBigInt().toString();

function makeLeaf(overrides: Partial<ClaimLeaf> = {}): ClaimLeaf {
  return {
    memberWalletId: MEMBER_A,
    ndcHash: NDC_LISINOPRIL,
    pharmacyWalletId: PHARMACY_X,
    prescriberWalletId: PRESCRIBER_P,
    dateOfService: '20260115',
    patientPayCents: '1000',
    planPayCents: '5000',
    operationType: '1',
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<ClaimMetadata> = {}): ClaimMetadata {
  return {
    receiptId: 'rcpt-001',
    timestamp: Date.now(),
    ndc: '00378-1805-10',
    brandName: 'Lisinopril',
    tierLevel: 1,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('Claim Accumulator Types', () => {
  test('CLAIM_TREE_HEIGHT is 24', () => {
    expect(CLAIM_TREE_HEIGHT).toBe(24);
  });

  test('computeClaimLeafHash produces deterministic Poseidon hash', () => {
    const leaf = makeLeaf();
    const hash1 = computeClaimLeafHash(leaf);
    const hash2 = computeClaimLeafHash(leaf);
    expect(hash1.toString()).toBe(hash2.toString());
  });

  test('computeClaimLeafHash changes with any field change', () => {
    const base = makeLeaf();
    const baseHash = computeClaimLeafHash(base).toString();

    // Change each field and verify hash differs
    const fields: (keyof ClaimLeaf)[] = [
      'memberWalletId', 'ndcHash', 'pharmacyWalletId', 'prescriberWalletId',
      'dateOfService', 'patientPayCents', 'planPayCents', 'operationType',
    ];
    for (const field of fields) {
      const modified = { ...base, [field]: '99999' };
      const modifiedHash = computeClaimLeafHash(modified).toString();
      expect(modifiedHash).not.toBe(baseHash);
    }
  });

  test('computeClaimLeafHash matches manual Poseidon.hash of 8 fields', () => {
    const leaf = makeLeaf();
    const expected = Poseidon.hash([
      Field(BigInt(leaf.memberWalletId)),
      Field(BigInt(leaf.ndcHash)),
      Field(BigInt(leaf.pharmacyWalletId)),
      Field(BigInt(leaf.prescriberWalletId)),
      Field(BigInt(leaf.dateOfService)),
      Field(BigInt(leaf.patientPayCents)),
      Field(BigInt(leaf.planPayCents)),
      Field(BigInt(leaf.operationType)),
    ]);
    expect(computeClaimLeafHash(leaf).toString()).toBe(expected.toString());
  });

  test('ClaimAccumulatorWitness has correct height', () => {
    const tree = new MerkleTree(CLAIM_TREE_HEIGHT);
    const witness = new ClaimAccumulatorWitness(tree.getWitness(0n));
    expect(witness).toBeDefined();
    // Height = 24, so witness path length = 23
    expect(witness.toJSON().path.length).toBe(CLAIM_TREE_HEIGHT - 1);
  });
});

describe('ClaimAccumulatorService — Basic Operations', () => {
  let service: ClaimAccumulatorService;

  beforeEach(() => {
    service = new ClaimAccumulatorService();
  });

  test('starts with zero leaves and empty root', () => {
    expect(service.getLeafCount()).toBe(0n);
    // Empty tree root should be the same as a fresh MerkleTree(24)
    const emptyTree = new MerkleTree(CLAIM_TREE_HEIGHT);
    expect(service.getRoot()).toBe(emptyTree.getRoot().toBigInt());
  });

  test('appendClaim returns entry with correct leafIndex', () => {
    const entry0 = service.appendClaim(makeLeaf(), makeMetadata());
    expect(entry0.leafIndex).toBe(0n);

    const entry1 = service.appendClaim(
      makeLeaf({ memberWalletId: MEMBER_B }),
      makeMetadata({ receiptId: 'rcpt-002' }),
    );
    expect(entry1.leafIndex).toBe(1n);

    expect(service.getLeafCount()).toBe(2n);
  });

  test('appendClaim stores correct leafHash', () => {
    const leaf = makeLeaf();
    const entry = service.appendClaim(leaf, makeMetadata());
    const expectedHash = computeClaimLeafHash(leaf).toString();
    expect(entry.leafHash).toBe(expectedHash);
  });

  test('appendClaim changes the tree root', () => {
    const rootBefore = service.getRoot();
    service.appendClaim(makeLeaf(), makeMetadata());
    const rootAfter = service.getRoot();
    expect(rootAfter).not.toBe(rootBefore);
  });

  test('getEntry retrieves stored entry', () => {
    const original = service.appendClaim(makeLeaf(), makeMetadata());
    const retrieved = service.getEntry(0n);
    expect(retrieved).toBeDefined();
    expect(retrieved!.leafHash).toBe(original.leafHash);
    expect(retrieved!.leaf.memberWalletId).toBe(MEMBER_A);
    expect(retrieved!.metadata.receiptId).toBe('rcpt-001');
  });

  test('getEntry returns undefined for non-existent index', () => {
    expect(service.getEntry(999n)).toBeUndefined();
  });
});

describe('ClaimAccumulatorService — Index Queries', () => {
  let service: ClaimAccumulatorService;

  beforeEach(() => {
    service = new ClaimAccumulatorService();

    // Claim 0: Member A, Pharmacy X, Prescriber P, Lisinopril
    service.appendClaim(
      makeLeaf(),
      makeMetadata({ receiptId: 'rcpt-001' }),
    );

    // Claim 1: Member A, Pharmacy Y, Prescriber P, Metformin
    service.appendClaim(
      makeLeaf({
        pharmacyWalletId: PHARMACY_Y,
        ndcHash: NDC_METFORMIN,
        dateOfService: '20260120',
      }),
      makeMetadata({ receiptId: 'rcpt-002', ndc: '00093-7215-10', brandName: 'Metformin' }),
    );

    // Claim 2: Member B, Pharmacy X, Prescriber Q, Lisinopril
    service.appendClaim(
      makeLeaf({
        memberWalletId: MEMBER_B,
        prescriberWalletId: PRESCRIBER_Q,
        dateOfService: '20260125',
      }),
      makeMetadata({ receiptId: 'rcpt-003' }),
    );

    // Claim 3: Member A, Pharmacy X, Prescriber P, Atorvastatin (reversal)
    service.appendClaim(
      makeLeaf({
        ndcHash: NDC_ATORVASTATIN,
        operationType: '2',
        dateOfService: '20260130',
      }),
      makeMetadata({ receiptId: 'rcpt-004', ndc: '00378-2177-10', brandName: 'Atorvastatin' }),
    );
  });

  test('getClaimsByMember returns correct claims', () => {
    const memberAClaims = service.getClaimsByMember(MEMBER_A);
    expect(memberAClaims.length).toBe(3); // claims 0, 1, 3
    expect(memberAClaims.map(c => c.leafIndex)).toEqual([0n, 1n, 3n]);

    const memberBClaims = service.getClaimsByMember(MEMBER_B);
    expect(memberBClaims.length).toBe(1); // claim 2
    expect(memberBClaims[0].leafIndex).toBe(2n);
  });

  test('getClaimsByPharmacy returns correct claims', () => {
    const pharmacyXClaims = service.getClaimsByPharmacy(PHARMACY_X);
    expect(pharmacyXClaims.length).toBe(3); // claims 0, 2, 3
    expect(pharmacyXClaims.map(c => c.leafIndex)).toEqual([0n, 2n, 3n]);

    const pharmacyYClaims = service.getClaimsByPharmacy(PHARMACY_Y);
    expect(pharmacyYClaims.length).toBe(1); // claim 1
  });

  test('getClaimsByPrescriber returns correct claims', () => {
    const prescriberPClaims = service.getClaimsByPrescriber(PRESCRIBER_P);
    expect(prescriberPClaims.length).toBe(3); // claims 0, 1, 3

    const prescriberQClaims = service.getClaimsByPrescriber(PRESCRIBER_Q);
    expect(prescriberQClaims.length).toBe(1); // claim 2
  });

  test('getClaimsByNdc returns correct claims', () => {
    const lisinoprilClaims = service.getClaimsByNdc(NDC_LISINOPRIL);
    expect(lisinoprilClaims.length).toBe(2); // claims 0, 2

    const metforminClaims = service.getClaimsByNdc(NDC_METFORMIN);
    expect(metforminClaims.length).toBe(1); // claim 1

    const atorvastatinClaims = service.getClaimsByNdc(NDC_ATORVASTATIN);
    expect(atorvastatinClaims.length).toBe(1); // claim 3
  });

  test('getClaimsByMember returns empty for unknown wallet', () => {
    expect(service.getClaimsByMember('9999')).toEqual([]);
  });

  test('getClaimsByPharmacy returns empty for unknown wallet', () => {
    expect(service.getClaimsByPharmacy('9999')).toEqual([]);
  });

  test('getClaimsByPrescriber returns empty for unknown wallet', () => {
    expect(service.getClaimsByPrescriber('9999')).toEqual([]);
  });

  test('getClaimsByNdc returns empty for unknown NDC', () => {
    expect(service.getClaimsByNdc('9999')).toEqual([]);
  });
});

describe('ClaimAccumulatorService — Merkle Proofs', () => {
  let service: ClaimAccumulatorService;

  beforeEach(() => {
    service = new ClaimAccumulatorService();
    service.appendClaim(makeLeaf(), makeMetadata({ receiptId: 'rcpt-001' }));
    service.appendClaim(
      makeLeaf({ memberWalletId: MEMBER_B }),
      makeMetadata({ receiptId: 'rcpt-002' }),
    );
  });

  test('getWitness returns valid witness for leaf 0', () => {
    const witness = service.getWitness(0n);
    const leafHash = computeClaimLeafHash(makeLeaf());
    const computedRoot = witness.calculateRoot(leafHash);
    expect(computedRoot.toBigInt()).toBe(service.getRoot());
  });

  test('getWitness returns valid witness for leaf 1', () => {
    const witness = service.getWitness(1n);
    const leafHash = computeClaimLeafHash(makeLeaf({ memberWalletId: MEMBER_B }));
    const computedRoot = witness.calculateRoot(leafHash);
    expect(computedRoot.toBigInt()).toBe(service.getRoot());
  });

  test('getClaimWithProof returns entry + witness + root', () => {
    const result = service.getClaimWithProof(0n);
    expect(result).toBeDefined();
    expect(result!.entry.leafIndex).toBe(0n);
    expect(result!.root).toBe(service.getRoot().toString());
    expect(result!.witnessJson).toBeDefined();

    // Parse witness JSON and verify it's valid
    const witnessData = JSON.parse(result!.witnessJson);
    expect(witnessData.path).toBeDefined();
    expect(witnessData.path.length).toBe(CLAIM_TREE_HEIGHT - 1);
  });

  test('getClaimWithProof returns undefined for non-existent index', () => {
    expect(service.getClaimWithProof(999n)).toBeUndefined();
  });

  test('witness for wrong leaf hash does NOT verify', () => {
    const witness = service.getWitness(0n);
    // Use leaf 1's hash at leaf 0's witness — should NOT match root
    const wrongHash = computeClaimLeafHash(makeLeaf({ memberWalletId: MEMBER_B }));
    const computedRoot = witness.calculateRoot(wrongHash);
    expect(computedRoot.toBigInt()).not.toBe(service.getRoot());
  });
});

describe('ClaimAccumulatorService — Export / Restore', () => {
  test('exportState captures all entries and root', () => {
    const service = new ClaimAccumulatorService();
    service.appendClaim(makeLeaf(), makeMetadata({ receiptId: 'rcpt-001' }));
    service.appendClaim(
      makeLeaf({ memberWalletId: MEMBER_B }),
      makeMetadata({ receiptId: 'rcpt-002' }),
    );

    const state = service.exportState();
    expect(state.nextLeafIndex).toBe(2n);
    expect(state.entries.length).toBe(2);
    expect(state.currentRoot).toBe(service.getRoot().toString());
    expect(state.entries[0].leafIndex).toBe(0n);
    expect(state.entries[1].leafIndex).toBe(1n);
  });

  test('restoreState rebuilds tree with same root', () => {
    // Build original
    const original = new ClaimAccumulatorService();
    original.appendClaim(makeLeaf(), makeMetadata({ receiptId: 'rcpt-001' }));
    original.appendClaim(
      makeLeaf({ memberWalletId: MEMBER_B, ndcHash: NDC_METFORMIN }),
      makeMetadata({ receiptId: 'rcpt-002' }),
    );
    original.appendClaim(
      makeLeaf({ pharmacyWalletId: PHARMACY_Y }),
      makeMetadata({ receiptId: 'rcpt-003' }),
    );

    const originalRoot = original.getRoot();
    const state = original.exportState();

    // Restore into new service
    const restored = new ClaimAccumulatorService();
    restored.restoreState(state);

    expect(restored.getRoot()).toBe(originalRoot);
    expect(restored.getLeafCount()).toBe(3n);
  });

  test('restoreState rebuilds all indexes', () => {
    const original = new ClaimAccumulatorService();
    original.appendClaim(makeLeaf(), makeMetadata({ receiptId: 'rcpt-001' }));
    original.appendClaim(
      makeLeaf({ memberWalletId: MEMBER_B }),
      makeMetadata({ receiptId: 'rcpt-002' }),
    );

    const state = original.exportState();

    const restored = new ClaimAccumulatorService();
    restored.restoreState(state);

    // Verify indexes rebuilt correctly
    expect(restored.getClaimsByMember(MEMBER_A).length).toBe(1);
    expect(restored.getClaimsByMember(MEMBER_B).length).toBe(1);
    expect(restored.getClaimsByPharmacy(PHARMACY_X).length).toBe(2);
    expect(restored.getClaimsByPrescriber(PRESCRIBER_P).length).toBe(2);
    expect(restored.getClaimsByNdc(NDC_LISINOPRIL).length).toBe(2);
  });

  test('restoreState clears previous data', () => {
    const service = new ClaimAccumulatorService();

    // Add some data first
    service.appendClaim(makeLeaf(), makeMetadata());
    service.appendClaim(makeLeaf(), makeMetadata());
    service.appendClaim(makeLeaf(), makeMetadata());
    expect(service.getLeafCount()).toBe(3n);

    // Restore with just 1 entry
    const singleEntry = new ClaimAccumulatorService();
    singleEntry.appendClaim(
      makeLeaf({ memberWalletId: MEMBER_B }),
      makeMetadata({ receiptId: 'rcpt-only' }),
    );
    const state = singleEntry.exportState();

    service.restoreState(state);
    expect(service.getLeafCount()).toBe(1n);
    expect(service.getClaimsByMember(MEMBER_A)).toEqual([]);
    expect(service.getClaimsByMember(MEMBER_B).length).toBe(1);
  });

  test('export/restore round-trip preserves Merkle witnesses', () => {
    const original = new ClaimAccumulatorService();
    original.appendClaim(makeLeaf(), makeMetadata());
    original.appendClaim(
      makeLeaf({ memberWalletId: MEMBER_B }),
      makeMetadata({ receiptId: 'rcpt-002' }),
    );

    const state = original.exportState();
    const restored = new ClaimAccumulatorService();
    restored.restoreState(state);

    // Witness from restored service should verify against restored root
    const witness = restored.getWitness(0n);
    const leafHash = computeClaimLeafHash(makeLeaf());
    const computedRoot = witness.calculateRoot(leafHash);
    expect(computedRoot.toBigInt()).toBe(restored.getRoot());
  });

  test('restoreState with empty state resets to empty', () => {
    const service = new ClaimAccumulatorService();
    service.appendClaim(makeLeaf(), makeMetadata());

    service.restoreState({
      nextLeafIndex: 0n,
      entries: [],
      currentRoot: '0',
    });

    expect(service.getLeafCount()).toBe(0n);
    expect(service.getClaimsByMember(MEMBER_A)).toEqual([]);
  });
});

describe('ClaimAccumulatorService — Edge Cases', () => {
  test('operationType distinguishes fulfillment (1) from reversal (2)', () => {
    const service = new ClaimAccumulatorService();

    service.appendClaim(
      makeLeaf({ operationType: '1' }),
      makeMetadata({ receiptId: 'fill' }),
    );
    service.appendClaim(
      makeLeaf({ operationType: '2' }),
      makeMetadata({ receiptId: 'reversal' }),
    );

    const claims = service.getClaimsByMember(MEMBER_A);
    expect(claims.length).toBe(2);
    expect(claims[0].leaf.operationType).toBe('1');
    expect(claims[1].leaf.operationType).toBe('2');
  });

  test('same drug for different members creates separate entries', () => {
    const service = new ClaimAccumulatorService();

    service.appendClaim(makeLeaf({ memberWalletId: MEMBER_A }), makeMetadata());
    service.appendClaim(makeLeaf({ memberWalletId: MEMBER_B }), makeMetadata());

    // Both show up under NDC index
    const ndcClaims = service.getClaimsByNdc(NDC_LISINOPRIL);
    expect(ndcClaims.length).toBe(2);

    // But member indexes are separate
    expect(service.getClaimsByMember(MEMBER_A).length).toBe(1);
    expect(service.getClaimsByMember(MEMBER_B).length).toBe(1);
  });

  test('metadata is preserved through append', () => {
    const service = new ClaimAccumulatorService();

    const meta: ClaimMetadata = {
      receiptId: 'rcpt-detailed',
      timestamp: 1700000000000,
      ndc: '00378-1805-10',
      brandName: 'Lisinopril',
      tierLevel: 1,
      gpi: '36200010100110',
      therapeuticClass: 'ACE Inhibitors',
      daysSupply: 30,
      fillNumber: 0,
    };

    service.appendClaim(makeLeaf(), meta);
    const entry = service.getEntry(0n);

    expect(entry!.metadata.receiptId).toBe('rcpt-detailed');
    expect(entry!.metadata.brandName).toBe('Lisinopril');
    expect(entry!.metadata.tierLevel).toBe(1);
    expect(entry!.metadata.gpi).toBe('36200010100110');
    expect(entry!.metadata.therapeuticClass).toBe('ACE Inhibitors');
    expect(entry!.metadata.daysSupply).toBe(30);
    expect(entry!.metadata.fillNumber).toBe(0);
  });
});
