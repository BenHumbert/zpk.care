/**
 * The voices of the zpk.care walkthrough. Each person (and the narrator) has an engine voice and a way of talking.
 * say() shows the line as a caption on whatever page is on camera and holds the next action until the line has been
 * spoken. One person speaks at a time across every page (the talking stick), so no two lines ever overlap and the
 * film needs one voice track, no ducking. mixTrack() lays every spoken line on that one track.
 *
 * Adapted from SwapStreet's site-e2e/lib/narrate.mjs. Changes for zpk.care:
 *  - TOOLS comes from ZPK_DEMO_TOOLS (else SWAPSTREET_TOOLS, else Z:/ByteStreetCustomBeta/.tools); the SwapStreet
 *    folder is only read
 *  - toSpeech() knows the zpk words (wallet I D, N D C, NADAC, Poseidon, zk, OOP, PCP, Merkle, o1js, Ed25519...)
 *  - MAYA_VOICES holds the zpk cast, designed from plain descriptions
 *  - say(..., { during }) runs board strokes while the line plays; the turn ends when both are done
 *  - cacheOnly: a take never synthesises (the CPU and GPU belong to the proofs); a missing clip is an error
 *  - silent: rehearsals show captions for an estimated time (about 2.6 words a second) and make no audio
 *  - Piper clips are resampled to the engines' 24 kHz, so every voice mixes into one track
 *  - word times written by py/check_asr.py next to a cached clip (<clip>.words.json) are handed to during()
 *
 * Engines (one long-lived Python worker each, under TOOLS/tts):
 *  - "kokoro:<voice>"      Kokoro-82M (Apache-2.0), CPU, fast; mood sets the speed
 *  - "chatterbox:<ref>"    Chatterbox (MIT), CPU, slow; reads in the voice of a reference clip
 *  - "turbo:<ref>"         Chatterbox Turbo (MIT), CPU; performs [laugh]-style cues
 *  - "maya:<persona>"      Maya1 (Apache-2.0), GPU through llama.cpp Vulkan; voice designed from MAYA_VOICES
 *  - "orpheus:<voice>"     Orpheus 3B (Apache-2.0, built on Llama 3.2), GPU; one of ORPHEUS_VOICES
 *  - a Piper voice name    (VOICES), offline, public-domain or CC0 training data
 * A line may carry cues in braces ("{chuckle}"): engines that perform cues get them in their own syntax, the others
 * drop them, and captions never show them.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_ROOT = path.resolve(HERE, '..');
export const OUT_ROOT = path.resolve(process.env.ZPK_DEMO_OUT || path.join(DEMO_ROOT, 'demo-out'));
export const TOOLS = path.resolve(process.env.ZPK_DEMO_TOOLS || process.env.SWAPSTREET_TOOLS || 'Z:/ByteStreetCustomBeta/.tools');
export const PIPER = path.join(TOOLS, 'piper', 'piper', 'piper.exe');
export const VOICES_DIR = path.join(TOOLS, 'piper', 'voices');
export const FFMPEG = path.join(TOOLS, 'ffmpeg', 'bin', 'ffmpeg.exe');
export const FFPROBE = path.join(TOOLS, 'ffmpeg', 'bin', 'ffprobe.exe');
/** Where checked clips live; the take reuses them byte for byte. */
export const VOICE_CACHE = path.join(OUT_ROOT, 'voice-cache');

/** The Piper voices a posted video may use, with the license of the data each was trained on. */
export const VOICES = Object.freeze({
  'en_US-ljspeech-high': 'public domain (LJ Speech)',
  'en_US-kristin-medium': 'public domain (LibriVox)',
  'en_GB-cori-high': 'public domain (LibriVox)',
  'en_US-john-medium': 'public domain (LibriVox)',
  'en_US-norman-medium': 'public domain (LibriVox)',
  'en_US-bryce-medium': 'public domain',
  'en_US-joe-medium': 'CC0'
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const upTo99 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''));
const under1000 = (n) => (n < 100 ? upTo99(n) : `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ' ' + upTo99(n % 100) : ''}`);

