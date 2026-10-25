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
 * A drug added to the console's formulary reaches each member with a device on it as its own 'formulary' update.
 *
 * What was wrong: getFormularyLeafIndex adds a drug that the catalog indexes but the console's formulary tree does not
 * hold yet, rebuilds the console's EligibilityData and moves every member served from the console's formulary onto the
 * new root: leaf 0 of its forest and its credential's forest root. For a member with a device it queued no wallet
 * update, so the change rode inside the member's next update of another kind (a fill, a prior authorization), which
 * the device was asked to prove as that kind. updateFormularyEntry, the console's other formulary change, queues one
 * 'formulary' update for each member with a device it moves. Found by the option A specification
 * (docs/research/a22-option-a-spec.md, 2026-10-24, section 5.6), as one of step 1's prerequisites: under option A the
 * phone checks each update against its kind.
 *
 * Now the add path updates inventory slot 0 and queues one 'formulary' update for each member with a device it moves,
 * as updateFormularyEntry does; the parts sent rebuild the root named. A fixture member, whose updates the engine
 * proves, is moved as before and its next update carries the change; a member on its own plan's formulary is not
 * touched.
 *
 * With today's catalogs the path is not reached: the catalog the constructor backfills from is always a subset of the
 * drugs the tree is built from, so every indexed drug already has a leaf. The tests plant one drug the way the
 * backfill indexes one, without a leaf. A member with a device on the console's formulary is one bound to
 * PLAN-GOLD-2026 before plan binding (an older checkpoint); the tests make one, and a fixture member, from members
 * registered on a plan.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled, every proof skipped.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const ABACAVIR = '00378410591';
const DEVICE = '79700000000000000001';    // a member with a device, served from the console's formulary
const FIXTURE = '79700000000000000002';   // a fixture member: the engine proves its updates
const ON_PLAN = '79700000000000000003';   // a member with a device on its own plan's formulary

let node: any;
let seq: any;
let svc: any;
let hashString: (s: string) => Field;
let ForestDomain: any;
let CredentialData: any;
let rederiveInventoryRoot: any;
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

/**
 * Serve a registered member from the console's formulary, as a member restored from a checkpoint is: PLAN-GOLD-2026
 * and the console's EligibilityData in leaf 0, and the ledger holding that credential (nothing queued). A fixture
 * member also has the identity preimage the engine proves with.
 */
function serveFromConsole(walletId: string, { fixture }: { fixture: boolean }): any {
  const m = svc.enrolledMembers.get(walletId);
  m.planId = 'PLAN-GOLD-2026';
  if (fixture) {
    m.memberIndex = 0;
    m.preimageFields = [1, 2, 3, 4, 5, 6].map((n) => Field(n));
  }
  m.eligibilityData = svc.sharedEligibilityData;
  m.forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, m.eligibilityData.commitment());
  const c = m.credentialData;
  m.credentialData = new CredentialData({ credentialType: c.credentialType, forestRoot: m.forest.getForestRoot(), issuerWalletId: c.issuerWalletId, subjectWalletId: c.subjectWalletId, issuedAt: c.issuedAt, expiresAt: c.expiresAt, revoked: c.revoked });
  m.credentialInventory.updateCredential(0n, m.credentialData);
  for (const u of svc.walletUpdatesFor(walletId)) svc.pendingWalletUpdates.delete(u.updateId);
  m.credentialInventoryRoot = m.credentialInventory.getRoot();
  return m;
}

/** A drug the catalog indexes with no leaf in the console's tree, as the constructor's backfill indexes one. */
function backfilledDrug(ndc: string): string {
  const base = svc.medByNdcHash.get(ndcHashOf(ABACAVIR));
  const ndcHash = ndcHashOf(ndc);
  svc.medByNdcHash.set(ndcHash, { ...base, ndc, ndcFormatted: `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`, brandName: `BACKFILLED ${ndc}`, formularyEntry: { ...base.formularyEntry, ndc } });
  expect(svc.medIndexByNdcHash.has(ndcHash)).toBe(false);
  return ndcHash;
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
  ({ rederiveInventoryRoot } = await import('../src/credentials/wallet-update.js'));
  const LC = await import('../src/engine/lifecycle.js');

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-console-formulary-add' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });

  const base: any = {
    planId: 'PLAN-CFA', name: 'Console formulary add', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
    formularyNdcs: [ABACAVIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  for (const w of [DEVICE, FIXTURE, ON_PLAN]) {
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(w)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: w, groupIdHash: ndcHashOf('GRP-CFA'), planIdHash: ndcHashOf('PLAN-CFA'), planId: 'PLAN-CFA', employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: w, ownershipProofJson: '{}', displayName: 'Console formulary member' });
  }
  serveFromConsole(DEVICE, { fixture: false });
  serveFromConsole(FIXTURE, { fixture: true });
});

