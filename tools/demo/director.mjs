#!/usr/bin/env node
/**
 * The zpk.care walkthrough: one claim, end to end, from the insurer publishing a plan and HR picking it to the
 * member seeing her claim, played on every real dashboard by AI actors (real clicks, real typing), shown one screen
 * at a time, with a narrator explaining what happens underneath and a whiteboard where the equations are written
 * stroke by stroke. Adapted from SwapStreet's site-e2e/demo-bid.mjs: the pre-render loop, T0 and T1, the deferred /
 * until / fail / watchdog pattern, the encode settings, the srt and the player page carry over; MetaMask, the chain,
 * the prompt pump and the xstack grid do not.
 *
 * Recording: one headless Chromium, one browser context per person (insurer analyst, HR admin, member phone,
 * prescriber, pharmacist, network view) plus the director's own offline context (whiteboard, status card). Every
 * page stays open on its real dashboard and records itself; lib/camera.mjs logs which one is on camera, and
 * lib/post.mjs builds one film from that cut list (sped-up silent waits get a badge). All voices share one track;
 * one person speaks at a time (lib/narrate.mjs).
 *
 *   node director.mjs --rehearsal [--stop-after <scene>]      fast stage, no voices (captions for an estimated time)
 *   node director.mjs --voices narrator=maya:narrator,hr=maya:hr,analyst=maya:analyst,member=turbo:af_heart,prescriber=maya:prescriber,pharmacist=orpheus:dan
 *   node director.mjs --plan                                  check the script and print the scene plan (offline)
 *   node director.mjs --post-only demo-out/<stamp>            rebuild the film from a take's raw recordings
 * Options: --out <dir>, --no-post, --hr-port 5050, --headed, --stop-after <scene key> (see lib/claim-script.mjs SCENES)
 *
 * Environment (source ../../scripts/dev/live-env.sh first): ZKTRIDENT_ADMIN_TOKEN (the operator token: the director's
 * read-only reads and the Leviathan dashboard's header), ZKTRIDENT_INSURER_ADMIN_TOKEN (else derived as the launcher
 * does), ZKTRIDENT_TRANSITION_VK_HASH (the gate board says this take pins the verification key), ZPK_DEMO_TOOLS,
 * PW_CHROMIUM_PATH, HF_HUB_OFFLINE, ZPK_DEMO_OUT. URLs: ZPK_DEMO_SEQ_URL, ZPK_DEMO_INSURER_URL, ZPK_DEMO_MEMBER_URL,
 * ZPK_DEMO_PRESCRIBER_URL, ZPK_DEMO_PHARMACY_URL (defaults 127.0.0.1:3030/4004/4001/4002/4003).
 *
 * Secrets stay off camera: the insurer token arrives through storageState, the operator token as a request header
 * (context.route), the tenant token, codes, PINs and passphrases through page.evaluate into masked fields
 * (stage.fillSecret); the activation code (shown once on the marketplace page, redacted by lib/masks.mjs) is kept from
 * the apply answer; the director keeps them in memory only and never logs or writes them. The director reads responses
 * (allowlisted paths and fields) and never request bodies, and it never writes through the API. It delays three
 * onboarding requests in the member's browser (holdRequest: the script's route holds) and never changes one.
 *
 * Amounts: every line that says one is filled from the claim (lib/claim-script.mjs). Lines are rendered before T0 from
 * castOf's prediction; once the fill proof is done the director reads the engine's own answer (learnClaim) and speaks
 * every later line from it, and a take stops there if the claim breaks what the lines say or needs a voice that was not
 * rendered. Lines marked PRICING wait on the pricing commit.
 *
 * Selectors come from the screen audit (prepare:screens), checked against the dashboard sources at 9f5099d (the
 * screens fixed for this film); the ones that still depend on a rehearsal or on the pricing commit are marked
 * TODO(selector). A failed take needs a new genesis boot.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseVoices, stampNow } from './lib/args.mjs';
import { launchBrowser, chromiumPath } from './lib/browser.mjs';
import { stage } from './lib/stage.mjs';
import { Narrator, synth, stopEngines, enginesRunning, knownVoice, clipPath, OUT_ROOT, VOICE_CACHE } from './lib/narrate.mjs';
import { openWhiteboard, directorContext, SCREEN } from './lib/whiteboard.mjs';
import { openStatusCard } from './lib/status-card.mjs';
import { makeBoardRunner, checkBoardAction } from './lib/board-beats.mjs';
import { Camera } from './lib/camera.mjs';
import { assemble } from './lib/post.mjs';
import { makeReads, insurerAdminToken } from './lib/reads.mjs';
import { Sniffer, SNIFF_RULES } from './lib/sniff.mjs';
import { applyMasks } from './lib/masks.mjs';
import { writeTakeAssets } from './lib/assets.mjs';
import {
  PEOPLE, ACTS, SCENES, BEATS, SCRIPT_STATUS, PRICING_STATUS, castOf, storyLines, allLines, withClaim, claimDiffs, storyChecks, screenCards
} from './lib/claim-script.mjs';
import { EQUATIONS } from './lib/equations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const args = parseArgs();
const REHEARSAL = !!args.rehearsal;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
let logFile = null;
const log = (s) => {
  const line = `[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${s}`;
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, line + '\n');
};
const short = (h) => (h ? (String(h).length > 16 ? `${String(h).slice(0, 8)}…${String(h).slice(-6)}` : String(h)) : '--');
const cents = (n) => (n == null ? '--' : `$${(Number(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// ------------------------------------------------------------------ the cast, the script, the voices
// every page: a 1920x1080 viewport drawn at html { zoom: 1.5 } (a 1280x720 layout, recorded crisp at 1080p;
// lib/whiteboard.mjs SCREEN says why a deviceScaleFactor does not work for the recording)
const VIEW = SCREEN.viewport;
const VIDEO = SCREEN.video;
const VOICE_DEFAULT = Object.freeze({ narrator: 'maya:narrator', hr: 'maya:hr', analyst: 'maya:analyst', member: 'turbo:af_heart', prescriber: 'maya:prescriber', pharmacist: 'orpheus:dan' });
const voiceArg = parseVoices(args.voices);
for (const k of Object.keys(voiceArg)) if (!PEOPLE[k]) throw new Error(`--voices: no person "${k}" (${Object.keys(PEOPLE).join(', ')})`);
const PERSONS = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [k, { ...p, voice: voiceArg[k] || VOICE_DEFAULT[k] }]));
if (!REHEARSAL) for (const p of Object.values(PERSONS)) if (!knownVoice(p.voice)) throw new Error(`${p.name}: ${p.voice} is not a voice lib/narrate.mjs knows`);

/**
 * The cast and its lines. `cast` starts as castOf's prediction and becomes the engine's own claim once the fill proof
 * is done (learnClaim); `S` is rebuilt from it then. `c` keeps the names, the plan and the drug, which never change.
 */
let cast = castOf();
let S;
try {
  S = storyLines(cast);
} catch (e) {
  console.error(`lib/claim-script.mjs: ${e.message}`);
  process.exit(1);
}
const c = cast;
const CARDS = screenCards(cast);
const stopAfter = args['stop-after'] ? String(args['stop-after']) : null;
if (stopAfter && !SCENES.some((s) => s.key === stopAfter)) throw new Error(`--stop-after: no scene "${stopAfter}" (${SCENES.map((s) => s.key).join(', ')})`);
const RUN = stopAfter ? SCENES.slice(0, SCENES.findIndex((s) => s.key === stopAfter) + 1) : SCENES.slice();

/** The script's problems that must stop a take before T0, and the gaps that only warrant a warning. */
function checkScript() {
  const problems = [];
  const gaps = [];
  for (const sc of SCENES) {
    const beats = S[sc.key];
    if (!beats) { problems.push(`scene ${sc.key}: no lines`); continue; }
    if (sc.kind !== 'board' && !BEATS[sc.key]) problems.push(`scene ${sc.key}: no beats in BEATS (the director speaks a ${sc.kind} scene beat by beat)`);
    for (const [beat, lines] of Object.entries(beats)) {
      for (const l of lines) {
        if (!PEOPLE[l.who]) problems.push(`${sc.key}.${beat}: unknown speaker "${l.who}"`);
        if (!l.text || !String(l.text).trim()) problems.push(`${sc.key}.${beat}: an empty line`);
        if (l.board && l.board.length && sc.kind !== 'board') problems.push(`${sc.key}.${beat}: board actions in a ${sc.kind} scene (the board is off camera there)`);
        for (const a of l.board || []) {
          try { checkBoardAction(a); } catch (e) { problems.push(`${sc.key}.${beat}: ${e.message}`); }
        }
      }
    }
    for (const b of BEATS[sc.key] || []) if (!beats[b]) gaps.push(`${sc.key}.${b}`);
  }
  for (const p of storyChecks(cast)) problems.push(`the predicted claim: ${p}`);
  return { problems, gaps };
}

