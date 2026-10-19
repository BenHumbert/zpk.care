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
 * The review of the prescriber quote and prior-authorization work (owner decision 2026-10-19): the engine and the
 * sequencer.
 *
 * What was wrong:
 *  1. l2_estimateCost also admitted the 'pcp' reader, the sequencer's PCP links. Those keep every prescriber a member
 *     ever named and do not follow a provider's status, so a former or a suspended primary-care prescriber read the
 *     member's price, her deductible phase and her prior-authorization status for any drug, which the engine's own
 *     consent check (the 'prescriber' reader) refuses.
 *  2. A prescriber's reason for a request and an insurer's reason for a denial went into engine messages as typed, and
 *     the operator console drew those messages as HTML: a reason that was markup ran in the page that holds the
 *     operator token.
 *  3. An approval authorized the plan's whole limit per fill, whatever quantity the prescriber asked for and the
 *     insurer's review list showed as the request.
 *  4. A denial sent while an approval was being proven was taken, and the approval then overwrote it: the request ended
 *     APPROVED with the denial's reason, after "PA Denied" and "PA Approved" had both gone to the prescriber.
 *  5. /node/state sent each drug without its NADAC price and pricing unit, so the pharmacy console's NADAC/Unit column
 *     read "No NADAC price" for every drug.
 *
 * Now the quote answers 'prescriber' and not 'pcp'; both reasons are plain text where they enter (no < or >, no control
 * character but a line break), and the console escapes every message (tests/pa-review-screens.test.ts); an approval
 * holds the quantity asked for, within the plan's limit, and prescribing more is refused before any proof; a request
 * being approved takes no other decision; /node/state carries each drug's NADAC price and unit.
 *
 * A real L2Node sequencer and RPC server, and a real AdjudicationService with the engine's routes registered; programs
 * not compiled, every proof skipped.
 */
import fs from 'fs';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-pa-review';
const ABACAVIR = '00378410591';   // tier 1: no prior authorization, 90 EA per fill
const PA_DRUG = '59148004580';    // ABILIFY MAINTENA ER 300 MG SYR: prior authorization and step therapy, 30 EA per fill
const PA_ML_DRUG = '50242014301'; // ACTEMRA ACTPEN 162 MG/0.9 ML: prior authorization, 30 ML per fill
const W1 = '79300000000000000001';   // names prescriber 0, then prescriber 1
const W2 = '79300000000000000002';   // names prescriber 2, which the insurer then suspends
const W3 = '79300000000000000003';   // names prescriber 3
const W4 = '79300000000000000004';   // names prescriber 3

let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let hashString: (s: string) => Field;
let LC: any;
let PRESCRIBERS: any[];
let MEDICATIONS: any[];
let signRequest: any;
let walletSigner: any;
let deriveWalletSigningKey: any;
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const ndcHashOf = (ndc: string) => hashString(ndc).toString();
const prescriberWallet = (i: number): string => svc.getPrescriberWalletId(i).toString();
const memberKeys: Record<string, any> = {};
let rpcId = 1;

async function rpc(method: string, params: Record<string, unknown>, headers: Record<string, string> = bearer): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return r.json();
}

/** Headers signing a request as seed prescriber i's own wallet, with the key its node derives from its enrollment key. */
function asPrescriber(i: number, method: string, path: string, body?: string): Record<string, string> {
  const signer = walletSigner(PRESCRIBERS[i].enrollmentKey, prescriberWallet(i));
  return signRequest({ signerId: signer.signerId, privateKey: signer.privateKey, method, path, body });
}

async function quoteAsPrescriber(i: number, walletId: string, ndc: string, quantity = 30): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'l2_estimateCost', params: { walletId, ndcHash: ndcHashOf(ndc), quantity } });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...asPrescriber(i, 'POST', '/rpc', body) }, body });
  return r.json();
}

