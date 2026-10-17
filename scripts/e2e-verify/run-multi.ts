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
 *   Member devices: http://localhost:4001 (stateDir <repo>/nautilus-data) and 4011-4013
 *   (stateDir <devicesDir>/member-<port>).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Field, Poseidon, verify } from 'o1js';
import { Trace, makeHttp, poll, abbrev } from './trace.js';
import { expectedAdjudication, findSecrets } from './reference.js';
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
const bearer = { Authorization: `Bearer ${ADMIN}` };
const unwrap = (j: any) => (j && typeof j === 'object' && 'ok' in j && 'data' in j ? j.data : j);

fs.mkdirSync(OUT, { recursive: true });
const traces: Trace[] = [];
function lane(name: string) {
  const t = new Trace(path.join(OUT, name));
  traces.push(t);
  return { t, http: makeHttp(t) };
}
const quiet = makeHttp(new Trace(path.join(OUT, '_polls')));
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
    const ws = (await rpc('l2_getWalletWitnesses', { walletId: wid }, quiet)).result;
    const st = (await rpc('l2_getWalletState', { walletId: wid }, quiet)).result;
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
    ein: label === 'A' ? '12-3456789' : '98-7654321', state: 'WI', selectedPlanIds: [planId], effectiveDate: new Date().toISOString().slice(0, 10), enrollmentCap: 10, publicKeyHex,
  });
  const appId = unwrap(apply.json)?.applicationId;
  // A8: the activation code, shown once at submission, is what collects the credentials.
  const activationCode: string = unwrap(apply.json)?.activationCode ?? '';
  const claimSecret = activationCode.includes('.') ? activationCode.split('.').slice(1).join('.') : '';
  t.check('Application accepted', !!appId, 'applicationId', apply.json);
  const up = await fetch(`${INS}/marketplace/api/upload-document/${appId}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4\n% E2E placeholder (fictional)\n%%EOF\n') });
  t.check('IRS letter uploaded', up.status < 300, '2xx', up.status);
  const appr = await http('POST', `${INS}/employer-applications/${appId}/approve`, {}, bearer);
  t.check('Insurer approved with its own admin token', appr.status < 300, '2xx', appr.status);
  const agr = unwrap((await http('GET', `${INS}/marketplace/api/agreement/${appId}`)).json);
  const sig = crypto.sign(null, Buffer.from(`${agr?.canonicalMessage}|HR ${label}|Owner`, 'utf8'), privateKey).toString('hex');
  const sign = await http('POST', `${INS}/marketplace/api/sign/${appId}`, { employerSignature: sig, ts: agr?.ts, signerName: `HR ${label}`, signerTitle: 'Owner', reviewedAt: Date.now() });
  t.check('Agreement signed', sign.status < 300, '2xx', sign.status);
  await http('POST', `${INS}/marketplace/api/activate/${appId}`, {});
  const act = unwrap((await poll(quiet, `${INS}/marketplace/api/activate-status/${appId}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 300_000, 2000)).json);
  t.check('Employer node and HR Tool activated', act?.status === 'complete', 'complete', act?.status ?? act);
  t.check('The open status poll carries no admin token', !act?.adminToken, 'absent', act?.adminToken ?? 'absent');
  // A8: collect the admin token once, with the activation secret.
  const cred = unwrap((await http('POST', `${INS}/marketplace/api/activate-credentials/${appId}`, { claimSecret })).json);
  t.check('Admin credentials collected with the activation secret', Boolean(cred?.adminToken), 'token', cred?.adminToken ? 'present' : cred);
  act.employerNodeUrl = cred?.employerNodeUrl ?? act.employerNodeUrl;
  act.hrToolUrl = cred?.hrToolUrl ?? act.hrToolUrl;
  act.adminToken = cred?.adminToken;
  const groupId = `GRP-${label}-${RUN}`;
  const grp = await http('POST', `${act.employerNodeUrl}/groups`, { groupId, planId, effectiveDate: new Date().toISOString().slice(0, 10), enrollmentCap: 10 }, { Authorization: `Bearer ${act.adminToken}` });
  t.check('Group created', grp.status < 300, '2xx', grp.status);
  await http('POST', `${act.hrToolUrl}/api/unlock`, { passphrase: `hr-pass-${label}-${RUN}` });
  await http('POST', `${act.hrToolUrl}/api/group/select`, { groupId });
  const csv = ['employee_id,family_id,first_name,last_name,dob,email', ...people.map(p => `${p.employeeId},${p.familyId},${p.firstName},${p.lastName},${p.dob},${p.email}`)].join('\n');
  const imp = await http('POST', `${act.hrToolUrl}/api/import`, { csvContent: csv, validUntil: '2027-12-31', dryRun: false });
  t.check(`${people.length} employees imported`, (unwrap(imp.json)?.success ?? imp.json?.success) === people.length, people.length, imp.json);
  const tokens = (unwrap((await http('GET', `${act.hrToolUrl}/api/export/tokens`)).json)?.tokens ?? []) as any[];
  const byEmployee: Record<string, { tokenId: string; tokenPIN: string }> = {};
  for (const p of people) {
    // employeeIdHash is salted with the group's seed (known only to the HR Tool), so match on displayName.
    const tk = tokens.find(x => x.displayName === `${p.firstName} ${p.lastName[0]}.`);
    if (tk) { byEmployee[p.employeeId] = { tokenId: tk.tokenId, tokenPIN: tk.tokenPIN }; t.secret(`code for ${p.firstName}`, `${tk.tokenId} / PIN ${tk.tokenPIN}`); }
  }
  t.check('One enrollment code per employee', Object.keys(byEmployee).length === people.length, people.length, Object.keys(byEmployee).length);
  t.end();
  results.employers[label] = { employerId, appId, groupId, employerNodeUrl: act.employerNodeUrl, hrToolUrl: act.hrToolUrl };
  return { employerId, groupId, privateKey, byEmployee };
}

