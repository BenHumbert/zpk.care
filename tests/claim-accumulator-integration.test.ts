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
 * Claim Accumulator Integration Tests — End-to-end NDC data flow.
 *
 * Tests the full pipeline: submitProof with metadata → AuditEvent.ndcHash →
 * ClaimAccumulator append → index queries → Merkle proofs →
 * checkpoint export/restore → batch metadata.
 *
 * All FAST (no ZkProgram compilation). Uses mock proofs.
 *
 * Run: npx jest tests/claim-accumulator-integration.test.ts --verbose
 */

import { Field, Poseidon, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { L2Node } from '../src/l2/l2-node.js';
import { AuditService } from '../src/audit/audit-service.js';
import type { ClaimSubmissionMetadata } from '../src/l2/l2-types.js';

// ─── Mock Proof Helpers ─────────────────────────────────────

// Build a mock StateTransitionProof that passes sequencer verification
// (uses the same approach as tests/l2.test.ts — mock verify + publicOutput)
function makeMockProof(opts: {
  walletId: Field;
  oldRegistryRoot: Field;
  newRegistryRoot: Field;
  oldLifecycleRoot: Field;
  newLifecycleRoot: Field;
}) {
  return {
    verify: () => {},
    publicOutput: {
      walletId: opts.walletId,
      oldRegistryRoot: opts.oldRegistryRoot,
      newRegistryRoot: opts.newRegistryRoot,
      oldLifecycleRoot: opts.oldLifecycleRoot,
      newLifecycleRoot: opts.newLifecycleRoot,
    },
    toJSON: () => ({}),
  } as any;
}

// ─── Test Data ──────────────────────────────────────────────

const REG_ROOT_0 = Field(1000);
const REG_ROOT_1 = Field(1001);
const REG_ROOT_2 = Field(1002);
const REG_ROOT_3 = Field(1003);
const LC_ROOT = Field(2000);
const WALLET_A = Field(100);
const WALLET_B = Field(200);

const NDC_LISINOPRIL_HASH = Poseidon.hash([Field(BigInt('00378180510'))]).toString();
const NDC_METFORMIN_HASH = Poseidon.hash([Field(BigInt('00093721510'))]).toString();

function makeClaimMetadata(overrides: Partial<ClaimSubmissionMetadata> = {}): ClaimSubmissionMetadata {
  return {
    ndcHash: NDC_LISINOPRIL_HASH,
    memberWalletId: WALLET_A.toString(),
    pharmacyWalletId: '5001',
    prescriberWalletId: '6001',
    dateOfService: '20260115',
    patientPayCents: '1000',
    planPayCents: '5000',
    operationType: '1',
    ndc: '00378-1805-10',
    brandName: 'Lisinopril',
    tierLevel: 1,
    ...overrides,
  };
}

// ─── Integration Tests ──────────────────────────────────────

describe('Claim Accumulator Integration — Sequencer', () => {
  let sequencer: L2SequencerService;

  beforeEach(() => {
    const store = new InMemoryStore();
    sequencer = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));
  });

  test('submitProof with metadata sets ndcHash on AuditEvent', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await sequencer.submitProof(proof, makeClaimMetadata());

    const log = sequencer.getAuditLog();
    expect(log.events.length).toBe(1);
    expect(log.events[0].ndcHash).toBe(NDC_LISINOPRIL_HASH);
  });

  test('submitProof without metadata leaves ndcHash undefined on AuditEvent', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await sequencer.submitProof(proof);

    const log = sequencer.getAuditLog();
    expect(log.events[0].ndcHash).toBeUndefined();
  });

  test('audit chain integrity preserved with 8-field commitment (ndcHash)', async () => {
    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: REG_ROOT_1,
      newRegistryRoot: REG_ROOT_2,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await sequencer.submitProof(proof1, makeClaimMetadata({ ndcHash: NDC_LISINOPRIL_HASH }));
    await sequencer.submitProof(proof2, makeClaimMetadata({ ndcHash: NDC_METFORMIN_HASH }));

    const log = sequencer.getAuditLog();
    const integrity = AuditService.verifyReceiptChain(log);
    expect(integrity.isValid).toBe(true);
    expect(integrity.totalEvents).toBe(2);
  });

  test('submitProof with metadata appends to claim accumulator', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    const receipt = await sequencer.submitProof(proof, makeClaimMetadata());

    expect(receipt.claimLeafIndex).toBe(0n);
    expect(sequencer.getClaimLeafCount()).toBe(1n);
  });

  test('submitProof without metadata does NOT append to accumulator', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    const receipt = await sequencer.submitProof(proof);

    expect(receipt.claimLeafIndex).toBeUndefined();
    expect(sequencer.getClaimLeafCount()).toBe(0n);
  });

  test('query claims by member returns correct results', async () => {
    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: REG_ROOT_1,
      newRegistryRoot: REG_ROOT_2,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await sequencer.submitProof(proof1, makeClaimMetadata({
      memberWalletId: WALLET_A.toString(),
    }));
    await sequencer.submitProof(proof2, makeClaimMetadata({
      memberWalletId: WALLET_B.toString(),
      ndcHash: NDC_METFORMIN_HASH,
      brandName: 'Metformin',
    }));

    const memberAClaims = sequencer.getClaimsByMember(WALLET_A.toString());
    expect(memberAClaims.length).toBe(1);
    expect(memberAClaims[0].metadata.brandName).toBe('Lisinopril');

    const memberBClaims = sequencer.getClaimsByMember(WALLET_B.toString());
    expect(memberBClaims.length).toBe(1);
    expect(memberBClaims[0].metadata.brandName).toBe('Metformin');
  });

  test('query claims by NDC returns results across members', async () => {
    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: REG_ROOT_1,
      newRegistryRoot: REG_ROOT_2,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    // Both members get Lisinopril
    await sequencer.submitProof(proof1, makeClaimMetadata({
      memberWalletId: WALLET_A.toString(),
    }));
    await sequencer.submitProof(proof2, makeClaimMetadata({
      memberWalletId: WALLET_B.toString(),
    }));

    const ndcClaims = sequencer.getClaimsByNdc(NDC_LISINOPRIL_HASH);
    expect(ndcClaims.length).toBe(2);
  });

  test('getClaimWithProof returns verifiable Merkle proof', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    const receipt = await sequencer.submitProof(proof, makeClaimMetadata());

    const result = sequencer.getClaimWithProof(receipt.claimLeafIndex!);
    expect(result).toBeDefined();
    expect(result!.entry.leafIndex).toBe(0n);
    expect(result!.root).toBe(sequencer.getClaimAccumulatorRoot());
  });

  test('reversal entries tracked with operationType=2', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await sequencer.submitProof(proof, makeClaimMetadata({
      operationType: '2',
      patientPayCents: '1000',
      planPayCents: '5000',
    }));

    const claims = sequencer.getClaimsByMember(WALLET_A.toString());
    expect(claims.length).toBe(1);
    expect(claims[0].leaf.operationType).toBe('2');
  });
});