async function engine(method: 'GET' | 'POST', path: string, bodyObj: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const r = await fetch(url + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const requestAs = (i: number, body: unknown) => engine('POST', '/interactive/request-prior-auth', body, asPrescriber(i, 'POST', '/interactive/request-prior-auth', JSON.stringify(body)));
const statusAs = (i: number, member: string, ndc: string) =>
  engine('GET', `/interactive/prior-auth-status?memberWalletId=${member}&ndcHash=${ndcHashOf(ndc)}`, undefined, asPrescriber(i, 'GET', '/interactive/prior-auth-status'));

/** The member's primary-care choice as its device makes it: the engine's record, then the sequencer link signed as the wallet. */
async function namePcp(member: string, prescriberIndex: number): Promise<void> {
  await svc.assignPcpForDevice({ walletId: member, pcpWalletId: prescriberWallet(prescriberIndex), effectiveDate: '20261019', specialty: 'Family Medicine', consentScopeFlags: 7 });
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'l2_registerPcpAssignment', params: { memberWalletId: member, prescriberWalletId: prescriberWallet(prescriberIndex), effectiveDate: '2026-10-19' } });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signRequest({ signerId: member, privateKey: memberKeys[member].privateKey, method: 'POST', path: '/rpc', body }) }, body });
  expect((await r.json()).error).toBeUndefined();
}

const pendingFor = (member: string, ndc: string): any =>
  [...svc.priorAuths.values()].find((pa: any) => pa.memberWalletId === member && pa.ndcHash === ndcHashOf(ndc) && pa.status === 'PENDING');

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { formularyRaw } = await import('../src/data/formulary-loader.js');
  const data = await import('../src/data/index.js');
  ({ signRequest } = await import('../src/security/signed-request.js'));
  ({ walletSigner, deriveWalletSigningKey } = await import('../src/security/wallet-key.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  LC = await import('../src/engine/lifecycle.js');
  PRESCRIBERS = data.PRESCRIBERS;
  MEDICATIONS = data.MEDICATIONS;

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-pa-review' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  seq = node.getSequencer();
  seq.getFormularyService().loadFromNadac(formularyRaw);
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });

  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(server, svc);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;

  // Seed prescribers 0 to 3, registered as their nodes register them: the wallet with its signing key, credentialed ACTIVE.
  for (let i = 0; i < 4; i++) {
    const r = await rpc('l2_registerEntity', {
      walletId: prescriberWallet(i), displayName: `Prescriber ${i}`, type: 'prescriber', npi: String(PRESCRIBERS[i].localData.prescriberId),
      signingPublicKeyHex: deriveWalletSigningKey(PRESCRIBERS[i].enrollmentKey).publicKeyHex,
    });
    expect(r.error).toBeUndefined();
  }
  const base: any = {
    planId: 'PLAN-PA-REVIEW', name: 'PA review plan', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1300,
    formularyNdcs: [ABACAVIR, PA_DRUG, PA_ML_DRUG], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, data.getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  for (const w of [W1, W2, W3, W4]) {
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(w)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: w, groupIdHash: ndcHashOf('GRP-PA-REVIEW'), planIdHash: ndcHashOf(base.planId), planId: base.planId, employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: w, ownershipProofJson: '{}', displayName: 'PA review member' });
    // the member's wallet with its own signing key, as its device registers it
    memberKeys[w] = deriveWalletSigningKey(`enrollment-key-of-${w}`);
    expect((await rpc('l2_registerEntity', { walletId: w, displayName: 'PA review member', type: 'member', signingPublicKeyHex: memberKeys[w].publicKeyHex })).error).toBeUndefined();
  }
  await namePcp(W3, 3);
  await namePcp(W4, 3);
});

afterAll(async () => { await server?.stop(); });

