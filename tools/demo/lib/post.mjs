/**
 * Builds the film from the per-page recordings and the camera's cut list: one screen at a time, sped-up waits with a
 * small "sped up" badge, hard cuts inside an act and a short dip to black between acts, every spoken line moved onto
 * the film's timeline, one voice track, chapters per act, captions, a scene list and a player page.
 *
 *   await assemble({ outDir, take, log });   // take.json written by director.mjs (or whiteboard-preview.mjs)
 *
 * take = { T0, T1, shots: { key: { video, videoStartedAt, label } }, cuts: [{ at, key, act, scene }],
 *          speedups: [{ from, to, factor }], scenes: [{ key, act, title, at }], acts: { 1: 'title', ... },
 *          lines: [{ at, ms, name, persona, text, file }] }
 *
 * Output in outDir: walkthrough.mp4, narration.srt, scenes.json, player.html (and pieces/ while it works).
 * Steps (as the tooling spec lists them): segments from consecutive cuts, split at speed-up edges; one encode per
 * segment (-ss into the page's webm, setpts for the speed, fps 30, 1920x1080, drawtext badge); the concat demuxer;
 * voice times remapped segment by segment; mixTrack and srt; a loudnorm AAC mux with chapters and +faststart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ffmpeg, mixTrack, srt, FFPROBE } from './narrate.mjs';

const FPS = 30;
const FADE = 0.35; // seconds of dip to black at an act change

function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-400)}`))));
  });
}

/** Duration of a media file in ms (ffprobe), or null. */
export async function probeMs(file) {
  if (!fs.existsSync(FFPROBE)) return null;
  const out = await capture(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]).catch(() => '');
  const s = parseFloat(String(out).trim());
  return Number.isFinite(s) ? Math.round(s * 1000) : null;
}

function badgeFont() {
  for (const f of ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf']) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}
/** ffmpeg filter-option escaping: the drive colon and backslashes in a quoted value. */
const ffPath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:');

/** Plans the film: pieces of [from, to) wall-clock time, each from one shot at one speed. */
export function planPieces(take, { minSpeedUpMs = 1500 } = {}) {
  const T0 = take.T0;
  const T1 = take.T1;
  if (!(T1 > T0)) throw new Error('post: the take has no length (T1 <= T0)');
  const cuts = (take.cuts || []).filter((c) => c.at < T1).sort((a, b) => a.at - b.at);
  if (!cuts.length) throw new Error('post: the cut list is empty');
  const ups = (take.speedups || []).filter((w) => w.to && w.to - w.from >= minSpeedUpMs && w.factor > 1)
    .map((w) => ({ from: Math.max(T0, w.from), to: Math.min(T1, w.to), factor: w.factor })).filter((w) => w.to > w.from);
  const edges = new Set([T0, T1]);
  for (const c of cuts) if (c.at > T0 && c.at < T1) edges.add(c.at);
  for (const w of ups) { edges.add(w.from); edges.add(w.to); }
  const times = [...edges].sort((a, b) => a - b);
  const keyAt = (t) => {
    let k = cuts[0].key;
    for (const c of cuts) { if (c.at <= t) k = c.key; else break; }
    return k;
  };
  const factorAt = (a, b) => ups.reduce((f, w) => (w.from <= a && w.to >= b ? Math.max(f, w.factor) : f), 1);
  const scenes = (take.scenes || []).slice().sort((a, b) => a.at - b.at);
  const sceneAt = (t) => {
    let s = scenes[0] || null;
    for (const x of scenes) { if (x.at <= t) s = x; else break; }
    return s;
  };
  const raw = [];
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i];
    const b = times[i + 1];
    if (b - a < 1) continue;
    const sc = sceneAt(a);
    raw.push({ key: keyAt(a), from: a, to: b, factor: factorAt(a, b), act: sc ? sc.act : null, scene: sc ? sc.key : null });
  }
  // merge neighbours that show the same page at the same speed in the same act
  const pieces = [];
  for (const p of raw) {
    const last = pieces[pieces.length - 1];
    if (last && last.key === p.key && last.factor === p.factor && last.act === p.act && last.to === p.from) last.to = p.to;
    else pieces.push({ ...p });
  }
  // a piece shorter than one film frame is folded into its neighbour
  const out = [];
  for (const p of pieces) {
    const outMs = (p.to - p.from) / p.factor;
    if (outMs < 1000 / FPS && out.length) out[out.length - 1].to = p.to;
    else out.push(p);
  }
  return out;
}