// ─── Members ────────────────────────────────────────────────
type Person = { key: string; employer: string; port: number; employeeId: string; familyId: string; firstName: string; lastName: string; dob: string; email: string; pin: string };

async function enrollMember(p: Person, token: { tokenId: string; tokenPIN: string }, groupId: string) {
  const { t, http } = lane(`member-${p.key}`);
  const MEM = `http://localhost:${p.port}`;
  const stateDir = p.port === 4001 ? path.join(REPO, 'nautilus-data') : path.join(DEVICES, `member-${p.port}`);
  t.begin(`member ${p.key}`, `Enroll ${p.firstName} ${p.lastName} on device :${p.port}`);
  t.secret('device PIN', p.pin);
  const ph0 = unwrap((await http('GET', `${MEM}/onboarding/status`)).json)?.phase;
  // A4: eject needs the PIN, proved at the moment of erasing.
  if (ph0 && ph0 !== 'awaiting_token' && ph0 !== 'locked') await http('POST', `${MEM}/onboarding/eject`, { pin: p.pin });
  t.check('Device unlocked', (await http('POST', `${MEM}/onboarding/unlock`, { pin: p.pin })).status < 300, '2xx', 'unlock');
  t.check('Code accepted', (await http('POST', `${MEM}/onboarding/accept-token`, { tokenId: token.tokenId })).status < 300, '2xx', 'accept-token');
  t.check('Enrollment key generated on the device', (await http('POST', `${MEM}/onboarding/generate-key`, {})).status < 300, '2xx', 'generate-key');
  const today = new Date().toISOString().slice(0, 10);
  const dw = await http('POST', `${MEM}/onboarding/derive-wallet`, {
    cardholderId: p.employeeId, dateOfBirth: p.dob, firstName: p.firstName, lastName: p.lastName,
    consentRecord: { phiDescription: 'Claim adjudication data', disclosingParty: 'Member', receivingParty: 'zpk.care network', purpose: 'E2E verification', expiration: '2027-12-31', signatureDate: today },
  });
  const walletId = unwrap(dw.json)?.walletId as string;
  t.check('Wallet derived', !!walletId, 'walletId', dw.json);
  const en = await http('POST', `${MEM}/onboarding/enroll`, { tokenPIN: token.tokenPIN });
  t.check('Insurer accepted the enrollment', en.status < 300, '2xx', en.json);
  const t0 = Date.now();
  await http('POST', `${MEM}/onboarding/compile`, {});
  await poll(quiet, `${MEM}/onboarding/status`, j => unwrap(j)?.phase === 'ready', 600_000, 3000);
  const reg = await http('POST', `${MEM}/proof/registration`, {});
  // The route may outlast the 30 s HTTP timeout; wait for the receipt and the adjudication registration.
  let registered = false;
  for (const start = Date.now(); Date.now() - start < 900_000;) {
    const rr = (await rpc('l2_getReceiptsByWallet', { walletId }, quiet)).result;
    const st = (await quiet('GET', `${SEQ}/interactive/state`)).json;
    const inAdj = (st?.enrolledMembers ?? []).some((m: any) => m.walletId === walletId);
    if ((rr?.receipts ?? rr ?? []).length > 0 && inAdj) { registered = true; break; }
    if (reg.status >= 400 && reg.status !== 504 && !/timeout/i.test(String(reg.json?.error ?? ''))) break;
    await new Promise(r => setTimeout(r, 4000));
  }
  const regMs = Date.now() - t0;
  t.check('Registration proof accepted and member registered with the adjudication engine', registered, true, registered ? `ok in ${regMs} ms` : reg.json);
  // Device secrets → independent wallet recomputation.
  const ls = new NautilusLocalState(stateDir);
  await ls.unlock(p.pin);
  const dev = await ls.load();
  const enrollmentKey = ls.hasEnrollmentKey() ? ls.useEnrollmentKey(k => k) : '';
  t.secret('enrollment key (device only)', enrollmentKey);
  t.check('Device state is this member', dev?.walletId === walletId, walletId, dev?.walletId);
  const pre = (dev?.preimageFields ?? []) as string[];
  const expected = [hashString(p.employeeId), hashDate(p.dob), hashString(p.firstName), hashString(p.lastName), hashString(enrollmentKey)].map(f => f.toString());
  t.check('Wallet inputs 1-5 recompute from the raw values', expected.every((v, i) => pre[i] === v), expected, pre.slice(0, 5));
  t.check('Wallet ID = Poseidon(0, the six device inputs)', Poseidon.hash([Field(0), ...pre.map(f => Field(BigInt(f)))]).toString() === walletId, walletId, 'recomputed');
  results.members[p.key] = { employer: p.employer, port: p.port, walletId, regMs, groupInput: pre[5], groupId, secrets: { enrollmentKey, preimage: pre } };
  t.end();
  return walletId;
}