/** A whole number in words: 2,450,000 -> "two million four hundred fifty thousand". */
export function sayNumber(n) {
  let v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 0) return String(n);
  if (v === 0) return 'zero';
  const parts = [];
  for (const [size, word] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (v >= size) {
      parts.push(`${under1000(Math.floor(v / size))} ${word}`);
      v %= size;
    }
  }
  if (v) parts.push(under1000(v));
  return parts.join(' ');
}

/** A price the way people say it: 1500 -> "fifteen hundred", 1350 -> "thirteen fifty", 2000 -> "two thousand". */
export function sayAmount(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 0) return String(n);
  if (v < 100) return upTo99(v);
  if (v % 1000 === 0 && v < 100000) return `${upTo99(v / 1000)} thousand`;
  if (v < 10000 && v % 100 === 0) return `${upTo99(v / 100)} hundred`;
  if (v >= 1000 && v < 10000) {
    const hi = Math.floor(v / 100);
    const lo = v % 100;
    return `${upTo99(hi)} ${lo < 10 ? 'oh ' + ONES[lo] : upTo99(lo)}`;
  }
  if (v < 1000) return under1000(v);
  return sayNumber(v);
}

/** "$12.40" -> "twelve dollars and forty cents"; "$0.04" -> "four cents"; "$1.00" -> "one dollar". */
export function sayDollars(whole, cents) {
  const d = Number(String(whole).replace(/,/g, ''));
  const c = cents === undefined ? 0 : Number(String(cents).padEnd(2, '0').slice(0, 2));
  const dw = d === 1 ? 'one dollar' : `${sayNumber(d)} dollars`;
  if (!c) return dw;
  const cw = c === 1 ? 'one cent' : `${upTo99(c)} cents`;
  return d ? `${dw} and ${cw}` : cw;
}

const digitsOf = (s) => String(s).split('').map((d) => ONES[Number(d)]).join(' ');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth',
  'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth',
  'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];

/**
 * Spoken forms of the words a TTS engine reads badly; the caption keeps the written form. Order matters: codes
 * (NDC, EIN) and CCYYMMDD dates first, money before the decimal rule, terms before the bare-number rule.
 */
