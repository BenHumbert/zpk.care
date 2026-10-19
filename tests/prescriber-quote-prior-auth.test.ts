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
 * A prescriber who may prescribe for a member reads the member's own quote with the drug's availability on her plan,
 * and starts the prior authorization her plan requires (owner decision 2026-10-19).
 *
 * What was wrong: l2_estimateCost with a walletId answered only the member, a caller holding her tapped attestation,
 * the plan and the operator, so her own primary-care prescriber saw no price before writing; the quote said nothing about
 * prior authorization, step therapy or the limit per fill; and a prior-authorization request named its prescriber by a
 * seed index in the body, which any prescriber node key could set, with no check of the member's consent or of her plan.
 *
 * Now the read gate also admits the primary-care prescriber the member names (the engine's record of her consent, not
 * the sequencer's PCP links, which keep every prescriber she ever named) and a prescriber her device authorized for the
 * visit (B5), active prescribers only, which the engine answers through the call it registers with its quote; the quote
 * carries priorAuthRequired, stepTherapyRequired, maxQuantityPerFill and, for a prior-authorization drug, her own status;
 * and the engine takes a prescriber's request signed as the prescriber's own wallet, refusing one without her consent,
 * for a drug her plan needs no prior authorization for, or a duplicate of a pending one. The console's operator path is
 * kept.
 *
 * A real L2Node sequencer and RPC server, and a real AdjudicationService with the engine's routes registered; programs
 * not compiled, every proof skipped.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-prescriber-quote';
const ABACAVIR = '00378410591';   // tier 1: no prior authorization, no step therapy, 90 EA per fill
const PA_DRUG = '59148004580';    // ABILIFY MAINTENA ER 300 MG SYR: prior authorization and step therapy, 30 EA per fill
const OFF_PLAN = '42385096230';   // claimable, not on the plan
const W = '79100000000000000001';
const W2 = '79100000000000000002';
const UNKNOWN = '79100000000000009999';

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
let PRESCRIBERS: any[];
let signRequest: any;
let privateKeyFromSeedHex: any;
let walletSigner: any;
let deriveWalletSigningKey: any;
let prescriberNodeKey: any;
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const ndcHashOf = (ndc: string) => hashString(ndc).toString();
const prescriberWallet = (i: number): string => svc.getPrescriberWalletId(i).toString();
let rpcId = 1;

function publishedPlan(over: Record<string, unknown>): any {
  const base: any = {
    planId: 'PLAN-PA', name: 'PA plan', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1300,
    formularyNdcs: [ABACAVIR, PA_DRUG], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0, ...over,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  return { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) };
}

async function enroll(walletId: string, planId: string): Promise<any> {
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(walletId)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId, groupIdHash: ndcHashOf('GRP-PA'), planIdHash: ndcHashOf(planId), planId, employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId, ownershipProofJson: '{}', displayName: 'PA member' });
  return svc.enrolledMembers.get(walletId);
}

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

async function quoteAsPrescriber(i: number, params: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'l2_estimateCost', params });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...asPrescriber(i, 'POST', '/rpc', body) }, body });
  return r.json();
}

/** An engine route, signed as prescriber i's wallet (or with the given headers). */
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
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  ({ signRequest, privateKeyFromSeedHex } = await import('../src/security/signed-request.js'));
  ({ walletSigner, deriveWalletSigningKey } = await import('../src/security/wallet-key.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  LC = await import('../src/engine/lifecycle.js');
  catalog = data.getAllFormularyEntries();
  PRESCRIBERS = data.PRESCRIBERS;

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-prescriber-quote' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  seq = node.getSequencer();
  seq.getFormularyService().loadFromNadac(formularyRaw);
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });

  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  prescriberNodeKey = generateNodeKey('prescriber-node');
  server.registerNodeKey(prescriberNodeKey.nodeId, prescriberNodeKey.publicKeyHex, 'prescriber');
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
  await node.storePlan(publishedPlan({}));
  await enroll(W, 'PLAN-PA');
  await enroll(W2, 'PLAN-PA');
});

afterAll(async () => { await server?.stop(); });

