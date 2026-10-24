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
 * The pharmacy workstation's verify line counts the member's scripts that are still waiting to be dispensed.
 *
 * What was wrong: Verify Member wrote its status line once, ending with the count of the member's filled scripts at
 * that moment ("— 1 script(s) ready for dispensing"), and nothing wrote it again. After the script was dispensed, and
 * after every refresh, the line still said a script was ready while the Filled column was empty; a switch to another
 * pharmacy, which clears the verified member, left it up too. Found by the QA of the walkthrough's first voiced take,
 * 2026-10-23: after the dispense the line read "Verified: 105793011474027089991… [Attestation: Ed25519 signature valid]
 * — 1 script(s) ready for dispensing" above an empty Filled column, the script in Dispensed.
 *
 * Now the line keeps what the verification said and ends it with a count drawn with the columns (showVerifiedCount): a
 * script dispensed, or moved on by a refresh, leaves the count as it leaves the Filled column, and the line goes once
 * the pharmacy it was verified at is no longer the one selected.
 *
 * Verify Member, the dispense and its proof poll, and the column drawing are lifted out of app.js and run against a
 * stand-in node that answers at once, with each column's cards stubbed.
 */
import fs from 'fs';

const NL = '\n';
const APP = fs.readFileSync('dashboard-pharmacy/app.js', 'utf8').replace(/\r\n/g, NL);

