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
 * Timeline — Scrolling chronological event log.
 */

import { formatTime, describeEvent, LANE_COLORS } from './utils.js';

export class Timeline {
  constructor(containerEl) {
    this.container = containerEl;
    this.maxEntries = 500;
  }

  init() {
    if (this.container) this.container.innerHTML = '';
  }

  /** Handle a new event */
  handleEvent(event) {
    // Skip internal bus events
    if (event.type?.startsWith('bus:')) return;
    // Skip chain events that aren't interesting
    if (event.type === 'node:tick') return;

    const entry = document.createElement('div');
    entry.className = 'event-entry';

    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = formatTime(event.timestamp || Date.now());

    const badge = document.createElement('span');
    const lane = event.lane || this.inferLane(event.type);
    badge.className = `event-badge event-badge-${lane}`;
    badge.textContent = lane.toUpperCase();

    const text = document.createElement('span');
    text.className = 'event-text';

    if (event.actor) {
      const actorClass = event.actorType ? `event-actor-${event.actorType}` : '';
      text.innerHTML = `<strong class="${actorClass}">${event.actor}</strong> ${this.escapeHtml(describeEvent(event))}`;
    } else {
      text.innerHTML = this.escapeHtml(describeEvent(event));
    }

    entry.appendChild(time);
    entry.appendChild(badge);
    entry.appendChild(text);

    // Prepend (newest first)
    this.container.insertBefore(entry, this.container.firstChild);

    // Trim old entries
    while (this.container.children.length > this.maxEntries) {
      this.container.removeChild(this.container.lastChild);
    }
  }

  /** Infer lane from chain event types */
  inferLane(type) {
    if (!type) return 'batch';
    if (type.includes('enrollment') || type.includes('token')) return 'enrollment';
    if (type.includes('eligibility') || type.includes('formulary')) return 'eligibility';
    if (type.includes('prescription')) return 'prescription';
    if (type.includes('fulfillment') || type.includes('accumulator') || type.includes('reversal')) return 'fulfillment';
    if (type.includes('message') || type.includes('delegation')) return 'messaging';
    return 'batch';
  }

  /** Escape HTML to prevent XSS */
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