export function toSpeech(text) {
  return String(text)
    // an NDC (00378-0137-01) and an EIN (00-4417321) are read digit by digit
    .replace(/\b(\d{4,5})-(\d{3,4})-(\d{1,2})\b/g, (m, a, b, c) => [a, b, c].map(digitsOf).join(', '))
    .replace(/\b(\d{2})-(\d{7})\b/g, (m, a, b) => `${digitsOf(a)}, ${digitsOf(b)}`)
    // a CCYYMMDD date: 20260201 -> February first, twenty twenty-six
    .replace(/\b(19|20)(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/g, (m, cc, yy, mm, dd) => `${MONTHS[Number(mm) - 1]} ${ORDINAL[Number(dd)]}, ${sayAmount(Number(cc + yy))}`)
    // product and crypto terms
    .replace(/\bzpk\.care\b/gi, 'Z P K dot care')
    .replace(/\bo1js\b/gi, 'oh one J S')
    .replace(/\bEd25519\b/gi, 'E D twenty-five five nineteen')
    .replace(/\bX25519\b/gi, 'X twenty-five five nineteen')
    .replace(/\bSHA-?256\b/gi, 'shah two fifty-six')
    .replace(/\bHKDF\b/g, 'H K D F')
    .replace(/\bscrypt\b/gi, 'ess crypt')
    .replace(/\bzk-?SNARKs?\b/gi, (m) => (/s$/i.test(m) ? 'zee kay snarks' : 'zee kay snark'))
    .replace(/\bZK\b|\bzk\b/g, 'zee kay')
    .replace(/\bPoseidon\b/g, 'Po-sigh-don')
    .replace(/\bMerkle\b/g, 'Merkel')
    .replace(/\bNADAC\b/g, 'nay dack')
    .replace(/\bNDCs\b/g, 'N D Cs')
    .replace(/\bNDC\b/g, 'N D C')
    .replace(/\bNPI\b/g, 'N P I')
    .replace(/\bEIN\b/g, 'E I N')
    .replace(/\bCP ?575\b/g, 'C P five seventy-five')
    .replace(/\bPCP\b/g, 'P C P')
    .replace(/\bOOP\b/g, 'out-of-pocket')
    .replace(/\bPIN\b/g, 'pin')
    .replace(/\bPINs\b/g, 'pins')
    .replace(/\bHR\b/g, 'H R')
    .replace(/\bNFC\b/g, 'N F C')
    .replace(/\bRx\b|\bRX\b/g, 'R X')
    .replace(/\beScripts?\b|\be-scripts?\b/gi, (m) => (/s$/i.test(m) ? 'e-scripts' : 'e-script'))
    .replace(/\bwallet ID(s?)\b/gi, (m, s) => `wallet I D${s ? 's' : ''}`)
    .replace(/\bIDs\b/g, 'I Ds')
    .replace(/\bID\b/g, 'I D')
    .replace(/\bL2\b/g, 'layer two')
    .replace(/\bRPC\b/g, 'R P C')
    .replace(/\bCSV\b/g, 'C S V')
    .replace(/\bPDF\b/g, 'P D F')
    .replace(/\bJSON\b/g, 'jason')
    .replace(/\bA-(\d+)\b/g, (m, n) => `A ${sayNumber(Number(n))}`)
    // money: $12.40 -> twelve dollars and forty cents (before the decimal rule)
    .replace(/\$(\d{1,3}(?:,\d{3})+|\d+)\.(\d{1,2})\b/g, (m, a, b) => sayDollars(a, b))
    .replace(/\$(\d{1,3}(?:,\d{3})+|\d+)\b/g, (m, n) => sayDollars(n))
    // decimals: 0.1 -> point one, 9.5 -> nine point five
    .replace(/\b(\d+)\.(\d+)\b/g, (m, a, b) => `${a === '0' ? '' : sayAmount(Number(a)) + ' '}point ${b.split('').map((d) => ONES[Number(d)]).join(' ')}`)
    // 2^23 -> two to the twenty-three
    .replace(/\b(\d+)\^(\d+)\b/g, (m, a, b) => `${sayNumber(Number(a))} to the ${sayNumber(Number(b))}`)
    // numbers (the caption keeps the digits): a grouped count in full (1,024 -> one thousand twenty-four), a plain
    // number the way people say a price or a year (1418 -> fourteen eighteen, 2026 -> twenty twenty-six)
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => sayNumber(Number(m.replace(/,/g, ''))))
    .replace(/\b\d+\b/g, (m) => sayAmount(Number(m)))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Duration and layout of a PCM WAV file, from its header. */
export function wavInfo(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV file`);
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt) throw new Error(`${file}: data before fmt`);
      const frames = size / (fmt.channels * (fmt.bits / 8));
      return { ...fmt, dataOffset: off + 8, dataSize: size, ms: Math.round((frames / fmt.rate) * 1000) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-600)}`))));
    if (input !== undefined) p.stdin.end(input);
  });
}

// ---------------------------------------------------------------- engine voices
const TTS = path.join(TOOLS, 'tts');
const ENGINES = Object.freeze({
  kokoro: { py: path.join(TTS, 'venv-kokoro', 'Scripts', 'python.exe'), script: path.join(TTS, 'worker_kokoro.py') },
  chatterbox: { py: path.join(TTS, 'venv', 'Scripts', 'python.exe'), script: path.join(TTS, 'worker_chatterbox.py') },
  turbo: { py: path.join(TTS, 'venv', 'Scripts', 'python.exe'), script: path.join(TTS, 'worker_turbo.py') },
  maya: { py: path.join(TTS, 'maya', 'venv', 'Scripts', 'python.exe'), script: path.join(TTS, 'worker_maya.py') },
  orpheus: { py: path.join(TTS, 'maya', 'venv', 'Scripts', 'python.exe'), script: path.join(TTS, 'worker_orpheus.py') }
});

/** Orpheus 3B's own voices. */
export const ORPHEUS_VOICES = Object.freeze(['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe']);

/**
 * Maya1 voices for the zpk cast, designed from a plain description (the model's own words, nobody's recording).
 * They are plain descriptions on purpose: no real person is named or imitated.
 */
