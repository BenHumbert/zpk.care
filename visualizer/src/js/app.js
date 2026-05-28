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
 * App — Entry point for the Adjuda-GATOR Visualizer.
 *
 * Initializes SSE connections, creates all modules, and dispatches events.
 */

import { EventBus } from './event-bus.js';
import { EntityRegistry } from './entity-registry.js';
import { NodeView } from './node-view.js';
import { LaneRenderer } from './lane-renderer.js';
import { StatsPanel } from './stats-panel.js';
import { InsurerPanel } from './insurer-panel.js';
import { RelationshipGraph } from './relationship-graph.js';
import { Timeline } from './timeline.js';

const BASE_URL = 'http://127.0.0.1:3030';

// ─── Initialize Modules ──────────────────────────────

const bus = new EventBus(BASE_URL);
const entities = new EntityRegistry();

const nodeViewContainer = document.getElementById('node-view-container');
const laneContainer = document.getElementById('lane-container');
const eventLogContainer = document.getElementById('event-log');
const relationshipContainer = document.getElementById('relationship-graph');

const nodeView = new NodeView(nodeViewContainer);
const lanes = new LaneRenderer(laneContainer);
const stats = new StatsPanel();
const insurer = new InsurerPanel();
const relationships = new RelationshipGraph(relationshipContainer);
const timeline = new Timeline(eventLogContainer);

// ─── Status Indicator ─────────────────────────────────

const statusBadge = document.getElementById('connection-status');
const eventCountEl = document.getElementById('event-count');
let eventCount = 0;

function setConnected(connected) {
  if (statusBadge) {
    statusBadge.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
    statusBadge.className = connected
      ? 'badge inline bg-green fg-white'
      : 'badge inline bg-red fg-white';
  }
}

// ─── Network Status KPIs ──────────────────────────────

const kpiEls = {
  sequencer:    { kpi: document.getElementById('kpi-sequencer'),    dot: null, val: document.getElementById('kpi-sequencer-val') },
  contract:     { kpi: document.getElementById('kpi-contract'),     dot: null, val: document.getElementById('kpi-contract-val') },
  members:      { kpi: document.getElementById('kpi-members'),      dot: null, val: document.getElementById('kpi-members-val') },
  prescribers:  { kpi: document.getElementById('kpi-prescribers'),  dot: null, val: document.getElementById('kpi-prescribers-val') },
  pharmacies:   { kpi: document.getElementById('kpi-pharmacies'),   dot: null, val: document.getElementById('kpi-pharmacies-val') },
  insurer:      { kpi: document.getElementById('kpi-insurer'),      dot: null, val: document.getElementById('kpi-insurer-val') },
};

// Grab dot elements
for (const key of Object.keys(kpiEls)) {
  const kpi = kpiEls[key].kpi;
  if (kpi) kpiEls[key].dot = kpi.querySelector('.net-dot');
}

const nodeStatus = {
  sequencerOnline: false,
  contractActive: false,
  memberCount: 0,
  prescriberCount: 0,
  pharmacyCount: 0,
  insurerOnline: false,
  membersActive: new Set(),
  prescribersActive: new Set(),
  pharmaciesActive: new Set(),
};

function setKpi(key, online, label) {
  const el = kpiEls[key];
  if (!el) return;
  if (el.dot) {
    el.dot.className = online ? 'net-dot dot-online' : 'net-dot dot-offline';
  }
  if (el.val) {
    el.val.textContent = label;
  }
}

function updateNetworkStatus() {
  setKpi('sequencer', nodeStatus.sequencerOnline,
    nodeStatus.sequencerOnline ? 'Connected' : 'Offline');

  setKpi('contract', nodeStatus.contractActive,
    nodeStatus.contractActive ? 'Active' : 'Inactive');

  const mc = nodeStatus.membersActive.size;
  setKpi('members', mc > 0, `${mc} online`);

  const pc = nodeStatus.prescribersActive.size;
  setKpi('prescribers', pc > 0, `${pc} online`);

  const phc = nodeStatus.pharmaciesActive.size;
  setKpi('pharmacies', phc > 0, `${phc} online`);

  setKpi('insurer', nodeStatus.insurerOnline,
    nodeStatus.insurerOnline ? 'Active' : 'Offline');
}