describe('Claim Accumulator Integration — Checkpoint', () => {
  test('export/restore preserves claim accumulator state', async () => {
    const store = new InMemoryStore();
    const original = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));

    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: REG_ROOT_1,
      newRegistryRoot: REG_ROOT_2,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await original.submitProof(proof1, makeClaimMetadata({
      memberWalletId: WALLET_A.toString(),
    }));
    await original.submitProof(proof2, makeClaimMetadata({
      memberWalletId: WALLET_B.toString(),
      ndcHash: NDC_METFORMIN_HASH,
    }));

    const originalRoot = original.getClaimAccumulatorRoot();
    const state = original.exportState();

    // Restore
    const restored = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));
    restored.restoreState(state);

    expect(restored.getClaimAccumulatorRoot()).toBe(originalRoot);
    expect(restored.getClaimLeafCount()).toBe(2n);
    expect(restored.getClaimsByMember(WALLET_A.toString()).length).toBe(1);
    expect(restored.getClaimsByMember(WALLET_B.toString()).length).toBe(1);
    expect(restored.getClaimsByNdc(NDC_LISINOPRIL_HASH).length).toBe(1);
    expect(restored.getClaimsByNdc(NDC_METFORMIN_HASH).length).toBe(1);
  });

  test('empty accumulator not included in checkpoint', () => {
    const store = new InMemoryStore();
    const sequencer = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));

    const state = sequencer.exportState();
    expect(state.claimAccumulatorState).toBeUndefined();
  });

  test('restoreState without accumulator resets to empty', async () => {
    const store = new InMemoryStore();
    const sequencer = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    await sequencer.submitProof(proof, makeClaimMetadata());
    expect(sequencer.getClaimLeafCount()).toBe(1n);

    // Restore with a state that has no accumulator
    const emptyState = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));
    const state = emptyState.exportState();
    sequencer.restoreState(state);

    expect(sequencer.getClaimLeafCount()).toBe(0n);
  });
});