// ─── Claims ─────────────────────────────────────────────────
const accState: Record<string, { deductiblePaidCents: bigint; oopPaidCents: bigint }> = {};
async function fileClaim(memberKey: string, walletId: string, ndcHash: string, copay: bigint, ingredient: bigint, fee: bigint, label: string) {
  const { t, http } = lane(`claim-${memberKey}-${results.claims.length + 1}`);
  t.begin(`claim ${memberKey}`, label);
  const rxId = `RX-${RUN}-${memberKey}-${results.claims.length + 1}`;
  const tp = Date.now();
  const sp = await http('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: 30, refills: 0, rxId });
  const isMine = (x: any) => x.id === rxId;
  let prescriptionId: string | undefined = sp.json?.prescriptionId;
  const stillRunning = sp.status === 504 || /timeout/i.test(String(sp.json?.error ?? ''));
  if (!prescriptionId && (!sp.json?.error || stillRunning)) {
    const f = await poll(quiet, `${SEQ}/interactive/state`, j => (j?.prescriptions ?? []).some((x: any) => isMine(x) && x.status === 'ADJUDICATED'), 900_000, 4000);
    prescriptionId = (f.json?.prescriptions ?? []).find(isMine)?.id;
  }
  const prescribeMs = Date.now() - tp;
  t.check('Prescription adjudicated', !!prescriptionId, 'prescriptionId', prescriptionId ?? sp.json);
  if (!prescriptionId) { t.end(); results.claims.push({ memberKey, label, error: sp.json }); return null; }
  await http('POST', `${PHA}/dispensing/mark-filled`, { prescriptionId });
  const tf = Date.now();
  const disp = await http('POST', `${PHA}/dispensing/dispense`, { prescriptionId, quantityDispensed: 30, ingredientCostCents: Number(ingredient), dispensingFeeCents: Number(fee) });
  let fill: any = unwrap(disp.json);
  if (disp.status < 300 && fill?.jobKey) fill = unwrap((await poll(quiet, `${PHA}/dispensing/fill-status?jobKey=${encodeURIComponent(fill.jobKey)}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 900_000, 4000)).json);
  const fillMs = Date.now() - tf;
  const r = fill?.result ?? fill;
  t.check('Fill adjudicated', !!r?.adjudication, 'adjudication', fill?.error ?? fill?.status);
  if (!r?.adjudication) { t.end(); results.claims.push({ memberKey, label, error: fill }); return null; }
  const adj = r.adjudication, before = r.accumulator.before, after = r.accumulator.after, limits = r.accumulator.limits;
  const acc = accState[memberKey] ?? { deductiblePaidCents: 0n, oopPaidCents: 0n };
  t.check("Accumulator before = this member's running total", BigInt(before.deductiblePaidCents) === acc.deductiblePaidCents && BigInt(before.oopPaidCents) === acc.oopPaidCents, acc, before);
  const exp = expectedAdjudication(ingredient, fee, copay, {
    deductibleAmountCents: BigInt(limits.deductibleAmountCents), deductiblePaidCents: acc.deductiblePaidCents,
    oopMaxCents: BigInt(limits.oopMaxCents), oopPaidCents: acc.oopPaidCents, annualBenefitMaxCents: BigInt(limits.annualBenefitMaxCents ?? 0), annualBenefitUsedCents: 0n,
  });
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
  const ready = await poll(quiet, `${SEQ}/interactive/state`, j => j?.compiled === true, 2_400_000, 10_000);
  t.check('All circuits compiled', ready.json?.compiled === true, true, ready.json?.compiled);
  await checkInvariant('boot (seed providers provisioned)', []);

  t.begin('insurer', 'Create the plan');
  const planId = `PLAN-E2E-${RUN}`;
  const plan = await http('POST', `${INS}/plans`, { planId, name: 'E2E Gold', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 800000, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000 }, bearer);
  t.check('Plan created with the insurer token', plan.status < 300, '2xx', plan.status);

  const people: Person[] = [
    { key: 'A1', employer: 'A', port: 4001, employeeId: `A1-${RUN}`, familyId: `FA1-${RUN}`, firstName: 'Avery', lastName: 'Quillfeather', dob: '19870412', email: 'a1@example.test', pin: '864209' },
    { key: 'A2', employer: 'A', port: 4011, employeeId: `A2-${RUN}`, familyId: `FA2-${RUN}`, firstName: 'Rowan', lastName: 'Ashgrove', dob: '19921103', email: 'a2@example.test', pin: '531907' },
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
  const listApps = await http('GET', `${INS}/employer-applications`, undefined, bearer);
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
  const wallets = await Promise.all(firstThree.map(p => enrollMember(p, token(p), group(p))));
  const enrolled: string[] = wallets.filter(Boolean);
  t.check('All three concurrent registrations succeeded', enrolled.length === 3, 3, enrolled.length);
  await checkInvariant('3 concurrent registrations', enrolled);

  // Drug choice.
  const st = (await http('GET', `${SEQ}/interactive/state`)).json;
  const med = (st?.demoData?.medications ?? []).find((m: any) => m.active !== false && !m.requiresPriorAuth && !m.stepTherapyRequired && !m.deaSchedule && (m.maxQuantityPerFill ?? 999) >= 30);
  const ndcHash = hashString(String(med.ndc).replace(/-/g, '')).toString();
  const copay = BigInt(med.currentCopayAmountCents ?? med.copayAmountCents);
  results.drug = { brandName: med.brandName, ndc: med.ndc, copayCents: copay.toString() };
  t.note(`drug ${med.brandName} ${med.strength}, copay ${copay}¢`);

  // B2 enrolls while A1's first claim is being adjudicated (registration vs. fill contention).
  t.begin('harness', "B2 enrolls while A1's first claim is adjudicated");
  const b2 = people[3];
  const [b2Wallet] = await Promise.all([
    enrollMember(b2, token(b2), group(b2)),
    fileClaim('A1', wallets[0], ndcHash, copay, 1200n, 200n, 'A1 claim 1 — inside the deductible'),
  ]);
  if (b2Wallet) enrolled.push(b2Wallet);
  t.check('B2 registered while a fill was in flight', !!b2Wallet, 'walletId', b2Wallet);
  await checkInvariant('registration during a fill', enrolled);

  // Remaining claims, invariant after each.
  const rest: Array<[string, string, bigint, bigint, string]> = [
    ['A1', wallets[0], 60000n, 200n, 'A1 claim 2 — crosses the deductible'],
    ['A1', wallets[0], 4500n, 200n, 'A1 claim 3 — copay only'],
    ['A2', wallets[1], 3000n, 200n, 'A2 claim 1'],
    ['B1', wallets[2], 900n, 200n, 'B1 claim 1'],
    ['B2', b2Wallet, 70000n, 200n, 'B2 claim 1 — crosses the deductible'],
  ];
  for (const [k, w, ing, fee, label] of rest) {
    if (!w) continue;
    await fileClaim(k, w, ndcHash, copay, ing, fee, label);
    await checkInvariant(label, enrolled);
  }

  await verifyAll(wallets[1], people);
}

async function verifyAll(credentialWallet: string, people: Person[]) {
  const t = main.t, http = main.http;
  // ── Independent verification ──
  t.begin('verifier', 'Claim inclusion proofs, audits and accumulators per member');
  await http('POST', `${SEQ}/interactive/force-batch`, {});
  const rootNow = String((await rpc('l2_getClaimAccumulatorRoot')).result?.root);
  for (const m of Object.values(results.members) as any[]) {
    const claims = ((await rpc('l2_getClaimsByMember', { walletId: m.walletId })).result ?? []) as any[];
    const mine = results.claims.filter((c: any) => c.walletId === m.walletId && c.adjudication);
    const listed = (c: any) => claims.some((ce: any) => String(ce.leaf?.patientPayCents) === String(c.adjudication.patientPayCents) && String(ce.leaf?.planPayCents) === String(c.adjudication.planPayCents));
    t.check(`${m.walletId.slice(0, 10)}…: every claim filed in this run is in the claims ledger`, mine.every(listed), mine.length, mine.filter(listed).length);
    for (const ce of claims) {
      const cp = (await rpc('l2_getClaimWithProof', { leafIndex: String(ce.leafIndex) })).result;
      const leaf = cp.entry.leaf ?? cp.entry;
      let h = Poseidon.hash([leaf.memberWalletId, leaf.ndcHash, leaf.pharmacyWalletId, leaf.prescriberWalletId].map((v: string) => Field(BigInt(v)))
        .concat([Poseidon.hash([Field(BigInt(leaf.dateOfService))])], [leaf.patientPayCents, leaf.planPayCents, leaf.operationType, leaf.deductibleCreditCents].map((v: string) => Field(BigInt(v)))));
      const w = JSON.parse(cp.witnessJson);
      for (let i = 0; i < w.path.length; i++) h = w.isLeft[i] ? Poseidon.hash([h, Field(BigInt(w.path[i]))]) : Poseidon.hash([Field(BigInt(w.path[i])), h]);
      t.check(`Leaf ${ce.leafIndex}: recomputed root equals the claim root`, h.toString() === cp.root && cp.root === rootNow, rootNow, h.toString());
    }
    const recon = (await rpc('l2_reconstructAccumulator', { walletId: m.walletId })).result;
    const eng = ((await http('GET', `${SEQ}/interactive/state`)).json?.enrolledMembers ?? []).find((x: any) => x.walletId === m.walletId)?.accumulator;
    t.check(`${m.walletId.slice(0, 10)}…: accumulator rebuilt from the ledger = the engine's totals (what NFC recovery relies on)`,
      String(recon?.oopPaidCents) === String(eng?.oopPaidCents) && String(recon?.deductiblePaidCents) === String(eng?.deductiblePaidCents),
      { engineOop: eng?.oopPaidCents, engineDeductible: eng?.deductiblePaidCents }, { ledgerOop: String(recon?.oopPaidCents), ledgerDeductible: String(recon?.deductiblePaidCents), claims: String(recon?.claimCount) });
  }
  for (const mth of ['l2_verifyChainIntegrity', 'l2_verifyFinancialBalance', 'l2_detectDuplicateClaims']) {
    const a = (await rpc(mth)).result;
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

  t.begin('verifier', 'Portable credential for A2 verifies offline');
  await http('POST', `${SEQ}/interactive/generate-credential`, { walletId: credentialWallet });
  const cred = (await poll(quiet, `${SEQ}/interactive/credential-status?walletId=${encodeURIComponent(credentialWallet)}`, j => ['complete', 'error'].includes(j?.status), 900_000, 5000)).json;
  const credential = cred?.credential ?? cred?.result?.credential;
  if (credential?.proofJson) {
    const { CredentialProgram } = await import('../../src/credentials/credential-program.js');
    const { verifyCredentialOffline } = await import('../../src/credentials/portable-credential.js');
    await CredentialProgram.compile();
    t.check('Credential proof verifies offline', await verifyCredentialOffline(credential, ''), true, 'verify');
  } else t.check('Credential generated', false, 'proofJson', cred);

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
    const secrets: Record<string, string> = { firstName: p.firstName, lastName: p.lastName, dob: p.dob, cardholderId: p.employeeId, enrollmentKey: m.secrets.enrollmentKey, 'hash(enrollmentKey)': m.secrets.preimage[4] };
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
    results.members[p.key] = { employer: p.employer, port: p.port, walletId, secrets: { enrollmentKey, preimage: dev?.preimageFields ?? [] } };
    wallets[p.key] = walletId;
    // Is the member known to the adjudication engine? If not, send the same call the device makes.
    const st = (await http('GET', `${SEQ}/interactive/state`)).json;
    if (!(st?.enrolledMembers ?? []).some((m: any) => m.walletId === walletId)) {
      results.findings.push({ id: `adjudication-registration-${p.key}`, severity: 'medium', title: 'Device registered on chain but not with the adjudication engine', evidence: `${p.key}: the credential mint lost the race 4 times during concurrent onboarding; the member node treats this step as non-critical and does not retry.` });
      t.note(`${p.key} is on chain but missing from the adjudication engine — re-sending /interactive/register-member as the device would`);
      await http('POST', `${SEQ}/interactive/register-member`, { walletId, preimageFields: dev?.preimageFields, displayName: `Member device ${p.port}` });
      const ok = await poll(quiet, `${SEQ}/interactive/state`, j => (j?.enrolledMembers ?? []).some((m: any) => m.walletId === walletId), 600_000, 4000);
      t.check(`${p.key} registered with the adjudication engine after the retry`, !ok.timedOut, true, !ok.timedOut);
    }
  }
  const enrolled = Object.values(wallets);
  await checkInvariant('resume (4 members)', enrolled);

  const st = (await http('GET', `${SEQ}/interactive/state`)).json;
  // Expected totals start from what the engine already holds for each member.
  for (const [k, w] of Object.entries(wallets)) {
    const m = (st?.enrolledMembers ?? []).find((x: any) => x.walletId === w);
    accState[k] = { deductiblePaidCents: BigInt(m?.accumulator?.deductiblePaidCents ?? 0), oopPaidCents: BigInt(m?.accumulator?.oopPaidCents ?? 0) };
  }
  t.note(`starting totals: ${JSON.stringify(Object.fromEntries(Object.entries(accState).map(([k, v]) => [k, { ded: v.deductiblePaidCents.toString(), oop: v.oopPaidCents.toString() }])))}`);
  // A different covered drug for each claim, so the same-day duplicate rule doesn't apply.
  const meds = (st?.demoData?.medications ?? []).filter((m: any) => m.active !== false && !m.requiresPriorAuth && !m.stepTherapyRequired && !m.deaSchedule && (m.maxQuantityPerFill ?? 999) >= 30);
  let mi = 5;   // skip the drug used by the earlier claims
  const nextDrug = () => { const m = meds[mi++ % meds.length]; return { ndcHash: hashString(String(m.ndc).replace(/-/g, '')).toString(), copay: BigInt(m.currentCopayAmountCents ?? m.copayAmountCents), name: `${m.brandName} ${m.strength}` }; };
  const plan: Array<[string, bigint, bigint, string]> = [
    ['A1', 1500n, 200n, 'A1 claim 4 — deductible already met'],
    ['A2', 52000n, 200n, 'A2 claim 2 — crosses the deductible'],
    ['A2', 2500n, 200n, 'A2 claim 3 — copay only'],
    ['B1', 800n, 200n, 'B1 claim 2'],
    ['B2', 3600n, 200n, 'B2 claim 2 — copay only'],
  ];
  results.drugs = [];
  for (const [k, ing, fee, label] of plan) {
    const d = nextDrug();
    results.drugs.push({ claim: label, drug: d.name, copayCents: d.copay.toString() });
    await fileClaim(k, wallets[k], d.ndcHash, d.copay, ing, fee, `${label} (${d.name})`);
    await checkInvariant(label, enrolled);
  }
  // Deliberate duplicate: the same drug for B1 again on the same day.
  t.begin('pharmacy', 'Same drug, same member, same pharmacy, same day — a duplicate claim');
  const dup = results.drugs[3];
  const dupMed = meds.find((m: any) => `${m.brandName} ${m.strength}` === dup.drug);
  const leavesBefore = Number((await rpc('l2_getClaimAccumulatorRoot')).result?.leafCount ?? 0);
  const dupAdj = await fileClaim('B1', wallets.B1, hashString(String(dupMed.ndc).replace(/-/g, '')).toString(), BigInt(dup.copayCents), 800n, 200n, 'B1 duplicate of claim 2');
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
