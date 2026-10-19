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
 * does), ZPK_DEMO_TOOLS, PW_CHROMIUM_PATH, HF_HUB_OFFLINE, ZPK_DEMO_OUT. URLs: ZPK_DEMO_SEQ_URL, ZPK_DEMO_INSURER_URL,
 * ZPK_DEMO_MEMBER_URL, ZPK_DEMO_PRESCRIBER_URL, ZPK_DEMO_PHARMACY_URL (defaults 127.0.0.1:3030/4004/4001/4002/4003).
 *
 * Secrets stay off camera: the insurer token arrives through storageState, the operator token as a request header
 * (context.route), the tenant token, codes, PINs and passphrases through page.evaluate into masked fields
 * (stage.fillSecret); the activation code is read from the native alert by a dialog handler; the director keeps them
 * in memory only and never logs or writes them. The director reads responses (allowlisted paths and fields) and
 * never request bodies, and it never writes through the API.
 *
 * Selectors come from the screen audit (prepare:screens) and were checked against the dashboard sources at a654f31;
 * the ones that depend on data or fixes that are not in the repository yet are marked TODO(selector).
 * A failed take needs a new genesis boot.
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
import { Narrator, synth, stopEngines, enginesRunning, knownVoice, OUT_ROOT, VOICE_CACHE } from './lib/narrate.mjs';
import { openWhiteboard, directorContext, SCREEN } from './lib/whiteboard.mjs';
import { openStatusCard } from './lib/status-card.mjs';
import { makeBoardRunner, checkBoardAction } from './lib/board-beats.mjs';
import { Camera } from './lib/camera.mjs';
import { assemble } from './lib/post.mjs';
import { makeReads, insurerAdminToken } from './lib/reads.mjs';
import { Sniffer, SNIFF_RULES } from './lib/sniff.mjs';
import { applyMasks } from './lib/masks.mjs';
import { writeTakeAssets } from './lib/assets.mjs';
import { PEOPLE, ACTS, SCENES, BEATS, SCRIPT_STATUS, castOf, storyLines, allLines } from './lib/claim-script.mjs';
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

const cast = castOf();
const S = storyLines(cast);
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
    for (const [beat, lines] of Object.entries(beats)) {
      for (const l of lines) {
        if (!PEOPLE[l.who]) problems.push(`${sc.key}.${beat}: unknown speaker "${l.who}"`);
        if (!l.text || !String(l.text).trim()) problems.push(`${sc.key}.${beat}: an empty line`);
        for (const a of l.board || []) {
          try { checkBoardAction(a); } catch (e) { problems.push(`${sc.key}.${beat}: ${e.message}`); }
        }
      }
    }
    for (const b of BEATS[sc.key] || []) if (!beats[b]) gaps.push(`${sc.key}.${b}`);
  }
  return { problems, gaps };
}

