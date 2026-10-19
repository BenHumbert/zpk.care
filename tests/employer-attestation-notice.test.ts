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
 * The employer's own dashboard says when its signed agreement needs new terms, and what to do (review of the pricing
 * fixes, A-48 follow-up).
 *
 * What was missing: the employer node's GET /attestation reported termsChanged and signedBeforeFullTerms, but the
 * employer dashboard showed neither, only the authorized plans; and nothing on the employer's side said which of the
 * plans it selected had been published since it signed, which only the insurer knows (the marketplace's agreement route
 * names them as plansToAdd, during signing only).
 *
 * Now the insurer node answers GET /employer-agreements/:applicationId/plans-to-add (open like the marketplace's other
 * per-application reads, plan IDs only, rate-limited), the employer node asks it for the application its attestation
 * names, at most once per 30 s, and GET /attestation carries plansToAdd and the marketplace URL; the dashboard's
 * attestation banner says what changed and to sign the new terms on the marketplace.
 *
 * A real sequencer RPC server holds the plans; the insurer node runs on a real NautilusAppServer that the employer node
 * reaches over HTTP.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(120_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const OPERATOR = 'operator-token-for-attestation-notice';
let rpcServer: any;
let seqUrl: string;
let insurerUrl: string;
let store: Map<string, any>;
let EmployerNode: any;
let NautilusAppServer: any;
let buildEmployerRoutes: any;
let buildInsurerRoutes: any;
let InsurerNode: any;
let insurerKey: { nodeId: string; seedHex: string; publicKeyHex: string };
const stops: Array<() => Promise<void>> = [];
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${seqUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}

const planOf = (planId: string, over: Record<string, unknown> = {}) => ({
  planId, name: `Plan ${planId}`, coverageType: 1, copayAmountCents: 2000, deductibleAmountCents: 50000, oopMaxCents: 780000,
  annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0,
  formularyNdcs: ['00378410591'], networkProviderWalletIds: [], published: true, createdAt: 1, updatedAt: 1, ...over,
});

const application = (applicationId: string, over: Record<string, unknown>) => ({
  applicationId, employerId: `EMP-${applicationId}`, companyName: 'Fernhill Test Works LLC', contactName: 'Jordan Testcase',
  contactEmail: 'hr@fernhill.example.test', state: 'WI', effectiveDate: '2027-01-01', enrollmentCap: 10, publicKeyHex: 'a'.repeat(64),
  submittedAt: 1, ...over,
});

/** An insurer node on a random port serving its routes over the test sequencer. */
async function startInsurer(): Promise<string> {
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: tempDir('notice-insurer-'), enableSSE: false,
    maxSseConnections: 0, allowedOrigins: [], adminToken: 'insurer-admin-token', nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
  });
  server.registerRoutes(buildInsurerRoutes(server));
  server.setEntityNode(new InsurerNode({ role: 'insurer', sequencerUrl: seqUrl, clientOptions: server.sequencerClientOptions() }));
  await server.start();
  stops.push(() => server.stop());
  return `http://127.0.0.1:${server.getPort()}`;
}

