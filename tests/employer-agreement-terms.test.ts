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
 * The employer's agreement describes what members are billed (pricing review F12).
 *
 * What was wrong: the agreement was built from the plans' live records, which since plan-bound formularies can be a
 * draft the insurer has not published, so an employer could sign for a $5 copay while members paid $20. It left out
 * the dispensing fee and the formulary, which decide what members pay, and its commitment hashed only the copay,
 * deductible, OOP max and annual max, so a plan republished with a $100 fee still matched an agreement signed at none.
 * Nothing told the employer or the insurer when the terms an attestation committed to stopped being the billed ones.
 *
 * Now each plan in the agreement is the plan as published (planAsPublished) with the fee a fill is charged and the
 * published formulary root, both in the commitment; a selected plan with no published terms is listed as unavailable,
 * and an agreement covering none cannot be signed. The marketplace, the insurer's application list and the employer
 * node say when a registered attestation's terms changed, and the employer can sign the new terms as attestation
 * seq + 1. The marketplace and the employer node offer only plans with published terms, at those terms.
 *
 * Review of those fixes (round 2):
 *  - The commitment left out the family deductible, OOP max and annual max (the fill circuit pools a family against
 *    them) and the provider network, so a republish that changed only those still matched. It now covers every term
 *    a plan is published with, under terms version 2026.2.
 *  - An attestation signed before that (2026.1: copay, deductible, OOP max and annual max) was reported as a terms
 *    change though nothing changed. It is now compared with its own format and reported as signed before full terms.
 *  - The attestation authorized every selected plan, including one the agreement listed as unavailable, so that plan
 *    was admitted at whatever terms it was published with later. It now authorizes only the plans the agreement
 *    covers; a plan published later is added by signing again (seq + 1), which the agreement route offers.
 *
 * The marketplace and employer routes over a real sequencer RPC server that pins the insurer's attestation key, so the
 * signatures and the monotonic sequence are checked as in the running network.
 */
import JSZip from 'jszip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(180_000);

const OPERATOR = 'operator-token-for-agreement-terms';
const SIGNING_SEED = 'insurer-signing-seed-for-agreement-terms';
let rpcServer: any;
let seqUrl: string;
let marketplace: any[];
let employerAdmin: any[];
let store: Map<string, any>;
let att: any;            // src/onboarding/employer-attestation.ts
let publishedTermsFrom: any;
let EmployerNode: any;
let buildEmployerRoutes: any;
let NautilusAppServer: any;
const tempDirs: string[] = [];

