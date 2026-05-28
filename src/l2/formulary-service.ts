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
 * FormularyService — Option C: Canonical formulary with plan overlays.
 *
 * Architecture:
 *   - One canonical MerkleTree(16) of 32,768 NADAC drugs loaded at construction
 *   - In-memory indexes by classification (G/B), tier level (1-4), drug name prefix, route
 *   - Plan overlays (~5-10KB each) for tier/copay/PA customizations — not full 10MB copies
 *   - Paginated queries for dashboard drill-down
 *
 * This replaces the old formularyStore approach (Map<planIdHash, {entriesJson: string}>)
 * which stored full 10MB JSON blobs per plan.
 */

import { Field, Poseidon, MerkleTree, MerkleWitness } from 'o1js';
import { hashString } from '../zkp/hash-utils.js';

// ─── Tree Constants ──────────────────────────────────────────

/** MerkleTree height — 2^16 = 65,536 leaf capacity (32,768 drugs + room to grow) */
export const FORMULARY_TREE_HEIGHT = 16;

/** Merkle witness for the formulary tree */
export class FormularyWitness extends MerkleWitness(FORMULARY_TREE_HEIGHT) {}

/**
 * Compute the Poseidon hash of a formulary leaf (6 Fields → 1 hash).
 *
 * Leaf structure:
 *   [ndcHash, classification, tierLevel, copayAmount, requiresPriorAuth, maxDaySupply]
 *
 * This commits the drug's identity + coverage parameters into a single Field.
 */
export function computeFormularyLeafHash(
  ndcHash: string,
  classification: string,
  tierLevel: number,
  copayAmount: number,
  requiresPriorAuth: boolean,
  maxDaySupply: number,
): Field {
  return Poseidon.hash([
    Field(BigInt(ndcHash)),
    Field(classification === 'B' ? 1 : 0), // 0=generic, 1=brand
    Field(tierLevel),
    Field(copayAmount),
    Field(requiresPriorAuth ? 1 : 0),
    Field(maxDaySupply),
  ]);
}

// ─── Types ────────────────────────────────────────────────────

/** Canonical drug entry stored in the formulary */
export interface FormularyDrug {
  ndc: string;
  ndcHash: string;
  ndcFormatted: string;
  description: string;
  genericName: string;
  brandName: string;
  strength: string;
  dosageForm: string;
  route: string;
  classification: string; // 'G' = generic, 'B' = brand
  nadacPerUnit: number;
  pricingUnit: string;
  otc: boolean;
  /** Default tier (from NADAC pricing rules) */
  defaultTier: number;
  /** Default copay cents */
  defaultCopay: number;
  requiresPriorAuth: boolean;
  maxQuantityPerFill: number;
  maxDaySupply: number;
  stepTherapyRequired: boolean;
}

/** Plan overlay — lightweight tier/copay/PA overrides for a specific plan */
export interface PlanOverlay {
  planIdHash: string;
  planName: string;
  /** Per-drug overrides keyed by ndcHash */
  overrides: Map<string, DrugOverride>;
  /** Plan-wide defaults (applied when no per-drug override exists) */
  defaults: PlanDefaults;
  publishedAt: number;
  version: number;
}

/** Per-drug override within a plan overlay */
export interface DrugOverride {
  ndcHash: string;
  tierLevel?: number;
  copayAmount?: number;
  requiresPriorAuth?: boolean;
  excluded?: boolean; // true = not covered by this plan
}

/** Plan-wide defaults */
export interface PlanDefaults {
  tier1Copay: number; // cents
  tier2Copay: number;
  tier3Copay: number;
  tier4Copay: number;
}

/** Category summary for drill-down UI */
export interface FormularyCategory {
  name: string;
  drugCount: number;
  subcategories?: { name: string; drugCount: number }[];
}