beforeAll(async () => {
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { generateNodeKey } = await import('../src/security/node-roles.js');
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  ({ NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js'));
  ({ buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js'));
  ({ buildEmployerRoutes } = await import('../src/nodes/routes/employer-routes.js'));
  ({ EmployerNode } = await import('../src/nodes/employer-node.js'));
  ({ InsurerNode } = await import('../src/nodes/insurer-node.js'));
  const { getApplicationStore } = await import('../src/nodes/routes/marketplace-routes.js');
  store = getApplicationStore();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-attestation-notice' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  insurerKey = generateNodeKey('insurer-node');
  rpcServer.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
  await rpcServer.start();
  seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;

  // PLAN-A and PLAN-LATER are published; PLAN-DRAFT never was.
  for (const planId of ['PLAN-A', 'PLAN-LATER']) {
    const plan = planOf(planId);
    expect((await rpc('l2_storePlan', { plan: { ...plan, formularyRoot: '111', networkRoot: '0', publishedTerms: publishedTermsFrom(plan as any, '111', '0', 1) } })).error).toBeUndefined();
  }
  expect((await rpc('l2_storePlan', { plan: planOf('PLAN-DRAFT', { published: false }) })).error).toBeUndefined();

  // An employer that selected all three and signed when only PLAN-A was published; one that signed before
  // authorizedPlanIds was kept; one approved and not yet signed.
  store.set('EMPAPP-SIGNED', application('EMPAPP-SIGNED', { status: 'active', selectedPlanIds: ['PLAN-A', 'PLAN-LATER', 'PLAN-DRAFT'], authorizedPlanIds: ['PLAN-A'] }));
  store.set('EMPAPP-OLD', application('EMPAPP-OLD', { status: 'signed', selectedPlanIds: ['PLAN-A', 'PLAN-LATER'] }));
  store.set('EMPAPP-UNSIGNED', application('EMPAPP-UNSIGNED', { status: 'approved', selectedPlanIds: ['PLAN-A', 'PLAN-LATER'] }));

  insurerUrl = await startInsurer();
});

afterAll(async () => {
  for (const stop of stops) await stop();
  await rpcServer?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const plansToAdd = async (base: string, applicationId: string) => {
  const r = await fetch(`${base}/employer-agreements/${applicationId}/plans-to-add`);
  return { status: r.status, json: await r.json() as any };
};

describe('the insurer names the plans an employer can add to its signed agreement', () => {
  test('a selected plan published after signing, and not one still unpublished or already authorized', async () => {
    const r = await plansToAdd(insurerUrl, 'EMPAPP-SIGNED');
    expect(r.status).toBe(200);                                         // before: 404, no such route
    expect(r.json.data).toEqual({ applicationId: 'EMPAPP-SIGNED', plansToAdd: ['PLAN-LATER'] });
  });

  test('nothing to add for an attestation that authorized every selected plan, or an agreement not yet signed; 404 for no application', async () => {
    expect((await plansToAdd(insurerUrl, 'EMPAPP-OLD')).json.data.plansToAdd).toEqual([]);
    expect((await plansToAdd(insurerUrl, 'EMPAPP-UNSIGNED')).json.data.plansToAdd).toEqual([]);
    expect((await plansToAdd(insurerUrl, 'EMPAPP-NONE')).status).toBe(404);
  });

  test('each caller may ask 30 times a minute', async () => {
    const own = await startInsurer();
    const answers: number[] = [];
    for (let i = 0; i < 31; i++) answers.push((await plansToAdd(own, 'EMPAPP-SIGNED')).status);
    expect(answers.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(answers[30]).toBe(429);
  });
});

describe('the employer node and its GET /attestation', () => {
  const attestation = (applicationId: string) => ({
    v: 2, employerId: `EMP-${applicationId}`, publicKeyHex: 'a'.repeat(64), authorizedPlanIds: ['PLAN-A'], enrollmentCap: 10,
    agreementCommitment: '1', documentHash: 'abc', effectiveDate: '20270101', employerSignature: '', insurerSignature: '',
    insurerPublicKeyHex: '', ts: 1, applicationId, attestationSeq: 0, signerName: 'Jordan Testcase', signerTitle: 'Owner',
  });

  async function call(routes: any[], method: string, p: string): Promise<{ status: number; payload: any }> {
    const r = routes.find((x) => x.method === method && x.path === p);
    let status = 0;
    let payload: any = {};
    const res = {
      writeHead(code: number) { status = code; return this; },
      setHeader() { return this; },
      end(b?: string) { if (b) payload = JSON.parse(b); return this; },
      get writableEnded() { return status !== 0; },
    };
    await r.handler({ url: p, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, {}, new URLSearchParams(), undefined);
    return { status, payload };
  }

  function employerRoutesFor(employer: any): any[] {
    const tenant = new NautilusAppServer({
      role: 'employer', port: 0, host: '127.0.0.1', sequencerUrl: seqUrl, stateDir: tempDir('notice-employer-'), enableSSE: false,
      maxSseConnections: 0, allowedOrigins: [], adminToken: 'employer-admin-token',
    });
    tenant.setEntityNode(employer);
    return buildEmployerRoutes(tenant);
  }

  test('GET /attestation carries the plans to add and where the employer signs', async () => {
    const employer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId: 'EMP-EMPAPP-SIGNED', insurerUrl, displayName: 'Fernhill' });
    employer.setAttestation(attestation('EMPAPP-SIGNED'));
    const status = await call(employerRoutesFor(employer), 'GET', '/attestation');
    expect(status.status).toBe(200);
    expect(status.payload.data).toMatchObject({ loaded: true, attestationSeq: 0, plansToAdd: ['PLAN-LATER'], marketplaceUrl: `${insurerUrl}/marketplace/` });
    expect(typeof status.payload.data.termsChanged).toBe('boolean');
    // before any attestation, the marketplace link still comes from the node
    const waiting = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId: 'EMP-NEW', insurerUrl, displayName: 'New' });
    expect((await call(employerRoutesFor(waiting), 'GET', '/attestation')).payload.data).toMatchObject({ loaded: false, marketplaceUrl: `${insurerUrl}/marketplace/` });
  });

  test('the node asks its insurer at most once per 30 s, and says null when it cannot ask', async () => {
    let asked = 0;
    const insurer = http.createServer((req, res) => {
      asked++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { applicationId: 'EMPAPP-SIGNED', plansToAdd: ['PLAN-LATER'] } }));
    });
    await new Promise<void>((resolve) => insurer.listen(0, '127.0.0.1', () => resolve()));
    stops.push(() => new Promise<void>((resolve) => insurer.close(() => resolve())));
    const url = `http://127.0.0.1:${(insurer.address() as AddressInfo).port}`;
    const employer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId: 'EMP-EMPAPP-SIGNED', insurerUrl: url, displayName: 'Fernhill' });
    employer.setAttestation(attestation('EMPAPP-SIGNED'));
    expect(await Promise.all([1, 2, 3].map(() => employer.attestationPlansToAdd()))).toEqual([['PLAN-LATER'], ['PLAN-LATER'], ['PLAN-LATER']]);
    expect(asked).toBe(1);
    // a new attestation is asked about afresh
    employer.setAttestation({ ...attestation('EMPAPP-SIGNED'), attestationSeq: 1 });
    await employer.attestationPlansToAdd();
    expect(asked).toBe(2);

    const noInsurer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId: 'EMP-X', displayName: 'X' });
    noInsurer.setAttestation(attestation('EMPAPP-SIGNED'));
    expect(await noInsurer.attestationPlansToAdd()).toBeNull();
    expect(noInsurer.getMarketplaceUrl()).toBeNull();
    const deadInsurer = new EmployerNode({ role: 'employer', sequencerUrl: seqUrl, employerId: 'EMP-Y', insurerUrl: 'http://127.0.0.1:1', displayName: 'Y' });
    deadInsurer.setAttestation(attestation('EMPAPP-SIGNED'));
    expect(await deadInsurer.attestationPlansToAdd()).toBeNull();
  });
});