export const MAYA_VOICES = Object.freeze({
  narrator: 'Male, late 30s, American, a nerdy systems engineer, precise and articulate, warm and curious, dry understated delivery, measured explanatory pacing',
  hr: 'Female, mid 40s, American Midwest, meticulous HR administrator, organized and friendly, crisp diction, brisk office pacing, matter-of-fact',
  analyst: 'Male, early 30s, American, dry and exact insurance analyst, quiet, even pacing, slightly formal, understated',
  member: 'Female, early 30s, American, friendly and polite, a little anxious about cost, slightly hesitant, natural conversational pacing',
  prescriber: 'Female, mid 50s, American, busy but kind family physician, calm clinical authority, short clipped sentences',
  pharmacist: 'Male, early 50s, American, seen-it-all independent pharmacist, efficient and unhurried, wry, steady pacing'
});

/** Inline cues a line may carry ("{chuckle}"): performed by turbo, maya and orpheus, dropped elsewhere, never captioned. */
const CUE = /\s*\{(laugh|chuckle|sigh|gasp|giggle|cough|excited|sarcastic|whisper|curious|exhale)\}\s*/g;
export const stripCues = (s) => String(s).replace(CUE, ' ').replace(/\s{2,}/g, ' ').trim();
function withCues(engine, text) {
  if (engine === 'turbo') return String(text).replace(/\{(\w+)\}/g, '[$1]');
  if (engine === 'maya' || engine === 'orpheus') return String(text).replace(/\{(\w+)\}/g, '<$1>');
  return stripCues(text);
}
/** Reference clips for chatterbox/turbo: new ones are made in demo-out/voice-refs; the SwapStreet ones are only read. */
export const REFS_DIR = path.join(OUT_ROOT, 'voice-refs');
export const SHARED_REFS_DIR = path.join(TTS, 'refs');
export function refPath(name) {
  for (const dir of [REFS_DIR, SHARED_REFS_DIR]) {
    const p = path.join(dir, `${name}.wav`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
export const ENGINE_RATE = 24000;

/** How each mood is delivered: Chatterbox's emotion (exaggeration) and pacing (cfg), Kokoro's speed, Turbo's temperature. */
export const MOODS = Object.freeze({
  calm: { exaggeration: 0.35, cfg: 0.5, speed: 0.97, temperature: 0.6 },
  precise: { exaggeration: 0.3, cfg: 0.55, speed: 0.95, temperature: 0.55 },
  warm: { exaggeration: 0.45, cfg: 0.5, speed: 1.0, temperature: 0.7 },
  curious: { exaggeration: 0.5, cfg: 0.45, speed: 1.0, temperature: 0.75 },
  dry: { exaggeration: 0.3, cfg: 0.5, speed: 0.98, temperature: 0.6 },
  brisk: { exaggeration: 0.4, cfg: 0.45, speed: 1.05, temperature: 0.7 },
  anxious: { exaggeration: 0.55, cfg: 0.45, speed: 1.02, temperature: 0.75 },
  relieved: { exaggeration: 0.5, cfg: 0.5, speed: 0.98, temperature: 0.7 },
  kind: { exaggeration: 0.45, cfg: 0.5, speed: 1.0, temperature: 0.7 },
  wry: { exaggeration: 0.45, cfg: 0.5, speed: 0.98, temperature: 0.7 }
});

/** One long-lived worker per engine: JSON request per line on stdin, one JSON answer per line on stdout. */
class EngineWorker {
  constructor(name) {
    const e = ENGINES[name];
    if (!fs.existsSync(e.py) || !fs.existsSync(e.script)) throw new Error(`${name} is not installed under ${TTS}`);
    this.name = name;
    this.waiting = [];
    // HF_HUB_OFFLINE: worker_turbo.py calls snapshot_download at start; nothing may reach the network
    this.p = spawn(e.py, [e.script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: TTS,
      env: { ...process.env, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' }
    });
    this.err = '';
    this.p.stderr.on('data', (d) => { this.err = (this.err + d).slice(-2000); });
    let buf = '';
    let readyResolve;
    let readyReject;
    this.ready = new Promise((a, b) => { readyResolve = a; readyReject = b; });
    this.p.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        const msg = JSON.parse(line);
        if (msg.ready) readyResolve();
        else this.waiting.shift()?.resolve(msg);
      }
    });
    this.p.on('exit', (code) => {
      const e2 = new Error(`${name} worker exited ${code}: ${this.err.slice(-400)}`);
      readyReject(e2);
      for (const w of this.waiting.splice(0)) w.reject(e2);
    });
  }

  async request(obj) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.p.stdin.write(JSON.stringify(obj) + '\n');
    });
  }

  stop() {
    try { this.p.kill(); } catch {}
  }
}
const workers = new Map();
const worker = (name) => workers.get(name) || workers.set(name, new EngineWorker(name)).get(name);
/** Stops the engine workers (they also stop when this process exits). Call before T0 so proofs get the CPU. */
export function stopEngines() {
  for (const w of workers.values()) w.stop();
  workers.clear();
}
export const enginesRunning = () => workers.size;
process.on('exit', stopEngines);