/** Paginated result */
export interface FormularyPage {
  drugs: FormularyDrugWithPlan[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Drug entry with plan-specific pricing applied */
export interface FormularyDrugWithPlan {
  ndc: string;
  ndcHash: string;
  ndcFormatted: string;
  genericName: string;
  brandName: string;
  strength: string;
  dosageForm: string;
  route: string;
  classification: string;
  nadacPerUnit: number;
  tierLevel: number;
  copayAmount: number;
  requiresPriorAuth: boolean;
  excluded: boolean;
  maxQuantityPerFill: number;
  maxDaySupply: number;
  stepTherapyRequired: boolean;
}

/** Coverage check result */
export interface CoverageResult {
  covered: boolean;
  tierLevel: number;
  copayAmount: number;
  requiresPriorAuth: boolean;
  nadacPerUnit: number;
  genericName: string;
  brandName: string;
  strength: string;
  dosageForm: string;
}

/** Filter for paginated queries */
export interface FormularyFilter {
  /** Search by drug name prefix (case-insensitive) */
  namePrefix?: string;
  /** Filter by classification: 'G' | 'B' | 'all' */
  classification?: string;
  /** Filter by tier level (1-4) */
  tierLevel?: number;
  /** Filter by route (Oral, Injectable, etc.) */
  route?: string;
  /** Plan overlay to apply (for plan-specific pricing) */
  planIdHash?: string;
  /** Exclude drugs not covered by plan */
  excludeNonCovered?: boolean;
}

/** Serializable state for checkpoint */
export interface FormularyServiceState {
  /** Merkle root of the formulary tree (decimal string) */
  formularyRoot: string;
  /** Number of drugs in the tree */
  drugCount: number;
  overlays: Record<string, {
    planIdHash: string;
    planName: string;
    overrides: Record<string, DrugOverride>;
    defaults: PlanDefaults;
    publishedAt: number;
    version: number;
  }>;
}

// ─── Service ──────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 100;

export class FormularyService {
  /** All 32K drugs indexed by ndcHash */
  private drugsByNdcHash: Map<string, FormularyDrug> = new Map();
  /** All drugs in insertion order (for pagination) */
  private allDrugs: FormularyDrug[] = [];
  /** Index: classification → drugs */
  private byClassification: Map<string, FormularyDrug[]> = new Map();
  /** Index: tier level → drugs */
  private byTier: Map<number, FormularyDrug[]> = new Map();
  /** Index: route → drugs */
  private byRoute: Map<string, FormularyDrug[]> = new Map();
  /** Index: name prefix (first 3 chars uppercase) → drugs */
  private byNamePrefix: Map<string, FormularyDrug[]> = new Map();
  /** Plan overlays keyed by planIdHash */
  private overlays: Map<string, PlanOverlay> = new Map();

  /** Merkle tree — cryptographic commitment to the full formulary */
  private tree: MerkleTree = new MerkleTree(FORMULARY_TREE_HEIGHT);
  /** ndcHash → leaf index in the Merkle tree */
  private leafIndexByNdcHash: Map<string, bigint> = new Map();
  /** Next available leaf index */
  private nextLeafIndex: bigint = 0n;

  get drugCount(): number { return this.allDrugs.length; }
  get overlayCount(): number { return this.overlays.size; }

  /** Current Merkle root — single Field committing to all 32K drugs */
  getRoot(): Field { return this.tree.getRoot(); }

  /** Root as string (for JSON serialization) */
  getRootString(): string { return this.tree.getRoot().toString(); }

  /** Merkle witness for a specific drug (16 hashes proving inclusion) */
  getWitness(ndcHash: string): FormularyWitness | null {
    const leafIndex = this.leafIndexByNdcHash.get(ndcHash);
    if (leafIndex === undefined) return null;
    return new FormularyWitness(this.tree.getWitness(leafIndex));
  }

  /** Get leaf index for a drug */
  getLeafIndex(ndcHash: string): bigint | null {
    return this.leafIndexByNdcHash.get(ndcHash) ?? null;
  }

  /**
   * Load the canonical formulary from raw NADAC records.
   * Called once at sequencer startup.
   */
  loadFromNadac(records: Array<{
    ndc: string;
    ndcFormatted: string;
    description: string;
    classification: string;
    nadacPerUnit: number;
    pricingUnit: string;
    otc: boolean;
    tierLevel: number;
    copayAmount: number;
    requiresPriorAuth: boolean;
    maxQuantityPerFill: number;
    maxDaySupply: number;
    stepTherapyRequired: boolean;
  }>): void {
    this.drugsByNdcHash.clear();
    this.allDrugs = [];
    this.byClassification.clear();
    this.byTier.clear();
    this.byRoute.clear();
    this.byNamePrefix.clear();
    this.tree = new MerkleTree(FORMULARY_TREE_HEIGHT);
    this.leafIndexByNdcHash.clear();
    this.nextLeafIndex = 0n;

    for (const r of records) {
      const { genericName, strength, dosageForm } = parseDescription(r.description);
      const route = guessRoute(dosageForm);
      const ndcHash = hashString(r.ndc).toString();

      const drug: FormularyDrug = {
        ndc: r.ndc,
        ndcHash,
        ndcFormatted: r.ndcFormatted,
        description: r.description,
        genericName,
        brandName: r.classification === 'B' ? r.description : `${genericName} (Generic)`,
        strength,
        dosageForm,
        route,
        classification: r.classification,
        nadacPerUnit: r.nadacPerUnit,
        pricingUnit: r.pricingUnit,
        otc: r.otc,
        defaultTier: r.tierLevel,
        defaultCopay: r.copayAmount,
        requiresPriorAuth: r.requiresPriorAuth,
        maxQuantityPerFill: r.maxQuantityPerFill,
        maxDaySupply: r.maxDaySupply,
        stepTherapyRequired: r.stepTherapyRequired,
      };

      this.drugsByNdcHash.set(ndcHash, drug);
      this.allDrugs.push(drug);

      // Classification index
      const cls = r.classification || 'G';
      if (!this.byClassification.has(cls)) this.byClassification.set(cls, []);
      this.byClassification.get(cls)!.push(drug);

      // Tier index
      if (!this.byTier.has(r.tierLevel)) this.byTier.set(r.tierLevel, []);
      this.byTier.get(r.tierLevel)!.push(drug);

      // Route index
      if (!this.byRoute.has(route)) this.byRoute.set(route, []);
      this.byRoute.get(route)!.push(drug);

      // Name prefix index (first 3 chars)
      const prefix = (genericName || r.description).substring(0, 3).toUpperCase();
      if (!this.byNamePrefix.has(prefix)) this.byNamePrefix.set(prefix, []);
      this.byNamePrefix.get(prefix)!.push(drug);

      // Merkle tree — compute leaf hash and insert
      const leafHash = computeFormularyLeafHash(
        ndcHash,
        r.classification,
        r.tierLevel,
        r.copayAmount,
        r.requiresPriorAuth,
        r.maxDaySupply,
      );
      this.tree.setLeaf(this.nextLeafIndex, leafHash);
      this.leafIndexByNdcHash.set(ndcHash, this.nextLeafIndex);
      this.nextLeafIndex++;
    }
  }

  // ─── Drug Lookup ─────────────────────────────────────────

  /** Get a single drug by ndcHash */
  getDrug(ndcHash: string): FormularyDrug | null {
    return this.drugsByNdcHash.get(ndcHash) ?? null;
  }

  /** Get a single drug by NDC code */
  getDrugByNdc(ndc: string): FormularyDrug | null {
    const ndcHash = hashString(ndc).toString();
    return this.drugsByNdcHash.get(ndcHash) ?? null;
  }

  // ─── Categories (for drill-down UI) ──────────────────────

  /** Get top-level categories for hierarchical drill-down */
  getCategories(): FormularyCategory[] {
    const categories: FormularyCategory[] = [];

    // By route (Oral, Injectable, Topical, etc.)
    const routes: FormularyCategory[] = [];
    for (const [route, drugs] of this.byRoute) {
      routes.push({ name: route, drugCount: drugs.length });
    }
    routes.sort((a, b) => b.drugCount - a.drugCount);

    // By classification
    const generics = this.byClassification.get('G')?.length ?? 0;
    const brands = this.byClassification.get('B')?.length ?? 0;

    categories.push({
      name: 'By Classification',
      drugCount: this.allDrugs.length,
      subcategories: [
        { name: 'Generic', drugCount: generics },
        { name: 'Brand', drugCount: brands },
      ],
    });

    categories.push({
      name: 'By Route',
      drugCount: this.allDrugs.length,
      subcategories: routes,
    });

    // By tier
    const tierSubs: { name: string; drugCount: number }[] = [];
    for (const tier of [1, 2, 3, 4]) {
      const count = this.byTier.get(tier)?.length ?? 0;
      if (count > 0) {
        const tierNames = ['', 'Tier 1 — Generic', 'Tier 2 — Preferred Brand', 'Tier 3 — Non-Preferred', 'Tier 4 — Specialty'];
        tierSubs.push({ name: tierNames[tier], drugCount: count });
      }
    }
    categories.push({
      name: 'By Tier',
      drugCount: this.allDrugs.length,
      subcategories: tierSubs,
    });

    return categories;
  }

  // ─── Paginated Query ─────────────────────────────────────

  /** Query drugs with filtering and pagination */
  getPage(filter: FormularyFilter = {}, offset = 0, limit = DEFAULT_PAGE_SIZE): FormularyPage {
    let candidates = this.allDrugs;

    // Apply filters
    if (filter.classification && filter.classification !== 'all') {
      candidates = candidates.filter(d => d.classification === filter.classification);
    }
    if (filter.tierLevel) {
      candidates = candidates.filter(d => d.defaultTier === filter.tierLevel);
    }
    if (filter.route) {
      candidates = candidates.filter(d => d.route === filter.route);
    }
    if (filter.namePrefix) {
      const prefix = filter.namePrefix.toUpperCase();
      candidates = candidates.filter(d =>
        d.genericName.toUpperCase().startsWith(prefix) ||
        d.brandName.toUpperCase().startsWith(prefix) ||
        d.description.toUpperCase().startsWith(prefix)
      );
    }

    // Get plan overlay if specified
    const overlay = filter.planIdHash ? this.overlays.get(filter.planIdHash) : null;

    // Apply plan-specific filtering
    if (filter.excludeNonCovered && overlay) {
      candidates = candidates.filter(d => {
        const ovr = overlay.overrides.get(d.ndcHash);
        return !ovr?.excluded;
      });
    }

    const total = candidates.length;
    const page = candidates.slice(offset, offset + limit);

    const drugs: FormularyDrugWithPlan[] = page.map(d => this.applyOverlay(d, overlay ?? null));

    return {
      drugs,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  // ─── Coverage Check ──────────────────────────────────────

  /** Check if a drug is covered under a specific plan */
  checkCoverage(planIdHash: string, ndcHash: string): CoverageResult | null {
    const drug = this.drugsByNdcHash.get(ndcHash);
    if (!drug) return null;

    const overlay = this.overlays.get(planIdHash);
    const ovr = overlay?.overrides.get(ndcHash);

    if (ovr?.excluded) {
      return {
        covered: false,
        tierLevel: drug.defaultTier,
        copayAmount: drug.defaultCopay,
        requiresPriorAuth: drug.requiresPriorAuth,
        nadacPerUnit: drug.nadacPerUnit,
        genericName: drug.genericName,
        brandName: drug.brandName,
        strength: drug.strength,
        dosageForm: drug.dosageForm,
      };
    }

    const tierLevel = ovr?.tierLevel ?? drug.defaultTier;
    let copayAmount = ovr?.copayAmount ?? drug.defaultCopay;

    // Apply plan defaults if no per-drug override
    if (!ovr?.copayAmount && overlay) {
      const tierKey = `tier${tierLevel}Copay` as keyof PlanDefaults;
      copayAmount = overlay.defaults[tierKey] ?? drug.defaultCopay;
    }

    return {
      covered: true,
      tierLevel,
      copayAmount,
      requiresPriorAuth: ovr?.requiresPriorAuth ?? drug.requiresPriorAuth,
      nadacPerUnit: drug.nadacPerUnit,
      genericName: drug.genericName,
      brandName: drug.brandName,
      strength: drug.strength,
      dosageForm: drug.dosageForm,
    };
  }

  // ─── Plan Overlays ───────────────────────────────────────

  /** Publish a plan overlay (lightweight — ~5-10KB, not 10MB) */
  publishOverlay(
    planIdHash: string,
    planName: string,
    overrides: DrugOverride[],
    defaults: PlanDefaults,
  ): PlanOverlay {
    const existing = this.overlays.get(planIdHash);
    const version = existing ? existing.version + 1 : 1;

    const overrideMap = new Map<string, DrugOverride>();
    for (const ovr of overrides) {
      overrideMap.set(ovr.ndcHash, ovr);
    }

    const overlay: PlanOverlay = {
      planIdHash,
      planName,
      overrides: overrideMap,
      defaults,
      publishedAt: Date.now(),
      version,
    };

    this.overlays.set(planIdHash, overlay);
    return overlay;
  }

  /** Get a plan overlay */
  getOverlay(planIdHash: string): PlanOverlay | null {
    return this.overlays.get(planIdHash) ?? null;
  }

  /** Get all overlay plan IDs */
  getOverlayIds(): string[] {
    return Array.from(this.overlays.keys());
  }

  // ─── Available Routes (for filter UI) ────────────────────

  /** Get all distinct routes with counts */
  getRoutes(): { route: string; count: number }[] {
    const result: { route: string; count: number }[] = [];
    for (const [route, drugs] of this.byRoute) {
      result.push({ route, count: drugs.length });
    }
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  // ─── Checkpoint ──────────────────────────────────────────

  /** Export state for checkpoint */
  exportState(): FormularyServiceState {
    const overlays: FormularyServiceState['overlays'] = {};
    for (const [key, overlay] of this.overlays) {
      overlays[key] = {
        planIdHash: overlay.planIdHash,
        planName: overlay.planName,
        overrides: Object.fromEntries(overlay.overrides),
        defaults: overlay.defaults,
        publishedAt: overlay.publishedAt,
        version: overlay.version,
      };
    }
    return {
      formularyRoot: this.getRootString(),
      drugCount: this.allDrugs.length,
      overlays,
    };
  }

  /** Restore state from checkpoint (drugs must already be loaded via loadFromNadac) */
  restoreState(state: FormularyServiceState): void {
    this.overlays.clear();
    if (state.overlays) {
      for (const [key, data] of Object.entries(state.overlays)) {
        const overrideMap = new Map<string, DrugOverride>();
        for (const [ndcHash, ovr] of Object.entries(data.overrides)) {
          overrideMap.set(ndcHash, ovr);
        }
        this.overlays.set(key, {
          planIdHash: data.planIdHash,
          planName: data.planName,
          overrides: overrideMap,
          defaults: data.defaults,
          publishedAt: data.publishedAt,
          version: data.version,
        });
      }
    }

    // Verify root integrity after restore
    const rebuiltRoot = this.tree.getRoot().toString();
    if (state.formularyRoot && rebuiltRoot !== state.formularyRoot) {
      console.warn(`[Formulary] Root mismatch after restore: expected ${state.formularyRoot}, got ${rebuiltRoot}`);
    }
  }

  // ─── Internal ────────────────────────────────────────────

  private applyOverlay(drug: FormularyDrug, overlay: PlanOverlay | null): FormularyDrugWithPlan {
    const ovr = overlay?.overrides.get(drug.ndcHash);
    const tierLevel = ovr?.tierLevel ?? drug.defaultTier;
    let copayAmount = ovr?.copayAmount ?? drug.defaultCopay;

    if (!ovr?.copayAmount && overlay) {
      const tierKey = `tier${tierLevel}Copay` as keyof PlanDefaults;
      copayAmount = overlay.defaults[tierKey] ?? drug.defaultCopay;
    }

    return {
      ndc: drug.ndc,
      ndcHash: drug.ndcHash,
      ndcFormatted: drug.ndcFormatted,
      genericName: drug.genericName,
      brandName: drug.brandName,
      strength: drug.strength,
      dosageForm: drug.dosageForm,
      route: drug.route,
      classification: drug.classification,
      nadacPerUnit: drug.nadacPerUnit,
      tierLevel,
      copayAmount,
      requiresPriorAuth: ovr?.requiresPriorAuth ?? drug.requiresPriorAuth,
      excluded: ovr?.excluded ?? false,
      maxQuantityPerFill: drug.maxQuantityPerFill,
      maxDaySupply: drug.maxDaySupply,
      stepTherapyRequired: drug.stepTherapyRequired,
    };
  }
}

// ─── Description Parser (duplicated from src/data/index.ts to avoid circular deps) ──

const DOSAGE_FORMS = [
  'TABLET', 'CAPSULE', 'SOLUTION', 'SUSPENSION', 'INJECTION', 'CREAM',
  'OINTMENT', 'GEL', 'PATCH', 'INHALER', 'SPRAY', 'DROPS', 'SUPPOSITORY',
  'POWDER', 'LIQUID', 'SYRUP', 'LOTION', 'FOAM', 'AEROSOL', 'ENEMA',
  'IMPLANT', 'FILM', 'GRANULES', 'PELLETS', 'RING', 'INSERT', 'KIT',
  'SWAB', 'SHAMPOO', 'EMULSION', 'PASTE', 'STRIP', 'WAFER', 'LOZENGE',
  'ELIXIR', 'TINCTURE', 'OIL', 'VIAL', 'PEN', 'SYRINGE', 'CARTRIDGE',
  'AMPULE', 'PACKET', 'SACHET', 'POUCH', 'CHEWABLE', 'DELAYED-RELEASE',
  'EXTENDED-RELEASE', 'ER', 'DR', 'CR', 'SR', 'XR', 'XL', 'LA', 'HFA',
  'MDI', 'DPI', 'OPHTHALMIC', 'OTIC', 'NASAL', 'RECTAL', 'VAGINAL',
  'TOPICAL', 'ORAL', 'SUBLINGUAL', 'BUCCAL', 'TRANSDERMAL',
];

function parseDescription(desc: string): { genericName: string; strength: string; dosageForm: string } {
  const parts = desc.split(/\s+/);
  let strengthIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d/.test(parts[i]) && i + 1 < parts.length &&
        /^(MG|MCG|ML|MG\/ML|MCG\/ML|%|UNIT|GM|GR|MEQ|IU|MG\/HR|MCG\/HR|MG\/ACTUATION|MCG\/ACTUATION)$/i.test(parts[i + 1])) {
      strengthIdx = i;
      break;
    }
    if (/^\d+\.?\d*(MG|MCG|ML|%)$/i.test(parts[i])) {
      strengthIdx = i;
      break;
    }
  }

  if (strengthIdx > 0) {
    const genericName = parts.slice(0, strengthIdx).join(' ');
    let dosageIdx = parts.length;
    for (let i = strengthIdx; i < parts.length; i++) {
      if (DOSAGE_FORMS.some(f => parts[i].toUpperCase().includes(f))) {
        dosageIdx = i;
        break;
      }
    }
    const strength = parts.slice(strengthIdx, dosageIdx).join(' ');
    const dosageForm = dosageIdx < parts.length ? parts.slice(dosageIdx).join(' ') : '';
    return { genericName, strength, dosageForm };
  }

  return { genericName: desc, strength: '', dosageForm: '' };
}

function guessRoute(dosageForm: string): string {
  const df = dosageForm.toUpperCase();
  if (df.includes('OPHTHALMIC')) return 'Ophthalmic';
  if (df.includes('OTIC')) return 'Otic';
  if (df.includes('NASAL')) return 'Nasal';
  if (df.includes('RECTAL') || df.includes('SUPPOSITORY') || df.includes('ENEMA')) return 'Rectal';
  if (df.includes('VAGINAL') || df.includes('INSERT') || df.includes('RING')) return 'Vaginal';
  if (df.includes('TOPICAL') || df.includes('CREAM') || df.includes('OINTMENT') ||
      df.includes('GEL') || df.includes('LOTION') || df.includes('FOAM') ||
      df.includes('SHAMPOO') || df.includes('PATCH') || df.includes('TRANSDERMAL')) return 'Topical';
  if (df.includes('INJECTION') || df.includes('SYRINGE') || df.includes('VIAL') ||
      df.includes('AMPULE') || df.includes('CARTRIDGE')) return 'Injectable';
  if (df.includes('INHALER') || df.includes('HFA') || df.includes('MDI') ||
      df.includes('DPI') || df.includes('AEROSOL') || df.includes('INHALATION')) return 'Inhalation';
  if (df.includes('SUBLINGUAL')) return 'Sublingual';
  if (df.includes('BUCCAL')) return 'Buccal';
  return 'Oral';
}
