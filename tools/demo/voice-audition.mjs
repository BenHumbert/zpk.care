#!/usr/bin/env node
/**
 * A voice audition for the zpk.care walkthrough: each person's sample lines in several candidate voices, as small
 * MP3s and one listening page. Engines (lib/narrate.mjs): Kokoro presets, Chatterbox and Chatterbox Turbo reading in
 * those same voices from reference clips made here from Kokoro (so every voice stays Apache-2.0 / MIT), Maya1, whose
 * voices are designed from the plain descriptions in MAYA_VOICES, and Orpheus 3B with its own voices. Runs are merged
 * into one audition.json, so each engine can be added when it is ready. Nothing is sent anywhere. Adapted from
 * SwapStreet's site-e2e/voice-audition.mjs; new reference clips go to demo-out/voice-refs, so the SwapStreet folder
 * is only read.
 *
 * This is the only step besides voice-check.mjs that uses the GPU (Maya1, Orpheus): run it when no proofs are running.
 *
 *   node voice-audition.mjs --engines kokoro,maya,orpheus,turbo      the clips (default kokoro)
 *   node voice-audition.mjs --page [--asr <dir>] [--cast "<text>"]   write audition.html
 *     --asr: a folder with <person>-<engine>-<voice>/asr.json (py/check_asr.py); --cast: the cast in use
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { synth, stopEngines, stripCues, REFS_DIR, refPath, ffmpeg, OUT_ROOT, VOICE_CACHE, MAYA_VOICES } from './lib/narrate.mjs';
import { PEOPLE, SCRIPT_STATUS, castOf, allLines } from './lib/claim-script.mjs';

const args = parseArgs();
const OUT = path.resolve(args.out || path.join(OUT_ROOT, 'voice-audition'));
const DB = path.join(OUT, 'audition.json');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(REFS_DIR, { recursive: true });

// Sample lines with the words the engines find hard (used while the script is still a placeholder).
const SAMPLE = {
  narrator: [
    { text: 'The phone hashes six fields with one salt, using Poseidon, and only the wallet ID leaves it. The Merkle root moves; nobody learns her name.', mood: 'precise' },
    { text: 'The fill proof prices the claim: fourteen eighteen, the NADAC price plus a thirteen-dollar fee, all of it inside the deductible.', mood: 'precise' }
  ],
  hr: [
    { text: 'Fernhill Test Works. EIN double-zero, forty-four seventeen three twenty-one. Effective today, cap of twenty-five.', mood: 'brisk' },
    { text: 'Codes go in the letters. PINs go by text. Never together.', mood: 'brisk' }
  ],
  analyst: [
    { text: 'Everything on this form is in cents. Five hundred deductible. Seventy-eight hundred out-of-pocket.', mood: 'dry' },
    { text: 'Chain integrity. Pass. Financial balance. Good.', mood: 'dry' }
  ],
  member: [
    { text: 'Code from the letter. PIN from the text. And a recovery PIN, something I will not forget.', mood: 'anxious' },
    { text: 'Oh. I thought it was a ten-dollar copay. Okay, that is less than I was bracing for.', mood: 'relieved' }
  ],
  prescriber: [
    { text: 'She was worried about cost. Generic, then. Allopurinol, a hundred milligrams, once a day.', mood: 'kind' },
    { text: 'No refills until I see her labs. Send.', mood: 'kind' }
  ],
  pharmacist: [
    { text: 'Allopurinol, hundred milligram, thirty. Signature is good. One script ready.', mood: 'wry' },
    { text: 'It will be, once you have met your deductible. Take it after a meal, with plenty of water.', mood: 'wry' }
  ]
};
let LINES = SAMPLE;
if (SCRIPT_STATUS !== 'placeholder') {
  // the real script: each person's first two lines
  const all = allLines(castOf());
  LINES = Object.fromEntries(Object.keys(PEOPLE).map((k) => [k, all.filter((l) => l.who === k).slice(0, 2).map((l) => ({ text: l.text, mood: l.mood }))]));
}
// preset or reference voices per person (Kokoro, Chatterbox, Turbo); Maya1 designs one voice per person
const CANDIDATES = {
  narrator: ['bm_george', 'bm_fable', 'am_eric'],
  hr: ['af_sarah', 'af_nicole'],
  analyst: ['am_michael', 'bm_daniel'],
  member: ['af_heart', 'af_bella'],
  prescriber: ['af_kore', 'bf_alice'],
  pharmacist: ['am_adam', 'bm_lewis']
};
const MAYA = Object.fromEntries(Object.keys(PEOPLE).map((k) => [k, k])); // MAYA_VOICES has one designed voice per person
const ORPHEUS = { narrator: ['leo', 'zac'], hr: ['leah', 'jess'], analyst: ['zac', 'dan'], member: ['tara', 'mia'], prescriber: ['leah', 'zoe'], pharmacist: ['dan', 'leo'] };
const ENGINE_LABEL = { kokoro: 'Kokoro', chatterbox: 'Chatterbox', turbo: 'Chatterbox Turbo', maya: 'Maya1 (GPU)', orpheus: 'Orpheus 3B (GPU)' };
const REF_TEXT = 'Hello. Thank you for taking a moment with me today. Let me walk you through how this works, one careful step at a time.';

const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { rows: [] };
const engines = String(args.engines || (args.page ? '' : 'kokoro')).split(',').map((s) => s.trim()).filter(Boolean);
for (const k of Object.keys(PEOPLE)) if (!MAYA_VOICES[MAYA[k]]) throw new Error(`no Maya1 voice for ${k}`);

if (engines.some((e) => e === 'chatterbox' || e === 'turbo')) {
  // reference clips for the Chatterbox engines, read calmly by each Kokoro voice (new ones go to demo-out/voice-refs)
  for (const v of Object.values(CANDIDATES).flat()) {
    if (refPath(v)) continue;
    const c = await synth(REF_TEXT, { voice: `kokoro:${v}`, mood: 'calm', cacheDir: VOICE_CACHE });
    fs.copyFileSync(c.file, path.join(REFS_DIR, `${v}.wav`));
    console.log(`reference ${v}: ${(c.ms / 1000).toFixed(1)} s`);
  }
}

for (const engine of engines) {
  for (const key of Object.keys(LINES)) {
    const voices = engine === 'maya' ? [MAYA[key]] : engine === 'orpheus' ? ORPHEUS[key] : CANDIDATES[key];
    for (const v of voices) {
      const clips = [];
      for (const line of LINES[key]) {
        const t = Date.now();
        const c = await synth(line.text, { voice: `${engine}:${v}`, mood: line.mood, cacheDir: VOICE_CACHE });
        const mp3 = path.join(OUT, `${key}-${engine}-${v}-${clips.length + 1}.mp3`);
        await ffmpeg(['-i', c.file, '-c:a', 'libmp3lame', '-b:a', '96k', mp3]);
        clips.push({ file: path.basename(mp3), text: stripCues(line.text), mood: line.mood, ms: c.ms, synthMs: Date.now() - t });
        console.log(`${PEOPLE[key].name} ${engine}:${v} ${(c.ms / 1000).toFixed(1)} s audio in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      }
      db.rows = db.rows.filter((r) => !(r.key === key && r.engine === engine && r.voice === v)).concat([{ key, engine, voice: v, clips }]);
      fs.writeFileSync(DB, JSON.stringify(db, null, 2));
    }
  }
}
stopEngines();

if (args.page) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const asrOf = (r) => {
    if (!args.asr) return '';
    const f = path.join(String(args.asr), `${r.key}-${r.engine}-${r.voice}`, 'asr.json');
    if (!fs.existsSync(f)) return '';
    const a = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = Array.isArray(a) ? a : (a.results || a.lines || []);
    const bad = list.filter((x) => Number(x.match) < 0.95);
    if (!bad.length) return '<span class="asr ok">heard word for word</span>';
    const worst = bad.sort((x, y) => Number(x.match) - Number(y.match))[0];
    return `<span class="asr">heard: "${esc(String(worst.heard).slice(0, 80))}"</span>`;
  };
  const order = ['kokoro', 'chatterbox', 'turbo', 'maya', 'orpheus'];
  const people = Object.keys(LINES).map((key) => {
    const p = PEOPLE[key];
    const rows = db.rows.filter((r) => r.key === key).sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine) || a.voice.localeCompare(b.voice));
    const lines = LINES[key].map((l, i) => `<li><span class="n">${i + 1}</span>${esc(stripCues(l.text))}</li>`).join('');
    const body = rows.map((r) => {
      const audio = r.clips.map((c, i) => {
        const data = fs.readFileSync(path.join(OUT, c.file)).toString('base64');
        return `<div class="clip"><span class="n">${i + 1}</span><audio controls preload="metadata" src="data:audio/mpeg;base64,${data}"></audio></div>`;
      }).join('');
      const voiceName = r.engine === 'maya' ? 'designed voice' : r.voice.replace(/^[ab][fm]_/, '').replace(/^./, (m) => m.toUpperCase()) + (r.engine === 'orpheus' ? ' (Orpheus voice)' : '');
      return `<div class="row"><div class="who"><b>${esc(ENGINE_LABEL[r.engine])}</b><span>${esc(voiceName)}</span>${asrOf(r)}</div><div class="clips">${audio}</div></div>`;
    }).join('');
    const design = MAYA_VOICES[MAYA[key]] ? `<div class="design">Maya1 design: ${esc(MAYA_VOICES[MAYA[key]])}</div>` : '';
    return `<section class="person"><div class="ph"><span class="dot" style="background:${p.color}"></span><h2>${esc(p.name)}</h2><span class="role">${esc(p.role)}</span></div>${design}<ol class="lines">${lines}</ol>${body}</section>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice Audition</title>
<style>
:root { --bg:#0a0a0a; --surface:#131313; --raised:#1a1a1a; --line:#262626; --fg:#f4f4f5; --muted:#a1a1aa; --dim:#71717a; --accent:#8b5cf6; color-scheme:dark }
* { box-sizing:border-box } body { background:var(--bg); color:var(--fg); font:15px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; margin:0 }
.wrap { max-width:980px; margin:0 auto; padding-inline:16px; padding-block:28px 64px; display:grid; gap:28px }
h1 { margin:0; font-size:clamp(24px,4vw,34px); letter-spacing:-0.02em; text-wrap:balance } .lede { color:var(--muted); margin:0; max-width:70ch }
.person { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:18px; display:grid; gap:12px; min-width:0 }
.ph { display:flex; align-items:center; gap:10px } .ph h2 { margin:0; font-size:20px } .dot { width:12px; height:12px; border-radius:50% }
.role { font:500 11px/1 ui-monospace, Consolas, monospace; letter-spacing:0.08em; text-transform:uppercase; color:var(--dim) }
.design { color:var(--dim); font-size:13px }
.lines { margin:0; padding:0; list-style:none; display:grid; gap:4px; color:var(--muted) } .lines li { display:flex; gap:10px }
.n { font:500 12px/1.9 ui-monospace, Consolas, monospace; color:var(--accent); min-width:14px }
.row { display:grid; grid-template-columns:minmax(0,170px) minmax(0,1fr); gap:12px; align-items:center; border-top:1px solid var(--line); padding-top:10px }
.who { display:grid } .who b { font-size:14px } .who span { color:var(--dim); font-size:13px }
.clips { display:flex; flex-wrap:wrap; gap:8px 14px } .clip { display:flex; align-items:center; gap:6px; min-width:0 } audio { height:34px; max-width:100% }
.note { color:var(--muted); font-size:14px; border-left:2px solid var(--line); padding-left:12px; max-width:72ch }
.asr { font-size:12px; color:#f0b45a; line-height:1.4; margin-top:2px } .asr.ok { color:#6fcf8f }
.cast { background:var(--raised); border:1px solid var(--line); border-radius:12px; padding:12px 14px; color:var(--fg); font-size:14px; max-width:72ch }
@media (max-width:640px) { .row { grid-template-columns:minmax(0,1fr) } }
</style></head><body>
<main class="wrap">
<header style="display:grid;gap:10px"><h1>Pick a voice for each person</h1>${args.cast ? `<div class="cast">${esc(String(args.cast))}</div>` : ''}<p class="lede">Sample lines from the zpk.care walkthrough in each candidate voice. Every engine here is free and runs on this PC: Kokoro (Apache-2.0), Chatterbox and Turbo (MIT), Maya1 (Apache-2.0) and Orpheus 3B (Apache-2.0 on its card; it is built on Llama 3.2, so Meta's Llama license also applies). The people are fictional; the voices are AI-generated and designed from plain descriptions, not from anyone's recording.</p></header>
${people}
<p class="note">Pick one voice per person, then run voice-check.mjs with that cast. "Heard" is what a local speech recognizer (Whisper) wrote down: it flags misread terms (NADAC, Poseidon, Merkle, NDC), though it sometimes trips on numbers, so trust your ears.</p>
</main></body></html>`;
  fs.writeFileSync(path.join(OUT, 'audition.html'), html);
  console.log(`page: ${path.join(OUT, 'audition.html')} (${db.rows.length} voices, ${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB)`);
}
