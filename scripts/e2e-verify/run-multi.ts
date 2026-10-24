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
 * Multi-employer, multi-member end-to-end verifier for a running zpk.care network.
 *
 * Two employers onboard at the same time; four members, each on their own member
 * device, enroll concurrently (one of them while another member's claim is being
 * adjudicated). After every registration and claim the verifier checks that the
 * sequencer's wallet tree still hashes to its published root. Then it re-derives
 * every claim's split, recomputes claim-leaf inclusion proofs, rebuilds accumulators,
 * verifies batch proofs and a portable credential against locally compiled keys
 * (and confirms tampered copies fail), probes insurer auth, and scans for leaked secrets.
 *
 * Usage:
 *   ZKTRIDENT_ADMIN_TOKEN=... npx tsx scripts/e2e-verify/run-multi.ts <outDir> <devicesDir> [networkLog]
 *   ZKT_E2E_SERIAL=1 enrolls the members one at a time instead of concurrently (the concurrent registration
 *   race is a known open finding; serial mode measures everything after it).
 *   Member devices: http://localhost:4001 (stateDir <repo>/nautilus-data) and 4011-4013
 *   (stateDir <devicesDir>/member-<port>).
 */
import fs from 'fs';
import path from 'path';
import { deriveNodeAdminToken } from '../../src/security/node-roles.js';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Field, Poseidon, verify } from 'o1js';
import { Trace, makeHttp, poll, abbrev } from './trace.js';
import { waitForEngineReady } from './engine-ready.js';
import { expectedAdjudication, findSecrets, nadacE5, expectedNadacIngredientCents, deductibleLanding } from './reference.js';
import { hashString, hashDate } from '../../src/zkp/hash-utils.js';
import { NautilusLocalState } from '../../src/nodes/nautilus-local-state.js';
import { l2Parse } from '../../src/l2/l2-json.js';
import { WalletRegistryWitness, WalletState } from '../../src/wallets/wallet-state.js';

