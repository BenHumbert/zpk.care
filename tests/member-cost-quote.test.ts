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
 * The prescriber's estimate is the pre-script quote: what the fill would charge that member that day.
 *
 * What was wrong: l2_estimateCost priced from a different price list than the fill. The dashboard sent no planId, so
 * the estimate used the drug's tier copay and the network-default fee and skipped the deductible; it took the plan
 * from the caller when one was sent; it called drugs off the member's plan covered (the formulary service's overlay
 * lists), and split the claim with its own copy of the rules, without the family limits.
 *
 * Now, with a walletId, the sequencer asks the engine, through the quote provider the engine registers at start: the
 * member's own plan as published (a planId the caller sends is ignored), coverage from that plan's formulary (a drug
 * off it is not covered, as prescribing refuses it with 403), the fill's own price (NADAC x quantity + the plan's
 * fee), and the fill circuit's split over the member's and its family's accumulators. With no walletId, a planId reads
 * that plan's published drug list and copay. A fixture member keeps its tier copay and the network default fee. The
 * read rule is unchanged: the wallet itself, a caller with the member's attestation, the plan or the operator.
 *
 * A real L2Node sequencer and RPC server, and a real AdjudicationService with the engine's routes registered; programs
 * not compiled. The fill proof is AccumulatorFulfillmentProgram's own method run on constants (every constraint
 * checked, no proof), so the amounts each quote is compared with are the circuit's. The run.ts plan: copay $15, fee
 * $12.50, $500 deductible.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-member-quote';
const ABACAVIR = '00378410591';
const ADEFOVIR = '42794000308';
const ABILIFY = '59148000813';
const ADVAIR = '00173071622';      // priced per GM
const OFF_PLAN = '42385096230';    // claimable, not on the plan
const W = '79000000000000000001';
const FAMILY_A = '79000000000000000002';
const FAMILY_B = '79000000000000000003';
const FIXTURE = '79000000000000000004';

let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let hashString: (s: string) => Field;
let LC: any;
let publishedTermsFrom: any;
let buildPlanFormulary: any;
let catalog: any[];
let prescriberNode: any;
let signRequest: any;
let privateKeyFromSeedHex: any;
let buildAccumulatorData: any;
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

function publishedPlan(over: Record<string, unknown>): any {
  const base: any = {
    planId: 'PLAN-QUOTE', name: 'Quote plan', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
    formularyNdcs: [ABACAVIR, ADEFOVIR, ABILIFY, ADVAIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0, ...over,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  return { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) };
}

async function enroll(walletId: string, planId: string, familyIdHash: string | null = null): Promise<any> {
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(walletId)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId, groupIdHash: ndcHashOf('GRP-QUOTE'), planIdHash: ndcHashOf(planId), planId, employerId: null, familyIdHash });
  await svc.registerMemberFromEnrollment({ walletId, ownershipProofJson: '{}', displayName: 'Quote member' });
  const m = svc.enrolledMembers.get(walletId);
  m.pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };   // consent at prescribing: prescriber 0 is the PCP
  return m;
}

/** Prescribe, mark filled and dispense through the engine; the fill circuit runs on constants. */
async function prescribeAndFill(walletId: string, ndc: string, quantity: number): Promise<any> {
  const rx = await svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash: ndcHashOf(ndc), quantity, refills: 0 });
  svc.markFilled({ prescriptionId: rx.prescriptionId });
  return svc.dispensePrescription({ prescriptionId: rx.prescriptionId, quantityDispensed: quantity });
}