// ─── The employer dashboard ───────────────────────────────────────────────────────────────

const EMPLOYER_APP = read('dashboard-employer/app.js');
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The Groups tab's attestation banner, the node's GET /attestation answering `data`. */
async function banner(data: Record<string, unknown>): Promise<string> {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] = els[id] ?? { id, innerHTML: '', textContent: '', disabled: false }) };
  const load = run(['marketplaceHref', 'attestationNotice', 'loadAttestationBanner'].map((n) => lift(EMPLOYER_APP, n)), {
    document, esc: escHtml, toast: () => undefined, loadGroupsTable: () => undefined,
    API: { getAttestation: async () => data, refreshAttestation: async () => ({ loaded: false }) },
  }, 'loadAttestationBanner');
  await load();
  return String(els['attestation-banner'].innerHTML);
}
const LOADED = { loaded: true, authorizedPlanIds: ['PLAN-A'], enrollmentCap: 10, effectiveDate: '20270101', attestationSeq: 0, unavailablePlanIds: [], marketplaceUrl: 'http://localhost:4004/marketplace/' };

describe('the employer dashboard\'s attestation banner', () => {
  test('terms changed: says so, names a plan no longer published, and says to sign the new terms on the marketplace', async () => {
    const html = await banner({ ...LOADED, termsChanged: true, signedBeforeFullTerms: false, unavailablePlanIds: ['PLAN-GONE'], plansToAdd: [] });
    expect(html).toContain('ACTION NEEDED: SIGN THE NEW TERMS');
    expect(html).toContain('Terms changed since you signed.');
    expect(html).toContain('no longer published: PLAN-GONE');
    expect(html).toContain('Sign the new terms on <a href="http://localhost:4004/marketplace/" target="_blank" rel="noopener">the marketplace</a>; they register as attestation #1.');
  });

  test('signed before full terms: says the terms it covered are unchanged, and to sign the full terms', async () => {
    const html = await banner({ ...LOADED, termsChanged: false, signedBeforeFullTerms: true, plansToAdd: [] });
    expect(html).toContain('Signed before full terms.');
    expect(html).toContain('The terms it covered are unchanged.');
    expect(html).not.toContain('Terms changed since you signed');
    expect(html).toContain('Sign the new terms on');
  });

  test('plans to add: names them and why no group can be created on them yet', async () => {
    const html = await banner({ ...LOADED, termsChanged: false, signedBeforeFullTerms: false, plansToAdd: ['PLAN-LATER'], marketplaceUrl: 'http://127.0.0.1:4004/marketplace/' });
    expect(html).toContain('Plans to add.');
    expect(html).toContain('PLAN-LATER is published now, and your agreement does not cover it, so no group can be created on it yet.');
    expect(html).toContain('href="http://127.0.0.1:4004/marketplace/"');
  });

  test('a current agreement shows no notice; an unusable marketplace URL falls back to the local marketplace', async () => {
    const html = await banner({ ...LOADED, termsChanged: false, signedBeforeFullTerms: false, plansToAdd: [] });
    expect(html).toContain('MARKETPLACE ATTESTATION LOADED');
    expect(html).not.toContain('ACTION NEEDED');
    const odd = await banner({ ...LOADED, termsChanged: true, plansToAdd: null, marketplaceUrl: 'javascript:alert(1)' });
    expect(odd).not.toContain('javascript:');
    expect(odd).toContain('href="http://localhost:4004/marketplace/"');
  });
});