if (args.plan) {
  const { problems, gaps } = checkScript();
  console.log(`zpk.care walkthrough: ${SCENES.length} scenes, script ${SCRIPT_STATUS}, ${allLines(cast).length} lines, ${EQUATIONS.length} equation cards`);
  let act = null;
  for (const sc of SCENES) {
    if (sc.act !== act) { act = sc.act; console.log(`\nAct ${act}: ${ACTS[act]}`); }
    const lines = Object.values(S[sc.key] || {}).flat();
    const boards = lines.flatMap((l) => l.board || []);
    console.log(`  ${sc.key.padEnd(20)} ${sc.kind.padEnd(7)} ${sc.camera.padEnd(22)} ${String(lines.length).padStart(2)} lines${boards.length ? `, ${boards.length} board actions` : ''}  ${sc.title}`);
  }
  console.log(`\nVoices: ${Object.values(PERSONS).map((p) => `${p.key}=${p.voice}`).join(', ')}`);
  console.log(`Cast: ${cast.plan.id} (${cast.say.deductible} deductible), ${cast.employer.company}, ${cast.drug.name} x${cast.drug.quantity}: total ${cast.say.total}, patient ${cast.say.patientPay}, plan ${cast.say.planPay}`);
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
const take = { walletId: null, employerNodeUrl: null, hrToolUrl: null, applicationId: null, timings: {} };

const OUT = path.resolve(args.out || path.join(OUT_ROOT, `${stampNow()}${REHEARSAL ? '-rehearsal' : ''}`));
const RAW = path.join(OUT, 'raw');
fs.mkdirSync(RAW, { recursive: true });
logFile = path.join(OUT, 'director.log');
const reads = makeReads({ seqUrl: URLS.seq, memberUrl: URLS.member, operatorToken: secrets.operator, log: () => {} });
const sniffer = new Sniffer({ log });
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

// ------------------------------------------------------------------ pre-roll 1: the script, the voices (before anything records)
{
  const { problems, gaps } = checkScript();
  if (problems.length) throw new Error(`the script has problems:\n  ${problems.join('\n  ')}`);
  if (gaps.length) log(`script: beats left out (skipped): ${gaps.join(', ')}`);
  if (SCRIPT_STATUS === 'placeholder') log('script: lib/claim-script.mjs still holds PLACEHOLDER lines');
}
log(`take: ${OUT}${REHEARSAL ? ' (rehearsal: fast stage, no voices)' : ''}; scenes ${RUN[0].key} .. ${RUN[RUN.length - 1].key}`);
log(`chromium: ${chromiumPath()}`);
// fail fast if the network is not up at all (the full readiness wait comes after the voices)
await reads.status().catch((e) => { throw new Error(`the sequencer at ${URLS.seq} does not answer (${e.message}): boot the network first (README)`); });
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

/** The marketplace's native alert carries the activation code: kept in memory, never drawn, never logged. */
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
  sniffer.watch(page, SNIFF_RULES);
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
const card = (key, title, lines, ms = 9000) => shot(key).st.card(title, lines, { ms });
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

// ------------------------------------------------------------------ the scenes (in the order the UI enforces)
const c = cast;
const SCENE_RUN = {
  async plan() {
    const { page: pg, st } = shot('insurer');
    await camera.cut('insurer');
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
      await pg.locator('#plan-annual').fill(String(c.plan.annualCents));
      await pg.locator('#plan-fam-ded').fill(String(c.plan.famDedCents));
      await pg.locator('#plan-fam-oop').fill(String(c.plan.famOopCents));
    })()]);
    await pg.locator('#plan-coverage').selectOption(c.plan.coverage);
    await speak('plan', 'create');
    await pg.locator('#plan-create-btn').click();
    await pg.locator('#plan-create-result .form-result', { hasText: c.plan.id }).waitFor({ timeout: 60000 });
    await st.card('Behind this click', ['POST /plans with the insurer token', 'The insurer node publishes the plan to the sequencer, signed with the insurer key'], { ms: 10000 });
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
    await pg.locator('#sign-content').waitFor({ timeout: 30000 });
    await speak('apply', 'after');
  },

  async review() {
    const { page: pg } = shot('insurer');
    await camera.cut('insurer');
    await pg.locator('.nav-tab[data-tab="employers"]').click();
    const row = pg.locator('#marketplace-apps-body tr', { hasText: c.employer.company });
    await camera.speedWhile(() => row.waitFor({ timeout: 90000 }), { factor: 4 }); // the table polls every 10 s
    await speak('review', 'row');
    await speak('review', 'request');
    await row.locator('button', { hasText: 'Request Docs' }).click();
    await toast(pg, 'Documents requested').waitFor({ timeout: 30000 }).catch(() => {});
  },

  async docs() {
    const { page: pg, st } = shot('employer:marketplace');
    await camera.cut('employer:marketplace');
    // the Agreement screen reads the status when it renders; open it again to see 'Documents Required'
    await pg.locator('a.nav-link[data-tab="sign"]').click();
    const upload = pg.locator('#btn-upload-cp575');
    await upload.waitFor({ timeout: 30000 });
    await speak('docs', 'asked');
    await speak('docs', 'upload');
    await st.uploadVia(upload, assets.pdf);
    await toast(pg, 'Document uploaded').waitFor({ timeout: 60000 });
  },

  async approve() {
    const { page: pg } = shot('insurer');
    await camera.cut('insurer');
    const row = pg.locator('#marketplace-apps-body tr', { hasText: c.employer.company });
    const approve = row.locator('button', { hasText: 'Approve' });
    await camera.speedWhile(() => approve.waitFor({ timeout: 90000 }), { factor: 4 });
    // TODO(selector): 'Review PDF' (a.btn 'Review PDF' in this row) is a plain link to an admin-only route and answers
    // 401 until the screen fix "Insurer Review PDF: fetch with the token" lands; headless Chromium also has no PDF
    // viewer. The letter is therefore not opened on camera; the analyst's line covers the check.
    await row.locator('button', { hasText: 'Review PDF' }).hover().catch(() => {});
    await speak('approve', 'check');
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
    // activation runs by itself: POST activate, activate-status every 2 s, then activate-credentials
    await speak('sign', 'activation');
    const creds = await timed('activation', () => camera.speedWhile(() => sniffer.waitFor('credentials', { since, timeout: 180000 }), { factor: 4 }));
    secrets.tenantToken = creds.value?.data?.adminToken || '';
    take.employerNodeUrl = creds.value?.data?.employerNodeUrl || null;
    if (!secrets.tenantToken || !take.employerNodeUrl) throw new Error('activation did not hand over the employer node URL and admin token');
    // TODO(selector): the banner still reads "Provisioning your employer node and HR Tool" until the label fix (A7).
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
    // do not open the Roster tab: it calls /roster without the token until the roster fix
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
    await speak('codes', 'import');
    await st.uploadVia(zone, assets.csv);
    await pg.locator('#csv-preview-panel table').waitFor({ timeout: 30000 });
    await speak('codes', 'preview');
    await pg.locator('#imp-valid-until').fill(c.codes.validUntil);
    await speak('codes', 'expiry');
    const since = Date.now();
    await pg.locator('#btn-import-go').click();
    const imp = await timed('import', () => sniffer.waitFor('import', { since, timeout: 180000 }));
    const mine = (imp.value?.data?.results || []).find((r) => r.employeeId === c.member.employeeId);
    if (!mine || !mine.tokenId || !mine.tokenPIN) throw new Error('the import did not return a code and PIN for the member');
    secrets.code = mine.tokenId;
    secrets.pin = mine.tokenPIN;
    await pg.locator('#csv-results-panel .table-wrap').waitFor({ timeout: 30000 }); // redacted on screen (lib/masks.mjs)
    await speak('codes', 'channels');
    await speak('codes', 'after');
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
    await Promise.all([speak('enroll', 'identity'), (async () => {
      // fictional values, blurred on screen (lib/masks.mjs); nobody reads them aloud
      await pg.locator('#ob-cid').fill(c.member.cardholderId);
      await pg.locator('#ob-fn').fill(c.member.firstName);
      await pg.locator('#ob-next').click();
      await pg.locator('#ob-ln').waitFor({ timeout: 15000 });
      await pg.locator('#ob-ln').fill(c.member.lastName);
      await pg.locator('#ob-dob').fill(c.member.dob);
    })()]);
    const since = Date.now();
    take.enrollStartedAt = since;
    await pg.locator('#ob-next').click();
    // step 4 runs by itself: generate-key, redeem (device -> insurer -> employer), derive-wallet
    await st.card('Behind this', ['The code and a hash of the PIN go to the insurer, which forwards them, signed, to the employer node that issued the code', 'A group hash and a plan hash come back to the phone'], { ms: 12000 });
    await speak('enroll', 'redeem');
    const w = await sniffer.waitFor('wallet', { since, timeout: 180000 });
    take.walletId = w.value?.data?.walletId || null;
    if (!take.walletId) throw new Error('derive-wallet did not answer a wallet ID');
    // step 5 (enroll, compile, the registration proof) carries on while the film is at the whiteboard
  },

  'board-wallet': async () => { await camera.cut('board'); await speakAll('board-wallet'); },
  'board-registration': async () => { await camera.cut('board'); await speakAll('board-registration'); },

  async enrolled() {
    const { page: pg } = shot('member');
    await camera.cut('member');
    const enter = pg.locator('#ob-enter');
    const retry = pg.locator('#ob-retry');
    // compile (~27 s) and the registration proof (~40 s) may still be running: speed up the wait, never a voice
    await timed('enrollment-step-5', () => camera.speedWhile(() => until('enrollment to complete on the phone', async () => {
      if (await visible(enter)) return true;
      if (await visible(retry)) throw fatal(`enrollment failed on the phone: ${(await pg.locator('#onboard-body').innerText().catch(() => '')).slice(0, 400)}`);
      return false;
    }, { timeout: 600000, every: 1000 }), { factor: 6 }));
    take.timings['enrollment-total'] = Date.now() - (take.enrollStartedAt || Date.now());
    // TODO(selector): the completion text still says "registered on the Adjuda-GATOR network" until that label fix.
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
    const talk = speakAll('status-registration');
    const receipts = await reads.receiptsByWallet(take.walletId).catch(() => []);
    const reg = receipts.find((r) => r.isRegistration) || receipts[0];
    await status.update('upsertRow', { id: 'reg', label: 'Registration proof', value: reg ? `accepted · ${short(reg.receiptId)}` : 'not read', tone: reg ? 'ok' : 'wait', source: 'l2_getReceiptsByWallet (operator read)', note: reg && reg.auditEventHash ? `audit event ${short(reg.auditEventHash)}` : undefined });
    await sleep(1800);
    const m = await reads.member(take.walletId).catch(() => null);
    await status.update('upsertRow', { id: 'record', label: 'Engine record', value: m ? `${m.lifecycle} · ${m.planId}` : 'not read', tone: m ? 'ok' : 'wait', source: '/interactive/state (allowlisted fields)' });
    if (m && m.accumulator) await status.update('upsertRow', { id: 'limits', label: 'Her plan limits', value: `${cents(m.accumulator.limits?.deductibleAmountCents)} · ${cents(m.accumulator.limits?.oopMaxCents)}`, tone: 'info', source: '/interactive/state accumulator.limits', note: 'deductible · out-of-pocket maximum' });
    await sleep(1800);
    const ws = await reads.walletState(take.walletId).catch(() => null);
    await status.update('upsertRow', { id: 'inventory', label: 'Credential inventory root', value: ws ? `${short(ws.credentialInventoryRoot)} · nonce ${ws.nonce}` : 'not read', tone: ws ? 'ok' : 'wait', source: 'l2_getWalletState (operator read)', note: 'changed by the first credential update (the mint)' });
    await talk;
  },

  async pcp() {
    const { page: pg } = shot('member');
    await camera.cut('member');
    await pg.locator('a.nav-link[data-tab="providers"]').click();
    // TODO(selector): the doctor's card is found by name; the name comes from the fictional prescribers.json the
    // take boots with (the PROVIDERS preparation). Row 0 is "Miriam Fallowmere" in the working tree's uncommitted
    // provider replacement (2026-10-19); confirm once it is committed.
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
    // TODO(selector): the pharmacy option is found by name (fictional pharmacies.json; row 0 "Kettleby Pharmacy" in the
    // working tree's uncommitted provider replacement; confirm once it is committed)
    await selectByText(pg.locator('#rx-pharmacy-select'), c.pharmacy.match);
    // TODO(selector): the drug option is found by its label ("ALLOPURINOL 100 MG ..."); confirm it is in the first
    // 500 formulary rows with ZKTRIDENT_FORMULARY_LIMIT=100 (rehearsal)
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
    // TODO(selector): the badge says "ZK Proof: Verified" and lists the wrong four proofs until the prescriber
    // label fixes; keep the narration from repeating it.
    await speak('prescribe', 'proof');
    await timed('prescribe-proof', () => camera.speedWhile(() => until('the prescription proof', async () => {
      const cls = await badge.getAttribute('class');
      if (/badge-failed|badge-error/.test(cls || '')) throw fatal(`prescription proof failed: ${await pg.locator('#rx-proof-detail').innerText().catch(() => '')}`);
      return /badge-settled/.test(cls || '');
    }, { timeout: 600000, every: 1000 }), { factor: 6 }));
    await st.hideCard();
  },

  async fill() {
    const { page: pg } = shot('pharmacy');
    await camera.cut('pharmacy');
    await pg.locator('.nav-tab[data-tab="workstation"]').click();
    // TODO(selector): the card is found by the drug's label (brandName, truncated to 20 characters)
    const script = pg.locator('#ws-adjudicated-list .script-card', { hasText: c.drug.match });
    await camera.speedWhile(() => until('the prescription in the Adjudicated column', async () => {
      if (await script.count()) return true;
      await pg.locator('#ws-refresh-btn').click().catch(() => {});
      return false;
    }, { timeout: 180000, every: 5000 }), { factor: 4 });
    // a PENDING script shows no Fill until the prescriber's proofs finish, and a refused fill no longer moves the card
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
    await speak('attest', 'ask');
    await pg.locator('a.nav-link[data-tab="backup"]').click();
    const req = pg.locator('#attestation-btn');
    await req.scrollIntoViewIfNeeded(); // keeps the stale 'Recovery Backup' panel above out of frame
    const since = Date.now();
    await req.click();
    const copyBtn = pg.locator('#credential-copy-btn');
    await pg.locator('#credential-copy-btn:not([disabled])').waitFor({ timeout: 90000 });
    // TODO(selector): the result card reads att.expiry, att.signature and att.nonce (the fields are exp, sig and n),
    // so it shows '--' until the member screen fix.
    await copyBtn.click();
    await speak('attest', 'copy');
    // the copied JSON is a signed public value; it stands in for the NFC tap
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
    await pg.locator('#ws-verify-wallet').fill(take.attestationJson, { paste: true });
    await pg.locator('#ws-verify-lookup-btn').click();
    // BLOCKED until the /nfc/scan fix (prepare:screens action 1): today the route answers 500 and Dispense stays disabled
    const verified = pg.locator('#ws-verify-status.verified');
    const failed = pg.locator('#ws-verify-status.error');
    await until('the member to be verified', async () => {
      if (await visible(verified)) return true;
      if (await visible(failed)) throw fatal(`Verify Member failed: ${await failed.innerText().catch(() => '')}`);
      return false;
    }, { timeout: 90000, every: 500 });
    await speak('verify-dispense', 'verified');
    const card = pg.locator('#ws-filled-list .script-card', { hasText: c.drug.match }).first();
    await speak('verify-dispense', 'dispense');
    take.dispenseAt = Date.now();
    await card.locator('button', { hasText: 'Dispense' }).click();
    await closeDetail(pg);
    await st.card('Behind this click', [`The pharmacy node sends quantity ${c.drug.quantity}, ingredient ${c.say.ingredient} and fee ${c.say.fee} to the engine`, 'The engine builds the fill proof'], { ms: 12000 });
    await speak('verify-dispense', 'proving');
    // the fill proof runs in the engine while the film is at the whiteboard
  },

  'board-deductible': async () => { await camera.cut('board'); await speakAll('board-deductible'); },
  'board-settlement': async () => { await camera.cut('board'); await speakAll('board-settlement'); },

  async pay() {
    const { page: pg } = shot('pharmacy');
    await camera.cut('pharmacy');
    const card = pg.locator('#ws-dispensed-list .script-card', { hasText: c.drug.match }).first();
    await timed('fill-proof', () => camera.speedWhile(() => card.locator('.script-issue-badge', { hasText: 'ZK Proved' }).waitFor({ timeout: 900000 }), { factor: 6 }));
    take.timings['dispense-to-proved'] = Date.now() - (take.dispenseAt || Date.now());
    await speak('pay', 'price');
    await speak('pay', 'question');
    await speak('pay', 'answer');
    await speak('pay', 'relief');
    await Promise.all([speak('pay', 'counsel'), (async () => {
      await card.locator('button', { hasText: 'Payment Received' }).click();
      await closeDetail(pg);
    })()]);
    await speak('pay', 'after');
  },

  async 'status-update'() {
    await camera.cut('status');
    await status.update('clear');
    await status.update('setTitle', { title: 'Meanwhile, on the phone', subtitle: 'The claim waits for one more proof, made on the member’s device' });
    const lines = linesOf('status-update', 'lines');
    const first = lines.slice(0, 1);
    const rest = lines.slice(1);
    const m0 = await reads.member(take.walletId).catch(() => null);
    await status.update('upsertRow', { id: 'pending', label: 'Wallet updates waiting for the phone', value: m0 ? String(m0.pendingWalletUpdates) : 'not read', tone: 'wait', source: '/interactive/state pendingWalletUpdates (allowlisted)', note: 'the phone checks for work every 20 seconds' });
    for (const l of first) await narrator.say(() => camera.page(), PERSONS[l.who], l, { during: boardRunner.during(l) });
    const m1 = await timed('claim-update', () => camera.speedWhile(() => until('the phone to prove the claim update', async () => {
      const m = await reads.member(take.walletId);
      await status.update('upsertRow', { id: 'pending', label: 'Wallet updates waiting for the phone', value: String(m?.pendingWalletUpdates ?? '?'), tone: m && m.pendingWalletUpdates === 0 ? 'ok' : 'wait', source: '/interactive/state pendingWalletUpdates (allowlisted)', note: 'the phone checks for work every 20 seconds' });
      return m && m.pendingWalletUpdates === 0 ? m : null;
    }, { timeout: 600000, every: 3000 }), { factor: 6 }));
    const receipts = await reads.receiptsByWallet(take.walletId).catch(() => []);
    const claim = receipts.filter((r) => !r.isRegistration && r.claimLeafIndex != null).pop() || receipts.filter((r) => !r.isRegistration).pop();
    await status.update('upsertRow', { id: 'receipt', label: 'Wallet-update proof', value: claim ? `accepted · ${short(claim.receiptId)}` : 'not read', tone: claim ? 'ok' : 'wait', source: 'l2_getReceiptsByWallet (operator read)', note: claim && claim.claimLeafIndex != null ? `claim leaf ${claim.claimLeafIndex}` : undefined });
    if (m1 && m1.accumulator) await status.update('upsertRow', { id: 'acc', label: 'Her running totals (engine record)', value: `${cents(m1.accumulator.deductiblePaidCents)} · ${cents(m1.accumulator.oopPaidCents)}`, tone: 'info', source: '/interactive/state accumulator', note: 'deductible paid · out-of-pocket paid' });
    const stt = await reads.status().catch(() => null);
    if (stt) await status.update('countdown', { id: 'batch', label: 'Next batch', ms: stt.nextBatchInMs, source: 'l2_getStatus nextBatchInMs' });
    for (const l of rest) await narrator.say(() => camera.page(), PERSONS[l.who], l, { during: boardRunner.during(l) });
  },

  'board-ledger': async () => { await camera.cut('board'); await speakAll('board-ledger'); },

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
    await until('the chain integrity result', async () => /PASS|FAIL|Error/.test(await pg.locator('#audit-chain-val').innerText()), { timeout: 120000 });
    await pg.locator('#audit-finance-card').click();
    await until('the financial balance result', async () => /PASS|FAIL|Error/.test(await pg.locator('#audit-finance-val').innerText()), { timeout: 120000 });
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
    // TODO(selector): the card prints "NADAC $0.00 + Fee $13.00" until the NADAC price and label fixes
    await claim.first().scrollIntoViewIfNeeded();
    await speak('pickup', 'claim');
    await pg.locator('a.nav-link[data-tab="dashboard"]').click();
    // TODO(selector): the spend hero shows the default $1,500 / $5,000 limits until the plan-limits fix
    await pg.locator('#spend-hero .spend-row').waitFor({ timeout: 60000 }).catch(() => {});
    await speak('pickup', 'dashboard');
    await speak('pickup', 'closing');
    await sleep(1500);
  }
};
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
  T0, T1, failure, rehearsal: REHEARSAL, scriptStatus: SCRIPT_STATUS, stopAfter,
  acts: ACTS,
  people: Object.fromEntries(Object.values(PERSONS).map((p) => [p.key, { name: p.name, role: p.role, voice: REHEARSAL ? null : p.voice }])),
  cast: { plan: c.plan, employer: { company: c.employer.company, employerId: c.employer.employerId }, group: c.group, drug: c.drug, pricing: c.pricing, say: c.say },
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
