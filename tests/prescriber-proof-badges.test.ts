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
 * The prescriber's proof badge and result box have their colors in every state.
 *
 * What was wrong: after Send, the prescriber page shows a badge for the prescription's proofs and a result box. The page
 * sets 'badge badge-settled' when the proofs are made ("ZK Proofs: Generated"), 'badge badge-failed' when they failed,
 * 'badge badge-error' when it gave up waiting, and 'form-result info' around the result. The stylesheet had rules only
 * for badge-ready, badge-pending, badge-info, badge-accent and badge-live, and for form-result success and error. So the
 * pending pill was yellow, but on success it lost its background and read as plain body text; a failure or a timeout
 * was not red; the result box had no fill. Found by the scene audit of the walkthrough, 2026-10-19: the prescribe scene
 * films the badge as the proofs complete.
 *
 * Now each of those states has its rule, in the stylesheet's own colors: green for proved, red for failed and timed out,
 * and the info blue for the result box. A guard holds every badge and result class the page sets to a rule.
 *
 * Read from source: the stylesheet's rules and the classes app.js sets.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const CSS = read('dashboard-prescriber/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const APP = read('dashboard-prescriber/app.js');

interface Rule { selectors: string[]; decl: Record<string, string> }
/** Innermost `selector { declarations }` blocks; an @media or @keyframes wrapper is dropped, its rules kept. */
const RULES: Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean),
  decl: Object.fromEntries(m[2].split(';').map((d) => d.split(':')).filter((kv) => kv.length >= 2)
    .map(([k, ...v]) => [k.trim(), v.join(':').trim()])),
}));
const rule = (selector: string): Record<string, string> | null => {
  const hits = RULES.filter((r) => r.selectors.includes(selector));
  return hits.length ? Object.assign({}, ...hits.map((r) => r.decl)) : null;
};

describe('the prescriber page colors its proof badge and result box in every state', () => {
  test('proved is green, failed and timed out are red, as the page sets them', () => {
    expect(APP).toContain("badge.className = 'badge badge-settled'; badge.textContent = 'ZK Proofs: Generated';");
    expect(APP).toContain("badge.className = 'badge badge-failed'; badge.textContent = 'ZK Proof: Failed';");
    expect(APP).toContain("badge.className = 'badge badge-error'; badge.textContent = 'ZK Proof: Timeout';");
    expect(rule('.badge-settled')).toEqual({ background: '#0d3b1e', color: 'var(--green)' });   // before: no rule
    expect(rule('.badge-failed')).toEqual({ background: '#3b0d0d', color: 'var(--red)' });
    expect(rule('.badge-error')).toEqual({ background: '#3b0d0d', color: 'var(--red)' });
    expect(rule('.badge-settled')).toEqual(rule('.badge-ready'));                               // the page's own green pill
  });

  test('the result box around the prescription has the info colors', () => {
    expect(APP).toContain('\'<div class="form-result info">\'');
    expect(rule('.form-result.info')).toEqual({ background: '#0d2040', border: '1px solid var(--blue)', color: 'var(--blue)' });
    expect(rule('.form-result.info')?.color).toBe(rule('.badge-info')?.color);
  });

  test('every status pill and result box the page sets has its own colors', () => {
    // the pills the page sets on a badge: whole ('badge badge-settled') or joined ('badge ' + (... ? 'badge-ready' : ...))
    const pills = ['ready', 'pending', 'settled', 'failed', 'error'];
    expect(pills.filter((c) => !new RegExp(`'badge(?: badge)?-${c}'`).test(APP))).toEqual([]);
    const results = [...new Set([...APP.matchAll(/form-result ([a-z]+)/g)].map((m) => m[1]))];
    const colored = (d: Record<string, string> | null) => !!(d && d.background && d.color);
    expect(pills.filter((c) => !colored(rule('.badge-' + c)))).toEqual([]);                      // before: settled, failed, error
    expect(results.filter((c) => !colored(rule('.form-result.' + c)))).toEqual([]);              // before: info
  });
});
