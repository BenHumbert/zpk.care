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
 * A prior-authorization approval whose proof or ledger step fails changes nothing: the member's record is put back
 * exactly and the request stays pending.
 *
 * What was wrong: proveAndRecordPriorAuthApproval took the member's next leaf index, wrote the PriorAuthData at that
 * ACCESS_CONTROL leaf and moved the credential onto the new forest root before the AccessControl proof, and the ledger
 * step then moved inventory slot 0. When the proof or the ledger step threw, nothing was put back: the authorization
 * the insurer had not approved stayed in the member's forest, unqueued, and rode into the member's next update (the
 * device would be asked to prove a credential holding it, even after the insurer denied the request), and the leaf
 * index stayed taken, so the count ran toward the cap of 126 with fewer approvals. Found by round one of option A step 1
 * (2026-10-24) and confirmed by its review.
 *
 * Now the leaf index, the leaf, the credential and inventory slot 0 are saved before the approval changes any of them
 * and put back exactly when the proof or the ledger step fails; the error surfaces and the request stays pending, so the
 * insurer can approve it again, at the same leaf, or deny it. A plan binding made before (the member's due at this
 * action, queued as its own update) stays.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled, every proof skipped except where a
 * case makes the approval's proof throw. The records are compared whole, every tree as its root and every leaf.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const PA_DRUG = '59148004580';    // ABILIFY MAINTENA ER 300 MG SYR: prior authorization, 30 EA per fill
const PA_ML_DRUG = '50242014301'; // ACTEMRA ACTPEN 162 MG/0.9 ML: prior authorization, 30 ML per fill
const W = '79500000000000000001';         // a member with a device whose first approval's proof throws
const LEDGER = '79500000000000000002';    // a member with a device whose first approval's ledger step fails
const FIXTURE = '79500000000000000003';   // a fixture member: the sequencer does not take its first proved update

let node: any;
let seq: any;
let svc: any;
let hashString: (s: string) => Field;
let ForestDomain: any;
let CredentialData: any;
let ACCUMULATOR_LEAF_INDEX: bigint;
const events: Array<{ type: string; message: string }> = [];
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

/** A value as plain data, for comparing whole records: each Merkle tree as its root and every leaf it holds. */
function plain(v: unknown): unknown {
  if (v instanceof Field) return v.toString();
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof MerkleTree) {
    const leaves: string[] = [];
    for (let i = 0n; i < v.leafCount; i++) leaves.push(v.getLeaf(i).toString());
    return { root: v.getRoot().toString(), leaves };
  }
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [plain(k), plain(x)]);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** Everything an approval may change: the member's record, its next leaf index, the request and the engine's queue. */
function recordOf(walletId: string, paId: string): unknown {
  return plain({
    member: svc.enrolledMembers.get(walletId),
    nextPaLeafIndex: svc.nextPaLeafIndex.has(walletId) ? svc.nextPaLeafIndex.get(walletId) : 'none',
    request: svc.priorAuths.get(paId),
    queue: svc.pendingWalletUpdates,
  });
}

const accessControlLeaf = (walletId: string, index: bigint) => svc.enrolledMembers.get(walletId).forest.getLeaf(ForestDomain.ACCESS_CONTROL, index).toString();
const errorLines = () => events.filter((e) => e.type === 'error').map((e) => e.message);

