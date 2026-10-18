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
 * Claims committed for a member's pending wallet update — plan item B2.
 *
 * The engine commits a fill's claim on the sequencer, keyed by the wallet and the credential root
 * the member's proof will reach; the sequencer keeps it across a checkpoint and gives it up only
 * for exactly that wallet and root. The attachment itself happens in `l2_submitProof` and is
 * exercised on every live fill by the harness.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import type { ClaimSubmissionMetadata } from '../src/l2/l2-types.js';

const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const claim = (patientPayCents: string): ClaimSubmissionMetadata => ({
  ndcHash: '11', memberWalletId: '1001', pharmacyWalletId: '2001', prescriberWalletId: '3001', dateOfService: '20261018',
  patientPayCents, planPayCents: '4500', operationType: '1',
} as ClaimSubmissionMetadata);

describe('pending claims on the sequencer', () => {
  test('are keyed by wallet and root, found only for both, cleared once, and survive a checkpoint', () => {
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-under-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    const seq = node.getSequencer();
    expect(seq.pendingClaimCount()).toBe(0);
    seq.commitPendingClaim('1001', '555', claim('1000'));
    seq.commitPendingClaim('1001', '556', claim('2000'));
    expect(seq.pendingClaimCount()).toBe(2);
    expect(seq.pendingClaimFor('1001', '555')?.patientPayCents).toBe('1000');
    expect(seq.pendingClaimFor('1001', '556')?.patientPayCents).toBe('2000');
    expect(seq.pendingClaimFor('1002', '555')).toBeUndefined();
    expect(seq.pendingClaimFor('1001', '557')).toBeUndefined();

    const state = seq.exportState();
    expect(Object.keys(state.pendingClaims ?? {}).sort()).toEqual(['1001:555', '1001:556']);
    const other = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-restored' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    other.getSequencer().restoreState(state);
    expect(other.getSequencer().pendingClaimFor('1001', '556')?.planPayCents).toBe('4500');

    seq.clearPendingClaim('1001', '555');
    expect(seq.pendingClaimFor('1001', '555')).toBeUndefined();
    expect(seq.pendingClaimCount()).toBe(1);
    seq.clearPendingClaim('1001', '555'); // idempotent
    expect(seq.pendingClaimCount()).toBe(1);
    expect(seq.exportState().pendingClaims).toEqual({ '1001:556': claim('2000') });
  });
});
