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
 * Plan-bound formularies: what a published plan commits to.
 *
 * What was wrong: every member was served from one formulary, the console's PLAN-GOLD-2026 template over the whole
 * catalog, at the catalog's tier copays. The plan the insurer published named no formulary (its formularyRoot held
 * the overlay version number, '1'), its NDC list was ignored, and its copay was never billed.
 *
 * Now buildPlanFormulary builds a plan's formulary from its copay and NDC list over the catalog: every entry carries
 * the plan's copay, an empty list means the whole catalog, and the tree depends only on the copay and the NDC set.
 * The insurer publishes its root and the engine rebuilds it, so both reach the same root. FormularyRegistry.fromEntries
 * builds the same tree as addEntry, bottom-up. The published terms (src/l2/plan-terms.ts) keep what members are bound
 * to while the insurer edits a draft, and the sequencer's plan store refuses a malformed plan.
 *
 * Pure: a synthetic catalog, no circuit compiled, nothing proved.
 */
import { Field } from 'o1js';
import { buildFormularyEntry, FormularyEntry, type FormularyEntryLocalData } from '../src/access-control/formulary-entry.js';
import { FormularyRegistry } from '../src/access-control/formulary-registry.js';
import { ProviderNetworkRegistry } from '../src/eligibility/provider-network-registry.js';
import { PlanTemplate } from '../src/onboarding/plan-template.js';
import { buildPlanFormulary, planNetworkRoot, normalizeNdc, MAX_PLAN_FORMULARY_ON_REQUEST } from '../src/onboarding/plan-formulary.js';
import { publishedTermsFrom, publishedTermsOf, planAsPublished, planStoreError } from '../src/l2/plan-terms.js';
import { hashString } from '../src/zkp/hash-utils.js';
import type { BenefitPlanConfig } from '../src/l2/l2-types.js';

jest.setTimeout(120_000);

const drug = (n: number, tierLevel: number, copayAmount: number, requiresPriorAuth: boolean, stepTherapyRequired: boolean, maxQuantityPerFill: number): FormularyEntryLocalData => ({
  ndc: `0000000000${n}`, tierLevel, copayAmount, requiresPriorAuth, maxQuantityPerFill, maxDaySupply: maxQuantityPerFill, stepTherapyRequired,
});

/** Six drugs, tiers 1 to 4 at the data's tier copays, with mixed prior-auth and step-therapy flags. */
const catalog: FormularyEntryLocalData[] = [
  drug(1, 1, 1000, false, false, 90),
  drug(2, 1, 1000, false, false, 30),
  drug(3, 2, 3500, false, false, 90),
  drug(4, 3, 7500, false, true, 30),
  drug(5, 4, 15000, true, true, 30),
  drug(6, 2, 3500, true, false, 90),
];

