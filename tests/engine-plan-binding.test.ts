/**
 * What a member bound to a plan gets — plan item C2, finding A-9.
 *
 * The accumulator limits come from the plan the insurer approved, and the provider network from
 * the plan's overlay, where an empty list means every credentialed provider.
 */
import { Field } from 'o1js';
import { bindPlan } from '../src/adjudication/interactive-service.js';
import type { BenefitPlanConfig } from '../src/l2/l2-types.js';

const plan = (over: Partial<BenefitPlanConfig> = {}): BenefitPlanConfig => ({
  planId: 'PLAN-E2E-1', name: 'E2E', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 52500, oopMaxCents: 780000,
  annualBenefitMaxCents: 250000, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1000000, familyAnnualBenefitMaxCents: 0,
  formularyNdcs: [], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0, ...over,
} as BenefitPlanConfig);

const prescribers = new Map<number, Field>([[0, Field(11)], [1, Field(12)], [2, Field(13)]]);
const pharmacies = new Map<number, Field>([[0, Field(21)], [1, Field(22)]]);

test('the limits are the plan\'s, not PLAN-GOLD\'s', () => {
  const b = bindPlan(plan(), { prescribers, pharmacies });
  expect(b.accumulator).toEqual({ deductibleAmountCents: 52500, oopMaxCents: 780000, annualBenefitMaxCents: 250000 });
});

test('an empty network list means every credentialed provider', () => {
  const b = bindPlan(plan(), { prescribers, pharmacies });
  expect(b.prescriberIndices).toEqual([0, 1, 2]);
  expect(b.pharmacyIndices).toEqual([0, 1]);
});

test('an explicit network list binds exactly those providers, by wallet id', () => {
  const b = bindPlan(plan({ networkProviderWalletIds: ['12', '21', '999'] }), { prescribers, pharmacies });
  expect(b.prescriberIndices).toEqual([1]);
  expect(b.pharmacyIndices).toEqual([0]);
});

test('a plan with no providers credentialed yields an empty network either way', () => {
  const b = bindPlan(plan(), { prescribers: new Map(), pharmacies: new Map() });
  expect(b.prescriberIndices).toEqual([]);
  expect(b.pharmacyIndices).toEqual([]);
});
