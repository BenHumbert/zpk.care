import { Field } from 'o1js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';
import { FormularyEntry, buildFormularyEntry } from '../access-control/formulary-entry.js';
import type { FormularyEntryLocalData } from '../access-control/formulary-entry.js';
import { EligibilityData } from './eligibility-data.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { ACCUMULATOR_LEAF_INDEX } from '../access-control/accumulator-data.js';

/**
 * Result of a formulary rebuild for one member.
 */
export interface FormularyRebuildResult {
  /** The member's wallet ID (string form) */
  walletId: string;
  /** New EligibilityData with updated formularyRoot */
  newEligibilityData: EligibilityData;
  /** New forest root after rebuilding */
  newForestRoot: Field;
  /** The old formulary root that was replaced */
  oldFormularyRoot: string;
  /** The new formulary root */
  newFormularyRoot: string;
}

/**
 * Published formulary state — stored by the L2 sequencer.
 */
export interface PublishedFormulary {
  /** Plan ID hash (decimal string) — key for lookup */
  planIdHash: string;
  /** The new formulary Merkle root (decimal string) */
  formularyRoot: string;
  /** Serialized FormularyEntryLocalData[] for clients to verify */
  entriesJson: string;
  /** Timestamp when published */
  publishedAt: number;
  /** Version counter (incremented on each update) */
  version: number;
}

/**
 * FormularyUpdateService — manages formulary changes for benefit plans.
 *
 * When an insurer updates a formulary (add/remove drugs, change tiers/copays),
 * each affected member's EligibilityData.formularyRoot must be updated.
 *
 * Flow:
 *   1. Insurer builds new FormularyRegistry from updated entries
 *   2. Publishes to L2 sequencer (stored by planIdHash)
 *   3. SSE broadcasts 'formulary:updated' event to all nodes
 *   4. Member nodes detect update, download new formulary, rebuild forest
 *   5. Admin shortcut: bulk update via updateMemberFormulary()
 *
 * This service is STATELESS — all methods are static.
 * Follows the ReportingService pattern.
 */
export class FormularyUpdateService {
  /**
   * Build a new FormularyRegistry from entries.
   *
   * @returns The registry and its root
   */
  static buildFormulary(entries: FormularyEntryLocalData[]): {
    registry: FormularyRegistry;
    root: Field;
    formularyEntries: FormularyEntry[];
  } {
    const registry = new FormularyRegistry();
    const formularyEntries: FormularyEntry[] = [];

    for (const entryLocal of entries) {
      const entry = buildFormularyEntry(entryLocal);
      formularyEntries.push(entry);
      registry.addEntry(entry);
    }

    return {
      registry,
      root: registry.getRoot(),
      formularyEntries,
    };
  }

  /**
   * Rebuild a member's forest after a formulary change.
   *
   * Replaces the EligibilityData in the ACCESS_CONTROL tree with
   * a new version that has the updated formularyRoot. The accumulator
   * data at leaf 127 is preserved.
   *
   * @param forest — the member's current MerkleForest (mutated in-place)
   * @param currentEligData — the member's current EligibilityData
   * @param newFormularyRoot — the new formulary Merkle root
   * @returns New EligibilityData and new forest root
   */
  static rebuildMemberForest(
    forest: MerkleForest,
    currentEligData: EligibilityData,
    newFormularyRoot: Field,
  ): { newEligibilityData: EligibilityData; newForestRoot: Field } {
    // Build new EligibilityData with updated formularyRoot
    const newEligibilityData = new EligibilityData({
      planIdHash: currentEligData.planIdHash,
      groupIdHash: currentEligData.groupIdHash,
      effectiveDate: currentEligData.effectiveDate,
      terminationDate: currentEligData.terminationDate,
      copayAmountCents: currentEligData.copayAmountCents,
      coverageType: currentEligData.coverageType,
      formularyRoot: newFormularyRoot,
      networkRoot: currentEligData.networkRoot,
    });

    // Replace eligibility data in ACCESS_CONTROL tree (leaf 0)
    forest.setLeaf(
      ForestDomain.ACCESS_CONTROL,
      0n,
      newEligibilityData.commitment(),
    );

    return {
      newEligibilityData,
      newForestRoot: forest.getForestRoot(),
    };
  }

  /**
   * Compute the diff between two formularies.
   *
   * @returns Lists of added, removed, and changed entries
   */
  static diffFormularies(
    oldEntries: FormularyEntryLocalData[],
    newEntries: FormularyEntryLocalData[],
  ): {
    added: FormularyEntryLocalData[];
    removed: FormularyEntryLocalData[];
    changed: FormularyEntryLocalData[];
  } {
    const oldMap = new Map(oldEntries.map(e => [e.ndc, e]));
    const newMap = new Map(newEntries.map(e => [e.ndc, e]));

    const added: FormularyEntryLocalData[] = [];
    const removed: FormularyEntryLocalData[] = [];
    const changed: FormularyEntryLocalData[] = [];

    for (const [ndc, entry] of newMap) {
      const oldEntry = oldMap.get(ndc);
      if (!oldEntry) {
        added.push(entry);
      } else if (JSON.stringify(oldEntry) !== JSON.stringify(entry)) {
        changed.push(entry);
      }
    }

    for (const [ndc, entry] of oldMap) {
      if (!newMap.has(ndc)) {
        removed.push(entry);
      }
    }

    return { added, removed, changed };
  }
}