/** "kokoro:af_heart" -> { engine, name }; null for a Piper voice. */
export function engineVoice(v) {
  const m = /^(kokoro|chatterbox|turbo|maya|orpheus):([A-Za-z0-9_-]+)$/.exec(String(v));
  return m ? { engine: m[1], name: m[2] } : null;
}

/** True when lib/narrate.mjs can speak with this voice name. */
export function knownVoice(v) {
  const ev = engineVoice(v);
  if (!ev) return !!VOICES[v];
  if (ev.engine === 'maya') return !!MAYA_VOICES[ev.name];
  if (ev.engine === 'orpheus') return ORPHEUS_VOICES.includes(ev.name);
  return true;
}

function engineParams(ev, mood) {
  const m = MOODS[mood] || MOODS.warm;
  if (ev.engine === 'kokoro') return { voice: ev.name, speed: m.speed };
  if (ev.engine === 'maya') {
    if (!MAYA_VOICES[ev.name]) throw new Error(`no Maya1 voice ${ev.name} (${Object.keys(MAYA_VOICES).join(', ')})`);
    return { description: MAYA_VOICES[ev.name], seed: 7 };
  }
  if (ev.engine === 'orpheus') {
    if (!ORPHEUS_VOICES.includes(ev.name)) throw new Error(`no Orpheus voice ${ev.name} (${ORPHEUS_VOICES.join(', ')})`);
    return { voice: ev.name, seed: 7 };
  }
  if (ev.engine === 'turbo') {
    const ref = refPath(ev.name);
    if (!ref) throw new Error(`reference voice missing: ${ev.name}.wav in ${REFS_DIR} or ${SHARED_REFS_DIR}`);
    return { ref, temperature: m.temperature, seed: 7 };
  }
  const ref = ev.name === 'default' ? null : refPath(ev.name);
  if (ev.name !== 'default' && !ref) throw new Error(`reference voice missing: ${ev.name}.wav in ${REFS_DIR} or ${SHARED_REFS_DIR}`);
  return { ref, exaggeration: m.exaggeration, cfg_weight: m.cfg, seed: 7 };
}

/** The cache key leaves out the reference clip's folder, so a clip made from either refs folder is found again. */
function cacheKey(ev, params, spoken) {
  const p = { ...params };
  if (p.ref) p.ref = path.basename(p.ref);
  return crypto.createHash('sha1').update(`zpk1|${ev.engine}|${JSON.stringify(p)}|${spoken}`).digest('hex').slice(0, 16);
}

const NORMALISE = (trimFirst) => {
  const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06';
  return `${trimFirst ? `${trim},areverse,${trim},areverse,` : ''}loudnorm=I=-18:TP=-2:LRA=11`;
};

async function normaliseTo24k(raw, file) {
  const tmp = `${file}.part.wav`;
  await run(FFMPEG, ['-y', '-v', 'error', '-i', raw, '-af', NORMALISE(true), '-ac', '1', '-ar', String(ENGINE_RATE), '-c:a', 'pcm_s16le', tmp]);
  fs.rmSync(raw, { force: true });
  fs.renameSync(tmp, file);
}

