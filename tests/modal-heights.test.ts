/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The dashboards' modal windows fit the screen under CSS zoom.
 *
 * What was wrong: the network screen's batch window (.batch-modal) had max-height: 85vh, centered in a fixed overlay
 * that does not scroll. Under CSS zoom a vh length is multiplied by the zoom like any other length, so at zoom 1.5 the
 * window could grow to 85vh x 1.5, about 127% of the screen: it was cut off at both ends, its header with the title
 * and the close button above the top edge, where no click could reach the button. The pharmacy's script window (80vh),
 * the prescriber's compose window (80vh) and its formulary witness window (80vh, inline) had the same flaw. The compose
 * window and the two badge windows also capped their width in vw: the overlay's flex row still shrank them to the
 * screen, but under zoom they lost their margin at its sides. Found by the QA of the walkthrough's first voiced take,
 * 2026-10-23, which films the dashboards at html { zoom: 1.5 }: the batch window was clipped top and bottom for its
 * whole time on screen, and a click on its close button waited out its timeout.
 *
 * Now each window's maximum height and width is a share of its overlay (max-height: 85%, 80%; max-width: 90%, 95%).
 * The overlay is fixed over the whole screen, so a percentage reads the screen's own size, which zoom does not
 * multiply: unzoomed the batch and compose windows are the size they were (the pharmacy's script window, whose
 * overlay is padded, is a little shorter), and under any zoom they fit with a margin.
 *
 * Read from source: each stylesheet's rules, and how a length resolves under zoom (a px or viewport length is
 * multiplied by the zoom; a percentage reads the overlay, which the screen sizes; the overlay's flex row shrinks a
 * window wider than it). Headless Chromium 156 gives the same sizes: the batch window 1377 px tall with its top at
 * -148.5 px under 85vh, 918 px with its top at 81 px under 85%; the script window too, its padded overlay included.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);

interface Rule { selectors: string[]; decl: Record<string, string> }
/** Innermost `selector { declarations }` blocks, comments dropped; an @media wrapper is dropped, its rules kept. */
function rulesOf(file: string): Rule[] {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean),
    decl: Object.fromEntries(m[2].split(';').map((d) => d.split(':')).filter((kv) => kv.length >= 2)
      .map(([k, ...v]) => [k.trim(), v.join(':').trim()])),
  }));
}
/** The declarations of the rules naming exactly this selector, merged in source order. */
function decl(rules: Rule[], selector: string): Record<string, string> {
  const hits = rules.filter((r) => r.selectors.includes(selector));
  if (!hits.length) throw new Error('no rule for ' + selector);
  return Object.assign({}, ...hits.map((r) => r.decl));
}

/**
 * A length in screen pixels. `inner` is the overlay's content size, which a percentage reads; `screen` the screen's
 * size, which a viewport length reads; a px or viewport length is then multiplied by the zoom. Unset: no limit.
 */
function screenPx(value: string | undefined, inner: number, screen: number, zoom: number): number {
  if (!value) return Infinity;
  let m: RegExpExecArray | null;
  if ((m = /^([\d.]+)(vh|vw)$/.exec(value))) return (Number(m[1]) / 100) * screen * zoom;
  if ((m = /^([\d.]+)%$/.exec(value))) return (Number(m[1]) / 100) * inner;
  if ((m = /^([\d.]+)px$/.exec(value))) return Number(m[1]) * zoom;
  if ((m = /^calc\(100% - ([\d.]+)px\)$/.exec(value))) return inner - Number(m[1]) * zoom;
  throw new Error('a length this test does not read: ' + value);
}

/**
 * The window at its largest on a `w` x `h` screen at `zoom`: its height (Infinity when only its content sets it), and
 * its width, which the overlay's flex row shrinks to the overlay's inner width when it is wider.
 */
function largest(overlay: Record<string, string>, modal: Record<string, string>, w: number, h: number, zoom: number) {
  const pad = overlay.padding ? parseFloat(overlay.padding) * zoom : 0;
  return {
    height: screenPx(modal['max-height'], h - 2 * pad, h, zoom),
    width: Math.min(screenPx(modal.width, w - 2 * pad, w, zoom), screenPx(modal['max-width'], w - 2 * pad, w, zoom), w - 2 * pad),
  };
}

