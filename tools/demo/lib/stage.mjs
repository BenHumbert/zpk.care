/**
 * What the viewer of the recorded walkthrough sees on top of each real dashboard: a large cursor that travels on a
 * gentle eased arc and dips when it clicks, click ripples, the speaker's caption (name in their colour, then the
 * line), a badge naming whose screen this is, and a "behind this click" lower-third card. Only pages registered with
 * stage() get the slow, visible clicks and typing; every other page keeps Playwright's normal speed.
 *
 * Adapted from SwapStreet's site-e2e/lib/stage.mjs. Changes for zpk.care:
 *  - no SwapStreet #protoBar rule
 *  - fast mode for rehearsals (60 ms glides, no dwell, instant fills)
 *  - check(), uncheck() and setInputFiles() glide and ripple too (plan checkboxes, the HR roster CSV)
 *  - fill(value, { paste: true }) glides, clicks, then fills at once (the long attestation JSON)
 *  - window.__demoCard(title, lines): the lower-third card
 *  - hideCursor for the director's own pages (whiteboard, status card), which keep only the captions
 *  - fillSecret(): a token, PIN or passphrase is never typed on screen. The field is masked first and the value is
 *    written into it from Node (page.evaluate), a character at a time so the dots still appear.
 *  - the caption is drawn above the cursor, so a pointer left where a button was clicked never sits on the words, and
 *    the dashboards' toasts (#toast-container, bottom right on every dashboard) rise above the caption while it shows
 *  - cardAt: 'top-right' puts the lower-third beside the title (the director's status card, whose rows fill the
 *    screen below it)
 *  - a click's or hover's timeout covers its aim and glide too, so one allowed to fail gives up about a second after
 *    it, not after Playwright's 30 s on camera
 *  - pointAt() rests the pointer just under an element, so the figure a line names stays readable; clickAt() clicks
 *    a point that is no control of its own (a dialog's backdrop)
 *
 *   const s = await stage(page, { viewport, badge: { name: 'Theo Brandvold', role: 'Insurer analyst', color: '#0ea5e9' } });
 *   await s.glideTo({ x, y });
 *   await page.locator('#plan-name').fill('Standard Rx 2026');   // glides there, clicks, types at a human pace
 *   await s.card('Behind this click', ['POST /plans', 'signed with the insurer key']);
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The in-page layer (an init script, and evaluated once more on pages built with setContent). */
export function overlayScript(opts) {
  if (window.__demoOverlay) return;
  window.__demoOverlay = true;
  const hideCursor = !!(opts && opts.hideCursor);
  const cardTop = !!(opts && opts.cardAt === 'top-right');
  // stacking, top down: the caption, the cursor, a click ripple and the badge, the lower-third card
  const CSS = ''
    + '#__demoCursor{position:fixed;left:0;top:0;width:40px;height:40px;z-index:2147483646;pointer-events:none;transform:translate(-200px,-200px);will-change:transform' + (hideCursor ? ';display:none!important' : '') + '}'
    + '#__demoCursor svg{transition:transform .12s ease-out;transform-origin:6px 4px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}'
    + '#__demoCursor.down svg{transform:scale(.82)}'
    // centred by auto margins: left:50% with a translate would cap the caption at half the screen, under its max-width
    + '#__demoCaption{position:fixed;left:0;right:0;bottom:22px;margin:0 auto;width:fit-content;z-index:2147483647;pointer-events:none;max-width:82%;'
    + 'background:rgba(12,12,14,.94);color:#f4f4f5;font:500 19px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px 18px;border-radius:12px;'
    + 'border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.35);display:none}'
    + '#__demoCaption b{font-weight:700;margin-right:10px}'
    + '#__demoBadge{position:fixed;left:14px;bottom:22px;z-index:2147483645;pointer-events:none;display:none;align-items:center;gap:8px;'
    + 'background:rgba(12,12,14,.9);color:#f4f4f5;font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;padding:9px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.14)}'
    + '#__demoBadge i{width:10px;height:10px;border-radius:50%;display:inline-block}'
    + '#__demoBadge span{color:#a1a1aa;font-weight:500}'
    + '#__demoCard{position:fixed;left:18px;bottom:96px;z-index:2147483644;pointer-events:none;max-width:min(560px,46%);display:none;'
    + 'background:rgba(12,12,14,.92);color:#f4f4f5;font:500 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px 16px 13px;border-radius:10px;'
    + 'border:1px solid rgba(255,255,255,.14);border-left:4px solid #9b9bff;box-shadow:0 8px 24px rgba(0,0,0,.35);animation:__demoCardIn .35s ease-out both;transition:bottom .25s ease-out}'
    + '#__demoCard.__top{left:auto;right:40px;top:24px;bottom:auto;max-width:440px}'
    + '#__demoCard h4{margin:0 0 5px;font:700 11px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.09em;text-transform:uppercase;color:#a5a5ff}'
    + '#__demoCard p{margin:2px 0}'
    + '@keyframes __demoCardIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
    + '.__demoRipple{position:fixed;z-index:2147483645;pointer-events:none;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:3px solid #9b9bff;animation:__demoRip .6s ease-out forwards}'
    + '@keyframes __demoRip{from{transform:scale(.25);opacity:1}to{transform:scale(1.45);opacity:0}}'
    + '#toast-container{transition:bottom .25s ease-out}';
  let x = -200;
  let y = -200;
  // the take renders each page at 1920x1080 with html { zoom: 1.5 } (a 1280x720 layout, drawn crisp): mouse
  // coordinates are in screen pixels, while lengths inside the zoomed page are multiplied by the zoom
  const Z = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const place = (c) => { const z = Z(); c.style.transform = 'translate(' + (x / z - 6) + 'px,' + (y / z - 4) + 'px)'; };
  const state = { say: null, badge: null, card: null };
  // the dashboards' toasts (#toast-container, fixed bottom right) would slide under the caption: while a line shows
  // they sit just above it, and they come down a moment after the last line, not in the pause between two lines
  let toastDrop = null;
  function liftToasts(px) {
    let lift = document.getElementById('__demoToastLift');
    if (px) {
      clearTimeout(toastDrop);
      toastDrop = null;
      if (!lift) {
        lift = document.createElement('style');
        lift.id = '__demoToastLift';
        (document.head || document.body).appendChild(lift);
      }
      const css = '#toast-container{bottom:' + px + 'px!important}';
      if (lift.textContent !== css) lift.textContent = css;
    } else if (lift && !toastDrop) {
      toastDrop = setTimeout(() => { toastDrop = null; lift.remove(); }, 1500);
    }
  }
  function render() {
    const cap = document.getElementById('__demoCaption');
    if (cap) {
      cap.textContent = '';
      if (state.say) {
        const b = document.createElement('b');
        b.textContent = state.say.who;
        b.style.color = state.say.color;
        cap.appendChild(b);
        cap.appendChild(document.createTextNode(state.say.text));
        cap.style.display = 'block';
      } else cap.style.display = 'none';
      liftToasts(state.say ? 22 + cap.offsetHeight + 12 : 0);
    }
    const bad = document.getElementById('__demoBadge');
    if (bad && state.badge) {
      bad.textContent = '';
      const dot = document.createElement('i');
      dot.style.background = state.badge.color;
      bad.appendChild(dot);
      bad.appendChild(document.createTextNode(state.badge.name));
      const r = document.createElement('span');
      r.textContent = state.badge.role;
      bad.appendChild(r);
      // the caption takes the bottom while someone speaks; the badge stays clear of it
      bad.style.display = state.say ? 'none' : 'flex';
    }
    const card = document.getElementById('__demoCard');
    if (card) {
      card.classList.toggle('__top', cardTop);
      if (state.card) {
        if (card.__shown !== state.card) {
          card.textContent = '';
          const h = document.createElement('h4');
          h.textContent = state.card.title || '';
          card.appendChild(h);
          for (const line of state.card.lines || []) {
            const p = document.createElement('p');
            p.textContent = line;
            card.appendChild(p);
          }
          card.style.borderLeftColor = state.card.color || '#9b9bff';
          card.__shown = state.card;
        }
        card.style.display = 'block';
        // a caption grows upward from bottom:22px as it wraps: the card moves up to stay clear of it (96px clears one
        // line) and keeps its place while the caption is hidden between two lines
        if (cap && state.say && !cardTop) card.style.bottom = Math.max(96, 22 + cap.offsetHeight + 12) + 'px';
      } else {
        card.style.display = 'none';
        card.style.bottom = '';
        card.__shown = null;
      }
    }
  }
  function install() {
    if (!document.body) return;
    if (!document.getElementById('__demoStyle')) {
      const st = document.createElement('style');
      st.id = '__demoStyle';
      st.textContent = CSS;
      (document.head || document.body).appendChild(st);
    }
    if (!document.getElementById('__demoCursor')) {
      const c = document.createElement('div');
      c.id = '__demoCursor';
      c.innerHTML = '<svg width="40" height="40" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      place(c);
      document.body.appendChild(c);
    }
    for (const id of ['__demoCaption', '__demoBadge', '__demoCard']) {
      if (!document.getElementById(id)) {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
      }
    }
    render();
  }
  window.__demoSay = (who, text, color) => {
    state.say = who ? { who, text, color: color || '#9b9bff' } : null;
    install();
    render();
  };
  window.__demoBadge = (badge) => {
    state.badge = badge;
    install();
    render();
  };
  window.__demoCard = (title, lines, color) => {
    state.card = title ? { title, lines: Array.isArray(lines) ? lines : (lines ? [String(lines)] : []), color } : null;
    install();
    render();
  };
  document.addEventListener('mousemove', (e) => {
    x = e.clientX;
    y = e.clientY;
    const c = document.getElementById('__demoCursor');
    if (c) place(c);
  }, true);
  document.addEventListener('mousedown', (e) => {
    const c = document.getElementById('__demoCursor');
    if (c) c.classList.add('down');
    if (hideCursor) return;
    const r = document.createElement('div');
    r.className = '__demoRipple';
    r.style.left = (e.clientX / Z()) + 'px';
    r.style.top = (e.clientY / Z()) + 'px';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }, true);
  document.addEventListener('mouseup', () => {
    const c = document.getElementById('__demoCursor');
    if (c) c.classList.remove('down');
  }, true);
  window.__demoRipple = (px, py) => {
    const r = document.createElement('div');
    r.className = '__demoRipple';
    r.style.left = (px / Z()) + 'px';
    r.style.top = (py / Z()) + 'px';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
  setInterval(install, 400);
}

const STAGED = new WeakMap(); // page -> { pos, viewport, bend, fast }
let patched = false;

/** The eased arc from the cursor's spot to `to`: about 60 moves a second, longer trips take a little longer. */
async function glide(page, to, { ms } = {}) {
  const st = STAGED.get(page);
  const from = st.pos || { x: st.viewport.width / 2, y: st.viewport.height / 2 };
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < 2) return;
  const dur = st.fast ? 60 : (ms ?? Math.round(Math.min(1150, Math.max(380, 300 + d * 0.85))));
  // a control point off the straight line, alternating sides, so trips curve the way a hand moves
  st.bend = -(st.bend || 1);
  const nx = -(to.y - from.y) / d;
  const ny = (to.x - from.x) / d;
  const off = Math.min(70, d * 0.15) * st.bend;
  const c = { x: (from.x + to.x) / 2 + nx * off, y: (from.y + to.y) / 2 + ny * off };
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / dur);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const u = 1 - e;
    const px = u * u * from.x + 2 * u * e * c.x + e * e * to.x;
    const py = u * u * from.y + 2 * u * e * c.y + e * e * to.y;
    await page.mouse.move(px, py);
    if (t >= 1) break;
    await sleep(14);
  }
  st.pos = { x: to.x, y: to.y };
}

