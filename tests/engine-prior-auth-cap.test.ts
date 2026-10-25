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
 * A member's prior authorizations stop at the last free leaf of its credential: the 127th approval is refused.
 *
 * What was wrong: an approval writes the PriorAuthData at the member's next ACCESS_CONTROL leaf, counted from 1, and
 * nothing stopped the count at 127, the leaf that holds the member's accumulator (ACCUMULATOR_LEAF_INDEX). The 127th
 * approval overwrote the accumulator with the authorization, queued that for the member's device to prove, and left the
 * member with no fill that could be proven: the fill circuit finds the accumulator at leaf 127. Found by the option A
 * specification (docs/research/a22-option-a-spec.md, 2026-10-24, section 5.6), as one of step 1's prerequisites.
 *
 * Now an approval whose leaf would be 127 is refused with 409 before anything changes: the leaf index is not taken, the
 * plan binding the member is due is not made, nothing is written or queued, and the request stays pending, so the
 * insurer can still deny it. The approve route answers with that status. The 126th approval still takes leaf 126.
 *
 * A real L2Node sequencer and RPC server and a real AdjudicationService with the engine's routes registered; programs
 * not compiled, every proof skipped. The 125 approvals before are stood in for by the engine's own count of the
 * member's next leaf.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-prior-auth-cap';
const PA_DRUG = '59148004580';    // ABILIFY MAINTENA ER 300 MG SYR: prior authorization, 30 EA per fill
const PA_ML_DRUG = '50242014301'; // ACTEMRA ACTPEN 162 MG/0.9 ML: prior authorization, 30 ML per fill
const W = '79600000000000000001';

let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let hashString: (s: string) => Field;
let publishedTermsFrom: any;
let buildPlanFormulary: any;
let ForestDomain: any;
let ACCUMULATOR_LEAF_INDEX: bigint;
let catalog: any[];
let m: any;
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

function publishedPlan(over: Record<string, unknown>): any {
  const base: any = {
    planId: 'PLAN-PA-CAP', name: 'Prior authorization cap', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1300,
    formularyNdcs: [PA_DRUG, PA_ML_DRUG], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0, ...over,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  return { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', Date.now()) };
}

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

async function approveViaRoute(priorAuthId: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${url}/interactive/approve-prior-auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ priorAuthId }),
  });
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
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  ({ ForestDomain } = await import('../src/zkp/merkle-forest.js'));
  ({ ACCUMULATOR_LEAF_INDEX } = await import('../src/access-control/accumulator-data.js'));
  const LC = await import('../src/engine/lifecycle.js');
  catalog = getAllFormularyEntries();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-prior-auth-cap' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(server, svc);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;

  await node.storePlan(publishedPlan({}));
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: W, groupIdHash: ndcHashOf('GRP-PA-CAP'), planIdHash: ndcHashOf('PLAN-PA-CAP'), planId: 'PLAN-PA-CAP', employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId: W, ownershipProofJson: '{}', displayName: 'Prior authorization cap member' });
  m = svc.enrolledMembers.get(W);
});

afterAll(async () => { await server?.stop(); });

describe('a member\'s prior authorizations end at leaf 126; leaf 127 is its accumulator', () => {
  test('the 126th approval takes leaf 126 and leaves the accumulator at leaf 127', async () => {
    svc.nextPaLeafIndex.set(W, 126n);   // leaves 1 to 125 taken by earlier approvals
    const { paId } = svc.requestPriorAuth({ memberWalletId: W, prescriberIndex: 0, ndcHash: ndcHashOf(PA_DRUG) });
    const approved = await svc.approvePriorAuth(paId);
    expect(approved).toMatchObject({ status: 'APPROVED', paLeafIndex: 126 });
    const pa = svc.priorAuths.get(paId);
    expect(m.forest.getLeaf(ForestDomain.ACCESS_CONTROL, 126n).toString()).toBe(pa.priorAuthData.commitment().toString());
    expect(m.forest.getLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX).toString()).toBe(m.accumulatorData.commitment().toString());
    expect(svc.nextPaLeafIndex.get(W)).toBe(127n);
    const update = svc.walletUpdatesFor(W).at(-1);
    expect(update.reason).toBe('prior-auth');
    expect(update.forestLeaves).toContainEqual({ domain: ForestDomain.ACCESS_CONTROL, index: String(ACCUMULATOR_LEAF_INDEX), leaf: m.accumulatorData.commitment().toString() });
  });

  test('the 127th approval is refused with 409 before anything changes, and the request stays pending for a decision', async () => {
    const { paId } = svc.requestPriorAuth({ memberWalletId: W, prescriberIndex: 0, ndcHash: ndcHashOf(PA_ML_DRUG) });
    // the insurer republishes the plan: the member is due a plan binding at its next action, which a refused approval is not
    await node.storePlan(publishedPlan({ copayAmountCents: 2500 }));
    const before = {
      index: svc.nextPaLeafIndex.get(W),
      status: svc.priorAuths.get(paId).status,
      member: plain(m),
      queue: plain(svc.walletUpdatesFor(W)),
    };

    const viaRoute = await approveViaRoute(paId);
    expect(viaRoute.status).toBe(409);   // before: 200, the authorization written over the accumulator at leaf 127
    expect(viaRoute.json.error).toBe(`No prior-authorization leaf is left in this member's credential (leaves 1 to 126 are taken and leaf 127 is its accumulator); ${paId} stays pending`);   // before: an APPROVED answer
    await expect(svc.approvePriorAuth(paId)).rejects.toMatchObject({ name: 'RegistrationRefused', status: 409, message: expect.stringMatching(/^No prior-authorization leaf is left/) });   // before: 'Prior auth is already APPROVED'

    expect(svc.nextPaLeafIndex.get(W)).toBe(before.index);   // before: 128n
    expect(svc.priorAuths.get(paId).status).toBe(before.status);   // before: APPROVED
    expect(plain(m)).toEqual(before.member);   // before: leaf 127 held the authorization, the credential and inventory slot 0 moved, the plan was rebound
    expect(m.forest.getLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX).toString()).toBe(m.accumulatorData.commitment().toString());   // before: the PriorAuthData commitment
    expect(plain(svc.walletUpdatesFor(W))).toEqual(before.queue);   // before: a 'plan binding' and a 'prior-auth' update queued
    expect(svc.priorAuthApprovalsInFlight.has(paId)).toBe(false);

    expect(svc.denyPriorAuth(paId, 'No room for another authorization')).toMatchObject({ status: 'DENIED' });   // before: already APPROVED (409)
  });
});