/** A fixture member made from a registered one: served from the console's formulary, with the preimage the engine proves with, nothing queued. */
function fixtureFrom(walletId: string): any {
  const m = svc.enrolledMembers.get(walletId);
  m.memberIndex = 0;
  m.preimageFields = [1, 2, 3, 4, 5, 6].map((n) => Field(n));
  m.planId = 'PLAN-GOLD-2026';
  m.eligibilityData = svc.sharedEligibilityData;
  m.forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, m.eligibilityData.commitment());
  const c = m.credentialData;
  m.credentialData = new CredentialData({ credentialType: c.credentialType, forestRoot: m.forest.getForestRoot(), issuerWalletId: c.issuerWalletId, subjectWalletId: c.subjectWalletId, issuedAt: c.issuedAt, expiresAt: c.expiresAt, revoked: c.revoked });
  m.credentialInventory.updateCredential(0n, m.credentialData);
  for (const u of svc.walletUpdatesFor(walletId)) svc.pendingWalletUpdates.delete(u.updateId);
  m.credentialInventoryRoot = m.credentialInventory.getRoot();
  return m;
}

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
  ({ ForestDomain } = await import('../src/zkp/merkle-forest.js'));
  ({ CredentialData } = await import('../src/credentials/credential-data.js'));
  ({ ACCUMULATOR_LEAF_INDEX } = await import('../src/access-control/accumulator-data.js'));
  const LC = await import('../src/engine/lifecycle.js');

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-prior-auth-rollback' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService((e: { type: string; message: string }) => events.push(e), () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });

  const base: any = {
    planId: 'PLAN-PA-RB', name: 'Prior authorization rollback', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1300,
    formularyNdcs: [PA_DRUG, PA_ML_DRUG], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  for (const w of [W, LEDGER, FIXTURE]) {
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(w)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: w, groupIdHash: ndcHashOf('GRP-PA-RB'), planIdHash: ndcHashOf('PLAN-PA-RB'), planId: 'PLAN-PA-RB', employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: w, ownershipProofJson: '{}', displayName: 'Prior authorization rollback member' });
  }
  fixtureFrom(FIXTURE);
});

describe('a member with a device: the approval\'s proof throws', () => {
  let failed: string;

  test('the leaf index, the leaf, the credential and the queue stay exactly as they were, the request stays pending, and the error surfaces', async () => {
    ({ paId: failed } = svc.requestPriorAuth({ memberWalletId: W, prescriberIndex: 0, ndcHash: ndcHashOf(PA_DRUG) }));
    const before = recordOf(W, failed);
    const crash = 'Worker 1 crashed during AccessControl.provePriorAuth (code 134, signal null)';
    const prove = svc.dispatchProof;
    svc.dispatchProof = async (program: string, ...rest: unknown[]) => {
      if (program === 'AccessControl') throw new Error(crash);
      return prove(program, ...rest);
    };
    events.length = 0;
    try {
      await expect(svc.approvePriorAuth(failed)).rejects.toThrow(crash);
    } finally {
      svc.dispatchProof = prove;
    }
    expect(recordOf(W, failed)).toEqual(before);   // before: leaf 1 held the unapproved authorization, the credential named it and the next leaf index was 2
    expect(svc.priorAuths.get(failed).status).toBe('PENDING');
    expect(svc.priorAuthApprovalsInFlight.has(failed)).toBe(false);
    expect(errorLines()).toContain(`The approval of ${failed} was not recorded and its changes were put back; the request stays pending: ${crash}`);   // before: no such line
  });

  test('the insurer denies that request, and the member\'s next approval takes leaf 1 and carries no authorization but its own', async () => {
    expect(svc.denyPriorAuth(failed, 'Not medically necessary')).toMatchObject({ status: 'DENIED' });
    const m = svc.enrolledMembers.get(W);
    const { paId } = svc.requestPriorAuth({ memberWalletId: W, prescriberIndex: 0, ndcHash: ndcHashOf(PA_ML_DRUG) });
    const approved = await svc.approvePriorAuth(paId);
    expect(approved).toMatchObject({ status: 'APPROVED', paLeafIndex: 1 });   // before: leaf 2, leaf 1 taken by the failed approval
    expect(svc.nextPaLeafIndex.get(W)).toBe(2n);   // before: 3n
    const own = svc.priorAuths.get(paId).priorAuthData.commitment().toString();
    expect(accessControlLeaf(W, 1n)).toBe(own);   // before: the denied request's authorization
    for (let i = 2n; i < ACCUMULATOR_LEAF_INDEX; i++) expect(accessControlLeaf(W, i)).toBe('0');   // before: leaf 2 held this approval's authorization

    const update = svc.walletUpdatesFor(W).at(-1);
    expect(update.reason).toBe('prior-auth');
    const authorizationLeaves = update.forestLeaves.filter((l: any) => l.domain === ForestDomain.ACCESS_CONTROL && l.index !== '0' && l.index !== String(ACCUMULATOR_LEAF_INDEX));
    expect(authorizationLeaves).toEqual([{ domain: ForestDomain.ACCESS_CONTROL, index: '1', leaf: own }]);   // before: the denied request's authorization at leaf 1 rode along
    expect(update.newInventoryRoot).toBe(m.credentialInventory.getRoot().toString());
  });
});

