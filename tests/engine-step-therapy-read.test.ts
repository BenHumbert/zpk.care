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
 * The step-therapy read changes nothing: a drug the console's formulary tree does not hold reads as not on the formulary.
 *
 * What was wrong: checkStepTherapy, which GET /interactive/step-therapy-check reaches without the proving lock, answered a
 * member served from the console's formulary, or a wallet the engine has not enrolled, through getFormularyLeafIndex.
 * For a drug the catalog indexes but the console's tree does not hold, that adds the drug to the tree, rebuilds the
 * console's EligibilityData and moves every member served from the console's formulary onto the new root (leaf 0 of
 * its forest and its credential), queueing a 'formulary' update for each member with a device: a read rewrote members'
 * credentials, outside the lock the engine's writers hold. Found by round one's sweep of option A step 1 (2026-10-24).
 * It is latent with today's catalogs, where every indexed drug is already a leaf; the tests plant one drug the way the
 * constructor's backfill indexes one, without a leaf.
 *
 * Now the read looks the entry up in the console's tree without adding it, as displayFormularyEntryFor does for the
 * other display reads, and a drug the tree does not hold is refused as not on the formulary (403), over the route too.
 * A drug the tree holds is answered as before.
 *
 * A real L2Node sequencer and RPC server and a real AdjudicationService with the engine's routes; nothing proved. The
 * engine's state is compared whole: the console's formulary tree, every member's record (every tree as its root and
 * every leaf) and the queue.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-step-therapy-read';
const ABACAVIR = '00378410591';
const ACULAR = '00023218105';                // step therapy required in the catalog
const CONSOLE = '79300000000000000001';      // a member with a device served from the console's formulary
const FIXTURE = '79300000000000000002';      // a fixture member, served from the console's formulary
const ON_PLAN = '79300000000000000003';      // a member with a device on its own plan's formulary
const UNKNOWN = '79300000000000000099';      // a wallet the engine has not enrolled

let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let hashString: (s: string) => Field;
let ForestDomain: any;
let CredentialData: any;
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

/** Everything the console formulary's add path changes: the console's tree and its index, its EligibilityData, every member's record and the queue. */
function engineState(): unknown {
  return plain({
    consoleRoot: svc.formularyRegistry.getRoot(),
    consoleCount: svc.formularyRegistry.count,
    indexed: svc.medIndexByNdcHash.size,
    entries: svc.currentFormularyEntries.length,
    sharedEligibility: svc.sharedEligibilityData.commitment(),
    members: svc.enrolledMembers,
    queue: svc.pendingWalletUpdates,
  });
}

/**
 * Serve a registered member from the console's formulary, as a member restored from a checkpoint is: PLAN-GOLD-2026
 * and the console's EligibilityData in leaf 0, and the ledger holding that credential (nothing queued). A fixture
 * member also has the identity preimage the engine proves with.
 */
function serveFromConsole(walletId: string, { fixture }: { fixture: boolean }): void {
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
}

/** A drug the catalog indexes with no leaf in the console's tree, as the constructor's backfill indexes one. */
function backfilledDrug(ndc: string): string {
  const base = svc.medByNdcHash.get(ndcHashOf(ABACAVIR));
  const ndcHash = ndcHashOf(ndc);
  svc.medByNdcHash.set(ndcHash, { ...base, ndc, ndcFormatted: `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`, brandName: `BACKFILLED ${ndc}`, formularyEntry: { ...base.formularyEntry, ndc } });
  expect(svc.medIndexByNdcHash.has(ndcHash)).toBe(false);
  return ndcHash;
}

/** GET /interactive/step-therapy-check as the operator, the route's one reader. */
async function stepRead(walletId: string, ndcHash: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${url}/interactive/step-therapy-check?memberWalletId=${walletId}&ndcHash=${ndcHash}`, { headers: { Authorization: `Bearer ${OPERATOR}` } });
  return { status: r.status, json: await r.json() };
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ ForestDomain } = await import('../src/zkp/merkle-forest.js'));
  ({ CredentialData } = await import('../src/credentials/credential-data.js'));
  const LC = await import('../src/engine/lifecycle.js');

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-step-therapy-read' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(server, svc);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;

  const base: any = {
    planId: 'PLAN-STR', name: 'Step therapy read', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
    formularyNdcs: [ABACAVIR, ACULAR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  for (const w of [CONSOLE, FIXTURE, ON_PLAN]) {
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(w)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: w, groupIdHash: ndcHashOf('GRP-STR'), planIdHash: ndcHashOf('PLAN-STR'), planId: 'PLAN-STR', employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: w, ownershipProofJson: '{}', displayName: 'Step therapy read member' });
  }
  serveFromConsole(CONSOLE, { fixture: false });
  serveFromConsole(FIXTURE, { fixture: true });
});

afterAll(async () => { await server?.stop(); });

describe('a step-therapy read for a drug the console\'s tree does not hold', () => {
  let outside: string;

  test('is refused as not on the formulary for a member served from the console\'s formulary and for a wallet the engine has not enrolled, and changes nothing', () => {
    outside = backfilledDrug('99999000011');
    const before = engineState();
    for (const who of [CONSOLE, FIXTURE, UNKNOWN]) {
      let refusal: any;
      try { svc.checkStepTherapy(who, outside); } catch (err) { refusal = err; }
      expect(refusal).toMatchObject({ name: 'RegistrationRefused', status: 403, message: 'BACKFILLED 99999000011 is not on the formulary of this member\'s plan (PLAN-GOLD-2026)' });   // before: answered (Step therapy not required), the drug added to the console's tree
    }
    expect(engineState()).toEqual(before);   // before: the console's root moved, each console member's leaf 0 and credential were rewritten and a 'formulary' update was queued for the member with a device
    expect(svc.medIndexByNdcHash.has(outside)).toBe(false);   // before: indexed at a new leaf
    expect(svc.walletUpdatesFor(CONSOLE)).toHaveLength(0);   // before: one 'formulary' update
  });

  test('over the route the read answers 403, still changing nothing', async () => {
    const before = engineState();
    for (const who of [CONSOLE, UNKNOWN]) {
      const r = await stepRead(who, outside);
      expect(r.status).toBe(403);   // before: 200
      expect(r.json.error).toBe('BACKFILLED 99999000011 is not on the formulary of this member\'s plan (PLAN-GOLD-2026)');   // before: the step-therapy answer
    }
    const another = backfilledDrug('99999000012');
    const r = await stepRead(CONSOLE, another);
    expect(r.status).toBe(403);   // before: 200
    expect(engineState()).toEqual(before);   // before: the drug added, the console members moved onto the new root and an update queued
  });
});

describe('a step-therapy read for a drug the console\'s tree holds is answered as before', () => {
  test('for a member served from the console\'s formulary, a wallet the engine has not enrolled and a member on its own plan, with nothing changed', async () => {
    const before = engineState();
    for (const who of [CONSOLE, FIXTURE, UNKNOWN, ON_PLAN]) {
      expect(svc.checkStepTherapy(who, ndcHashOf(ABACAVIR))).toEqual({ allowed: true, message: 'Step therapy not required' });
      expect(svc.checkStepTherapy(who, ndcHashOf(ACULAR)).message).not.toBe('Step therapy not required');
    }
    const r = await stepRead(CONSOLE, ndcHashOf(ABACAVIR));
    expect(r.status).toBe(200);
    expect(r.json.message).toBe('Step therapy not required');
    expect(engineState()).toEqual(before);
  });
});
