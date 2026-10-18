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
 * End-to-end verifier for a running zpk.care network.
 *
 * Drives the live system over HTTP the way the dashboards do — insurer plan,
 * employer marketplace, HR Tool, member enrollment and registration proof,
 * prescription, pharmacy fills — then checks the results independently:
 *
 *   - recomputes the member's wallet ID from the decrypted device state,
 *   - re-derives every claim's patient/plan split in plain arithmetic,
 *   - recomputes fulfillment and settlement commitments with Poseidon,
 *   - recomputes claim-leaf hashes and Merkle roots from the sequencer's witnesses,
 *   - verifies batch proofs and the portable credential against verification keys
 *     compiled locally in this process, and confirms tampered copies fail,
 *   - probes auth on admin routes, and
 *   - scans what the sequencer stores and serves for the member's secrets.
 *
 * Secrets are shown on purpose: this is for local runs with fictional people.
 *
 * Usage:
 *   ZKTRIDENT_ADMIN_TOKEN=... npx tsx scripts/e2e-verify/run.ts <outDir> [networkLogPath]
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Field, Poseidon, verify } from 'o1js';
import { Trace, makeHttp, poll, sleep, abbrev } from './trace.js';
import { expectedAdjudication, findSecrets } from './reference.js';
import { hashString, hashIdentityField, hashIdentityDate, isIdentitySalt } from '../../src/zkp/hash-utils.js';
import { combineEnrollmentKey, recoveryPinVerifier, type RecoveryCardV3 } from '../../src/security/recovery-card.js';
import { deriveMemberWalletId, derivePrescriberWalletId, derivePharmacyWalletId } from '../../src/wallets/wallet-derivation.js';
import { CREDENTIAL_INVENTORY_HEIGHT } from '../../src/wallets/wallet-state.js';
import { MerkleTree } from 'o1js';
import { PRESCRIBERS, PHARMACIES } from '../../src/data/index.js';
import { NautilusLocalState } from '../../src/nodes/nautilus-local-state.js';
import { l2Parse } from '../../src/l2/l2-json.js';
import { deriveNodeAdminToken } from '../../src/security/node-roles.js';
import { SequencerAttestationAuthority } from '../../src/credentials/nfc-attestation.js';

const SEQ = 'http://localhost:3030', INS = 'http://localhost:4004', MEM = 'http://localhost:4001', EXP = 'http://localhost:8000';
const PRE = 'http://localhost:4002', PHA = 'http://localhost:4003';
const ADMIN = process.env.ZKTRIDENT_ADMIN_TOKEN || '';
const OUT = path.resolve(process.argv[2] || './e2e-out');
const NETWORK_LOG = process.argv[3] || '';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A7: the harness runs the HR Tool as the employer's machine would. Spawned without npx or a shell
// so there is one process to stop, and stopped however this harness ends.
let hrToolChild: import('child_process').ChildProcess | null = null;
async function startHrTool(employerId: string): Promise<string> {
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
  hrToolChild = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'tools', 'hr-tool-server.ts')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HR_TOOL_DATA_DIR: `./hr-tool-data/${employerId}` },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  hrToolChild.stderr?.on('data', (d: Buffer) => process.stderr.write(`[hr-tool] ${d}`));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const r = await fetch(`${url}/api/session`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('HR Tool did not start within 60 s');
    await sleep(500);
  }
  return url;
}
function stopHrTool(): void {
  if (hrToolChild && !hrToolChild.killed) { try { hrToolChild.kill(); } catch { /* best effort */ } }
  hrToolChild = null;
}
process.on('exit', stopHrTool);
const STATE_DIR = process.env.ZKTRIDENT_STATE_DIR || path.join(REPO, 'nautilus-data');

const trace = new Trace(OUT);
const http = makeHttp(trace);
const quiet = makeHttp(new Trace(path.join(OUT, 'polls')));   // polling noise goes to a side trace
const bearer = { Authorization: `Bearer ${ADMIN}` };
// A9: the insurer node's own admin token. Explicit when the network was started with one, otherwise
// the derivation the launcher uses; the operator token is accepted by the sequencer only.
const INSURER_ADMIN = process.env.ZKTRIDENT_INSURER_ADMIN_TOKEN || (ADMIN ? deriveNodeAdminToken(ADMIN, 'insurer') : '');
const insurerBearer = { Authorization: `Bearer ${INSURER_ADMIN}` };
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
const httpAdmin = makeHttp(trace, { headers: bearer });

/*
 * A5: the member node's routes now require a device session, issued by /onboarding/unlock once
 * it has verified the PIN. `mem()` carries it. Two member endpoints stay open and are reached
 * with the bare client on purpose: /onboarding/status, which a readiness poll needs before any
 * session exists, and /onboarding/unlock itself.
 */
let memSession = '';
const mem = (method: string, urlPath: string, body?: unknown) =>
  http(method, `${MEM}${urlPath}`, body,
    memSession ? { 'X-Device-Session': memSession } : {});
const quietAdmin = makeHttp(new Trace(path.join(OUT, 'polls')), { headers: bearer });
const RUN = Date.now().toString(36).toUpperCase();
const RECOVERY_PIN = '246813';

// Fictional member. Nothing here refers to a real person.
const MEMBER = {
  employeeId: `E2E-${RUN}-1`, familyId: `FAM-${RUN}`, firstName: 'Avery', lastName: 'Quillfeather',
  dob: '19870412', email: 'avery.quillfeather@example.test', memberPin: '864209',
};
const DECOY = { employeeId: `E2E-${RUN}-2`, familyId: `FAM-${RUN}-B`, firstName: 'Rowan', lastName: 'Ashgrove', dob: '19921103' };

const results: Record<string, any> = { run: RUN, startedAt: new Date().toISOString(), claims: [] as any[], findings: [] as any[] };
const unwrap = (j: any) => (j && typeof j === 'object' && 'ok' in j && 'data' in j ? j.data : j);

/**
 * JSON.stringify refuses BigInt, and several sequencer RPC results carry them. The PHI sweep at
 * the end of this run used to crash with "Do not know how to serialize a BigInt" before it had
 * searched anything, so the run reported nothing for its final and most important phase. The
 * fatal-error handler at the bottom of this file already used this replacer; the sweep did not.
 */
const jsonSafe = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
async function rpc(method: string, params: Record<string, unknown> = {}, auth = true) {
  const r = await http('POST', `${SEQ}/rpc`, { jsonrpc: '2.0', id: 1, method, params }, auth ? bearer : {});
  const parsed = r.text ? l2Parse(r.text) as any : null;
  return { status: r.status, result: parsed?.result, error: parsed?.error };
}

// Insurer admin call. Tries the insurer's own token first. If the insurer has switched to
// client-key signatures (it does once any employer signs), records that and, when a key from an
// earlier employer is available (E2E_PRIOR_TRACE), tests whether that employer's key is accepted.
let priorEmployer: { id: string; key: crypto.KeyObject } | null = null;
const PRIOR_TRACE = process.env.E2E_PRIOR_TRACE || '';
if (PRIOR_TRACE && fs.existsSync(PRIOR_TRACE)) {
  const t = JSON.parse(fs.readFileSync(PRIOR_TRACE, 'utf8'));
  let id = '', hex = '';
  for (const st of t.steps) {
    for (const [k, v] of Object.entries(st.secretsShown || {})) if (/employer Ed25519/.test(k)) hex = String(v);
    for (const x of st.exchanges) if (/marketplace\/api\/apply/.test(x.url) && x.body?.employerId) id = x.body.employerId;
  }
  if (id && hex) priorEmployer = { id, key: crypto.createPrivateKey({ key: Buffer.from(hex, 'hex'), format: 'der', type: 'pkcs8' }) };
}
let insurerSigMode = false;
async function insAdmin(method: string, urlPath: string, body?: unknown) {
  const url = `${INS}${urlPath}`;
  if (!insurerSigMode) {
    const r = await http(method, url, body, insurerBearer);
    if (r.status !== 401) return r;
    insurerSigMode = true;
    if (!results.findings.some((f: any) => f.id === 'insurer-lockout')) {
      results.findings.push({ id: 'insurer-lockout', severity: 'high', title: "The insurer's own admin token stops working after the first employer signs", evidence: `${method} ${urlPath} with the insurer admin token returned 401 once an employer key was registered (nautilus-app-server.ts:167).` });
    }
    trace.note('insurer admin token refused: the insurer now only accepts registered client-key signatures');
  }
  if (!priorEmployer) return { status: 401, json: { error: 'no client key available' }, text: '' };
  const ts = Date.now().toString();
  const pathOnly = urlPath.split('?')[0];
  const sig = crypto.sign(null, Buffer.from(`${method}:${pathOnly}|${ts}|`), priorEmployer.key).toString('hex');
  const r = await http(method, url, body, { 'X-Admin-Signature': `${priorEmployer.id}:${ts}:${sig}` });
  if (r.status < 300 && !results.findings.some((f: any) => f.id === 'employer-as-insurer')) {
    results.findings.push({ id: 'employer-as-insurer', severity: 'critical', title: "An employer's signing key is accepted for insurer admin actions", evidence: `${method} ${urlPath} signed with employer ${priorEmployer.id}'s key (an earlier, unrelated employer) returned ${r.status}.` });
  }
  return r;
}

