/**
 * The director's status card: a page for background steps that no product screen shows (the phone's 20-second
 * update loop, the registration behind the Enroll call, the batch countdown). It is honest about what it is: the
 * header and footer say that the video's director drew it from the network's own answers. Every value on it comes
 * from a read-only answer (lib/reads.mjs) or from an answer a product page received and the director only read (its
 * allowlisted fields, never a request body), and names the call it came from. It is offline (the board.mjs pattern):
 * its context aborts every request and the director feeds it with page.evaluate.
 *
 *   const card = await openStatusCard({ browser, recordVideoDir });          // or { context } to share one
 *   await card.update('setTitle', { title: 'Registration, behind the screen', subtitle: 'Avery’s phone and the sequencer' });
 *   await card.update('upsertRow', { id: 'receipt', label: 'Registration proof', value: 'accepted · receipt 4f1c…', tone: 'ok',
 *                                    source: 'l2_getReceiptsByWallet' });
 *   await card.update('countdown', { id: 'batch', label: 'Next batch', ms: 21000, source: 'l2_getStatus nextBatchInMs' });
 *   const { video, startedAt } = await card.finish();
 */
import { stage } from './stage.mjs';
import { directorContext, SCREEN } from './whiteboard.mjs';

export const STATUS_LABEL = "No product screen shows this. Drawn by the video's director from the network's own answers.";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Status card</title><style>
:root { --bg:#0b0d12; --panel:#121620; --raised:#171c28; --line:#252b3a; --fg:#eef1f7; --muted:#a3abbd; --dim:#6f7891;
  --ok:#34d399; --wait:#fbbf24; --bad:#f87171; --info:#93c5fd; --accent:#a5b4fc;
  --font:'Segoe UI', system-ui, -apple-system, sans-serif; --mono:Consolas, 'Cascadia Mono', ui-monospace, monospace }
* { box-sizing:border-box } html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:16px/1.45 var(--font); overflow:hidden }
body { background: radial-gradient(ellipse at 18% 0%, rgba(99,102,241,.16), transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(16,185,129,.10), transparent 50%), var(--bg) }
.wrap { position:absolute; inset:28px 40px 104px; display:grid; grid-template-rows:auto auto minmax(0,1fr); gap:18px }
.tag { justify-self:start; display:flex; align-items:center; gap:10px; font:600 12px/1 var(--mono); letter-spacing:.09em; text-transform:uppercase;
  color:var(--accent); background:rgba(165,180,252,.10); border:1px solid rgba(165,180,252,.28); padding:8px 12px; border-radius:999px }
.tag i { width:8px; height:8px; border-radius:50%; background:var(--accent) }
h1 { margin:0; font:650 34px/1.15 var(--font); letter-spacing:-.01em } .sub { color:var(--muted); font-size:17px; margin-top:6px }
.rows { display:grid; gap:12px; align-content:start; overflow:hidden }
.row { display:grid; grid-template-columns:28px minmax(0,1fr) auto; gap:14px; align-items:center; background:var(--panel); border:1px solid var(--line);
  border-radius:14px; padding:10px 18px; animation:in .45s ease both }
.row .dot { width:14px; height:14px; border-radius:50%; background:var(--dim); justify-self:center; box-shadow:0 0 0 4px rgba(111,120,145,.15) }
.row.ok .dot { background:var(--ok); box-shadow:0 0 0 4px rgba(52,211,153,.16) } .row.wait .dot { background:var(--wait); box-shadow:0 0 0 4px rgba(251,191,36,.16); animation:pulse 1.4s ease-in-out infinite }
.row.bad .dot { background:var(--bad) } .row.info .dot { background:var(--info) }
.label { font-weight:600; font-size:18px } .src { color:var(--dim); font:12.5px/1.3 var(--mono); margin-top:3px }
.end { text-align:right; max-width:520px } .end .src { white-space:normal }
.value { font:600 19px/1.2 var(--mono); color:var(--fg); text-align:right; white-space:nowrap } .row.ok .value { color:var(--ok) } .row.wait .value { color:var(--wait) }
.note { color:var(--muted); font-size:14px; margin-top:4px }
.foot { position:absolute; left:40px; right:40px; bottom:28px; height:56px; display:flex; align-items:center; gap:12px; color:var(--muted); font-size:14.5px;
  border-top:1px solid var(--line); padding-top:12px }