async function rpc(method: string, params: Record<string, unknown>, headers: Record<string, string> = { Authorization: `Bearer ${OPERATOR}` }): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now() + Math.random(), method, params });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return r.json();
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { AccumulatorFulfillmentProgram } = await import('../src/fulfillment/accumulator-fulfillment-program.js');
  const { formularyRaw } = await import('../src/data/formulary-loader.js');
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  ({ signRequest, privateKeyFromSeedHex } = await import('../src/security/signed-request.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  ({ buildAccumulatorData } = await import('../src/access-control/accumulator-data.js'));
  LC = await import('../src/engine/lifecycle.js');
  catalog = getAllFormularyEntries();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-member-quote' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  seq = node.getSequencer();
  seq.getFormularyService().loadFromNadac(formularyRaw);
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  // Every proof but the fill is skipped; the fill is the circuit's own method on constants.
  svc.dispatchProof = async (program: string, method: string, _types: string[], args: unknown[]) => {
    if (program !== 'AccumulatorFulfillment' || method !== 'proveFulfillmentWithAccumulator') return { proofJson: null, publicOutput: null, proveTimeMs: 0 };
    const raw = (AccumulatorFulfillmentProgram as any).rawMethods.proveFulfillmentWithAccumulator;
    const r = await raw(...args);
    const out = r.publicOutput ?? r;
    const publicOutput: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) publicOutput[k] = String(v);
    return { proofJson: null, publicOutput, proveTimeMs: 0 };
  };

  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  prescriberNode = generateNodeKey('prescriber-node');
  server.registerNodeKey(prescriberNode.nodeId, prescriberNode.publicKeyHex, 'prescriber');
  registerInteractiveRoutes(server, svc);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;

  await node.storePlan(publishedPlan({}));
  await node.storePlan(publishedPlan({ planId: 'PLAN-CHEAP', copayAmountCents: 0, dispensingFeeCents: 0, deductibleAmountCents: 0, formularyNdcs: [] }));
  await node.storePlan(publishedPlan({ planId: 'PLAN-FAMILY', familyOopMaxCents: 4000, formularyNdcs: [ABACAVIR, ADVAIR] }));
  await enroll(W, 'PLAN-QUOTE');
});

afterAll(async () => { await server?.stop(); });