/** Where a line's clip would be cached, without making it. */
export function clipPath(text, { voice, mood = 'warm', lengthScale = 1, sentenceSilence = 0.25, cacheDir = VOICE_CACHE }) {
  const ev = engineVoice(voice);
  if (ev) {
    const spoken = withCues(ev.engine, toSpeech(text));
    const params = engineParams(ev, mood);
    return { file: path.join(cacheDir, `${ev.engine}-${ev.name}-${cacheKey(ev, params, spoken)}.wav`), spoken, ev, params };
  }
  if (!VOICES[voice]) throw new Error(`voice ${voice} is not on the list cleared for posted videos`);
  const spoken = stripCues(toSpeech(text));
  const key = crypto.createHash('sha1').update(`zpk1|${voice}|${lengthScale}|${sentenceSilence}|${spoken}`).digest('hex').slice(0, 16);
  return { file: path.join(cacheDir, `${voice}-${key}.wav`), spoken, ev: null, params: { lengthScale, sentenceSilence } };
}

/** Word times saved by py/check_asr.py next to a clip: [{ word, startMs, endMs }], or []. */
export function wordTimes(file) {
  try {
    const j = JSON.parse(fs.readFileSync(`${file}.words.json`, 'utf8'));
    return Array.isArray(j) ? j : (j.words || []);
  } catch {
    return [];
  }
}

/**
 * Speaks `text` with a voice to a cached WAV; resolves { file, ms, words }. { cacheOnly: true } refuses to
 * synthesise: during a take every clip must already exist (rendered and checked before T0).
 */
export async function synth(text, { voice, mood = 'warm', lengthScale = 1, sentenceSilence = 0.25, cacheDir = VOICE_CACHE, cacheOnly = false }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const c = clipPath(text, { voice, mood, lengthScale, sentenceSilence, cacheDir });
  if (!fs.existsSync(c.file)) {
    if (cacheOnly) throw new Error(`not pre-rendered (cacheOnly): ${voice} "${stripCues(text).slice(0, 60)}"`);
    if (c.ev) {
      const raw = `${c.file}.raw.wav`;
      const r = await worker(c.ev.engine).request({ text: c.spoken, out: raw, ...c.params });
      if (!r.ok) throw new Error(`${c.ev.engine}: ${r.error}`);
      await normaliseTo24k(raw, c.file);
    } else {
      const model = path.join(VOICES_DIR, `${voice}.onnx`);
      if (!fs.existsSync(PIPER)) throw new Error(`Piper is not installed at ${PIPER}`);
      if (!fs.existsSync(model)) throw new Error(`voice model missing: ${model}`);
      const raw = `${c.file}.raw.wav`;
      await run(PIPER, ['--model', model, '--output_file', raw, '--length_scale', String(lengthScale), '--sentence_silence', String(sentenceSilence)], { input: c.spoken });
      // Piper writes 22,050 Hz; every clip on the track must share the engines' 24 kHz
      await normaliseTo24k(raw, c.file);
    }
  }
  return { file: c.file, ms: wavInfo(c.file).ms, words: wordTimes(c.file) };
}

/** A rehearsal's stand-in for a clip: about 2.6 words a second, never shorter than 0.9 s. */
export function estimateMs(text) {
  const words = stripCues(text).split(/\s+/).filter(Boolean).length;
  return Math.max(900, Math.round((words / 2.6) * 1000));
}

/**
 * The narration of one take. persona: { key, name, role, voice, color, mood }.
 * say(page, persona, line, { during }) waits for the talking stick, shows the caption, records the line with its
 * moment, runs during({ at, ms, file, words }) beside the clip, and resolves once both the clip and during() are
 * done (plus a short breath). Lines are synthesised (or looked up) before the stick is taken, so a turn starts
 * without a gap. `page` may be a function: it is called when the turn starts, so the caption lands on whatever page
 * the camera shows at that moment.
 */
export class Narrator {
  constructor({ cacheDir = VOICE_CACHE, log = () => {}, breathMs = 350, cacheOnly = false, silent = false, onTurnStart = null } = {}) {
    this.cacheDir = cacheDir;
    this.log = log;
    this.breathMs = breathMs;
    this.cacheOnly = cacheOnly;
    this.silent = silent;
    this.onTurnStart = onTurnStart;
    this.lines = [];
    this.stick = Promise.resolve();
    this.busy = false;
  }