if (args.plan) {
  const { problems, gaps } = checkScript();
  const all = allLines(cast);
  console.log(`zpk.care walkthrough: ${SCENES.length} scenes, script ${SCRIPT_STATUS} (pricing ${PRICING_STATUS}), ${all.length} lines, ${EQUATIONS.length} equation cards`);
  let act = null;
  for (const sc of SCENES) {
    if (sc.act !== act) { act = sc.act; console.log(`\nAct ${act}: ${ACTS[act]}`); }
    const lines = Object.values(S[sc.key] || {}).flat();
    const who = [...new Set(lines.map((l) => l.who))];
    const cards = [...new Set(lines.flatMap((l) => (l.board || []).filter((a) => a.do === 'write').map((a) => a.card)))];
    const priced = lines.filter((l) => l.pricing).length;
    console.log(`  ${sc.key.padEnd(20)} ${sc.kind.padEnd(7)} ${sc.camera.padEnd(21)} ${String(lines.length).padStart(2)} lines, ${who.length} speaker${who.length === 1 ? ' ' : 's'} (${who.join(', ')})`
      + `${cards.length ? `; cards ${cards.join(', ')}` : ''}${priced ? `; ${priced} PRICING` : ''}  [script ${sc.script}] ${sc.title}`);
  }
  console.log(`\nVoices: ${Object.values(PERSONS).map((p) => `${p.key}=${p.voice}`).join(', ')}`);
  console.log(`Cast: ${cast.plan.id} (${cast.say.deductible} deductible, ${cast.say.copay} copay), ${cast.employer.company}, ${cast.drug.name} x${cast.drug.quantity}`);
  console.log(`Claim (${cast.claim.source}, said from the engine's answer in a take): ingredient ${cast.say.ingredient} + fee ${cast.say.fee} = ${cast.say.total}; patient ${cast.say.patientPay}, plan ${cast.say.planPay}, deductible credit ${cast.say.credit}`);
  const priced = all.filter((l) => l.pricing);
  if (priced.length) console.log(`\nLines marked PRICING (confirm after the pricing commit): ${priced.length}\n  ${priced.map((l) => `${l.scene}.${l.beat} (${l.who}): ${l.text.length > 96 ? l.text.slice(0, 95) + '…' : l.text}`).join('\n  ')}`);
  if (gaps.length) console.log(`\nBeats the director calls that the script leaves out (skipped): ${gaps.join(', ')}`);
  if (problems.length) { console.log(`\nPROBLEMS:\n  ${problems.join('\n  ')}`); process.exit(1); }
  console.log('\nThe script checks out.');
  process.exit(0);
}

if (args['post-only']) {
  const dir = path.resolve(String(args['post-only']));
  const take = JSON.parse(fs.readFileSync(path.join(dir, 'take.json'), 'utf8'));
  await assemble({ outDir: dir, take, log });
  process.exit(0);
}

// ------------------------------------------------------------------ the network and the secrets
const url = (env, def) => String(process.env[env] || def).replace(/\/+$/, '');
const URLS = Object.freeze({
  seq: url('ZPK_DEMO_SEQ_URL', 'http://127.0.0.1:3030'),
  insurer: url('ZPK_DEMO_INSURER_URL', 'http://127.0.0.1:4004'),
  member: url('ZPK_DEMO_MEMBER_URL', 'http://127.0.0.1:4001'),
  prescriber: url('ZPK_DEMO_PRESCRIBER_URL', 'http://127.0.0.1:4002'),
  pharmacy: url('ZPK_DEMO_PHARMACY_URL', 'http://127.0.0.1:4003')
});
/** In memory only. Never logged, never written. */
const secrets = {
  operator: process.env.ZKTRIDENT_ADMIN_TOKEN || '',
  insurer: insurerAdminToken(),
  devicePin: String(crypto.randomInt(100000, 999999)),
  recoveryPin: crypto.randomBytes(6).toString('base64url'),
  hrPassphrase: crypto.randomBytes(12).toString('base64url'),
  activationCode: '',
  tenantToken: '',
  code: '',
  pin: ''
};
if (!secrets.operator) throw new Error('ZKTRIDENT_ADMIN_TOKEN is not set: source ../../scripts/dev/live-env.sh (the token the network booted with)');
if (!secrets.insurer) throw new Error('no insurer admin token: set ZKTRIDENT_INSURER_ADMIN_TOKEN as the network was booted');
/** What the take learns that is not secret (written to take.json). */
const take = { walletId: null, employerNodeUrl: null, hrToolUrl: null, applicationId: null, claim: null, timings: {} };

const OUT = path.resolve(args.out || path.join(OUT_ROOT, `${stampNow()}${REHEARSAL ? '-rehearsal' : ''}`));
const RAW = path.join(OUT, 'raw');
fs.mkdirSync(RAW, { recursive: true });
logFile = path.join(OUT, 'director.log');
const reads = makeReads({ seqUrl: URLS.seq, memberUrl: URLS.member, operatorToken: secrets.operator, log: () => {} });
const sniffer = new Sniffer({ log });
/**
 * The pharmacy page's fill-status answers (it polls every 5 s): the engine's claim, read once the fill proof is done.
 * Amounts and status only; the pharmacy's answer carries no identity.
 */
const FILL_FIELDS = ['adjudication.ingredientCostCents', 'adjudication.dispensingFeeCents', 'adjudication.totalCostCents', 'adjudication.patientPayCents',
  'adjudication.planPayCents', 'adjudication.phase', 'accumulator.before', 'accumulator.after', 'quantityDispensed'];
const FILL_RULE = Object.freeze({
  name: 'fill', method: 'GET', path: /\/dispensing\/fill-status$/, secret: false,
  // the job's result is the engine's fill answer, or (older relays) that answer wrapped once more in { result }
  fields: ['data.status', 'data.error', ...FILL_FIELDS.map((f) => `data.result.${f}`), ...FILL_FIELDS.map((f) => `data.result.result.${f}`)]
});
const WATCH_RULES = Object.freeze([...SNIFF_RULES, FILL_RULE]);
/** An error that stops an until() at once (a failure the page reports), instead of counting as "not yet". */
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });
const until = async (what, fn, { timeout = 120000, every = 1000 } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch((e) => { if (e && e.fatal) throw e; return null; });
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what} did not happen within ${Math.round(timeout / 1000)} s`);
    await sleep(every);
  }
};
const visible = (loc) => loc.first().isVisible().catch(() => false);
const timed = async (name, fn) => {
  const a = Date.now();
  try { return await fn(); } finally { take.timings[name] = Date.now() - a; log(`timing: ${name} ${((Date.now() - a) / 1000).toFixed(1)} s`); }
};
/** A problem a rehearsal only reports and a take must not record past. */
const mustHold = (msg) => { if (REHEARSAL) log(`WARNING: ${msg}`); else throw fatal(msg); };

// ------------------------------------------------------------------ pre-roll 1: the script, the voices (before anything records)
{
  const { problems, gaps } = checkScript();
  if (problems.length) throw new Error(`the script has problems:\n  ${problems.join('\n  ')}`);
  if (gaps.length) log(`script: beats left out (skipped): ${gaps.join(', ')}`);
  if (SCRIPT_STATUS === 'placeholder') log('script: lib/claim-script.mjs still holds PLACEHOLDER lines');
  if (PRICING_STATUS !== 'final') log(`script: ${allLines(cast).filter((l) => l.pricing).length} lines marked PRICING wait on the pricing commit; the claim is said from the engine's answer`);
}
log(`take: ${OUT}${REHEARSAL ? ' (rehearsal: fast stage, no voices)' : ''}; scenes ${RUN[0].key} .. ${RUN[RUN.length - 1].key}`);
log(`chromium: ${chromiumPath()}`);
// fail fast if the network is not up at all (the full readiness wait comes after the voices)
const status0 = await reads.status().catch((e) => { throw new Error(`the sequencer at ${URLS.seq} does not answer (${e.message}): boot the network first (README)`); });
// what the lines say about this boot must be true of it
if (status0 && status0.batchIntervalMs && Math.round(status0.batchIntervalMs / 1000) !== c.network.batchSeconds) {
  mustHold(`the sequencer builds a batch every ${Math.round(status0.batchIntervalMs / 1000)} s; the batch scene says ${c.network.batchSeconds} s (castOf network.batchSeconds)`);
}
if (!process.env.ZKTRIDENT_TRANSITION_VK_HASH) mustHold('ZKTRIDENT_TRANSITION_VK_HASH is not set in this shell, and the gate board says "this take pins one": boot with it set (README)');
if (!REHEARSAL) {
  log('voices: making sure every line is rendered (voice-check.mjs renders and checks them before a take)');
  const lines = allLines(cast, { upTo: stopAfter });
  let made = 0;
  for (const l of lines) {
    const p = PERSONS[l.who];
    const before = Date.now();
    await synth(l.text, { voice: p.voice, mood: l.mood || p.mood, cacheDir: VOICE_CACHE });
    if (Date.now() - before > 400) made++;
  }
  if (made) log(`voices: ${made} line(s) were rendered now and have not been checked with voice-check.mjs`);
  stopEngines();
  if (enginesRunning()) throw new Error('a voice engine is still running; the proofs need the CPU');
}

// ------------------------------------------------------------------ pre-roll 2: the network
log('network: waiting until the engine has compiled every circuit');
await timed('network-ready', () => until('the network compiling its circuits', async () => (await reads.compiled()).compiled === true, { timeout: 1800000, every: 10000 }));
const phase = await reads.memberPhase();
if (phase !== 'awaiting_token') throw new Error(`the member device is in phase "${phase}", not awaiting_token: boot from genesis (README: genesis boot) before a take`);

// the HR Tool runs on the employer's own machine; the director starts it the way the harness does (run.ts:65-82)
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
let hrChild = null;
let hrErr = '';
{
  const port = Number(args['hr-port'] || 5050);
  if (!(await portFree(port))) throw new Error(`port ${port} is busy (an HR Tool from an earlier take?): stop it or pass --hr-port`);
  hrChild = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'tools', 'hr-tool-server.ts')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HR_TOOL_DATA_DIR: path.join(OUT, 'hr-tool-data') },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  hrChild.stderr.on('data', (d) => { hrErr = (hrErr + d).slice(-2000); });
  take.hrToolUrl = `http://127.0.0.1:${port}`;
  await until('the HR Tool to start', async () => (await fetch(`${take.hrToolUrl}/api/session`, { signal: AbortSignal.timeout(3000) })).ok, { timeout: 60000, every: 500 })
    .catch((e) => { throw new Error(`${e.message}: ${hrErr.slice(-400)}`); });
  log(`HR Tool: ${take.hrToolUrl} (data under the take folder)`);
}
const stopHrTool = () => { if (hrChild && !hrChild.killed) { try { hrChild.kill(); } catch {} } hrChild = null; };
process.on('exit', stopHrTool);
process.on('SIGINT', () => { stopHrTool(); process.exit(130); });

const assets = writeTakeAssets(cast, path.join(OUT, 'assets'));

// ------------------------------------------------------------------ pre-roll 3: the browser, the cameras
const browser = await launchBrowser({ headless: !args.headed });
const narrator = new Narrator({ cacheDir: VOICE_CACHE, log, cacheOnly: !REHEARSAL, silent: REHEARSAL });
const camera = new Camera({ narrator, log });
narrator.onTurnStart = (at) => camera.endSpeedUp(at);

