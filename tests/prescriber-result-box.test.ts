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
 * The prescriber's eScript result box gives one proving time, and one name for each proof.
 *
 * What was wrong: once the prescribe proofs were made, the box printed "Proved in 35.1s" over "proofGate: 6.38s |
 * eligibility: 8.87s | accessControl: 8.70s | messaging: 8.45s | total: 32.39s". That is two totals that disagree: the
 * first was the job's age when the 5 s poll found it done, the second the engine's sum of the proof times. And the
 * timings named the proofs by the engine's keys, so the proof the sentence below calls FormularyAccess was
 * "accessControl" there. The box breaks lines anywhere, for its hashes, and so broke that sentence mid-word. Found by
 * the QA of the walkthrough's first voiced take, 2026-10-23: the prescribe scene showed both totals, "accessControl"
 * above "FormularyAccess", and "so no one outside t" / "he engine verifies them yet."
 *
 * Now the box says "Proved in" once, with the sum of the proof times the engine measured, then each proof by the name
 * the sentence uses, both from one table (PRESCRIBE_PROOF_NAMES); the poll's elapsed time stands in only when the
 * engine sent no times. The detail lines wrap between words.
 *
 * writeRx and the status poll are lifted out of app.js and run against a stand-in node that answers at once.
 */
import fs from 'fs';

const NL = '\n';
const APP = fs.readFileSync('dashboard-prescriber/app.js', 'utf8').replace(/\r\n/g, NL);

const has = (name: string): boolean => APP.includes(NL + '  function ' + name + '(') || APP.includes(NL + '  async function ' + name + '(');
/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
/** A top-level one-line `var NAME = ...;` of the page, or nothing when the page has none. */
function liftVarLine(name: string): string {
  const at = APP.indexOf(NL + '  var ' + name + ' = ');
  return at < 0 ? '' : APP.slice(at + 1, APP.indexOf(NL, at + 1));
}
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (html: string): string => html.replace(/<\/div>/g, '\n').replace(/<[^>]*>/g, '').trim();

// createPrescription's proof times for the walkthrough's prescription, in ms as performance.now() measured them
const TIMES = { proofGate: 6381.4, eligibility: 8868.7, accessControl: 8695.2, messaging: 8446.0, total: 32391.3 };

/** The page after Send Prescription: writeRx's result box, then the status poll's answer drawn into it. */
async function sent(answer: Record<string, unknown>) {
  const els: Record<string, any> = {};
  const field = (id: string, value = '') => (els[id] = els[id] ?? { id, value, textContent: '', className: '', innerHTML: '', disabled: false, selectedOptions: [{ dataset: { name: 'ALLOPURINOL' } }] });
  Object.entries({ 'rx-patient-select': '105793011474027089991654625', 'rx-pharmacy-select': '955866566332813', 'rx-med-select': '1111', 'rx-quantity': '30', 'rx-days-supply': '30', 'rx-refills': '0' })
    .forEach(([id, v]) => field(id, v));
  let box = '';
  const scope: Record<string, unknown> = {
    $: (sel: string) => field(sel.replace(/^#/, '')),
    document: { getElementById: (id: string) => els[id] ?? null },
    esc: escHtml, toast: () => undefined, loadPrescriptionHistory: () => undefined,
    setTimeout: (fn: () => void) => { fn(); return 0; },
    API: { prescribeWithProof: async () => ({ rxId: 'RX-1792809653151-ojmx', jobKey: 'rx-job-1' }), prescribeStatus: async () => answer },
    /** writeRx's result box; its detail line becomes the element the poll writes to. */
    setHTML: (_sel: string, html: string) => { box = html; field('rx-proof-badge'); field('rx-proof-detail'); },
  };
  const pieces = [liftVarLine('QUANTITY_RULE'), liftVarLine('PRESCRIBE_PROOF_NAMES'),
    ...['parseQuantity', 'prescribeProofTimes', 'prescribeProofSummary', 'pollPrescribeStatus', 'writeRx'].filter(has).map(lift)];
  const names = Object.keys(scope);
  const writeRx = new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn writeRx;`)(...names.map((n) => scope[n]));
  await writeRx();
  await flush();
  return { box, detail: String(els['rx-proof-detail'].innerHTML), badge: els['rx-proof-badge'].textContent };
}

describe('the result box after the prescribe proofs finish', () => {
  test('gives one total, the sum of the proof times, and each proof by the name the sentence uses', async () => {
    const { detail, badge } = await sent({ status: 'complete', rxId: 'RX-1792809653151-ojmx', result: { proofTimesMs: TIMES }, elapsedMs: 35100 });
    expect(badge).toBe('ZK Proofs: Generated');
    const lines = text(detail).split(NL);
    expect(lines[0]).toBe('Proved in 32.39s');                                 // before: Proved in 35.1s
    expect(lines[1]).toBe('ProofGate.verifyPrescriber: 6.38s | Eligibility: 8.87s | FormularyAccess: 8.70s | Messaging (eScript): 8.45s');
    expect(text(detail).match(/Proved in|total/g)).toEqual(['Proved in']);     // before: Proved in, and total: 32.39s
    expect(detail).not.toContain('accessControl');                            // before: accessControl: 8.70s
    // every name in the timings is the one the sentence below gives
    for (const name of lines[1].split(' | ').map((t) => t.split(': ')[0])) expect(lines[2]).toContain(name);
    expect(lines[2]).toBe('4 ZK proofs generated by the engine: ProofGate.verifyPrescriber + Eligibility + FormularyAccess + Messaging (eScript). Not kept and not sent to the ledger, so no one outside the engine verifies them yet.');
  });

  test('with a prior authorization, its proof is named and counted in the total', async () => {
    const { detail } = await sent({ status: 'complete', result: { proofTimesMs: { proofGate: 6000, eligibility: 8000, accessControl: 8000, priorAuth: 5000, messaging: 8000, total: 35000 } }, elapsedMs: 41000 });
    expect(text(detail).split(NL).slice(0, 2)).toEqual(['Proved in 35.00s', 'ProofGate.verifyPrescriber: 6.00s | Eligibility: 8.00s | FormularyAccess: 8.00s | PriorAuth: 5.00s | Messaging (eScript): 8.00s']);
  });

  test('when the engine sends no times, the poll\'s elapsed time is the one total', async () => {
    const { detail } = await sent({ status: 'complete', result: {}, elapsedMs: 35100 });
    expect(text(detail).split(NL)).toEqual(['Proved in 35.10s', 'ZK proofs generated by the engine. Not kept and not sent to the ledger, so no one outside the engine verifies them yet.']);
  });

  test('the detail lines wrap between words, though the box around them breaks anywhere for its hashes', async () => {
    const { box } = await sent({ status: 'complete', result: { proofTimesMs: TIMES }, elapsedMs: 35100 });
    expect(box).toContain('<div class="form-result info">');
    expect(box).toMatch(/<div id="rx-proof-detail" style="[^"]*word-break:normal;overflow-wrap:anywhere"><\/div>/);   // before: break-all, from .form-result
  });
});