describe('1. the quote answers the prescriber the member consents to now, not a PCP link the sequencer kept', () => {
  test('the D1 table: the quote is read by the member, a prescriber it consents to and its attestation; claim reads keep the PCP links', async () => {
    const { MEMBER_DATA_METHODS } = await import('../src/l2/member-data-methods.js');
    expect(MEMBER_DATA_METHODS.l2_estimateCost.readers).toEqual(['self', 'prescriber', 'attestation']);   // before: 'pcp' too
    expect(MEMBER_DATA_METHODS.l2_getClaimsByMember.readers).toContain('pcp');
  });

  test('a former primary-care prescriber, whose link the sequencer keeps, reads nothing; the one she names now reads her quote', async () => {
    await namePcp(W1, 0);
    expect((await quoteAsPrescriber(0, W1, ABACAVIR)).result).toMatchObject({ covered: true, phase: 'deductible' });
    await namePcp(W1, 1);
    // the sequencer still lists her under prescriber 0
    const links = (await rpc('l2_getPcpAssignments', { prescriberWalletId: prescriberWallet(0) })).result;
    expect(links.map((l: any) => l.memberWalletId)).toContain(W1);
    expect(svc.prescribingConsentFor(W1, prescriberWallet(0), ndcHashOf(ABACAVIR))).toBeNull();
    const former = await quoteAsPrescriber(0, W1, ABACAVIR);
    expect(former.result).toBeUndefined();                 // before: her share and phase, through the kept link
    expect(former.error?.message).toMatch(/Forbidden/);
    expect(former.error?.message).toMatch(/a prescriber it consented to \(its primary-care prescriber, or one its device authorized for this visit\)/);
    const formerPa = await quoteAsPrescriber(0, W1, PA_DRUG, 1);
    expect(formerPa.result).toBeUndefined();               // before: her prior-authorization status for the drug
    expect((await statusAs(0, W1, PA_DRUG)).status).toBe(403);
    expect((await quoteAsPrescriber(1, W1, ABACAVIR)).result).toMatchObject({ covered: true, phase: 'deductible' });
  });

  test('a suspended primary-care prescriber reads nothing, though the engine and the sequencer still name it', async () => {
    await namePcp(W2, 2);
    expect((await quoteAsPrescriber(2, W2, ABACAVIR)).result).toMatchObject({ covered: true });
    expect((await rpc('l2_updateProviderStatus', { walletId: prescriberWallet(2), newState: 3 })).error).toBeUndefined();
    const suspended = await quoteAsPrescriber(2, W2, ABACAVIR);
    expect(suspended.result).toBeUndefined();              // before: answered through the sequencer's link
    expect(suspended.error?.message).toMatch(/Forbidden/);
  });
});

describe('2. a reason is plain text where it enters', () => {
  const C = (code: number) => String.fromCharCode(code);

  test('a prescriber\'s reason with markup or a control character is refused with 400 and nothing is recorded; a line break is kept', async () => {
    const before = svc.priorAuths.size;
    const markup = await requestAs(3, { memberWalletId: W3, ndcHash: ndcHashOf(PA_DRUG), quantity: 10, reason: '<img src=x onerror="fetch(1)">' });
    expect([markup.status, markup.json.error]).toEqual([400, expect.stringMatching(/may not contain < or >/)]);   // before: 200
    const bell = await requestAs(3, { memberWalletId: W3, ndcHash: ndcHashOf(PA_DRUG), quantity: 10, reason: `Two agents failed${C(7)}` });
    expect([bell.status, bell.json.error]).toEqual([400, expect.stringMatching(/control characters other than a line break/)]);
    expect(svc.priorAuths.size).toBe(before);
    const ok = await requestAs(3, { memberWalletId: W3, ndcHash: ndcHashOf(PA_DRUG), quantity: 10, reason: 'Two oral agents failed.\nA1c 9.1%' });
    expect(ok.status).toBe(200);
    expect(svc.listPriorAuths('PENDING').find((p: any) => p.memberWalletId === W3)).toMatchObject({ quantity: 10, reason: 'Two oral agents failed.\nA1c 9.1%' });
  });

  test('an insurer\'s denial reason with markup or a control character is refused with 400, and the request stays pending', async () => {
    const pa = pendingFor(W3, PA_DRUG);
    const markup = await engine('POST', '/interactive/deny-prior-auth', { priorAuthId: pa.id, reason: '<script>steal()</script>' }, bearer);
    expect([markup.status, markup.json.error]).toEqual([400, expect.stringMatching(/may not contain < or >/)]);   // before: 200, and DENIED
    const escape = await engine('POST', '/interactive/deny-prior-auth', { priorAuthId: pa.id, reason: `${C(27)}[2J cleared` }, bearer);
    expect(escape.status).toBe(400);
    let refusal: any = null;
    try { svc.denyPriorAuth(pa.id, 'dose > 30'); } catch (err) { refusal = err; }
    expect(refusal).toMatchObject({ status: 400 });
    expect(pa.status).toBe('PENDING');
    expect(pa.decisionReason).toBeUndefined();
  });

  test('an unknown request is a 404 and a decided one a 409, not a 500', async () => {
    expect((await engine('POST', '/interactive/deny-prior-auth', { priorAuthId: 'PA-9999', reason: 'No such request' }, bearer)).status).toBe(404);
    expect((await engine('POST', '/interactive/approve-prior-auth', { priorAuthId: 'PA-9999' }, bearer)).status).toBe(404);
  });
});