const directorCtx = await directorContext(browser, { recordVideoDir: path.join(RAW, 'director'), viewport: VIEW, videoSize: VIDEO });
const board = await openWhiteboard({ browser, context: directorCtx, viewport: VIEW, log });
camera.register('board', { page: board.page, videoStartedAt: board.startedAt, label: 'Whiteboard' });
const status = await openStatusCard({ browser, context: directorCtx, viewport: VIEW, log });
camera.register('status', { page: status.page, videoStartedAt: status.startedAt, label: 'Status card (drawn by the director)' });
await board.prepare(EQUATIONS.map((e) => ({ id: `eq-${e.key}`, latex: e.latex })));
log(`whiteboard: ${EQUATIONS.length} equations typeset (MathJax ${board.mathjax})`);
const boardRunner = makeBoardRunner({ board, log });

const CONTEXTS = {
  insurer: { masks: ['insurer'], storage: () => ({ cookies: [], origins: [{ origin: new URL(URLS.insurer).origin, localStorage: [{ name: 'zkt_insurer_admin_token', value: secrets.insurer }] }] }) },
  employer: { masks: ['marketplace', 'employer', 'hrtool'], clipboard: true },
  member: { masks: ['member'], clipboard: true },
  prescriber: { masks: ['prescriber'] },
  pharmacy: { masks: ['pharmacy'], clipboard: true },
  network: { masks: ['network'], operatorHeader: true }
};
const SHOTS = {
  insurer: { ctx: 'insurer', url: () => `${URLS.insurer}/`, label: 'Insurer dashboard', persona: 'analyst' },
  'employer:marketplace': { ctx: 'employer', url: () => `${URLS.insurer}/marketplace/`, label: 'Employer marketplace', persona: 'hr' },
  'employer:node': { ctx: 'employer', url: () => take.employerNodeUrl, label: 'Employer dashboard (tenant node)', persona: 'hr', late: true },
  'employer:hrtool': { ctx: 'employer', url: () => take.hrToolUrl, label: 'HR Tool', persona: 'hr' },
  member: { ctx: 'member', url: () => `${URLS.member}/`, label: 'Member app (the phone)', persona: 'member' },
  prescriber: { ctx: 'prescriber', url: () => `${URLS.prescriber}/`, label: 'Prescriber dashboard', persona: 'prescriber' },
  pharmacy: { ctx: 'pharmacy', url: () => `${URLS.pharmacy}/`, label: 'Pharmacy dashboard', persona: 'pharmacist' },
  network: { ctx: 'network', url: () => `${URLS.seq}/`, label: 'Leviathan sequencer dashboard', badge: { name: 'Sequencer network', role: 'Leviathan dashboard', color: '#a3e635' } }
};
const contexts = new Map();
const open = new Map(); // shot key -> { page, st, videoStartedAt }

