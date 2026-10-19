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
 * Quantities count the drug's NADAC pricing unit (EA, ML or GM, the NCPDP billing units), to thousandths of it.
 *
 * What was wrong: nothing in a request or on a screen said which unit a quantity counts, though NADAC x quantity now
 * sets the price: the prescriber's form said "Quantity" with min=1 and the engine's log said "30 tablets" from the
 * dosage form. A guard refused any fill below one unit, so 0.4 ML (one ADALIMUMAB pen) could not be dispensed, and the
 * engine's quantity arithmetic was in floating point (0.3 - 0.1 left 0.19999999999999998 to dispense).
 *
 * Now the unit is shown beside every quantity input and every quantity shown with a price, and in the engine's log
 * lines; quantities are accepted in thousandths of the unit (greater than 0, at most three decimals, NCPDP's
 * precision), refused otherwise at every door with 400; the engine's remaining-quantity and partial-fill arithmetic is
 * in exact thousandths, the scale quantityToField gives the circuits, whose comparisons (dispensed <= prescribed <=
 * maximum per fill) are all at that one scale; the reporting strings are exact integers.
 *
 * A real L2Node sequencer and RPC server and a real AdjudicationService; the fill is AccumulatorFulfillmentProgram's
 * own method run on constants, every constraint checked, no proof. ADVAIR HFA is priced per GM, ADALIMUMAB-ADAZ per ML.
 */
import fs from 'fs';
import vm from 'vm';
import { Field, MerkleTree } from 'o1js';
import { quantityError, quantityMilli, formatQuantity, priceDispense, quoteNadacPrice } from '../src/fulfillment/nadac-pricing.js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-quantity-units';
const ADVAIR = '00173071622';       // $18.75078 per GM
const ADALIMUMAB = '61314032720';   // $1,590.28426 per ML; one pen is 0.4 ML
const W = '79500000000000000001';
let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let events: Array<{ message: string }> = [];
let hashString: (s: string) => Field;
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

describe('quantityError: thousandths of the pricing unit', () => {
  test('accepts a positive number with at most three decimals', () => {
    for (const q of [30, 0.4, 0.001, 12.5, 1.005, 9_999_999.999]) expect([q, quantityError(q)]).toEqual([q, null]);
  });
  test('refuses 0, negatives, a fourth decimal, non-numbers and the absurd', () => {
    for (const q of [0, -1, 0.0005, 1.0001, '30', NaN, Infinity, null, undefined, 10_000_000]) expect(quantityError(q)).not.toBeNull();
    expect(quantityError(1.0001)).toMatch(/at most three decimals/);
  });
  test('thousandths are exact integers, and the price is NADAC x quantity in them', () => {
    expect([quantityMilli(0.4), quantityMilli(1.005), quantityMilli(0.3) - quantityMilli(0.1)]).toEqual([400, 1005, 200]);
    expect(formatQuantity(0.4, 'ML')).toBe('0.4 ML');
    expect(priceDispense(quoteNadacPrice({ ndc: ADALIMUMAB, nadacPerUnit: 1590.28426, pricingUnit: 'ML' }, null), 0.4).ingredientCostCents).toBe(63611);
    expect(priceDispense(quoteNadacPrice({ ndc: ADVAIR, nadacPerUnit: 18.75078, pricingUnit: 'GM' }, null), 12).ingredientCostCents).toBe(22501);
  });
});