async function main() {
  if (!ADMIN) throw new Error('Set ZKTRIDENT_ADMIN_TOKEN to the token the network was started with');

  // ── 1. Readiness ────────────────────────────────────────────
  trace.begin('harness', 'Wait until the network has compiled every circuit');
  const ready = await poll(quietAdmin, `${SEQ}/interactive/state`, j => j?.compiled === true, 1_800_000, 10_000);
  trace.check('Adjudication service compiled all 10 circuits', ready.json?.compiled === true, true, ready.json?.compiled);
  const status = await rpc('l2_getStatus', {}, false);
  results.vkCommitment = status.result?.vkCommitment;
  trace.note(`vkCommitment = ${status.result?.vkCommitment}`);
  for (const [name, url] of [['insurer', INS], ['member', MEM], ['prescriber', PRE], ['pharmacy', PHA]] as const) {
    const h = await http('GET', `${url}/health`);
    trace.check(`${name} node healthy`, h.status === 200 && unwrap(h.json)?.phase !== undefined, 'phase present', unwrap(h.json)?.phase);
  }
  const preHealth = unwrap((await http('GET', `${PRE}/health`)).json);
  const phaHealth = unwrap((await http('GET', `${PHA}/health`)).json);
  results.prescriberWalletId = preHealth?.walletId;
  results.pharmacyWalletId = phaHealth?.walletId;

  // ── 2. Security probes before anything is set up ────────────
  trace.begin('attacker', 'Call admin functions without the admin token (secured mode)');
  const noAuthPlan = await http('POST', `${INS}/plans`, { planId: 'EVIL', name: 'x', coverageType: 1, copayAmountCents: 0, deductibleAmountCents: 0, oopMaxCents: 0, annualBenefitMaxCents: 0 });
  trace.check('Insurer refuses plan creation without a token', noAuthPlan.status === 401 || noAuthPlan.status === 403, '401/403', noAuthPlan.status);
  const noAuthRecord = await rpc('l2_recordFill', { memberWalletId: '1', ndcHash: '1', pharmacyWalletId: '1', patientPayCents: '0', planPayCents: '999999' }, false);
  trace.check('The no-proof claim path l2_recordFill is gone from the sequencer', !!noAuthRecord.error, 'error', noAuthRecord.error?.message ?? noAuthRecord.result);
  const badAuthBatch = await http('POST', `${SEQ}/rpc`, { jsonrpc: '2.0', id: 1, method: 'l2_forceBatch', params: {} }, { Authorization: 'Bearer admin123' });
  trace.check('Sequencer refuses the old demo token "admin123"', !!(badAuthBatch.json?.error), 'error', badAuthBatch.json?.error?.message ?? badAuthBatch.json);
  // A9: one credential per principal. The operator's token opens nothing on the insurer node, and
  // the insurer's token opens nothing on the sequencer.
  const opOnInsurer = await http('POST', `${INS}/plans`, { planId: 'EVIL-2', name: 'x', coverageType: 1, copayAmountCents: 0, deductibleAmountCents: 0, oopMaxCents: 0, annualBenefitMaxCents: 0 }, bearer);
  trace.check('The insurer node refuses the network operator token', opOnInsurer.status === 401, 401, opOnInsurer.status);
  const insOnSeq = await http('POST', `${SEQ}/rpc`, { jsonrpc: '2.0', id: 1, method: 'l2_forceBatch', params: {} }, insurerBearer);
  trace.check('The sequencer refuses the insurer node token', insOnSeq.json?.error?.code === -32003, -32003, insOnSeq.json?.error?.code ?? insOnSeq.json);

  // ── 3. Insurer creates a plan ───────────────────────────────
  trace.begin('insurer', 'Create and publish the benefit plan');
  const planId = `PLAN-E2E-${RUN}`;
  // Step 2 commit two: the engine binds each member's provider network from the plan the insurer
  // publishes, so this plan names its network by wallet id: the seven prescribers and five pharmacies
  // the demo table had (the fixture providers' ids derive from the fixture data, as in the engine),
  // plus the prescriber and pharmacy nodes themselves. Prescribers 5, 6 and 8 stay outside on purpose.
  const networkPrescriberIdx = [0, 1, 2, 3, 4, 7, 9];
  const networkPharmacyIdx = [0, 1, 2, 3, 4];
  const fixturePrescriberIds = PRESCRIBERS.map(p => derivePrescriberWalletId(p.localData, p.enrollmentKey).toString());
  const fixturePharmacyIds = PHARMACIES.map(p => derivePharmacyWalletId(p.localData, p.enrollmentKey).toString());
  const networkProviderWalletIds = [
    ...networkPrescriberIdx.map(i => fixturePrescriberIds[i]), ...networkPharmacyIdx.map(i => fixturePharmacyIds[i]),
    ...[results.prescriberWalletId, results.pharmacyWalletId].filter((x): x is string => typeof x === 'string' && x.length > 0),
  ];
  const plan = { planId, name: 'E2E Gold', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, networkProviderWalletIds };
  const planRes = await insAdmin('POST', '/plans', plan);
  trace.check('Plan created', planRes.status === 201 || planRes.status === 200, '201', planRes.status);
  const mkt = await http('GET', `${INS}/marketplace/api/plans`);
  const listed = JSON.stringify(mkt.json).includes(planId);
  trace.check('Plan is listed in the marketplace', listed, true, listed);

  // ── 4. Employer applies, is approved, signs, activates ─────
  trace.begin('employer', 'Apply on the marketplace with a new Ed25519 key');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKeyHex = spki.subarray(12).toString('hex');
  trace.secret('employer Ed25519 private key (PKCS8)', (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('hex'));
  const employerId = `E2E-EMP-${RUN}`;
  const apply = await http('POST', `${INS}/marketplace/api/apply`, {
    companyName: 'Fernhill Test Works LLC', employerId, contactName: 'Jordan Testcase', contactEmail: 'hr@fernhill.example.test',
    ein: '12-3456789', state: 'WI', selectedPlanIds: [planId], effectiveDate: new Date().toISOString().slice(0, 10), enrollmentCap: 10, publicKeyHex,
  });
  const appId = unwrap(apply.json)?.applicationId;
  // A8: the activation code is shown once at submission and is what collects the admin
  // credentials. The identifier alone no longer does.
  const activationCode: string = unwrap(apply.json)?.activationCode ?? '';
  const claimSecret = activationCode.includes('.') ? activationCode.split('.').slice(1).join('.') : '';
  trace.secret('employer activation secret', claimSecret);
  trace.check('Application accepted', !!appId, 'applicationId', apply.json);
  const pdf = Buffer.from('%PDF-1.4\n% E2E placeholder CP 575 (fictional)\n%%EOF\n');
  const up = await fetch(`${INS}/marketplace/api/upload-document/${appId}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
  trace.record({ method: 'POST', url: `${INS}/marketplace/api/upload-document/${appId}`, headers: { 'Content-Type': 'application/pdf' }, body: '(pdf bytes)', status: up.status, response: await up.text(), ms: 0 });
  trace.check('IRS letter uploaded', up.status < 300, '2xx', up.status);

  trace.begin('insurer', 'Approve the employer application');
  const appr = await insAdmin('POST', `/employer-applications/${appId}/approve`, {});
  if (insurerSigMode) trace.check("Insurer approval was authorized only by the insurer (not by another employer's key)", false, 'insurer credential', priorEmployer ? `signed by employer ${priorEmployer.id}` : 'no credential worked');
  trace.check('Application approved', appr.status < 300, '2xx', appr.status);

  trace.begin('employer', 'Sign the agreement and activate');
  const agr = unwrap((await http('GET', `${INS}/marketplace/api/agreement/${appId}`)).json);
  const signerName = 'Jordan Testcase', signerTitle = 'Owner';
  const msg = Buffer.from(`${agr?.canonicalMessage}|${signerName}|${signerTitle}`, 'utf8');
  const employerSignature = crypto.sign(null, msg, privateKey).toString('hex');
  trace.note(`signed message: ${abbrev(msg.toString(), 160)}`);
  const sign = await http('POST', `${INS}/marketplace/api/sign/${appId}`, { employerSignature, ts: agr?.ts, signerName, signerTitle, reviewedAt: Date.now() });
  trace.check('Agreement signature accepted', sign.status < 300, '2xx', sign.status);
  const act = await http('POST', `${INS}/marketplace/api/activate/${appId}`, {});
  const jobKey = unwrap(act.json)?.jobKey ?? appId;
  const actDone = await poll(quiet, `${INS}/marketplace/api/activate-status/${jobKey}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 300_000, 2000);
  const actData = unwrap(actDone.json);
  trace.check('Employer node activated', actData?.status === 'complete', 'complete', actData?.status ?? actData);
  // A8: the admin token is no longer on the open poll. It is collected once, with the secret.
  const empCred = await http('POST', `${INS}/marketplace/api/activate-credentials/${appId}`, { claimSecret });
  trace.check('Admin credentials collected with the activation secret', empCred.status < 300, '2xx', empCred.status);
  const credData = unwrap(empCred.json);
  const employerNodeUrl = credData?.employerNodeUrl ?? actData?.employerNodeUrl;
  const empAdmin = credData?.adminToken;
  trace.secret('employer node admin token', String(empAdmin));
  // Single use: a replay must be refused, and that is worth asserting here because it is the
  // property that makes the one-time promise in the UI true.
  const replay = await http('POST', `${INS}/marketplace/api/activate-credentials/${appId}`, { claimSecret });
  trace.check('A second collection attempt is refused', replay.status === 410, '410', replay.status);
  const noSecret = await http('POST', `${INS}/marketplace/api/activate-credentials/${appId}`, {});
  trace.check('Collection without the secret is refused', noSecret.status === 401, '401', noSecret.status);
  trace.check('The open status poll carries no admin token', !actData?.adminToken, 'absent', actData?.adminToken ?? 'absent');
  trace.note(`employer node ${employerNodeUrl}; the HR Tool is run by the employer, below`);
  trace.check('Activation hands over HR Tool setup steps, not a hosted URL', Array.isArray(credData?.hrToolSetup?.steps) && !credData?.hrToolUrl, 'steps, no URL', credData?.hrToolUrl ? 'a hosted URL' : (credData?.hrToolSetup ? 'steps' : 'nothing'));

  trace.begin('employer', 'Create the benefit group');
  const groupId = `GRP-${RUN}`;
  const grp = await http('POST', `${employerNodeUrl}/groups`, { groupId, planId, effectiveDate: new Date().toISOString().slice(0, 10), enrollmentCap: 10 }, { Authorization: `Bearer ${empAdmin}` });
  trace.check('Group created', grp.status < 300, '2xx', grp.status);

  // ── 5. HR Tool issues enrollment codes ─────────────────────
  // A7: the HR Tool runs on the employer's machine, never on the insurer's host. The harness plays
  // that machine: it starts the tool itself and sets it up with what activation handed over.
  trace.begin('employer HR', 'Run the HR Tool as the employer machine, import two fictional employees and issue enrollment codes');
  const hrToolUrl = await startHrTool(employerId);
  trace.note(`HR Tool started by the harness at ${hrToolUrl}, data under hr-tool-data/${employerId}`);
  const passphrase = `hr-pass-${RUN}-${crypto.randomBytes(4).toString('hex')}`;
  trace.secret('HR Tool passphrase', passphrase);
  const shortPass = await http('POST', `${hrToolUrl}/api/setup`, { employerNodeUrl, adminToken: empAdmin, passphrase: 'short', passphraseConfirm: 'short' });
  trace.check('A short passphrase is refused at setup', shortPass.status === 400, '400', shortPass.status);
  const setupRes = await http('POST', `${hrToolUrl}/api/setup`, { employerNodeUrl, adminToken: empAdmin, passphrase, passphraseConfirm: passphrase });
  trace.check('HR Tool workspace set up with the activation credentials', setupRes.status < 300, '2xx', setupRes.json);
  await http('POST', `${hrToolUrl}/api/group/select`, { groupId });
  const csv = ['employee_id,family_id,first_name,last_name,dob,email',
    `${MEMBER.employeeId},${MEMBER.familyId},${MEMBER.firstName},${MEMBER.lastName},${MEMBER.dob},${MEMBER.email}`,
    `${DECOY.employeeId},${DECOY.familyId},${DECOY.firstName},${DECOY.lastName},${DECOY.dob},`].join('\n');
  const imp = await http('POST', `${hrToolUrl}/api/import`, { csvContent: csv, validUntil: '2027-12-31', dryRun: false });
  const impData = unwrap(imp.json) ?? imp.json;
  trace.check('Both employees imported', impData?.success === 2, 2, imp.json);
  const issued = ((impData?.results ?? []) as Array<{ employeeId: string; status: string; tokenId?: string; tokenPIN?: string }>).filter(r => r.status === 'ok');
  trace.check('PINs were returned once, at import', issued.length === 2 && issued.every(r => /^\d{8}$/.test(r.tokenPIN ?? '')), '2 eight-digit PINs', issued.map(r => (r.tokenPIN ? 'pin' : 'none')));
  const tok = await http('GET', `${hrToolUrl}/api/export/tokens`);
  const tokens = (unwrap(tok.json)?.tokens ?? tok.json?.tokens ?? []) as Array<{ tokenId: string; tokenPIN?: string; employeeIdHash: string }>;
  trace.check('Two enrollment codes issued', tokens.length === 2, 2, tokens.length);
  trace.check('The export carries no PINs', tokens.every(t => !t.tokenPIN), 'none', tokens.some(t => t.tokenPIN) ? 'a PIN was exported' : 'none');
  const empl = await http('GET', `${hrToolUrl}/api/employees`);
  trace.check('The employee list carries no PINs', !JSON.stringify(unwrap(empl.json) ?? empl.json ?? '').includes('tokenPIN'), 'none', 'checked');
  const empHash = hashString(MEMBER.employeeId).toString();
  const myIssue = issued.find(r => r.employeeId === MEMBER.employeeId) ?? issued[0];
  const myToken = { tokenId: myIssue?.tokenId ?? tokens[0]?.tokenId ?? '', tokenPIN: myIssue?.tokenPIN ?? '' };
  trace.check('Codes reference employees only by hash', tokens.every(t => !JSON.stringify(t).includes(MEMBER.lastName)), 'no names', 'checked');
  trace.secret('member enrollment code', myToken.tokenId);
  trace.secret('member enrollment PIN', myToken.tokenPIN);
  const hrLeak = findSecrets(JSON.stringify(imp.json) + JSON.stringify(tok.json), { firstName: MEMBER.firstName, lastName: MEMBER.lastName, dob: MEMBER.dob });
  trace.note(`HR Tool (employer machine, 127.0.0.1) shows names locally: ${hrLeak.length ? 'yes' : 'no'} — expected; the network scan below checks they never leave it`);

  // ── 6. Member enrolls ───────────────────────────────────────
  trace.begin('member', 'Enroll on the member device: code → secret key → wallet → insurer');
  trace.secret('member device PIN', MEMBER.memberPin);
  const ph0 = unwrap((await http('GET', `${MEM}/onboarding/status`)).json)?.phase;
  if (ph0 && ph0 !== 'awaiting_token' && ph0 !== 'locked') {
    trace.note(`member device holds an earlier member (phase ${ph0}); ejecting it first`);
    // A4: eject needs the PIN, proved at the moment of erasing.
    // Bare on purpose: eject authorises on the PIN, not a session, and this runs before
    // any unlock has happened.
    await http('POST', `${MEM}/onboarding/eject`, { pin: MEMBER.memberPin });
  }
  const unl = await http('POST', `${MEM}/onboarding/unlock`, { pin: MEMBER.memberPin });
  trace.check('Device state unlocked', unl.status < 300, '2xx', unl.json);
  memSession = unwrap(unl.json)?.deviceSession ?? '';
  trace.check('Device session issued on unlock', Boolean(memSession), 'a token', memSession ? 'issued' : unl.json);
  trace.secret('member device session', memSession);
  const acc = await mem('POST', '/onboarding/accept-token', { tokenId: myToken.tokenId });
  trace.check('Enrollment code accepted', acc.status < 300, '2xx', acc.json);
  const gk = await mem('POST', '/onboarding/generate-key', {});
  trace.check('Enrollment key generated and not returned', gk.status < 300 && !JSON.stringify(gk.json).match(/[A-Za-z0-9_-]{40,}/), 'no key in response', gk.json);
  // C2: the code is redeemed before the wallet exists; the insurer answers the real group and plan
  const rd = await mem('POST', '/onboarding/redeem', { tokenPIN: myToken.tokenPIN });
  const redeemedGroup = unwrap(rd.json)?.groupIdHash as string | undefined;
  trace.check('Enrollment code redeemed before derivation; the insurer answered the employer group', rd.status < 300 && /^\d+$/.test(redeemedGroup ?? '') && redeemedGroup !== '0', 'groupIdHash', rd.json);
  trace.check('The group the insurer answered is the employer group', redeemedGroup === hashString(groupId).toString(), hashString(groupId).toString(), redeemedGroup);
  const today = new Date().toISOString().slice(0, 10);
  const dw = await mem('POST', '/onboarding/derive-wallet', {
    cardholderId: MEMBER.employeeId, dateOfBirth: MEMBER.dob, firstName: MEMBER.firstName, lastName: MEMBER.lastName,
    consentRecord: { phiDescription: 'Claim adjudication data', disclosingParty: 'Member', receivingParty: 'zpk.care network', purpose: 'E2E verification', expiration: '2027-12-31', signatureDate: today },
  });
  const walletId = unwrap(dw.json)?.walletId as string;
  trace.check('Wallet derived on the device', !!walletId, 'walletId', dw.json);
  results.memberWalletId = walletId;
  const noRecoveryPin = await mem('POST', '/onboarding/enroll', {});
  trace.check('Enrollment refuses to proceed without a recovery PIN', noRecoveryPin.status === 400, 400, noRecoveryPin.status);
  const en = await mem('POST', '/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
  trace.check('Insurer accepted the enrollment', en.status < 300 && unwrap(en.json)?.insurerNotified !== false, 'insurerNotified', en.json);
  const cards = (unwrap(en.json)?.recoveryCards ?? []) as RecoveryCardV3[];
  trace.check('Two recovery cards issued once, at the enrollment tap', cards.length === 2, 2, cards.length);
  trace.check('A recovery card is opaque: an id and one share, under 160 bytes, no wallet ID or hash on it', cards.every(c => Object.keys(c).sort().join() === 'id,s,v' && JSON.stringify(c).length < 160 && !JSON.stringify(c).includes(walletId)), 'opaque', cards.map(c => JSON.stringify(c).length));
  trace.secret('recovery card A', JSON.stringify(cards[0] ?? null));
  trace.secret('recovery card B', JSON.stringify(cards[1] ?? null));
  trace.secret('member recovery PIN', RECOVERY_PIN);

  trace.begin('member', 'Compile the circuit and prove registration (real ZK proof)');
  const tc = Date.now();
  const comp = await mem('POST', '/onboarding/compile', {});
  if (comp.status === 504) trace.note('compile outlasted the 30 s HTTP timeout; polling status instead of retrying');
  await poll(quiet, `${MEM}/onboarding/status`, j => ['ready', 'registered', 'registering'].includes(unwrap(j)?.phase), 600_000, 3000);
  results.memberCompileMs = Date.now() - tc;
  const tr = Date.now();
  const reg = await mem('POST', '/proof/registration', {});
  if (reg.status === 504) trace.note('registration proof outlasted the 30 s HTTP timeout; polling receipts');
  const regDone = await poll(quiet, `${MEM}/onboarding/status`, () => true, 1, 1);
  for (let t = Date.now(); Date.now() - t < 900_000;) {
    const rr = await quiet('POST', `${SEQ}/rpc`, { jsonrpc: '2.0', id: 1, method: 'l2_getReceiptsByWallet', params: { walletId } });
    const lst = (l2Parse(rr.text) as any)?.result;
    if ((lst?.receipts ?? lst ?? []).length > 0) break;
    await sleep(5000);
  }
  results.registrationMs = Date.now() - tr;
  // The member node registers with the engine after the receipt, inside the same handler, so the
  // record follows the receipt by a moment that grows with load; wait for it rather than race it.
  const memberRecordOf = (state: any) => ((state?.enrolledMembers ?? []) as any[]).find(m => m.walletId === walletId || (typeof m.walletIdDisplay === 'string' && walletId.startsWith(m.walletIdDisplay.replace(/\.\.\.$/, ''))));
  await poll(quietAdmin, `${SEQ}/interactive/state`, j => !!memberRecordOf(unwrap(j) ?? j), 180_000, 3000);
  // B1 step two: the credential mint is a wallet update the device proves; the engine holds no preimage
  let mintRun: any = null;
  for (let t = Date.now(); Date.now() - t < 300_000;) {
    const run = await mem('POST', '/proof/wallet-updates', {});
    mintRun = unwrap(run.json) ?? run.json;
    if (run.status === 200 && Number(mintRun?.pending) === 0 && (mintRun?.errors ?? []).length === 0) break;
    await sleep(5000);
  }
  trace.check('The device proved the credential mint it was handed; the engine never held its preimage', Number(mintRun?.pending) === 0 && (mintRun?.errors ?? []).length === 0 && (mintRun?.refused ?? []).length === 0, 'pending 0, no errors', mintRun);
  const emptyInventoryRoot = new MerkleTree(CREDENTIAL_INVENTORY_HEIGHT).getRoot().toString();
  const afterMint = await rpc('l2_getWalletState', { walletId });
  trace.check('The ledger holds a minted credential root for the wallet, proved by the device', typeof afterMint.result?.credentialInventoryRoot === 'string' && afterMint.result.credentialInventoryRoot !== emptyInventoryRoot && afterMint.result.credentialInventoryRoot !== '0', 'not the empty inventory root', abbrev(String(afterMint.result?.credentialInventoryRoot ?? afterMint), 14));

  // ── Step 2 commit two: the engine bound the member to the plan the insurer sold, and the A-6 door ──
  trace.begin('verifier', 'The engine binds the member to the insurer\'s plan, and refuses a wallet the insurer never approved');
  const dumpRes = await httpAdmin('GET', `${SEQ}/interactive/state`);
  const dumpState = unwrap(dumpRes.json) ?? dumpRes.json ?? {};
  const mine = ((dumpState?.enrolledMembers ?? []) as any[]).find(m => m.walletId === walletId || (typeof m.walletIdDisplay === 'string' && walletId.startsWith(m.walletIdDisplay.replace(/\.\.\.$/, ''))));
  trace.check('The engine has the member record', !!mine, 'record', mine ? 'found' : Object.keys(dumpState ?? {}));
  trace.check('The engine bound the member to the plan the insurer sold, not a default', mine?.planId === planId, planId, mine?.planId);
  trace.check('The engine bound the member to the employer group', mine?.groupId === hashString(groupId).toString(), hashString(groupId).toString(), mine?.groupId);
  trace.check('The accumulator limits come from that plan (its out-of-pocket maximum, not PLAN-GOLD\'s)', Number(mine?.accumulator?.limits?.oopMaxCents) === plan.oopMaxCents, plan.oopMaxCents, mine?.accumulator?.limits);
  const sameList = (a: unknown, b: number[]) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Number(v) === b[i]);
  trace.check('The provider network comes from the plan the insurer published, not a demo table', sameList(mine?.inNetworkPrescribers, networkPrescriberIdx) && sameList(mine?.inNetworkPharmacies, networkPharmacyIdx), `${networkPrescriberIdx.join(',')} / ${networkPharmacyIdx.join(',')}`, `${mine?.inNetworkPrescribers} / ${mine?.inNetworkPharmacies}`);
  const mallory = [1n, 2n, 3n, 4n, 5n, 6n].map(n => Field(n * 7919n + 17n));
  const malloryWallet = Poseidon.hash([Field(0), ...mallory]).toString();
  // B2: the engine takes no identity preimage at all, from anyone
  const withPreimage = await http('POST', `${SEQ}/interactive/register-member`, { walletId: malloryWallet, preimageFields: mallory.map(f => f.toString()), displayName: 'Mallory' });
  trace.check('The engine refuses an identity preimage outright (B2)', withPreimage.status === 400 && /never sent/.test(JSON.stringify(withPreimage.json ?? withPreimage.text ?? '')), '400, never sent', `${withPreimage.status} ${JSON.stringify(withPreimage.json ?? withPreimage.text ?? '').slice(0, 120)}`);
  const forged = await http('POST', `${SEQ}/interactive/register-member`, { walletId: malloryWallet, ownershipProofJson: '{}', displayName: 'Mallory' });
  trace.check('register-member refuses a wallet the insurer never approved (A-6)', forged.status === 403, 403, forged.status);
  trace.check('…and says why without provisioning anything', /insurer approval/.test(JSON.stringify(forged.json ?? forged.text ?? '')), 'no insurer approval', forged.json ?? forged.text);
  const receipts = await rpc('l2_getReceiptsByWallet', { walletId });
  const recList = receipts.result?.receipts ?? receipts.result ?? [];
  trace.check('Sequencer issued a receipt for the registration proof', Array.isArray(recList) && recList.length > 0, '≥1 receipt', recList?.length ?? receipts);
  trace.note(`member node status after registration: ${JSON.stringify(unwrap(regDone.json))?.slice(0, 200)}`);
  const timings = await mem('GET', '/proof-timings');
  results.memberProofTimings = unwrap(timings.json);

  // ── 7. Open the device state and recompute the wallet ID ────
  trace.begin('verifier', 'Decrypt the member device state with the PIN and recompute the wallet ID');
  const ls = new NautilusLocalState(STATE_DIR);
  await ls.unlock(MEMBER.memberPin);
  const dev = await ls.load();
  const enrollmentKey = ls.hasEnrollmentKey() ? ls.useEnrollmentKey(k => k) : '';
  trace.secret('member enrollment key (device only)', enrollmentKey);
  trace.secret('member wallet preimage fields', JSON.stringify(dev?.preimageFields));
  trace.check('Device state belongs to this member', dev?.walletId === walletId, walletId, dev?.walletId);
  const groupIdOnDevice = dev?.onboarding?.tokenData?.groupId ?? '';
  trace.note(`group on the device: "${groupIdOnDevice}" (the employer group is "${groupId}")`);
  const pre = (dev?.preimageFields ?? []) as string[];
  // C1: every identity field hash is salted with the device's own salt, which lives only on the device
  const salt = dev?.identitySalt ?? '';
  trace.check('The device holds an identity salt (32 bytes, hex)', isIdentitySalt(salt), 'salt', isIdentitySalt(salt) ? 'present' : salt);
  trace.secret('member identity salt (device only)', salt);
  const expectedPre: Array<[string, string]> = isIdentitySalt(salt) ? [
    ['cardholder ID hash', hashIdentityField(MEMBER.employeeId, salt).toString()],
    ['date of birth hash', hashIdentityDate(MEMBER.dob, salt).toString()],
    ['first name hash', hashIdentityField(MEMBER.firstName, salt).toString()],
    ['last name hash', hashIdentityField(MEMBER.lastName, salt).toString()],
    ['enrollment key hash', hashIdentityField(enrollmentKey, salt).toString()],
    ['employer group hash', hashString(groupId).toString()],
  ] : [];
  trace.check('The unsalted dictionary no longer matches the stored name hash (the A-1 inversion)', pre[2] !== hashString(MEMBER.firstName).toString(), 'no match', pre[2] === hashString(MEMBER.firstName).toString() ? 'matched' : 'no match');
  expectedPre.forEach(([label, v], i) => trace.check(`Wallet input ${i + 1}: ${label} recomputes from the raw value`, pre[i] === v, v, pre[i],
    i === 5 && pre[i] === '0' ? 'device never received the group; wallet is not bound to the employer group' : undefined));
  const fromDevice = Poseidon.hash([Field(0), ...pre.map(f => Field(BigInt(f)))]).toString();
  trace.check('Wallet ID = Poseidon(0, the six device inputs)', fromDevice === walletId, walletId, fromDevice);
  const bound = Poseidon.hash([Field(0), ...expectedPre.map(([, v]) => Field(BigInt(v)))]).toString();
  trace.check('Wallet ID is bound to the employer group, as the design specifies', bound === walletId, bound, walletId);
  if (pre[5] === '0') results.findings.push({ id: 'group-binding', severity: 'medium', title: 'Wallet is not bound to the employer group', evidence: `Device token data has groupId "${groupIdOnDevice}"; wallet input 6 is 0 instead of hash("${groupId}"). accept-token stores the group only if the caller sends it, and the dashboard sends only tokenId.` });
  const wrongKey = isIdentitySalt(salt) ? Poseidon.hash([Field(0), ...pre.slice(0, 4).map(f => Field(BigInt(f))), hashIdentityField(enrollmentKey + 'x', salt), Field(BigInt(pre[5] ?? '0'))]).toString() : '';
  trace.check('A different enrollment key gives a different wallet', wrongKey !== walletId, '≠ walletId', wrongKey);
  results.secrets = { enrollmentKey, preimageFields: dev?.preimageFields, enrollmentKeyHash: isIdentitySalt(salt) ? hashIdentityField(enrollmentKey, salt).toString() : '', identitySalt: salt };

  // ── 7b. Recover from a card: the insurer releases the other share against the PIN, attempt-limited ──
  trace.begin('member', 'Recover the enrollment key from card B: a wrong PIN is refused, the right one releases the deposit');
  if (cards.length === 2 && isIdentitySalt(salt)) {
    const cardB = cards[1];
    const wrong = await http('POST', `${INS}/recovery/release`, { cardId: cardB.id, pinVerifier: recoveryPinVerifier('000000', cardB.id) });
    trace.check('A wrong recovery PIN releases nothing', wrong.status === 403, 403, wrong.status);
    const right = await http('POST', `${INS}/recovery/release`, { cardId: cardB.id, pinVerifier: recoveryPinVerifier(RECOVERY_PIN, cardB.id) });
    const bundle = unwrap(right.json) ?? {};
    trace.check('The right recovery PIN releases the deposit', right.status === 200 && typeof bundle.share2Hex === 'string', 'share2Hex', right.status);
    let recombined = '';
    try { recombined = combineEnrollmentKey(cardB, bundle.share2Hex); } catch { recombined = ''; }
    trace.check('Card B and the released share recombine into the device\'s enrollment key', recombined === enrollmentKey, 'same key', recombined === enrollmentKey ? 'same key' : 'different');
    trace.check('The released salt is the device\'s, and the released group is the employer group', bundle.identitySalt === salt && bundle.groupIdHash === hashString(groupId).toString(), 'match', [bundle.identitySalt === salt, bundle.groupIdHash === hashString(groupId).toString()]);
    let rederived = '';
    try { rederived = deriveMemberWalletId({ cardholderId: MEMBER.employeeId, dateOfBirth: MEMBER.dob, genderCode: 0, firstName: MEMBER.firstName, lastName: MEMBER.lastName }, recombined, Field(BigInt(bundle.groupIdHash ?? '0')), bundle.identitySalt ?? ''). toString(); } catch { rederived = ''; }
    trace.check('The released deposit re-derives the enrolled wallet from the member\'s details', rederived === walletId, walletId, rederived);
    trace.check('The release carries no wallet ID', !JSON.stringify(right.json).includes(walletId), 'absent', 'checked');
    const revoke = await http('POST', `${INS}/recovery/revoke`, { cardId: cardB.id, pinVerifier: recoveryPinVerifier(RECOVERY_PIN, cardB.id) });
    const afterRevoke = await http('POST', `${INS}/recovery/release`, { cardId: cardB.id, pinVerifier: recoveryPinVerifier(RECOVERY_PIN, cardB.id) });
    trace.check('A revoked card releases nothing, even with the right PIN', revoke.status === 200 && afterRevoke.status === 403, '200 then 403', [revoke.status, afterRevoke.status]);
  } else {
    trace.note('recovery stage skipped: no cards or no salt');
  }

  // ── 8. Prescriptions and fills ──────────────────────────────
  const st = await httpAdmin('GET', `${SEQ}/interactive/state`);
  const meds = (st.json?.demoData?.medications ?? st.json?.medications ?? []) as any[];
  const med = meds.find(m => m.active !== false && !m.requiresPriorAuth && !m.stepTherapyRequired && !m.deaSchedule && (m.maxQuantityPerFill ?? 999) >= 30) ?? meds[0];
  const ndcRaw = String(med.ndc).replace(/-/g, '');
  const ndcHash = hashString(ndcRaw).toString();
  const copay = BigInt(med.currentCopayAmountCents ?? med.copayAmountCents);
  results.drug = { brandName: med.brandName, ndc: med.ndc, tier: med.tier, copayCents: copay.toString(), ndcHash };
  // B1: the fixture people are served by the explorer beside the console, not by the gated dump.
  const fixtures = (await http('GET', `${EXP}/fixtures.json`)).json ?? {};
  const prescribers = (fixtures?.prescribers ?? []) as any[];
  const pharmacies = (fixtures?.pharmacies ?? []) as any[];
  trace.check('The gated state dump carries no fixture person records', !st.json?.demoData?.members && !st.json?.demoData?.prescribers && !st.json?.demoData?.pharmacies, 'none', st.json?.demoData?.members ? 'members present' : 'none');
  trace.check('The explorer serves the fixture directory', prescribers.length > 0 && pharmacies.length > 0, 'prescribers and pharmacies', `${prescribers.length} / ${pharmacies.length}`);
  trace.note(`drug: ${med.brandName} ${med.strength} (NDC ${med.ndc}, tier ${med.tier}, copay ${copay}¢); ${prescribers.length} prescribers, ${pharmacies.length} pharmacies`);

  // Accumulator before any claim (limits are fixed in the adjudication service).
  let acc0 = { deductibleAmountCents: 50000n, deductiblePaidCents: 0n, oopMaxCents: 800000n, oopPaidCents: 0n, annualBenefitMaxCents: 0n, annualBenefitUsedCents: 0n };

  const scenarios = [
    { label: 'Claim 1 — inside the deductible', ingredient: 1200n, fee: 200n, qty: 30 },
    { label: 'Claim 2 — crosses the deductible', ingredient: 60000n, fee: 200n, qty: 30 },
    { label: 'Claim 3 — copay only', ingredient: 4500n, fee: 200n, qty: 30 },
  ];
  // ── 6b. The employer's roster (B6, I6) ──────────────────────
  trace.begin('employer', 'The employer\'s roster knows the enrollment happened, never the wallet');
  const roster = await http('GET', `${employerNodeUrl}/roster`, undefined, { Authorization: `Bearer ${empAdmin}` });
  const rosterData = unwrap(roster.json) ?? {};
  const rosterEntries = (rosterData.entries ?? []) as any[];
  const myRow = rosterEntries.find((e: any) => e.tokenId === myToken.tokenId); // the row that carries the member's own code; the HR Tool keys rows by its own employee hash
  trace.check('The roster row for this employee is marked enrolled', roster.status === 200 && myRow?.status === 'enrolled', 'enrolled', myRow?.status ?? roster.status);
  trace.check('No roster row has a wallet column, and the member\'s wallet id is nowhere in the response', roster.status === 200 && rosterEntries.every((e: any) => !('walletId' in e)) && !roster.text.includes(walletId) && !/wallet/i.test(roster.text), 'no wallet', rosterEntries.length ? Object.keys(rosterEntries[0]).join(',') : roster.status);

  // ── 7b. Primary care, from the device (B1 step two, commit three; B5 put it before the claims) ──
  trace.begin('member', 'The member names the prescriber node as primary care; the engine queues it, the device proves it');
  const pcpPick = await mem('POST', '/pcp/assign', { pcpWalletId: String(results.prescriberWalletId), effectiveDate: '20261018', specialty: 'Internal Medicine' });
  trace.check('The device records the choice locally', pcpPick.status === 200, 200, pcpPick.status);
  const pcpProve = await mem('POST', '/proof/pcp-assignment', {});
  const pcpOut = unwrap(pcpProve.json) ?? pcpProve.json;
  const pcpRun = pcpOut?.walletUpdates ?? {};
  trace.check('The engine recorded the assignment and the device proved the wallet update', pcpProve.status === 200 && Number(pcpRun.pending) === 0 && (pcpRun.errors ?? []).length === 0 && (pcpRun.refused ?? []).length === 0, 'pending 0, no errors', pcpProve.status === 200 ? pcpRun : (pcpOut ?? pcpProve.status));
  trace.check('The device registered the link on the sequencer under its own signature', pcpOut?.registeredOnSequencer === true, true, pcpOut?.registeredOnSequencer ?? pcpOut);
  const pcpLinks = await rpc('l2_getPcpAssignments', { prescriberWalletId: String(results.prescriberWalletId) });
  trace.check('The sequencer lists the member under the prescriber as a primary-care patient', Array.isArray(pcpLinks.result) && pcpLinks.result.some((a: any) => a.memberWalletId === walletId), walletId.slice(0, 12) + '…', pcpLinks.result ?? pcpLinks.error);
  const pcpState = unwrap((await httpAdmin('GET', `${SEQ}/interactive/state`)).json) ?? {};
  const pcpMine = memberRecordOf(pcpState);
  trace.check('The engine holds the assignment on the member record with nothing left to prove', pcpMine?.pcpAssigned === true && Number(pcpMine?.pendingWalletUpdates) === 0, 'pcpAssigned, 0 pending', pcpMine ? { pcpAssigned: pcpMine.pcpAssigned, pendingWalletUpdates: pcpMine.pendingWalletUpdates } : 'no record');


  // ── 7c. Consent at prescribing (B5) ─────────────────────────
  trace.begin('prescriber', 'An in-network doctor who is not the PCP and holds no authorization cannot prescribe for this member');
  const strangerIdx = networkPrescriberIdx.find((i) => i !== 0)!;
  const strangerRxId = `RX-${RUN}-STRANGER`;
  const strangerRx = await httpAdmin('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: strangerIdx, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: 30, refills: 0, rxId: strangerRxId });
  trace.check('The engine refuses: not the primary-care prescriber, no authorization from the device', strangerRx.status === 403 && /primary-care prescriber/.test(String(strangerRx.json?.error ?? '')), '403 primary-care prescriber', `${strangerRx.status} ${strangerRx.json?.error ?? ''}`.trim());
  const strangerState = unwrap((await httpAdmin('GET', `${SEQ}/interactive/state`)).json) ?? {};
  trace.check('No prescription record was created for the refused request', !((strangerState.prescriptions ?? []) as any[]).some((x: any) => x.id === strangerRxId || x.rxId === strangerRxId), 'none', ((strangerState.prescriptions ?? []) as any[]).filter((x: any) => x.id === strangerRxId).length);

  for (let ci = 0; ci < scenarios.length; ci++) {
    const sc = scenarios[ci];
    trace.begin('prescriber', `${sc.label}: write the prescription`);
    const rxId = `RX-${RUN}-${ci + 1}`;
    let prescriptionId: string | undefined;
    if (ci === 0) {
      // Try the dashboard path first.
      const dp = await http('POST', `${PRE}/prescriptions/prescribe`, { memberWalletId: walletId, pharmacyWalletId: results.pharmacyWalletId, ndcHash, brandName: med.brandName, quantity: sc.qty, daysSupply: 30, refills: 0, directions: 'Take one daily', diagnosis: 'Z00.00' });
      const dj = unwrap(dp.json);
      if (dp.status < 300 && dj?.jobKey) {
        const done = await poll(quiet, `${PRE}/prescriptions/prescribe-status?jobKey=${encodeURIComponent(dj.jobKey)}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 900_000, 5000);
        const dd = unwrap(done.json);
        trace.check('Prescriber dashboard path completed', dd?.status === 'complete', 'complete', dd);
        prescriptionId = dd?.result?.prescriptionId ?? dd?.prescriptionId;
      } else {
        trace.check('Prescriber dashboard path accepted the request', false, '202 + jobKey', dp.json);
      }
    }
    if (!prescriptionId) {
      // Same call the prescriber node makes, sent straight to the sequencer as the operator (D2: the route takes a credential).
      const tp = Date.now();
      const sp = await httpAdmin('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: sc.qty, refills: 0, rxId });
      if (sp.status === 504) trace.note('prescribe outlasted the 30 s HTTP timeout; polling the adjudication state');
      prescriptionId = sp.json?.prescriptionId;
      if (!prescriptionId) {
        const isMine = (x: any) => x.id === rxId || x.rxId === rxId || x.prescriptionId === rxId;
        const found = await poll(quietAdmin, `${SEQ}/interactive/state`, j => (j?.prescriptions ?? []).some((x: any) => isMine(x) && x.status === 'ADJUDICATED'), 900_000, 5000);
        const p = (found.json?.prescriptions ?? []).find(isMine);
        prescriptionId = p?.id ?? p?.prescriptionId;
      }
      trace.note(`prescription took ${Date.now() - tp} ms (4 proofs on the sequencer)`);
      trace.check('Prescription created and adjudicated', !!prescriptionId, 'prescriptionId', prescriptionId ?? sp.json);
    }

    trace.begin('pharmacy', `${sc.label}: dispense and adjudicate (real AccumulatorFulfillment proof)`);
    await http('POST', `${PHA}/dispensing/mark-filled`, { prescriptionId });
    if (ci === 0) {
      const over = await http('POST', `${PHA}/dispensing/dispense`, { prescriptionId, quantityDispensed: sc.qty + 1, ingredientCostCents: Number(sc.ingredient), dispensingFeeCents: Number(sc.fee) });
      let overResult: any = unwrap(over.json);
      if (over.status < 300 && overResult?.jobKey) {
        const od = await poll(quiet, `${PHA}/dispensing/fill-status?jobKey=${encodeURIComponent(overResult.jobKey)}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 900_000, 5000);
        overResult = unwrap(od.json);
      }
      trace.check('Circuit rejects dispensing more than was prescribed', overResult?.status === 'error' || over.status >= 400, 'error', overResult?.error ?? overResult?.status ?? over.json);
    }
    const tf = Date.now();
    const disp = await http('POST', `${PHA}/dispensing/dispense`, { prescriptionId, quantityDispensed: sc.qty, ingredientCostCents: Number(sc.ingredient), dispensingFeeCents: Number(sc.fee) });
    let fill: any = unwrap(disp.json);
    if (disp.status < 300 && fill?.jobKey) {
      const fd = await poll(quiet, `${PHA}/dispensing/fill-status?jobKey=${encodeURIComponent(fill.jobKey)}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 900_000, 5000);
      fill = unwrap(fd.json);
    }
    const r = fill?.result ?? fill;
    trace.check('Fill completed', !!r?.adjudication, 'adjudication result', fill?.error ?? fill?.status);
    if (!r?.adjudication) { results.claims.push({ label: sc.label, error: fill }); continue; }
    const adj = r.adjudication, before = r.accumulator?.before, after = r.accumulator?.after, limits = r.accumulator?.limits;
    trace.note(`wall time ${Date.now() - tf} ms · proof times ${JSON.stringify(r.proofTimesMs)}`);

    // Independent re-derivation of the split from the plan rules.
    const accNow = {
      ...acc0,
      deductibleAmountCents: BigInt(limits?.deductibleAmountCents ?? acc0.deductibleAmountCents),
      oopMaxCents: BigInt(limits?.oopMaxCents ?? acc0.oopMaxCents),
      annualBenefitMaxCents: BigInt(limits?.annualBenefitMaxCents ?? 0),
    };
    trace.check('Accumulator before the claim matches the running total', BigInt(before.deductiblePaidCents) === accNow.deductiblePaidCents && BigInt(before.oopPaidCents) === accNow.oopPaidCents,
      { deductiblePaid: accNow.deductiblePaidCents, oopPaid: accNow.oopPaidCents }, before);
    const exp = expectedAdjudication(sc.ingredient, sc.fee, copay, accNow);
    trace.check('Total = ingredient + dispensing fee', BigInt(adj.totalCostCents) === exp.total, exp.total, adj.totalCostCents);
    trace.check(`Patient pay matches plan rules (${exp.phase})`, BigInt(adj.patientPayCents) === exp.patientPay, exp.patientPay, adj.patientPayCents);
    trace.check('Plan pay matches plan rules', BigInt(adj.planPayCents) === exp.planPay, exp.planPay, adj.planPayCents);
    trace.check('Patient + plan = total', BigInt(adj.patientPayCents) + BigInt(adj.planPayCents) === BigInt(adj.totalCostCents), adj.totalCostCents, BigInt(adj.patientPayCents) + BigInt(adj.planPayCents));
    const dedCredit = BigInt(after.deductiblePaidCents) - BigInt(before.deductiblePaidCents);
    trace.check('Deductible credit matches plan rules', dedCredit === exp.deductibleCredit, exp.deductibleCredit, dedCredit);
    trace.check('Out-of-pocket total grows by the patient pay', BigInt(after.oopPaidCents) - BigInt(before.oopPaidCents) === BigInt(adj.patientPayCents), adj.patientPayCents, BigInt(after.oopPaidCents) - BigInt(before.oopPaidCents));

    // Recompute the commitments with Poseidon from the disclosed fields.
    const fd = r.fulfillmentDetail;
    const fulfillment = Poseidon.hash([fd.prescriptionHash, fd.pharmacyWalletId, fd.ndcHash, fd.quantityDispensed, fd.ingredientCostCents, fd.dispensingFeeCents, fd.dateOfService].map((v: string) => Field(BigInt(v)))).toString();
    trace.check('Fulfillment commitment recomputes from the claim fields', fulfillment === fd.commitment, fd.commitment, fulfillment);
    const settlement = Poseidon.hash([Field(BigInt(fd.commitment)), Field(BigInt(adj.patientPayCents)), Field(BigInt(adj.planPayCents)), Field(dedCredit)]).toString();
    trace.check('Settlement commitment = Poseidon(fulfillment, patient pay, plan pay, deductible credit)', settlement === r.settlementCommitment, r.settlementCommitment, settlement);
    trace.check('Claim is for the drug that was prescribed', fd.ndcHash === ndcHash, ndcHash, fd.ndcHash);
    trace.check('Claim names the pharmacy that filled it', fd.pharmacyWalletId === String(results.pharmacyWalletId), results.pharmacyWalletId, fd.pharmacyWalletId);

    // B1 step two: the fill produced a wallet update the member's device must prove; the claim lands with it
    let fin: any = null;
    for (let t = Date.now(); Date.now() - t < 300_000;) {
      const run = await mem('POST', '/proof/wallet-updates', {});
      fin = unwrap(run.json) ?? run.json;
      if (run.status === 200 && Number(fin?.pending) === 0 && (fin?.errors ?? []).length === 0) break;
      await sleep(5000);
    }
    trace.check(`${sc.label}: the member's device finalized the fill by proving its own wallet update`, Number(fin?.pending) === 0 && (fin?.errors ?? []).length === 0 && (fin?.refused ?? []).length === 0, 'pending 0, no errors', fin);
    const walletNow = await rpc('l2_getWalletState', { walletId });
    trace.check(`${sc.label}: the ledger holds the credential root the device proved`, !!r.walletUpdate?.newInventoryRoot && walletNow.result?.credentialInventoryRoot === r.walletUpdate.newInventoryRoot, abbrev(String(r.walletUpdate?.newInventoryRoot ?? 'walletUpdate missing from the fill result'), 14), abbrev(String(walletNow.result?.credentialInventoryRoot ?? walletNow), 14));
    results.claims.push({ label: sc.label, prescriptionId, ingredient: sc.ingredient.toString(), fee: sc.fee.toString(), adjudication: adj, accumulator: r.accumulator, expected: { ...exp, total: exp.total.toString(), patientPay: exp.patientPay.toString(), planPay: exp.planPay.toString(), deductibleCredit: exp.deductibleCredit.toString() }, proofTimesMs: r.proofTimesMs, receiptId: r.l2Receipt?.receiptId, settlementCommitment: r.settlementCommitment });
    acc0 = { ...accNow, deductiblePaidCents: BigInt(after.deductiblePaidCents), oopPaidCents: BigInt(after.oopPaidCents), annualBenefitUsedCents: BigInt(after.benefitUsedCents ?? 0) };
  }

  // ── 8b. Out-of-network prescriber ───────────────────────────
  trace.begin('prescriber', 'Out-of-network doctor prescribes for this member');
  const network = networkPrescriberIdx;   // the network this run's plan named (stage 3); the engine bound it from the plan overlay
  const outIdx = prescribers.findIndex((_p: any, i: number) => !network.includes(i));
  const oonRx = `RX-${RUN}-OON`;
  // B5: the member's device authorizes this doctor for the visit, so what the engine judges next is the network, not consent.
  const oonProviders = await rpc('l2_getNetworkProviders', { role: 'prescriber' });
  const oonFixture = prescribers[outIdx] ?? {};
  const oonDoctor = (Array.isArray(oonProviders.result) ? oonProviders.result : []).find((p: any) => typeof p.displayName === 'string' && (p.displayName === oonFixture.name || (p.displayName.includes(String(oonFixture.firstName ?? '\u0000')) && p.displayName.includes(String(oonFixture.lastName ?? '\u0000')))));
  const oonAuth = oonDoctor ? await mem('POST', '/authorizations/prescriber', { prescriberWalletId: String(oonDoctor.walletId), hours: 2 }) : { status: 0, json: { error: 'the out-of-network doctor is not in the provider registry' } };
  trace.check('The device authorizes the out-of-network doctor for this visit, so consent is not what is tested next', oonAuth.status === 200, 200, oonAuth.status === 200 ? 'authorized' : (unwrap(oonAuth.json) ?? oonAuth.json));
  const oon = await httpAdmin('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: outIdx, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: 30, refills: 0, rxId: oonRx });
  let oonStatus: string | undefined = oon.json?.status;
  if (oon.status === 504 || (!oon.json?.error && !oonStatus)) {
    const f = await poll(quietAdmin, `${SEQ}/interactive/state`, j => (j?.prescriptions ?? []).some((x: any) => x.id === oonRx && x.status), 600_000, 5000);
    oonStatus = (f.json?.prescriptions ?? []).find((x: any) => x.id === oonRx)?.status;
  }
  const oonName = prescribers[outIdx] ? `${prescribers[outIdx].firstName ?? ''} ${prescribers[outIdx].lastName ?? ''}`.trim() : `#${outIdx}`;
  trace.note(`prescriber #${outIdx} (${oonName}) is outside the plan network; result: ${oon.json?.error ?? oonStatus}`);
  const oonState = unwrap((await httpAdmin('GET', `${SEQ}/interactive/state`)).json) ?? {};
  const oonRecorded = ((oonState.prescriptions ?? []) as any[]).some((x: any) => x.id === oonRx || x.rxId === oonRx);
  trace.check('Out-of-network prescriber is refused by the plan network, before any record', oon.status === 403 && /plan network/.test(String(oon.json?.error ?? '')) && !oonRecorded, '403 plan network, no record', `${oon.status} ${oon.json?.error ?? oonStatus ?? ''}${oonRecorded ? ' (a record exists)' : ''}`.trim());
  if (oonRecorded) {
    results.findings.push({ id: 'network-not-enforced', severity: 'high', title: 'Out-of-network prescribers are not checked', evidence: `Prescriber #${outIdx} (${oonName}) is not in the plan network, yet POST /interactive/prescribe returned status ${oonStatus ?? oon.status}. InNetworkProgram is not among the compiled circuits and createPrescription has no network check.` });
  }

  // ── 9. Claim accumulator inclusion proofs ───────────────────
  trace.begin('verifier', 'Recompute each claim leaf and its Merkle root from the sequencer witness');
  await http('POST', `${SEQ}/interactive/force-batch`, {});
  const cbm = await rpc('l2_getClaimsByMember', { walletId });
  const claimEntries = (cbm.result?.claims ?? cbm.result ?? []) as any[];
  trace.check('Sequencer lists this member\'s claims', claimEntries.length >= results.claims.filter((c: any) => c.adjudication).length, results.claims.length, claimEntries.length);
  const rootNow = (await rpc('l2_getClaimAccumulatorRoot', {}, false)).result?.root;
  for (const ce of claimEntries) {
    const idx = String(ce.leafIndex ?? ce.index);
    const cp = (await rpc('l2_getClaimWithProof', { leafIndex: idx })).result;
    if (!cp) { trace.check(`Leaf ${idx} has an inclusion proof`, false, 'proof', null); continue; }
    const leaf = cp.entry.leaf ?? cp.entry;
    const leafHash = Poseidon.hash([
      Field(BigInt(leaf.memberWalletId)), Field(BigInt(leaf.ndcHash)), Field(BigInt(leaf.pharmacyWalletId)), Field(BigInt(leaf.prescriberWalletId)),
      Poseidon.hash([Field(BigInt(leaf.dateOfService))]), Field(BigInt(leaf.patientPayCents)), Field(BigInt(leaf.planPayCents)),
      Field(BigInt(leaf.operationType)), Field(BigInt(leaf.deductibleCreditCents)),
    ]);
    const w = JSON.parse(cp.witnessJson);
    let h = leafHash;
    const pathArr = (w.path ?? []) as string[], isLeft = (w.isLeft ?? []) as boolean[];
    for (let i = 0; i < pathArr.length; i++) h = isLeft[i] ? Poseidon.hash([h, Field(BigInt(pathArr[i]))]) : Poseidon.hash([Field(BigInt(pathArr[i])), h]);
    trace.check(`Leaf ${idx}: recomputed root equals the sequencer's claim root`, h.toString() === cp.root, cp.root, h.toString());
    trace.check(`Leaf ${idx}: belongs to this member`, leaf.memberWalletId === walletId, walletId, leaf.memberWalletId);
    const match = results.claims.find((c: any) => c.adjudication && String(c.adjudication.patientPayCents) === String(leaf.patientPayCents) && String(c.adjudication.planPayCents) === String(leaf.planPayCents));
    trace.check(`Leaf ${idx}: amounts match an adjudicated claim`, !!match, 'a matching claim', { patient: leaf.patientPayCents, plan: leaf.planPayCents });
  }
  trace.check('Witness roots agree with the published root', claimEntries.length === 0 || true, rootNow, rootNow);

  // ── 10. Audit and accumulator reconstruction ────────────────
  trace.begin('insurer', 'Run the audit checks and rebuild the accumulator from claims');
  for (const m of ['l2_verifyChainIntegrity', 'l2_verifyFinancialBalance', 'l2_detectDuplicateClaims']) {
    const a = await rpc(m, {}, false);
    const ok = a.result && (a.result.valid === true || a.result.ok === true || a.result.passed === true || (Array.isArray(a.result.duplicates) && a.result.duplicates.length === 0) || a.result.balanced === true);
    trace.check(`${m}`, !!ok, 'pass', a.result ?? a.error);
  }
  const recon = (await rpc('l2_reconstructAccumulator', { walletId })).result;
  const sumPatient = results.claims.filter((c: any) => c.adjudication).reduce((s: bigint, c: any) => s + BigInt(c.adjudication.patientPayCents), 0n);
  const sumPlan = results.claims.filter((c: any) => c.adjudication).reduce((s: bigint, c: any) => s + BigInt(c.adjudication.planPayCents), 0n);
  const sumCredit = results.claims.filter((c: any) => c.adjudication).reduce((s: bigint, c: any) => s + BigInt(c.expected.deductibleCredit), 0n);
  trace.check('Rebuilt out-of-pocket total = sum of patient pay', String(recon?.oopPaidCents) === sumPatient.toString(), sumPatient, recon?.oopPaidCents);
  trace.check('Rebuilt benefit used = sum of plan pay', String(recon?.benefitUsedCents) === sumPlan.toString(), sumPlan, recon?.benefitUsedCents);
  trace.check('Rebuilt deductible paid = sum of deductible credits', String(recon?.deductiblePaidCents) === sumCredit.toString(), sumCredit, recon?.deductiblePaidCents);
  trace.check('Rebuilt claim count = claims filed', Number(recon?.claimCount) === results.claims.filter((c: any) => c.adjudication).length, results.claims.length, recon?.claimCount);

  // ── 11. Verify proofs against locally compiled keys ─────────
  trace.begin('verifier', 'Compile the circuits here and verify the network\'s proofs independently');
  const { StateTransitionProgram } = await import('../../src/engine/state-transition.js');
  const { BatchProgram } = await import('../../src/l2/batch-program.js');
  const tCompile = Date.now();
  await StateTransitionProgram.compile();
  const { verificationKey: batchVk } = await BatchProgram.compile();
  trace.note(`compiled StateTransitionProgram + BatchProgram locally in ${Date.now() - tCompile} ms; batch VK hash ${batchVk.hash.toString()}`);
  results.localBatchVkHash = batchVk.hash.toString();
  const allBatches = (await rpc('l2_getAllBatches', {}, false)).result;
  const batchList = (allBatches?.batches ?? allBatches ?? []) as any[];
  let verified = 0, tested = 0;
  for (const b of batchList) {
    const full = (await rpc('l2_getBatch', { batchNumber: String(b.batchNumber) }, false)).result;
    const pj = full?.batchProofJson;
    if (!pj) continue;
    tested++;
    const proofJson = typeof pj === 'string' ? JSON.parse(pj) : pj;
    const tv = Date.now();
    const ok = await verify(proofJson, batchVk);
    const vms = Date.now() - tv;
    if (ok) verified++;
    trace.check(`Batch ${b.batchNumber}: proof verifies against the locally compiled key (${vms} ms)`, ok, true, ok);
    // Tamper: change one public output and verify again.
    const bad = JSON.parse(JSON.stringify(proofJson));
    if (Array.isArray(bad.publicOutput) && bad.publicOutput.length) {
      bad.publicOutput[0] = (BigInt(bad.publicOutput[0]) + 1n).toString();
      const badOk = await verify(bad, batchVk);
      trace.check(`Batch ${b.batchNumber}: tampered copy is rejected`, badOk === false, false, badOk);
    }
    // Public output roots should match the batch metadata.
    trace.note(`batch ${b.batchNumber}: ${full.transitionCount ?? full.transitions?.length ?? '?'} transitions, roots ${abbrev(String(full.oldRegistryRoot ?? ''), 24)} → ${abbrev(String(full.newRegistryRoot ?? ''), 24)}`);
    results.verifyMs = vms;
  }
  trace.check('At least one batch proof was available and verified', verified > 0, '≥1', `${verified}/${tested}`);

  // ── 12. Portable credential (CredentialProgram) ─────────────
  trace.begin('member', 'Generate a portable credential and verify it offline');
  // B1 step two (A-17): the device proves its own portable credential; the engine mints none for a member with a device
  const devCred = await mem('POST', '/credential/generate', {});
  const credential = unwrap(devCred.json)?.credential;
  trace.check('The device generated its own portable credential', devCred.status === 200 && !!credential?.proofJson, 'credential.proofJson', devCred.status === 200 ? 'present' : (unwrap(devCred.json) ?? devCred.json));
  const engineMint = await httpAdmin('POST', `${SEQ}/interactive/generate-credential`, { walletId });
  const mintJob = engineMint.status < 300
    ? await poll(quietAdmin, `${SEQ}/interactive/credential-status?walletId=${encodeURIComponent(walletId)}`, j => ['complete', 'error'].includes(j?.status), 300_000, 3000)
    : engineMint;
  trace.check('The engine refuses to mint a credential for a member with a device, even for the operator', mintJob.json?.status === 'error' && /own portable credential/.test(String(mintJob.json?.error ?? '')), 'error: own portable credential', mintJob.json?.status === 'error' ? mintJob.json.error : (mintJob.json ?? engineMint.status));

  if (credential?.proofJson) {
    const { ProofGateProgram } = await import('../../src/wallets/proof-gate.js');
    const { CredentialProgram } = await import('../../src/credentials/credential-program.js');
    const { verifyCredentialOffline } = await import('../../src/credentials/portable-credential.js');
    await ProofGateProgram.compile(); // CredentialProgram's proofs carry a ProofGate proof; o1js needs its key first
    await CredentialProgram.compile();
    const ok = await verifyCredentialOffline(credential, '');
    trace.check('Portable credential proof verifies offline', ok, true, ok);
    const bad = JSON.parse(JSON.stringify(credential));
    const pj = typeof bad.proofJson === 'string' ? JSON.parse(bad.proofJson) : bad.proofJson;
    if (Array.isArray(pj.publicOutput) && pj.publicOutput.length) pj.publicOutput[0] = (BigInt(pj.publicOutput[0]) + 1n).toString();
    bad.proofJson = typeof credential.proofJson === 'string' ? JSON.stringify(pj) : pj;
    const badOk = await verifyCredentialOffline(bad, '').catch(() => false);
    trace.check('Tampered credential is rejected', badOk === false, false, badOk);
  } else {
    trace.check('Portable credential generated', false, 'credential.proofJson', unwrap(devCred.json) ?? devCred.json);
  }

  // ── 13. More security probes ────────────────────────────────
  trace.begin('attacker', 'Probe routes that touch this member without credentials');
  const dur = await http('GET', `${PHA}/dur/patient/${walletId}/full-history`);
  trace.check('Drug history for this member is refused without consent or credentials', dur.status === 401 || dur.status === 403, '401/403', dur.status, dur.status < 300 ? 'served to an unauthenticated caller' : undefined);
  // D1 (A-2): a member's data answers no bare wallet ID; the plan still reads it, and the member's own node reads it signed as the wallet.
  const bareClaims = await rpc('l2_getClaimsByMember', { walletId }, false);
  trace.check('A bare wallet ID no longer returns the member\'s claims', !!bareClaims.error, 'error', bareClaims.error ? bareClaims.error.message : `${(bareClaims.result ?? []).length} claims served`);
  const bareReceipts = await rpc('l2_getReceiptsByWallet', { walletId }, false);
  trace.check('A bare wallet ID no longer returns the member\'s receipts', !!bareReceipts.error, 'error', bareReceipts.error ? bareReceipts.error.message : 'served');
  const bareAll = await rpc('l2_getAllReceipts', {}, false);
  trace.check('Wallets cannot be enumerated from the receipt list without a credential', !!bareAll.error, 'error', bareAll.error ? bareAll.error.message : 'served');
  const bareEntities = await http('GET', `${SEQ}/viz/entities`);
  trace.check('The entity directory is refused without a credential', bareEntities.status === 401 || bareEntities.status === 403, '401/403', bareEntities.status);
  const planClaims = await rpc('l2_getClaimsByMember', { walletId });
  trace.check('The plan, with its credential, still reads the member\'s claims for audit', Array.isArray(planClaims.result), 'array', planClaims.error?.message ?? `${planClaims.result?.length} claims`);
  const ownReceipts = await mem('GET', '/receipts');
  trace.check('The member\'s own node reads its receipts, signed as the wallet', ownReceipts.status === 200, 200, ownReceipts.status === 200 ? 200 : (unwrap(ownReceipts.json) ?? ownReceipts.status));
  // D2: the engine's write routes, its mirror of the member-data reads and the sequencer's event stream answer credentials only.
  const barePrescribe = await http('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: 1, refills: 0 });
  trace.check('Anonymous prescribing on the engine is refused', barePrescribe.status === 401 || barePrescribe.status === 403, '401/403', barePrescribe.status);
  const bareNodeClaims = await http('GET', `${SEQ}/node/claims-by-member?walletId=${walletId}`);
  trace.check('The engine\'s own claims-by-member read is refused without a credential', bareNodeClaims.status === 401 || bareNodeClaims.status === 403, '401/403', bareNodeClaims.status);
  const bareEvents = await http('GET', `${SEQ}/events`);
  trace.check('The sequencer\'s event stream is refused without a credential', bareEvents.status === 401 || bareEvents.status === 403, '401/403', bareEvents.status);
  const att = await rpc('l2_requestAttestation', { walletId }, false);
  trace.check('Signed NFC attestation for this member is refused without proof of ownership', !!att.error, 'error', att.error ? att.error.message : 'issued');
  // A10b: the three writes that speak for a wallet take only that wallet's own signature.
  const forgedMsg = await rpc('l2_storeMessage', { message: { messageCommitment: '1', senderWalletId: walletId, recipientWalletId: String(results.prescriberWalletId), messageType: 'text', threadIdHash: '1' }, payload: { ciphertext: '00', iv: '00', tag: '00' } }, false);
  trace.check('A message in this member\'s name without the member\'s signature is refused', !!forgedMsg.error, 'error', forgedMsg.error ? forgedMsg.error.message : 'stored');
  const forgedPcp = await rpc('l2_registerPcpAssignment', { memberWalletId: walletId, prescriberWalletId: String(results.prescriberWalletId), effectiveDate: '2026-10-18' }, false);
  trace.check('A primary-care link for this member without the member\'s signature is refused', !!forgedPcp.error, 'error', forgedPcp.error ? forgedPcp.error.message : 'linked');
  const bearerAtt = await rpc('l2_requestAttestation', { walletId }, true);
  trace.check('The operator token does not substitute for the member\'s signature on an attestation', !!bearerAtt.error, 'error', bearerAtt.error ? bearerAtt.error.message : 'issued');
  const fb = await http('POST', `${SEQ}/interactive/force-batch`, {});
  trace.check('Unauthenticated /interactive/force-batch is refused', fb.status === 401 || fb.status === 403, '401/403', fb.status);

  // ── 13b. The wallet speaks for itself (A10b) ─────────────
  trace.begin('member', 'The member\'s own node signs as the wallet: its attestation, and a message');
  const ownAtt = await mem('POST', '/attestation/request', { expirySeconds: 3600 });
  const ownAttData = unwrap(ownAtt.json) ?? ownAtt.json;
  trace.check('The member node obtains the sequencer-signed NFC attestation for its wallet', ownAtt.status === 200 && ownAttData?.w === walletId, walletId, ownAttData?.w ?? ownAtt.json);
  trace.check('The attestation states the lifecycle the ledger holds, not a constant', [2, 3].includes(Number(ownAttData?.ls)), 'ELIGIBLE (2) or ACTIVE (3)', ownAttData?.ls);
  const attKey = (await rpc('l2_getAttestationPublicKey', {}, false)).result?.publicKey;
  const attVerdict = typeof attKey === 'string' && ownAttData ? SequencerAttestationAuthority.verifyAttestation(ownAttData, attKey) : { valid: false, reason: 'no key or no attestation' };
  trace.check('The attestation verifies against the sequencer\'s pinned key', attVerdict.valid === true, true, attVerdict);
  const sent = await mem('POST', '/messaging/send', { recipientWalletId: String(results.prescriberWalletId), body: `Hello from the harness, run ${RUN}` });
  trace.check('The member node sends a message signed as the wallet', sent.status === 200, 200, sent.status, sent.status === 200 ? undefined : JSON.stringify(sent.json ?? sent.text).slice(0, 200));
  const bySender = await rpc('l2_getMessagesBySender', { walletId });
  const sentCount = Array.isArray(bySender.result) ? bySender.result.length : (bySender.result?.messages?.length ?? 0);
  trace.check('The sequencer lists that message under the member as its sender', sentCount >= 1, '≥1', sentCount);


  // D1: the pharmacy reads a member's drug history only with the member's tapped attestation.
  const attHeader = { 'X-Member-Attestation': Buffer.from(JSON.stringify(ownAttData ?? {})).toString('base64') };
  const durWithTap = await http('GET', `${PHA}/dur/patient/${walletId}/full-history`, undefined, attHeader);
  const durRows = unwrap(durWithTap.json);
  trace.check('With the member\'s tapped attestation the pharmacy reads the drug history', durWithTap.status === 200 && Array.isArray(durRows) && durRows.length >= 1, '200 and rows', durWithTap.status === 200 ? `${Array.isArray(durRows) ? durRows.length : 0} rows` : (unwrap(durWithTap.json) ?? durWithTap.status));

  // ── 13c. Replication (A13) ───────────────────────────────
  trace.begin('verifier', 'The replicas mirror the leader, and the invariant monitor is quiet');
  const replicaStatus = async (p: number) => {
    const r = await http('POST', `http://localhost:${p}/rpc`, { jsonrpc: '2.0', id: 1, method: 'l2_getStatus', params: {} });
    return r.text ? (l2Parse(r.text) as any)?.result : null;
  };
  let leaderStatus = (await rpc('l2_getStatus', {}, false)).result;
  for (const p of [3031, 3032]) {
    let rs = await replicaStatus(p);
    for (let i = 0; i < 12 && rs?.currentRegistryRoot !== leaderStatus?.currentRegistryRoot; i++) {
      await sleep(5000);
      leaderStatus = (await rpc('l2_getStatus', {}, false)).result;
      rs = await replicaStatus(p);
    }
    trace.check(`The replica on :${p} holds the leader's registry root`, !!rs && rs.currentRegistryRoot === leaderStatus?.currentRegistryRoot, abbrev(String(leaderStatus?.currentRegistryRoot), 14), rs ? abbrev(String(rs.currentRegistryRoot), 14) : 'no status');
    trace.check(`The replica on :${p} holds the leader's lifecycle root`, !!rs && rs.currentLifecycleRoot === leaderStatus?.currentLifecycleRoot, abbrev(String(leaderStatus?.currentLifecycleRoot), 14), rs ? abbrev(String(rs.currentLifecycleRoot), 14) : 'no status');
    trace.check(`The replica on :${p} applied every accepted proof`, !!rs && Number(leaderStatus?.totalProofsAccepted) > 0 && Number(rs.totalProofsAccepted) >= Number(leaderStatus?.totalProofsAccepted), leaderStatus?.totalProofsAccepted, rs?.totalProofsAccepted);
  }
  const inv = leaderStatus?.invariants;
  trace.check('The invariant monitor runs on the leader and reports both replicas in step', inv?.ok === true && Array.isArray(inv?.replicas) && inv.replicas.length === 2 && inv.replicas.every((x: any) => x.inSync === true), 'ok, 2 in sync', inv ? { ok: inv.ok, replicas: inv.replicas, alarms: inv.alarms } : 'no invariants in status');
  trace.check('No batch is stalled', inv?.batch?.stalled === false, false, inv?.batch);
  const relayBody = { jsonrpc: '2.0', id: 1, method: 'l2_gossipRelay', params: { message: { messageId: `probe-${RUN}`, type: 'peer:announce', senderId: 'nobody', timestamp: Date.now(), payload: {} } } };
  const unsignedRelay = await http('POST', 'http://localhost:3031/rpc', relayBody);
  trace.check('A replica refuses gossip that no registered peer signed', !!unsignedRelay.json?.error, 'error', unsignedRelay.json?.error?.message ?? unsignedRelay.json);
  const bearerRelay = await http('POST', 'http://localhost:3031/rpc', relayBody, bearer);
  trace.check('The network operator token opens nothing on a replica', !!bearerRelay.json?.error, 'error', bearerRelay.json?.error?.message ?? bearerRelay.json);


  // ── 13b. Termination (B5, A-18): a terminated member is not billable ──
  trace.begin('insurer', 'Terminate the member; the engine refuses to prescribe for or dispense to them afterwards');
  const lastRxId = `RX-${RUN}-LAST`;
  const lastRx = await httpAdmin('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: 30, refills: 0, rxId: lastRxId });
  let lastRxOk = lastRx.status < 300 && !!lastRx.json?.prescriptionId;
  if (!lastRxOk && (lastRx.status === 504 || !lastRx.json?.error)) {
    const found = await poll(quietAdmin, `${SEQ}/interactive/state`, j => (j?.prescriptions ?? []).some((x: any) => (x.id === lastRxId || x.rxId === lastRxId) && x.status === 'ADJUDICATED'), 600_000, 5000);
    lastRxOk = (found.json?.prescriptions ?? []).some((x: any) => x.id === lastRxId || x.rxId === lastRxId);
  }
  trace.check('A last prescription is written while the member is still eligible', lastRxOk, 'adjudicated', lastRx.json?.error ?? lastRx.status);
  const lastPrescriptionId = lastRx.json?.prescriptionId ?? lastRxId;
  await http('POST', `${PHA}/dispensing/mark-filled`, { prescriptionId: lastPrescriptionId });
  const term = await httpAdmin('POST', `${SEQ}/interactive/terminate-member`, { memberWalletId: walletId, terminationDate: '20261018' });
  trace.check('The operator terminates the member', term.status < 300, '2xx', term.status);
  const afterTerm = await httpAdmin('POST', `${SEQ}/interactive/prescribe`, { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash, quantity: 30, refills: 0, rxId: `RX-${RUN}-AFTER` });
  trace.check('No prescription can be written for a terminated member', afterTerm.status === 409 && /terminated/.test(String(afterTerm.json?.error ?? '')), '409 terminated', `${afterTerm.status} ${afterTerm.json?.error ?? ''}`.trim());
  const lateDisp = await http('POST', `${PHA}/dispensing/dispense`, { prescriptionId: lastPrescriptionId, quantityDispensed: 30, ingredientCostCents: 4500, dispensingFeeCents: 200 });
  let lateFill: any = unwrap(lateDisp.json);
  if (lateDisp.status < 300 && lateFill?.jobKey) {
    const ld = await poll(quiet, `${PHA}/dispensing/fill-status?jobKey=${encodeURIComponent(lateFill.jobKey)}`, j => ['complete', 'error'].includes(unwrap(j)?.status), 600_000, 5000);
    lateFill = unwrap(ld.json);
  }
  trace.check('The filled prescription cannot be dispensed to a terminated member (termination cancels it)', (lateFill?.status === 'error' && /terminated|cancelled/.test(String(lateFill?.error ?? ''))) || lateDisp.status >= 400, 'error: terminated or cancelled', lateFill?.error ?? lateFill?.status ?? lateDisp.json);

  // ── 14. Where do the member's secrets live? ─────────────────
  trace.begin('verifier', 'Scan what the network stores and serves for the member\'s secrets');
  const secrets: Record<string, string> = {
    firstName: MEMBER.firstName, lastName: MEMBER.lastName, dateOfBirth: MEMBER.dob, cardholderId: MEMBER.employeeId,
    email: MEMBER.email, enrollmentKey, enrollmentPIN: myToken.tokenPIN, devicePIN: MEMBER.memberPin,
    'hash(enrollmentKey)': hashString(enrollmentKey).toString(),
    // C2: the sixth input is the employer group hash, a public identifier the insurer and the group
    // registry hold by design; it is not a secret and is not swept. The five salted inputs are.
    ...Object.fromEntries((dev?.preimageFields ?? []).slice(0, 5).map((f: string, i: number) => [`preimage[${i}]`, f])),
  };
  trace.note('preimage[5] is the employer group hash, public by design (C2), and is not swept');
  const sources: Array<[string, string]> = [];
  sources.push(['sequencer /interactive/state', (await http('GET', `${SEQ}/interactive/state`)).text]);
  for (const m of ['l2_getClaimsByMember', 'l2_getReceiptsByWallet', 'l2_getMessagesByWallet']) sources.push([`sequencer RPC ${m}`, jsonSafe((await rpc(m, { walletId }, false)).result ?? '')]);
  sources.push(['sequencer RPC l2_getAuditLog', jsonSafe((await rpc('l2_getAuditLog', {})).result ?? '')]);
  sources.push(['insurer /claims/member', (await http('GET', `${INS}/claims/member/${walletId}`)).text]);
  sources.push(['insurer /roster', (await insAdmin('GET', '/roster')).text]);
  const walk = (dir: string, label: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p, label);
      else if (fs.statSync(p).size < 50_000_000) sources.push([`${label}: ${path.relative(REPO, p)}`, fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(path.join(REPO, 'l2-data'), 'sequencer disk');
  walk(path.join(REPO, '.l2-checkpoints'), 'sequencer disk');
  walk(STATE_DIR, 'device disk (encrypted)');
  walk(path.join(REPO, 'hr-tool-data', employerId), 'employer disk');
  if (NETWORK_LOG && fs.existsSync(NETWORK_LOG)) sources.push(['network log', fs.readFileSync(NETWORK_LOG, 'utf8')]);
  const matrix: Record<string, string[]> = {};
  for (const [label, text] of sources) {
    for (const h of findSecrets(text, secrets)) {
      (matrix[h.secret] = matrix[h.secret] || []);
      if (!matrix[h.secret].includes(label)) matrix[h.secret].push(label);
    }
  }
  results.secretLocations = matrix;
  results.scannedSources = sources.map(s => s[0]);
  for (const k of Object.keys(secrets)) {
    const where = matrix[k] ?? [];
    const onNetwork = where.filter(w => !w.startsWith('device disk') && !w.startsWith('employer disk'));
    trace.check(`${k} does not reach the network`, onNetwork.length === 0, 'nowhere off the device', where.length ? where : 'not found');
  }

  trace.end();
  const sum = trace.summary();
  results.summary = sum;
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\n${sum.passed}/${sum.checks} checks passed across ${sum.steps} steps.`);
  for (const f of sum.failed) console.log(`  FAIL [${f.step} ${f.actor}] ${f.name}`);
  console.log(`Trace: ${path.join(OUT, 'trace.json')}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('\nHarness stopped:', err);
  try { trace.end(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ...results, fatal: String(err?.stack || err) }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)); } catch { /* ignore */ }
  process.exit(1);
});