describe('buildPlanFormulary', () => {
  test('every entry carries the plan copay; tier, prior auth, step therapy and limits come from the catalog', () => {
    const f = buildPlanFormulary({ copayAmountCents: 1500, formularyNdcs: [] }, catalog);
    expect(f.registry.count).toBe(6);
    expect(f.copayAmountCents).toBe(1500);
    for (let i = 0; i < catalog.length; i++) {
      const entry = f.registry.getEntry(BigInt(i))!;
      const fromCatalog = buildFormularyEntry(catalog[i]);
      expect(entry.copayAmountCents.toBigInt()).toBe(1500n);
      expect(entry.ndcHash.toString()).toBe(fromCatalog.ndcHash.toString());
      expect(entry.tierLevel.toString()).toBe(fromCatalog.tierLevel.toString());
      expect(entry.requiresPriorAuth.toString()).toBe(fromCatalog.requiresPriorAuth.toString());
      expect(entry.maxQuantityPerFill.toString()).toBe(fromCatalog.maxQuantityPerFill.toString());
      expect(entry.maxDaySupply.toString()).toBe(fromCatalog.maxDaySupply.toString());
      expect(entry.stepTherapyRequired.toString()).toBe(fromCatalog.stepTherapyRequired.toString());
      expect(f.leafByNdcHash.get(hashString(catalog[i].ndc).toString())).toBe(BigInt(i));
    }
  });

  test('a listed formulary is those drugs in catalog order, dashes ignored, duplicates once; unknown NDCs are reported', () => {
    const withDashes = `${catalog[4].ndc.slice(0, 5)}-${catalog[4].ndc.slice(5, 9)}-${catalog[4].ndc.slice(9)}`;
    expect(normalizeNdc(withDashes)).toBe(catalog[4].ndc);
    const f = buildPlanFormulary({ copayAmountCents: 1500, formularyNdcs: [withDashes, catalog[1].ndc, catalog[1].ndc, '99999999999'] }, catalog);
    expect(f.registry.count).toBe(2);
    expect(f.registry.getEntry(0n)!.ndcHash.toString()).toBe(hashString(catalog[1].ndc).toString());
    expect(f.registry.getEntry(1n)!.ndcHash.toString()).toBe(hashString(catalog[4].ndc).toString());
    expect(f.unknownNdcs).toEqual(['99999999999']);
    expect(f.leafByNdcHash.has(hashString(catalog[0].ndc).toString())).toBe(false);
  });

  test('the root depends only on the copay and the NDC set', () => {
    const a = catalog[0].ndc, b = catalog[2].ndc, c = catalog[3].ndc;
    const root = (copayAmountCents: number, formularyNdcs: string[]) => buildPlanFormulary({ copayAmountCents, formularyNdcs }, catalog).root.toString();
    expect(root(1500, [a, b])).toBe(root(1500, [b, a]));
    expect(root(1500, [a, b])).not.toBe(root(1600, [a, b]));
    expect(root(1500, [a, b])).not.toBe(root(1500, [a, c]));
    // the catalog's tier copays (the console's PLAN-GOLD-2026 template) build a different tree from the plan's copay
    const template = new PlanTemplate({ planId: 'T', copayAmountCents: 3000, coverageType: 1, deductibleAmountCents: 0, oopMaxCents: 0, annualBenefitMaxCents: 0, formularyEntries: catalog });
    expect(root(1500, [])).not.toBe(template.formularyRoot.toString());
  });

  test('each covered drug\'s witness reaches the root from its entry', () => {
    const f = buildPlanFormulary({ copayAmountCents: 1500, formularyNdcs: [] }, catalog);
    for (let i = 0n; i < BigInt(f.registry.count); i++) {
      expect(f.registry.getEntryWitness(i).calculateRoot(f.registry.getEntry(i)!.commitment()).toString()).toBe(f.root.toString());
    }
  });

  test('a copay that is negative, fractional or not a number is refused', () => {
    for (const copay of [-1, 10.5, NaN, '1500' as unknown as number]) {
      expect(() => buildPlanFormulary({ copayAmountCents: copay, formularyNdcs: [] }, catalog)).toThrow(/whole number of cents/);
    }
  });

  test('a plan formulary too large to build on a request is refused before anything is hashed', () => {
    expect(MAX_PLAN_FORMULARY_ON_REQUEST).toBeGreaterThanOrEqual(100); // the demo catalog fits
    expect(() => buildPlanFormulary({ copayAmountCents: 1500, formularyNdcs: [] }, catalog, { maxEntries: 5 })).toThrow(/6 drugs.*not built on a request.*every drug in the catalog/);
    expect(() => buildPlanFormulary({ copayAmountCents: 1500, formularyNdcs: [catalog[0].ndc, catalog[1].ndc] }, catalog, { maxEntries: 2 })).not.toThrow();
  });
});

describe('FormularyRegistry.fromEntries', () => {
  test('builds the same tree as addEntry one at a time', () => {
    const entries = catalog.concat(catalog.slice(0, 3).map((d, i) => ({ ...d, ndc: `1000000000${i}` }))).map(buildFormularyEntry);
    for (const n of [0, 1, 2, 5, 9]) {
      const bulk = FormularyRegistry.fromEntries(entries.slice(0, n));
      const one = new FormularyRegistry();
      entries.slice(0, n).forEach((e) => one.addEntry(e));
      expect(bulk.getRoot().toString()).toBe(one.getRoot().toString());
      expect(bulk.count).toBe(one.count);
      for (let i = 0n; i < BigInt(n); i++) {
        expect(bulk.getEntry(i)).toBe(entries[Number(i)]);
        expect(bulk.getEntryWitness(i).calculateRoot(entries[Number(i)].commitment()).toString()).toBe(one.getRoot().toString());
      }
      // the next addEntry lands at index n in both
      expect(bulk.addEntry(entries[0]).index).toBe(BigInt(n));
    }
  });

  test('refuses more than the tree holds before hashing anything', () => {
    const entry = new FormularyEntry({ ndcHash: Field(1), tierLevel: Field(1), copayAmountCents: Field(0), requiresPriorAuth: Field(0), maxQuantityPerFill: Field(0), maxDaySupply: Field(0), stepTherapyRequired: Field(0) });
    expect(() => FormularyRegistry.fromEntries(new Array(32_769).fill(entry))).toThrow(/Formulary full/);
  });
});

