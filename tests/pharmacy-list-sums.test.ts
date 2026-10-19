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
 * The pharmacy's prescription list: every amount on a prescription is a sum over its standing fills.
 *
 * What was wrong: getPrescriptionsByPharmacy summed patient pay and plan pay over the active fills but took the
 * ingredient cost, the dispensing fee and the pricing from the last fill only, so on a prescription filled more than
 * once the card's drug cost disagreed with patient + plan. The run.ts plan in the copay phase, 30 ABACAVIR dispensed
 * as 10 and then 20: patient $30.00 and plan $13.01 (sums) beside a drug cost of $24.51 (the last fill).
 *
 * Now the ingredient cost and the fee are sums too, so patient + plan = ingredient + fee on the card; the one standing
 * fill's NADAC breakdown is kept, and with several fills each fill's own amounts and pricing are in fills[], which the
 * dashboard's detail lists. The dashboard no longer lays one ledger claim over the engine's sums.
 *
 * Fast: the real method on a bare engine object, and the dashboard's own functions lifted out of app.js.
 */
import fs from 'fs';
import vm from 'vm';
import { Field } from 'o1js';
import { AdjudicationService } from '../src/adjudication/interactive-service.js';

const pricingOf = (quantity: number, ingredient: number) => ({
  basis: 'NADAC', ndc: '00378410591', nadacUnitPriceE5: 60042, pricingUnit: 'EA', dispensingFeeCents: 1250, dispensingFeeSource: 'plan',
  quantity, ingredientCostCents: ingredient, totalCostCents: ingredient + 1250,
});
const fill = (quantity: number, ingredient: number, patient: number, reversed = false) => ({
  patientPayCents: patient, planPayCents: ingredient + 1250 - patient, totalCostCents: ingredient + 1250,
  deductibleCreditField: Field(0), accumulatorBefore: { deductiblePaid: 50000, oopPaid: 0, benefitUsed: 0 },
  fulfillmentData: { ingredientCostCents: Field(ingredient), dispensingFeeCents: Field(1250) },
  pricing: pricingOf(quantity, ingredient), reversed, quantityDispensed: quantity, dateOfService: '20261019',
});

function row(fills: unknown[]): any {
  const svc: any = Object.create(AdjudicationService.prototype);
  Object.assign(svc, {
    pendingPrescriptions: new Map(),
    prescriptions: new Map([['RX-1', {
      status: 'DISPENSED', pharmacyIndex: 0, prescriberIndex: 0, ndcHash: 'ndc', memberWalletId: '123',
      quantity: 30, quantityDispensed: 30, refills: 0, refillsUsed: 0, statusHistory: [],
      formularyEntry: { copayAmountCents: Field(1500) },
    }]]),
    fulfillments: new Map([['RX-1', fills]]),
    pharmacyWalletIds: new Map([[0, Field(55)]]),
    prescriberWalletIds: new Map([[0, Field(66)]]),
    getMedicationByNdcHash: () => ({ brandName: 'ABACAVIR', genericName: 'ABACAVIR', strength: '300 MG', ndcFormatted: '00378-4105-91', pricingUnit: 'EA', formularyEntry: { tierLevel: 1, copayAmount: 1000 } }),
  });
  return svc.getPrescriptionsByPharmacy(0)[0];
}

