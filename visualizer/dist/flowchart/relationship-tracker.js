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
 * relationship-tracker.js — Manages structural links between entities.
 *
 * Creates D3 force links that pull related entities together:
 *   - member → prescriber (PCP assignment)
 *   - member → pharmacy (fill relationships)
 */

class RelationshipTracker {
  constructor() {
    /** @type {Map<string, {source: string, target: string, type: string, distance: number, strength: number}>} */
    this.links = new Map();
  }

  /**
   * Recompute all relationship links from current state.
   * @param {Object} params
   * @param {Array} params.members - Enrolled members from /interactive/state
   * @param {Array} params.leviathans - Leviathan visual state
   * @param {Object} params.partitionMap - {partitionIndex: leviathanId}
   * @param {number} params.partitionCount - Number of partitions (3)
   * @param {Array} params.prescriptions - Active prescriptions
   */
  update({ members = [], leviathans = [], partitionMap = {}, partitionCount = 3, prescriptions = [] }) {
    this.links.clear();

    // Member → Prescriber (PCP)
    for (const m of members) {
      if (m.pcpAssignment) {
        this.links.set(`m2p:${m.walletId}`, {
          source: `member-${m.memberIndex}`,
          target: `prescriber-${m.pcpAssignment.prescriberIndex}`,
          type: 'member-prescriber',
          distance: 150,
          strength: 0.03,
        });
      }
    }

    // Prescription → Pharmacy links
    for (const rx of prescriptions) {
      if (rx.status === 'FILLED' || rx.status === 'DISPENSED') {
        const memberId = this.findMemberNodeId(rx.memberWalletId, members);
        if (memberId) {
          const key = `rx:${rx.id}`;
          this.links.set(key, {
            source: memberId,
            target: `pharmacy-${rx.pharmacyIndex}`,
            type: 'member-pharmacy',
            distance: 160,
            strength: 0.02,
          });
        }
      }
    }
  }

  /**
   * Find the node ID for a member by walletId.
   */
  findMemberNodeId(walletId, members) {
    const m = members.find(m => m.walletId === walletId || String(m.walletId) === String(walletId));
    return m ? `member-${m.memberIndex}` : null;
  }

  /**
   * Get all links as an array for D3 force simulation.
   * @returns {Array}
   */
  getLinks() {
    return Array.from(this.links.values());
  }

  /**
   * Get links filtered by type.
   */
  getLinksByType(type) {
    return this.getLinks().filter(l => l.type === type);
  }
}