describe('3. an approval holds the quantity the prescriber asked for, within the plan\'s limit', () => {
  test('asked for 10 EA: the authorization, its proof and the answer say 10 EA; 30 EA is refused at prescribing before any proof', async () => {
    const pa = pendingFor(W3, PA_DRUG);
    const proofs: Array<{ program: string; method: string; args: any[] }> = [];
    const skip = svc.dispatchProof;
    svc.dispatchProof = async (program: string, method: string, _types: string[], args: any[]) => { proofs.push({ program, method, args }); return skip(); };
    try {
      const approved = await svc.approvePriorAuth(pa.id);
      expect(approved).toMatchObject({ status: 'APPROVED', approvedQuantity: 10, pricingUnit: 'EA' });
      expect(pa.priorAuthData.approvedQuantity.toBigInt()).toBe(10_000n);   // before: 30000, the plan's whole limit
      const paProof = proofs.find((p) => p.program === 'AccessControl' && p.method === 'provePriorAuth');
      expect(paProof!.args[paProof!.args.length - 1].toBigInt()).toBe(10_000n);
      expect(svc.listPriorAuths('RESOLVED').find((p: any) => p.id === pa.id)).toMatchObject({ status: 'APPROVED', quantity: 10 });
      // the prescriber is told what was approved
      const toPrescriber = svc.getThreads(prescriberWallet(3))
        .flatMap((t: any) => svc.decryptThread(t.messageIndices, prescriberWallet(3)))
        .filter((m: any) => m && m.subject === 'PA Approved: ABILIFY MAINTENA ER 300 MG SYR');
      expect(toPrescriber.map((m: any) => m.body.endsWith(`Auth #${pa.id}, 10 EA per fill`))).toEqual([true]);

      proofs.length = 0;
      await expect(svc.createPrescription({ prescriberIndex: 3, pharmacyIndex: 0, memberWalletId: W3, ndcHash: ndcHashOf(PA_DRUG), quantity: 30, refills: 0 }))
        .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/approves at most 10 EA per fill; 30 EA is more/) });   // before: on to the proofs
      expect(proofs).toEqual([]);
    } finally {
      svc.dispatchProof = skip;
    }
  });

  test('10 EA passes the prior-authorization check at prescribing', async () => {
    const stepTherapy = svc.checkStepTherapy;
    svc.checkStepTherapy = () => ({ allowed: true, message: 'met' });   // the drug also needs step therapy; not this test's subject
    try {
      const rx = await svc.createPrescription({ prescriberIndex: 3, pharmacyIndex: 0, memberWalletId: W3, ndcHash: ndcHashOf(PA_DRUG), quantity: 10, refills: 0 });
      expect(rx.prescriptionId).toEqual(expect.any(String));
    } finally {
      svc.checkStepTherapy = stepTherapy;
    }
  });

  test('a request the console made names no quantity and is approved at the plan\'s limit per fill', async () => {
    const r = await engine('POST', '/interactive/request-prior-auth', { memberWalletId: W4, prescriberIndex: 3, ndcHash: ndcHashOf(PA_ML_DRUG) }, bearer);
    expect(r.status).toBe(200);
    const approved = await svc.approvePriorAuth(r.json.paId);
    expect(approved).toMatchObject({ approvedQuantity: 30, pricingUnit: 'ML' });
    expect(svc.priorAuths.get(r.json.paId).priorAuthData.approvedQuantity.toBigInt()).toBe(30_000n);
  });
});