// The windows of the dashboards the claim is filmed on, each in the fixed overlay that shows it
const MODALS: Array<[string, string, string]> = [
  ['dashboard-leviathan/style.css', '.batch-modal-overlay', '.batch-modal'],
  ['dashboard-pharmacy/style.css', '.ws-modal-overlay', '.ws-modal'],
  ['dashboard-pharmacy/style.css', '.badge-modal-overlay', '.badge-modal'],
  ['dashboard-prescriber/style.css', '.modal-overlay', '.modal-content'],
  ['dashboard-prescriber/style.css', '.badge-modal-overlay', '.badge-modal'],
];
const SCREENS: Array<[number, number]> = [[1920, 1080], [1280, 720], [800, 600], [640, 360]];
const ZOOMS = [1, 1.25, 1.5, 2];

describe('the batch window on the network screen', () => {
  const rules = rulesOf('dashboard-leviathan/style.css');
  const overlay = decl(rules, '.batch-modal-overlay');
  const modal = decl(rules, '.batch-modal');

  test('at 1920 x 1080 and zoom 1.5 it fits, with its header and close button on screen', () => {
    const { height } = largest(overlay, modal, 1920, 1080, 1.5);
    expect(height).toBeLessThanOrEqual(1080);                          // before: 85vh x 1.5 = 1377 px
    expect((1080 - height) / 2).toBeGreaterThanOrEqual(0);             // the top edge of the centered window; before: -148 px
  });

  test('unzoomed it is as tall as before, 85% of the screen', () => {
    expect(largest(overlay, modal, 1920, 1080, 1).height).toBeCloseTo(0.85 * 1080);
  });

  test('what does not fit scrolls inside it', () => {
    expect(modal).toMatchObject({ display: 'flex', 'flex-direction': 'column', overflow: 'hidden' });
    expect(decl(rules, '.batch-modal-body')['overflow-y']).toBe('auto');
  });
});

describe('every window fits the screen at every zoom, with a margin', () => {
  test.each(MODALS)('%s %s', (file, overlaySelector, modalSelector) => {
    const rules = rulesOf(file);
    const overlay = decl(rules, overlaySelector);
    expect(overlay).toMatchObject({ position: 'fixed', inset: '0', display: 'flex' });   // a percentage reads the screen
    const modal = decl(rules, modalSelector);
    for (const [w, h] of SCREENS) {
      for (const zoom of ZOOMS) {
        const { height, width } = largest(overlay, modal, w, h, zoom);
        if (height !== Infinity) expect([w, h, zoom, 'height', height < h]).toEqual([w, h, zoom, 'height', true]);   // before: 85vh, 80vh run off the screen
        expect([w, h, zoom, 'width', width < w]).toEqual([w, h, zoom, 'width', true]);    // before: 90vw, 95vw touch its sides
      }
    }
  });

  test('no window on those dashboards is sized in viewport units, in a stylesheet or inline', () => {
    const viewport = /^[\d.]+(vh|vw|vmin|vmax|dvh|svh|lvh)$/;
    const sized = ['height', 'max-height', 'min-height', 'width', 'max-width', 'min-width'];
    const found: string[] = [];
    for (const page of ['employer', 'hr-tool', 'insurer', 'leviathan', 'marketplace', 'member', 'pharmacy', 'prescriber']) {
      for (const r of rulesOf(`dashboard-${page}/style.css`)) {
        if (!r.selectors.some((s) => /modal|dialog|overlay/.test(s))) continue;
        for (const p of sized) if (viewport.test(r.decl[p] || '')) found.push(`${page} ${r.selectors.join(', ')} ${p}: ${r.decl[p]}`);
      }
      // a window built in script, with its size in an inline style
      for (const m of read(`dashboard-${page}/app.js`).matchAll(/max-(?:height|width):\s*[\d.]+(?:vh|vw)/g)) found.push(`${page} app.js ${m[0]}`);
    }
    expect(found).toEqual([]);   // before: the batch window, the script window, the compose window, both badge windows, the witness window
  });
});