async function contextFor(name) {
  if (contexts.has(name)) return contexts.get(name);
  const def = CONTEXTS[name];
  const ctx = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCREEN.deviceScaleFactor,
    locale: 'en-US',
    recordVideo: { dir: path.join(RAW, name), size: VIDEO },
    storageState: def.storage ? def.storage() : undefined,
    permissions: def.clipboard ? ['clipboard-read', 'clipboard-write'] : []
  });
  await applyMasks(ctx, def.masks, { zoom: SCREEN.zoom });
  if (def.operatorHeader) {
    // the Leviathan dashboard's stream and RPC carry the operator token as a header; it is never typed or shown
    const seqOrigin = new URL(URLS.seq).origin;
    await ctx.route((u) => u.origin === seqOrigin && (u.pathname.startsWith('/events') || u.pathname === '/rpc' || u.pathname.startsWith('/viz/')),
      (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${secrets.operator}` } }));
  }
  contexts.set(name, ctx);
  return ctx;
}

/**
 * Native dialogs. The marketplace now shows the activation code on its page (redacted, lib/masks.mjs) instead of an
 * alert; this handler stays for the prompts that can still appear (the rekey prompt asks for the activation code,
 * the member app can ask for the device PIN) and accepts any other dialog. Nothing in a dialog is drawn or logged.
 */
async function onDialog(dialog) {
  const msg = dialog.message();
  const code = msg.split(/\r?\n/).map((l) => l.trim()).find((l) => /^\S+\.\S+$/.test(l) && !/\s/.test(l));
  if (code) secrets.activationCode = code;
  if (dialog.type() === 'prompt' && /activation code/i.test(msg) && secrets.activationCode) await dialog.accept(secrets.activationCode).catch(() => {});
  else if (dialog.type() === 'prompt' && /device PIN/i.test(msg)) await dialog.accept(secrets.devicePin).catch(() => {});
  else await dialog.accept().catch(() => {});
  log(`dialog (${dialog.type()}) accepted${code ? '; the activation code is kept in memory only' : ''}`);
}

async function openShot(key) {
  if (open.has(key)) return open.get(key);
  const def = SHOTS[key];
  const target = def.url();
  if (!target) throw new Error(`no address yet for ${def.label}`);
  const ctx = await contextFor(def.ctx);
  const page = await ctx.newPage();
  const videoStartedAt = Date.now();
  page.on('dialog', onDialog);
  page.on('pageerror', (e) => log(`${key} page error: ${String(e.message).split('\n')[0]}`));
  sniffer.watch(page, WATCH_RULES);
  const p = def.persona ? PERSONS[def.persona] : null;
  const badge = def.badge || { name: p.name, role: p.role, color: p.color };
  const st = await stage(page, { viewport: VIEW, badge, fast: REHEARSAL });
  camera.register(key, { page, videoStartedAt, label: def.label });
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await st.glideTo({ x: VIEW.width / 2, y: VIEW.height / 2 }, { ms: 50 });
  const entry = { page, st, videoStartedAt };
  open.set(key, entry);
  log(`opened ${def.label}`);
  return entry;
}
async function closeShot(key) {
  const e = open.get(key);
  if (!e) return;
  open.delete(key);
  await e.page.close().catch(() => {});
  log(`closed ${SHOTS[key].label}`);
}
const shot = (key) => {
  const e = open.get(key);
  if (!e) throw new Error(`${key} is not open`);
  return e;
};

// ------------------------------------------------------------------ holds (a delay in the browser, never a change)
/**
 * Holds the page's first request to `pathname` until release(): it waits in the browser and then goes out exactly as
 * the page made it, so the status line the narrator is explaining stays on screen (the script's route holds). Later
 * requests to the same path pass at once, and a hold lets go by itself after `maxMs`, so a stuck director never
 * strands the page.
 */
async function holdRequest(page, pathname, { maxMs = 15 * 60000 } = {}) {
  let letGo;
  const gate = new Promise((r) => { letGo = r; });
  const timer = setTimeout(() => letGo(), maxMs);
  let held = null;
  const match = (u) => u.pathname === pathname;
  const handler = async (route) => {
    if (held) return route.continue().catch(() => {});
    held = gate.then(() => route.continue().catch(() => {}));
    await held;
  };
  await page.route(match, handler);
  return {
    async release() {
      clearTimeout(timer);
      letGo();
      if (held) await held;
      await page.unroute(match, handler).catch(() => {});
    }
  };
}
/** The onboarding requests held in the member's browser: generate-key and redeem in 'enroll', enroll until 'enrolling'. */
const holds = {};

// ------------------------------------------------------------------ speaking
const warned = new Set();
function linesOf(scene, beat) {
  const b = S[scene] && S[scene][beat];
  if (!b) {
    if (!warned.has(`${scene}.${beat}`)) { warned.add(`${scene}.${beat}`); log(`script: no beat ${scene}.${beat}; skipped`); }
    return [];
  }
  return b;
}
/** Speaks one beat (every line in it, in order), with the line's board actions running beside it. */
async function speak(scene, beat) {
  for (const line of linesOf(scene, beat)) {
    await narrator.say(() => camera.page(), PERSONS[line.who], line, { during: boardRunner.during(line) });
  }
}
async function speakAll(scene) {
  for (const beat of Object.keys(S[scene] || {})) await speak(scene, beat);
}
/** A lower-third (lib/claim-script.mjs screenCards) on one person's page, hidden again after `ms`. */
const show = (key, def, ms = 10000) => shot(key).st.card(def.title, def.lines, { ms, color: def.color });
/** The same lower-third on the director's status page (its overlay draws the same card). */
async function showOnStatus(def, ms = 12000) {
  await status.page.evaluate(([t, l, col]) => window.__demoCard && window.__demoCard(t, l, col), [def.title, def.lines, def.color || null]).catch(() => {});
  setTimeout(() => { status.page.evaluate(() => window.__demoCard && window.__demoCard(null)).catch(() => {}); }, ms);
}
const toast = (pg, text) => pg.locator('#toast-container .toast', { hasText: text });
async function closeDetail(pg) {
  // the pharmacy's cards open a detail view on any click inside them, including their own buttons
  const close = pg.locator('#ws-modal-overlay:not(.hidden) #ws-modal-close');
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
}
async function selectByText(select, re) {
  const value = await select.evaluate((el, src) => {
    const rx = new RegExp(src, 'i');
    const o = [...el.options].find((x) => x.value && rx.test(x.textContent || ''));
    return o ? o.value : null;
  }, re);
  if (!value) throw new Error(`no option matching /${re}/i`);
  await select.selectOption(value);
  return value;
}

let enrollRetries = 0;
/** Retry resumes enrollment from the device's phase (9f5099d); a phone that fails a third time stops the take. */
async function retryIfFailed(pg) {
  const retry = pg.locator('#ob-retry');
  if (!(await visible(retry))) return false;
  const why = (await pg.locator('#onboard-body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
  if (++enrollRetries > 2) throw fatal(`enrollment failed on the phone after ${enrollRetries - 1} retries: ${why}`);
  log(`enrollment: the phone reports a failure (${why}); Retry ${enrollRetries} resumes from the device's phase`);
  await retry.click().catch(() => {});
  return true;
}

/**
 * Review PDF fetches the CP 575 with the insurer token and opens it in a new tab (9f5099d). The tab is filmed only
 * when the browser drew the letter in its PDF viewer; otherwise it is closed and the camera stays on the row.
 * TODO(selector): confirm in a rehearsal that headless Chromium 143 draws the PDF (document.contentType check below).
 */
async function reviewLetter(pg, row) {
  const opened = pg.waitForEvent('popup', { timeout: 20000 }).then((tab) => ({ tab, at: Date.now() })).catch(() => null);
  await row.locator('button', { hasText: 'Review PDF' }).click();
  const o = await opened;
  if (!o) {
    log('Review PDF: no tab opened');
    await speak('approve', 'pdf');
    return;
  }
  const { tab, at } = o;
  const loaded = await until('the letter to load', async () => /^blob:/.test(tab.url()), { timeout: 20000, every: 250 }).catch(() => false);
  let filmed = false;
  if (loaded) {
    await tab.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    const drawn = await tab.evaluate(() => document.contentType === 'application/pdf' || !!document.querySelector('embed[type="application/pdf"]')).catch(() => false);
    if (drawn) {
      camera.register('insurer:letter', { page: tab, videoStartedAt: at, label: 'The CP 575 (insurer tab)' });
      await stage(tab, { viewport: VIEW, badge: { name: PEOPLE.analyst.name, role: PEOPLE.analyst.role, color: PEOPLE.analyst.color }, fast: REHEARSAL, now: true }).catch(() => {});
      await camera.cut('insurer:letter');
      filmed = true;
    } else log('Review PDF: the letter loaded but the browser drew no PDF viewer; not filmed');
  } else log(`Review PDF: the letter did not load${await visible(toast(pg, 'Could not open')) ? ' (the page says why)' : ''}`);
  await speak('approve', 'pdf');
  if (filmed) await camera.cut('insurer');
  await tab.close().catch(() => {});
}

/** Lines still to come (from the scene after `sceneKey`) whose voice is not in the cache: a take cannot render them. */
function unrenderedAfter(sceneKey) {
  const from = RUN.findIndex((s) => s.key === sceneKey) + 1;
  const out = [];
  for (const sc of RUN.slice(from)) {
    for (const [beat, lines] of Object.entries(S[sc.key] || {})) {
      for (const l of lines) {
        const p = PERSONS[l.who];
        const { file } = clipPath(l.text, { voice: p.voice, mood: l.mood || p.mood, lengthScale: p.lengthScale ?? 1, cacheDir: VOICE_CACHE });
        if (!fs.existsSync(file)) out.push(`${sc.key}.${beat}`);
      }
    }
  }
  return out;
}

/**
 * Waits for the fill proof (the pharmacy page polls fill-status) and takes the claim from the engine's answer: every
 * line from here on is spoken from it (lib/claim-script.mjs withClaim). A claim that breaks what the lines say, or
 * that the voices were not rendered for, stops a take here, before any of those lines; a rehearsal logs it and goes on
 * with the engine's numbers. The patient pay the pharmacy shows must be the engine's.
 */
async function learnClaim(since) {
  const { page: pg } = shot('pharmacy');
  const dispensed = pg.locator('#ws-dispensed-list .script-card', { hasText: c.drug.match }).first();
  const answer = await timed('fill-proof', () => camera.speedWhile(() => until('the fill proof', async () => {
    const heard = (sniffer.captures.get('fill') || []).filter((x) => x.at >= since);
    const done = heard.find((x) => x.value?.data?.status === 'complete');
    if (done) return done;
    const failed = heard.find((x) => x.value?.data?.status === 'error');
    if (failed) throw fatal(`the fill failed: ${failed.value.data.error || 'no reason given'}`);
    if (await visible(pg.locator('.script-issue-badge', { hasText: 'Proof Failed' }))) throw fatal('the pharmacy shows Proof Failed');
    return null;
  }, { timeout: 900000, every: 1000 }), { factor: 6 }));
  take.timings['dispense-to-proved'] = Date.now() - (take.dispenseAt || Date.now());
  await dispensed.locator('.script-issue-badge', { hasText: 'ZK Proved' }).waitFor({ timeout: 60000 }).catch(() => {});
  const predicted = cast;
  const res = answer.value?.data?.result;
  let real;
  try {
    real = withClaim(cast, res && res.adjudication ? res : res?.result);
  } catch (e) {
    // a rehearsal goes on with castOf's numbers (and says so); a take cannot say amounts it did not read
    mustHold(`the engine's claim could not be read from the fill answer (${e.message}); the lines keep castOf's prediction`);
    return;
  }
  const problems = storyChecks(real);
  const differs = claimDiffs(predicted, real);
  const onScreen = (await dispensed.locator('.script-price-tag.patient-pay').innerText().catch(() => '')).trim();
  const shownCents = Math.round(parseFloat(onScreen.replace(/[$,\s]/g, '')) * 100);
  if (onScreen && shownCents !== real.claim.P) problems.push(`the pharmacy shows ${onScreen}, the engine answered ${real.say.patientPay}`);
  cast = real;
  S = storyLines(cast);
  take.claim = { source: real.claim.source, ...real.pricing, say: real.say, predicted: differs.length ? predicted.say : undefined };
  log(`claim (engine): ${real.say.ingredient} + ${real.say.fee} = ${real.say.total}; patient ${real.say.patientPay}, plan ${real.say.planPay}, deductible credit ${real.say.credit}`
    + (differs.length ? `; castOf predicted ${predicted.say.total} and ${predicted.say.patientPay}` : ' (as castOf predicted)'));
  if (problems.length) mustHold(`the claim breaks what the lines say: ${problems.join('; ')}`);
  if (differs.length) {
    const missing = REHEARSAL ? [] : unrenderedAfter(camera.sceneKey);
    if (missing.length) throw fatal(`the engine priced the claim differently from castOf (${differs.join(', ')}), and ${missing.length} line(s) still to come were never rendered (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}): update predictPrice/castOf in lib/claim-script.mjs (lines marked PRICING), rerun voice-check.mjs, boot again`);
    log(`claim: castOf's prediction differs (${differs.join(', ')}); update predictPrice/castOf (lines marked PRICING) and rerun voice-check.mjs before a take`);
  }
}

// ------------------------------------------------------------------ the scenes (in the order the UI enforces)
const SCENE_RUN = {
  async plan() {
    const { page: pg, st } = shot('insurer');
    await camera.cut('insurer');
    await show('insurer', CARDS.disclosure, 8000);
    await speak('plan', 'intro');
    await pg.locator('.nav-tab[data-tab="plans"]').click();
    await pg.locator('#plan-create-toggle').click();
    await pg.locator('#plan-create-body:not(.hidden)').waitFor({ timeout: 10000 });
    await Promise.all([speak('plan', 'name'), (async () => {
      await pg.locator('#plan-name').fill(c.plan.name);
      await pg.locator('#plan-id').fill(c.plan.id);
    })()]);
    await Promise.all([speak('plan', 'cents'), pg.locator('#plan-copay').fill(String(c.plan.copayCents))]);
    await Promise.all([speak('plan', 'limits'), (async () => {
      await pg.locator('#plan-deductible').fill(String(c.plan.deductibleCents));
      await pg.locator('#plan-oop').fill(String(c.plan.oopCents));
      await pg.locator('#plan-annual').fill(String(c.plan.annualCents)); // the form's own default; a typed 0 becomes 10,000,000 anyway
      await pg.locator('#plan-fam-ded').fill(String(c.plan.famDedCents));
      await pg.locator('#plan-fam-oop').fill(String(c.plan.famOopCents));
    })()]);
    // PRICING: confirm after the pricing commit. The plan's dispensing fee is typed when the form has a field for it.
    // TODO(selector): the field's id is a guess until the pricing commit lands; without the field nothing is typed.
    const fee = pg.locator('#plan-dispensing-fee');
    if (await fee.count()) await fee.fill(String(c.plan.dispensingFeeCents));
    else log('plan: the form has no dispensing-fee field; the plan keeps its default (PRICING: confirm after the pricing commit)');
    await pg.locator('#plan-coverage').selectOption(c.plan.coverage);
    await speak('plan', 'create');
    await pg.locator('#plan-create-btn').click();
    await pg.locator('#plan-create-result .form-result', { hasText: c.plan.id }).waitFor({ timeout: 60000 });
    await st.card(CARDS.planBehind.title, CARDS.planBehind.lines, { ms: 10000 });
    await speak('plan', 'after');
  },

  async apply() {
    const { page: pg } = shot('employer:marketplace');
    // the page was opened before the plan existed; read the plans again while the camera is still on the insurer
    // (safe now: the marketplace's signing key is made only when the application is submitted)
    const chosen = pg.locator(`.plan-card[data-plan="${c.plan.id}"]`);
    await until('the new plan in the marketplace', async () => {
      if (await chosen.count()) return true;
      await pg.reload({ waitUntil: 'domcontentloaded' });
      await chosen.waitFor({ timeout: 8000 }).catch(() => {});
      return (await chosen.count()) > 0;
    }, { timeout: 120000, every: 2000 });
    await camera.cut('employer:marketplace');
    await speak('apply', 'plans');
    if (c.altPlan) await pg.locator(`.plan-card[data-plan="${c.altPlan.id}"]`).hover().catch(() => {});
    await chosen.hover();
    await speak('apply', 'choose');
    await chosen.click();
    await pg.locator('#btn-to-apply').click();
    await pg.locator('#app-company').waitFor({ timeout: 15000 });
    await pg.locator('#app-company').fill(c.employer.company);
    await pg.locator('#app-employer-id').fill(c.employer.employerId);
    await pg.locator('#app-contact').fill(c.employer.contact);
    await pg.locator('#app-email').fill(c.employer.email, { paste: true });
    await pg.locator('#app-phone').fill(c.employer.phone);
    await pg.locator('#app-ein').fill(c.employer.ein);
    await pg.locator('#app-state').fill(c.employer.state);
    await pg.locator('#app-industry').fill(c.employer.industry);
    await Promise.all([speak('apply', 'details'), (async () => {
      await pg.locator('#app-effective').fill(c.employer.effective);
      await pg.locator('#app-cap').fill(String(c.employer.cap));
    })()]);
    await pg.locator('#app-plan-type').selectOption(c.employer.planType);
    await speak('apply', 'submit');
    const since = Date.now();
    await pg.locator('#btn-submit-app').click(); // the Ed25519 key is made in this page and lives only in its memory
    const applied = await sniffer.waitFor('apply', { since, timeout: 60000 });
    take.applicationId = applied.value?.data?.applicationId || null;
    if (!secrets.activationCode && applied.value?.data?.activationCode) secrets.activationCode = applied.value.data.activationCode;
    // Submit opens the Agreement screen by itself: the activation code card (redacted) above the CP 575 request
    await pg.locator('#sign-content').waitFor({ timeout: 30000 });
    await speak('apply', 'after');
  },

  async docs() {
    const { page: pg, st } = shot('employer:marketplace');
    await camera.cut('employer:marketplace');
    // the one-time activation code is shown on this page (9f5099d) and redacted on camera (lib/masks.mjs
    // #activation-code); the director already holds it from the apply answer
    if (await visible(pg.locator('#activation-code-card'))) {
      await show('employer:marketplace', CARDS.activationCode, 10000);
      await pg.locator('#btn-copy-code').click().catch(() => {});
      await speak('docs', 'code');
      await pg.locator('#btn-code-saved').click().catch(() => {});
    } else log('docs: no activation code card on the Agreement screen');
    // the marketplace asks for the IRS letter from submission on (status submitted, no letter on file)
    const upload = pg.locator('#btn-upload-cp575');
    if (!(await visible(upload))) await pg.locator('a.nav-link[data-tab="sign"]').click();
    await upload.waitFor({ timeout: 30000 });
    await speak('docs', 'asked');
    await speak('docs', 'upload');
    await st.uploadVia(upload, assets.pdf);
    await toast(pg, 'Document uploaded').waitFor({ timeout: 60000 });
  },

  async approve() {
    const { page: pg } = shot('insurer');
    await camera.cut('insurer');
    await pg.locator('.nav-tab[data-tab="employers"]').click();
    const row = pg.locator('#marketplace-apps-body tr', { hasText: c.employer.company });
    const approve = row.locator('button', { hasText: 'Approve' });
    // with the letter on file the row offers Review PDF and Approve; the table polls every 10 s
    await camera.speedWhile(() => approve.waitFor({ timeout: 90000 }), { factor: 4 });
    const onFile = row.locator('.badge', { hasText: 'CP 575 on file' });
    if (await visible(onFile)) await onFile.hover().catch(() => {});
    await speak('approve', 'row');
    await reviewLetter(pg, row);
    await speak('approve', 'approve');
    await approve.click();
    await row.locator('.badge', { hasText: 'Approved' }).waitFor({ timeout: 30000 }).catch(() => {});
  },

  async sign() {
    const { page: pg, st } = shot('employer:marketplace');
    await camera.cut('employer:marketplace');
    await pg.locator('a.nav-link[data-tab="sign"]').click();
    const box = pg.locator('#agreement-scroll-container');
    await box.waitFor({ timeout: 60000 });
    await Promise.all([speak('sign', 'scroll'), st.scrollWithin(box)]);
    await pg.locator('#signer-name').fill(c.employer.contact);
    await pg.locator('#signer-title').selectOption(c.employer.signerTitle);
    await pg.locator('#attest-checkbox').check();
    await pg.locator('#btn-sign:not([disabled])').waitFor({ timeout: 10000 });
    await speak('sign', 'sign');
    const since = Date.now();
    await pg.locator('#btn-sign').click();
    // activation runs by itself: POST activate, activate-status every 2 s, then activate-credentials; the banner
    // reads "Provisioning your employer node..." (no HR Tool is started here since A7)
    await speak('sign', 'activation');
    const creds = await timed('activation', () => camera.speedWhile(() => sniffer.waitFor('credentials', { since, timeout: 180000 }), { factor: 4 }));
    secrets.tenantToken = creds.value?.data?.adminToken || '';
    take.employerNodeUrl = creds.value?.data?.employerNodeUrl || null;
    if (!secrets.tenantToken || !take.employerNodeUrl) throw new Error('activation did not hand over the employer node URL and admin token');
    const copy = pg.locator('#btn-copy-token');
    await copy.waitFor({ timeout: 30000 });
    await speak('sign', 'token');
    await copy.click(); // the admin token itself is redacted on screen (lib/masks.mjs)
  },

  async group() {
    // the employer dashboard opens in a new tab of the HR admin's browser; the marketplace tab stays open
    const { page: pg } = await openShot('employer:node');
    // the tenant token goes in from Node memory (the Admin field shows it masked); it is never typed
    await pg.evaluate((t) => { if (typeof API !== 'undefined') API.setAdminToken(t); else localStorage.setItem('zkt_employer_admin_token', t); }, secrets.tenantToken);
    await camera.cut('employer:node');
    await pg.locator('a.nav-link[data-tab="admin"]').click();
    await pg.locator('#admin-token-input').waitFor({ timeout: 15000 });
    await pg.locator('#btn-set-token').click();
    await speak('group', 'token');
    await pg.locator('a.nav-link[data-tab="groups"]').click();
    await pg.locator('#btn-show-create-group').click();
    await pg.locator('#cg-groupId').waitFor({ timeout: 15000 });
    await Promise.all([speak('group', 'form'), (async () => {
      await pg.locator('#cg-groupId').fill(c.group.id);
      await pg.locator('#cg-planId').selectOption(c.plan.id); // only a plan the employer bought is accepted (else 409)
      await pg.locator('#cg-effectiveDate').fill(c.group.effectiveDate);
      await pg.locator('#cg-enrollmentCap').fill(String(c.group.cap));
    })()]);
    await pg.locator('#btn-create-group').click();
    await pg.locator('#groups-table', { hasText: c.group.id }).waitFor({ timeout: 30000 });
    // the Roster tab sends its token and shows no wallet column (9f5099d); the story does not need it
    await speak('group', 'after');
  },

  async codes() {
    const { page: pg, st } = shot('employer:hrtool');
    await camera.cut('employer:hrtool');
    if (!(await pg.locator('#setup-form:not(.hidden)').isVisible().catch(() => false))) await pg.locator('#link-to-setup').click();
    await pg.locator('#setup-url').waitFor({ timeout: 15000 });
    await Promise.all([speak('codes', 'setup'), (async () => {
      await pg.locator('#setup-url').fill(take.employerNodeUrl, { paste: true });
      await st.fillSecret(pg.locator('#setup-token'), secrets.tenantToken);
      await st.fillSecret(pg.locator('#setup-passphrase'), secrets.hrPassphrase);
      await st.fillSecret(pg.locator('#setup-confirm'), secrets.hrPassphrase);
    })()]);
    await pg.locator('#btn-setup').click();
    await pg.locator('#unlock-overlay.hidden').waitFor({ state: 'attached', timeout: 60000 });
    const select = pg.locator(`.btn-select-group[data-gid="${c.group.id}"]`);
    await select.waitFor({ timeout: 60000 });
    await speak('codes', 'group');
    await select.click();
    await pg.locator('a.nav-link[data-tab="import"]').click();
    const zone = pg.locator('#csv-drop-zone');
    await zone.waitFor({ timeout: 15000 });
    await st.uploadVia(zone, assets.csv);
    await pg.locator('#csv-preview-panel table').waitFor({ timeout: 30000 });
    await speak('codes', 'preview');
    await Promise.all([speak('codes', 'expiry'), pg.locator('#imp-valid-until').fill(c.codes.validUntil)]);
    const since = Date.now();
    await pg.locator('#btn-import-go').click();
    const imp = await timed('import', () => sniffer.waitFor('import', { since, timeout: 180000 }));
    const mine = (imp.value?.data?.results || []).find((r) => r.employeeId === c.member.employeeId);
    if (!mine || !mine.tokenId || !mine.tokenPIN) throw new Error('the import did not return a code and PIN for the member');
    secrets.code = mine.tokenId;
    secrets.pin = mine.tokenPIN;
    await pg.locator('#csv-results-panel .table-wrap').waitFor({ timeout: 30000 }); // redacted on screen (lib/masks.mjs)
    await show('employer:hrtool', CARDS.learnsEmployerCodes, 20000);
    await speak('codes', 'after');
    await speak('codes', 'channels');
  },

  async enroll() {
    const { page: pg, st } = shot('member');
    await camera.cut('member');
    await speak('enroll', 'intro');
    await speak('enroll', 'new');
    await pg.locator('#landing-enroll-btn').click();
    await pg.locator('#ob-pin').waitFor({ timeout: 15000 });
    await Promise.all([speak('enroll', 'pin'), (async () => {
      await st.fillSecret(pg.locator('#ob-pin'), secrets.devicePin);
      await st.fillSecret(pg.locator('#ob-pin-confirm'), secrets.devicePin);
    })()]);
    await pg.locator('#ob-next').click();
    await pg.locator('#ob-token').waitFor({ timeout: 30000 });
    await Promise.all([speak('enroll', 'code'), (async () => {
      await st.fillSecret(pg.locator('#ob-token'), secrets.code);
      await st.fillSecret(pg.locator('#ob-enroll-pin'), secrets.pin);
    })()]);
    await Promise.all([speak('enroll', 'recovery'), st.fillSecret(pg.locator('#ob-recovery-pin'), secrets.recoveryPin)]);
    await pg.locator('#ob-next').click();
    await pg.locator('#ob-cid').waitFor({ timeout: 30000 });
    await show('member', CARDS.blurred, 16000);
    await Promise.all([speak('enroll', 'identity'), (async () => {
      // fictional values, blurred on screen (lib/masks.mjs); nobody reads them aloud
      await pg.locator('#ob-cid').fill(c.member.cardholderId);
      await pg.locator('#ob-fn').fill(c.member.firstName);
      await pg.locator('#ob-next').click();
      await pg.locator('#ob-ln').waitFor({ timeout: 15000 });
      await pg.locator('#ob-ln').fill(c.member.lastName);
      await pg.locator('#ob-dob').fill(c.member.dob);
    })()]);
    // step 4 runs by itself: generate-key, redeem (phone -> insurer -> employer), derive-wallet; then step 5 calls
    // enroll. Three of those requests are held in the browser (delayed, never changed) so each status line stays on
    // screen while it is explained; the enroll call waits through the wallet board and goes out in 'enrolling'.
    holds.keygen = await holdRequest(pg, '/onboarding/generate-key');
    holds.redeem = await holdRequest(pg, '/onboarding/redeem');
    holds.enroll = await holdRequest(pg, '/onboarding/enroll');
    const since = Date.now();
    take.enrollStartedAt = since;
    await pg.locator('#ob-next').click();
    const keyMsg = pg.locator('#ob-keygen-msg');
    const showing = (re) => until(`"${re.source}" on the phone`, async () => {
      const t = await keyMsg.innerText().catch(() => '');
      if (/^Error:/.test(t)) throw fatal(`step 4 failed on the phone: ${t.slice(0, 300)}`);
      return re.test(t);
    }, { timeout: 120000, every: 200 });
    await showing(/enrollment key on device/i);
    await speak('enroll', 'keygen');
    await holds.keygen.release();
    await showing(/Redeeming/i);
    await show('member', CARDS.redeemBehind, 18000);
    await speak('enroll', 'redeem');
    await speak('enroll', 'answer');
    await holds.redeem.release();
    const w = await sniffer.waitFor('wallet', { since, timeout: 180000 });
    take.walletId = w.value?.data?.walletId || null;
    if (!take.walletId) throw new Error('derive-wallet did not answer a wallet ID');
    await show('member', CARDS.learnsEmployerRedeem, 9000);
    await sleep(1500); // 'Wallet derived' on screen, then step 5 shows 'Enrolling with insurer...' with its call held
  },

  async enrolling() {
    const { page: pg } = shot('member');
    await camera.cut('member');
    const msg = pg.locator('#ob-enroll-msg');
    await until('the enroll step on the phone', async () => /Enrolling with insurer/i.test(await msg.innerText().catch(() => '')), { timeout: 60000, every: 300 });
    await show('member', CARDS.enrollBehind, 15000);
    await speak('enrolling', 'enroll');
    await show('member', CARDS.learnsInsurer, 20000);
    await speak('enrolling', 'shares');
    if (holds.enroll) await holds.enroll.release();
    // compile (~27 s, on the proving budget since 9f5099d) runs next: speed up the wait, never a voice
    await timed('enrollment-compile', () => camera.speedWhile(() => until('the registration proof to start', async () => {
      if (/registration proof/i.test(await msg.innerText().catch(() => ''))) return true;
      if (await visible(pg.locator('#ob-enter'))) return true;
      await retryIfFailed(pg);
      return false;
    }, { timeout: 900000, every: 1000 }), { factor: 6 }));
    await speak('enrolling', 'compile');
    // the registration proof (~40 s) carries on while the film is at the whiteboard
  },

  async enrolled() {
    const { page: pg } = shot('member');
    await camera.cut('member');
    const enter = pg.locator('#ob-enter');
    // the registration proof may still be running: speed up the wait, never a voice; Retry resumes from the phase
    await timed('enrollment-step-5', () => camera.speedWhile(() => until('enrollment to complete on the phone', async () => {
      if (await visible(enter)) return true;
      await retryIfFailed(pg);
      return false;
    }, { timeout: 900000, every: 1000 }), { factor: 6 }));
    take.timings['enrollment-total'] = Date.now() - (take.enrollStartedAt || Date.now());
    // the completion text reads "Your wallet is registered on the network. Your name and birth date stayed on this phone."
    await speak('enrolled', 'cards'); // the two recovery cards are redacted on screen (lib/masks.mjs)
    await speak('enrolled', 'explain');
    await speak('enrolled', 'enter');
    await enter.click();
    await pg.locator('#header-wallet').waitFor({ timeout: 30000 });
  },

  async 'status-registration'() {
    await camera.cut('status');
    await status.update('clear');
    await status.update('setTitle', { title: 'Registration, behind the screen', subtitle: `${PEOPLE.member.name}'s phone, the engine and the sequencer` });
    const receipts = await reads.receiptsByWallet(take.walletId).catch(() => []);
    const reg = receipts.find((r) => r.isRegistration) || receipts[0];
    await status.update('upsertRow', { id: 'reg', label: 'Registration proof', value: reg ? `accepted · ${short(reg.receiptId)}` : 'not read', tone: reg ? 'ok' : 'wait', source: 'l2_getReceiptsByWallet (operator read)', note: reg && reg.auditEventHash ? `audit event ${short(reg.auditEventHash)}` : undefined });
    const m = await reads.member(take.walletId).catch(() => null);
    await status.update('upsertRow', { id: 'record', label: 'Engine record', value: m ? `${m.lifecycle} · ${m.planId}` : 'not read', tone: m ? 'ok' : 'wait', source: '/interactive/state (allowlisted fields)', note: m ? `pending wallet updates: ${m.pendingWalletUpdates ?? '?'}` : undefined });
    const talk = speak('status-registration', 'accepted');
    await showOnStatus(CARDS.learnsEngine, 14000);
    if (m && m.accumulator) {
      const lim = m.accumulator.limits || {};
      await status.update('upsertRow', { id: 'limits', label: 'Her plan limits', value: `${cents(lim.deductibleAmountCents)} · ${cents(lim.oopMaxCents)} · ${cents(lim.annualBenefitMaxCents)}`, tone: 'info', source: '/interactive/state accumulator.limits', note: 'deductible · out-of-pocket maximum · annual benefit maximum' });
      await status.update('upsertRow', { id: 'paid', label: 'Paid so far', value: `${cents(m.accumulator.deductiblePaidCents)} · ${cents(m.accumulator.oopPaidCents)} · ${cents(m.accumulator.benefitUsedCents)}`, tone: 'info', source: '/interactive/state accumulator', note: 'toward the deductible · out of pocket · by the plan' });
    }
    await sleep(1800);
    const ws = await reads.walletState(take.walletId).catch(() => null);
    await status.update('upsertRow', { id: 'inventory', label: 'Credential inventory root', value: ws ? `${short(ws.credentialInventoryRoot)} · nonce ${ws.nonce}` : 'not read', tone: ws ? 'ok' : 'wait', source: 'l2_getWalletState (operator read)', note: 'changed by the first credential update (the mint)' });
    await talk;
    await speak('status-registration', 'record');
  },

  async pcp() {
    const { page: pg } = shot('member');
    await camera.cut('member');
    await pg.locator('a.nav-link[data-tab="providers"]').click();
    // row 0 of the fictional src/data/prescribers.json (3f2a192): Miriam Fallowmere, MD, Family Medicine
    const doc = pg.locator('#provider-list .provider-card', { hasText: c.prescriber.match });
    await doc.waitFor({ timeout: 60000 });
    await doc.scrollIntoViewIfNeeded();
    await doc.hover();
    await speak('pcp', 'choose');
    await doc.locator('button', { hasText: 'Set PCP' }).click(); // never 'Remove' (it sends no device session)
    await speak('pcp', 'set');
    // two toasts follow: 'PCP assigned — generating ZK proof...' then 'PCP proof submitted to sequencer' (~13.5 s)
    await timed('pcp-proof', () => camera.speedWhile(() => until('the PCP proof', async () => {
      if (await visible(toast(pg, 'PCP proof submitted'))) return true;
      if (await visible(toast(pg, 'failed'))) throw fatal(`PCP assignment failed: ${await toast(pg, 'failed').first().innerText().catch(() => '')}`);
      return false;
    }, { timeout: 300000, every: 500 }), { factor: 4 }));
    await show('member', CARDS.learnsPrescriber, 16000);
    await speak('pcp', 'after');
  },

  async prescribe() {
    const { page: pg, st } = shot('prescriber');
    await camera.cut('prescriber');
    await pg.locator('.nav-tab[data-tab="prescriptions"]').click();
    await pg.locator('#rx-write-toggle').click(); // opening the form loads the patient, pharmacy and drug lists
    const patient = pg.locator('#rx-patient-select');
    // the PCP link puts the member on this list as a short wallet hash, never a name; the option's value is the wallet ID
    const patientValue = await until('the patient list to show the member', async () => patient.evaluate((el, w) => {
      const opts = [...el.options].filter((o) => o.value);
      const mine = opts.find((o) => o.value === w);
      return mine ? mine.value : (opts.length === 1 ? opts[0].value : null);
    }, take.walletId), { timeout: 90000, every: 2000 });
    await speak('prescribe', 'patient');
    await patient.selectOption(patientValue);
    await speak('prescribe', 'pharmacy');
    // row 0 of the fictional src/data/pharmacies.json (3f2a192): "Kettleby Pharmacy"
    await selectByText(pg.locator('#rx-pharmacy-select'), c.pharmacy.match);
    // the label is "ALLOPURINOL (Generic) 100 MG TABLET": NDC 00378-0137-01 is in the 100-drug formulary
    // (src/data/formulary-100.json with ZKTRIDENT_FORMULARY_LIMIT=100), and the list loads up to 500 drugs
    await selectByText(pg.locator('#rx-med-select'), `${c.drug.match}.*${c.drug.strengthMatch}`);
    await speak('prescribe', 'drug');
    await pg.locator('#rx-quantity').fill(String(c.drug.quantity));
    await pg.locator('#rx-days-supply').fill(String(c.drug.daysSupply));
    await Promise.all([speak('prescribe', 'directions'), pg.locator('#rx-directions').fill(c.drug.directions)]);
    await Promise.all([speak('prescribe', 'refills'), pg.locator('#rx-refills').fill(String(c.drug.refills))]);
    await pg.locator('#rx-diagnosis').fill(c.drug.diagnosis);
    await speak('prescribe', 'send');
    await pg.locator('#rx-write-btn').click();
    const badge = pg.locator('#rx-proof-badge');
    await badge.waitFor({ timeout: 60000 });
    await speak('prescribe', 'sent');
    await st.card(CARDS.prescribeProofs.title, CARDS.prescribeProofs.lines, { ms: 20000 });
    await speak('prescribe', 'proofs');
    await timed('prescribe-proof', () => camera.speedWhile(() => until('the prescription proof', async () => {
      const cls = await badge.getAttribute('class');
      if (/badge-failed|badge-error/.test(cls || '')) throw fatal(`prescription proof failed: ${await pg.locator('#rx-proof-detail').innerText().catch(() => '')}`);
      return /badge-settled/.test(cls || '');
    }, { timeout: 600000, every: 1000 }), { factor: 6 }));
    // the badge reads "ZK Proofs: Generated" and its detail lists the proofs the engine made, not kept and not verified (9f5099d)
    await speak('prescribe', 'ledger');
    await st.hideCard();
  },

  async fill() {
    const { page: pg } = shot('pharmacy');
    await camera.cut('pharmacy');
    await pg.locator('.nav-tab[data-tab="workstation"]').click();
    // the card's label is the drug's brandName, "ALLOPURINOL (Generic)", cut to 20 characters
    const script = pg.locator('#ws-adjudicated-list .script-card', { hasText: c.drug.match });
    await camera.speedWhile(() => until('the prescription in the Adjudicated column', async () => {
      if (await script.count()) return true;
      await pg.locator('#ws-refresh-btn').click().catch(() => {});
      return false;
    }, { timeout: 180000, every: 5000 }), { factor: 4 });
    // a PENDING script shows "Adjudicating…" and no Fill until the prescriber's proofs finish; a refused fill stays put
    await camera.speedWhile(() => script.first().locator('button', { hasText: 'Fill' }).waitFor({ timeout: 600000 }), { factor: 4 });
    await speak('fill', 'read');
    await script.first().locator('button', { hasText: 'Fill' }).click();
    await closeDetail(pg);
    await pg.locator('#ws-filled-list .script-card', { hasText: c.drug.match }).first().waitFor({ timeout: 60000 });
    await speak('fill', 'fill');
    await speak('fill', 'after');
  },

  async attest() {
    const { page: pg } = shot('member');
    await camera.cut('member');
    await speak('attest', 'ask'); // Walt, at the counter, off camera
    await Promise.all([speak('attest', 'open'), pg.locator('a.nav-link[data-tab="backup"]').click()]);
    const req = pg.locator('#attestation-btn');
    await req.scrollIntoViewIfNeeded();
    const since = Date.now();
    await req.click();
    const copyBtn = pg.locator('#credential-copy-btn');
    await pg.locator('#credential-copy-btn:not([disabled])').waitFor({ timeout: 90000 });
    // the card shows the attestation's own fields (exp, sig, n); Write to NFC is hidden (9f5099d)
    await copyBtn.click();
    // the copied JSON is the sequencer-signed attestation (a 24-hour read pass to her claims); it stands in for the
    // NFC tap, stays in memory (never in take.json) and is blurred where the pharmacy pastes it
    let json = await pg.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    if (!/credential-attestation/.test(json || '')) {
      const att = await sniffer.waitFor('attestation', { since, timeout: 30000 });
      json = JSON.stringify({ type: 'credential-attestation', version: 2, walletId: take.walletId, attestation: att.value?.data, exportedAt: Date.now() }, null, 2);
    }
    take.attestationJson = json;
    await speak('attest', 'explain');
  },

  async 'verify-dispense'() {
    const { page: pg, st } = shot('pharmacy');
    await camera.cut('pharmacy');
    // the pasted attestation is a 24-hour read pass to her claims: blurred on camera
    await pg.addStyleTag({ content: '#ws-verify-wallet{filter:blur(6px)!important}' }).catch(() => {});
    const filled = pg.locator('#ws-filled-list .script-card', { hasText: c.drug.match }).first();
    const verifyBtn = filled.locator('button', { hasText: 'Verify Member' });
    if (await visible(verifyBtn)) await verifyBtn.click().catch(() => {}); // focuses the verify box
    await closeDetail(pg);
    await st.card(CARDS.simulatedTap.title, CARDS.simulatedTap.lines, { ms: 9000 });
    await Promise.all([speak('verify-dispense', 'pasted'), pg.locator('#ws-verify-wallet').fill(take.attestationJson, { paste: true })]);
    await pg.locator('#ws-verify-lookup-btn').click();
    // /nfc/scan checks the signature against the pinned key and reads the history once with the tap (A-41, 9f5099d)
    const verified = pg.locator('#ws-verify-status.verified');
    const failed = pg.locator('#ws-verify-status.error');
    await until('the member to be verified', async () => {
      if (await visible(verified)) return true;
      if (await visible(failed)) throw fatal(`Verify Member failed: ${await failed.innerText().catch(() => '')}`);
      return false;
    }, { timeout: 90000, every: 500 });
    await speak('verify-dispense', 'verified');
    const dispense = filled.locator('button', { hasText: 'Dispense' });
    await dispense.hover().catch(() => {});
    await speak('verify-dispense', 'gate');
    await speak('verify-dispense', 'dispense');
    take.dispenseAt = Date.now();
    await dispense.click();
    await closeDetail(pg);
    await st.card(CARDS.dispenseBehind.title, CARDS.dispenseBehind.lines, { ms: 14000 }); // PRICING: confirm after the pricing commit
    await speak('verify-dispense', 'proving');
    await speak('verify-dispense', 'checks');
    // no amount is said before the engine has priced the claim: wait for the fill proof here (sped up) and take the
    // claim from its answer; the boards and the counter then say the engine's numbers
    await learnClaim(take.dispenseAt);
  },

  async pay() {
    const { page: pg } = shot('pharmacy');
    await camera.cut('pharmacy');
    const dispensed = pg.locator('#ws-dispensed-list .script-card', { hasText: c.drug.match }).first();
    await dispensed.locator('.script-issue-badge', { hasText: 'ZK Proved' }).waitFor({ timeout: 60000 });
    const price = dispensed.locator('.script-price-tag.patient-pay');
    if (await visible(price)) await price.hover().catch(() => {});
    await speak('pay', 'price');
    await speak('pay', 'question');
    await speak('pay', 'answer');
    await speak('pay', 'card');
    await Promise.all([speak('pay', 'counsel'), (async () => {
      await dispensed.locator('button', { hasText: 'Payment Received' }).click();
      await closeDetail(pg);
    })()]);
    await show('pharmacy', CARDS.learnsPharmacy, 18000);
    await speak('pay', 'after');
  },

  async 'status-update'() {
    await camera.cut('status');
    await status.update('clear');
    await status.update('setTitle', { title: 'Meanwhile, on Avery’s phone', subtitle: 'The claim waits for one more proof, made on her phone' });
    const m0 = await reads.member(take.walletId).catch(() => null);
    const ws0 = await reads.walletState(take.walletId).catch(() => null);
    take.inventoryBefore = ws0 ? ws0.credentialInventoryRoot : null;
    await status.update('upsertRow', { id: 'pending', label: 'Wallet updates waiting for the phone', value: m0 ? String(m0.pendingWalletUpdates) : 'not read', tone: 'wait', source: '/interactive/state pendingWalletUpdates (allowlisted)', note: 'the phone checks for work every 20 seconds' });
    if (ws0) await status.update('upsertRow', { id: 'inventory', label: 'Credential inventory root on the ledger', value: short(ws0.credentialInventoryRoot), tone: 'info', source: 'l2_getWalletState (operator read)', note: 'before the update' });
    await speak('status-update', 'queued');
  },

  async 'status-accepted'() {
    await camera.cut('status');
    const pendingRow = (m) => ({ id: 'pending', label: 'Wallet updates waiting for the phone', value: String(m?.pendingWalletUpdates ?? '?'), tone: m && m.pendingWalletUpdates === 0 ? 'ok' : 'wait', source: '/interactive/state pendingWalletUpdates (allowlisted)', note: 'the phone checks for work every 20 seconds' });
    const m1 = await timed('claim-update', () => camera.speedWhile(() => until('the phone to prove the claim update', async () => {
      const m = await reads.member(take.walletId);
      await status.update('upsertRow', pendingRow(m));
      return m && m.pendingWalletUpdates === 0 ? m : null;
    }, { timeout: 600000, every: 3000 }), { factor: 6 }));
    const receipts = await reads.receiptsByWallet(take.walletId).catch(() => []);
    const claim = receipts.filter((r) => !r.isRegistration && r.claimLeafIndex != null).pop() || receipts.filter((r) => !r.isRegistration).pop();
    await status.update('upsertRow', { id: 'receipt', label: 'Wallet-update proof', value: claim ? `accepted · ${short(claim.receiptId)}` : 'not read', tone: claim ? 'ok' : 'wait', source: 'l2_getReceiptsByWallet (operator read)', note: claim && claim.claimLeafIndex != null ? `claim leaf ${claim.claimLeafIndex}` : undefined });
    const ws1 = await reads.walletState(take.walletId).catch(() => null);
    if (ws1) await status.update('upsertRow', { id: 'inventory', label: 'Credential inventory root on the ledger', value: `${short(take.inventoryBefore)} → ${short(ws1.credentialInventoryRoot)}`, tone: 'ok', source: 'l2_getWalletState (operator read)', note: `nonce ${ws1.nonce}` });
    await speak('status-accepted', 'accepted');
    if (m1 && m1.accumulator) await status.update('upsertRow', { id: 'acc', label: 'Her running totals (engine record)', value: `${cents(m1.accumulator.deductiblePaidCents)} · ${cents(m1.accumulator.oopPaidCents)} · ${cents(m1.accumulator.benefitUsedCents)}`, tone: 'info', source: '/interactive/state accumulator', note: 'toward the deductible · out of pocket · by the plan' });
    const stt = await reads.status().catch(() => null);
    if (stt) await status.update('countdown', { id: 'batch', label: 'Next batch', ms: stt.nextBatchInMs, source: 'l2_getStatus nextBatchInMs' });
    await speak('status-accepted', 'caveat');
  },

  async batch() {
    const { page: pg } = shot('network');
    await camera.cut('network');
    await pg.locator('.nav-tab[data-tab="batches"]').click();
    await speak('batch', 'intro');
    // TODO(selector): the batch is matched by the receipt's l1BatchNumber / l2BlockNumber; confirm in a rehearsal
    // that this is the index the dashboard's Batches table shows (window._showBatchDetail(<index>)).
    const r = await timed('batch-wait', () => camera.speedWhile(() => until('the claim to be batched', async () => {
      const rs = await reads.receiptsByWallet(take.walletId);
      const last = rs.filter((x) => !x.isRegistration).pop();
      return last && (last.l1BatchNumber != null || last.l2BlockNumber != null) ? last : null;
    }, { timeout: 600000, every: 3000 }), { factor: 6 }));
    await pg.locator('#batch-refresh-btn').click();
    const idx = r.l1BatchNumber ?? r.l2BlockNumber;
    let row = pg.locator(`#batch-table tr[onclick*="_showBatchDetail(${idx})"]`);
    if (!(await row.count())) row = pg.locator('#batch-table tr[onclick*="_showBatchDetail"]').first();
    await row.waitFor({ timeout: 30000 });
    await row.click();
    await pg.locator('#batch-modal').waitFor({ state: 'visible', timeout: 30000 });
    await speak('batch', 'batch');
    await pg.locator('#batch-modal .batch-modal-header button').click().catch(() => {});
  },

  async audit() {
    const { page: pg } = shot('insurer');
    await camera.cut('insurer');
    await pg.locator('.nav-tab[data-tab="audit"]').click();
    await speak('audit', 'chain');
    await pg.locator('#audit-chain-card').click();
    const chain = await until('the chain integrity result', async () => { const t = await pg.locator('#audit-chain-val').innerText(); return /PASS|FAIL|Error/.test(t) ? t : null; }, { timeout: 120000 });
    await pg.locator('#audit-finance-card').click();
    const finance = await until('the financial balance result', async () => { const t = await pg.locator('#audit-finance-val').innerText(); return /PASS|FAIL|Error/.test(t) ? t : null; }, { timeout: 120000 });
    // Theo says "Good." only over two passes
    if (!/PASS/.test(chain) || !/PASS/.test(finance)) mustHold(`the audit cards read "${chain.trim()}" and "${finance.trim()}", not PASS`);
    await speak('audit', 'balance');
    await speak('audit', 'after');
  },

  async pickup() {
    const { page: pg } = shot('member');
    await camera.cut('member');
    await pg.locator('a.nav-link[data-tab="claims"]').click();
    const claim = pg.locator('#claims-list .claim-card');
    await camera.speedWhile(() => until('the claim on the phone', async () => {
      if (await claim.count()) return true;
      await pg.locator('a.nav-link[data-tab="dashboard"]').click().catch(() => {});
      await pg.locator('a.nav-link[data-tab="claims"]').click().catch(() => {}); // the tab reads the claims when it opens
      return false;
    }, { timeout: 300000, every: 8000 }), { factor: 6 });
    // PRICING: confirm after the pricing commit. The card prints "Drug Cost: <total> (NADAC <ingredient> + Fee <fee>)";
    // the NADAC label is true once the engine prices the fill from NADAC (today the pharmacy page sends a cost of 0).
    await claim.first().scrollIntoViewIfNeeded();
    await speak('pickup', 'claim');
    await show('member', CARDS.learnsLedger, 14000);
    await speak('pickup', 'read');
    await pg.locator('a.nav-link[data-tab="dashboard"]').click();
    // the spend hero shows her own plan limits, read from the device (9f5099d)
    await pg.locator('#spend-hero .spend-row').waitFor({ timeout: 60000 }).catch(() => {});
    await speak('pickup', 'deductible');
    await speak('pickup', 'closing');
    await speak('pickup', 'unfinished');
    await show('member', CARDS.endCard, 8000);
    await sleep(4000);
  }
};
// the board scenes write their cards while their lines play
for (const sc of SCENES) if (sc.kind === 'board' && !SCENE_RUN[sc.key]) SCENE_RUN[sc.key] = async () => { await camera.cut('board'); await speakAll(sc.key); };
for (const sc of SCENES) if (!SCENE_RUN[sc.key]) throw new Error(`director: no scene function for "${sc.key}"`);

// ------------------------------------------------------------------ pre-roll 4: open the first screens, the second plan
const shotsFor = (i) => (RUN[i] && SHOTS[RUN[i].camera] && !SHOTS[RUN[i].camera].late ? [RUN[i].camera] : []);
await openShot('insurer');
if (c.altPlan) {
  // a second plan, published through the same form before the film starts, so the marketplace offers a real choice
  const { page: pg, st } = shot('insurer');
  st.setFast(true);
  try {
    await pg.locator('.nav-tab[data-tab="plans"]').click();
    await pg.locator('#plan-create-toggle').click();
    for (const [sel, v] of [['#plan-name', c.altPlan.name], ['#plan-id', c.altPlan.id], ['#plan-copay', c.altPlan.copayCents], ['#plan-deductible', c.altPlan.deductibleCents],
      ['#plan-oop', c.altPlan.oopCents], ['#plan-annual', c.altPlan.annualCents], ['#plan-fam-ded', c.altPlan.famDedCents], ['#plan-fam-oop', c.altPlan.famOopCents]]) await pg.locator(sel).fill(String(v));
    // PRICING: confirm after the pricing commit (the dispensing-fee field, when the form has one; see the plan scene)
    if (await pg.locator('#plan-dispensing-fee').count()) await pg.locator('#plan-dispensing-fee').fill(String(c.altPlan.dispensingFeeCents));
    await pg.locator('#plan-create-btn').click();
    await pg.locator('#plan-create-result .form-result').waitFor({ timeout: 60000 });
    log(`pre-roll: second plan: ${(await pg.locator('#plan-create-result').innerText()).trim()}`);
  } catch (e) {
    log(`pre-roll: the second plan was not published (${e.message}); the marketplace shows one plan`);
  }
  st.setFast(REHEARSAL);
  await pg.reload({ waitUntil: 'domcontentloaded' });
}
for (const k of [...shotsFor(0), ...shotsFor(1)]) await openShot(k);

// ------------------------------------------------------------------ the take
let failure = null;
let stopped = false;
const T0 = Date.now(); // the film starts here
take.T0 = T0;
log('T0: the film starts');
async function runScenes() {
  for (let i = 0; i < RUN.length && !stopped; i++) {
    const sc = RUN[i];
    for (const k of [...shotsFor(i), ...shotsFor(i + 1)]) await openShot(k);
    camera.scene(sc.key, { act: sc.act, title: sc.title });
    log(`scene ${i + 1}/${RUN.length}: ${sc.key} (${sc.title})`);
    const a = Date.now();
    await SCENE_RUN[sc.key]();
    take.timings[`scene:${sc.key}`] = Date.now() - a;
    // close what no later scene shows (its video is finished; nothing it holds is needed again)
    for (const k of [...open.keys()]) if (!RUN.slice(i + 1).some((s) => s.camera === k)) await closeShot(k);
  }
}
let watchdog = null;
try {
  const scenes = runScenes();
  scenes.catch(() => {}); // after a watchdog stop, a late failure of the abandoned scene must not crash the wrap-up
  await Promise.race([
    scenes,
    new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('watchdog: the take ran over 60 minutes')), 60 * 60000); })
  ]);
} catch (e) {
  stopped = true;
  failure = `${camera.sceneKey || 'pre-roll'}: ${e.message}`;
  log(`FAILED ${failure}`);
  if (e.stack) log(e.stack.split('\n').slice(1, 4).join(' | '));
}
clearTimeout(watchdog);
for (const h of Object.values(holds)) await h.release().catch(() => {}); // a stopped take leaves no request waiting
await narrator.quiet();
await sleep(1500);
const T1 = Date.now();
take.T1 = T1;
log(`T1: ${((T1 - T0) / 1000).toFixed(0)} s recorded${failure ? ' (FAILED)' : ''}`);

