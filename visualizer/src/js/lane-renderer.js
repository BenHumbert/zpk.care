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
 * LaneRenderer — Horse-race style visualization engine.
 *
 * Creates 6 horizontal lanes. Events appear as "chips" that animate
 * left-to-right through stages, like carnival horse racing.
 */

import { LANE_ICONS, describeEvent } from './utils.js';

/** Lane definitions: name, stage labels */
const LANE_DEFS = [
  { id: 'enrollment',   label: 'Enrollment',   stages: ['Token Gen', 'Token Used', 'Enrolling', 'Credential Issued', 'ELIGIBLE'] },
  { id: 'eligibility',  label: 'Eligibility',  stages: ['Check', 'Verified', 'Formulary', 'On Formulary'] },
  { id: 'prescription', label: 'Prescription', stages: ['Written', 'eScript Sent', 'Received', 'Status'] },
  { id: 'fulfillment',  label: 'Fulfillment',  stages: ['Fill Started', 'Settled', 'Accum Updated', 'Batched', 'L1 Settled'] },
  { id: 'messaging',    label: 'Messaging',    stages: ['Composed', 'Encrypted', 'Sent', 'Received', 'Decrypted'] },
  { id: 'batch',        label: 'Batch',        stages: ['Pending', 'Building', 'Settling', 'SETTLED'] },
];

export class LaneRenderer {
  constructor(containerEl) {
    this.container = containerEl;
    /** @type {Map<string, {trackEl: HTMLElement, chipsEl: HTMLElement, stageDefs: string[]}>} */
    this.lanes = new Map();
    /** @type {Map<string, {chipEl: HTMLElement, lane: string, stage: number}>} */
    this.chips = new Map();
    this.chipCounter = 0;

    this.init();
  }

  /** Build all lane DOM elements (also resets internal state) */
  init() {
    this.lanes = new Map();
    this.chips = new Map();
    this.chipCounter = 0;
    this.container.innerHTML = '';

    for (const def of LANE_DEFS) {
      const lane = document.createElement('div');
      lane.className = `lane lane-${def.id}`;

      // Header
      const header = document.createElement('div');
      header.className = 'lane-header';

      const icon = document.createElement('div');
      icon.className = 'lane-icon';
      icon.textContent = LANE_ICONS[def.id] || '';

      const label = document.createElement('div');
      label.className = 'lane-label';
      label.textContent = def.label;

      header.appendChild(icon);
      header.appendChild(label);

      // Stage track (markers)
      const track = document.createElement('div');
      track.className = 'lane-track';

      for (const stageName of def.stages) {
        const marker = document.createElement('div');
        marker.className = 'stage-marker';
        marker.textContent = stageName;
        track.appendChild(marker);
      }

      // Chips container
      const chips = document.createElement('div');
      chips.className = 'lane-chips';

      lane.appendChild(header);
      lane.appendChild(track);
      lane.appendChild(chips);
      this.container.appendChild(lane);

      this.lanes.set(def.id, { trackEl: track, chipsEl: chips, stageDefs: def.stages });
    }
  }

  /**
   * Handle a viz event — create or advance a chip in the appropriate lane.
   */
  handleEvent(event) {
    if (!event.type?.startsWith('viz:')) return;
    if (!event.lane) return;

    const laneData = this.lanes.get(event.lane);
    if (!laneData) return;

    // Generate a chip key based on actor + lane context
    const chipKey = this.getChipKey(event);
    let chipInfo = this.chips.get(chipKey);

    if (!chipInfo) {
      // Create new chip
      const chipEl = this.createChip(event, laneData);
      laneData.chipsEl.appendChild(chipEl);
      chipInfo = { chipEl, lane: event.lane, stage: event.stage };
      this.chips.set(chipKey, chipInfo);
    } else {
      // Advance existing chip
      chipInfo.stage = event.stage;
      this.updateChip(chipInfo, event, laneData);
    }
  }

  /** Generate a unique key for a chip based on the event context */
  getChipKey(event) {
    // For messaging, each message is unique
    if (event.lane === 'messaging') {
      return event.id;
    }
    // For other lanes, group by actor within the lane
    return `${event.lane}:${event.actor}:${event.data?.drug || event.data?.tokenId || event.data?.batchNumber || this.chipCounter++}`;
  }

  /** Create a chip DOM element */
  createChip(event, laneData) {
    const chip = document.createElement('div');
    const actorType = event.actorType || 'member';
    chip.className = `chip chip-${actorType} active`;

    // Progress bar background
    const progress = document.createElement('div');
    progress.className = 'chip-progress';
    const pct = ((event.stage + 1) / event.totalStages) * 100;
    progress.style.width = `${pct}%`;

    // Content
    const content = document.createElement('div');
    content.className = 'chip-content';

    const dot = document.createElement('span');
    dot.className = 'chip-dot';

    const actor = document.createElement('span');
    actor.className = 'chip-actor';
    actor.textContent = event.actor;

    const detail = document.createElement('span');
    detail.className = 'chip-detail';
    detail.textContent = this.getChipDetail(event);

    const status = document.createElement('span');
    status.className = 'chip-status';
    status.textContent = laneData.stageDefs[event.stage] || '';

    content.appendChild(dot);
    content.appendChild(actor);
    content.appendChild(detail);
    content.appendChild(status);

    chip.appendChild(progress);
    chip.appendChild(content);

    // Mark complete if at final stage
    if (event.stage >= event.totalStages - 1) {
      chip.classList.remove('active');
      chip.classList.add('completed');
      status.textContent += ' \u2714';
    }

    return chip;
  }

  /** Update an existing chip to a new stage */
  updateChip(chipInfo, event, laneData) {
    const chip = chipInfo.chipEl;
    const progress = chip.querySelector('.chip-progress');
    const status = chip.querySelector('.chip-status');
    const detail = chip.querySelector('.chip-detail');

    // Update progress bar
    const pct = ((event.stage + 1) / event.totalStages) * 100;
    if (progress) progress.style.width = `${pct}%`;

    // Update status label
    if (status) {
      status.textContent = laneData.stageDefs[event.stage] || '';
    }

    // Update detail
    if (detail) {
      const newDetail = this.getChipDetail(event);
      if (newDetail) detail.textContent = newDetail;
    }

    // Mark complete if at final stage
    if (event.stage >= event.totalStages - 1) {
      chip.classList.remove('active');
      chip.classList.add('completed');
      if (status) status.textContent += ' \u2714';
    }
  }

  /** Get a short detail string for a chip */
  getChipDetail(event) {
    const d = event.data || {};

    if (d.drug) return ` \u2014 ${d.drug}`;
    if (d.medication) return ` \u2014 ${d.medication}`;
    if (d.messageType) {
      const target = event.target ? ` \u2192 ${event.target}` : '';
      return ` ${d.messageType}${target}`;
    }
    if (d.tokenId) return ` \u2014 ${d.tokenId}`;
    if (d.lifecycle) return ` \u2014 ${d.lifecycle}`;
    if (d.patientPay) return ` \u2014 Patient: ${d.patientPay}, Plan: ${d.planPay}`;
    if (d.scope) return ` \u2014 ${d.scope} to ${d.delegate || ''}`;
    if (d.batchNumber !== undefined) return ` \u2014 Batch #${d.batchNumber}`;
    if (event.target) return ` \u2192 ${event.target}`;
    return '';
  }
}