.foot b { color:var(--fg); font-weight:600 }
@keyframes in { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:none } }
@keyframes pulse { 50% { opacity:.45 } }
</style></head><body>
<div class="wrap">
  <div class="tag"><i></i><span id="tag">Status card · drawn by the director</span></div>
  <div><h1 id="title">Behind the screen</h1><div class="sub" id="sub"></div></div>
  <div class="rows" id="rows"></div>
</div>
<div class="foot" id="foot"></div>
<script>
const $ = (id) => document.getElementById(id);
const rows = new Map();
const timers = new Map();
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function render(r) {
  let el = rows.get(r.id);
  if (!el) { el = document.createElement('div'); rows.set(r.id, el); $('rows').appendChild(el); }
  el.className = 'row ' + (r.tone || '');
  el.innerHTML = '';
  const dot = document.createElement('span'); dot.className = 'dot'; el.appendChild(dot);
  const mid = document.createElement('div');
  const l = document.createElement('div'); l.className = 'label'; l.textContent = r.label || ''; mid.appendChild(l);
  if (r.note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = r.note; mid.appendChild(n); }
  el.appendChild(mid);
  // the source sits under the value, so a row is at most two lines tall and five rows fit under the title
  const end = document.createElement('div'); end.className = 'end';
  const v = document.createElement('div'); v.className = 'value'; v.textContent = r.value == null ? '' : String(r.value); end.appendChild(v);
  if (r.source) { const s = document.createElement('div'); s.className = 'src'; s.textContent = 'from ' + r.source; end.appendChild(s); }
  el.appendChild(end);
  el.__value = v;
}
window.card = {
  setTitle(o) { $('title').textContent = (o && o.title) || ''; $('sub').textContent = (o && o.subtitle) || ''; },
  setFooter(text) { $('foot').textContent = text || ''; },
  upsertRow(r) { if (timers.has(r.id)) { clearInterval(timers.get(r.id)); timers.delete(r.id); } render(r); },
  removeRow(id) { const el = rows.get(id); if (el) el.remove(); rows.delete(id); },
  /** A client-side countdown seeded from a network answer (e.g. nextBatchInMs); it says 'due' at zero. */
  countdown(r) {
    const end = Date.now() + Number(r.ms || 0);
    render({ ...r, value: mmss(r.ms), tone: r.tone || 'wait' });
    if (timers.has(r.id)) clearInterval(timers.get(r.id));
    timers.set(r.id, setInterval(() => { const el = rows.get(r.id); const left = end - Date.now(); if (el && el.__value) el.__value.textContent = left > 0 ? mmss(left) : (r.dueText || 'due'); }, 250));
  },
  clear() { for (const t of timers.values()) clearInterval(t); timers.clear(); rows.clear(); $('rows').innerHTML = ''; }
};
</script></body></html>`;

export async function openStatusCard({ browser, context, recordVideoDir, viewport = SCREEN.viewport, deviceScaleFactor = SCREEN.deviceScaleFactor,
  videoSize = SCREEN.video, zoom = SCREEN.zoom, label = STATUS_LABEL, log = () => {}, captions = true }) {
  const own = !context;
  const ctx = context || await directorContext(browser, { recordVideoDir, viewport, deviceScaleFactor, videoSize });
  const page = await ctx.newPage();
  const startedAt = Date.now();
  page.on('pageerror', (e) => log(`status card page error: ${e.message}`));
  await page.setContent(PAGE, { waitUntil: 'load' });
  await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
  await page.evaluate((t) => window.card.setFooter(t), label);
  if (captions) await stage(page, { viewport, hideCursor: true, now: true });
  return {
    page,
    context: ctx,
    startedAt,
    /** Runs one card function with its argument; never throws (a card hiccup must not stop the take). */
    async update(fn, arg) {
      await page.evaluate(([f, a]) => window.card[f](a), [fn, arg]).catch((e) => log(`status card ${fn} failed: ${e.message}`));
    },
    async finish() {
      const video = page.video() ? await page.video().path() : null;
      await page.close();
      if (own) await ctx.close();
      return { video, startedAt };
    }
  };
}