// ------------------------------------------------------------------ wrap: videos, take.json, the film
for (const s of camera.shots.values()) s.video = s.page.video() ? await s.page.video().path().catch(() => null) : null;
for (const ctx of contexts.values()) await ctx.close().catch(() => {});
await directorCtx.close().catch(() => {});
await browser.close().catch(() => {});
stopHrTool();
const cam = camera.toJSON();
const takeJson = {
  T0, T1, failure, rehearsal: REHEARSAL, scriptStatus: SCRIPT_STATUS, pricingStatus: PRICING_STATUS, stopAfter,
  acts: ACTS,
  people: Object.fromEntries(Object.values(PERSONS).map((p) => [p.key, { name: p.name, role: p.role, voice: REHEARSAL ? null : p.voice }])),
  cast: { plan: c.plan, employer: { company: c.employer.company, employerId: c.employer.employerId }, group: c.group, drug: c.drug, pricing: cast.pricing, say: cast.say },
  claim: take.claim,
  shots: cam.shots, cuts: cam.cuts, speedups: cam.speedups, scenes: cam.scenes,
  lines: narrator.lines.map((l) => ({ at: l.at, ms: l.ms, name: l.name, persona: l.persona, voice: l.voice, mood: l.mood, text: l.text, file: l.file })),
  walletId: take.walletId, employerNodeUrl: take.employerNodeUrl, hrToolUrl: take.hrToolUrl, applicationId: take.applicationId,
  timings: take.timings
};
fs.writeFileSync(path.join(OUT, 'take.json'), JSON.stringify(takeJson, null, 2));
log(`take.json written (no secrets in it); raw recordings in ${RAW}`);
if (!args['no-post']) {
  try {
    await assemble({ outDir: OUT, take: takeJson, log, title: `zpk.care: one claim, end to end${REHEARSAL ? ' (rehearsal)' : ''}` });
  } catch (e) {
    log(`post failed: ${e.message} (rerun: node director.mjs --post-only "${OUT}")`);
    failure = failure || `post: ${e.message}`;
  }
}
log(`${failure ? 'FAILED' : 'done'}: ${narrator.lines.length} lines, ${cam.cuts.length} cuts; output ${OUT}`);
if (failure) log('a failed take needs a new genesis boot before the next one');
process.exit(failure ? 1 : 0);