/** Maps a wall-clock moment onto the film's timeline (ms from the film's start). */
export function makeTimeMap(pieces) {
  return (t) => {
    for (const p of pieces) {
      if (t < p.from) return p.outStart;
      if (t < p.to) return p.outStart + ((t - p.from) / p.factor) * (p.outMs / p.plannedMs);
    }
    const last = pieces[pieces.length - 1];
    return last ? last.outStart + last.outMs : 0;
  };
}

export async function assemble({ outDir, take, log = () => {}, crf = 18, preset = 'medium', keepPieces = false, filmName = 'walkthrough.mp4', title = 'zpk.care walkthrough' }) {
  fs.mkdirSync(outDir, { recursive: true });
  const pieceDir = path.join(outDir, 'pieces');
  fs.rmSync(pieceDir, { recursive: true, force: true });
  fs.mkdirSync(pieceDir, { recursive: true });
  const pieces = planPieces(take);
  const font = badgeFont();
  log(`post: ${pieces.length} pieces from ${(take.cuts || []).length} cuts and ${(take.speedups || []).length} speed-ups`);

  // ---------------------------------------------------------------- one encode per piece
  let outStart = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const shot = take.shots[p.key];
    if (!shot || !shot.video || !fs.existsSync(shot.video)) throw new Error(`post: no recording for shot "${p.key}"`);
    const inSec = Math.max(0, (p.from - shot.videoStartedAt) / 1000);
    const inDur = (p.to - p.from) / 1000;
    const plannedMs = (p.to - p.from) / p.factor;
    const frames = Math.max(1, Math.round((plannedMs / 1000) * FPS));
    const outSec = frames / FPS;
    const vf = [`setpts=(PTS-STARTPTS)/${p.factor}`, `fps=${FPS}`, 'scale=1920:1080:flags=lanczos', 'setsar=1'];
    if (p.factor > 1) {
      const txt = `sped up ${Number.isInteger(p.factor) ? p.factor : p.factor.toFixed(1)}x`;
      vf.push(`drawtext=${font ? `fontfile='${ffPath(font)}':` : ''}text='${txt}':x=w-tw-44:y=40:fontsize=30:fontcolor=white@0.95:box=1:boxcolor=0x0c0c0e@0.62:boxborderw=12`);
    }
    const prev = pieces[i - 1];
    const next = pieces[i + 1];
    if (prev && prev.act !== p.act) vf.push(`fade=t=in:st=0:d=${FADE}`);
    if (next && next.act !== p.act && outSec > FADE * 2) vf.push(`fade=t=out:st=${(outSec - FADE).toFixed(3)}:d=${FADE}`);
    const file = path.join(pieceDir, `piece-${String(i + 1).padStart(4, '0')}.mp4`);
    await ffmpeg(['-ss', inSec.toFixed(3), '-i', shot.video, '-t', (inDur + 1).toFixed(3), '-vf', vf.join(','), '-an', '-r', String(FPS), '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', file]);
    const actual = (await probeMs(file)) ?? Math.round(outSec * 1000);
    Object.assign(p, { file, plannedMs, outMs: actual, outStart });
    outStart += actual;
    log(`post: piece ${i + 1}/${pieces.length} ${p.key}${p.factor > 1 ? ` x${p.factor}` : ''} ${(actual / 1000).toFixed(1)} s`);
  }
  const totalMs = outStart;

  // ---------------------------------------------------------------- one picture track
  const list = path.join(pieceDir, 'list.txt');
  fs.writeFileSync(list, pieces.map((p) => `file '${p.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const video = path.join(pieceDir, 'video.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);

  // ---------------------------------------------------------------- the voices, moved onto the film's timeline
  const map = makeTimeMap(pieces);
  const lines = (take.lines || []).map((l) => {
    const piece = pieces.find((p) => l.at >= p.from && l.at < p.to);
    if (piece && piece.factor > 1) log(`post: warning: "${String(l.text).slice(0, 40)}" starts inside a sped-up piece`);
    return { ...l, wallAt: l.at, at: Math.round(map(l.at)) };
  });
  const voices = path.join(pieceDir, 'voices.wav');
  mixTrack(lines, { startAt: 0, ms: totalMs, out: voices });
  fs.writeFileSync(path.join(outDir, 'narration.srt'), srt(lines, 0));

  // ---------------------------------------------------------------- scenes, chapters
  const scenes = (take.scenes || []).slice().sort((a, b) => a.at - b.at).map((s, i, all) => ({
    key: s.key, act: s.act, title: s.title, start: Math.round(map(Math.max(take.T0, s.at))),
    end: Math.round(i + 1 < all.length ? map(Math.max(take.T0, all[i + 1].at)) : totalMs)
  })).filter((s) => s.end > s.start || s.start < totalMs);
  const acts = [];
  for (const s of scenes) {
    const last = acts[acts.length - 1];
    if (!last || last.act !== s.act) acts.push({ act: s.act, title: (take.acts && take.acts[s.act]) || `Act ${s.act}`, start: s.start, end: s.end });
    else last.end = s.end;
  }
  const esc = (s) => String(s).replace(/([=;#\\\n])/g, '\\$1');
  const meta = [';FFMETADATA1', `title=${esc(title)}`, ...acts.flatMap((a) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${a.start}`, `END=${Math.max(a.start + 1, a.end)}`, `title=${esc(a.title)}`])].join('\n') + '\n';
  const metaFile = path.join(pieceDir, 'chapters.txt');
  fs.writeFileSync(metaFile, meta);

  // ---------------------------------------------------------------- the film
  const film = path.join(outDir, filmName);
  const spoken = lines.some((l) => l.file);
  await ffmpeg(['-i', video, '-i', voices, '-i', metaFile, '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2', '-c:v', 'copy',
    ...(spoken ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', (totalMs / 1000).toFixed(3), '-movflags', '+faststart', film]);

  const summary = {
    film: filmName,
    durationMs: totalMs,
    startedAt: new Date(take.T0).toISOString(),
    acts,
    scenes,
    pieces: pieces.map((p) => ({ key: p.key, label: take.shots[p.key]?.label || p.key, act: p.act, scene: p.scene, factor: p.factor, start: p.outStart, ms: p.outMs })),
    lines: lines.map((l) => ({ at: l.at, ms: l.ms, name: l.name, persona: l.persona, text: l.text }))
  };
  fs.writeFileSync(path.join(outDir, 'scenes.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'player.html'), playerHtml(summary, title));
  if (!keepPieces) fs.rmSync(pieceDir, { recursive: true, force: true });
  log(`post: ${film} (${(totalMs / 1000).toFixed(1)} s)`);
  return { film, durationMs: totalMs, summary };
}

/** The listening page (adapted from demo-bid.mjs): the film, and a scene list that follows it and seeks on click. */
export function playerHtml(summary, title) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = summary.scenes.map((s) => ({ t: s.start / 1000, act: s.act, title: s.title, key: s.key }));
  const lines = summary.lines.map((l) => ({ t: l.at / 1000, who: l.name, text: l.text }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#0b0b0d;--fg:#ececf1;--mut:#9a9aa6;--line:#26262c;--acc:#9b9bff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1400px;margin:0 auto;padding:16px}h1{font-size:18px;margin:0 0 12px}video{width:100%;border-radius:8px;border:1px solid var(--line);background:#000}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:16px;margin-top:12px}@media(max-width:900px){.cols{grid-template-columns:minmax(0,1fr)}}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600}
tr{cursor:pointer}tr.future td{color:#5e5e68}tr.now td{background:rgba(155,155,255,.12)}.mono{font-family:ui-monospace,Consolas,monospace}</style></head><body><main>
<h1>${esc(title)}</h1>
<video id="v" src="${esc(summary.film)}" controls preload="auto"></video>
<div class="cols"><table><thead><tr><th>Time</th><th>Act</th><th>Scene</th></tr></thead><tbody id="scenes"></tbody></table>
<table><thead><tr><th>Time</th><th>Who</th><th>Line</th></tr></thead><tbody id="lines"></tbody></table></div>
<script>const SCENES=${JSON.stringify(rows)};const LINES=${JSON.stringify(lines)};
const v=document.getElementById('v');const fmt=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
function fill(id,list,cols){const tb=document.getElementById(id);list.forEach(r=>{const tr=document.createElement('tr');tr.className='future';cols(r).forEach((c,j)=>{const td=document.createElement('td');td.textContent=c;if(j===0)td.className='mono';tr.appendChild(td)});tr.addEventListener('click',()=>{v.currentTime=r.t;v.play()});tb.appendChild(tr)});return tb}
const a=fill('scenes',SCENES,r=>[fmt(r.t),String(r.act==null?'':r.act),r.title]);const b=fill('lines',LINES,r=>[fmt(r.t),r.who,r.text]);
function mark(tb,list){let last=-1;list.forEach((r,i)=>{if(r.t<=v.currentTime)last=i});[...tb.children].forEach((tr,i)=>{tr.className=i<last?'':i===last?'now':'future'})}
const tick=()=>{mark(a,SCENES);mark(b,LINES)};v.addEventListener('timeupdate',tick);v.addEventListener('seeked',tick);tick();</script></main></body></html>`;
}
