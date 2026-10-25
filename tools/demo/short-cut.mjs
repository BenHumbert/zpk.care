#!/usr/bin/env node
/**
 * A short cut of a finished take: whole scenes taken from its walkthrough.mp4 in film order, each with a short fade,
 * joined into one film, with its own captions and player page. The take's film already carries the mixed voices,
 * and the camera only cuts in silence, so a scene boundary never splits a spoken line.
 *
 *   node short-cut.mjs --take demo-out/<stamp>                       the default scene list (about seven minutes)
 *   node short-cut.mjs --take demo-out/<stamp> --scenes plan,enroll,prescribe,pickup --name short.mp4
 *   node short-cut.mjs --take demo-out/<stamp> --list                the take's scenes with their lengths
 *
 * Output beside the take's film: <name> (default short.mp4), <name>.srt and <name>.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, srt } from './lib/narrate.mjs';
import { playerHtml, probeMs } from './lib/post.mjs';

/**
 * The story in brief: the plan, the member enrolling, the gate that checks every proof, her wallet ID, her doctor, the
 * prescription, the pharmacy and the counter, the price, her phone's proof accepted at the same gate, and the pickup.
 * pcp stays because the prescription scene says the member named this doctor as primary care; fill introduces the
 * pharmacist; board-gate and the two status scenes keep the one thing a viewer must not miss, that the network checks
 * every proof, beside the caveats about what it does not check yet.
 */
const DEFAULT_SCENES = ['plan', 'enroll', 'board-gate', 'enrolled', 'pcp', 'prescribe', 'fill', 'attest', 'verify-dispense', 'pay',
  'status-update', 'status-accepted', 'pickup'];
const FADE = 0.35;
// A scene often opens on a line that starts within milliseconds of the cut, so the sound gets only a click guard:
// a fade as long as the picture's would swallow the first word.
const AUDIO_EDGE = 0.015;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const takeDir = arg('take');
if (!takeDir || takeDir === true) throw new Error('short-cut: --take <take folder> is required');
const summaryFile = path.join(takeDir, 'scenes.json');
if (!fs.existsSync(summaryFile)) throw new Error(`short-cut: no scenes.json in ${takeDir} (build the film first)`);
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
const film = path.join(takeDir, summary.film || 'walkthrough.mp4');
if (!fs.existsSync(film)) throw new Error(`short-cut: no film at ${film}`);

if (arg('list', false)) {
  for (const s of summary.scenes) console.log(`${String(s.act).padEnd(3)}${s.key.padEnd(22)}${((s.end - s.start) / 1000).toFixed(0).padStart(5)} s  ${s.title}`);
  process.exit(0);
}

const wanted = String(arg('scenes', DEFAULT_SCENES.join(','))).split(',').map((k) => k.trim()).filter(Boolean);
const byKey = new Map(summary.scenes.map((s) => [s.key, s]));
const missing = wanted.filter((k) => !byKey.has(k));
if (missing.length) throw new Error(`short-cut: the take has no scene ${missing.join(', ')} (see --list)`);
// film order, whatever order they were named in
const chosen = summary.scenes.filter((s) => wanted.includes(s.key));

const name = String(arg('name', 'short.mp4'));
const out = path.join(takeDir, name);
// absolute, because the concat demuxer resolves the list's entries against the list's own folder
const work = path.resolve(takeDir, `${path.parse(name).name}-pieces`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const scenes = [];
const lines = [];
let at = 0;
for (let i = 0; i < chosen.length; i++) {
  const s = chosen[i];
  // Whole frames only, rounded down so a piece never takes the first frame of the scene after it, and the sound padded
  // to exactly that length: sound a few milliseconds short of its picture would add up, join by join, into drift.
  const frames = Math.floor(((s.end - s.start) / 1000) * 30 + 1e-6);
  const sec = frames / 30;
  const file = path.join(work, `piece-${String(i + 1).padStart(2, '0')}.mp4`);
  const vf = [`fade=t=in:st=0:d=${FADE}`];
  const af = [`afade=t=in:st=0:d=${AUDIO_EDGE}`];
  if (sec > FADE * 2) vf.push(`fade=t=out:st=${(sec - FADE).toFixed(3)}:d=${FADE}`);
  if (sec > AUDIO_EDGE * 2) af.push(`afade=t=out:st=${(sec - AUDIO_EDGE).toFixed(3)}:d=${AUDIO_EDGE}`);
  af.push(`apad=whole_dur=${sec.toFixed(6)}`, `atrim=end=${sec.toFixed(6)}`);
  await ffmpeg(['-ss', (s.start / 1000).toFixed(3), '-i', film, '-vf', vf.join(','), '-af', af.join(','), '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', file]);
  const ms = (await probeMs(file)) ?? Math.round(sec * 1000);
  scenes.push({ key: s.key, act: s.act, title: s.title, start: at, end: at + ms });
  for (const l of summary.lines || []) {
    if (l.at >= s.start && l.at < s.end) lines.push({ ...l, at: at + (l.at - s.start) });
  }
  console.log(`short-cut: ${s.key} ${(ms / 1000).toFixed(1)} s`);
  at += ms;
}

const list = path.join(work, 'list.txt');
fs.writeFileSync(list, scenes.map((_, i) => `file '${path.join(work, `piece-${String(i + 1).padStart(2, '0')}.mp4`).replace(/\\/g, '/')}'`).join('\n') + '\n');
// The picture is copied; the sound is encoded once more as one stream, because copying each piece's AAC leaves
// timestamps that step backwards at every join (each piece carries its own encoder priming).
await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
  '-movflags', '+faststart', out]);
const durationMs = (await probeMs(out)) ?? at;

fs.writeFileSync(path.join(takeDir, `${name}.srt`), srt(lines, 0));
const shortSummary = { film: name, durationMs, startedAt: summary.startedAt, acts: [], scenes, pieces: [], lines };
fs.writeFileSync(path.join(takeDir, `${name}.html`), playerHtml(shortSummary, 'zpk.care: one claim, in brief'));
fs.rmSync(work, { recursive: true, force: true });
console.log(`short-cut: ${out} (${(durationMs / 1000).toFixed(1)} s, ${scenes.length} scenes, ${lines.length} lines)`);
