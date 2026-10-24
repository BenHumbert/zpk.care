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
 * The pharmacy's Payment Received says what it did: it recorded the payment at the counter.
 *
 * What was wrong: confirmPayment marks the script paid on the page, keeps the mark in sessionStorage so a refresh
 * shows it again, and sends nothing, but its toast said "Payment confirmed — claim lifecycle complete". The claim is
 * not complete then: the dispense left it on the network, waiting for the proof from the member's phone and then the
 * batch, and the card still offers Reverse. Found by the scene audit of the walkthrough, 2026-10-19: in the pay scene
 * that toast told the viewer the claim's lifecycle was complete just before the narration said the claim was parked
 * on the sequencer, waiting for one more proof from the member's phone.
 *
 * Now the toast says "Payment recorded". The card is as before: Paid in the Dispensed column, Reverse still offered.
 *
 * confirmPayment and the card markup are lifted out of app.js (one browser IIFE) and run in a vm with stubs for the
 * page.
 */
import fs from 'fs';
import vm from 'vm';

const NL = '\n';
const APP = fs.readFileSync('dashboard-pharmacy/app.js', 'utf8').replace(/\r\n/g, NL);

/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('app.js has no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}

/** A dispensed, proven script on the workstation; the lifted functions run in a strict vm whose globals are the page stubs. */
function counter() {
  const claim = { prescriptionId: 'RX-1', status: 'DISPENSED', medication: 'Metformin 500 mg', memberWalletId: '7001', prescriberWalletId: '5001', patientPayCents: '1801', planPayCents: '0' };
  const toasts: Array<[string, string]> = [];
  const stored: Record<string, string> = {};
  const fetch = jest.fn();
  const ctx: Record<string, any> = {
    scriptWorkflow: { 'RX-1': { proofStatus: 'complete' } },
    scriptKey: (c: { prescriptionId: string }) => c.prescriptionId,
    findClaimByKey: (k: string) => (k === claim.prescriptionId ? claim : undefined),
    getScriptIssue: () => null, isScriptVerified: () => false,
    truncate: String, formatDate: String, formatCents: String, escapeHtml: String,
    renderWorkstationColumns: () => {},
    toast: (m: string, t: string) => { toasts.push([m, t]); },
    sessionStorage: { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; } },
    API: {}, // no node routes: a call to one would throw
    fetch,
  };
  vm.createContext(ctx);
  vm.runInContext("'use strict';" + NL + ['getScriptStatus', 'fillPricingOf', 'renderColumn', 'confirmPayment'].map(lift).join(NL), ctx);
  const card = (): string => {
    const column = { innerHTML: '' };
    ctx.renderColumn(column, [claim], 'dispensed');
    return column.innerHTML;
  };
  return { ctx, toasts, stored, fetch, card };
}

describe('Payment Received records the payment at the counter and says only that', () => {
  test('the script is marked paid on this workstation, nothing is sent, and the toast does not call the claim complete', () => {
    const { ctx, toasts, stored, fetch } = counter();
    ctx.confirmPayment('RX-1');
    expect(ctx.scriptWorkflow['RX-1'].paymentReceived).toBe(true);
    expect(Object.keys(JSON.parse(stored.zkt_pharmacy_payments))).toEqual(['RX-1']); // a refresh shows it again
    expect(fetch).not.toHaveBeenCalled();
    expect(toasts).toEqual([['Payment recorded', 'success']]);                       // before: 'Payment confirmed — claim lifecycle complete'
    expect(toasts[0][0]).not.toMatch(/complete|lifecycle|settle/i);
  });

  test('the card then shows Paid in the Dispensed column and still offers Reverse', () => {
    const { ctx, card } = counter();
    expect(card()).toContain('data-act="confirmPayment" data-key="RX-1">Payment Received</button>');
    ctx.confirmPayment('RX-1');
    const paid = card();
    expect(paid).toContain('>Paid</span>');
    expect(paid).not.toContain('confirmPayment');
    expect(paid).toContain('data-act="reverseScript" data-key="RX-1"');
  });
});