describe('the engine, with an ML drug and a GM drug', () => {
  beforeAll(async () => {
    process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
    const { InMemoryStore } = await import('../src/storage/local-store.js');
    const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
    const { L2Node } = await import('../src/l2/l2-node.js');
    const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
    const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
    const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
    const { AccumulatorFulfillmentProgram } = await import('../src/fulfillment/accumulator-fulfillment-program.js');
    const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
    const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
    const { getAllFormularyEntries } = await import('../src/data/index.js');
    const { formularyRaw } = await import('../src/data/formulary-loader.js');
    ({ hashString } = await import('../src/zkp/hash-utils.js'));
    const LC = await import('../src/engine/lifecycle.js');

    const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
    node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-quantity-units' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    seq = node.getSequencer();
    seq.getFormularyService().loadFromNadac(formularyRaw);
    svc = new AdjudicationService((e: { message: string }) => events.push(e), () => {}, node);
    svc.compiled = true;
    svc.verifyOwnershipProof = async (_w: string, j: string) => j;
    svc.dispatchProof = async (program: string, method: string, _types: string[], args: unknown[]) => {
      if (program !== 'AccumulatorFulfillment' || method !== 'proveFulfillmentWithAccumulator') return { proofJson: null, publicOutput: null, proveTimeMs: 0 };
      const r = await (AccumulatorFulfillmentProgram as any).rawMethods.proveFulfillmentWithAccumulator(...args);
      const out = r.publicOutput ?? r;
      const publicOutput: Record<string, string> = {};
      for (const [k, v] of Object.entries(out)) publicOutput[k] = String(v);
      return { proofJson: null, publicOutput, proveTimeMs: 0 };
    };
    server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    registerInteractiveRoutes(server, svc);
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;

    const base: any = {
      planId: 'PLAN-UNITS', name: 'Units plan', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 0, oopMaxCents: 780000,
      annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
      formularyNdcs: [ADVAIR, ADALIMUMAB], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
    };
    const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
    await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: W, groupIdHash: ndcHashOf('GRP-UNITS'), planIdHash: ndcHashOf('PLAN-UNITS'), planId: 'PLAN-UNITS', employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: W, ownershipProofJson: '{}', displayName: 'Units member' });
    svc.enrolledMembers.get(W).pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };
  });

  afterAll(async () => { await server?.stop(); });

  const prescribe = (ndc: string, quantity: unknown, pharmacyIndex = 0) =>
    svc.createPrescription({ prescriberIndex: 0, pharmacyIndex, memberWalletId: W, ndcHash: ndcHashOf(ndc), quantity, refills: 0 });

  test('one ADALIMUMAB pen, 0.4 ML: prescribed, proven and priced at NADAC x 0.4 ML, with the unit in the log', async () => {
    events = [];
    const rx = await prescribe(ADALIMUMAB, 0.4);
    expect(rx.prescriptionData.quantityPrescribed).toBe('400');
    svc.markFilled({ prescriptionId: rx.prescriptionId });
    const fill = await svc.dispensePrescription({ prescriptionId: rx.prescriptionId, quantityDispensed: 0.4 });
    expect(fill.adjudication).toMatchObject({ ingredientCostCents: 63611, dispensingFeeCents: 1250, totalCostCents: 64861 });
    expect(fill.fulfillmentDetail.quantityDispensed).toBe('400');   // the circuit compared 400 <= 400 <= 90000
    expect(fill.rxStatus).toBe('DISPENSED');
    const log = events.map((e) => e.message);
    expect(log.filter((l) => l.startsWith('    Qty:'))).toEqual(['    Qty:     0.4 ML (the NADAC pricing unit), 0 refills']);   // not the dosage form plus s
    expect(log.some((l) => /^  Filling ADALIMUMAB.* — 0\.4 ML$/.test(l))).toBe(true);
  });

  test('0.1 GM and then 0.2 GM of a 0.3 GM prescription: the remainder is exact, more than it is refused, saying the unit', async () => {
    const rx = await prescribe(ADVAIR, 0.3);
    svc.markFilled({ prescriptionId: rx.prescriptionId });
    await svc.dispensePrescription({ prescriptionId: rx.prescriptionId, quantityDispensed: 0.1 });
    await expect(svc.dispensePrescription({ prescriptionId: rx.prescriptionId, quantityDispensed: 0.3 }))
      .rejects.toThrow('Quantity dispensed (0.3 GM) exceeds remaining prescribed qty (0.2 GM of 0.3 GM)');
    const second = await svc.dispensePrescription({ prescriptionId: rx.prescriptionId, quantityDispensed: 0.2 });
    expect(second.rxStatus).toBe('DISPENSED');
    expect(second.quantityDispensed).toBe(0.3);
    expect(second.adjudication.ingredientCostCents).toBe(375);   // 18.75078 x 0.2 = 3.750156 -> $3.75
  });

  test('every door refuses a quantity that is not one, with 400', async () => {
    for (const q of [0, -1, 0.0005, '30']) await expect(prescribe(ADVAIR, q, 1)).rejects.toMatchObject({ status: 400 });
    const rx = await prescribe(ADVAIR, 12, 1);
    svc.markFilled({ prescriptionId: rx.prescriptionId });
    await expect(svc.dispensePrescription({ prescriptionId: rx.prescriptionId, quantityDispensed: 1.0001 })).rejects.toMatchObject({ status: 400 });
    const asOperator = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` };
    const pres = await fetch(`${url}/interactive/prescribe`, { method: 'POST', headers: asOperator, body: JSON.stringify({ prescriberIndex: 0, pharmacyIndex: 1, memberWalletId: W, ndcHash: ndcHashOf(ADVAIR), quantity: 1.0001 }) });
    expect(pres.status).toBe(400);
    const fillRoute = await fetch(`${url}/interactive/fill`, { method: 'POST', headers: asOperator, body: JSON.stringify({ prescriptionId: rx.prescriptionId, quantityDispensed: 0 }) });
    expect(fillRoute.status).toBe(400);
  });

  test('the reporting strings are exact integers of thousandths', () => {
    const fills = svc.fulfillments;
    const someFill = [...fills.values()][0][0];
    const saved = someFill.quantityDispensed;
    someFill.quantityDispensed = 1.005;   // (1.005 * 1000).toString() was "1004.9999999999999", which BigInt() refuses
    try {
      const claims = svc.buildVerifiedClaims();
      expect(claims.map((c: any) => c.quantityDispensed)).toContain('1005');
      for (const c of claims) expect(c.quantityDispensed).toMatch(/^\d+$/);
      expect(() => svc.buildReports()).not.toThrow();
    } finally {
      someFill.quantityDispensed = saved;
    }
  });
});

describe('the provider nodes\' routes', () => {
  function fakeServer() {
    const sent: Array<{ status: number; error?: string }> = [];
    const calls: string[] = [];
    const server = {
      getEntityNode: () => ({ getWalletId: () => '5001', storeMessage: jest.fn(), getClient: () => ({}) }),
      getConfig: () => ({ sequencerUrl: 'http://seq.test' }),
      getLocalState: () => ({ hasEnrollmentKey: () => false }),
      signedFetch: (u: string) => { calls.push(u); return Promise.resolve(new Response('{}', { status: 500 })); },
      sendResponse(_res: unknown, status: number, _ok: boolean, _data?: unknown, error?: string) { sent.push({ status, error }); },
    };
    return { server, sent, calls };
  }
  const call = (routes: any[], method: string, path: string, body: unknown) => routes.find((r) => r.method === method && r.path === path).handler({ headers: {} }, {}, {}, new URLSearchParams(), body);

  test('the pharmacy node refuses a quantity dispensed that is not one before it asks the engine', async () => {
    const { buildPharmacyRoutes } = await import('../src/nodes/routes/pharmacy-routes.js');
    const f = fakeServer();
    const routes = buildPharmacyRoutes(f.server as any);
    await call(routes, 'POST', '/dispensing/dispense', { prescriptionId: 'RX-1', quantityDispensed: 0.0004 });
    await call(routes, 'POST', '/dispensing/fill', { memberWalletId: '1', ndcHash: '1', prescriberWalletId: '700', quantity: -2 });
    expect(f.sent.map((s) => s.status)).toEqual([400, 400]);
    expect(f.calls).toEqual([]);
  });

  test('the prescriber node refuses one before any eScript goes out', async () => {
    const { buildPrescriberRoutes } = await import('../src/nodes/routes/prescriber-routes.js');
    const f = fakeServer();
    jest.useFakeTimers();
    let routes: any[];
    try { routes = buildPrescriberRoutes(f.server as any); } finally { jest.useRealTimers(); }
    await call(routes!, 'POST', '/prescriptions/prescribe', { memberWalletId: '1', pharmacyWalletId: '500', ndcHash: '1', quantity: 0 });
    await call(routes!, 'POST', '/prescriptions/write', { memberWalletId: '1', pharmacyWalletId: '500', ndcHash: '1', quantity: 2.0005 });
    expect(f.sent.map((s) => s.status)).toEqual([400, 400]);
    expect(f.calls).toEqual([]);
  });
});

describe('the screens', () => {
  const NL = String.fromCharCode(10);
  const read = (p: string) => fs.readFileSync(p, 'utf8').split(String.fromCharCode(13) + NL).join(NL);
  function lift(app: string, name: string): string {
    let at = app.indexOf(NL + '  function ' + name + '(');
    if (at < 0) at = app.indexOf(NL + '  async function ' + name + '(');
    if (at < 0) throw new Error('no function ' + name);
    return app.slice(at + 1, app.indexOf(NL + '  }' + NL, at) + 4);
  }

  test('the prescriber\'s form shows the pricing unit beside the quantity and takes thousandths', () => {
    const html = read('dashboard-prescriber/index.html');
    expect(html).toMatch(/<span id="rx-quantity-unit">/);
    expect(html).toMatch(/id="rx-quantity" value="30" min="0\.001" step="0\.001"/);
    const app = read('dashboard-prescriber/app.js');
    const ctx: Record<string, any> = {};
    vm.createContext(ctx);
    vm.runInContext(lift(app, 'parseQuantity') + NL + 'globalThis.parseQuantity = parseQuantity;', ctx);
    expect(['0.4', '30', '.5', '12.125'].map((s) => ctx.parseQuantity(s))).toEqual([0.4, 30, 0.5, 12.125]);
    for (const bad of ['0', '1.0001', 'abc', '-1', '']) expect(Number.isNaN(ctx.parseQuantity(bad))).toBe(true);
    expect(app).not.toContain("parseInt($('#rx-quantity')");
    // the estimate card names the unit after the quantity and labels the drug cost as the ingredient
    expect(app).toContain("'<div style=\"color:var(--text-muted);margin-bottom:4px\">Ingredient (NADAC)</div>'");
    expect(app).toContain("'/' + esc(unit) + ' x ' + esc(est.quantity) + ' ' + esc(unit)");
  });

  test('the pharmacy shows the unit on the card, in the price and in the detail, and dispenses what is left', async () => {
    const app = read('dashboard-pharmacy/app.js');
    const cents = (c: unknown) => '$' + (Number(c) / 100).toFixed(2);
    const claim = {
      prescriptionId: 'RX-9', status: 'FILLED', quantity: 0.3, quantityDispensed: 0.1, pricingUnit: 'GM',
      pricing: { nadacUnitPriceE5: 1875078, pricingUnit: 'GM', quantity: 0.1, ingredientCostCents: 188, dispensingFeeCents: 1250, dispensingFeeSource: 'plan' },
    };
    const sentBodies: any[] = [];
    const ctx: Record<string, any> = {
      scriptWorkflow: {}, formatCents: cents, escapeHtml: String, truncate: String, formatDate: String, $: () => null,
      scriptKey: (c: { prescriptionId: string }) => c.prescriptionId, getScriptIssue: () => null, isScriptVerified: () => true,
      findClaimByKey: () => claim, renderWorkstationColumns: () => {}, toast: () => {}, loadWorkstation: () => {}, console: { warn() {} },
      API: { dispensing: { dispense: (b: unknown) => { sentBodies.push(b); return Promise.resolve({ jobKey: null }); } } },
    };
    vm.createContext(ctx);
    vm.runInContext(['getScriptStatus', 'setScriptStatus', 'fillPricingOf', 'formatNadacUnit', 'nadacBreakdown', 'renderColumn', 'dispenseScript'].map((n) => lift(app, n)).join(NL), ctx);
    expect(ctx.nadacBreakdown(ctx.fillPricingOf(claim, {}))).toBe('NADAC $18.75078/GM x 0.1 GM = $1.88 + dispensing fee $12.50 = $14.38');
    const column = { innerHTML: '' };
    ctx.renderColumn(column, [claim], 'filled');
    expect(column.innerHTML).toContain('0.3 GM');
    await ctx.dispenseScript('RX-9');
    expect(sentBodies).toEqual([{ prescriptionId: 'RX-9', quantityDispensed: 0.2 }]);
    expect(app).toContain("['Qty Dispensed', withUnit(qty)]");
  });
});