const dwell = (pg, ms) => (STAGED.get(pg)?.fast ? Promise.resolve() : pg.waitForTimeout(ms));

/**
 * Where to aim. Each step waits at most 5 s, and all of them together no longer than the action's own timeout: an
 * action allowed to fail must fail within it, not hold the camera on a still screen.
 */
async function centerOf(loc, timeout) {
  const end = Date.now() + (timeout || Infinity); // 0 is Playwright's "no timeout"
  const left = () => Math.max(1, Math.min(5000, end - Date.now()));
  await loc.scrollIntoViewIfNeeded({ timeout: left() }).catch(() => {});
  const box = await loc.boundingBox({ timeout: left() }).catch(() => null);
  if (box && box.width > 0 && box.height > 0) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // a hidden control (a file input inside its drop zone): aim at the nearest visible ancestor instead
  const r = await loc.evaluate((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const b = p.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, undefined, { timeout: left() }).catch(() => null);
  return r;
}
/** The action's own options once it has aimed: what is left of the caller's timeout (at least a second). */
const remaining = (o, end) => (end ? { ...o, timeout: Math.max(1000, end - Date.now()) } : o);

/** Input types a person does not type character by character (the browser's own pickers). */
const PICKER_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'file', 'checkbox', 'radio']);

function patchLocators(page) {
  if (patched) return;
  const proto = Object.getPrototypeOf(page.locator('body'));
  patched = true;
  const click = proto.click;
  const select = proto.selectOption;
  const fill = proto.fill;
  const check = proto.check;
  const uncheck = proto.uncheck;
  const setInputFiles = proto.setInputFiles;
  const hover = proto.hover;
  proto.__unstagedClick = click;
  proto.__unstagedFill = fill;

  proto.click = async function stagedClick(o) {
    const pg = this.page();
    if (!STAGED.has(pg)) return click.call(this, o);
    const end = o && o.timeout ? Date.now() + o.timeout : null;
    const to = await centerOf(this, o && o.timeout);
    if (to) {
      await glide(pg, to);
      await dwell(pg, 260);
    }
    return click.call(this, remaining(o, end));
  };
  proto.hover = async function stagedHover(o) {
    const pg = this.page();
    if (!STAGED.has(pg)) return hover.call(this, o);
    const end = o && o.timeout ? Date.now() + o.timeout : null;
    const to = await centerOf(this, o && o.timeout);
    if (to) await glide(pg, to);
    return hover.call(this, remaining(o, end));
  };
  /** Types at a human pace; { paste: true } (and fast mode, and date pickers) fill at once after the click. */
  proto.fill = async function stagedFill(value, o = {}) {
    const pg = this.page();
    if (!STAGED.has(pg)) return fill.call(this, value, o);
    const { paste, ...rest } = o || {};
    const to = await centerOf(this, rest.timeout);
    if (to) await glide(pg, to);
    const type = await this.evaluate((el) => (el.tagName === 'INPUT' ? String(el.type || 'text').toLowerCase() : el.tagName.toLowerCase())).catch(() => 'text');
    if (paste || STAGED.get(pg).fast || PICKER_TYPES.has(type)) {
      await click.call(this, { timeout: rest.timeout ?? 5000 }).catch(() => {});
      await dwell(pg, 120);
      return fill.call(this, String(value), rest);
    }
    await click.call(this);
    await this.press('Control+A').catch(() => {});
    await this.press('Backspace').catch(() => {});
    for (const ch of String(value)) {
      await this.pressSequentially(ch, { delay: 0 });
      await pg.waitForTimeout(85 + Math.round(Math.random() * 70));
    }
  };
  proto.selectOption = async function stagedSelect(v, o) {
    const pg = this.page();
    if (!STAGED.has(pg)) return select.call(this, v, o);
    const to = await centerOf(this, o && o.timeout);
    if (to) await glide(pg, to);
    const r = await select.call(this, v, o);
    await dwell(pg, 420);
    return r;
  };
  proto.check = async function stagedCheck(o) {
    const pg = this.page();
    if (!STAGED.has(pg)) return check.call(this, o);
    const to = await centerOf(this, o && o.timeout);
    if (to) {
      await glide(pg, to);
      await dwell(pg, 220);
    }
    return check.call(this, o);
  };
  proto.uncheck = async function stagedUncheck(o) {
    const pg = this.page();
    if (!STAGED.has(pg)) return uncheck.call(this, o);
    const to = await centerOf(this, o && o.timeout);
    if (to) {
      await glide(pg, to);
      await dwell(pg, 220);
    }
    return uncheck.call(this, o);
  };
  proto.setInputFiles = async function stagedSetInputFiles(files, o) {
    const pg = this.page();
    if (!STAGED.has(pg)) return setInputFiles.call(this, files, o);
    const to = await centerOf(this, o && o.timeout);
    if (to) {
      await glide(pg, to);
      await pg.evaluate(([px, py]) => window.__demoRipple && window.__demoRipple(px, py), [to.x, to.y]).catch(() => {});
      await dwell(pg, 260);
    }
    return setInputFiles.call(this, files, o);
  };
}