describe('Claim Accumulator Integration — L2Node', () => {
  test('L2Node.submitProof forwards metadata to sequencer', async () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store,
      REG_ROOT_0,
      LC_ROOT,
      Field(0),
    );

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    const receipt = await node.submitProof(proof, makeClaimMetadata());

    expect(receipt.claimLeafIndex).toBe(0n);
    expect(node.getClaimLeafCount()).toBe(1n);
    expect(node.getClaimsByMember(WALLET_A.toString()).length).toBe(1);
  });

  test('L2Node claim query pass-throughs work correctly', async () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store,
      REG_ROOT_0,
      LC_ROOT,
      Field(0),
    );

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await node.submitProof(proof, makeClaimMetadata({
      pharmacyWalletId: '5001',
      prescriberWalletId: '6001',
    }));

    // All query methods work through node
    expect(node.getClaimsByPharmacy('5001').length).toBe(1);
    expect(node.getClaimsByPrescriber('6001').length).toBe(1);
    expect(node.getClaimsByNdc(NDC_LISINOPRIL_HASH).length).toBe(1);
    expect(node.getClaimAccumulatorRoot()).toBeDefined();

    const proof2 = node.getClaimWithProof(0n);
    expect(proof2).toBeDefined();
    expect(proof2!.root).toBe(node.getClaimAccumulatorRoot());
  });
});

describe('Claim Accumulator Integration — Multiple Claims', () => {
  test('multiple claims for same member accumulate correctly', async () => {
    const store = new InMemoryStore();
    const sequencer = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));

    // 3 claims for the same member, different drugs
    const roots = [REG_ROOT_0, REG_ROOT_1, REG_ROOT_2, REG_ROOT_3];
    const drugs = [
      { ndcHash: NDC_LISINOPRIL_HASH, brandName: 'Lisinopril' },
      { ndcHash: NDC_METFORMIN_HASH, brandName: 'Metformin' },
      { ndcHash: NDC_LISINOPRIL_HASH, brandName: 'Lisinopril (refill)' },
    ];

    for (let i = 0; i < 3; i++) {
      const proof = makeMockProof({
        walletId: WALLET_A,
        oldRegistryRoot: roots[i],
        newRegistryRoot: roots[i + 1],
        oldLifecycleRoot: LC_ROOT,
        newLifecycleRoot: LC_ROOT,
      });
      await sequencer.submitProof(proof, makeClaimMetadata({
        memberWalletId: WALLET_A.toString(),
        ndcHash: drugs[i].ndcHash,
        brandName: drugs[i].brandName,
      }));
    }

    // Member has 3 claims
    const memberClaims = sequencer.getClaimsByMember(WALLET_A.toString());
    expect(memberClaims.length).toBe(3);

    // Lisinopril NDC has 2 claims (original + refill)
    const lisinoprilClaims = sequencer.getClaimsByNdc(NDC_LISINOPRIL_HASH);
    expect(lisinoprilClaims.length).toBe(2);

    // Metformin NDC has 1 claim
    const metforminClaims = sequencer.getClaimsByNdc(NDC_METFORMIN_HASH);
    expect(metforminClaims.length).toBe(1);

    // All 3 claims have valid leaf indices
    expect(memberClaims.map(c => c.leafIndex)).toEqual([0n, 1n, 2n]);
  });

  test('mixed claim and non-claim proofs maintain correct state', async () => {
    const store = new InMemoryStore();
    const sequencer = new L2SequencerService(store, REG_ROOT_0, LC_ROOT, Field(0));

    // Proof 1: registration (no metadata)
    const regProof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_0,
      newRegistryRoot: REG_ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: Field(2001),
    });
    const regReceipt = await sequencer.submitProof(regProof);
    expect(regReceipt.claimLeafIndex).toBeUndefined();

    // Proof 2: claim (with metadata)
    const claimProof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: REG_ROOT_1,
      newRegistryRoot: REG_ROOT_2,
      oldLifecycleRoot: Field(2001),
      newLifecycleRoot: Field(2001),
    });
    const claimReceipt = await sequencer.submitProof(claimProof, makeClaimMetadata());
    expect(claimReceipt.claimLeafIndex).toBe(0n);

    // Only 1 claim in accumulator, but 2 audit events
    expect(sequencer.getClaimLeafCount()).toBe(1n);
    const log = sequencer.getAuditLog();
    expect(log.events.length).toBe(2);

    // Audit chain is still valid
    const integrity = AuditService.verifyReceiptChain(log);
    expect(integrity.isValid).toBe(true);
  });
});
