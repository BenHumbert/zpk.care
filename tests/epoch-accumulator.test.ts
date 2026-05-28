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
 * Epoch Accumulator — Monthly epoch-based claim accumulator tests.
 *
 * Tests the EpochAccumulatorService which wraps multiple
 * ClaimAccumulatorService instances (one per month) for
 * production-scale drug history across epochs.
 *
 * All tests are FAST (no ZkProgram compilation).
 *
 * Run: npx jest tests/epoch-accumulator.test.ts --verbose
 */
import { EpochAccumulatorService } from '../src/l2/epoch-accumulator-service.js';
import type { EpochInfo } from '../src/l2/epoch-accumulator-service.js';
import type { ClaimLeaf, ClaimMetadata } from '../src/l2/claim-accumulator-types.js';

jest.setTimeout(30_000);

// ─── Helpers ────────────────────────────────────────────────────
// All ClaimLeaf fields go through Field(BigInt(...)), so they MUST be
// valid numeric decimal strings.

/** Distinct member wallet IDs (numeric strings) */
const MEMBER_A = '1001';
const MEMBER_B = '1002';
const MEMBER_X = '1003';
const MEMBER_Y = '1004';

/** Distinct NDC hashes */
const NDC_1 = '5001';
const NDC_2 = '5002';
const NDC_3 = '5003';
const NDC_4 = '5004';
const NDC_5 = '5005';
const NDC_LISINOPRIL = '6001';
const NDC_METFORMIN = '6002';

/** Pharmacies */
const PHARM_DEFAULT = '111';
const PHARM_X = '3001';
const PHARM_Y = '3002';

/** Prescribers */
const PRESCRIBER_DEFAULT = '222';
const DOC_A = '4001';
const DOC_B = '4002';

function makeClaimLeaf(
  memberWalletId: string,
  ndcHash: string,
  pharmacyWalletId = PHARM_DEFAULT,
  prescriberWalletId = PRESCRIBER_DEFAULT,
): ClaimLeaf {
  return {
    memberWalletId,
    ndcHash,
    pharmacyWalletId,
    prescriberWalletId,
    dateOfService: '20260217',
    patientPayCents: '1000',
    planPayCents: '5000',
    operationType: '1',
  };
}

