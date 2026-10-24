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
 * The operator console prices a fill the way the engine does (pricing review F10).
 *
 * What was wrong: the console's fill preview priced at AWP x quantity + $2.00, while the engine charges NADAC x
 * quantity plus the member's plan fee (ABACAVIR x30: the console showed $21.60 + $2.00 = $23.60, a fixture member was
 * charged $18.01 + $10.00 = $28.01), and the formulary and drug views showed AWP prices.
 *
 * Now the preview shows the NADAC ingredient with its unit, computed with the engine's exact rounding, and says the
 * dispensing fee is the member's plan fee, added at the fill; after the fill it shows the engine's own numbers. No
 * console view shows an AWP price.
 *
 * The console's modules are browser ES modules: nadac-price.js is loaded as source, and the pharmacy phase class is
 * loaded with its imports replaced by stubs, so nothing here needs a browser or a running engine.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const PHASES = ['pharmacy-phase.js', 'member-phase.js', 'prescriber-phase.js'].map((f) => `visualizer/src/js/interactive/${f}`);
const NADAC_JS = 'visualizer/src/js/interactive/nadac-price.js';

/** The console's NADAC helpers, from source (absent before the fix: then every helper is a function that throws). */
function consoleNadac(): Record<string, any> {
  const names = ['nadacUnitPriceE5', 'nadacIngredientCents', 'formatNadacE5', 'nadacPerUnitLabel', 'nadacIngredientPreview', 'engineFillPriceLine'];
  if (!fs.existsSync(NADAC_JS)) return Object.fromEntries(names.map((n) => [n, () => { throw new Error(`${NADAC_JS} is missing`); }]));
  const src = read(NADAC_JS);
  // every function the module exports, so the phases' imports from it can all be supplied
  const exported = [...src.matchAll(/^export\s+function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  const body = src.replace(/^export\s+/gm, '');
  return new Function(`'use strict';\n${body}\nreturn { ${[...new Set([...names, ...exported])].join(', ')} };`)();
}

/** The console's escaping (message-thread.js), from source: the phases escape what they place in the page (A-61). */
function messageThread(): Record<string, unknown> {
  const src = read('visualizer/src/js/interactive/message-thread.js');
  return new Function(`'use strict';\n${src.replace(/^export\s+/gm, '')}\nreturn { escapeHtml, renderMessageBubbles };`)();
}

const formatCents = (c: number) => '$' + (c / 100).toFixed(2);

/** The pharmacy phase class with its imports stubbed, and a page of element stubs it renders into. */
function pharmacyPhase(fetchStub: (url: string, init?: unknown) => Promise<unknown> = async () => { throw new Error('no network here'); }) {
  const els: Record<string, any> = {};
  const element = (id: string) => (els[id] = els[id] ?? {
    id, value: '', innerHTML: '', textContent: '', disabled: false, classList: { add() {}, remove() {} }, style: {},
    handlers: {} as Record<string, () => unknown>,
    addEventListener(type: string, fn: () => unknown) { this.handlers[type] = fn; },
    scrollIntoView() {},
  });
  const nadac = consoleNadac();
  const src = read('visualizer/src/js/interactive/pharmacy-phase.js')
    .replace(/import\s*\{[^}]*\}\s*from\s*'[^']+';/g, '')
    .replace(/^export\s+class\s+/m, 'class ');
  const scope: Record<string, unknown> = {
    API_BASE: '', formatCents, updateChainState: () => undefined,
    renderCredentialCard: () => '', renderForestCard: () => '', renderZkDataSection: () => '',
    checkInteractions: () => [], getDurStatus: () => ({}), renderDurBadge: () => '', renderInteractionAlerts: () => '',
    renderSectionCard: () => '', renderMetricRow: () => '', renderSortableTable: () => '', truncHash: (h: unknown) => String(h),
    loadInteractiveState: async () => ({}),
    ...nadac,
    ...messageThread(),
    document: { getElementById: element, querySelectorAll: () => [] },
    fetch: fetchStub, setTimeout: () => 0,
  };
  const PharmacyPhase = new Function(...Object.keys(scope), `'use strict';\n${src}\nreturn PharmacyPhase;`)(...Object.values(scope));
  const phase = new PharmacyPhase({ setStatus() {} });
  phase.renderStatusHistory = () => '';
  phase.renderPharmacyMessages = () => '';
  return { phase, element };
}

// ABACAVIR 300 MG TABLET as the console's state carries it (awpUnitPriceCents is still in the payload, display only)
const ABACAVIR = {
  index: 0, brandName: 'ABACAVIR', genericName: 'ABACAVIR', strength: '300 MG', dosageForm: 'TABLET', route: 'ORAL',
  ndc: '00378-4105-91', tier: 1, copayAmountCents: 1000, requiresPriorAuth: false, stepTherapyRequired: false,
  maxQuantityPerFill: 90, maxDaySupply: 90, awpUnitPriceCents: 72, nadacPerUnit: 0.60042, pricingUnit: 'EA',
  therapeuticClass: 'Antiviral', deaSchedule: 0, manufacturer: 'Mylan',
};
const RX = { id: 'RX-1', medicationIndex: 0, prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: 'W1', quantity: 30, quantityDispensed: 0, status: 'DISPENSED', refills: 0 };
const STATE = {
  demoData: {
    medications: [ABACAVIR],
    prescribers: [{ firstName: 'Avery', lastName: 'Quill', credential: 'MD' }],
    pharmacies: [{ storeName: 'Fernhill Pharmacy', pharmacyType: 'Retail', address: '1 Main St', city: 'Madison', state: 'WI' }],
    plan: { planId: 'PLAN-GOLD-2026', deductibleAmountCents: 50000, oopMaxCents: 800000, dispensingFeeCents: 1000 },
  },
  enrolledMembers: [{ walletId: 'W1', displayName: 'Member One', planId: 'PLAN-GOLD-2026', accumulator: { deductiblePaidCents: 0, oopPaidCents: 0 } }],
};

describe('the console computes NADAC x quantity exactly as the engine does', () => {
  let engine: { nadacUnitPriceE5: (n: unknown) => number; nadacIngredientCents: (e5: number, q: number) => number };
  let catalog: Array<{ ndc: string; nadacPerUnit: number; pricingUnit: string }>;
  beforeAll(async () => {
    process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
    engine = await import('../src/fulfillment/nadac-pricing.js') as any;
    catalog = (await import('../src/data/formulary-loader.js') as any).formularyRaw;
  });

  test('for every drug in the catalog and quantities whole and fractional, the cents agree', () => {
    const c = consoleNadac();
    expect(catalog.length).toBeGreaterThan(50);
    let compared = 0;
    for (const d of catalog) {
      for (const q of [1, 2, 7, 30, 90, 0.4, 2.5, 12.345, 1000]) {
        const want = engine.nadacIngredientCents(engine.nadacUnitPriceE5(d.nadacPerUnit), q);
        expect([d.ndc, q, c.nadacIngredientCents(d.nadacPerUnit, q)]).toEqual([d.ndc, q, want]);
        compared++;
      }
    }
    expect(compared).toBe(catalog.length * 9);
  });

  test('ABACAVIR x30 is $18.01 at $0.60042/EA; a drug without a NADAC price is not priced at $0', () => {
    const c = consoleNadac();
    expect(c.nadacIngredientCents(0.60042, 30)).toBe(1801);
    expect(c.nadacIngredientPreview(ABACAVIR, 30)).toEqual({ cents: 1801, text: 'NADAC $0.60042/EA x 30 EA = $18.01' });
    expect(c.nadacIngredientPreview({ ...ABACAVIR, nadacPerUnit: undefined }, 30).cents).toBeNull();
    expect(c.nadacIngredientPreview({ ...ABACAVIR, pricingUnit: '' }, 30).cents).toBeNull();
    expect(c.nadacIngredientPreview(ABACAVIR, 0).cents).toBeNull();
    expect(c.nadacPerUnitLabel(ABACAVIR)).toBe('$0.60042/EA');
  });
});

describe('the fill preview shows the NADAC ingredient and leaves the fee to the plan', () => {
  test('before the fill: NADAC x quantity with its unit, the fee named as the member\'s plan fee, no AWP and no $2.00', () => {
    const { phase } = pharmacyPhase();
    phase.selectedRxId = 'RX-1';
    const html: string = phase.renderFillDetails([RX], STATE);
    expect(html).toContain('NADAC $0.60042/EA x 30 EA = $18.01');
    expect(html).toContain('value="$18.01"');
    expect(html).toContain('Quantity to Dispense (EA)');
    expect(html).toMatch(/member's plan fee, added at the fill/);
    expect(html).not.toContain('$21.60');    // AWP x 30
    expect(html).not.toContain('$2.00');
    expect(html).not.toContain('$23.60');
    expect(html).not.toMatch(/AWP/i);
  });

  test('changing the quantity reprices the NADAC ingredient, with the engine\'s rounding', () => {
    const { phase, element } = pharmacyPhase();
    element('fill-quantity').value = '10';
    phase.bindFillDetailEvents(RX, ABACAVIR, STATE);
    element('fill-quantity').handlers.input();
    expect(element('fill-ingredient').value).toBe('$6.00');      // 0.60042 x 10 = 6.0042 -> 600 cents
    expect(element('fill-ingredient-basis').textContent).toBe('NADAC $0.60042/EA x 10 EA = $6.00');
    expect(element('fill-total').value).not.toBe('$9.20');        // the AWP preview's 7.20 + 2.00
  });

  test('after the fill: the engine\'s ingredient, fee and source, and total', () => {
    const { phase, element } = pharmacyPhase();
    const pricing = { basis: 'NADAC', ndc: '00378410591', nadacUnitPriceE5: 60042, pricingUnit: 'EA', dispensingFeeCents: 1250, dispensingFeeSource: 'plan', quantity: 30, ingredientCostCents: 1801, totalCostCents: 3051 };
    phase._renderFillResult({
      serviceDateStr: '20261019', rxStatus: 'DISPENSED', quantityDispensed: 30, quantityPrescribed: 30,
      adjudication: { phase: 'DEDUCTIBLE', patientPayCents: 3051, planPayCents: 0, totalCostCents: 3051, ingredientCostCents: 1801, dispensingFeeCents: 1250, pricing },
      accumulator: {
        before: { deductiblePaidCents: 0, oopPaidCents: 0 }, after: { deductiblePaidCents: 3051, oopPaidCents: 3051 },
        limits: { deductibleAmountCents: 50000, oopMaxCents: 780000, familyDeductibleAmountCents: 0, familyOopMaxCents: 0 },
      },
      // the engine's field name since the credential rename; the card read eligibilityNft and threw on every fill
      eligibilityCredential: { oldForestRoot: '1', newForestRoot: '2', changed: true },
      proofTimesMs: { proofGate: 1, prescriptionStatus: 1, accumulatorFulfillment: 1, total: 3 },
    }, RX);
    const html = String(element('fill-result').innerHTML);
    expect(html).toContain('Ingredient (NADAC)');
    expect(html).toContain('$18.01');
    expect(html).toContain('$12.50 (plan)');
    expect(html).toContain('NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $12.50 (plan) = $30.51');
    expect(html).toContain('accumulator updated in credential');
  });

  test('a reversal shows the engine\'s refund, read from the field names the engine sends', async () => {
    const reversal = {
      prescriptionId: 'RX-1', fillIndex: 0, medication: { brandName: 'ABACAVIR', strength: '300 MG' },
      refund: { patientRefundCents: 3051, planRefundCents: 0, totalRefundCents: 3051 },
      accumulator: { before: { deductiblePaidCents: 3051, oopPaidCents: 3051 }, after: { deductiblePaidCents: 0, oopPaidCents: 0 } },
      eligibilityCredential: { oldForestRoot: '2', newForestRoot: '3' },
      proofTimesMs: { accumulatorReversal: 1, total: 1 },
    };
    const { phase, element } = pharmacyPhase(async () => ({ ok: true, json: async () => reversal }));
    await phase.doReverseRx('RX-1', { disabled: false, textContent: '' }, STATE);
    const html = String(element('reversal-result').innerHTML);
    expect(html).toContain('Claim Reversed');
    expect(html).toContain('$30.51');
    expect(html).toContain('accumulator rolled back in credential');
    expect(html).not.toContain('Error:');
  });
});

describe('no console view shows an AWP price', () => {
  test.each(PHASES)('%s', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/awp/i);
    expect(src).not.toContain("'$2.00'");
    expect(src).not.toContain('value="$2.00"');
    expect(src).not.toMatch(/\+ 200\b/);
  });

  test('the formulary browser and the drug details show NADAC per unit', () => {
    const { phase } = pharmacyPhase();
    const html: string = phase.renderFormularyBrowser(STATE);
    expect(html).toContain('NADAC/Unit');
    expect(html).toContain('$0.60042/EA');
  });
});