describe('with a walletId, the estimate is the fill the member would get today', () => {
  test('the run.ts claims: each quote equals the fill proof that follows it, the accumulator carried from claim to claim', async () => {
    const expected: Array<[string, number, number, string]> = [
      [ABACAVIR, 3051, 0, 'deductible'],
      [ADEFOVIR, 48449, 23896, 'deductible'],
      [ABILIFY, 1500, 55813, 'copay'],
    ];
    for (const [ndc, member, plan, phase] of expected) {
      const quote = (await rpc('l2_estimateCost', { walletId: W, ndcHash: ndcHashOf(ndc), quantity: 30 })).result;
      expect(quote).toMatchObject({ covered: true, memberPayCents: member, employerPayCents: plan, phase, copayAmountCents: 1500, copayBasis: 'plan', dispensingFeeCents: 1250, dispensingFeeSource: 'plan', pricingUnit: 'EA', quantity: 30 });
      expect(quote.ingredientCostCents + quote.dispensingFeeCents).toBe(quote.totalCostCents);
      const fill = await prescribeAndFill(W, ndc, 30);
      expect([fill.adjudication.patientPayCents, fill.adjudication.planPayCents, fill.adjudication.totalCostCents])
        .toEqual([quote.memberPayCents, quote.employerPayCents, quote.totalCostCents]);
    }
  });

  test('a drug off the member\'s plan is not covered, as prescribing refuses it; the reason names no plan', async () => {
    const quote = (await rpc('l2_estimateCost', { walletId: W, ndcHash: ndcHashOf(OFF_PLAN), quantity: 30 })).result;
    expect(quote).toMatchObject({ covered: false, phase: 'not-covered', reason: "Not on the formulary of the member's plan" });
    expect(JSON.stringify(quote)).not.toContain('PLAN-QUOTE');
    await expect(svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: W, ndcHash: ndcHashOf(OFF_PLAN), quantity: 30, refills: 0 }))
      .rejects.toMatchObject({ status: 403 });
  });

  test('a planId the caller sends never replaces the member\'s own plan', async () => {
    const own = (await rpc('l2_estimateCost', { walletId: W, ndcHash: ndcHashOf(ADVAIR), quantity: 12 })).result;
    const claimed = (await rpc('l2_estimateCost', { walletId: W, ndcHash: ndcHashOf(ADVAIR), quantity: 12, planId: 'PLAN-CHEAP', dispensingFeeCents: 0 })).result;
    expect(claimed).toEqual(own);
    expect(own).toMatchObject({ dispensingFeeCents: 1250, copayAmountCents: 1500, pricingUnit: 'GM', ingredientCostCents: 22501 });
  });

  test('the response carries the member\'s share and the rule that set it, no balances and no plan', async () => {
    const quote = (await rpc('l2_estimateCost', { walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).result;
    expect(Object.keys(quote).sort()).toEqual([
      'classification', 'copayAmountCents', 'copayBasis', 'covered', 'dispensingFeeCents', 'dispensingFeeSource', 'drugName', 'employerPayCents',
      'ingredientCostCents', 'memberPayCents', 'nadacPerUnit', 'ndcHash', 'phase', 'pricingUnit', 'quantity', 'tierLevel', 'totalCostCents',
    ]);
  });

  test('family pooling: a family member\'s quote is capped at what is left of the family OOP max, and equals its fill', async () => {
    await enroll(FAMILY_A, 'PLAN-FAMILY', 'FAMILY-HASH-1');
    await enroll(FAMILY_B, 'PLAN-FAMILY', 'FAMILY-HASH-1');
    const a = await prescribeAndFill(FAMILY_A, ABACAVIR, 30);
    expect(a.adjudication.patientPayCents).toBe(3051);   // the family has paid 3051 of its $40.00 OOP max
    const quote = (await rpc('l2_estimateCost', { walletId: FAMILY_B, ndcHash: ndcHashOf(ADVAIR), quantity: 12 })).result;
    expect(quote).toMatchObject({ covered: true, totalCostCents: 23751, memberPayCents: 949, employerPayCents: 22802, phase: 'oop-max-reached' });
    const b = await prescribeAndFill(FAMILY_B, ADVAIR, 12);
    expect([b.adjudication.patientPayCents, b.adjudication.planPayCents]).toEqual([949, 22802]);
  });

  test('a fixture member keeps its tier copay and the network default fee, as its fill does', () => {
    svc.enrolledMembers.set(FIXTURE, {
      memberIndex: 0, walletId: Field(BigInt(FIXTURE)), walletIdStr: FIXTURE, displayName: 'Fixture', planId: 'PLAN-GOLD-2026', groupId: 'ACME-CORP',
      familyId: '', eligibilityData: svc.sharedEligibilityData, lifecycle: 'ELIGIBLE',
      accumulatorData: buildAccumulatorData({ planYear: '20260101', deductibleAmountCents: 50000, deductiblePaidCents: 50000, oopMaxCents: 800000, oopPaidCents: 50000, annualBenefitMaxCents: 5000000, annualBenefitUsedCents: 0 }),
    });
    const quote = svc.quoteMemberCost(FIXTURE, ndcHashOf(ABACAVIR), 30);
    expect(quote).toMatchObject({ covered: true, copayAmountCents: 1000, copayBasis: 'tier', tierLevel: 1 });
    expect(quote.price).toMatchObject({ ingredientCostCents: 1801, dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', totalCostCents: 2801 });
    expect(quote.split).toMatchObject({ patientPayCents: 1000, planPayCents: 1801, phase: 'copay' });
    svc.enrolledMembers.delete(FIXTURE);
  });

  test('a wallet the engine has not enrolled is refused, saying so', async () => {
    const r = await rpc('l2_estimateCost', { walletId: '79000000000000009999', ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect(r.error?.message).toMatch(/not a member enrolled with the engine/);
  });
});

describe('the read rule is unchanged', () => {
  const envelopeFor = (params: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'l2_estimateCost', params });
  const asPrescriberNode = (body: string) => signRequest({ signerId: prescriberNode.nodeId, privateKey: privateKeyFromSeedHex(prescriberNode.seedHex), method: 'POST', path: '/rpc', body });
  async function signed(body: string): Promise<any> {
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...asPrescriberNode(body) }, body });
    return r.json();
  }

  test('a prescriber node without the member\'s attestation is refused; with it, it gets the member\'s quote', async () => {
    const bare = envelopeFor({ walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect((await signed(bare)).error?.message).toMatch(/Forbidden/);
    const attestation = node.requestAttestation(W);
    const tapped = envelopeFor({ walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30, memberAttestation: attestation });
    const r = await signed(tapped);
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ covered: true, copayBasis: 'plan', dispensingFeeCents: 1250 });
  });

  test('with no member it stays open', async () => {
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: envelopeFor({ ndcHash: ndcHashOf(ABACAVIR), quantity: 30 }) });
    expect((await r.json()).result).toMatchObject({ covered: true, dispensingFeeSource: 'network-default' });
  });
});