describe('the engine\'s list', () => {
  // 30 ABACAVIR dispensed as 10 and then 20, copay phase: 600 + 1250 and 1201 + 1250, the member paying the $15 copay each time
  const twoFills = [fill(10, 600, 1500), fill(20, 1201, 1500)];

  test('sums every amount over the standing fills, so patient + plan = ingredient + fee', () => {
    const r = row(twoFills);
    expect([r.ingredientCostCents, r.dispensingFeeCents, r.patientPayCents, r.planPayCents]).toEqual([1801, 2500, 3000, 1301]);
    expect(r.patientPayCents + r.planPayCents).toBe(r.ingredientCostCents + r.dispensingFeeCents);
    expect(r.pricing).toBeNull();   // a sum has no single NADAC unit price
    expect(r.pricingUnit).toBe('EA');
  });

  test('keeps each fill\'s own amounts and pricing in fills[]', () => {
    const r = row(twoFills);
    expect(r.fills.map((f: any) => [f.quantityDispensed, f.ingredientCostCents, f.dispensingFeeCents, f.patientPayCents, f.planPayCents]))
      .toEqual([[10, 600, 1250, 1500, 350], [20, 1201, 1250, 1500, 951]]);
    expect(r.fills[1].pricing).toEqual(pricingOf(20, 1201));
  });

  test('a reversed fill is left out of the sums; one standing fill keeps its NADAC breakdown', () => {
    const r = row([fill(10, 600, 1500, true), fill(20, 1201, 1500)]);
    expect([r.ingredientCostCents, r.dispensingFeeCents, r.patientPayCents, r.planPayCents]).toEqual([1201, 1250, 1500, 951]);
    expect(r.pricing).toEqual(pricingOf(20, 1201));
  });

  test('a fill the member paid nothing for reads $0, not missing', () => {
    const r = row([fill(30, 1801, 0)]);
    expect([r.patientPayCents, r.planPayCents]).toEqual([0, 3051]);
  });
});

describe('the pharmacy dashboard', () => {
  const NL = String.fromCharCode(10);
  const app = fs.readFileSync('dashboard-pharmacy/app.js', 'utf8').split(String.fromCharCode(13) + NL).join(NL);
  function lift(name: string): string {
    let at = app.indexOf(NL + '  function ' + name + '(');
    if (at < 0) at = app.indexOf(NL + '  async function ' + name + '(');
    if (at < 0) throw new Error('app.js has no function ' + name);
    return app.slice(at + 1, app.indexOf(NL + '  }' + NL, at) + 4);
  }
  const cents = (c: unknown) => '$' + (Number(c) / 100).toFixed(2);
  function page(names: string[], stubs: Record<string, unknown> = {}) {
    const ctx: Record<string, any> = { scriptWorkflow: {}, formatCents: cents, ...stubs };
    vm.createContext(ctx);
    vm.runInContext(names.map(lift).join(NL), ctx);
    return ctx;
  }
  const engineRow = { ...row([fill(10, 600, 1500), fill(20, 1201, 1500)]), metadata: { ingredientCostCents: 1201, dispensingFeeCents: 1250, nadacUnitPriceE5: 60042, pricingUnit: 'EA', quantityDispensed: 20 } };

  test('the card\'s drug cost is the engine\'s sums, whatever ledger claim was merged beside them', () => {
    const p = page(['fillPricingOf', 'formatNadacUnit', 'nadacBreakdown']);
    const pricing = p.fillPricingOf(engineRow, {});
    expect(pricing.totalCostCents).toBe(engineRow.patientPayCents + engineRow.planPayCents);
    expect(p.nadacBreakdown(pricing)).toBe('Ingredient $18.01 (2 fills, 30 EA) + dispensing fees $25.00 = $43.01');
  });

  test('a fill just dispensed shows its own NADAC breakdown, with the unit after the quantity', () => {
    const p = page(['fillPricingOf', 'formatNadacUnit', 'nadacBreakdown']);
    expect(p.nadacBreakdown(p.fillPricingOf(engineRow, { pricing: pricingOf(20, 1201) }))).toBe('NADAC $0.60042/EA x 20 EA = $12.01 + dispensing fee $12.50 = $24.51');
  });

  test('the merge of ledger claims fills only what the engine\'s list leaves empty', () => {
    for (const field of ['patientPayCents', 'planPayCents', 'deductibleCreditCents', 'ingredientCostCents', 'dispensingFeeCents']) {
      expect(app).toContain(`if (acc.${field} != null && rx.${field} == null) rx.${field} = acc.${field};`);
    }
  });
});
