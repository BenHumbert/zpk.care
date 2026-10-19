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
 * The pharmacy queue's adjudication phase comes from the claim's own numbers (screen audit, pharmacy item 4), and the
 * queue carries the fill's NADAC pricing.
 *
 * getPrescriptionsByPharmacy called a fill DEDUCTIBLE whenever the member had paid under a fixed $500 before it. Since
 * A-35 the limits are the member's own, so that constant was wrong both ways. Now a fill that credited the deductible
 * is DEDUCTIBLE, and one that credited nothing is NORMAL_COPAY. With NADAC pricing the queue also carries the latest
 * fill's ingredient cost, fee and pricing, so the pharmacy screen shows NADAC x quantity + fee after a reload, and the
 * copay of the entry proven at prescribing (the member's plan copay).
 *
 * Fast: the real method on a bare engine object. No compile, no proof.
 */
import { Field } from 'o1js';
import { AdjudicationService } from '../src/adjudication/interactive-service.js';

const PRICING = {
  basis: 'NADAC', ndc: '00378410591', nadacUnitPriceE5: 60042, pricingUnit: 'EA', dispensingFeeCents: 1250, dispensingFeeSource: 'plan',
  quantity: 30, ingredientCostCents: 1801, totalCostCents: 3051,
};

function queueRow(fill: { deductibleCreditCents: number; deductiblePaidBefore: number; patientPayCents: number; totalCostCents: number } | null): any {
  const fulfillments = new Map<string, unknown[]>();
  if (fill) {
    fulfillments.set('RX-1', [{
      patientPayCents: fill.patientPayCents, planPayCents: fill.totalCostCents - fill.patientPayCents, totalCostCents: fill.totalCostCents,
      deductibleCreditField: Field(fill.deductibleCreditCents),
      accumulatorBefore: { deductiblePaid: fill.deductiblePaidBefore, oopPaid: 0, benefitUsed: 0 },
      fulfillmentData: { ingredientCostCents: Field(1801), dispensingFeeCents: Field(1250) },
      pricing: PRICING,
      reversed: false, quantityDispensed: 30,
    }]);
  }
  const svc: any = Object.create(AdjudicationService.prototype);
  Object.assign(svc, {
    pendingPrescriptions: new Map(),
    prescriptions: new Map([['RX-1', {
      status: fill ? 'DISPENSED' : 'FILLED', pharmacyIndex: 0, prescriberIndex: 0, ndcHash: 'ndc', memberWalletId: '123',
      quantity: 30, quantityDispensed: fill ? 30 : 0, refills: 0, refillsUsed: 0, statusHistory: [],
      formularyEntry: { copayAmountCents: Field(1500) },   // the plan's copay, as proven at prescribing
    }]]),
    fulfillments,
    pharmacyWalletIds: new Map([[0, Field(55)]]),
    prescriberWalletIds: new Map([[0, Field(66)]]),
    getMedicationByNdcHash: () => ({
      brandName: 'Testdrug', genericName: 't', strength: '1 mg', ndcFormatted: '00000-0000-01',
      formularyEntry: { tierLevel: 1, copayAmount: 1000 },
    }),
  });
  return svc.getPrescriptionsByPharmacy(0)[0];
}

test('a fill that credited the deductible is DEDUCTIBLE, though the member had paid more than $500 before it', () => {
  // A $1,500 deductible with $600 paid: the fixed rule called this NORMAL_COPAY.
  expect(queueRow({ deductibleCreditCents: 2500, deductiblePaidBefore: 60000, patientPayCents: 2500, totalCostCents: 2500 }).adjudicationPhase).toBe('DEDUCTIBLE');
});

test('a fill that credited nothing is NORMAL_COPAY, though the member had paid less than $500 before it', () => {
  // A $250 deductible already met: the fixed rule called this DEDUCTIBLE.
  expect(queueRow({ deductibleCreditCents: 0, deductiblePaidBefore: 25000, patientPayCents: 1000, totalCostCents: 4300 }).adjudicationPhase).toBe('NORMAL_COPAY');
});

test('a script with no fill has no phase and no pricing', () => {
  const row = queueRow(null);
  expect(row.adjudicationPhase).toBeNull();
  expect(row.pricing).toBeNull();
  expect(row.ingredientCostCents).toBeNull();
  expect(row.dispensingFeeCents).toBeNull();
});

test('the queue carries the latest fill\'s NADAC pricing and the plan copay proven at prescribing', () => {
  const row = queueRow({ deductibleCreditCents: 3051, deductiblePaidBefore: 0, patientPayCents: 3051, totalCostCents: 3051 });
  expect(row.ingredientCostCents).toBe(1801);
  expect(row.dispensingFeeCents).toBe(1250);
  expect(row.pricing).toEqual(PRICING);
  expect(row.copayAmountCents).toBe(1500);
});
