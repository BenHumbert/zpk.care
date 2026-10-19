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
 * The pharmacy's script cards show the badges they render.
 *
 * What was wrong: the stylesheet hid `.script-issue-badge` (display: none) unless the card had an issue, and every
 * status badge a card renders reuses that class with its own colors: eRx, Filling..., Dispensing..., Proving...,
 * ZK Proved, Proof Failed, Proof Timeout, Member Verified, Settlement Complete, Reversed and the rest. So a card with
 * no issue showed none of them: the pharmacist could not see that a fill was proven, still proving, failed or
 * settled. Hidden since 2695e7c (2026-03-12). Found by the walkthrough rehearsal of 2026-10-19, whose pay scene waits
 * for ZK Proved on the dispensed card. The same rehearsal's frames showed the card's date and quantity breaking over
 * two lines and the Payment Received button wrapping onto the third price in the narrow Dispensed column.
 *
 * Now every badge shows, and the card's top row wraps, so the badges move under the drug name when the column is
 * narrow; the meta items keep one line (the patient and the prescriber shorten with an ellipsis); the actions move
 * under the prices with their labels on one line.
 *
 * Read from source: the stylesheet's rules and the card markup in app.js.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const CSS = read('dashboard-pharmacy/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const APP = read('dashboard-pharmacy/app.js');

interface Rule { selectors: string[]; decl: Record<string, string> }
/** Innermost `selector { declarations }` blocks; an @media or @keyframes wrapper is dropped, its rules kept. */
const RULES: Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean),
  decl: Object.fromEntries(m[2].split(';').map((d) => d.split(':')).filter((kv) => kv.length >= 2)
    .map(([k, ...v]) => [k.trim(), v.join(':').trim()])),
}));
/** The declarations of the rules naming exactly this selector, merged in source order. */
function decl(selector: string): Record<string, string> {
  const hits = RULES.filter((r) => r.selectors.includes(selector));
  if (!hits.length) throw new Error('no rule for ' + selector);
  return Object.assign({}, ...hits.map((r) => r.decl));
}

describe('the pharmacy cards show every badge they render', () => {
  test('no rule hides a badge; the badge rule shows it', () => {
    const hiding = RULES.filter((r) => r.selectors.some((s) => /\.script-issue-badge\b/.test(s)) && /^none\b/.test(r.decl.display || ''));
    expect(hiding.map((r) => r.selectors.join(', '))).toEqual([]);          // before: '.script-issue-badge' { display: none }
    expect(decl('.script-issue-badge').display).toBe('inline-block');
    expect(decl('.script-issue-badge')['white-space']).toBe('nowrap');
  });

  test('the status badges are the ones that class carries, so each of them is now on screen', () => {
    const top = APP.slice(APP.indexOf("'<div class=\"script-card-top\">'"), APP.indexOf("'<div class=\"script-card-meta\">'"));
    expect(top.length).toBeGreaterThan(0);
    for (const label of ['eRx', 'Filling...', 'Dispensing...', 'Proving...', 'ZK Proved', 'Proof Failed', 'Proof Timeout', 'Member Verified', 'Settlement Complete', 'Reversed', 'Rejected', 'Transferred', 'Cancelled', 'Not Recorded']) {
      expect([label, new RegExp(`<span class="script-issue-badge"[^>]*>${label.replace(/\./g, '\\.')}</span>`).test(top)]).toEqual([label, true]);
    }
  });

  test('the top row wraps: the drug name shortens, and the badges move under it in a narrow column', () => {
    expect(decl('.script-card-top')['flex-wrap']).toBe('wrap');            // before: one line, badges pushed out
    expect(decl('.script-med')['min-width']).toBe('0');
    expect(decl('.script-med')['max-width']).toBe('100%');                 // before: 70%
    expect(decl('.script-med')['text-overflow']).toBe('ellipsis');
  });

  test('each meta item keeps one line; the patient and the prescriber shorten with an ellipsis', () => {
    expect(decl('.script-card-meta > span')['white-space']).toBe('nowrap'); // before: the date broke as 2026-10- / 19
    for (const s of ['.script-card-meta > .script-patient', '.script-card-meta > .script-prescriber']) {
      expect([s, decl(s).overflow, decl(s)['text-overflow'], decl(s)['min-width']]).toEqual([s, 'hidden', 'ellipsis', '0']);
    }
    expect(APP).toContain(`'<span class="script-prescriber" title="Prescriber">' + escapeHtml(prescriber) + '</span>'`);
  });

  test('the actions keep their labels on one line and move under the prices when the column is narrow', () => {
    expect(decl('.script-card-bottom')['flex-wrap']).toBe('wrap');
    expect(decl('.script-actions .btn')['white-space']).toBe('nowrap');    // before: Payment / Received over the price
    expect(decl('.script-actions')['margin-left']).toBe('auto');
    expect(decl('.script-price-tag')['white-space']).toBe('nowrap');
  });
});