/**
 * Puts a page on stage: the overlay on every navigation, slow visible clicks, the badge. Call before goto().
 * { now: true } also installs the overlay in the current document (pages built with setContent); { cardAt: 'top-right' }
 * draws the lower-third card beside the title instead of at the bottom left.
 */
export async function stage(page, { viewport, badge, fast = false, hideCursor = false, now = false, cardAt = null } = {}) {
  STAGED.set(page, { pos: null, viewport: viewport || page.viewportSize() || { width: 1280, height: 720 }, bend: 1, fast });
  patchLocators(page);
  await page.addInitScript(overlayScript, { hideCursor, cardAt });
  if (now) await page.evaluate(overlayScript, { hideCursor, cardAt }).catch(() => {});
  const setBadge = () => page.evaluate((b) => window.__demoBadge && window.__demoBadge(b), badge).catch(() => {});
  if (badge) page.on('load', setBadge);
  let cardTimer = null;
  const api = {
    page,
    glideTo: (to, o) => glide(page, to, o),
    async ripple(to) {
      await page.evaluate(([px, py]) => window.__demoRipple && window.__demoRipple(px, py), [to.x, to.y]).catch(() => {});
    },
    /**
     * Points at an element without covering it: the pointer's tip rests just under its bottom edge, so the arrow sits
     * below the figure a line names (a hover parks it on top). Never throws; it gives up after `timeout`.
     */
    async pointAt(loc, { timeout = 5000 } = {}) {
      const end = Date.now() + timeout;
      await loc.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
      const box = await loc.boundingBox({ timeout: Math.max(1, end - Date.now()) }).catch(() => null);
      if (box) await glide(page, { x: box.x + box.width / 2, y: box.y + box.height + 4 });
    },
    /** Glides to a point and clicks there: a spot that is no control of its own, such as a dialog's backdrop. */
    async clickAt(to) {
      await glide(page, to);
      await dwell(page, 260);
      await page.mouse.click(to.x, to.y);
    },
    setBadge,
    setFast(on) { STAGED.get(page).fast = !!on; },
    get fast() { return STAGED.get(page).fast; },
    /** The "behind this click" lower-third. { ms } hides it again after that long. */
    async card(title, lines = [], { ms, color } = {}) {
      if (cardTimer) clearTimeout(cardTimer);
      await page.evaluate(([t, l, c]) => window.__demoCard && window.__demoCard(t, l, c), [title, lines, color || null]).catch(() => {});
      if (ms) cardTimer = setTimeout(() => api.hideCard(), ms);
    },
    async hideCard() {
      if (cardTimer) clearTimeout(cardTimer);
      cardTimer = null;
      await page.evaluate(() => window.__demoCard && window.__demoCard(null)).catch(() => {});
    },
    /**
     * Writes a secret into a field without typing it: the field is masked first (password fields already are;
     * any other input gets -webkit-text-security: disc), then the value goes in from Node a character at a time.
     */
    async fillSecret(loc, value, { charMs = 70 } = {}) {
      const to = await centerOf(loc);
      if (to) await glide(page, to);
      await loc.__unstagedClick({ timeout: 5000 }).catch(() => {});
      await loc.evaluate((el) => {
        const masked = (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password')
          || getComputedStyle(el).getPropertyValue('-webkit-text-security').trim() === 'disc';
        if (!masked) el.style.setProperty('-webkit-text-security', 'disc', 'important');
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const v = String(value);
      const step = STAGED.get(page).fast ? Math.max(1, v.length) : 1;
      for (let i = step; i <= v.length + step - 1; i += step) {
        const n = Math.min(i, v.length);
        // the value travels inside page.evaluate; it is never sent as key presses and never logged
        await loc.evaluate((el, s) => { el.value = s; el.dispatchEvent(new Event('input', { bubbles: true })); }, v.slice(0, n));
        if (!STAGED.get(page).fast) await sleep(charMs + Math.round(Math.random() * 40));
      }
      await loc.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
    },
    /** Scrolls an inner scroll box to its end with the mouse wheel, the way a person reads to the bottom. */
    async scrollWithin(loc, { step = 220, maxSteps = 60 } = {}) {
      const to = await centerOf(loc);
      if (to) await glide(page, to);
      if (STAGED.get(page).fast) {
        await loc.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
        return;
      }
      for (let i = 0; i < maxSteps; i++) {
        const done = await loc.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
        if (done) break;
        await page.mouse.wheel(0, step);
        await sleep(240 + Math.round(Math.random() * 120));
      }
      // the page listens for the scroll event to unlock signing; make sure the last one fired at the bottom
      await loc.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    },
    /** Clicks a visible upload button (or drop zone) and answers the browser's file chooser with `files`. */
    async uploadVia(buttonLoc, files) {
      const to = await centerOf(buttonLoc);
      if (to) {
        await glide(page, to);
        await dwell(page, 260);
      }
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), buttonLoc.__unstagedClick()]);
      await chooser.setFiles(files);
    }
  };
  return api;
}