describe('planNetworkRoot', () => {
  test('no list is every provider (Field 0); a list is its tree, in order, duplicates and non-decimal IDs dropped', () => {
    expect(planNetworkRoot([]).toString()).toBe('0');
    expect(planNetworkRoot(undefined).toString()).toBe('0');
    const reg = new ProviderNetworkRegistry();
    reg.addProvider(Field(11));
    reg.addProvider(Field(12));
    expect(planNetworkRoot(['11', '12']).toString()).toBe(reg.getRoot().toString());
    expect(planNetworkRoot(['11', '011', 'x', '12', '11']).toString()).toBe(reg.getRoot().toString());
    // a list with nothing valid left is an empty network, not every provider
    expect(planNetworkRoot(['x']).toString()).toBe(new ProviderNetworkRegistry().getRoot().toString());
    expect(planNetworkRoot(['x']).toString()).not.toBe('0');
  });
});

describe('published terms', () => {
  const plan = (over: Partial<BenefitPlanConfig> = {}): BenefitPlanConfig => ({
    planId: 'PLAN-T', name: 'T', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0,
    formularyNdcs: ['00000000001'], networkProviderWalletIds: ['11'], published: false, createdAt: 0, updatedAt: 0, ...over,
  });

  test('publishing keeps the binding fields and the roots; the published view lays them over a later draft', () => {
    const terms = publishedTermsFrom(plan(), '123', '0', 7);
    expect(terms).toEqual({
      copayAmountCents: 1500, coverageType: 1, deductibleAmountCents: 50000, oopMaxCents: 780000, annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: null,
      formularyNdcs: ['00000000001'], networkProviderWalletIds: ['11'], formularyRoot: '123', networkRoot: '0', publishedAt: 7,
    });
    expect(publishedTermsFrom(plan({ dispensingFeeCents: 1250 }), '123', '0', 7).dispensingFeeCents).toBe(1250);
    // a draft the insurer is editing: new copay, drug list, limits, network and fee, unpublished
    const draft = plan({ copayAmountCents: 2500, formularyNdcs: [], deductibleAmountCents: 1, networkProviderWalletIds: [], dispensingFeeCents: 2500, published: false, publishedTerms: terms });
    const view = planAsPublished(draft);
    expect(view).toMatchObject({ copayAmountCents: 1500, formularyNdcs: ['00000000001'], deductibleAmountCents: 50000, networkProviderWalletIds: ['11'], formularyRoot: '123', networkRoot: '0', published: true });
    expect(view.dispensingFeeCents).toBeNull();   // published with no fee: the network default, whatever the draft says
    expect(view.name).toBe('T');
  });

  test('a plan with no published terms (a draft never published, or one published before the terms were kept) has none', () => {
    expect(publishedTermsOf(plan())).toBeNull();
    expect(publishedTermsOf(plan({ published: true, formularyRoot: '1' }))).toBeNull();
    expect(publishedTermsOf(null)).toBeNull();
    const legacy = plan({ published: true, formularyRoot: '1' });
    expect(planAsPublished(legacy)).toBe(legacy);
    expect(planAsPublished(null)).toBeNull();
  });

  test('the plan store refuses a malformed copay, drug list, provider list or set of published terms', () => {
    expect(planStoreError(plan())).toBeNull();
    expect(planStoreError({ planId: 'P', name: 'N' })).toBeNull(); // fields left out: the insurer's defaults apply
    expect(planStoreError({ planId: 'P' })).toMatch(/requires planId, name/);
    expect(planStoreError(plan({ copayAmountCents: -1 }))).toMatch(/copayAmountCents/);
    expect(planStoreError(plan({ copayAmountCents: 10.5 }))).toMatch(/copayAmountCents/);
    expect(planStoreError(plan({ copayAmountCents: '1500' as unknown as number }))).toMatch(/copayAmountCents/);
    expect(planStoreError(plan({ formularyNdcs: [1, 2] as unknown as string[] }))).toMatch(/formularyNdcs/);
    expect(planStoreError(plan({ networkProviderWalletIds: 'x' as unknown as string[] }))).toMatch(/networkProviderWalletIds/);
    const terms = publishedTermsFrom(plan(), '123', '0', 7);
    expect(planStoreError(plan({ publishedTerms: terms }))).toBeNull();
    expect(planStoreError(plan({ publishedTerms: { ...terms, formularyRoot: 'abc' } }))).toMatch(/publishedTerms.formularyRoot/);
    expect(planStoreError(plan({ publishedTerms: { ...terms, copayAmountCents: -5 } }))).toMatch(/publishedTerms.copayAmountCents/);
    expect(planStoreError(plan({ publishedTerms: { ...terms, oopMaxCents: undefined as unknown as number } }))).toMatch(/publishedTerms.oopMaxCents/);
    expect(planStoreError(plan({ publishedTerms: { ...terms, formularyNdcs: [7] as unknown as string[] } }))).toMatch(/publishedTerms.formularyNdcs/);
  });
});
