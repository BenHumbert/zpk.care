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
 * The operator console's fill and prescribe screens after the pricing fixes (review of those fixes, F8 and F10).
 *
 * What was wrong:
 *  F8.  The engine, the dashboards and the node routes take quantities in thousandths of the drug's pricing unit (a
 *       40 MG/0.4 ML pen is 0.4 ML), but the console still parsed whole units: its Fill button refused 0.4 ML with
 *       "Quantity must be at least 1." while its own preview priced it, sent 1.5 GM as 1 GM, subtracted remaining
 *       quantities in floating point (0.3 - 0.1 = 0.19999999999999998), and its prescribe form sent 0.4 as 0.
 *  F10. The fill screen showed the drug's catalog tier copay and the PLAN-GOLD-2026 template's deductible and
 *       out-of-pocket maximum for every member, also on the reversal card. A member on its own plan pays that plan's
 *       copay under its own limits.
 *
 * Now the console reads quantities to three decimals, never rounding, and computes what remains in exact thousandths,
 * with the unit beside each quantity; and it shows a member on its own plan the plan's copay and the member's own
 * limits, keeping the tier copay and the template for fixture members.
 *
 * The console's modules are browser ES modules: they are loaded as source with their imports replaced by stubs (as
 * in tests/console-nadac-preview.test.ts), so nothing here needs a browser or a running engine.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const NADAC_JS = 'visualizer/src/js/interactive/nadac-price.js';