describe('with no walletId, a planId reads the plan as published', () => {
  test('a drug off its published drug list is excluded; one on it is priced at the plan\'s copay and fee', async () => {
    const off = (await rpc('l2_estimateCost', { planId: 'PLAN-QUOTE', ndcHash: ndcHashOf(OFF_PLAN), quantity: 30 })).result;
    expect(off).toMatchObject({ covered: false, reason: 'Drug excluded from this plan' });
    const on = (await rpc('l2_estimateCost', { planId: 'PLAN-QUOTE', ndcHash: ndcHashOf(ABILIFY), quantity: 30 })).result;
    expect(on).toMatchObject({ covered: true, copayAmountCents: 1500, copayBasis: 'plan', dispensingFeeCents: 1250, totalCostCents: 57313, memberPayCents: 1500, employerPayCents: 55813, phase: 'copay' });
  });

  test('a plan that lists no drugs covers the whole catalog', async () => {
    const r = (await rpc('l2_estimateCost', { planId: 'PLAN-CHEAP', ndcHash: ndcHashOf(OFF_PLAN), quantity: 30 })).result;
    expect(r).toMatchObject({ covered: true, copayAmountCents: 0, dispensingFeeCents: 0, memberPayCents: 0 });
  });

  test('a plan never published bills no one: not covered, with the price its draft states', async () => {
    await node.storePlan({ planId: 'PLAN-DRAFT', name: 'Draft', coverageType: 1, copayAmountCents: 500, deductibleAmountCents: 0, oopMaxCents: 0, annualBenefitMaxCents: 0, dispensingFeeCents: 1250, formularyNdcs: [], networkProviderWalletIds: [], published: false, createdAt: 0, updatedAt: 0 });
    const r = (await rpc('l2_estimateCost', { planId: 'PLAN-DRAFT', ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).result;
    expect(r).toMatchObject({ covered: false, phase: 'not-covered', ingredientCostCents: 1801, dispensingFeeCents: 1250, totalCostCents: 3051 });
    expect(r.reason).toMatch(/not published/);
  });

  test('a quantity with a fourth decimal is refused', async () => {
    const r = await rpc('l2_estimateCost', { ndcHash: ndcHashOf(ABACAVIR), quantity: 1.0001 });
    expect(r.error?.message).toMatch(/at most three decimals/);
  });
});

describe('the prescriber node\'s /estimate-cost route', () => {
  let buildPrescriberRoutes: any;
  beforeAll(async () => { ({ buildPrescriberRoutes } = await import('../src/nodes/routes/prescriber-routes.js')); });

  function routeWith(answer: (params: any) => Promise<unknown>) {
    const asked: any[] = [];
    const sent: Array<{ status: number; data?: unknown; error?: string }> = [];
    const fakeServer = {
      getEntityNode: () => ({ getWalletId: () => '5001', getClient: () => ({ estimateCost: (p: any) => { asked.push(p); return answer(p); } }) }),
      getConfig: () => ({ sequencerUrl: 'http://seq.test' }),
      getLocalState: () => ({ hasEnrollmentKey: () => false }),
      signedFetch: () => Promise.resolve(new Response('{}', { status: 500 })),
      sendResponse(_res: unknown, status: number, _ok: boolean, data?: unknown, error?: string) { sent.push({ status, data, error }); },
    };
    jest.useFakeTimers();   // the builder starts a PCP sync interval
    let routes: any[];
    try { routes = buildPrescriberRoutes(fakeServer as any); } finally { jest.useRealTimers(); }
    const route = routes.find((r) => r.method === 'POST' && r.path === '/estimate-cost');
    return {
      asked, sent,
      call: (body: unknown, headers: Record<string, string> = {}) => route.handler({ headers }, {}, {}, new URLSearchParams(), body),
    };
  }

  test('forwards the member\'s tapped attestation, and only the fields the quote reads', async () => {
    const r = routeWith(async () => ({ covered: true }));
    const attestation = { w: W, sig: 'aa', exp: 1 };
    await r.call({ ndcHash: '11', walletId: W, quantity: 30, planId: 'PLAN-CHEAP', dispensingFeeCents: 0 }, { 'x-member-attestation': Buffer.from(JSON.stringify(attestation)).toString('base64') });
    expect(r.asked[0]).toEqual({ ndcHash: '11', walletId: W, quantity: 30, memberAttestation: attestation });
    await r.call({ ndcHash: '11', quantity: 30, planId: 'PLAN-QUOTE' });
    expect(r.asked[1]).toEqual({ ndcHash: '11', quantity: 30, planId: 'PLAN-QUOTE' });
    expect(r.sent.map((s) => s.status)).toEqual([200, 200]);
  });

  test('a refusal for want of the member\'s tap is a 403 that says so; a bad quantity is a 400 before asking', async () => {
    const r = routeWith(async () => { throw new Error('RPC error -32004: Forbidden — l2_estimateCost for wallet 79000000000… answers that wallet'); });
    await r.call({ ndcHash: '11', walletId: W, quantity: 30 });
    expect(r.sent[0].status).toBe(403);
    expect(r.sent[0].error).toMatch(/member's tapped attestation/);
    await r.call({ ndcHash: '11', walletId: W, quantity: 0.0004 });
    expect(r.sent[1].status).toBe(400);
    expect(r.asked).toHaveLength(1);
  });
});
