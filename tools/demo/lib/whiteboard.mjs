/**
 * The walkthrough's whiteboard, recorded like the people's screens (the board.mjs pattern from SwapStreet). It is an
 * offline page: its browser context is offline and every request is aborted, MathJax 3.2.2 comes from this folder's
 * node_modules through addScriptTag({ path }), and the handwriting font arrives as a data: URL. The director feeds it
 * with page.evaluate; it holds no data of its own.
 *
 *   const board = await openWhiteboard({ browser, recordVideoDir });     // or { context } to share one
 *   await board.prepare(EQUATIONS.map(e => ({ id: e.key, latex: e.latex })));   // before T0; throws on bad LaTeX
 *   await board.setTitle('From identity to wallet ID');
 *   await board.writeEquation(eq('2b').latex, { id: 'eq-2b', durationMs: 6000, color: 'ink', at: 'next' });
 *   await board.annotate('stays on the phone', { near: { eq: 'eq-2b', find: 'f0' }, side: 'below', color: 'blue' });
 *   await board.circle({ eq: 'eq-2b', find: 'f5' }, { color: 'red' });
 *   board.start('writeEquation', {...}); ...; await board.idle();      // fire and forget, then wait for the pen
 *   const { video, startedAt } = await board.finish();
 *
 * update(fn, arg) awaits the in-page promise and logs errors, but never throws: a board hiccup must not stop a take.
 * call(fn, ...args) is the strict version (prepare and the preview use it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stage } from './stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WHITEBOARD_HTML = path.join(HERE, '..', 'whiteboard', 'whiteboard.html');
export const MATHJAX_FILE = path.join(HERE, '..', 'node_modules', 'mathjax', 'es5', 'tex-svg-full.js');
export const FONT_FILE = path.join(HERE, '..', 'whiteboard', 'fonts', 'ComicNeue-Regular.ttf');

/** MathJax before it loads: nothing autoloads (no CDN), no typesetting on its own, every glyph an inline <path>. */
export const MATHJAX_CONFIG = Object.freeze({
  loader: { load: [] },
  startup: { typeset: false },
  options: { enableMenu: false },
  tex: { packages: { '[+]': ['html', 'color', 'ams', 'boldsymbol', 'cancel'], '[-]': ['noerrors', 'noundefined'] } },
  svg: { fontCache: 'none' }
});

/**
 * The screen every page of a take is recorded at. Chrome's screencast (what Playwright records) ignores an emulated
 * deviceScaleFactor: a 1280x720 viewport at DSF 1.5 is recorded as a 1280x720 frame padded into the 1920x1080 video.
 * So each page gets a real 1920x1080 viewport at DSF 1 and html { zoom: 1.5 }: it lays out as on a 1280x720 screen
 * (as the dashboards were designed and the tooling spec intended) and is drawn crisp at 1080p.
 */
export const SCREEN = Object.freeze({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, zoom: 1.5, video: { width: 1920, height: 1080 } });

/** Shared defaults for a director page: what the people's pages use, offline. */
export async function directorContext(browser, { recordVideoDir, viewport = SCREEN.viewport, deviceScaleFactor = SCREEN.deviceScaleFactor, videoSize = SCREEN.video } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    locale: 'en-US',
    offline: true,
    recordVideo: recordVideoDir ? { dir: recordVideoDir, size: videoSize } : undefined
  });
  await context.route('**/*', (route) => route.abort());
  return context;
}

