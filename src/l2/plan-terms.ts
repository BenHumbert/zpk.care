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
 * Plan-bound formularies: the terms a plan was last published with.
 *
 * Publishing a plan (InsurerNode.markPlanPublished) copies the fields its members are bound by into
 * BenefitPlanConfig.publishedTerms, beside the formulary and network roots built from them. An edit (PUT /plans/:id)
 * unpublishes the live record but never touches publishedTerms, so the engine goes on serving the plan's members at
 * the version they hold while the insurer drafts the next one, and after a restart too, since the plan store is on the
 * ledger (WAL and gossip). Only publishing again moves the members, each at its next prescription, PA approval or fill.
 *
 * Plain TypeScript, no o1js: the sequencer's RPC server, the insurer node and the engine all read it.
 */
import type { BenefitPlanConfig, PublishedPlanTerms } from './l2-types.js';
import { dispensingFeeError } from '../fulfillment/nadac-pricing.js';

/** The accumulator and family limits a published plan binds, in whole cents. */
const LIMIT_FIELDS = [
  'deductibleAmountCents',
  'oopMaxCents',
  'annualBenefitMaxCents',
  'familyDeductibleAmountCents',
  'familyOopMaxCents',
  'familyAnnualBenefitMaxCents',
] as const;

/** The terms to keep when a plan is published with these roots. */
export function publishedTermsFrom(
  plan: BenefitPlanConfig,
  formularyRoot: string,
  networkRoot: string,
  publishedAt = Date.now(),
): PublishedPlanTerms {
  return {
    copayAmountCents: plan.copayAmountCents,
    coverageType: plan.coverageType,
    deductibleAmountCents: plan.deductibleAmountCents,
    oopMaxCents: plan.oopMaxCents,
    annualBenefitMaxCents: plan.annualBenefitMaxCents,
    familyDeductibleAmountCents: plan.familyDeductibleAmountCents,
    familyOopMaxCents: plan.familyOopMaxCents,
    familyAnnualBenefitMaxCents: plan.familyAnnualBenefitMaxCents,
    dispensingFeeCents: plan.dispensingFeeCents ?? null,
    formularyNdcs: [...(plan.formularyNdcs ?? [])],
    networkProviderWalletIds: [...(plan.networkProviderWalletIds ?? [])],
    formularyRoot,
    networkRoot,
    publishedAt,
  };
}

/**
 * The terms the plan was last published with, or null: a plan never published, or one published before the terms
 * were kept (its formularyRoot is the overlay version, not a root; the insurer must republish it).
 */
export function publishedTermsOf(plan: BenefitPlanConfig | null | undefined): PublishedPlanTerms | null {
  const terms = plan?.publishedTerms;
  return terms && typeof terms === 'object' && typeof terms.formularyRoot === 'string' && terms.formularyRoot !== '' ? terms : null;
}

/**
 * The plan as its members are bound to it: the published terms laid over the live record. A plan with no published
 * terms is returned as it is; the engine binds no member to such a plan (it refuses with 409 until the insurer
 * publishes), so its live values reach only displays.
 */
export function planAsPublished(plan: BenefitPlanConfig): BenefitPlanConfig;
export function planAsPublished(plan: BenefitPlanConfig | null | undefined): BenefitPlanConfig | null;
export function planAsPublished(plan: BenefitPlanConfig | null | undefined): BenefitPlanConfig | null {
  if (!plan) return null;
  const terms = publishedTermsOf(plan);
  if (!terms) return plan;
  return {
    ...plan,
    copayAmountCents: terms.copayAmountCents,
    coverageType: terms.coverageType,
    deductibleAmountCents: terms.deductibleAmountCents,
    oopMaxCents: terms.oopMaxCents,
    annualBenefitMaxCents: terms.annualBenefitMaxCents,
    familyDeductibleAmountCents: terms.familyDeductibleAmountCents,
    familyOopMaxCents: terms.familyOopMaxCents,
    familyAnnualBenefitMaxCents: terms.familyAnnualBenefitMaxCents,
    // the fee as published: none published means the network default, whatever a draft now says
    dispensingFeeCents: terms.dispensingFeeCents ?? null,
    formularyNdcs: terms.formularyNdcs,
    networkProviderWalletIds: terms.networkProviderWalletIds,
    formularyRoot: terms.formularyRoot,
    networkRoot: terms.networkRoot,
    published: true,
  };
}