const has = (name: string): boolean => APP.includes(NL + '  function ' + name + '(') || APP.includes(NL + '  async function ' + name + '(');
/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('app.js has no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MEMBER = '105793011474027089991654625';
const KETTLEBY = { npi: '2999000518', name: 'Kettleby Pharmacy' };
const WEXLEY = { npi: '2999000526', name: 'Wexley Road Pharmacy' };
// The member's attestation as the tap gives it (the node checks its signature; the stand-in node says it did)
const ATTESTATION = JSON.stringify({ type: 'credential-attestation', walletId: MEMBER, attestation: { v: 2, t: 'credential-attestation', w: MEMBER, sig: 'ab' } });
const VERIFIED = 'Verified: ' + MEMBER.slice(0, 20) + '… [Attestation: Ed25519 signature valid]';

interface Script { leafIndex: number; prescriptionId: string; status: string; brandName: string; memberWalletId: string; quantity: number; dateOfService: string }
/** A script in this pharmacy's queue, as /prescriptions/list passes it on. */
const rx = (leafIndex: number, status = 'FILLED', memberWalletId = MEMBER): Script => ({
  leafIndex, prescriptionId: 'RX-' + leafIndex, status, brandName: 'ALLOPURINOL (Generic)', memberWalletId, quantity: 30, dateOfService: '2026-10-24',
});

function workstation(scripts: Script[], { fill = 'complete' }: { fill?: 'complete' | 'pending' } = {}) {
  const classes = new Set(['ws-verify-status', 'hidden']);
  const status = {
    textContent: '',
    classList: { add: (...c: string[]) => c.forEach((x) => classes.add(x)), remove: (...c: string[]) => c.forEach((x) => classes.delete(x)) },
  };
  const columns: Record<string, string[]> = {};
  let pharmacy = KETTLEBY;
  let scan: () => Promise<unknown> = async () => ({ attestationVerified: true, attestationExpired: false, walletId: MEMBER });
  const scope: Record<string, unknown> = {
    $: (sel: string) => (sel === '#ws-verify-status' ? status : sel === '#ws-verify-wallet' ? { value: '' } : null),
    getSelectedPharmacy: () => pharmacy,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
    escapeHtml: escHtml,
    API: {
      nfc: { scan: () => scan() },
      dispensing: {
        dispense: async () => ({ jobKey: 'fill-1' }),
        fillStatus: async () => (fill === 'pending' ? { status: 'pending' }
          : { status: 'complete', result: { prescriptionId: 'RX-7', adjudication: { patientPayCents: 1418, planPayCents: 0, phase: 'deductible' } } }),
      },
    },
    setTimeout: (fn: () => void) => { if (fill !== 'pending') fn(); return 0; },   // the proof poll asks at once; a pending proof is left running
    toast: () => undefined, console: { warn: () => undefined }, setText: () => undefined, loadWorkstation: () => undefined,
    getScriptIssue: () => null,
    /** Each column's cards, by prescription. */
    renderColumn: (sel: string, claims: Script[]) => { columns[sel] = claims.map((c) => c.prescriptionId); },
  };
  const body = [
    'let allClaims = claims;', 'let scriptWorkflow = {};', 'let verifiedMemberWallets = {};', 'let verifyLine = null;',
    ...['getVerifiedMemberWallet', 'setVerifiedMemberWallet', 'truncate', 'scriptKey', 'getScriptStatus', 'setScriptStatus', 'findClaimByKey',
      'isScriptVerified', 'verifyScriptsForMember', 'showVerifiedCount', 'verifyMember', 'renderWorkstationColumns', 'dispenseScript',
      'pollDispenseStatus'].filter(has).map(lift),        // showVerifiedCount is absent from the page before the fix
  ].join(NL);
  const names = Object.keys(scope);
  const page = new Function(...names, 'claims', `'use strict';\n${body}\nreturn { verifyMember, dispenseScript, renderWorkstationColumns, scriptKey, refresh: (c) => { allClaims = c; renderWorkstationColumns(); } };`)(
    ...names.map((n) => scope[n]), scripts) as {
      verifyMember: (credential: string) => Promise<void>; dispenseScript: (key: string) => Promise<void>; renderWorkstationColumns: () => void;
      scriptKey: (s: Script) => string; refresh: (c: Script[]) => void;
    };
  return {
    columns,
    /** The verify line as shown; '' while it is hidden. */
    line: () => (classes.has('hidden') ? '' : status.textContent),
    classes: () => [...classes],
    verify: async () => { await page.verifyMember(ATTESTATION); await flush(); },
    /** Dispense on the card of this script, and let the stand-in node answer the dispense and its proof. */
    dispense: async (s: Script) => { await page.dispenseScript(page.scriptKey(s)); await flush(); },
    /** The next refresh from the node: this pharmacy's queue, drawn again. */
    refresh: (queue: Script[]) => page.refresh(queue),
    redraw: () => page.renderWorkstationColumns(),
    selectPharmacy: (p: typeof KETTLEBY) => { pharmacy = p; },
    scanAnswers: (fn: () => Promise<unknown>) => { scan = fn; },
  };
}

describe('the verify line counts the member\'s scripts still waiting to be dispensed', () => {
  test('after the dispense it says none is waiting, as the Filled column does', async () => {
    const w = workstation([rx(7)]);
    await w.verify();
    expect(w.line()).toBe(VERIFIED + ' — 1 script(s) ready for dispensing');
    expect(w.classes()).toContain('verified');
    await w.dispense(rx(7));
    expect([w.columns['#ws-filled-list'], w.columns['#ws-dispensed-list']]).toEqual([[], ['RX-7']]);
    expect(w.line()).toBe(VERIFIED + ' — no filled scripts awaiting pickup');   // before: — 1 script(s) ready for dispensing
    expect(w.classes()).toContain('verified');
  });

  test('while her script is being dispensed it stays in the Filled column, and the line says it is being dispensed', async () => {
    const w = workstation([rx(7)], { fill: 'pending' });
    await w.verify();
    await w.dispense(rx(7));                                                   // the fill proof is still running
    expect(w.columns['#ws-filled-list']).toEqual(['RX-7']);
    expect(w.line()).toBe(VERIFIED + ' — 1 script(s) being dispensed');      // before: — no filled scripts awaiting pickup
  });

  test('with two of her scripts filled, one dispensed leaves one ready', async () => {
    const w = workstation([rx(7), rx(8)]);
    await w.verify();
    expect(w.line()).toBe(VERIFIED + ' — 2 script(s) ready for dispensing');
    await w.dispense(rx(7));
    expect(w.line()).toBe(VERIFIED + ' — 1 script(s) ready for dispensing');   // before: — 2 script(s) ready for dispensing
  });

  test('a refresh that brings her script back dispensed counts it out; another member\'s filled script never counts', async () => {
    const w = workstation([rx(7), rx(9, 'FILLED', '7001')]);
    await w.verify();
    expect(w.line()).toBe(VERIFIED + ' — 1 script(s) ready for dispensing');
    w.refresh([rx(7, 'DISPENSED'), rx(9, 'FILLED', '7001')]);
    expect(w.line()).toBe(VERIFIED + ' — no filled scripts awaiting pickup');   // before: — 1 script(s) ready for dispensing
  });

  test('once another pharmacy is selected, the line of the first one goes', async () => {
    const w = workstation([rx(7)]);
    await w.verify();
    w.selectPharmacy(WEXLEY);                                           // switchPharmacy clears the verified member
    w.refresh([]);
    expect(w.line()).toBe('');                                          // before: the first pharmacy's line stayed up
  });

  test('while a verification is out, a redraw of the columns leaves "Verifying..." on the line', async () => {
    const w = workstation([rx(7)]);
    await w.verify();
    let answer: (v: unknown) => void = () => undefined;
    w.scanAnswers(() => new Promise((r) => { answer = r; }));
    const second = w.verify();
    w.redraw();                                                         // the 10 s refresh
    expect(w.line()).toBe('Verifying...');
    answer({ attestationVerified: true, attestationExpired: false, walletId: MEMBER });
    await second;
    expect(w.line()).toBe(VERIFIED + ' — 1 script(s) ready for dispensing');
  });

  test('a failed verification\'s error stays on the line through a redraw', async () => {
    const w = workstation([rx(7)]);
    await w.verify();
    w.scanAnswers(async () => ({ attestationVerified: false }));
    await w.verify();
    w.redraw();
    expect(w.line()).toBe('Verification failed: Attestation signature NOT verified — member identity not confirmed');
    expect(w.classes()).toContain('error');
  });
});