export async function openWhiteboard({ browser, context, recordVideoDir, viewport = SCREEN.viewport, deviceScaleFactor = SCREEN.deviceScaleFactor,
  videoSize = SCREEN.video, zoom = SCREEN.zoom, mathjaxFile = MATHJAX_FILE, fontFile = FONT_FILE, log = () => {}, captions = true, rough = true }) {
  if (!fs.existsSync(mathjaxFile)) throw new Error(`MathJax is not installed: ${mathjaxFile} (npm install in tools/demo)`);
  const own = !context;
  const ctx = context || await directorContext(browser, { recordVideoDir, viewport, deviceScaleFactor, videoSize });
  const page = await ctx.newPage();
  const startedAt = Date.now();
  page.on('pageerror', (e) => log(`whiteboard page error: ${e.message}`));
  const font = `data:font/ttf;base64,${fs.readFileSync(fontFile).toString('base64')}`;
  const html = fs.readFileSync(WHITEBOARD_HTML, 'utf8').replace('url(__COMIC_NEUE_DATA_URL__)', () => `url(${font})`);
  await page.setContent(html, { waitUntil: 'load' });
  // the board is laid out at 1280x720 CSS pixels; the zoom draws it at the viewport's 1920x1080
  await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
  await page.addScriptTag({ content: `window.MathJax = ${JSON.stringify(MATHJAX_CONFIG)};` });
  await page.addScriptTag({ path: mathjaxFile });
  const ready = await page.evaluate(() => window.wb.ready());
  if (!ready.font) log('whiteboard: Comic Neue did not load; the CSS fallbacks are in use');
  await page.evaluate((o) => window.wb.configure(o), { rough });
  if (captions) await stage(page, { viewport, hideCursor: true, now: true });

  const call = (fn, ...args) => page.evaluate(([f, a]) => window.wb[f](...a), [fn, args]);
  const update = async (fn, ...args) => {
    try {
      return await call(fn, ...args);
    } catch (e) {
      log(`whiteboard ${fn} failed: ${String(e.message || e).split('\n')[0]}`);
      return null;
    }
  };
  /** Queues a stroke on the pen and returns at once; idle() waits for every queued stroke. */
  const start = async (fn, ...args) => {
    await page.evaluate(([f, a]) => { window.wb[f](...a).catch((e) => console.warn('wb', f, e && e.message)); return true; }, [fn, args]).catch((e) => log(`whiteboard ${fn} failed: ${e.message}`));
  };
  const idle = async () => {
    const r = await page.evaluate(() => window.wb.idle()).catch((e) => ({ ok: false, lastError: e.message }));
    if (r && r.lastError) log(`whiteboard: ${r.lastError}`);
    return r;
  };
  const target = (t) => (typeof t === 'string' ? t : t);

  return {
    page,
    context: ctx,
    startedAt,
    mathjax: ready.mathjax,
    fontLoaded: ready.font,
    call,
    update,
    start,
    idle,
    /** Typesets every equation ahead of time; throws, naming each one, if any LaTeX is bad. */
    async prepare(list) {
      const r = await call('prepare', list);
      if (r.errors.length) throw new Error(`whiteboard: ${r.errors.length} equation(s) did not typeset: ${r.errors.map((e) => `${e.id}: ${e.message}`).join('; ')}`);
      return r;
    },
    setTitle: (text, o = {}) => update('setTitle', text, o),
    /** writeEquation(latex, { id, durationMs, color, at, size, align, order }) resolves when the last stroke ends. */
    writeEquation: (latex, o = {}) => update('writeEquation', latex, o),
    annotate: (text, o = {}) => update('annotate', { ...o, text, near: o.near ?? o.target }),
    value: (t, text, o = {}) => update('value', { ...o, target: target(t), text }),
    circle: (t, o = {}) => update('circle', { ...o, target: target(t) }),
    underline: (t, o = {}) => update('underline', { ...o, target: target(t) }),
    box: (t, o = {}) => update('box', { ...o, target: target(t) }),
    arrow: (from, to, o = {}) => update('arrow', { ...o, from, to }),
    check: (t, o = {}) => update('check', { ...o, target: target(t) }),
    erase: (ids, o = {}) => update('erase', { ...o, ids }),
    clear: (o = {}) => update('clear', o),
    pen: (visible) => update('pen', visible),
    text: (id) => call('text', id),
    state: () => call('state'),
    async screenshot(file) {
      await page.screenshot({ path: file });
      return file;
    },
    async finish() {
      const video = page.video() ? await page.video().path() : null;
      await page.close();
      if (own) await ctx.close();
      return { video, startedAt };
    }
  };
}
