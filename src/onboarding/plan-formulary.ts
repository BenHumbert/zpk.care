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

import { Field } from 'o1js';
import { buildFormularyEntry, type FormularyEntryLocalData } from '../access-control/formulary-entry.js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';
import { ProviderNetworkRegistry } from '../eligibility/provider-network-registry.js';

/**
 * Plan-bound formularies: what a published plan commits to, built the same way by the insurer when it publishes the
 * plan and by the engine when it binds a member to it.
 *
 * A plan's formulary is the formulary catalog (src/data: each drug's tier, prior authorization, step therapy and
 * quantity limits) cut to the NDCs the plan lists, or all of it when the plan lists none, in catalog order. Every entry
 * carries the plan's copay: in the copay phase the member pays the copay the insurer set on the plan, whatever the
 * drug's tier (owner decision 2026-10-18). The tree, and so its root, depends only on the plan's copay, its NDC set and
 * the catalog. The root is the plan's published formularyRoot, and the EligibilityData of each member bound to the plan
 * names it, so the AccessControl proof at prescribing ties the entry, and its copay, to the member's credential.
 *
 * No entry holds a price. The price list (NADAC plus a dispensing fee) is the engine's, attached where the entry is
 * resolved: at dispense today, at prescribing under B3.
 */

/** The fields of a plan its formulary is built from; a BenefitPlanConfig has them. */
export interface PlanFormularyInput {
  copayAmountCents: number;
  /** NDCs, with or without dashes. Empty or absent: every drug in the catalog. */
  formularyNdcs?: readonly string[];
}

/** One plan's formulary, as the proofs use it. */
export interface PlanFormulary {
  registry: FormularyRegistry;
  root: Field;
  copayAmountCents: number;
  /** Decimal ndcHash (hashString of the catalog NDC) to its leaf index in `registry`. */
  leafByNdcHash: Map<string, bigint>;
  /** NDCs the plan lists that the catalog does not have. They are not covered. */
  unknownNdcs: string[];
}

/** An NDC as the catalog spells it: digits only ("12345-6789-01" becomes "12345678901"). */
export function normalizeNdc(ndc: string): string {
  return String(ndc).replace(/\D/g, '');
}

/**
 * The most drugs a plan formulary may hold while it is built on a request: about 11 s of Poseidon hashing, measured at
 * roughly 11 ms a drug (its leaf commitment and its share of the tree). The insurer builds a plan's formulary in its
 * publish handler, and the engine builds it again the first time it binds a member to that version, inside register,
 * prescribe or fill, on the Leviathan's single thread, which it shares with the sequencer. A whole 32,768-drug catalog
 * would stall both for about six minutes, so a larger plan is refused, saying why, until plan formulary leaves are
 * cached (they depend only on the copay and the catalog). The demo's catalog (ZKTRIDENT_FORMULARY_LIMIT=100) is far
 * below it.
 */
export const MAX_PLAN_FORMULARY_ON_REQUEST = 1024;

/**
 * Build a plan's formulary over the catalog. Throws on a copay that is not a whole number of cents, 0 or more, and on
 * a plan whose formulary would hold more than `maxEntries` drugs (MAX_PLAN_FORMULARY_ON_REQUEST by default), before
 * hashing anything.
 */
export function buildPlanFormulary(
  plan: PlanFormularyInput,
  catalog: readonly FormularyEntryLocalData[],
  opts: { maxEntries?: number } = {},
): PlanFormulary {
  const copay = plan.copayAmountCents;
  if (typeof copay !== 'number' || !Number.isSafeInteger(copay) || copay < 0) {
    throw new Error(`A plan's copay must be a whole number of cents, 0 or more (got ${String(copay)})`);
  }
  const listed = new Set((plan.formularyNdcs ?? []).map(normalizeNdc).filter((ndc) => ndc.length > 0));
  const everyDrug = listed.size === 0;
  const covered = new Set<string>();
  const locals: FormularyEntryLocalData[] = [];
  for (const drug of catalog) {
    const ndc = normalizeNdc(drug.ndc);
    if (covered.has(ndc) || (!everyDrug && !listed.has(ndc))) continue;
    covered.add(ndc);
    locals.push({ ...drug, copayAmount: copay });
  }
  const maxEntries = opts.maxEntries ?? MAX_PLAN_FORMULARY_ON_REQUEST;
  if (locals.length > maxEntries) {
    throw new Error(
      `This plan's formulary would hold ${locals.length} drugs. A plan formulary of more than ${maxEntries} drugs is not `
      + `built on a request (about ${Math.round((locals.length * 11) / 1000)} s of hashing on the sequencer's thread) until `
      + `plan formulary leaves are cached; list the plan's drugs in formularyNdcs${everyDrug ? ' (an empty list means every drug in the catalog)' : ''}.`,
    );
  }
  const entries = locals.map((local) => buildFormularyEntry(local));
  const registry = FormularyRegistry.fromEntries(entries);
  const leafByNdcHash = new Map<string, bigint>();
  entries.forEach((entry, i) => leafByNdcHash.set(entry.ndcHash.toString(), BigInt(i)));
  return {
    registry,
    root: registry.getRoot(),
    copayAmountCents: copay,
    leafByNdcHash,
    unknownNdcs: [...listed].filter((ndc) => !covered.has(ndc)),
  };
}

/**
 * The root of a plan's provider network, as a member's EligibilityData names it: Field(0), every provider accepted, when
 * the plan lists none (PlanTemplate's convention); otherwise the tree of the listed wallet IDs in order, with duplicates
 * and anything that is not a decimal wallet ID dropped. A list with nothing valid left is an empty network, not every
 * provider.
 */
export function planNetworkRoot(walletIds: readonly string[] | undefined): Field {
  const ids = walletIds ?? [];
  if (ids.length === 0) return Field(0);
  const network = new ProviderNetworkRegistry();
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) continue;
    const canonical = BigInt(id).toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    network.addProvider(Field(BigInt(canonical)));
  }
  return network.getRoot();
}
