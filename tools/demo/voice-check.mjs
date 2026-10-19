#!/usr/bin/env node
/**
 * Every line the walkthrough (director.mjs) will say, rendered in the chosen voices before a take and listened back
 * with the local faster-whisper check (py/check_asr.py), so a garbled word, a swallowed phrase or a cue read aloud is
 * caught before it is on camera. The clips land in the narrator's cache (demo-out/voice-cache) with exactly the
 * director's parameters, so the take reuses them byte for byte, and the check saves each clip's word times next to
 * it (<clip>.words.json) for the whiteboard's { word } cues. Nothing is sent anywhere. Adapted from SwapStreet's
 * site-e2e/voice-check.mjs.
 *
 * This uses the GPU (Maya1, Orpheus) and the CPU (Kokoro, Turbo, Whisper): run it when no proofs are running.
 *
 *   node voice-check.mjs --voices narrator=maya:narrator,hr=maya:hr,analyst=maya:analyst,member=turbo:af_heart,prescriber=maya:prescriber,pharmacist=orpheus:dan
 *   node voice-check.mjs --voices ... --only narrator,member      just those people
 *
 * Prints one line per spoken line: how well the transcript matches the script (1 = word for word) and, below 0.85,
 * what was heard. Results: demo-out/voice-check/<person>/asr.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseVoices } from './lib/args.mjs';
import { synth, stopEngines, stripCues, engineVoice, knownVoice, TOOLS, OUT_ROOT, VOICE_CACHE } from './lib/narrate.mjs';
import { PEOPLE, castOf, allLines } from './lib/claim-script.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const VOICE_DEFAULT = { narrator: 'maya:narrator', hr: 'maya:hr', analyst: 'maya:analyst', member: 'turbo:af_heart', prescriber: 'maya:prescriber', pharmacist: 'orpheus:dan' };
const voices = { ...VOICE_DEFAULT, ...parseVoices(args.voices) };
const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : Object.keys(PEOPLE);
for (const k of only) {
  if (!PEOPLE[k]) throw new Error(`no person "${k}" (${Object.keys(PEOPLE).join(', ')})`);
  if (!knownVoice(voices[k]) || !engineVoice(voices[k])) throw new Error(`${k}: ${voices[k]} is not an engine voice lib/narrate.mjs knows`);
}
const OUT = path.resolve(args.out || path.join(OUT_ROOT, 'voice-check'));
const ASR_PY = path.join(TOOLS, 'tts', 'venv-asr', 'Scripts', 'python.exe');
const CHECK = path.join(HERE, 'py', 'check_asr.py');
const all = allLines(castOf());
const dirs = [];
for (const key of only) {
  const p = PEOPLE[key];
  const dir = path.join(OUT, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Set();
  const lines = [];
  for (const l of all.filter((x) => x.who === key)) {
    const mood = l.mood || p.mood; // exactly what director.mjs passes, so the cache key matches
    if (seen.has(`${mood}|${l.text}`)) continue;
    seen.add(`${mood}|${l.text}`);
    const c = await synth(l.text, { voice: voices[key], mood, cacheDir: VOICE_CACHE });
    const file = `${String(lines.length + 1).padStart(2, '0')}.wav`;
    fs.copyFileSync(c.file, path.join(dir, file));
    lines.push({ file, text: stripCues(l.text), ms: c.ms, scene: l.scene, beat: l.beat, source: c.file });
    process.stdout.write('.');
  }
  fs.writeFileSync(path.join(dir, 'timings.json'), JSON.stringify({ voice: voices[key], lines }, null, 2));
  dirs.push(dir);
  console.log(` ${key}: ${lines.length} lines in ${voices[key]}`);
}
stopEngines();
if (!fs.existsSync(ASR_PY)) throw new Error(`the Whisper check is not installed: ${ASR_PY}`);
const r = spawnSync(ASR_PY, ['-I', CHECK, ...dirs], { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ZPK_DEMO_TOOLS: TOOLS } });
if (r.status !== 0) throw new Error(`check_asr failed: ${(r.stderr || '').slice(-800)}`);
let weak = 0;
for (const dir of dirs) {
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'asr.json'), 'utf8'));
  const list = Array.isArray(a) ? a : (a.results || a.lines || []);
  console.log(`\n${path.basename(dir)} (${voices[path.basename(dir)]})`);
  for (const x of list) {
    const m = Number(x.match);
    if (m < 0.85) weak += 1;
    console.log(`  ${x.file} ${m.toFixed(2)}  ${m < 0.85 ? `meant "${x.meant}" | heard "${x.heard}"` : String(x.meant).slice(0, 70)}`);
  }
}
console.log(`\n${weak} lines below 0.85${weak ? ' (rework them: reword, or add a toSpeech rule in lib/narrate.mjs)' : ''}`);
