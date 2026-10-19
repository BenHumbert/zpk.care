#!/usr/bin/env node
/**
 * The whiteboard on its own, offline: no network, no servers, no zpk node. It writes equations from
 * lib/equations.mjs stroke by stroke, records the board like a take, saves PNG frames mid-write and at the end, and
 * builds a short preview.mp4 through the same post step as the film (lib/post.mjs), including one sped-up stretch on
 * the director's status card so the badge and the cut can be checked too.
 *
 *   node whiteboard-preview.mjs                                   a quick pass over three cards (about 40 s)
 *   node whiteboard-preview.mjs --cards 2b,7b,10                  choose the cards for the quick pass
 *   node whiteboard-preview.mjs --scenes board-wallet,board-ledger   the script's board beats (lib/claim-script.mjs)
 *   node whiteboard-preview.mjs --scenes board-wallet --voices narrator=maya:narrator   with the cached, checked voice
 *   node whiteboard-preview.mjs --texts                           print every card's glyph text (for { find } targets)
 * Options: --out <dir>, --no-post, --no-rough. Voices are never synthesised here (cacheOnly): render them first with
 * voice-check.mjs. Output: demo-out/<stamp>-whiteboard/ (preview.mp4, mid-*.png, end-*.png, take.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseVoices, stampNow } from './lib/args.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { openWhiteboard, directorContext } from './lib/whiteboard.mjs';
import { openStatusCard } from './lib/status-card.mjs';
import { makeBoardRunner } from './lib/board-beats.mjs';
import { Camera } from './lib/camera.mjs';
import { Narrator, OUT_ROOT, VOICE_CACHE, knownVoice } from './lib/narrate.mjs';
import { assemble } from './lib/post.mjs';
import { EQUATIONS, eq } from './lib/equations.mjs';
import { PEOPLE, SCENES, castOf, storyLines } from './lib/claim-script.mjs';

const args = parseArgs();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s] ${s}`);
const OUT = path.resolve(args.out || path.join(OUT_ROOT, `${stampNow()}-whiteboard`));
const RAW = path.join(OUT, 'raw');
fs.mkdirSync(RAW, { recursive: true });

const voices = parseVoices(args.voices);
const narratorVoice = voices.narrator || null;
if (narratorVoice && !knownVoice(narratorVoice)) throw new Error(`--voices: unknown voice ${narratorVoice}`);
const PERSONS = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [k, { ...p, voice: voices[k] || narratorVoice || 'kokoro:bm_george' }]));
const sceneKeys = args.scenes ? String(args.scenes).split(',').map((s) => s.trim()).filter(Boolean) : [];
for (const k of sceneKeys) if (!SCENES.some((s) => s.key === k && s.kind === 'board')) throw new Error(`--scenes: "${k}" is not a board scene (${SCENES.filter((s) => s.kind === 'board').map((s) => s.key).join(', ')})`);

const browser = await launchBrowser();
const ctx = await directorContext(browser, { recordVideoDir: RAW });
const board = await openWhiteboard({ browser, context: ctx, log, rough: !args['no-rough'] });
const card = args['no-status'] ? null : await openStatusCard({ browser, context: ctx, log });
log(`whiteboard ready: MathJax ${board.mathjax}, Comic Neue ${board.fontLoaded ? 'loaded' : 'NOT loaded (fallback font)'}`);
const prep = await board.prepare(EQUATIONS.map((e) => ({ id: `eq-${e.key}`, latex: e.latex })));
log(`typeset all ${prep.count} cards with no errors`);

if (args.texts) {
  for (const e of EQUATIONS) console.log(`${e.key.padEnd(4)} ${await board.text(`eq-${e.key}`)}`);
  await ctx.close();
  await browser.close();
  process.exit(0);
}

const narrator = new Narrator({ cacheDir: VOICE_CACHE, log, silent: !narratorVoice, cacheOnly: true });
const camera = new Camera({ narrator, log });
narrator.onTurnStart = (at) => camera.endSpeedUp(at);
camera.register('board', { page: board.page, videoStartedAt: board.startedAt, label: 'Whiteboard' });
if (card) camera.register('status', { page: card.page, videoStartedAt: card.startedAt, label: 'Status card (drawn by the director)' });
const runner = makeBoardRunner({ board, log });
const shots = [];
const shoot = async (name) => {
  const f = path.join(OUT, `${name}.png`);
  await board.page.screenshot({ path: f });
  shots.push(f);
  log(`frame: ${f}`);
};

const T0 = Date.now();
const narr = PERSONS.narrator;
if (!sceneKeys.length) {
  // ---------------------------------------------------------------- the quick pass: a few cards, fixed pacing
  const cards = String(args.cards || '2b,7b,10').split(',').map((s) => s.trim()).filter(Boolean);
  camera.scene('quick', { act: 1, title: 'Whiteboard preview' });
  await camera.cut('board');
  await board.setTitle('Whiteboard preview: written stroke by stroke');
  for (let i = 0; i < cards.length; i++) {
    const k = cards[i];
    const e = eq(k);
    if (i === 1) {
      // the eraser leaves a faint ghost of the last board
      await board.clear({ ghost: 0.06 });
      await board.setTitle(`Card ${k}: ${e.moment.replace(/^\S+\s/, '').slice(0, 60)}`);
    }
    const ms = Math.min(9000, 2500 + e.latex.length * 6);
    const writing = board.writeEquation(e.latex, { id: `eq-${k}`, durationMs: ms, size: i === 0 ? 50 : 38 });
    if (i === 0) {
      await sleep(Math.round(ms * 0.55));
      await shoot('mid-write');
    }
    const r = await writing;
    log(`card ${k}: ${r ? `${r.glyphs} glyphs at ${r.size}px${r.shrunk ? ' (shrunk to fit)' : ''}` : 'FAILED'}`);
    if (k === '2b') {
      await board.circle({ eq: 'eq-2b', find: 'f0,f1,f2,f3,f4' }, { color: 'blue' });
      await board.annotate('stays on the phone', { near: { eq: 'eq-2b', find: 'f0,f1,f2,f3,f4' }, side: 'below', color: 'blue' });
      await board.circle({ eq: 'eq-2b', find: 'f5' }, { color: 'red' });
      await board.box({ eq: 'eq-2b', find: 'W' }, { color: 'green' });
      await board.annotate('leaves the phone', { near: { eq: 'eq-2b', find: 'W' }, side: 'below', color: 'green' });
    }
    if (k === '7b') {
      await board.value({ eq: 'eq-7b', find: 'T=' }, '1,418', { side: 'above' });
      await board.underline({ eq: 'eq-7b', line: 2 }, { color: 'blue' });
    }
    if (k === '10') {
      await board.circle({ eq: 'eq-10', find: 'H(dos)' }, { color: 'red' });
      await board.check({ eq: 'eq-10', line: 2 }, { label: 'recomputed: match' });
    }
  }
  await sleep(600);
  await shoot('end-board');
} else {
  // ---------------------------------------------------------------- the script's board scenes
  const c = castOf();
  const S = storyLines(c);
  for (const key of sceneKeys) {
    const sc = SCENES.find((s) => s.key === key);
    camera.scene(key, { act: sc.act, title: sc.title });
    await camera.cut('board');
    let midDone = false;
    for (const [, lines] of Object.entries(S[key] || {})) {
      for (const line of lines) {
        const write = (line.board || []).find((a) => a.do === 'write');
        const during = line.board && line.board.length ? async (clip) => {
          if (write && !midDone) {
            midDone = true;
            const more = line.board.some((a) => a.do !== 'write');
            const ms = write.ms ?? Math.max(1500, Math.round((more ? 0.62 : 0.8) * clip.ms));
            setTimeout(() => shoot(`mid-${key}`).catch(() => {}), Math.round(ms * 0.5));
          }
          await runner.run(line.board, clip);
        } : undefined;
        await narrator.say(() => camera.page(), PERSONS[line.who] || narr, line, { during });
      }
    }
    await board.idle();
    await sleep(800);
    await shoot(`end-${key}`);
  }
}

if (card) {
  // ---------------------------------------------------------------- one cut to the status card, with a sped-up wait
  camera.scene('status', { act: 2, title: 'Status card (preview values)' });
  await card.update('setTitle', { title: 'Status card preview', subtitle: 'Placeholder values: the real card is filled from the network’s read-only answers' });
  await card.update('upsertRow', { id: 'a', label: 'Wallet-update proof', value: 'accepted · 4f1c0b2a…9e01d3', tone: 'ok', source: 'l2_getReceiptsByWallet (preview value)' });
  await card.update('upsertRow', { id: 'b', label: 'Wallet updates waiting for the phone', value: '1', tone: 'wait', source: '/interactive/state pendingWalletUpdates (preview value)' });
  await card.update('countdown', { id: 'c', label: 'Next batch', ms: 12000, source: 'l2_getStatus nextBatchInMs (preview value)' });
  await camera.cut('status');
  await sleep(1500);
  await camera.speedWhile(async () => {
    await sleep(3000);
    await card.update('upsertRow', { id: 'b', label: 'Wallet updates waiting for the phone', value: '0', tone: 'ok', source: '/interactive/state pendingWalletUpdates (preview value)' });
    await sleep(3000);
  }, { factor: 4 });
  await sleep(1500);
  await card.page.screenshot({ path: path.join(OUT, 'end-status.png') });
  shots.push(path.join(OUT, 'end-status.png'));
}
await narrator.quiet();
await sleep(800);
const T1 = Date.now();

for (const s of camera.shots.values()) s.video = s.page.video() ? await s.page.video().path() : null;
await ctx.close();
await browser.close();
const cam = camera.toJSON();
const take = {
  T0, T1, preview: true, acts: { 1: 'Whiteboard', 2: 'Status card' },
  shots: cam.shots, cuts: cam.cuts, speedups: cam.speedups, scenes: cam.scenes,
  lines: narrator.lines.map((l) => ({ at: l.at, ms: l.ms, name: l.name, persona: l.persona, text: l.text, file: l.file }))
};
fs.writeFileSync(path.join(OUT, 'take.json'), JSON.stringify(take, null, 2));
if (!args['no-post']) {
  const r = await assemble({ outDir: OUT, take, log, filmName: 'preview.mp4', title: 'zpk.care whiteboard preview' });
  log(`preview: ${r.film} (${(r.durationMs / 1000).toFixed(1)} s)`);
}
log(`frames: ${shots.join(', ')}`);