describe('the console formulary\'s add path queues the change for each member with a device it moves', () => {
  let added: string;
  let index: bigint;
  let before: Record<string, any>;

  test('a member with a device on the console\'s formulary gets one \'formulary\' update, whose parts rebuild the root it names', () => {
    const d = svc.enrolledMembers.get(DEVICE);
    before = {
      deviceRoot: d.credentialInventory.getRoot().toString(),
      fixture: plain(svc.enrolledMembers.get(FIXTURE)),
      onPlan: plain(svc.enrolledMembers.get(ON_PLAN)),
      consoleRoot: svc.formularyRegistry.getRoot().toString(),
    };
    added = backfilledDrug('99999000001');
    index = svc.getFormularyLeafIndex(added);
    expect(svc.formularyRegistry.getEntry(index).ndcHash.toString()).toBe(added);
    expect(svc.formularyRegistry.getRoot().toString()).not.toBe(before.consoleRoot);
    expect(d.eligibilityData.formularyRoot.toString()).toBe(svc.formularyRegistry.getRoot().toString());
    expect(d.credentialInventory.getCredential(0n).commitment().toString()).toBe(d.credentialData.commitment().toString());   // before: slot 0 still held the credential from before the change

    const updates = svc.walletUpdatesFor(DEVICE);
    expect(updates).toHaveLength(1);   // before: 0, the change left to ride inside the member's next update
    const [u] = updates;
    expect(u).toMatchObject({ reason: 'formulary', phase: 'formulary', status: 'pending', claimCommitted: false, oldInventoryRoot: before.deviceRoot, newInventoryRoot: d.credentialInventory.getRoot().toString() });   // before: none queued
    expect(u.newInventoryRoot).not.toBe(before.deviceRoot);
    expect(rederiveInventoryRoot(u).inventoryRoot).toBe(u.newInventoryRoot);
    expect(u.forestLeaves).toContainEqual({ domain: ForestDomain.ACCESS_CONTROL, index: '0', leaf: svc.sharedEligibilityData.commitment().toString() });
  });

  test('a fixture member is moved onto the new root with nothing queued, and a member on its own plan is not touched', () => {
    const f = svc.enrolledMembers.get(FIXTURE);
    expect(svc.walletUpdatesFor(FIXTURE)).toHaveLength(0);
    expect(f.eligibilityData).toBe(svc.sharedEligibilityData);
    expect(f.forest.getLeaf(ForestDomain.ACCESS_CONTROL, 0n).toString()).toBe(svc.sharedEligibilityData.commitment().toString());
    expect(f.credentialData.forestRoot.toString()).toBe(f.forest.getForestRoot().toString());
    expect(plain(f.credentialInventory)).toEqual(before.fixture.credentialInventory);   // its next update, which the engine proves, carries the change

    expect(svc.walletUpdatesFor(ON_PLAN)).toHaveLength(1);   // its credential mint, nothing more
    expect(plain(svc.enrolledMembers.get(ON_PLAN))).toEqual(before.onPlan);
  });

  test('the drug\'s next lookup finds its leaf and queues nothing more', () => {
    expect(svc.getFormularyLeafIndex(added)).toBe(index);
    expect(svc.walletUpdatesFor(DEVICE)).toHaveLength(1);   // before: 0, nothing was queued for the added drug
  });

  test('prescribing a drug the console\'s tree does not hold yet queues the member\'s \'formulary\' update, next in its chain', async () => {
    const d = svc.enrolledMembers.get(DEVICE);
    d.pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };   // consent at prescribing: prescriber 0 is the PCP
    const next = backfilledDrug('99999000002');
    const queued = svc.walletUpdatesFor(DEVICE);
    const head = queued.length > 0 ? queued.at(-1).newInventoryRoot : d.credentialInventoryRoot.toString();   // where the device's next update starts
    const rx = await svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: DEVICE, ndcHash: next, quantity: 30, refills: 0 });
    expect(rx.prescriptionId).toEqual(expect.any(String));
    const updates = svc.walletUpdatesFor(DEVICE);
    expect(updates).toHaveLength(queued.length + 1);   // before: no update queued
    expect(updates.at(-1)).toMatchObject({ reason: 'formulary', oldInventoryRoot: head, newInventoryRoot: d.credentialInventory.getRoot().toString() });   // before: none queued
    expect(rederiveInventoryRoot(updates.at(-1)).inventoryRoot).toBe(updates.at(-1).newInventoryRoot);
  });
});