describe('4. a request being approved takes no other decision', () => {
  test('a denial and a second approval sent while the approval is proven get 409; the request ends APPROVED with no denial reason', async () => {
    expect((await requestAs(3, { memberWalletId: W4, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 })).status).toBe(200);
    const pa = pendingFor(W4, PA_DRUG);
    let entered: () => void = () => {};
    const proving = new Promise<void>((resolve) => { entered = resolve; });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const skip = svc.dispatchProof;
    svc.dispatchProof = async (program: string, method: string) => {
      if (program === 'AccessControl' && method === 'provePriorAuth') { entered(); await gate; }
      return skip();
    };
    try {
      const approving = svc.approvePriorAuth(pa.id);
      await proving;
      let denial: any = null;
      try { svc.denyPriorAuth(pa.id, 'Step therapy not documented'); } catch (err) { denial = err; }
      expect(denial).toMatchObject({ status: 409, message: expect.stringMatching(/being proven/) });   // before: no refusal, DENIED
      const viaRoute = await engine('POST', '/interactive/deny-prior-auth', { priorAuthId: pa.id, reason: 'Step therapy not documented' }, bearer);
      expect(viaRoute.status).toBe(409);
      await expect(svc.approvePriorAuth(pa.id)).rejects.toMatchObject({ status: 409 });
      expect(pa.status).toBe('PENDING');
      release();
      await approving;
    } finally {
      release();
      svc.dispatchProof = skip;
    }
    expect(pa.status).toBe('APPROVED');
    expect(pa.decisionReason).toBeUndefined();
    const decided = await engine('POST', '/interactive/deny-prior-auth', { priorAuthId: pa.id, reason: 'Too late' }, bearer);
    expect([decided.status, decided.json.error]).toEqual([409, `Prior auth is already APPROVED: ${pa.id}`]);   // before: 500
  });

  test('a failed approval releases the request for the next decision', async () => {
    expect((await requestAs(3, { memberWalletId: W3, ndcHash: ndcHashOf(PA_ML_DRUG), quantity: 0.9 })).status).toBe(200);
    const pa = pendingFor(W3, PA_ML_DRUG);
    const skip = svc.dispatchProof;
    svc.dispatchProof = async (program: string, method: string) => {
      if (program === 'AccessControl' && method === 'provePriorAuth') throw new Error('prover unavailable');
      return skip();
    };
    try {
      await expect(svc.approvePriorAuth(pa.id)).rejects.toThrow('prover unavailable');
    } finally {
      svc.dispatchProof = skip;
    }
    expect(svc.denyPriorAuth(pa.id, 'Resubmit with chart notes')).toMatchObject({ status: 'DENIED' });
  });
});

describe('5. /node/state sends what the pharmacy console\'s NADAC column reads', () => {
  const NL = '\n';
  const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
  function liftModule(src: string, name: string): string {
    const at = src.search(new RegExp(`\\n(export )?function ${name}\\(`));
    if (at < 0) throw new Error('no function ' + name);
    const end = src.indexOf(NL + '}' + NL, at);
    return src.slice(at + 1, end + 2).replace(/^export /, '');
  }

  test('every drug carries its NADAC price and pricing unit, and the console lists the price from what the route sends', async () => {
    const r = await engine('GET', '/node/state', undefined, bearer);
    expect(r.status).toBe(200);
    const meds: any[] = r.json.medications;
    expect(meds.length).toBe(MEDICATIONS.length);
    for (const [i, m] of meds.entries()) {
      expect([m.ndc, m.nadacPerUnit, m.pricingUnit]).toEqual([MEDICATIONS[i].ndc, MEDICATIONS[i].nadacPerUnit, MEDICATIONS[i].pricingUnit]);   // before: undefined
    }

    const PHARMACY = read('visualizer/src/js/pharmacy-dashboard.js');
    const NADAC = read('visualizer/src/js/interactive/nadac-price.js');
    const COMMON = read('visualizer/src/js/node-common.js');
    const nadac = new Function(`'use strict';\n${NADAC.replace(/^export\s+/gm, '')}\nreturn { nadacPerUnitLabel, nadacUnitPriceE5 };`)();
    const els: Record<string, any> = {};
    const scope: Record<string, unknown> = {
      medications: meds, ...nadac, formatCents: (c: number) => '$' + (c / 100).toFixed(2),
      renderSectionCard: (title: string, _kind: string, body: string) => `<h3>${title}</h3>${body}`,
      document: { getElementById: (id: string) => (els[id] = els[id] ?? { id, innerHTML: '' }) },
    };
    const names = Object.keys(scope);
    const code = [liftModule(PHARMACY, 'tierBadge'), liftModule(PHARMACY, 'renderFormulary'), liftModule(COMMON, 'renderSortableTable')].join(NL);
    new Function(...names, `'use strict';\n${code}\nreturn renderFormulary;`)(...names.map((n) => scope[n]))();
    const html = String(els['section-formulary'].innerHTML);
    const abacavir = meds.find((m) => m.ndc === ABACAVIR);
    expect(html).toContain(`>${nadac.nadacPerUnitLabel(abacavir)}</td>`);
    expect(nadac.nadacPerUnitLabel(abacavir)).toBe('$0.60042/EA');
    expect(html).not.toContain('No NADAC price');           // before: every row
  });
});