interface Captured { status: number; payload: any }
async function call(routes: any[], method: string, p: string, params: Record<string, string> = {}, body?: unknown): Promise<Captured> {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route not registered: ${method} ${p}`);
  let status = 0;
  let payload: any = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(b?: string) { if (b) { try { payload = JSON.parse(b); } catch { payload = { raw: b }; } } return this; },
    get writableEnded() { return status !== 0; },
  };
  await r.handler({ url: p, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, params, new URLSearchParams(), body);
  return { status, payload };
}
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${seqUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const planOf = (planId: string, over: Record<string, unknown> = {}) => ({
  planId, name: `Plan ${planId}`, coverageType: 1, copayAmountCents: 2000, deductibleAmountCents: 50000, oopMaxCents: 780000,
  annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0,
  formularyNdcs: ['00378410591'], networkProviderWalletIds: [], published: true, createdAt: 1, updatedAt: 1, ...over,
});
/** A plan as the insurer publishes it: the record, its published terms and roots. */
const publishedPlan = (planId: string, over: Record<string, unknown> = {}, root = '111') => {
  const plan = planOf(planId, over);
  return { ...plan, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(plan, root, '0', 1) };
};

/** An employer: a key pair, an application the insurer has approved. */
async function approvedApplication(employerId: string, selectedPlanIds: string[]) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('hex');
  const applied = await call(marketplace, 'POST', '/marketplace/api/apply', {}, {
    companyName: 'Fernhill Test Works LLC', employerId, contactName: 'Jordan Testcase', contactEmail: 'hr@fernhill.example.test',
    ein: '00-0000009', state: 'WI', selectedPlanIds, effectiveDate: '2027-01-01', enrollmentCap: 10, publicKeyHex,
  });
  expect(applied.status).toBe(201);
  const applicationId = applied.payload.data.applicationId as string;
  store.get(applicationId).status = 'approved';
  const sign = async (agreement: any) => {
    const message = `${agreement.canonicalMessage}|Jordan Testcase|Owner`;
    const employerSignature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
    return call(marketplace, 'POST', '/marketplace/api/sign/:applicationId', { applicationId }, { employerSignature, signerName: 'Jordan Testcase', signerTitle: 'Owner', reviewedAt: Date.now() });
  };
  return { applicationId, sign };
}
const agreementFor = async (applicationId: string) => {
  const r = await call(marketplace, 'GET', '/marketplace/api/agreement/:applicationId', { applicationId });
  expect(r.status).toBe(200);
  return r.payload.data;
};

beforeAll(async () => {
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  ({ NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js'));
  const { buildMarketplaceRoutes, buildEmployerAdminRoutes, getApplicationStore } = await import('../src/nodes/routes/marketplace-routes.js');
  ({ buildEmployerRoutes } = await import('../src/nodes/routes/employer-routes.js'));
  ({ EmployerNode } = await import('../src/nodes/employer-node.js'));
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  att = await import('../src/onboarding/employer-attestation.js');
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-agreement-terms' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  const insurerKey = generateNodeKey('insurer-node');
  rpcServer = new L2RpcServer(node, {
    port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false,
    insurerAttestationPublicKeyHex: att.insurerPublicKeyFromSeed(SIGNING_SEED),
  });
  rpcServer.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
  await rpcServer.start();
  seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;

  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: tempDir('agreement-terms-'), enableSSE: false,
    maxSseConnections: 0, allowedOrigins: [], adminToken: 'insurer-admin-token-for-tests',
    nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex }, insurerSigningSeed: SIGNING_SEED,
  } as any);
  marketplace = buildMarketplaceRoutes(server);
  employerAdmin = buildEmployerAdminRoutes(server);
  store = getApplicationStore();

  // PLAN-AGR is published at a $20 copay and no fee of its own, and the insurer is drafting a $5 copay and a $90 fee.
  const live = publishedPlan('PLAN-AGR');
  expect((await rpc('l2_storePlan', { plan: { ...live, copayAmountCents: 500, dispensingFeeCents: 9000, published: false } })).error).toBeUndefined();
  // PLAN-LEGACY was published before the terms were kept; PLAN-NEVER was never published.
  expect((await rpc('l2_storePlan', { plan: { ...planOf('PLAN-LEGACY'), formularyRoot: '1', networkRoot: '2' } })).error).toBeUndefined();
  expect((await rpc('l2_storePlan', { plan: planOf('PLAN-NEVER', { published: false }) })).error).toBeUndefined();
});

afterAll(async () => {
  await rpcServer?.stop();
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('the agreement terms', () => {
  test('a plan is agreed to at its published terms, with the fee a fill is charged and its formulary root, not at a draft', () => {
    const plan = { ...publishedPlan('PLAN-X'), copayAmountCents: 500, dispensingFeeCents: 9000, published: false };
    const terms = att.buildAgreementTerms({ applicationId: 'EMPAPP-X', employerId: 'E', companyName: 'C', selectedPlanIds: ['PLAN-X'], effectiveDate: '20270101', enrollmentCap: 10 }, [plan]);
    expect(terms.selectedPlans).toEqual([{
      planId: 'PLAN-X', planName: 'Plan PLAN-X', coverageType: 1, copayAmountCents: 2000, deductibleAmountCents: 50000, oopMaxCents: 780000,
      annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0,
      dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', formularyRoot: '111', networkRoot: '0',
    }]);
    expect(terms.unavailablePlanIds).toEqual([]);
    expect(terms.termsVersion).toBe('2026.2');
  });

  test('a selected plan with no published terms is listed as unavailable, not agreed to', () => {
    const terms = att.buildAgreementTerms(
      { applicationId: 'EMPAPP-Y', employerId: 'E', companyName: 'C', selectedPlanIds: ['PLAN-X', 'PLAN-LEGACY', 'PLAN-NEVER', 'PLAN-GONE'], effectiveDate: '20270101', enrollmentCap: 10 },
      [publishedPlan('PLAN-X'), { ...planOf('PLAN-LEGACY'), formularyRoot: '1' }, planOf('PLAN-NEVER', { published: false })],
    );
    expect(terms.selectedPlans.map((p: any) => p.planId)).toEqual(['PLAN-X']);
    expect(terms.unavailablePlanIds).toEqual(['PLAN-LEGACY', 'PLAN-NEVER', 'PLAN-GONE']);
  });

  test('the commitment changes when a plan is republished with another fee or another formulary', () => {
    const app = { applicationId: 'EMPAPP-Z', employerId: 'E', companyName: 'C', selectedPlanIds: ['PLAN-X'], effectiveDate: '20270101', enrollmentCap: 10 };
    const commit = (plan: unknown) => att.computeAgreementCommitment(att.buildAgreementTerms(app, [plan]));
    const base = commit(publishedPlan('PLAN-X'));
    expect(commit(publishedPlan('PLAN-X'))).toBe(base);
    expect(commit(publishedPlan('PLAN-X', { dispensingFeeCents: 10000 }))).not.toBe(base);   // a $100 fee
    expect(commit(publishedPlan('PLAN-X', {}, '222'))).not.toBe(base);                       // another drug list
    expect(commit({ ...publishedPlan('PLAN-X'), copayAmountCents: 1, published: false })).toBe(base); // a draft is not billed
  });

  test('the commitment covers every published term: the family limits, the provider network and the coverage type too', () => {
    const app = { applicationId: 'EMPAPP-F', employerId: 'E', companyName: 'C', selectedPlanIds: ['PLAN-X'], effectiveDate: '20270101', enrollmentCap: 10 };
    const commit = (plan: unknown) => att.computeAgreementCommitment(att.buildAgreementTerms(app, [plan]));
    const base = commit(publishedPlan('PLAN-X'));
    // the fill circuit pools a family against the family OOP max and annual max (B8), so each changes what members pay
    expect(commit(publishedPlan('PLAN-X', { familyOopMaxCents: 400000 }))).not.toBe(base);          // before: equal
    expect(commit(publishedPlan('PLAN-X', { familyAnnualBenefitMaxCents: 2500000 }))).not.toBe(base); // before: equal
    expect(commit(publishedPlan('PLAN-X', { familyDeductibleAmountCents: 50000 }))).not.toBe(base);   // before: equal
    expect(commit(publishedPlan('PLAN-X', { coverageType: 2 }))).not.toBe(base);                      // before: equal
    const narrowed = planOf('PLAN-X', { networkProviderWalletIds: ['42'] });
    expect(commit({ ...narrowed, formularyRoot: '111', networkRoot: '999', publishedTerms: publishedTermsFrom(narrowed, '111', '999', 1) })).not.toBe(base); // before: equal
  });

  /** An attestation as signed before 2026.2: its commitment covered each plan's copay, deductible, OOP max and annual max. */
  async function legacyAttestation(plan: any, applicationId: string) {
    const { Poseidon, Field: F } = await import('o1js');
    const { hashString, dateToField } = await import('../src/zkp/hash-utils.js');
    const planFinancials = `${plan.planId}:${plan.copayAmountCents}:${plan.deductibleAmountCents}:${plan.oopMaxCents}:${plan.annualBenefitMaxCents}`;
    const agreementCommitment = Poseidon.hash([
      hashString(`AGR-${applicationId}`), hashString('E'), hashString(planFinancials), F(BigInt(10)), dateToField('20270101'), hashString('2026.1'),
    ]).toString();
    return { applicationId, employerId: 'E', authorizedPlanIds: [plan.planId], enrollmentCap: 10, effectiveDate: '20270101', agreementCommitment };
  }

  test('an attestation signed before 2026.2 whose terms are unchanged is signed before full terms, not a terms change', async () => {
    const signedOver = await legacyAttestation(planOf('PLAN-X'), 'EMPAPP-OLD');
    expect(att.attestationTermsStatus(signedOver, [publishedPlan('PLAN-X')])).toMatchObject({ termsChanged: false, signedBeforeFullTerms: true }); // before: termsChanged true
    // what it did not cover may change without making it a terms change: it never committed to the fee
    expect(att.attestationTermsStatus(signedOver, [publishedPlan('PLAN-X', { dispensingFeeCents: 1250 })])).toMatchObject({ termsChanged: false, signedBeforeFullTerms: true });
    // what it covered changing is a terms change
    expect(att.attestationTermsStatus(signedOver, [publishedPlan('PLAN-X', { copayAmountCents: 2500 })])).toMatchObject({ termsChanged: true, signedBeforeFullTerms: false });
  });

  test('an attestation over the current terms is current, and never counted as signed before full terms', () => {
    const app = { applicationId: 'EMPAPP-NEW', employerId: 'E', companyName: 'C', selectedPlanIds: ['PLAN-X'], effectiveDate: '20270101', enrollmentCap: 10 };
    const agreementCommitment = att.computeAgreementCommitment(att.buildAgreementTerms(app, [publishedPlan('PLAN-X')]));
    const signedOver = { applicationId: 'EMPAPP-NEW', employerId: 'E', authorizedPlanIds: ['PLAN-X'], enrollmentCap: 10, effectiveDate: '20270101', agreementCommitment };
    expect(att.attestationTermsStatus(signedOver, [publishedPlan('PLAN-X')])).toMatchObject({ termsChanged: false, signedBeforeFullTerms: false });
    expect(att.attestationTermsStatus(signedOver, [publishedPlan('PLAN-X', { familyOopMaxCents: 400000 })])).toMatchObject({ termsChanged: true, signedBeforeFullTerms: false });
  });

  test('the signed document states the family limits and the network, and that a plan published later needs a new signature', async () => {
    const terms = att.buildAgreementTerms(
      { applicationId: 'EMPAPP-DOC', employerId: 'E', companyName: 'Fernhill Test Works LLC', selectedPlanIds: ['PLAN-X', 'PLAN-NEVER'], effectiveDate: '20270101', enrollmentCap: 10 },
      [publishedPlan('PLAN-X', { familyAnnualBenefitMaxCents: 2500000 }), planOf('PLAN-NEVER', { published: false })],
    );
    const docx = await att.generateAgreementDocx(terms, '1', 'ab', 'cd', 'ef', 'a'.repeat(64), 'Jordan Testcase', 'Owner');
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const text = xml.replace(/<[^>]+>/g, '');
    expect(text).toContain('Family OOP Max');
    expect(text).toContain('$16000.00');                       // the family OOP max
    expect(text).toContain('$25000.00');                       // the family annual max
    expect(text).toContain('Published provider network root for Plan PLAN-X');
    expect(text).toContain('A plan published later is covered only under a new Agreement that the Employer signs');
    expect(text).not.toContain('until the Insurer publishes them');
  });
});

describe('signing, a terms change, and signing the new terms', () => {
  let applicationId: string;
  let sign: (agreement: any) => Promise<Captured>;
  const employerId = `FERNHILL-AGR-${Date.now()}`;

  beforeAll(async () => {
    ({ applicationId, sign } = await approvedApplication(employerId, ['PLAN-AGR', 'PLAN-NEVER']));
  });

  test('the marketplace offers only plans with published terms, at those terms', async () => {
    const r = await call(marketplace, 'GET', '/marketplace/api/plans');
    const offered = r.payload.data as any[];
    expect(offered.map((p) => p.planId)).toEqual(['PLAN-AGR']);   // not the legacy plan, not the draft-only plan
    expect(offered[0]).toMatchObject({ copayAmountCents: 2000, dispensingFeeCents: null, formularyRoot: '111', published: true });
    expect((await call(marketplace, 'GET', '/marketplace/api/plans/:planId', { planId: 'PLAN-AGR' })).payload.data.copayAmountCents).toBe(2000);
    expect((await call(marketplace, 'GET', '/marketplace/api/plans/:planId', { planId: 'PLAN-NEVER' })).status).toBe(404);
  });

  test('the agreement states the published terms, the fee and the formulary, and lists the unpublished plan', async () => {
    const a = await agreementFor(applicationId);
    expect(a.terms.selectedPlans).toEqual([expect.objectContaining({ planId: 'PLAN-AGR', copayAmountCents: 2000, dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', formularyRoot: '111' })]);
    expect(a.terms.unavailablePlanIds).toEqual(['PLAN-NEVER']);
    expect(a.commitment).toBe(att.computeAgreementCommitment(a.terms));
    expect(a.signedAttestation).toBeNull();
    expect(a.attestationSeq).toBe(0);

    const signed = await sign(a);
    expect(signed.status).toBe(200);
    expect(signed.payload.data.docxAvailable).toBe(true);
    const registered = (await rpc('l2_getEmployerAttestation', { employerId })).result;
    expect(registered).toMatchObject({ attestationSeq: 0, agreementCommitment: a.commitment });
    // the plans the agreement covers, not the unpublished plan it lists as unavailable
    expect(registered.authorizedPlanIds).toEqual(['PLAN-AGR']);   // before: ['PLAN-AGR', 'PLAN-NEVER']
    expect(store.get(applicationId).authorizedPlanIds).toEqual(['PLAN-AGR']);
  });

  test('while the published terms are unchanged, the signed attestation is current everywhere', async () => {
    const a = await agreementFor(applicationId);
    expect(a.signedAttestation).toEqual({ attestationSeq: 0, signedAt: expect.any(Number), termsChanged: false, signedBeforeFullTerms: false, plansToAdd: [] });
    expect(a.attestationSeq).toBe(1);
    const apps = (await call(employerAdmin, 'GET', '/employer-applications')).payload.data as any[];
    expect(apps.find((x) => x.applicationId === applicationId)).toMatchObject({ termsChanged: false, signedBeforeFullTerms: false });
  });

  test('after the insurer republishes with a $100 fee, the marketplace, the insurer list and the employer node all say the terms changed', async () => {
    const republished = publishedPlan('PLAN-AGR', { dispensingFeeCents: 10000 }, '222');
    expect((await rpc('l2_storePlan', { plan: republished })).error).toBeUndefined();

    const a = await agreementFor(applicationId);
    expect(a.signedAttestation).toMatchObject({ attestationSeq: 0, termsChanged: true });
    expect(a.terms.selectedPlans[0]).toMatchObject({ dispensingFeeCents: 10000, dispensingFeeSource: 'plan', formularyRoot: '222' });

    const apps = (await call(employerAdmin, 'GET', '/employer-applications')).payload.data as any[];
    expect(apps.find((x) => x.applicationId === applicationId).termsChanged).toBe(true);

    // The employer node holds the attestation the sequencer has and reads the plans as published now.
    const employer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId, displayName: 'Fernhill' });
    employer.setAttestation((await rpc('l2_getEmployerAttestation', { employerId })).result);
    // GET /attestation is open, so the node reads the plans at most once per TTL, however often it is asked
    const client = employer.getClient();
    const readPlans = client.getPlans.bind(client);
    let planReads = 0;
    client.getPlans = async () => { planReads++; return readPlans(); };
    expect(await employer.attestationTermsStatus()).toEqual({ termsChanged: true, signedBeforeFullTerms: false, unavailablePlanIds: [] });
    const tenant = new NautilusAppServer({
      role: 'employer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: tempDir('agreement-employer-'), enableSSE: false,
      maxSseConnections: 0, allowedOrigins: [], adminToken: 'employer-admin-token-for-tests',
    } as any);
    tenant.setEntityNode(employer);
    const employerRoutes = buildEmployerRoutes(tenant);
    const status = await call(employerRoutes, 'GET', '/attestation');
    expect(status.payload.data).toMatchObject({ loaded: true, attestationSeq: 0, termsChanged: true, signedBeforeFullTerms: false, unavailablePlanIds: [] });
    await Promise.all([1, 2, 3].map(() => call(employerRoutes, 'GET', '/attestation')));
    expect(planReads).toBe(1);
    // and it offers the plans with published terms, at those terms
    const available = (await call(employerRoutes, 'GET', '/plans/available')).payload.data as any[];
    expect(available.map((p) => p.planId)).toEqual(['PLAN-AGR']);
    expect(available[0]).toMatchObject({ dispensingFeeCents: 10000, formularyRoot: '222', published: true });
  });

  test('the employer signs the new terms as attestation 1, and the agreement is current again', async () => {
    const a = await agreementFor(applicationId);
    expect(a.attestationSeq).toBe(1);
    const signed = await sign(a);
    expect(signed.status).toBe(200);
    const registered = (await rpc('l2_getEmployerAttestation', { employerId })).result;
    expect(registered).toMatchObject({ attestationSeq: 1, agreementCommitment: a.commitment });
    expect((await agreementFor(applicationId)).signedAttestation).toMatchObject({ attestationSeq: 1, termsChanged: false });

    const employer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId, displayName: 'Fernhill' });
    employer.setAttestation(registered);
    expect((await employer.attestationTermsStatus()).termsChanged).toBe(false);
  });
});

describe('an agreement that covers no published plan', () => {
  test('cannot be signed', async () => {
    const { applicationId, sign } = await approvedApplication(`FERNHILL-NONE-${Date.now()}`, ['PLAN-NEVER', 'PLAN-LEGACY']);
    const a = await agreementFor(applicationId);
    expect(a.terms.selectedPlans).toEqual([]);
    expect(a.terms.unavailablePlanIds).toEqual(['PLAN-NEVER', 'PLAN-LEGACY']);
    const refused = await sign(a);
    expect(refused.status).toBe(409);
    expect(refused.payload.error).toMatch(/None of the plans in this application is published/);
  });
});

describe('a plan the agreement did not cover, published after the employer signed', () => {
  let applicationId: string;
  let sign: (agreement: any) => Promise<Captured>;
  const employerId = `FERNHILL-LATER-${Date.now()}`;

  beforeAll(async () => {
    expect((await rpc('l2_storePlan', { plan: planOf('PLAN-LATER', { published: false }) })).error).toBeUndefined();
    ({ applicationId, sign } = await approvedApplication(employerId, ['PLAN-AGR', 'PLAN-LATER']));
    const signed = await sign(await agreementFor(applicationId));
    expect(signed.status).toBe(200);
  });

  test('is not admitted under the signature: the employer cannot open a group on it once it is published', async () => {
    const registered = (await rpc('l2_getEmployerAttestation', { employerId })).result;
    expect(registered.authorizedPlanIds).toEqual(['PLAN-AGR']);
    // the insurer publishes PLAN-LATER with a $100 fee the employer never saw
    expect((await rpc('l2_storePlan', { plan: publishedPlan('PLAN-LATER', { dispensingFeeCents: 10000 }, '333') })).error).toBeUndefined();
    const employer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId, displayName: 'Fernhill' });
    employer.setAttestation(registered);
    expect(employer.isPlanAuthorized('PLAN-LATER')).toBe(false);   // before: true, at terms never signed
    expect(() => employer.createGroup('GRP-LATER', 'PLAN-LATER', '20270101')).toThrow(/not authorized/);
    expect(employer.isPlanAuthorized('PLAN-AGR')).toBe(true);
  });

  test('the agreement route offers it to sign as the next attestation, and signing it admits it', async () => {
    const a = await agreementFor(applicationId);
    expect(a.signedAttestation).toMatchObject({ attestationSeq: 0, termsChanged: false, signedBeforeFullTerms: false, plansToAdd: ['PLAN-LATER'] });
    expect(a.terms.selectedPlans.map((p: any) => p.planId)).toEqual(['PLAN-AGR', 'PLAN-LATER']);
    expect(a.terms.selectedPlans[1]).toMatchObject({ dispensingFeeCents: 10000, dispensingFeeSource: 'plan', formularyRoot: '333' });
    expect(a.canonicalMessage).toContain('|PLAN-AGR,PLAN-LATER|');
    const signed = await sign(a);
    expect(signed.status).toBe(200);
    const registered = (await rpc('l2_getEmployerAttestation', { employerId })).result;
    expect(registered).toMatchObject({ attestationSeq: 1, authorizedPlanIds: ['PLAN-AGR', 'PLAN-LATER'] });
    const employer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId, displayName: 'Fernhill' });
    employer.setAttestation(registered);
    expect(employer.isPlanAuthorized('PLAN-LATER')).toBe(true);
    expect((await agreementFor(applicationId)).signedAttestation).toMatchObject({ attestationSeq: 1, plansToAdd: [] });
  });
});