describe('the pre-script quote answers a prescriber who may prescribe for the member', () => {
  test('a prescriber with no relationship to the member is refused, as before, and so is one asking about a wallet that is not enrolled', async () => {
    const refused = await quoteAsPrescriber(1, { walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect(refused.result).toBeUndefined();
    expect(refused.error?.message).toMatch(/Forbidden/);
    const unknown = await quoteAsPrescriber(1, { walletId: UNKNOWN, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect(unknown.error?.message).toMatch(/Forbidden/);
    expect(unknown.error?.message).not.toMatch(/not a member/);
  });

  test('the primary-care prescriber the member named reads her own quote, the same numbers the operator reads, with the drug\'s availability', async () => {
    await svc.assignPcpForDevice({ walletId: W, pcpWalletId: prescriberWallet(0), effectiveDate: '20261019', specialty: 'Family Medicine', consentScopeFlags: 7 });
    const asOperator = (await rpc('l2_estimateCost', { walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).result;
    const asPcp = await quoteAsPrescriber(0, { walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect(asPcp.error).toBeUndefined();     // before: Forbidden, the tap was the only way in
    expect(asPcp.result).toEqual(asOperator);
    expect(asPcp.result).toMatchObject({
      covered: true, phase: 'deductible', memberPayCents: 3101, employerPayCents: 0, ingredientCostCents: 1801, dispensingFeeCents: 1300,
      priorAuthRequired: false, stepTherapyRequired: false, maxQuantityPerFill: 90,
    });
    expect(asPcp.result).not.toHaveProperty('priorAuth');
  });

  test('a prior-authorization drug says so before the script is written: PA and step therapy required, 30 EA per fill, none requested', async () => {
    const q = (await quoteAsPrescriber(0, { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 1 })).result;
    expect(q).toMatchObject({ covered: true, priorAuthRequired: true, stepTherapyRequired: true, maxQuantityPerFill: 30, pricingUnit: 'EA', priorAuth: { status: 'none' } });
    const off = (await quoteAsPrescriber(0, { walletId: W, ndcHash: ndcHashOf(OFF_PLAN), quantity: 30 })).result;
    expect(off).toMatchObject({ covered: false, phase: 'not-covered', reason: "Not on the formulary of the member's plan" });
  });

  test('the quote carries the member\'s share and the drug\'s rules, no balances and no plan', async () => {
    const q = (await quoteAsPrescriber(0, { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 1 })).result;
    expect(Object.keys(q).sort()).toEqual([
      'classification', 'copayAmountCents', 'copayBasis', 'covered', 'dispensingFeeCents', 'dispensingFeeSource', 'drugName', 'employerPayCents',
      'ingredientCostCents', 'maxQuantityPerFill', 'memberPayCents', 'nadacPerUnit', 'ndcHash', 'phase', 'pricingUnit', 'priorAuth', 'priorAuthRequired',
      'quantity', 'stepTherapyRequired', 'tierLevel', 'totalCostCents',
    ]);
    expect(JSON.stringify(q)).not.toContain('PLAN-PA');
  });

  test('a PCP link on the sequencer alone opens nothing: the engine\'s record of her consent decides', async () => {
    const memberKey = deriveWalletSigningKey('member-two-enrollment-key-for-this-suite');
    expect((await rpc('l2_registerEntity', { walletId: W2, displayName: 'Member two', type: 'member', signingPublicKeyHex: memberKey.publicKeyHex })).error).toBeUndefined();
    expect((await quoteAsPrescriber(2, { walletId: W2, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).error?.message).toMatch(/Forbidden/);
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'l2_registerPcpAssignment', params: { memberWalletId: W2, prescriberWalletId: prescriberWallet(2), effectiveDate: '2026-10-19' } });
    const link = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signRequest({ signerId: W2, privateKey: memberKey.privateKey, method: 'POST', path: '/rpc', body }) }, body });
    expect((await link.json()).error).toBeUndefined();
    // the sequencer keeps such links for good, through a change of PCP and a suspension (tests/prior-auth-review-fixes.test.ts)
    const q = await quoteAsPrescriber(2, { walletId: W2, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect(q.result).toBeUndefined();
    expect(q.error?.message).toMatch(/Forbidden/);
  });

  test('a prescriber the member\'s device authorized for this visit reads the quote for the drug it was authorized for, until the visit ends', async () => {
    await svc.authorizePrescriber({ walletId: W, prescriberWalletId: prescriberWallet(1), ndcHash: ndcHashOf(PA_DRUG), hours: 1 });
    const granted = await quoteAsPrescriber(1, { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 1 });
    expect(granted.error).toBeUndefined();   // before: Forbidden
    expect(granted.result).toMatchObject({ covered: true, priorAuthRequired: true });
    // the authorization is for one drug: another drug's price is not opened by it
    expect((await quoteAsPrescriber(1, { walletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).error?.message).toMatch(/Forbidden/);
    // the visit ended
    for (const a of svc.prescriberAuthorizations.get(W)) a.expiresAt = Date.now() - 1;
    expect((await quoteAsPrescriber(1, { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 1 })).error?.message).toMatch(/Forbidden/);
  });

  test('a suspended prescriber is no longer admitted, even as the member\'s named primary-care prescriber', async () => {
    await svc.assignPcpForDevice({ walletId: W2, pcpWalletId: prescriberWallet(3), effectiveDate: '20261019', specialty: 'Internal Medicine', consentScopeFlags: 7 });
    expect((await quoteAsPrescriber(3, { walletId: W2, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).error).toBeUndefined();
    expect((await rpc('l2_updateProviderStatus', { walletId: prescriberWallet(3), newState: 3 })).error).toBeUndefined();
    expect((await quoteAsPrescriber(3, { walletId: W2, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).error?.message).toMatch(/Forbidden/);
  });
});

describe('a prescriber requests prior authorization as itself', () => {
  const REASON = 'Two oral antipsychotics failed; adherence problems';

  test('the named PCP asks for a drug her plan requires it for: pending, recorded under the prescriber that signed, the answer names no request', async () => {
    const r = await requestAs(0, { memberWalletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30, reason: REASON });
    expect(r.status).toBe(200);              // before: 401, a prescriber's own wallet could not call it
    expect(r.json).toMatchObject({ status: 'pending', ndcHash: ndcHashOf(PA_DRUG), quantity: 30, pricingUnit: 'EA' });
    expect(r.json).not.toHaveProperty('paId');
    const recorded = [...svc.priorAuths.values()].filter((pa: any) => pa.memberWalletId === W && pa.ndcHash === ndcHashOf(PA_DRUG));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: 'PENDING', prescriberIndex: 0, requestedQuantity: 30 });
    // the reason is for the insurer's review, in memory: never in the checkpoint written to disk
    expect(JSON.stringify(svc.exportState())).not.toContain('antipsychotics');
    const checkpointed = svc.exportState().priorAuths.find((pa: any) => pa.id === recorded[0].id);
    expect(checkpointed).toMatchObject({ requestedQuantity: 30 });
    expect(checkpointed).not.toHaveProperty('reason');
    expect((await quoteAsPrescriber(0, { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 })).result.priorAuth).toMatchObject({ status: 'pending' });
    const status = await statusAs(0, W, PA_DRUG);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ status: 'pending' });
    expect(status.json).not.toHaveProperty('paId');
  });

  test('a duplicate of a pending request is refused', async () => {
    const r = await requestAs(0, { memberWalletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/already pending/);
  });

  test('a drug that needs no prior authorization on her plan, a drug off her plan, a quantity over the limit, a bad quantity and a body that names a prescriber are refused; nothing is recorded', async () => {
    await svc.assignPcpForDevice({ walletId: W2, pcpWalletId: prescriberWallet(0), effectiveDate: '20261019', specialty: 'Family Medicine', consentScopeFlags: 7 });
    const before = svc.priorAuths.size;
    const noPa = await requestAs(0, { memberWalletId: W2, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 });
    expect([noPa.status, noPa.json.error]).toEqual([409, expect.stringMatching(/needs no prior authorization on the member's plan/)]);
    const off = await requestAs(0, { memberWalletId: W2, ndcHash: ndcHashOf(OFF_PLAN), quantity: 30 });
    expect([off.status, off.json.error]).toEqual([403, expect.stringMatching(/not on the formulary of the member's plan/)]);
    expect(off.json.error).not.toContain('PLAN-PA');
    const overLimit = await requestAs(0, { memberWalletId: W2, ndcHash: ndcHashOf(PA_DRUG), quantity: 31 });
    expect([overLimit.status, overLimit.json.error]).toEqual([409, expect.stringMatching(/at most 30 EA/)]);
    expect((await requestAs(0, { memberWalletId: W2, ndcHash: ndcHashOf(PA_DRUG), quantity: 1.0001 })).status).toBe(400);
    expect((await requestAs(0, { memberWalletId: W2, ndcHash: ndcHashOf(PA_DRUG), quantity: 30, prescriberIndex: 5 })).status).toBe(400);
    expect(svc.priorAuths.size).toBe(before);
  });

  test('a prescriber without the member\'s consent is refused, with the same answer for a wallet that is not enrolled; its status read too', async () => {
    const noConsent = await requestAs(2, { memberWalletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 });
    const unknown = await requestAs(2, { memberWalletId: UNKNOWN, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 });
    expect([noConsent.status, unknown.status]).toEqual([403, 403]);
    expect(unknown.json.error).toBe(noConsent.json.error);
    expect((await statusAs(2, W, PA_DRUG)).status).toBe(403);
  });

  test('a prescriber node key, a member\'s wallet and an anonymous caller do not open it', async () => {
    const body = { memberWalletId: W2, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 };
    const text = JSON.stringify(body);
    const byNodeKey = signRequest({ signerId: prescriberNodeKey.nodeId, privateKey: privateKeyFromSeedHex(prescriberNodeKey.seedHex), method: 'POST', path: '/interactive/request-prior-auth', body: text });
    expect((await engine('POST', '/interactive/request-prior-auth', body, byNodeKey)).status).toBe(403);   // before: passed, as any prescriber
    const memberKey = deriveWalletSigningKey('member-two-enrollment-key-for-this-suite');
    const byMember = signRequest({ signerId: W2, privateKey: memberKey.privateKey, method: 'POST', path: '/interactive/request-prior-auth', body: text });
    expect((await engine('POST', '/interactive/request-prior-auth', body, byMember)).status).toBe(403);
    expect((await engine('POST', '/interactive/request-prior-auth', body, {})).status).toBe(401);
    expect((await engine('GET', `/interactive/prior-auth-status?memberWalletId=${W2}&ndcHash=${ndcHashOf(PA_DRUG)}`, undefined, {})).status).toBe(401);
  });

  test('denied, asked again, approved: the status follows; an approval in force is a duplicate; past its last day it is none', async () => {
    const pending = [...svc.priorAuths.values()].find((pa: any) => pa.memberWalletId === W && pa.status === 'PENDING');
    svc.denyPriorAuth(pending.id);
    expect((await statusAs(0, W, PA_DRUG)).json).toMatchObject({ status: 'denied' });
    expect((await quoteAsPrescriber(0, { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 })).result.priorAuth).toMatchObject({ status: 'denied' });
    expect((await requestAs(0, { memberWalletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 })).status).toBe(200);
    const again = [...svc.priorAuths.values()].find((pa: any) => pa.memberWalletId === W && pa.status === 'PENDING');
    await svc.approvePriorAuth(again.id);
    const approved = (await statusAs(0, W, PA_DRUG)).json;
    expect(approved).toMatchObject({ status: 'approved', expiresOn: '2027-02-01' });
    expect((await quoteAsPrescriber(0, { walletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 })).result.priorAuth).toMatchObject({ status: 'approved', expiresOn: '2027-02-01' });
    const dup = await requestAs(0, { memberWalletId: W, ndcHash: ndcHashOf(PA_DRUG), quantity: 30 });
    expect([dup.status, dup.json.error]).toEqual([409, expect.stringMatching(/already authorized for this member through 2027-02-01/)]);
    expect(svc.priorAuthStatusOf(W, ndcHashOf(PA_DRUG), Date.UTC(2027, 1, 2))).toEqual({ status: 'none' });
  });

  test('the plan reviews the requests: the insurer node lists them with the quantity and both reasons and no member name; nobody else does', async () => {
    const { generateNodeKey } = await import('../src/security/node-roles.js');
    const insurerKey = generateNodeKey('insurer-node');
    server.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
    const byInsurer = (p: string) => signRequest({ signerId: insurerKey.nodeId, privateKey: privateKeyFromSeedHex(insurerKey.seedHex), method: 'GET', path: p });
    const list = await engine('GET', '/interactive/prior-auths?status=RESOLVED', undefined, byInsurer('/interactive/prior-auths'));
    expect(list.status).toBe(200);                   // before: no such route
    const denied = list.json.priorAuths.find((pa: any) => pa.status === 'DENIED');
    expect(denied).toMatchObject({
      memberWalletId: W, ndcHash: ndcHashOf(PA_DRUG), ndc: '59148-0045-80', drugName: 'ABILIFY MAINTENA ER', quantity: 30, pricingUnit: 'EA',
      reason: REASON, resolvedAt: expect.any(Number),
    });
    expect(Object.keys(denied).sort()).toEqual(['decisionReason', 'drugName', 'id', 'memberWalletId', 'ndc', 'ndcHash', 'prescriberName', 'pricingUnit', 'quantity', 'reason', 'requestedAt', 'resolvedAt', 'status']);
    expect(JSON.stringify(list.json)).not.toContain('PA member');   // the member's display name
    const pending = await engine('GET', '/interactive/prior-auths?status=PENDING', undefined, byInsurer('/interactive/prior-auths'));
    expect(pending.json.priorAuths.every((pa: any) => pa.status === 'PENDING')).toBe(true);
    expect((await engine('GET', '/interactive/prior-auths', undefined, bearer)).status).toBe(200);
    expect((await engine('GET', '/interactive/prior-auths', undefined, {})).status).toBe(401);
    const byNodeKey = signRequest({ signerId: prescriberNodeKey.nodeId, privateKey: privateKeyFromSeedHex(prescriberNodeKey.seedHex), method: 'GET', path: '/interactive/prior-auths' });
    expect((await engine('GET', '/interactive/prior-auths', undefined, byNodeKey)).status).toBe(403);
    expect((await engine('GET', '/interactive/prior-auths?status=SOME', undefined, bearer)).status).toBe(400);
  });

  test('the insurer\'s reason for a denial reaches the review list and stays off the checkpoint', async () => {
    const r = await requestAs(0, { memberWalletId: W2, ndcHash: ndcHashOf(PA_DRUG), quantity: 10 });
    expect(r.status).toBe(200);
    const pa = [...svc.priorAuths.values()].find((p: any) => p.memberWalletId === W2 && p.status === 'PENDING');
    const deny = await engine('POST', '/interactive/deny-prior-auth', { priorAuthId: pa.id, reason: '  Step therapy not documented  ' }, bearer);
    expect(deny.status).toBe(200);
    const listed = svc.listPriorAuths('RESOLVED').find((p: any) => p.id === pa.id);
    expect(listed).toMatchObject({ status: 'DENIED', quantity: 10, decisionReason: 'Step therapy not documented' });
    expect(JSON.stringify(svc.exportState())).not.toContain('Step therapy not documented');
    expect((await engine('POST', '/interactive/deny-prior-auth', { priorAuthId: pa.id, reason: 'x'.repeat(501) }, bearer)).status).toBe(400);
  });

  test('the console\'s operator path still requests by seed index, and the operator reads any member\'s status', async () => {
    const r = await engine('POST', '/interactive/request-prior-auth', { memberWalletId: W2, prescriberIndex: 0, ndcHash: ndcHashOf(PA_DRUG) }, bearer);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'PENDING', paId: expect.stringMatching(/^PA-\d{4}$/) });
    const read = await engine('GET', `/interactive/prior-auth-status?memberWalletId=${W2}&ndcHash=${ndcHashOf(PA_DRUG)}`, undefined, bearer);
    expect([read.status, read.json.status]).toEqual([200, 'pending']);
  });
});