/** Track which node types are active based on viz events */
function trackNodeActivity(event) {
  if (!event.type?.startsWith('viz:')) return;

  // Any event means sequencer is online
  nodeStatus.sequencerOnline = true;

  // Track actor types seen
  if (event.actorType === 'member' && event.actor) {
    nodeStatus.membersActive.add(event.actor);
  }
  if (event.actorType === 'prescriber' && event.actor) {
    nodeStatus.prescribersActive.add(event.actor);
  }
  if (event.actorType === 'pharmacy' && event.actor) {
    nodeStatus.pharmaciesActive.add(event.actor);
  }
  if (event.actorType === 'insurer') {
    nodeStatus.insurerOnline = true;
  }

  // Track targets too
  if (event.targetType === 'member' && event.target) {
    nodeStatus.membersActive.add(event.target);
  }
  if (event.targetType === 'prescriber' && event.target) {
    nodeStatus.prescribersActive.add(event.target);
  }
  if (event.targetType === 'pharmacy' && event.target) {
    nodeStatus.pharmaciesActive.add(event.target);
  }
  if (event.targetType === 'insurer') {
    nodeStatus.insurerOnline = true;
  }

  // Enrollment or fulfillment events imply CareContract is active
  if (event.type.includes('enrollment:complete') ||
      event.type.includes('fulfillment:settled') ||
      event.type.includes('batch:settled')) {
    nodeStatus.contractActive = true;
  }

  updateNetworkStatus();
}

// ─── Uptime Timer ─────────────────────────────────────

const uptimeEl = document.getElementById('kpi-uptime');
let uptimeStart = null;

function updateUptime() {
  if (!uptimeStart || !uptimeEl) return;
  const elapsed = Math.floor((Date.now() - uptimeStart) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  uptimeEl.textContent = `${mm}:${ss}`;
}

setInterval(updateUptime, 1000);

// ─── Event Dispatch ───────────────────────────────────

bus.subscribe((event) => {
  // Connection status
  if (event.type === 'bus:connected') {
    setConnected(true);
    nodeStatus.sequencerOnline = true;
    if (!uptimeStart) uptimeStart = Date.now();
    updateNetworkStatus();
    return;
  }
  if (event.type === 'bus:disconnected') {
    setConnected(false);
    nodeStatus.sequencerOnline = false;
    updateNetworkStatus();
    return;
  }

  // Count viz events
  if (event.type?.startsWith('viz:')) {
    eventCount++;
    if (eventCountEl) eventCountEl.textContent = `${eventCount} events`;
  }

  // Track network node activity
  trackNodeActivity(event);

  // Dispatch to all modules
  nodeView.handleEvent(event);
  lanes.handleEvent(event);
  stats.handleEvent(event);
  insurer.handleEvent(event);
  relationships.handleEvent(event);
  timeline.handleEvent(event);
});

// ─── Clear Button ────────────────────────────────────

const clearBtn = document.getElementById('btn-clear');
if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    try {
      await fetch(`${BASE_URL}/viz/clear`, { method: 'POST' });
    } catch { /* server may be down */ }

    // Reset local state
    eventCount = 0;
    if (eventCountEl) eventCountEl.textContent = '0 events';
    if (uptimeStart) uptimeStart = Date.now();

    // Reset network KPIs
    nodeStatus.sequencerOnline = false;
    nodeStatus.contractActive = false;
    nodeStatus.membersActive.clear();
    nodeStatus.prescribersActive.clear();
    nodeStatus.pharmaciesActive.clear();
    nodeStatus.insurerOnline = false;
    updateNetworkStatus();

    // Re-initialize all modules
    nodeView.init();
    lanes.init();
    stats.init();
    insurer.init();
    relationships.init();
    timeline.init();

    // Reconnect SSE (picks up fresh empty buffer)
    bus.disconnect();
    bus.connect();

    console.log('[Visualizer] Cleared — waiting for fresh events.');
  });
}

// ─── Start ────────────────────────────────────────────

async function init() {
  console.log('[Visualizer] Connecting to', BASE_URL);

  // Fetch entity registry (may fail if server not up yet)
  await entities.fetch(BASE_URL);

  // Pre-populate node counts from entity registry
  const allEntities = entities.getAll();
  for (const ent of allEntities) {
    if (ent.type === 'member')     nodeStatus.memberCount++;
    if (ent.type === 'prescriber') nodeStatus.prescriberCount++;
    if (ent.type === 'pharmacy')   nodeStatus.pharmacyCount++;
    if (ent.type === 'insurer')    nodeStatus.insurerOnline = true;
  }
  updateNetworkStatus();

  // Connect to SSE streams
  bus.connect();

  console.log('[Visualizer] Ready. Waiting for events...');
}

init().catch((err) => {
  console.error('[Visualizer] Init error:', err);
  // Retry after delay
  setTimeout(() => init(), 3000);
});