/** An NDC as the formulary catalog spells it: digits only ("12345-6789-01" becomes "12345678901"). */
const digitsOnly = (ndc: string): string => String(ndc).replace(/\D/g, '');

/**
 * Whether a plan's published drug list covers an NDC, as buildPlanFormulary reads the list: an empty list covers every
 * drug in the formulary catalog; otherwise the NDC must be listed (dashes ignored). Whether the catalog has the drug at
 * all is the caller's to check. A set lookup, no formulary build, so a read that names no member can ask it cheaply.
 */
export function publishedListCovers(terms: PublishedPlanTerms, ndc: string): boolean {
  const listed = terms.formularyNdcs.map(digitsOnly).filter((n) => n.length > 0);
  return listed.length === 0 || listed.includes(digitsOnly(ndc));
}

const isCents = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isDecimal = (v: unknown): boolean => typeof v === 'string' && /^\d+$/.test(v);

/**
 * Why the sequencer's plan store must refuse this plan, or null when it may store it. The engine builds formularies,
 * binds members and (with NADAC pricing) prices fills from what is stored, so a malformed copay, drug list, provider
 * list or set of published terms would otherwise fail later inside register, prescribe or fill. Fields left out are
 * allowed (the insurer's routes fill in the plan's defaults); published terms, when present, must be complete.
 */
export function planStoreError(plan: unknown): string | null {
  if (!plan || typeof plan !== 'object') return 'Missing or invalid plan parameter (requires planId, name)';
  const p = plan as Record<string, unknown>;
  if (typeof p.planId !== 'string' || typeof p.name !== 'string') return 'Missing or invalid plan parameter (requires planId, name)';
  if (p.copayAmountCents !== undefined && !isCents(p.copayAmountCents)) return 'copayAmountCents must be a whole number of cents, 0 or more';
  if (p.formularyNdcs !== undefined && !isStringList(p.formularyNdcs)) return 'formularyNdcs must be a list of NDC strings (empty for every drug in the formulary)';
  if (p.networkProviderWalletIds !== undefined && !isStringList(p.networkProviderWalletIds)) return 'networkProviderWalletIds must be a list of wallet ID strings';
  // NADAC pricing: the engine adds this fee to every fill on the plan
  const feeError = dispensingFeeError(p.dispensingFeeCents);
  if (feeError) return feeError;
  if (p.publishedTerms !== undefined && p.publishedTerms !== null) {
    const t = p.publishedTerms as Record<string, unknown>;
    if (typeof t !== 'object') return 'publishedTerms must be an object';
    if (!isCents(t.copayAmountCents)) return 'publishedTerms.copayAmountCents must be a whole number of cents, 0 or more';
    for (const k of LIMIT_FIELDS) {
      if (!isCents(t[k])) return `publishedTerms.${k} must be a whole number of cents, 0 or more`;
    }
    if (typeof t.coverageType !== 'number' || !Number.isSafeInteger(t.coverageType)) return 'publishedTerms.coverageType must be a whole number';
    if (!isStringList(t.formularyNdcs)) return 'publishedTerms.formularyNdcs must be a list of NDC strings';
    if (!isStringList(t.networkProviderWalletIds)) return 'publishedTerms.networkProviderWalletIds must be a list of wallet ID strings';
    if (!isDecimal(t.formularyRoot)) return 'publishedTerms.formularyRoot must be a field element in decimal';
    if (!isDecimal(t.networkRoot)) return 'publishedTerms.networkRoot must be a field element in decimal';
    const termsFeeError = dispensingFeeError(t.dispensingFeeCents);
    if (termsFeeError) return `publishedTerms.${termsFeeError}`;
  }
  return null;
}