  /** estMs: a rehearsal's stand-in length for this line (the script may give one for long board explanations). */
  async clipFor(persona, text, mood, estMs) {
    if (this.silent) return { file: null, ms: Number(estMs) || estimateMs(text), words: [] };
    return synth(text, { voice: persona.voice, mood, lengthScale: persona.lengthScale ?? 1, cacheDir: this.cacheDir, cacheOnly: this.cacheOnly });
  }

  async say(page, persona, line, { wait = true, mood, during } = {}) {
    const text = typeof line === 'string' ? line : line.text;
    const feel = mood || (typeof line === 'string' ? undefined : line.mood) || persona.mood || 'warm';
    const clip = await this.clipFor(persona, text, feel, typeof line === 'string' ? undefined : line.estMs);
    const turn = this.stick.then(async () => {
      this.busy = true;
      const at = Date.now();
      if (this.onTurnStart) {
        try { this.onTurnStart(at); } catch {}
      }
      const caption = stripCues(text);
      const pg = typeof page === 'function' ? page() : page;
      this.lines.push({ at, persona: persona.key, name: persona.name, voice: persona.voice, mood: feel, text: caption, file: clip.file, ms: clip.ms, page: pg?.__shotKey || null });
      this.log(`${persona.name}: "${caption}"`);
      if (pg) await pg.evaluate(([who, t, color]) => window.__demoSay && window.__demoSay(who, t, color), [persona.name, caption, persona.color || '#9b9bff']).catch(() => {});
      const both = [sleep(clip.ms + this.breathMs)];
      if (during) both.push(Promise.resolve().then(() => during({ at, ms: clip.ms, file: clip.file, words: clip.words || [] })).catch((e) => this.log(`during() failed: ${e.message}`)));
      await Promise.all(both);
      if (pg) await pg.evaluate(() => window.__demoSay && window.__demoSay(null)).catch(() => {});
      this.busy = false;
    });
    this.stick = turn.catch(() => { this.busy = false; });
    if (wait) await turn;
    return turn;
  }

  /** Waits until everyone has finished talking. */
  async quiet() {
    await this.stick;
  }
}

/**
 * One mono 16-bit WAV of `ms` length with each line placed at (line.at - startAt), summed and clipped. Lines without
 * a clip (rehearsal) are skipped; every clip must share one sample rate. Returns the file.
 */
export function mixTrack(lines, { startAt, ms, out, rate: forceRate }) {
  const clips = lines.filter((l) => l.file).map((l) => ({ ...l, info: wavInfo(l.file) }));
  const rate = forceRate || clips[0]?.info.rate || ENGINE_RATE;
  for (const c of clips) {
    if (c.info.rate !== rate || c.info.channels !== 1 || c.info.bits !== 16) throw new Error(`${c.file}: not 16-bit mono at ${rate} Hz`);
  }
  const total = Math.max(1, Math.ceil((ms / 1000) * rate));
  const acc = new Int32Array(total);
  for (const c of clips) {
    const buf = fs.readFileSync(c.file);
    const start = Math.round(((c.at - startAt) / 1000) * rate);
    const n = c.info.dataSize / 2;
    for (let i = 0; i < n; i++) {
      const j = start + i;
      if (j < 0) continue;
      if (j >= total) break;
      acc[j] += buf.readInt16LE(c.info.dataOffset + i * 2);
    }
  }
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, acc[i])), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([head, data]));
  return out;
}

/** Runs the full ffmpeg (not Playwright's reduced one). */
export function ffmpeg(args) {
  if (!fs.existsSync(FFMPEG)) throw new Error(`ffmpeg is not installed at ${FFMPEG}`);
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** SubRip captions of the spoken lines, timed from startAt. */
export function srt(lines, startAt) {
  const ts = (ms) => {
    const v = Math.max(0, Math.round(ms));
    const h = Math.floor(v / 3600000);
    const m = Math.floor((v % 3600000) / 60000);
    const s = Math.floor((v % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(v % 1000).padStart(3, '0')}`;
  };
  return lines.map((l, i) => `${i + 1}\n${ts(l.at - startAt)} --> ${ts(l.at - startAt + l.ms)}\n${l.name}: ${l.text}\n`).join('\n');
}