/** Every function nadac-price.js exports, from source. */
function consoleHelpers(): Record<string, unknown> {
  const src = read(NADAC_JS);
  const names = [...src.matchAll(/^export\s+function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  return new Function(`'use strict';\n${src.replace(/^export\s+/gm, '')}\nreturn { ${names.join(', ')} };`)();
}

const formatCents = (c: number) => '$' + (c / 100).toFixed(2);

interface Page { element: (id: string) => any; alerts: string[]; sent: Array<{ url: string; body: any }> }

/** A console phase class loaded from source with its imports stubbed; fetch records what it is sent. */
function loadPhase(file: string, className: string, answer: (url: string) => unknown = () => ({ ok: false, status: 500, json: async () => ({ error: 'stopped by the test' }) })) {
  const els: Record<string, any> = {};
  const element = (id: string) => (els[id] = els[id] ?? {
    id, value: '', innerHTML: '', textContent: '', disabled: false, classList: { add() {}, remove() {} }, style: {},
    handlers: {} as Record<string, () => unknown>,
    addEventListener(type: string, fn: () => unknown) { this.handlers[type] = fn; },
    scrollIntoView() {},
  });
  const page: Page = { element, alerts: [], sent: [] };
  const src = read(file)
    .replace(/import\s*\{[^}]*\}\s*from\s*'[^']+';/g, '')
    .replace(/^export\s+class\s+/m, 'class ');
  const scope: Record<string, unknown> = {
    API_BASE: '', formatCents, updateChainState: () => undefined,
    renderCredentialCard: () => '', renderForestCard: () => '', renderZkDataSection: () => '',
    checkInteractions: () => [], getDurStatus: () => ({}), renderDurBadge: () => '', renderInteractionAlerts: () => '',
    renderSectionCard: () => '', renderMetricRow: () => '', renderSortableTable: () => '', truncHash: (h: unknown) => String(h),
    loadInteractiveState: async () => ({}),
    ...consoleHelpers(),
    document: { getElementById: element, querySelectorAll: () => [] },
    fetch: async (url: string, init?: { body?: string }) => {
      page.sent.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return answer(url);
    },
    alert: (m: string) => { page.alerts.push(m); },
    setTimeout: () => 0,
  };
  const Phase = new Function(...Object.keys(scope), `'use strict';\n${src}\nreturn ${className};`)(...Object.values(scope));
  const phase = new Phase({ setStatus() {} });
  return { phase, page };
}

// ADALIMUMAB-ADAZ(CF) PEN 40 MG/0.4 ML, priced per ML; ADVAIR HFA, priced per GM; ABACAVIR, per EA
const PEN = { index: 0, brandName: 'ADALIMUMAB-ADAZ(CF) PEN', genericName: 'ADALIMUMAB-ADAZ', strength: '40 MG/0.4 ML', dosageForm: 'PEN', route: 'SUBCUTANEOUS', ndc: '61314-0327-20', tier: 3, copayAmountCents: 7500, maxQuantityPerFill: 1, maxDaySupply: 28, nadacPerUnit: 1590.28426, pricingUnit: 'ML' };
const INHALER = { ...PEN, index: 1, brandName: 'ADVAIR HFA', strength: '115-21 MCG', dosageForm: 'INHALER', ndc: '00173-0716-20', tier: 2, copayAmountCents: 3500, maxQuantityPerFill: 36, nadacPerUnit: 18.75078, pricingUnit: 'GM' };
const ABACAVIR = { ...PEN, index: 2, brandName: 'ABACAVIR', strength: '300 MG', dosageForm: 'TABLET', ndc: '00378-4105-91', tier: 1, copayAmountCents: 1000, maxQuantityPerFill: 90, nadacPerUnit: 0.60042, pricingUnit: 'EA' };

const DEVICE_MEMBER = {
  walletId: 'W-DEVICE', displayName: 'Device Member', memberIndex: -1, planId: 'PLAN-E2E-SILVER',
  eligibility: { copayAmountCents: '1500', planIdHash: '1', groupIdHash: '2' },
  accumulator: { deductiblePaidCents: 5000, oopPaidCents: 5000, benefitUsedCents: 0, limits: { deductibleAmountCents: 25000, oopMaxCents: 780000, annualBenefitMaxCents: 0 } },
};
const FIXTURE_MEMBER = { walletId: 'W-FIXTURE', displayName: 'Fixture Member', memberIndex: 0, planId: 'PLAN-GOLD-2026', accumulator: { deductiblePaidCents: 0, oopPaidCents: 0 } };

const rx = (over: Record<string, unknown>) => ({ id: 'RX-1', medicationIndex: 0, prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: 'W-DEVICE', quantity: 0.4, quantityDispensed: 0, status: 'DISPENSED', refills: 0, ...over });
const stateWith = (prescriptions: unknown[], members: unknown[] = [DEVICE_MEMBER, FIXTURE_MEMBER]) => ({
  prescriptions,
  demoData: {
    medications: [PEN, INHALER, ABACAVIR],
    prescribers: [{ firstName: 'Avery', lastName: 'Quill', credential: 'MD' }],
    pharmacies: [{ storeName: 'Fernhill Pharmacy', pharmacyType: 'Retail', address: '1 Main St', city: 'Madison', state: 'WI' }],
    plan: { planId: 'PLAN-GOLD-2026', deductibleAmountCents: 50000, oopMaxCents: 800000, dispensingFeeCents: 1000 },
  },
  enrolledMembers: members,
});

function pharmacy() {
  const loaded = loadPhase('visualizer/src/js/interactive/pharmacy-phase.js', 'PharmacyPhase', () => ({ ok: true, status: 202, json: async () => ({ status: 'pending' }) }));
  loaded.phase.renderStatusHistory = () => '';
  loaded.phase.renderPharmacyMessages = () => '';
  // the fill is accepted; the polling and the result card are not what these tests look at
  loaded.phase._pollFillStatus = async () => ({});
  loaded.phase._renderFillResult = () => undefined;
  return loaded;
}

describe('F8: the console fills in thousandths of the pricing unit', () => {
  test('a 0.4 ML pen is filled as 0.4 ML, not refused as less than one unit', async () => {
    const { phase, page } = pharmacy();
    page.element('fill-quantity').value = '0.4';
    await phase.doFill(rx({}), PEN);
    expect(page.alerts).toEqual([]);                                  // before: "Quantity must be at least 1."
    expect(page.sent).toEqual([{ url: '/interactive/fill', body: { prescriptionId: 'RX-1', quantityDispensed: 0.4 } }]);
  });

  test('1.5 GM is sent as 1.5 GM, not cut to 1 GM', async () => {
    const { phase, page } = pharmacy();
    page.element('fill-quantity').value = '1.5';
    await phase.doFill(rx({ medicationIndex: 1, quantity: 12 }), INHALER);
    expect(page.sent.map((s) => s.body.quantityDispensed)).toEqual([1.5]);  // before: 1
  });

  test('what remains is exact: 0.2 GM of 0.3 GM fills, 0.21 GM and a fourth decimal are refused before anything is sent', async () => {
    const partial = rx({ medicationIndex: 1, quantity: 0.3, quantityDispensed: 0.1, status: 'PARTIALLY_FILLED' });
    const ok = pharmacy();
    ok.page.element('fill-quantity').value = '0.2';
    await ok.phase.doFill(partial, INHALER);
    expect(ok.page.alerts).toEqual([]);                               // before: refused (parseInt gave 0)
    expect(ok.page.sent.map((s) => s.body.quantityDispensed)).toEqual([0.2]);
    const over = pharmacy();
    over.page.element('fill-quantity').value = '0.21';
    await over.phase.doFill(partial, INHALER);
    expect(over.page.alerts).toEqual(['Quantity dispensed (0.21 GM) exceeds remaining qty (0.2 GM). Fill rejected.']);
    expect(over.page.sent).toEqual([]);
    const tooFine = pharmacy();
    tooFine.page.element('fill-quantity').value = '0.0005';
    await tooFine.phase.doFill(partial, INHALER);
    expect(tooFine.page.alerts).toHaveLength(1);
    expect(tooFine.page.alerts[0]).toMatch(/greater than 0, in GM, with at most three decimals/);
    expect(tooFine.page.sent).toEqual([]);
  });

  test('the fill screen offers the fractional remainder it prices, with its unit, and no floating-point remainder', () => {
    const { phase } = pharmacy();
    phase.selectedRxId = 'RX-1';
    const pen = phase.renderFillDetails([rx({})], stateWith([rx({})]));
    expect(pen).toContain('id="fill-quantity" value="0.4" min="0.001" step="0.001"');   // before: min="1"
    expect(pen).toContain('NADAC $1590.28426/ML x 0.4 ML = $636.11');
    expect(pen).toContain('0.4 ML');
    const partial = rx({ medicationIndex: 1, quantity: 0.3, quantityDispensed: 0.1, status: 'PARTIALLY_FILLED' });
    const inhaler = phase.renderFillDetails([partial], stateWith([partial]));
    expect(inhaler).toContain('0.2 GM');
    expect(inhaler).not.toContain('0.19999999999999998');            // before: the float remainder
  });

  test('typing a fractional quantity reprices the preview instead of reading it as 0', () => {
    const { phase, page } = pharmacy();
    page.element('fill-quantity').value = '0.4';
    phase.bindFillDetailEvents(rx({}), PEN, stateWith([rx({})]));
    page.element('fill-quantity').handlers.input();
    expect(page.element('fill-ingredient').value).toBe('$636.11');   // before: 'Not priced' (parseInt gave 0)
    expect(page.element('fill-ingredient-basis').textContent).toBe('NADAC $1590.28426/ML x 0.4 ML = $636.11');
  });

  test('the console\'s prescribe form sends 0.4 as 0.4 and names the unit', async () => {
    const { phase, page } = loadPhase('visualizer/src/js/interactive/prescriber-phase.js', 'PrescriberPhase');
    phase.selectedPrescriber = 0;
    phase.selectedPharmacy = 0;
    phase.selectedMedication = 0;
    page.element('patient-select').value = 'W-DEVICE';
    page.element('rx-quantity').value = '0.4';
    page.element('rx-refills').value = '0';
    await phase.doWriteRx();
    expect(page.alerts).toEqual([]);
    expect(page.sent.map((s) => s.body.quantity)).toEqual([0.4]);    // before: 0
    const src = read('visualizer/src/js/interactive/prescriber-phase.js');
    expect(src).toContain('<input type="number" id="rx-quantity" value="30" min="0.001" step="0.001" />');
    expect(src).toContain('id="rx-quantity-unit"');
  });
});

describe('F10: the fill and reversal screens show the member\'s own plan terms', () => {
  test('a member on its own plan sees its plan\'s copay and its own deductible and out-of-pocket maximum', () => {
    const { phase } = pharmacy();
    phase.selectedRxId = 'RX-1';
    const html = phase.renderFillDetails([rx({ medicationIndex: 2, quantity: 30 })], stateWith([]));
    expect(html).toContain('Plan copay</div><div class="value">$15.00');   // before: Copay $10.00, the tier copay
    expect(html).toContain('$50.00 / $250.00');                             // before: / $500.00, the template's
    expect(html).toContain('$50.00 / $7800.00');                            // before: / $8000.00
    expect(html).not.toContain('$8000.00');
  });

  test('a fixture member keeps the catalog tier copay and the console\'s template limits', () => {
    const { phase } = pharmacy();
    phase.selectedRxId = 'RX-1';
    const html = phase.renderFillDetails([rx({ medicationIndex: 2, quantity: 30, memberWalletId: 'W-FIXTURE' })], stateWith([]));
    expect(html).toContain('Tier copay</div><div class="value">$10.00');
    expect(html).toContain('$0.00 / $500.00');
    expect(html).toContain('$0.00 / $8000.00');
  });

  test('the reversal card measures the rolled-back accumulator against the member\'s own limits', async () => {
    const reversal = {
      prescriptionId: 'RX-1', fillIndex: 0, medication: { brandName: 'ABACAVIR', strength: '300 MG' },
      refund: { patientRefundCents: 3051, planRefundCents: 0, totalRefundCents: 3051 },
      accumulator: { before: { deductiblePaidCents: 8051, oopPaidCents: 8051 }, after: { deductiblePaidCents: 5000, oopPaidCents: 5000 } },
      eligibilityCredential: { oldForestRoot: '2', newForestRoot: '3' },
      proofTimesMs: { accumulatorReversal: 1, total: 1 },
    };
    const { phase, page } = loadPhase('visualizer/src/js/interactive/pharmacy-phase.js', 'PharmacyPhase', () => ({ ok: true, json: async () => reversal }));
    const filled = rx({ medicationIndex: 2, quantity: 30, status: 'FILLED' });
    await phase.doReverseRx('RX-1', { disabled: false, textContent: '' }, stateWith([filled]));
    const html = String(page.element('reversal-result').innerHTML);
    expect(html).toContain('$80.51 → $50.00');                        // the deductible rolled back
    expect(html).toContain('/ $250.00');                                    // before: / $500.00
    expect(html).toContain('/ $7800.00');                                   // before: / $8000.00
    expect(html).not.toContain('Error:');
  });
});
