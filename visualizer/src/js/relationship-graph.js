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
 * RelationshipGraph — Shows member → prescriber → pharmacy connections
 * as a visual flow diagram built from prescription events.
 */

import { ACTOR_COLORS } from './utils.js';

export class RelationshipGraph {
  constructor(containerEl) {
    this.container = containerEl;
    this.init();
  }

  init() {
    /** @type {Map<string, Set<string>>} member → prescribers */
    this.memberToPrescriber = new Map();
    /** @type {Map<string, Set<string>>} prescriber → pharmacies */
    this.prescriberToPharmacy = new Map();
    /** @type {Map<string, string>} name → actorType */
    this.actorTypes = new Map();
    if (this.container) this.container.innerHTML = '';
  }

  /** Handle viz events to build relationships */
  handleEvent(event) {
    if (!event.type?.startsWith('viz:')) return;

    // Track actor types
    if (event.actor && event.actorType) {
      this.actorTypes.set(event.actor, event.actorType);
    }
    if (event.target && event.targetType) {
      this.actorTypes.set(event.target, event.targetType);
    }

    switch (event.type) {
      case 'viz:prescription:written': {
        // prescriber wrote rx for member
        const member = event.target;
        const prescriber = event.actor;
        if (member && prescriber) {
          if (!this.memberToPrescriber.has(member)) {
            this.memberToPrescriber.set(member, new Set());
          }
          this.memberToPrescriber.get(member).add(prescriber);
        }
        break;
      }
      case 'viz:prescription:sent': {
        // prescriber sent to pharmacy
        const prescriber = event.actor;
        const pharmacy = event.target;
        if (prescriber && pharmacy) {
          if (!this.prescriberToPharmacy.has(prescriber)) {
            this.prescriberToPharmacy.set(prescriber, new Set());
          }
          this.prescriberToPharmacy.get(prescriber).add(pharmacy);
        }
        break;
      }
    }

    this.render();
  }

  render() {
    this.container.innerHTML = '';

    // Collect unique nodes per column
    const members = new Set();
    const prescribers = new Set();
    const pharmacies = new Set();

    for (const [member, prescriberSet] of this.memberToPrescriber) {
      members.add(member);
      for (const p of prescriberSet) prescribers.add(p);
    }
    for (const [prescriber, pharmacySet] of this.prescriberToPharmacy) {
      prescribers.add(prescriber);
      for (const ph of pharmacySet) pharmacies.add(ph);
    }

    if (members.size === 0 && prescribers.size === 0) return;

    const memberArr = [...members];
    const prescriberArr = [...prescribers];
    const pharmacyArr = [...pharmacies];

    // Calculate SVG dimensions
    const colWidth = 220;
    const nodeHeight = 40;
    const nodeGap = 16;
    const svgWidth = colWidth * 3 + 80;
    const maxRows = Math.max(memberArr.length, prescriberArr.length, pharmacyArr.length, 1);
    const svgHeight = maxRows * (nodeHeight + nodeGap) + 80;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
    svg.style.maxHeight = '400px';

    // Column headers
    this.addText(svg, colWidth * 0 + 40, 24, 'MEMBERS', '#4fc3f7', 12, 'bold');
    this.addText(svg, colWidth * 1 + 40, 24, 'PRESCRIBERS', '#66bb6a', 12, 'bold');
    this.addText(svg, colWidth * 2 + 40, 24, 'PHARMACIES', '#ffa726', 12, 'bold');

    // Node positions
    const positions = new Map();
    const startY = 50;

    // Place nodes
    for (let i = 0; i < memberArr.length; i++) {
      const y = startY + i * (nodeHeight + nodeGap);
      positions.set(memberArr[i], { x: 40, y, col: 0 });
      this.addNode(svg, 40, y, colWidth - 60, nodeHeight, memberArr[i], 'member');
    }
    for (let i = 0; i < prescriberArr.length; i++) {
      const y = startY + i * (nodeHeight + nodeGap);
      positions.set(prescriberArr[i], { x: colWidth + 40, y, col: 1 });
      this.addNode(svg, colWidth + 40, y, colWidth - 60, nodeHeight, prescriberArr[i], 'prescriber');
    }
    for (let i = 0; i < pharmacyArr.length; i++) {
      const y = startY + i * (nodeHeight + nodeGap);
      positions.set(pharmacyArr[i], { x: colWidth * 2 + 40, y, col: 2 });
      this.addNode(svg, colWidth * 2 + 40, y, colWidth - 60, nodeHeight, pharmacyArr[i], 'pharmacy');
    }

    // Draw edges (member → prescriber)
    for (const [member, prescriberSet] of this.memberToPrescriber) {
      const from = positions.get(member);
      if (!from) continue;
      for (const prescriber of prescriberSet) {
        const to = positions.get(prescriber);
        if (!to) continue;
        this.addEdge(svg, from.x + colWidth - 60, from.y + nodeHeight / 2,
          to.x, to.y + nodeHeight / 2, '#4fc3f7');
      }
    }

    // Draw edges (prescriber → pharmacy)
    for (const [prescriber, pharmacySet] of this.prescriberToPharmacy) {
      const from = positions.get(prescriber);
      if (!from) continue;
      for (const pharmacy of pharmacySet) {
        const to = positions.get(pharmacy);
        if (!to) continue;
        this.addEdge(svg, from.x + colWidth - 60, from.y + nodeHeight / 2,
          to.x, to.y + nodeHeight / 2, '#66bb6a');
      }
    }

    this.container.appendChild(svg);
  }

  addNode(svg, x, y, w, h, label, type) {
    const color = ACTOR_COLORS[type] || '#888';

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
    rect.setAttribute('rx', 6);
    rect.setAttribute('fill', '#16213e');
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', 2);
    svg.appendChild(rect);

    this.addText(svg, x + w / 2, y + h / 2 + 4, label, color, 11, 'normal', 'middle');
  }

  addEdge(svg, x1, y1, x2, y2, color) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mx = (x1 + x2) / 2;
    path.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', 2);
    path.setAttribute('stroke-opacity', 0.5);
    // Insert before nodes so edges are behind
    svg.insertBefore(path, svg.firstChild);
  }

  addText(svg, x, y, text, fill, size, weight = 'normal', anchor = 'start') {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    el.setAttribute('x', x);
    el.setAttribute('y', y);
    el.setAttribute('fill', fill);
    el.setAttribute('font-size', size);
    el.setAttribute('font-weight', weight);
    el.setAttribute('text-anchor', anchor);
    el.setAttribute('font-family', 'sans-serif');
    el.textContent = text;
    svg.appendChild(el);
  }
}