const SEQ = 'http://localhost:3030', INS = 'http://localhost:4004', PHA = 'http://localhost:4003';
const ADMIN = process.env.ZKTRIDENT_ADMIN_TOKEN || '';
const OUT = path.resolve(process.argv[2] || './e2e-multi-out');
const DEVICES = path.resolve(process.argv[3] || './e2e-devices');
const NETWORK_LOG = process.argv[4] || '';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN = Date.now().toString(36).toUpperCase();
// A7: the harness runs one HR Tool per employer, as each employer's machine would. Spawned without
// npx or a shell so each is one process, and all are stopped however this harness ends.
const hrToolChildren: import('child_process').ChildProcess[] = [];
async function startHrTool(label: string, employerId: string): Promise<string> {
  const { spawn } = await import('child_process');
  const net = await import('net');
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'tools', 'hr-tool-server.ts')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HR_TOOL_DATA_DIR: `./hr-tool-data/${employerId}` },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[hr-tool ${label}] ${d}`));
  hrToolChildren.push(child);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const r = await fetch(`${url}/api/session`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`HR Tool for ${label} did not start within 60 s`);
    await new Promise(r => setTimeout(r, 500));
  }
  return url;
}
process.on('exit', () => { for (const c of hrToolChildren) { if (!c.killed) { try { c.kill(); } catch { /* best effort */ } } } });
const bearer = { Authorization: `Bearer ${ADMIN}` };
// A9: one credential per principal — the insurer takes its own token, configured or derived from the operator's, never the operator's.
const INSURER_ADMIN = process.env.ZKTRIDENT_INSURER_ADMIN_TOKEN || (ADMIN ? deriveNodeAdminToken(ADMIN, 'insurer') : '');
const insurerBearer = { Authorization: `Bearer ${INSURER_ADMIN}` };
const RECOVERY_PIN = '246813';
const SERIAL = process.env.ZKT_E2E_SERIAL === '1';
const unwrap = (j: any) => (j && typeof j === 'object' && 'ok' in j && 'data' in j ? j.data : j);

fs.mkdirSync(OUT, { recursive: true });
const traces: Trace[] = [];
function lane(name: string) {
  const t = new Trace(path.join(OUT, name));
  traces.push(t);
  return { t, http: makeHttp(t) };
}
const quiet = makeHttp(new Trace(path.join(OUT, '_polls')));
/*
 * A11 admin-gated `GET /interactive/state`, and this harness uses it two different ways.
 *
 * Bookkeeping reads — readiness, prescription status, enrolled members — are the harness acting as
 * an operator, so they carry the admin token through these clients.
 *
 * The PHI sweep near the end reads it **deliberately unauthenticated**, because its job is to
 * measure what an outsider can collect. That call keeps using the bare client, and a refusal
 * there is the result we want.
 */
const httpAdmin = makeHttp(new Trace(path.join(OUT, '_admin')), { headers: bearer });
const quietAdmin = makeHttp(new Trace(path.join(OUT, '_polls')), { headers: bearer });
const main = lane('main');
const results: Record<string, any> = { run: RUN, startedAt: new Date().toISOString(), employers: {}, members: {}, claims: [], invariant: [], findings: [] as any[] };

async function rpc(method: string, params: Record<string, unknown> = {}, http = main.http, auth = false) {
  const r = await http('POST', `${SEQ}/rpc`, { jsonrpc: '2.0', id: 1, method, params }, auth ? bearer : {});
  const parsed = r.text ? l2Parse(r.text) as any : null;
  return { status: r.status, result: parsed?.result, error: parsed?.error };
}

// ─── Invariant: the sequencer's tree hashes to its published root ───
async function checkInvariant(label: string, wallets: string[]) {
  const t = main.t;
  const w = (await rpc('l2_getRegistrationWitnesses', {}, quiet)).result;
  const root = String(w.currentRegistryRoot);
  const next = WalletRegistryWitness.fromJSON(JSON.parse(w.registryWitnessJson)).calculateRoot(Field(0)).toString();
  let walletsOk = 0;
  for (const wid of wallets) {
    const ws = (await rpc('l2_getWalletWitnesses', { walletId: wid }, quiet, true)).result;
    const st = (await rpc('l2_getWalletState', { walletId: wid }, quiet, true)).result;
    const leaf = new WalletState({ walletId: Field(BigInt(wid)), credentialInventoryRoot: Field(BigInt(st.credentialInventoryRoot)), nonce: Field(BigInt(st.nonce)) }).commitment();
    if (WalletRegistryWitness.fromJSON(JSON.parse(ws.registryWitnessJson)).calculateRoot(leaf).toString() === root) walletsOk++;
  }
  const ok = next === root && walletsOk === wallets.length;
  results.invariant.push({ label, ok, root, nextSlot: w.nextSlotIndex, walletsChecked: wallets.length, walletsOk });
  t.check(`Invariant after ${label}: empty next slot and all ${wallets.length} wallets hash to the published root`, ok, root, { nextSlotRoot: next, walletsOk });
  return ok;
}

// ─── Employers ──────────────────────────────────────────────
async function onboardEmployer(label: string, planId: string, people: Array<{ employeeId: string; familyId: string; firstName: string; lastName: string; dob: string; email: string }>) {
  const { t, http } = lane(`employer-${label}`);
  t.begin(`employer ${label}`, 'Apply, get approved, sign, activate, create group, issue codes');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('hex');
  const employerId = `E2E-${label}-${RUN}`;
  t.secret(`employer ${label} Ed25519 private key`, (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('hex'));
  const apply = await http('POST', `${INS}/marketplace/api/apply`, {
    companyName: `${label === 'A' ? 'Fernhill' : 'Bayside'} Test Works LLC`, employerId, contactName: `HR ${label}`, contactEmail: `hr-${label.toLowerCase()}@example.test`,
    ein: label === 'A' ? '00-0000001' : '00-0000002', state: 'WI', selectedPlanIds: [planId], effectiveDate: new Date().toISOString().slice(0, 10), enrollmentCap: 10, publicKeyHex,
  });
  const appId = unwrap(apply.json)?.applicationId;
  // A8: the activation code, shown once at submission, is what collects the credentials.
  const activationCode: string = unwrap(apply.json)?.activationCode ?? '';
  const claimSecret = activationCode.includes('.') ? activationCode.split('.').slice(1).join('.') : '';
  t.check('Application accepted', !!appId, 'applicationId', apply.json);
  const up = await fetch(`${INS}/marketplace/api/upload-document/${appId}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4\n% E2E placeholder (fictional)\n%%EOF\n') });
  t.check('IRS letter uploaded', up.status < 300, '2xx', up.status);
  const appr = await http('POST', `${INS}/employer-applications/${appId}/approve`, {}, insurerBearer);
  t.check('Insurer approved with its own admin token', appr.status < 300, '2xx', appr.status);
  const agr = unwrap((await http('GET', `${INS}/marketplace/api/agreement/${appId}`)).json);
  const sig = crypto.sign(null, Buffer.from(`${agr?.canonicalMessage}|HR ${label}|Owner`, 'utf8'), privateKey).toString('hex');
  const sign = await http('POST', `${INS}/marketplace/api/sign/${appId}`, { employerSignature: sig, ts: agr?.ts, signerName: `HR ${label}`, signerTitle: 'Owner', reviewedAt: Date.now() });
  t.check('Agreement signed', sign.status < 300, '2xx', sign.status);
  await http('POST', `${INS}/marketplace/api/activate/${appId}`, {});
  const act = unwrap((await poll(quiet, `${INS}/marketplace/api/activate-status/${appId}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 300_000, 2000)).json);
  t.check('Employer node activated', act?.status === 'complete', 'complete', act?.status ?? act);
  t.check('The open status poll carries no admin token', !act?.adminToken, 'absent', act?.adminToken ?? 'absent');
  // A8: collect the admin token once, with the activation secret.
  const cred = unwrap((await http('POST', `${INS}/marketplace/api/activate-credentials/${appId}`, { claimSecret })).json);
  t.check('Admin credentials collected with the activation secret', Boolean(cred?.adminToken), 'token', cred?.adminToken ? 'present' : cred);
  act.employerNodeUrl = cred?.employerNodeUrl ?? act.employerNodeUrl;
  act.adminToken = cred?.adminToken;
  const groupId = `GRP-${label}-${RUN}`;
  const grp = await http('POST', `${act.employerNodeUrl}/groups`, { groupId, planId, effectiveDate: new Date().toISOString().slice(0, 10), enrollmentCap: 10 }, { Authorization: `Bearer ${act.adminToken}` });
  t.check('Group created', grp.status < 300, '2xx', grp.status);
  // A7: the HR Tool runs on the employer's machine. This harness plays each employer's machine:
  // one HR Tool per employer, set up with what activation handed over.
  const hrToolUrl = await startHrTool(label, employerId);
  const passphrase = `hr-pass-${label}-${RUN}-${crypto.randomBytes(3).toString('hex')}`;
  const setup = await http('POST', `${hrToolUrl}/api/setup`, { employerNodeUrl: act.employerNodeUrl, adminToken: act.adminToken, passphrase, passphraseConfirm: passphrase });
  t.check('HR Tool set up on the employer machine', setup.status < 300, '2xx', setup.status);
  await http('POST', `${hrToolUrl}/api/group/select`, { groupId });
  const csv = ['employee_id,family_id,first_name,last_name,dob,email', ...people.map(p => `${p.employeeId},${p.familyId},${p.firstName},${p.lastName},${p.dob},${p.email}`)].join('\n');
  const imp = await http('POST', `${hrToolUrl}/api/import`, { csvContent: csv, validUntil: '2027-12-31', dryRun: false });
  const impData = unwrap(imp.json) ?? imp.json;
  t.check(`${people.length} employees imported`, impData?.success === people.length, people.length, imp.json);
  // PINs are returned once, in the import result; the export never carries them again.
  const byEmployee: Record<string, { tokenId: string; tokenPIN: string }> = {};
  for (const r of (impData?.results ?? []) as Array<{ employeeId: string; status: string; tokenId?: string; tokenPIN?: string }>) {
    if (r.status !== 'ok' || !r.tokenId || !r.tokenPIN) continue;
    byEmployee[r.employeeId] = { tokenId: r.tokenId, tokenPIN: r.tokenPIN };
    const p = people.find(x => x.employeeId === r.employeeId);
    t.secret(`code for ${p?.firstName ?? r.employeeId}`, `${r.tokenId} / PIN ${r.tokenPIN}`);
  }
  const exported = (unwrap((await http('GET', `${hrToolUrl}/api/export/tokens`)).json)?.tokens ?? []) as any[];
  t.check('The export carries codes and no PINs', exported.length === people.length && exported.every(x => !x.tokenPIN), 'codes only', exported.some(x => x.tokenPIN) ? 'a PIN was exported' : `${exported.length} codes`);
  t.check('One enrollment code per employee', Object.keys(byEmployee).length === people.length, people.length, Object.keys(byEmployee).length);
  t.end();
  results.employers[label] = { employerId, appId, groupId, employerNodeUrl: act.employerNodeUrl, hrToolUrl };
  return { employerId, groupId, privateKey, byEmployee };
}

// ─── Members ────────────────────────────────────────────────
type Person = { key: string; employer: string; port: number; employeeId: string; familyId: string; firstName: string; lastName: string; dob: string; email: string; pin: string };

/** The prescriber node's wallet (fixture prescriber 0): the primary-care prescriber every member names (B5). */
async function prescriberWallet(): Promise<string> {
  if (!results.prescriberWalletId) results.prescriberWalletId = unwrap((await main.http('GET', 'http://localhost:4002/health')).json)?.walletId;
  return String(results.prescriberWalletId ?? '');
}

async function enrollMember(p: Person, token: { tokenId: string; tokenPIN: string }, groupId: string) {
  const { t, http } = lane(`member-${p.key}`);
  const MEM = `http://localhost:${p.port}`;
  /*
   * A5: this device's routes require a session, issued by unlock once it has verified the PIN.
   * `mem()` carries it. /onboarding/status and /onboarding/unlock stay open, and eject
   * authorises on the PIN rather than a session, so those three are called bare.
   */
  let memSession = '';
  const mem = (method: string, urlPath: string, body?: unknown) =>
    http(method, `${MEM}${urlPath}`, body,
      memSession ? { 'X-Device-Session': memSession } : {});
  const stateDir = p.port === 4001 ? path.join(REPO, 'nautilus-data') : path.join(DEVICES, `member-${p.port}`);
  t.begin(`member ${p.key}`, `Enroll ${p.firstName} ${p.lastName} on device :${p.port}`);
  t.secret('device PIN', p.pin);
  const ph0 = unwrap((await http('GET', `${MEM}/onboarding/status`)).json)?.phase;
  // A4: eject needs the PIN, proved at the moment of erasing.
  if (ph0 && ph0 !== 'awaiting_token' && ph0 !== 'locked') await http('POST', `${MEM}/onboarding/eject`, { pin: p.pin });
  const unl = await http('POST', `${MEM}/onboarding/unlock`, { pin: p.pin });
  t.check('Device unlocked', unl.status < 300, '2xx', 'unlock');
  memSession = unwrap(unl.json)?.deviceSession ?? '';
  t.check('Device session issued on unlock', Boolean(memSession), 'a token', memSession ? 'issued' : unl.json);
  t.check('Code accepted', (await mem('POST', '/onboarding/accept-token', { tokenId: token.tokenId })).status < 300, '2xx', 'accept-token');
  t.check('Enrollment key generated on the device', (await mem('POST', '/onboarding/generate-key', {})).status < 300, '2xx', 'generate-key');
  // C2/A6: the code is redeemed before the wallet exists; the insurer answers the employer group
  const rd = await mem('POST', '/onboarding/redeem', { tokenPIN: token.tokenPIN });
  t.check('Enrollment code redeemed before derivation; the insurer answered the employer group', rd.status < 300 && unwrap(rd.json)?.groupIdHash === hashString(groupId).toString(), hashString(groupId).toString(), unwrap(rd.json)?.groupIdHash ?? rd.json);
  const today = new Date().toISOString().slice(0, 10);
  const dw = await mem('POST', '/onboarding/derive-wallet', {
    cardholderId: p.employeeId, dateOfBirth: p.dob, firstName: p.firstName, lastName: p.lastName,
    consentRecord: { phiDescription: 'Claim adjudication data', disclosingParty: 'Member', receivingParty: 'zpk.care network', purpose: 'E2E verification', expiration: '2027-12-31', signatureDate: today },
  });
  const walletId = unwrap(dw.json)?.walletId as string;
  t.check('Wallet derived', !!walletId, 'walletId', dw.json);
  const en = await mem('POST', '/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
  t.check('Insurer accepted the enrollment', en.status < 300, '2xx', en.json);
  const t0 = Date.now();
  await mem('POST', '/onboarding/compile', {});
  await poll(quiet, `${MEM}/onboarding/status`, j => ['ready', 'registered', 'registering'].includes(unwrap(j)?.phase), 600_000, 3000);
  const reg = await mem('POST', '/proof/registration', {});
  // The route may outlast the 30 s HTTP timeout; wait for the receipt and the adjudication registration.
  let registered = false;
  for (const start = Date.now(); Date.now() - start < 900_000;) {
    const rr = (await rpc('l2_getReceiptsByWallet', { walletId }, quiet, true)).result;
    const st = (await quietAdmin('GET', `${SEQ}/interactive/state`)).json;
    const inAdj = (st?.enrolledMembers ?? []).some((m: any) => m.walletId === walletId);
    if ((rr?.receipts ?? rr ?? []).length > 0 && inAdj) { registered = true; break; }
    if (reg.status >= 400 && reg.status !== 504 && !/timeout/i.test(String(reg.json?.error ?? ''))) break;
    await new Promise(r => setTimeout(r, 4000));
  }
  const regMs = Date.now() - t0;
  t.check('Registration proof accepted and member registered with the adjudication engine', registered, true, registered ? `ok in ${regMs} ms` : reg.json);
  // B1 step two: the credential mint is a wallet update the device proves; the engine holds no preimage
  let mintRun: any = null;
  for (const start = Date.now(); Date.now() - start < 300_000;) {
    const run = await mem('POST', '/proof/wallet-updates', {});
    mintRun = unwrap(run.json) ?? run.json;
    if (run.status === 200 && Number(mintRun?.pending) === 0 && (mintRun?.errors ?? []).length === 0) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  t.check('The device proved the credential mint it was handed', Number(mintRun?.pending) === 0 && (mintRun?.errors ?? []).length === 0 && (mintRun?.refused ?? []).length === 0, 'pending 0, no errors', mintRun);
  // B5: the member names the prescriber node as primary care from the device; the engine queues it, the device proves it
  const pcpWallet = await prescriberWallet();
  const pcpPick = await mem('POST', '/pcp/assign', { pcpWalletId: pcpWallet, effectiveDate: today.replace(/-/g, ''), specialty: 'Family Medicine' });
  const pcpProve = await mem('POST', '/proof/pcp-assignment', {});
  const pcpOut = unwrap(pcpProve.json) ?? pcpProve.json;
  const pcpRun = pcpOut?.walletUpdates ?? {};
  t.check('Primary care named from the device and proved', pcpPick.status === 200 && pcpProve.status === 200 && Number(pcpRun.pending) === 0 && (pcpRun.errors ?? []).length === 0 && (pcpRun.refused ?? []).length === 0, 'pending 0, no errors', pcpProve.status === 200 ? pcpRun : (pcpOut ?? pcpPick.json));
  // Device secrets: the device knows its wallet; its enrollment key is a secret the sweep must not find on the network.
  const ls = new NautilusLocalState(stateDir);
  await ls.unlock(p.pin);
  const dev = await ls.load();
  const enrollmentKey = ls.hasEnrollmentKey() ? ls.useEnrollmentKey(k => k) : '';
  t.secret('enrollment key (device only)', enrollmentKey);
  t.check('Device state is this member', dev?.walletId === walletId, walletId, dev?.walletId);
  results.members[p.key] = { employer: p.employer, port: p.port, session: memSession, walletId, regMs, groupId, secrets: { enrollmentKey, preimage: [] } };
  t.end();
  return walletId;
}

// ─── Claims ─────────────────────────────────────────────────
/** Plan-bound formularies: the copay the run's plan sets, which the member pays in the copay phase for every drug whatever its tier. No tier copay in the data is $15 (they are $10, $35, $75 and $150). */
const PLAN_COPAY_CENTS = 1500;
/** The copay the members' plan charges: this run's plan, or on resume the plan the earlier run created, as published. */
let planCopayCents = BigInt(PLAN_COPAY_CENTS);
// NADAC pricing (owner decision 2026-10-18): the engine prices each fill at NADAC x quantity, rounded half up to the
// cent, plus the dispensing fee; this plan sets none, so the $10.00 network default applies, and the pharmacy sends no
// costs. Each claim names a drug and quantity whose NADAC price lands it where its label says. Prices are the NADAC
// records in src/data (the same in formulary-100.json and formulary.json); all six are tier 1 (the member pays the
// plan's $15 copay in the copay phase all the same), no PA or step therapy, at most 90 per fill.
const NETWORK_DEFAULT_FEE_CENTS = 1000n;
const DRUGS = {
  ABACAVIR:    { ndc: '00378410591', nadac: '0.60042', qty: 30 },  // ABACAVIR 300 MG TABLET          $18.01 + $10.00 = $28.01
  ADEFOVIR:    { ndc: '42794000308', nadac: '23.69832', qty: 30 }, // ADEFOVIR DIPIVOXIL 10 MG TAB    $710.95 + $10.00 = $720.95
  ABIGALE:     { ndc: '70700033084', nadac: '0.76504', qty: 30 },  // ABIGALE 1 MG-0.5 MG TABLET      $22.95 + $10.00 = $32.95
  ABIGALE_LO:  { ndc: '70700030384', nadac: '0.81693', qty: 30 },  // ABIGALE LO 0.5-0.1 MG TABLET    $24.51 + $10.00 = $34.51
  ACAMPROSATE: { ndc: '00378633380', nadac: '0.36315', qty: 30 },  // ACAMPROSATE CALC DR 333 MG TAB  $10.89 + $10.00 = $20.89
  ABIRTEGA:    { ndc: '82249001112', nadac: '0.90511', qty: 30 },  // ABIRTEGA 250 MG TABLET          $27.15 + $10.00 = $37.15
} as const;
type DrugKey = keyof typeof DRUGS;
type Lands = 'inside-deductible' | 'crosses-deductible' | 'copay-only';
interface ClaimDrug { key: DrugKey; ndcHash: string; copay: bigint; qty: number; nadac: string; ingredient: bigint; fee: bigint; name: string }
let formularyMeds: any[] = [];
/** A scenario drug as the engine lists it; refused if it is missing or not at the NADAC price the scenarios assume. */
function claimDrug(key: DrugKey): ClaimDrug {
  const d = DRUGS[key];
  const m = formularyMeds.find((x: any) => String(x.ndc).replace(/-/g, '') === d.ndc);
  if (!m) throw new Error(`The engine's formulary does not list ${key} (NDC ${d.ndc}); choose new scenario drugs`);
  if (m.nadacPerUnit == null || nadacE5(String(m.nadacPerUnit)) !== nadacE5(d.nadac)) throw new Error(`${key} is listed at NADAC $${m.nadacPerUnit}, not the $${d.nadac} these scenarios were written for`);
  // plan-bound formularies: the plan's copay, whatever the drug's tier (not the engine's PLAN-GOLD-2026 tier copay)
  return { key, ndcHash: hashString(d.ndc).toString(), copay: planCopayCents, qty: d.qty, nadac: d.nadac, ingredient: expectedNadacIngredientCents(nadacE5(d.nadac), d.qty), fee: NETWORK_DEFAULT_FEE_CENTS, name: `${m.brandName} ${m.strength}` };
}
const accState: Record<string, { deductiblePaidCents: bigint; oopPaidCents: bigint }> = {};
async function fileClaim(memberKey: string, walletId: string, drug: ClaimDrug, label: string, opts: { expectRefusal?: RegExp; lands?: Lands } = {}) {
  const { ndcHash, copay, ingredient, fee } = drug;
  const { t, http } = lane(`claim-${memberKey}-${results.claims.length + 1}`);
  t.begin(`claim ${memberKey}`, label);
  const rxId = `RX-${RUN}-${memberKey}-${results.claims.length + 1}`;
  const tp = Date.now();
  const sp = await httpAdmin('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: drug.qty, refills: 0, rxId });
  const isMine = (x: any) => x.id === rxId;
  let prescriptionId: string | undefined = sp.json?.prescriptionId;
  const stillRunning = sp.status === 504 || /timeout/i.test(String(sp.json?.error ?? ''));
  if (!prescriptionId && (!sp.json?.error || stillRunning)) {
    const f = await poll(quietAdmin, `${SEQ}/interactive/state`, j => (j?.prescriptions ?? []).some((x: any) => isMine(x) && x.status === 'ADJUDICATED'), 900_000, 4000);
    prescriptionId = (f.json?.prescriptions ?? []).find(isMine)?.id;
  }
  const prescribeMs = Date.now() - tp;
  t.check('Prescription adjudicated', !!prescriptionId, 'prescriptionId', prescriptionId ?? sp.json);
  if (!prescriptionId) { t.end(); results.claims.push({ memberKey, label, error: sp.json }); return null; }
  await http('POST', `${PHA}/dispensing/mark-filled`, { prescriptionId });
  const tf = Date.now();
  const disp = await http('POST', `${PHA}/dispensing/dispense`, { prescriptionId, quantityDispensed: drug.qty }); // no costs: the engine prices the fill
  let fill: any = unwrap(disp.json);
  if (disp.status < 300 && fill?.jobKey) fill = unwrap((await poll(quiet, `${PHA}/dispensing/fill-status?jobKey=${encodeURIComponent(fill.jobKey)}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 900_000, 4000)).json);
  const fillMs = Date.now() - tf;
  const r = fill?.result ?? fill;
  if (opts.expectRefusal) {
    // D4: the scenario expects this fill to be refused before any proof or payment
    const refused = fill?.status === 'error' && opts.expectRefusal.test(String(fill?.error ?? ''));
    t.check('The fill is refused before any proof or payment, as the scenario expects', refused, `error matching ${opts.expectRefusal}`, fill?.error ?? fill?.status ?? (r?.adjudication ? 'adjudicated' : fill));
    t.end(); results.claims.push({ memberKey, label, refused, error: fill?.error }); return null;
  }
  t.check('Fill adjudicated', !!r?.adjudication, 'adjudication', fill?.error ?? fill?.status);
  if (!r?.adjudication) { t.end(); results.claims.push({ memberKey, label, error: fill }); return null; }
  // B1 step two: the fill produced a wallet update the member's device must prove; the claim lands with it
  const device = results.members[memberKey];
  let fin: any = null;
  for (const start = Date.now(); Date.now() - start < 300_000;) {
    const run = await http('POST', `http://localhost:${device.port}/proof/wallet-updates`, {}, device.session ? { 'X-Device-Session': device.session } : {});
    fin = unwrap(run.json) ?? run.json;
    if (run.status === 200 && Number(fin?.pending) === 0 && (fin?.errors ?? []).length === 0) break;
    await new Promise(r2 => setTimeout(r2, 5000));
  }
  t.check('The device proved the wallet update the fill produced; the claim is on the ledger with it', Number(fin?.pending) === 0 && (fin?.errors ?? []).length === 0 && (fin?.refused ?? []).length === 0, 'pending 0, no errors', fin);
  const adj = r.adjudication, before = r.accumulator.before, after = r.accumulator.after, limits = r.accumulator.limits;
  const acc = accState[memberKey] ?? { deductiblePaidCents: 0n, oopPaidCents: 0n };
  t.check("Accumulator before = this member's running total", BigInt(before.deductiblePaidCents) === acc.deductiblePaidCents && BigInt(before.oopPaidCents) === acc.oopPaidCents, acc, before);
  const exp = expectedAdjudication(ingredient, fee, copay, {
    deductibleAmountCents: BigInt(limits.deductibleAmountCents), deductiblePaidCents: acc.deductiblePaidCents,
    oopMaxCents: BigInt(limits.oopMaxCents), oopPaidCents: acc.oopPaidCents, annualBenefitMaxCents: BigInt(limits.annualBenefitMaxCents ?? 0), annualBenefitUsedCents: 0n,
  });
  t.check(`Ingredient = NADAC $${drug.nadac} x ${drug.qty}, rounded half up`, BigInt(adj.ingredientCostCents) === ingredient, ingredient, adj.ingredientCostCents);
  t.check('Dispensing fee = the network default (this plan sets none), not one the pharmacy chose', BigInt(adj.dispensingFeeCents) === fee && adj.pricing?.dispensingFeeSource === 'network-default', `${fee} (network-default)`, `${adj.dispensingFeeCents} (${adj.pricing?.dispensingFeeSource})`);
  if (opts.lands) {
    const landed = deductibleLanding(exp.total, { deductibleAmountCents: BigInt(limits.deductibleAmountCents), deductiblePaidCents: acc.deductiblePaidCents });
    t.check(`The claim lands where its label says (${opts.lands})`, landed === opts.lands, opts.lands, landed);
  }
  t.check(`Patient pay matches the plan rules (${exp.phase})`, BigInt(adj.patientPayCents) === exp.patientPay, exp.patientPay, adj.patientPayCents);
  t.check('Plan pay matches the plan rules', BigInt(adj.planPayCents) === exp.planPay, exp.planPay, adj.planPayCents);
  const credit = BigInt(after.deductiblePaidCents) - BigInt(before.deductiblePaidCents);
  t.check('Deductible credit matches the plan rules', credit === exp.deductibleCredit, exp.deductibleCredit, credit);
  const fd = r.fulfillmentDetail;
  const fc = Poseidon.hash([fd.prescriptionHash, fd.pharmacyWalletId, fd.ndcHash, fd.quantityDispensed, fd.ingredientCostCents, fd.dispensingFeeCents, fd.dateOfService].map((v: string) => Field(BigInt(v)))).toString();
  t.check('Fulfillment commitment recomputes', fc === fd.commitment, fd.commitment, fc);
  const sc = Poseidon.hash([Field(BigInt(fd.commitment)), Field(BigInt(adj.patientPayCents)), Field(BigInt(adj.planPayCents)), Field(credit)]).toString();
  t.check('Settlement commitment recomputes', sc === r.settlementCommitment, r.settlementCommitment, sc);
  accState[memberKey] = { deductiblePaidCents: BigInt(after.deductiblePaidCents), oopPaidCents: BigInt(after.oopPaidCents) };
  results.claims.push({ memberKey, walletId, label, prescriptionId, prescribeMs, fillMs, adjudication: adj, expected: { phase: exp.phase, patientPay: exp.patientPay.toString(), planPay: exp.planPay.toString(), deductibleCredit: exp.deductibleCredit.toString() }, proofTimesMs: r.proofTimesMs });
  t.end();
  return adj;
}

// ─── Main ───────────────────────────────────────────────────
async function mainFlow() {
  if (!ADMIN) throw new Error('Set ZKTRIDENT_ADMIN_TOKEN');
  const t = main.t, http = main.http;
  t.begin('harness', 'Wait for the network');
  const ready = await poll(quietAdmin, `${SEQ}/interactive/state`, j => j?.compiled === true, 2_400_000, 10_000);
  t.check('All circuits compiled', ready.json?.compiled === true, true, ready.json?.compiled);
  // The engine refuses work that makes proofs (503 with Retry-After) until its proof pool runs, and the pool's workers
  // compile for minutes after boot; every proving step below comes after this.
  const provers = await waitForEngineReady(quiet, SEQ);
  results.engineReadyWaitMs = provers.ms;
  t.check('Claims engine ready to prove', provers.ready, 'ready within 15 min', provers.readiness, `waited ${(provers.ms / 1000).toFixed(1)} s`);
  await checkInvariant('boot (seed providers provisioned)', []);

  t.begin('insurer', 'Create the plan');
  const planId = `PLAN-E2E-${RUN}`;
  const plan = await http('POST', `${INS}/plans`, { planId, name: 'E2E Gold', coverageType: 1, copayAmountCents: PLAN_COPAY_CENTS, deductibleAmountCents: 50000, oopMaxCents: 800000, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000 }, insurerBearer);
  t.check('Plan created with the insurer token', plan.status < 300, '2xx', plan.status);

  // A-34: A1 and A2 are one family on employer A's roster; B1 and B2 are each a family of one.
  const people: Person[] = [
    { key: 'A1', employer: 'A', port: 4001, employeeId: `A1-${RUN}`, familyId: `FA1-${RUN}`, firstName: 'Avery', lastName: 'Quillfeather', dob: '19870412', email: 'a1@example.test', pin: '864209' },
    { key: 'A2', employer: 'A', port: 4011, employeeId: `A2-${RUN}`, familyId: `FA1-${RUN}`, firstName: 'Rowan', lastName: 'Ashgrove', dob: '19921103', email: 'a2@example.test', pin: '531907' },
    { key: 'B1', employer: 'B', port: 4012, employeeId: `B1-${RUN}`, familyId: `FB1-${RUN}`, firstName: 'Jules', lastName: 'Marrowind', dob: '19750828', email: 'b1@example.test', pin: '702318' },
    { key: 'B2', employer: 'B', port: 4013, employeeId: `B2-${RUN}`, familyId: `FB2-${RUN}`, firstName: 'Sasha', lastName: 'Penhallow', dob: '20010219', email: 'b2@example.test', pin: '416685' },
  ];

  if (process.env.E2E_RESUME_DIR) return resumeFromMembers(people, planId);

  // Two employers at the same time.
  const [empA, empB] = await Promise.all([
    onboardEmployer('A', planId, people.filter(p => p.employer === 'A')),
    onboardEmployer('B', planId, people.filter(p => p.employer === 'B')),
  ]);

  t.begin('attacker', "Insurer auth after employers signed");
  const listApps = await http('GET', `${INS}/employer-applications`, undefined, insurerBearer);
  t.check('Insurer admin token still works after two employers signed', listApps.status < 300, '2xx', listApps.status);
  const ts = Date.now().toString();
  const forged = crypto.sign(null, Buffer.from(`GET:/employer-applications|${ts}|`), empA.privateKey).toString('hex');
  const asEmployer = await http('GET', `${INS}/employer-applications`, undefined, { 'X-Admin-Signature': `${empA.employerId}:${ts}:${forged}` });
  t.check("Employer A's signing key is refused on insurer admin routes", asEmployer.status === 401 || asEmployer.status === 403, '401', asEmployer.status);

  const token = (p: Person) => (p.employer === 'A' ? empA : empB).byEmployee[p.employeeId];
  const group = (p: Person) => (p.employer === 'A' ? empA : empB).groupId;

  // Three members from both employers enroll at the same moment.
  t.begin('harness', 'Members A1, A2, B1 enroll concurrently');
  const firstThree = people.slice(0, 3);
  const wallets: string[] = SERIAL
    ? await (async () => { const out: string[] = []; for (const p of firstThree) out.push(await enrollMember(p, token(p), group(p))); return out; })()
    : await Promise.all(firstThree.map(p => enrollMember(p, token(p), group(p))));
  const enrolled: string[] = wallets.filter(Boolean);
  t.check(SERIAL ? 'All three registrations succeeded (serial mode)' : 'All three concurrent registrations succeeded', enrolled.length === 3, 3, enrolled.length);
  await checkInvariant('3 concurrent registrations', enrolled);

  // Drug choice: named drugs at known NADAC prices (DRUGS above). D4: a different drug for each of a member's
  // same-day claims; the same drug twice is a duplicate and is refused.
  const st = (await httpAdmin('GET', `${SEQ}/interactive/state`)).json;
  formularyMeds = (st?.demoData?.medications ?? []) as any[];
  const first = claimDrug('ABACAVIR');
  results.drug = { brandName: first.name, ndc: DRUGS.ABACAVIR.ndc, copayCents: first.copay.toString() };
  t.note(`scenario drugs ${Object.keys(DRUGS).join(', ')}; plan copay ${planCopayCents}¢; network-default dispensing fee ${NETWORK_DEFAULT_FEE_CENTS}¢`);

  // B2 enrolls while A1's first claim is being adjudicated (registration vs. fill contention).
  t.begin('harness', "B2 enrolls while A1's first claim is adjudicated");
  const b2 = people[3];
  let b2Wallet: string = '';
  const a1First = claimDrug('ABACAVIR');   // $18.01 + $10.00 = $28.01: A1 pays it all, deductible $28.01 of $500
  if (SERIAL) {
    b2Wallet = await enrollMember(b2, token(b2), group(b2));
    await fileClaim('A1', wallets[0], a1First, 'A1 claim 1 — inside the deductible', { lands: 'inside-deductible' });
  } else {
    [b2Wallet] = await Promise.all([
      enrollMember(b2, token(b2), group(b2)),
      fileClaim('A1', wallets[0], a1First, 'A1 claim 1 — inside the deductible', { lands: 'inside-deductible' }),
    ]);
  }
  if (b2Wallet) enrolled.push(b2Wallet);
  t.check('B2 registered while a fill was in flight', !!b2Wallet, 'walletId', b2Wallet);
  await checkInvariant('registration during a fill', enrolled);

  // Remaining claims, invariant after each. Expected (fee $10.00, deductible $500, plan copay $15):
  //   A1 claim 2  ADEFOVIR x30 $720.95: $471.99 of A1's deductible left -> A1 $486.99, plan $233.96; deductible met
  //   A1 claim 3  ABIGALE  x30 $32.95:  A1 $15.00, plan $17.95
  //   A2 claim 1  ABACAVIR x30 $28.01:  A2 $28.01, plan $0 (A1's family; no family limit is near)
  //   B1 claim 1  ABACAVIR x30 $28.01:  B1 $28.01, plan $0
  //   B2 claim 1  ADEFOVIR x30 $720.95: B2 $500 + $15 = $515.00, plan $205.95; deductible met
  const rest: Array<[string, string, DrugKey, string, Lands]> = [
    ['A1', wallets[0], 'ADEFOVIR', 'A1 claim 2 — crosses the deductible', 'crosses-deductible'],
    ['A1', wallets[0], 'ABIGALE', 'A1 claim 3 — copay only', 'copay-only'],
    ['A2', wallets[1], 'ABACAVIR', 'A2 claim 1 — inside the deductible', 'inside-deductible'],
    ['B1', wallets[2], 'ABACAVIR', 'B1 claim 1 — inside the deductible', 'inside-deductible'],
    ['B2', b2Wallet, 'ADEFOVIR', 'B2 claim 1 — crosses the deductible', 'crosses-deductible'],
  ];
  for (const [k, w, drugKey, label, lands] of rest) {
    if (!w) continue;
    await fileClaim(k, w, claimDrug(drugKey), label, { lands });
    await checkInvariant(label, enrolled);
  }

  await verifyAll(wallets[1], people);
}

async function verifyAll(credentialWallet: string, people: Person[]) {
  const t = main.t, http = main.http;
  // ── Independent verification ──
  t.begin('verifier', 'Claim inclusion proofs, audits and accumulators per member');
  await httpAdmin('POST', `${SEQ}/interactive/force-batch`, {});
  const rootNow = String((await rpc('l2_getClaimAccumulatorRoot')).result?.root);
  for (const m of Object.values(results.members) as any[]) {
    if (!m?.walletId) continue;
    const cbm = (await rpc('l2_getClaimsByMember', { walletId: m.walletId }, main.http, true)).result;
    const claims = (cbm?.claims ?? cbm ?? []) as any[];
    const mine = results.claims.filter((c: any) => c.walletId === m.walletId && c.adjudication);
    const listed = (c: any) => claims.some((ce: any) => String(ce.leaf?.patientPayCents) === String(c.adjudication.patientPayCents) && String(ce.leaf?.planPayCents) === String(c.adjudication.planPayCents));
    t.check(`${m.walletId.slice(0, 10)}…: every claim filed in this run is in the claims ledger`, mine.every(listed), mine.length, mine.filter(listed).length);
    for (const ce of claims) {
      const cp = (await rpc('l2_getClaimWithProof', { leafIndex: String(ce.leafIndex) }, main.http, true)).result;
      const leaf = cp.entry.leaf ?? cp.entry;
      let h = Poseidon.hash([leaf.memberWalletId, leaf.ndcHash, leaf.pharmacyWalletId, leaf.prescriberWalletId].map((v: string) => Field(BigInt(v)))
        .concat([Poseidon.hash([Field(BigInt(leaf.dateOfService))])], [leaf.patientPayCents, leaf.planPayCents, leaf.operationType, leaf.deductibleCreditCents].map((v: string) => Field(BigInt(v)))));
      const w = JSON.parse(cp.witnessJson);
      for (let i = 0; i < w.path.length; i++) h = w.isLeft[i] ? Poseidon.hash([h, Field(BigInt(w.path[i]))]) : Poseidon.hash([Field(BigInt(w.path[i])), h]);
      t.check(`Leaf ${ce.leafIndex}: recomputed root equals the claim root`, h.toString() === cp.root && cp.root === rootNow, rootNow, h.toString());
    }
    const recon = (await rpc('l2_reconstructAccumulator', { walletId: m.walletId }, main.http, true)).result;
    const eng = ((await httpAdmin('GET', `${SEQ}/interactive/state`)).json?.enrolledMembers ?? []).find((x: any) => x.walletId === m.walletId)?.accumulator;
    t.check(`${m.walletId.slice(0, 10)}…: accumulator rebuilt from the ledger = the engine's totals (what NFC recovery relies on)`,
      String(recon?.oopPaidCents) === String(eng?.oopPaidCents) && String(recon?.deductiblePaidCents) === String(eng?.deductiblePaidCents),
      { engineOop: eng?.oopPaidCents, engineDeductible: eng?.deductiblePaidCents }, { ledgerOop: String(recon?.oopPaidCents), ledgerDeductible: String(recon?.deductiblePaidCents), claims: String(recon?.claimCount) });
  }
  // The sequencer answers the duplicate check, whose groups name wallets, and the balance check the plan and the
  // operator only (D1), so the harness runs the audit checks as the operator; it ran them with no credential until
  // the review of round eight of the security fixes (2026-10-24).
  for (const mth of ['l2_verifyChainIntegrity', 'l2_verifyFinancialBalance', 'l2_detectDuplicateClaims']) {
    const a = (await rpc(mth, {}, main.http, true)).result;
    t.check(mth, !!a && (a.valid === true || a.balanced === true || (Array.isArray(a.duplicates) && a.duplicates.length === 0) || a.ok === true), 'pass', a);
  }

  t.begin('verifier', 'Verify every batch proof against keys compiled here; tampered copies must fail');
  const { StateTransitionProgram } = await import('../../src/engine/state-transition.js');
  const { BatchProgram } = await import('../../src/l2/batch-program.js');
  await StateTransitionProgram.compile();
  const { verificationKey } = await BatchProgram.compile();
  const batches = ((await rpc('l2_getAllBatches')).result?.batches ?? (await rpc('l2_getAllBatches')).result ?? []) as any[];
  let ok = 0, tested = 0;
  for (const b of batches) {
    const full = (await rpc('l2_getBatch', { batchNumber: String(b.batchNumber) }, quiet)).result;
    if (!full?.batchProofJson) continue;
    tested++;
    const pj = typeof full.batchProofJson === 'string' ? JSON.parse(full.batchProofJson) : full.batchProofJson;
    const good = await verify(pj, verificationKey);
    if (good) ok++;
    const bad = JSON.parse(JSON.stringify(pj));
    bad.publicOutput[0] = (BigInt(bad.publicOutput[0]) + 1n).toString();
    const badOk = await verify(bad, verificationKey);
    t.check(`Batch ${b.batchNumber} (${full.transitionCount ?? '?'} transitions) verifies; tampered copy rejected`, good && !badOk, 'verify true / tampered false', { good, badOk });
  }
  results.batches = { tested, verified: ok };
  t.check('Batch proofs verified', tested > 0 && ok === tested, `${tested}/${tested}`, `${ok}/${tested}`);

  t.begin('verifier', 'Portable credential for A2: the device proves its own (B1 step two, A-17)');
  const a2 = results.members.A2;
  const devCred = a2?.walletId ? await http('POST', `http://localhost:${a2.port}/credential/generate`, {}, a2.session ? { 'X-Device-Session': a2.session } : {}) : { status: 0, json: { error: 'A2 never enrolled' } };
  const credential = unwrap(devCred.json)?.credential;
  t.check('The device generated its own portable credential', devCred.status === 200 && !!credential?.proofJson, 'credential.proofJson', devCred.status === 200 ? 'present' : (unwrap(devCred.json) ?? devCred.json));
  if (credential?.proofJson) {
    const { CredentialProgram } = await import('../../src/credentials/credential-program.js');
    const { verifyCredentialOffline } = await import('../../src/credentials/portable-credential.js');
    const { ProofGateProgram } = await import('../../src/wallets/proof-gate.js');
    await ProofGateProgram.compile(); // CredentialProgram's proofs carry a ProofGate proof; o1js needs its key first
    await CredentialProgram.compile();
    t.check('Credential proof verifies offline', await verifyCredentialOffline(credential, ''), true, 'verify');
  }
  // A-34: the engine binds each member's family from the insurer's approval, which carries the employer's
  // opaque family hash from the enrollment code; the family ID itself stays on the employer's machine.
  t.begin('verifier', 'Families are bound from the employer codes');
  const familyHistory = async (key: string) => (await httpAdmin('GET', `${SEQ}/interactive/family-history?walletId=${results.members[key]?.walletId}`)).json;
  const head12 = (key: string) => String(results.members[key]?.walletId ?? '').slice(0, 12);
  const familyHeads = (f: any) => ((f?.members ?? []) as any[]).map((m) => String(m.walletId).slice(0, 12)).sort();
  const famA1 = await familyHistory('A1'), famA2 = await familyHistory('A2'), famB1 = await familyHistory('B1'), famB2 = await familyHistory('B2');
  const a1a2 = [head12('A1'), head12('A2')].sort();
  t.check('A1 and A2, one family on the roster, are one family on the engine', JSON.stringify(familyHeads(famA1)) === JSON.stringify(a1a2), a1a2, familyHeads(famA1));
  t.check('A2 sees the same family', famA2?.familyId === famA1?.familyId && JSON.stringify(familyHeads(famA2)) === JSON.stringify(a1a2), famA1?.familyId, famA2?.familyId);
  t.check('B1, a family of one, pools with no one', JSON.stringify(familyHeads(famB1)) === JSON.stringify([head12('B1')]), [head12('B1')], familyHeads(famB1));
  t.check('The engine holds opaque family hashes, one per family', [famA1, famB1, famB2].every((f) => /^\d+$/.test(String(f?.familyId ?? ''))) && new Set([famA1?.familyId, famB1?.familyId, famB2?.familyId]).size === 3, 'three distinct decimal hashes', [famA1?.familyId, famB1?.familyId, famB2?.familyId]);
  t.begin('verifier', 'Where do members\' secrets appear?');
  const sources: Array<[string, string]> = [['sequencer /interactive/state', (await http('GET', `${SEQ}/interactive/state`)).text]];
  const walk = (dir: string, label: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p2 = path.join(dir, f.name);
      if (f.isDirectory()) walk(p2, label);
      else if (fs.statSync(p2).size < 50_000_000) sources.push([`${label}: ${path.relative(REPO, p2)}`, fs.readFileSync(p2, 'utf8')]);
    }
  };
  walk(path.join(REPO, 'l2-data'), 'sequencer disk');
  if (NETWORK_LOG && fs.existsSync(NETWORK_LOG)) sources.push(['network log', fs.readFileSync(NETWORK_LOG, 'utf8')]);
  for (const p of people) {
    const m = results.members[p.key];
    if (!m) continue;
    const secrets: Record<string, string> = { firstName: p.firstName, lastName: p.lastName, dob: p.dob, cardholderId: p.employeeId, familyId: p.familyId, enrollmentKey: m.secrets.enrollmentKey, 'hash(enrollmentKey)': m.secrets.preimage[4] };
    const where: Record<string, string[]> = {};
    for (const [label, text] of sources) for (const h of findSecrets(text, secrets)) ((where[h.secret] ??= []).includes(label) || where[h.secret].push(label));
    m.secretLocations = where;
    for (const k of Object.keys(secrets)) t.check(`${p.key}: ${k} stays off the network`, !(where[k]?.length), 'not found', where[k] ?? 'not found');
  }

  for (const tr of traces) tr.end();
  const all = traces.flatMap(tr => tr.steps.flatMap(s => s.checks.map(c => ({ lane: path.basename(tr.outDir), step: s.title, ...c }))));
  results.summary = { checks: all.length, passed: all.filter(c => c.pass).length, failed: all.filter(c => !c.pass).map(c => `[${c.lane}] ${c.name}`) };
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\n${results.summary.passed}/${results.summary.checks} checks passed.`);
  for (const f of results.summary.failed) console.log('  FAIL', f);
}

// ─── Resume: claims + verification for members registered by an earlier run ───
async function resumeFromMembers(peopleTemplate: Person[], _planId: string) {
  const t = main.t, http = main.http;
  const dir = process.env.E2E_RESUME_DIR!;
  t.begin('harness', `Resume with the members registered by ${path.basename(dir)}`);
  const wallets: Record<string, string> = {};
  for (const tmpl of peopleTemplate) {
    const tr = JSON.parse(fs.readFileSync(path.join(dir, `member-${tmpl.key}`, 'trace.json'), 'utf8'));
    const ex = tr.steps.flatMap((st: any) => st.exchanges).find((x: any) => /derive-wallet/.test(x.url));
    const body = ex?.body ?? {};
    const p: Person = { ...tmpl, employeeId: body.cardholderId, firstName: body.firstName, lastName: body.lastName, dob: body.dateOfBirth };
    Object.assign(tmpl, p);
    const walletId = (ex?.response?.data ?? ex?.response)?.walletId as string;
    const stateDir = p.port === 4001 ? path.join(REPO, 'nautilus-data') : path.join(DEVICES, `member-${p.port}`);
    const ls = new NautilusLocalState(stateDir);
    await ls.unlock(p.pin);
    const dev = await ls.load();
    const enrollmentKey = ls.hasEnrollmentKey() ? ls.useEnrollmentKey(k => k) : '';
    t.check(`${p.key}: device still holds wallet ${walletId.slice(0, 10)}…`, dev?.walletId === walletId, walletId, dev?.walletId);
    // A5: the device's routes take a session; unlock over HTTP for one, as the live path did
    const unl = await http('POST', `http://localhost:${p.port}/onboarding/unlock`, { pin: p.pin });
    const session = (unwrap(unl.json)?.deviceSession ?? '') as string;
    results.members[p.key] = { employer: p.employer, port: p.port, session, walletId, secrets: { enrollmentKey, preimage: dev?.preimageFields ?? [] } };
    wallets[p.key] = walletId;
    // Is the member known to the adjudication engine? If not, send the same call the device makes.
    const st = (await httpAdmin('GET', `${SEQ}/interactive/state`)).json;
    if (!(st?.enrolledMembers ?? []).some((m: any) => m.walletId === walletId)) {
      results.findings.push({ id: `adjudication-registration-${p.key}`, severity: 'medium', title: 'Device registered on chain but not with the adjudication engine', evidence: `${p.key}: the credential mint lost the race 4 times during concurrent onboarding; the member node treats this step as non-critical and does not retry.` });
      t.note(`${p.key} is on chain but missing from the adjudication engine — re-sending /interactive/register-member as the device would`);
      await http('POST', `${SEQ}/interactive/register-member`, { walletId, preimageFields: dev?.preimageFields, displayName: `Member device ${p.port}` });
      const ok = await poll(quietAdmin, `${SEQ}/interactive/state`, j => (j?.enrolledMembers ?? []).some((m: any) => m.walletId === walletId), 600_000, 4000);
      t.check(`${p.key} registered with the adjudication engine after the retry`, !ok.timedOut, true, !ok.timedOut);
    }
  }
  const enrolled = Object.values(wallets);
  await checkInvariant('resume (4 members)', enrolled);

  const st = (await httpAdmin('GET', `${SEQ}/interactive/state`)).json;
  // Expected totals start from what the engine already holds for each member.
  for (const [k, w] of Object.entries(wallets)) {
    const m = (st?.enrolledMembers ?? []).find((x: any) => x.walletId === w);
    accState[k] = { deductiblePaidCents: BigInt(m?.accumulator?.deductiblePaidCents ?? 0), oopPaidCents: BigInt(m?.accumulator?.oopPaidCents ?? 0) };
  }
  t.note(`starting totals: ${JSON.stringify(Object.fromEntries(Object.entries(accState).map(([k, v]) => [k, { ded: v.deductiblePaidCents.toString(), oop: v.oopPaidCents.toString() }])))}`);
  // Named drugs at known NADAC prices (DRUGS above); none repeats a drug the same member took in the first run, so the
  // same-day duplicate rule does not apply. Plan-bound formularies: the members pay the copay of the plan they enrolled
  // into, the earlier run's, as it was published, whatever the drug's tier (this run's planId names a plan created a
  // moment ago, not theirs). Expected, from the totals the first run leaves (fee $10.00, copay $15):
  //   A1 claim 4  ABIGALE LO  x30 $34.51:  deductible met -> A1 $15.00, plan $19.51
  //   A2 claim 2  ADEFOVIR    x30 $720.95: $471.99 of A2's deductible left -> A2 $486.99, plan $233.96; deductible met
  //   A2 claim 3  ABIGALE     x30 $32.95:  A2 $15.00, plan $17.95
  //   B1 claim 2  ACAMPROSATE x30 $20.89:  inside B1's deductible -> B1 $20.89, plan $0
  //   B2 claim 2  ABIRTEGA    x30 $37.15:  deductible met -> B2 $15.00, plan $22.15
  const earlierPlanId = (st?.enrolledMembers ?? []).find((x: any) => x.walletId === wallets.A1)?.planId ?? _planId;
  const earlierPlan = (await rpc('l2_getPlan', { planId: earlierPlanId })).result;
  planCopayCents = BigInt(earlierPlan?.publishedTerms?.copayAmountCents ?? earlierPlan?.copayAmountCents ?? PLAN_COPAY_CENTS);
  t.note(`the members' plan ${earlierPlanId}: copay ${planCopayCents}¢`);
  formularyMeds = (st?.demoData?.medications ?? []) as any[];
  const plan: Array<[string, DrugKey, string, Lands]> = [
    ['A1', 'ABIGALE_LO', 'A1 claim 4 — deductible already met', 'copay-only'],
    ['A2', 'ADEFOVIR', 'A2 claim 2 — crosses the deductible', 'crosses-deductible'],
    ['A2', 'ABIGALE', 'A2 claim 3 — copay only', 'copay-only'],
    ['B1', 'ACAMPROSATE', 'B1 claim 2 — inside the deductible', 'inside-deductible'],
    ['B2', 'ABIRTEGA', 'B2 claim 2 — copay only', 'copay-only'],
  ];
  results.drugs = [];
  for (const [k, drugKey, label, lands] of plan) {
    const d = claimDrug(drugKey);
    results.drugs.push({ claim: label, drug: d.name, copayCents: d.copay.toString() });
    await fileClaim(k, wallets[k], d, `${label} (${d.name})`, { lands });
    await checkInvariant(label, enrolled);
  }
  // Deliberate duplicate: the same drug for B1 again on the same day.
  t.begin('pharmacy', 'Same drug, same member, same pharmacy, same day — a duplicate claim');
  const leavesBefore = Number((await rpc('l2_getClaimAccumulatorRoot')).result?.leafCount ?? 0);
  const dupAdj = await fileClaim('B1', wallets.B1, claimDrug('ACAMPROSATE'), 'B1 duplicate of claim 2', { expectRefusal: /duplicate/i });
  const leavesAfter = Number((await rpc('l2_getClaimAccumulatorRoot')).result?.leafCount ?? 0);
  main.t.check('A duplicate is either rejected before payment or recorded as a claim — never paid and dropped',
    !dupAdj || leavesAfter === leavesBefore + 1, 'rejected, or one new claim leaf', dupAdj ? `adjudicated (patient pays ${dupAdj.patientPayCents}) with ${leavesAfter - leavesBefore} new leaf` : 'rejected');
  await verifyAll(wallets[peopleTemplate[1].key], peopleTemplate);
}

mainFlow().then(() => process.exit(0)).catch(err => {
  console.error('\nHarness stopped:', err);
  try { for (const tr of traces) tr.end(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ...results, fatal: String(err?.stack || err) }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)); } catch { /* ignore */ }
  process.exit(1);
});