describe('a member with a device: the approval\'s ledger step fails', () => {
  test('inventory slot 0 is put back with everything else and the request stays pending; the approval made again takes the same leaf', async () => {
    const { paId } = svc.requestPriorAuth({ memberWalletId: LEDGER, prescriberIndex: 0, ndcHash: ndcHashOf(PA_DRUG) });
    const before = recordOf(LEDGER, paId);
    const queue = svc.queueWalletUpdate;
    svc.queueWalletUpdate = function (this: unknown, ...args: any[]) {
      if (args[1] === 'prior-auth') throw new Error('wallet update (prior-auth): the credential cannot be rebuilt from its parts (stand-in)');
      return queue.apply(this, args);
    };
    try {
      await expect(svc.approvePriorAuth(paId)).rejects.toThrow('the credential cannot be rebuilt from its parts (stand-in)');
    } finally {
      delete svc.queueWalletUpdate;
    }
    expect(recordOf(LEDGER, paId)).toEqual(before);   // before: inventory slot 0, the credential and leaf 1 held the authorization and the next leaf index was 2

    const approved = await svc.approvePriorAuth(paId);
    expect(approved).toMatchObject({ status: 'APPROVED', paLeafIndex: 1 });   // before: leaf 2
    expect(accessControlLeaf(LEDGER, 1n)).toBe(svc.priorAuths.get(paId).priorAuthData.commitment().toString());
    expect(accessControlLeaf(LEDGER, 2n)).toBe('0');   // before: the approval's authorization, a second copy
    expect(svc.walletUpdatesFor(LEDGER).filter((u: any) => u.reason === 'prior-auth')).toHaveLength(1);
  });
});

describe('a fixture member: the sequencer does not take the proved update', () => {
  test('everything stays exactly as it was and the request stays pending; the approval made again lands at the same leaf', async () => {
    expect(svc.medIndexByNdcHash.has(ndcHashOf(PA_DRUG))).toBe(true);   // the drug is a leaf of the console's formulary: approving it adds nothing there
    const { paId } = svc.requestPriorAuth({ memberWalletId: FIXTURE, prescriberIndex: 0, ndcHash: ndcHashOf(PA_DRUG) });
    const before = recordOf(FIXTURE, paId);
    svc.submitWalletUpdate = async () => { throw new Error('ledger unavailable'); };
    try {
      await expect(svc.approvePriorAuth(paId)).rejects.toThrow('ledger unavailable');
      expect(recordOf(FIXTURE, paId)).toEqual(before);   // before: inventory slot 0, the credential and leaf 1 held the authorization and the next leaf index was 2

      svc.submitWalletUpdate = async () => ({ receiptId: 'r-fixture-pa', sequenceNumber: 1n });
      const approved = await svc.approvePriorAuth(paId);
      expect(approved).toMatchObject({ status: 'APPROVED', paLeafIndex: 1, l2Receipt: { receiptId: 'r-fixture-pa' } });   // before: leaf 2
      expect(accessControlLeaf(FIXTURE, 1n)).toBe(svc.priorAuths.get(paId).priorAuthData.commitment().toString());
      expect(accessControlLeaf(FIXTURE, 2n)).toBe('0');   // before: the approval's authorization, a second copy
    } finally {
      delete svc.submitWalletUpdate;
    }
  });
});
