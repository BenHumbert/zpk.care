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
 * Two registrations of one new wallet sent together make one member record and one credential mint.
 *
 * What was wrong: registerMemberFromEnrollment checked that no record held the wallet, then waited for the sequencer's
 * roots to settle (withRootsSettled, A-33) before it created the record and queued the credential mint. Register-member
 * is an open route and takes no lock, so a second registration of the same wallet sent with the first (a device that
 * sends again) passed the same check while the first waited: both created a record, the second over the first, and both
 * queued a credential mint, the second from the first's root to the same root. Found by round one's sweep of option A
 * step 1 (2026-10-24), as plausible; reproduced here by holding the roots while both are sent.
 *
 * Now a registration holds the wallet from the check until it finishes. A second registration of the same wallet waits
 * for the first and then answers as for a registered wallet (alreadyRegistered, the first's display name); a
 * registration that fails releases the wallet, and the next one registers it.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled, the ownership proof taken as given.
 * The roots are held by a stand-in prover's lease on the sequencer, which withRootsSettled waits for.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const RACED = '79200000000000000001';      // two registrations sent together while the roots are held
const RELEASED = '79200000000000000002';   // the first registration fails after the check; the second, sent with it, registers

let node: any;
let seq: any;
let svc: any;
let hashString: (s: string) => Field;
let LC: any;
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

/** Approved by the insurer and REGISTERED on the ledger by the member's own registration proof: ready to register with the engine. */
function readyToRegister(walletId: string): void {
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(walletId)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId, groupIdHash: ndcHashOf('GRP-RACE'), planIdHash: ndcHashOf('PLAN-RACE'), planId: 'PLAN-RACE', employerId: null, familyIdHash: null });
}

const register = (walletId: string, displayName: string) => svc.registerMemberFromEnrollment({ walletId, ownershipProofJson: '{}', displayName });
const mintsOf = (walletId: string) => svc.walletUpdatesFor(walletId).filter((u: any) => u.reason === 'credential mint');

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  LC = await import('../src/engine/lifecycle.js');

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-register-race' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;

  const base: any = {
    planId: 'PLAN-RACE', name: 'Registration race', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
    formularyNdcs: ['00378410591'], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
});

test('two registrations sent together while the roots are held make one record and one mint; the second answers as for a registered wallet', async () => {
  readyToRegister(RACED);
  expect(seq.acquireProvingLease('stand-in-prover').granted).toBe(true);   // a device proving: the roots wait for it
  const first = register(RACED, 'First');
  const second = register(RACED, 'Second');
  await new Promise((resolve) => setTimeout(resolve, 50));   // both are sent; neither may finish while the roots are held
  expect(svc.enrolledMembers.has(RACED)).toBe(false);
  expect(seq.releaseProvingLease('stand-in-prover')).toBe(true);
  const [a, b] = await Promise.all([first, second]);

  expect(a).toMatchObject({ walletId: RACED, displayName: 'First', registered: true, walletUpdate: { status: 'pending' } });
  expect(b).toEqual({ walletId: RACED, displayName: 'First', alreadyRegistered: true });   // before: registered again, with a second mint
  expect(svc.enrolledMembers.get(RACED).displayName).toBe('First');   // before: 'Second', the second record over the first
  expect(mintsOf(RACED).map((u: any) => u.updateId)).toEqual([a.walletUpdate.updateId]);   // before: two mints, the second from the first's root to the same root
  expect(svc.pendingWalletUpdates.get(a.walletUpdate.updateId).oldInventoryRoot).toBe(seq.getWalletStateForRpc(RACED).credentialInventoryRoot);

  // sent again later, it answers the same way and queues nothing
  expect(await register(RACED, 'Third')).toEqual({ walletId: RACED, displayName: 'First', alreadyRegistered: true });   // before: the second registration's name
  expect(mintsOf(RACED)).toHaveLength(1);   // before: 2
});

test('a registration that fails after the check releases the wallet: the second, sent with it, registers it', async () => {
  readyToRegister(RELEASED);
  const settle = jest.spyOn(seq, 'withRootsSettled').mockRejectedValueOnce(new Error('Proving lease: the roots did not settle (stand-in)'));
  try {
    const first = register(RELEASED, 'First');
    const second = register(RELEASED, 'Second');
    await expect(first).rejects.toThrow('the roots did not settle (stand-in)');
    expect(await second).toMatchObject({ walletId: RELEASED, displayName: 'Second', registered: true });
  } finally {
    settle.mockRestore();
  }
  expect(svc.enrolledMembers.get(RELEASED).displayName).toBe('Second');
  expect(mintsOf(RELEASED)).toHaveLength(1);
});