function makeMetadata(receiptId: string): ClaimMetadata {
  return { receiptId, timestamp: Date.now() };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('EpochAccumulatorService', () => {
  // ── Constructor / Static ────────────────────────────────────

  test('1. Constructor uses provided epochId', () => {
    const svc = new EpochAccumulatorService('2025-06');
    expect(svc.getActiveEpochId()).toBe('2025-06');
  });

  test('2. Constructor defaults to current YYYY-MM', () => {
    const svc = new EpochAccumulatorService();
    const expected = EpochAccumulatorService.currentEpochId();
    expect(svc.getActiveEpochId()).toBe(expected);
  });

  test('3. currentEpochId returns YYYY-MM format', () => {
    const id = EpochAccumulatorService.currentEpochId();
    expect(id).toMatch(/^\d{4}-\d{2}$/);

    // Verify it matches the actual year/month
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    expect(id).toBe(`${year}-${month}`);
  });

  // ── Append / Active Root ────────────────────────────────────

  test('4. appendClaim stores entry in active epoch', () => {
    const svc = new EpochAccumulatorService('2026-01');
    const leaf = makeClaimLeaf(MEMBER_A, NDC_1);
    const meta = makeMetadata('R-001');

    const entry = svc.appendClaim(leaf, meta);

    expect(entry.leafIndex).toBe(0n);
    expect(entry.leaf).toEqual(leaf);
    expect(entry.metadata.receiptId).toBe('R-001');
    expect(typeof entry.leafHash).toBe('string');
    expect(entry.leafHash.length).toBeGreaterThan(0);
  });

  test('5. getActiveRoot changes after append', () => {
    const svc = new EpochAccumulatorService('2026-01');
    const rootBefore = svc.getActiveRoot();

    svc.appendClaim(makeClaimLeaf(MEMBER_A, NDC_1), makeMetadata('R-001'));
    const rootAfter = svc.getActiveRoot();

    expect(rootBefore).not.toBe(rootAfter);
  });

  // ── Index Queries ───────────────────────────────────────────

  test('6. getClaimsByMember returns matching claims', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf(MEMBER_A, NDC_1), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf(MEMBER_B, NDC_2), makeMetadata('R-002'));
    svc.appendClaim(makeClaimLeaf(MEMBER_A, NDC_3), makeMetadata('R-003'));

    const results = svc.getClaimsByMember(MEMBER_A);
    expect(results).toHaveLength(2);
    expect(results[0].metadata.receiptId).toBe('R-001');
    expect(results[1].metadata.receiptId).toBe('R-003');
  });

  test('7. getClaimsByPharmacy returns matching claims', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1, PHARM_X, PRESCRIBER_DEFAULT), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf('102', NDC_2, PHARM_Y, PRESCRIBER_DEFAULT), makeMetadata('R-002'));
    svc.appendClaim(makeClaimLeaf('103', NDC_3, PHARM_X, PRESCRIBER_DEFAULT), makeMetadata('R-003'));

    const results = svc.getClaimsByPharmacy(PHARM_X);
    expect(results).toHaveLength(2);
    expect(results[0].leaf.memberWalletId).toBe('101');
    expect(results[1].leaf.memberWalletId).toBe('103');
  });

  test('8. getClaimsByPrescriber returns matching claims', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1, PHARM_DEFAULT, DOC_A), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf('102', NDC_2, PHARM_DEFAULT, DOC_B), makeMetadata('R-002'));
    svc.appendClaim(makeClaimLeaf('103', NDC_3, PHARM_DEFAULT, DOC_A), makeMetadata('R-003'));

    const results = svc.getClaimsByPrescriber(DOC_A);
    expect(results).toHaveLength(2);
    expect(results[0].leaf.memberWalletId).toBe('101');
    expect(results[1].leaf.memberWalletId).toBe('103');
  });

  test('9. getClaimsByNdc returns matching claims', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_LISINOPRIL), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf('102', NDC_METFORMIN), makeMetadata('R-002'));
    svc.appendClaim(makeClaimLeaf('103', NDC_LISINOPRIL), makeMetadata('R-003'));

    const results = svc.getClaimsByNdc(NDC_LISINOPRIL);
    expect(results).toHaveLength(2);
    expect(results[0].leaf.memberWalletId).toBe('101');
    expect(results[1].leaf.memberWalletId).toBe('103');
  });

  // ── Merkle Proofs ──────────────────────────────────────────

  test('10. getClaimWithProof returns entry + witness + root', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf('102', NDC_2), makeMetadata('R-002'));

    const proof = svc.getClaimWithProof('2026-01', 0n);
    expect(proof).toBeDefined();
    expect(proof!.entry.leaf.memberWalletId).toBe('101');
    expect(proof!.entry.metadata.receiptId).toBe('R-001');
    expect(typeof proof!.witnessJson).toBe('string');
    expect(proof!.witnessJson.length).toBeGreaterThan(0);
    expect(typeof proof!.root).toBe('string');
    expect(proof!.root.length).toBeGreaterThan(0);

    // Root should match the active root
    expect(proof!.root).toBe(svc.getActiveRoot());
  });

  test('11. getClaimWithProof returns undefined for non-existent epoch', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));

    const proof = svc.getClaimWithProof('1999-12', 0n);
    expect(proof).toBeUndefined();
  });

  // ── Leaf Count ─────────────────────────────────────────────

  test('12. getTotalLeafCount tracks across epochs', () => {
    const svc = new EpochAccumulatorService('2026-01');
    expect(svc.getTotalLeafCount()).toBe(0n);

    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf('102', NDC_2), makeMetadata('R-002'));
    expect(svc.getTotalLeafCount()).toBe(2n);

    // Rotate and add more
    svc.rotateEpoch('2026-02');
    svc.appendClaim(makeClaimLeaf('103', NDC_3), makeMetadata('R-003'));
    expect(svc.getTotalLeafCount()).toBe(3n);
  });

  // ── Epoch Rotation ─────────────────────────────────────────

  test('13. rotateEpoch closes active epoch and returns its info', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf('102', NDC_2), makeMetadata('R-002'));

    const closedInfo = svc.rotateEpoch('2026-02');

    expect(closedInfo.epochId).toBe('2026-01');
    expect(closedInfo.archived).toBe(true);
    expect(closedInfo.endTimestamp).not.toBeNull();
    expect(typeof closedInfo.endTimestamp).toBe('number');
    expect(closedInfo.leafCount).toBe(2n);
    expect(typeof closedInfo.accumulatorRoot).toBe('string');
    expect(closedInfo.accumulatorRoot.length).toBeGreaterThan(0);
  });

  test('14. rotateEpoch creates new active epoch', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.rotateEpoch('2026-02');

    expect(svc.getActiveEpochId()).toBe('2026-02');

    // New epoch should be empty
    const info = svc.getEpochInfo('2026-02');
    expect(info).toBeDefined();
    expect(info!.leafCount).toBe(0n);
    expect(info!.archived).toBe(false);
    expect(info!.endTimestamp).toBeNull();
  });

  test('15. After rotation, new claims go to new epoch', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));
    svc.rotateEpoch('2026-02');
    svc.appendClaim(makeClaimLeaf('102', NDC_2), makeMetadata('R-002'));

    // Old epoch: 1 claim; new epoch: 1 claim
    const oldEpochClaims = svc.getClaimsByMemberInEpoch('101', '2026-01');
    expect(oldEpochClaims).toHaveLength(1);

    const newEpochClaims = svc.getClaimsByMemberInEpoch('102', '2026-02');
    expect(newEpochClaims).toHaveLength(1);

    // Member 102 should NOT be in the old epoch
    const m2InOldEpoch = svc.getClaimsByMemberInEpoch('102', '2026-01');
    expect(m2InOldEpoch).toHaveLength(0);

    // Proof from new epoch uses new epoch's root (different from old)
    const proof = svc.getClaimWithProof('2026-02', 0n);
    expect(proof).toBeDefined();
    expect(proof!.entry.leaf.memberWalletId).toBe('102');
  });

  // ── Cross-Epoch Queries ────────────────────────────────────

  test('16. Cross-epoch queries return claims from all epochs', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf(MEMBER_X, NDC_1), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf(MEMBER_X, NDC_2), makeMetadata('R-002'));

    svc.rotateEpoch('2026-02');
    svc.appendClaim(makeClaimLeaf(MEMBER_X, NDC_3), makeMetadata('R-003'));

    svc.rotateEpoch('2026-03');
    svc.appendClaim(makeClaimLeaf(MEMBER_X, NDC_4), makeMetadata('R-004'));

    const allClaims = svc.getClaimsByMember(MEMBER_X);
    expect(allClaims).toHaveLength(4);

    // Active epoch (newest) comes first, then archived newest-first
    // Active = 2026-03: R-004
    // Archived newest-first = 2026-02: R-003, then 2026-01: R-001, R-002
    expect(allClaims[0].metadata.receiptId).toBe('R-004');
    expect(allClaims[1].metadata.receiptId).toBe('R-003');
    expect(allClaims[2].metadata.receiptId).toBe('R-001');
    expect(allClaims[3].metadata.receiptId).toBe('R-002');
  });

  test('17. getClaimsByMemberInEpoch only returns that epoch', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf(MEMBER_Y, NDC_1), makeMetadata('R-001'));

    svc.rotateEpoch('2026-02');
    svc.appendClaim(makeClaimLeaf(MEMBER_Y, NDC_2), makeMetadata('R-002'));
    svc.appendClaim(makeClaimLeaf(MEMBER_Y, NDC_3), makeMetadata('R-003'));

    // Only 2026-01
    const jan = svc.getClaimsByMemberInEpoch(MEMBER_Y, '2026-01');
    expect(jan).toHaveLength(1);
    expect(jan[0].metadata.receiptId).toBe('R-001');

    // Only 2026-02
    const feb = svc.getClaimsByMemberInEpoch(MEMBER_Y, '2026-02');
    expect(feb).toHaveLength(2);
    expect(feb[0].metadata.receiptId).toBe('R-002');
    expect(feb[1].metadata.receiptId).toBe('R-003');

    // Non-existent epoch
    const none = svc.getClaimsByMemberInEpoch(MEMBER_Y, '2030-12');
    expect(none).toHaveLength(0);
  });

  // ── Epoch Listing / Info ───────────────────────────────────

  test('18. listEpochs returns all epochs sorted newest first', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.rotateEpoch('2026-02');
    svc.rotateEpoch('2026-03');

    const epochs = svc.listEpochs();
    expect(epochs).toHaveLength(3);

    // Newest (highest startTimestamp) first
    expect(epochs[0].epochId).toBe('2026-03');
    expect(epochs[0].archived).toBe(false);
    expect(epochs[1].epochId).toBe('2026-02');
    expect(epochs[1].archived).toBe(true);
    expect(epochs[2].epochId).toBe('2026-01');
    expect(epochs[2].archived).toBe(true);
  });

  test('19. getEpochInfo returns epoch details', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));

    const info = svc.getEpochInfo('2026-01');
    expect(info).toBeDefined();
    expect(info!.epochId).toBe('2026-01');
    expect(info!.leafCount).toBe(1n);
    expect(info!.archived).toBe(false);
    expect(info!.endTimestamp).toBeNull();
    expect(info!.startTimestamp).toBeGreaterThan(0);
    expect(typeof info!.accumulatorRoot).toBe('string');

    // Non-existent epoch
    const missing = svc.getEpochInfo('1999-01');
    expect(missing).toBeUndefined();
  });

  test('20. getRootForEpoch returns root for specific epoch', () => {
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));
    const rootJan = svc.getActiveRoot();

    svc.rotateEpoch('2026-02');
    svc.appendClaim(makeClaimLeaf('102', NDC_2), makeMetadata('R-002'));
    const rootFeb = svc.getActiveRoot();

    // Jan root should be the archived root
    const janRoot = svc.getRootForEpoch('2026-01');
    expect(janRoot).toBe(rootJan);

    // Feb root should be the active root
    const febRoot = svc.getRootForEpoch('2026-02');
    expect(febRoot).toBe(rootFeb);

    // Different trees, different content -> different roots
    expect(janRoot).not.toBe(febRoot);

    // Non-existent epoch
    expect(svc.getRootForEpoch('2099-12')).toBeUndefined();
  });

  // ── Export / Restore ───────────────────────────────────────

  test('21. exportState/restoreState round-trip preserves all data', () => {
    // Build a service with claims across two epochs
    const svc = new EpochAccumulatorService('2026-01');
    svc.appendClaim(makeClaimLeaf('101', NDC_1), makeMetadata('R-001'));
    svc.appendClaim(makeClaimLeaf('102', NDC_2), makeMetadata('R-002'));

    svc.rotateEpoch('2026-02');
    svc.appendClaim(makeClaimLeaf('103', NDC_3), makeMetadata('R-003'));

    // Capture state before export
    const totalBefore = svc.getTotalLeafCount();
    const activeRootBefore = svc.getActiveRoot();
    const janRoot = svc.getRootForEpoch('2026-01');
    const memberClaims = svc.getClaimsByMember('101');

    // Export
    const exported = svc.exportState();

    // Restore into a fresh service
    const svc2 = new EpochAccumulatorService('9999-01'); // dummy, will be overwritten
    svc2.restoreState(exported);

    // Verify active epoch
    expect(svc2.getActiveEpochId()).toBe('2026-02');

    // Verify leaf counts
    expect(svc2.getTotalLeafCount()).toBe(totalBefore);

    // Verify roots -- active root matches (tree rebuilt from entries)
    expect(svc2.getActiveRoot()).toBe(activeRootBefore);

    // Verify archived epoch root (also rebuilt from entries)
    expect(svc2.getRootForEpoch('2026-01')).toBe(janRoot);

    // Verify cross-epoch queries still work
    const restoredM1 = svc2.getClaimsByMember('101');
    expect(restoredM1).toHaveLength(memberClaims.length);
    expect(restoredM1[0].metadata.receiptId).toBe('R-001');

    // Verify index queries work for all dimensions
    expect(svc2.getClaimsByMember('103')).toHaveLength(1);
    expect(svc2.getClaimsByPharmacy(PHARM_DEFAULT)).toHaveLength(3);
    expect(svc2.getClaimsByPrescriber(PRESCRIBER_DEFAULT)).toHaveLength(3);
    expect(svc2.getClaimsByNdc(NDC_1)).toHaveLength(1);

    // Verify Merkle proofs still work on restored data
    const proof = svc2.getClaimWithProof('2026-02', 0n);
    expect(proof).toBeDefined();
    expect(proof!.entry.leaf.memberWalletId).toBe('103');
  });

  // ── Multiple Rotations ─────────────────────────────────────

  test('22. Multiple rotations work correctly', () => {
    const svc = new EpochAccumulatorService('2025-10');

    // Epoch 1: Oct 2025
    svc.appendClaim(makeClaimLeaf('201', NDC_1), makeMetadata('R-001'));
    const closedOct = svc.rotateEpoch('2025-11');
    expect(closedOct.epochId).toBe('2025-10');
    expect(closedOct.leafCount).toBe(1n);

    // Epoch 2: Nov 2025
    svc.appendClaim(makeClaimLeaf('202', NDC_2), makeMetadata('R-002'));
    svc.appendClaim(makeClaimLeaf('203', NDC_3), makeMetadata('R-003'));
    const closedNov = svc.rotateEpoch('2025-12');
    expect(closedNov.epochId).toBe('2025-11');
    expect(closedNov.leafCount).toBe(2n);

    // Epoch 3: Dec 2025
    svc.appendClaim(makeClaimLeaf('204', NDC_4), makeMetadata('R-004'));
    const closedDec = svc.rotateEpoch('2026-01');
    expect(closedDec.epochId).toBe('2025-12');
    expect(closedDec.leafCount).toBe(1n);

    // Epoch 4: Jan 2026 (active)
    svc.appendClaim(makeClaimLeaf('205', NDC_5), makeMetadata('R-005'));

    // Verify
    expect(svc.getActiveEpochId()).toBe('2026-01');
    expect(svc.getTotalLeafCount()).toBe(5n);

    const epochs = svc.listEpochs();
    expect(epochs).toHaveLength(4);
    // Active epoch is newest
    expect(epochs[0].epochId).toBe('2026-01');
    expect(epochs[0].archived).toBe(false);
    // All others archived
    expect(epochs.filter((e) => e.archived)).toHaveLength(3);

    // Cross-epoch query finds unique members
    const allM201 = svc.getClaimsByMember('201');
    expect(allM201).toHaveLength(1);
    const allM205 = svc.getClaimsByMember('205');
    expect(allM205).toHaveLength(1);

    // Proofs work in each epoch
    expect(svc.getClaimWithProof('2025-10', 0n)).toBeDefined();
    expect(svc.getClaimWithProof('2025-11', 0n)).toBeDefined();
    expect(svc.getClaimWithProof('2025-11', 1n)).toBeDefined();
    expect(svc.getClaimWithProof('2025-12', 0n)).toBeDefined();
    expect(svc.getClaimWithProof('2026-01', 0n)).toBeDefined();

    // Each epoch has its own independent Merkle root
    const roots = epochs.map((e) => e.accumulatorRoot);
    const uniqueRoots = new Set(roots);
    // All non-empty epochs with different content produce different roots
    expect(uniqueRoots.size).toBeGreaterThanOrEqual(2);
  });
});
