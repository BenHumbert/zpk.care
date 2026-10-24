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
 * Sequencer Dashboard — Live console + L2 chain status page.
 *
 * Left panel: Real-time SSE console stream with type filters.
 * Right panel: Sequencer status, action buttons, receipts, batches, audit chain.
 *
 * Every read and action here answers the network operator only. The console stream carries the
 * operator's token in its URL, since an EventSource sends no header; the chain status, which lists
 * every receipt's wallet and the audit log (the operator's since the sweep of the open routes,
 * 2026-10-24), and the actions carry it in the header operator-auth.js attaches to every
 * /interactive/ request this page makes, asking for the token when the sequencer refuses one.
 */

import { API_BASE, fetchJson, truncHash } from './node-common.js';
import { withOperatorToken } from './interactive/operator-auth.js';

// ============================================================================
// State
// ============================================================================

let lines = [];
let activeFilter = 'all';
let refreshTimer = null;

// ============================================================================
// Console (Left Panel)
// ============================================================================

function connectConsole() {
  const output = document.getElementById('console-output');
  const es = new EventSource(withOperatorToken(`${API_BASE}/interactive/console`));

  es.addEventListener('console', (e) => {
    const event = JSON.parse(e.data);
    addConsoleLine(output, event);
  });

  es.onopen = () => {
    addSystemLine(output, 'Connected to sequencer console stream');
    updateHealth(true);
  };

  es.onerror = () => {
    addSystemLine(output, 'Connection lost. Reconnecting...');
    updateHealth(false);
  };

  return es;
}

function addConsoleLine(output, event) {
  const ts = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const elapsed = event.elapsedMs ? ` (${(event.elapsedMs / 1000).toFixed(2)}s)` : '';
  const mem = event.memoryMB ? ` [${event.memoryMB} MB]` : '';
  const typeTag = `<span class="console-type-tag type-${event.type}">${event.type.toUpperCase()}</span>`;

  const line = { type: event.type };
  lines.push(line);

  const el = document.createElement('div');
  el.className = `console-line type-${event.type}`;
  el.innerHTML = `<span class="console-ts">[${ts}]</span> ${typeTag} ${escapeHtml(event.message)}${elapsed}${mem}`;

  if (activeFilter !== 'all' && event.type !== activeFilter) {
    el.classList.add('hidden');
  }

  output.appendChild(el);
  scrollToBottom(output);
}

function addSystemLine(output, message) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const el = document.createElement('div');
  el.className = 'console-line type-info';
  el.innerHTML = `<span class="console-ts">[${ts}]</span> <span class="console-type-tag type-info">SYS</span> ${escapeHtml(message)}`;
  output.appendChild(el);
  scrollToBottom(output);
}

function applyFilter(filter) {
  activeFilter = filter;
  const output = document.getElementById('console-output');
  const lineEls = output.querySelectorAll('.console-line');
  lineEls.forEach((el, i) => {
    if (filter === 'all') {
      el.classList.remove('hidden');
    } else {
      const lineType = lines[i]?.type;
      el.classList.toggle('hidden', lineType !== filter);
    }
  });
  scrollToBottom(output);
}

function clearConsole() {
  lines = [];
  document.getElementById('console-output').innerHTML = '';
}

function scrollToBottom(el) {
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================================
// Health Indicator
// ============================================================================

function updateHealth(connected) {
  const dot = document.getElementById('header-health');
  const text = document.getElementById('header-status-text');
  if (connected) {
    dot.classList.remove('disconnected');
    dot.classList.add('connected');
    text.textContent = 'Connected';
  } else {
    dot.classList.remove('connected');
    dot.classList.add('disconnected');
    text.textContent = 'Disconnected';
  }
}

// ============================================================================
// L2 Status (Right Panel)
// ============================================================================

async function fetchL2Status() {
  try {
    // the operator's read: operator-auth.js puts the token on it (imported above, and by node-common.js)
    const data = await fetchJson('/interactive/l2-status');
    renderStatus(data.status);
    renderActions();
    renderReceipts(data.receipts);
    renderBatches(data.batches);
    renderAuditChain(data.auditLog);
    updateHealth(true);
  } catch (err) {
    document.getElementById('section-status').innerHTML = `
      <div class="section-card">
        <div class="card-header sequencer">Sequencer Status</div>
        <div class="card-body" style="text-align:center; padding:24px; color:var(--text-secondary);">
          Unable to fetch status: ${escapeHtml(err.message)}
        </div>
      </div>
    `;
  }
}

function renderStatus(status) {
  if (!status) {
    document.getElementById('section-status').innerHTML = '';
    return;
  }

  const uptime = formatUptime(status.uptimeMs);
  const nextBatch = status.nextBatchInMs > 0
    ? `${Math.ceil(status.nextBatchInMs / 1000)}s`
    : 'Now';

  document.getElementById('section-status').innerHTML = `
    <div class="section-card">
      <div class="card-header sequencer">Sequencer Status</div>
      <div class="card-body">
        <div class="seq-stats-grid">
          ${statBox(status.running ? 'Running' : 'Stopped', 'Status', status.running ? '#4caf50' : '#f44336')}
          ${statBox(uptime, 'Uptime', '#2196f3')}
          ${statBox(status.pendingProofs, 'Pending', '#ffc107')}
          ${statBox(status.totalProofsAccepted, 'Proofs', '#2196f3')}
          ${statBox(status.totalBatchesBuilt, 'Batches', '#ab47bc')}
          ${statBox(status.totalBatchesSettled, 'Settled', '#4caf50')}
          ${statBox(status.totalBatchesFailed, 'Failed', '#f44336')}
          ${statBox(nextBatch, 'Next Batch', '#ff9800')}
        </div>
        <div class="seq-roots">
          <div class="seq-root-item">
            <span class="seq-root-label">Registry Root</span>
            <span class="seq-root-value mono">${truncHash(status.currentRegistryRoot, 8)}</span>
          </div>
          <div class="seq-root-item">
            <span class="seq-root-label">Lifecycle Root</span>
            <span class="seq-root-value mono">${truncHash(status.currentLifecycleRoot, 8)}</span>
          </div>
          <div class="seq-root-item">
            <span class="seq-root-label">Wallet Count</span>
            <span class="seq-root-value">${status.currentWalletCount}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function statBox(value, label, color) {
  return `
    <div class="seq-stat-box">
      <div class="seq-stat-value" style="color: ${color};">${value}</div>
      <div class="seq-stat-label">${label}</div>
    </div>
  `;
}

function renderActions() {
  const container = document.getElementById('section-actions');
  container.innerHTML = `
    <div class="section-card">
      <div class="card-header sequencer">Actions</div>
      <div class="card-body">
        <div class="seq-action-bar">
          <button class="btn-action sequencer" id="btn-force-batch">Force Batch Now</button>
          <button class="btn-action sequencer" id="btn-save-checkpoint">Save Checkpoint</button>
          <button class="btn-action sequencer-warn" id="btn-simulate-failure">Simulate Failure</button>
          <button class="btn-action sequencer" id="btn-retry-batch" disabled>Retry Failed</button>
        </div>
        <div id="action-result" style="margin-top:12px;"></div>
      </div>
    </div>
  `;
  bindActions();
}

function bindActions() {
  const pairs = [
    ['btn-force-batch', 'force-batch'],
    ['btn-save-checkpoint', 'save-checkpoint'],
    ['btn-simulate-failure', 'simulate-batch-failure'],
    ['btn-retry-batch', 'retry-batch'],
  ];
  for (const [id, action] of pairs) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => doAction(action, btn));
  }
}

async function doAction(action, btn) {
  const resultDiv = document.getElementById('action-result');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/interactive/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();

    if (data.error) {
      resultDiv.innerHTML = `<div style="color: #f44336; font-size: 13px;">${escapeHtml(data.error)}</div>`;
    } else {
      resultDiv.innerHTML = `<div style="color: #4caf50; font-size: 13px;">${escapeHtml(data.message || 'Done')}</div>`;
      if (action === 'simulate-batch-failure') {
        const retryBtn = document.getElementById('btn-retry-batch');
        if (retryBtn) retryBtn.disabled = false;
      }
    }

    // Refresh status panels
    await fetchL2Status();
  } catch (err) {
    resultDiv.innerHTML = `<div style="color: #f44336; font-size: 13px;">Failed: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function renderReceipts(receipts) {
  const container = document.getElementById('section-receipts');
  if (!receipts || receipts.length === 0) {
    container.innerHTML = `
      <div class="section-card">
        <div class="card-header sequencer">Receipts (0)</div>
        <div class="card-body" style="text-align:center; padding:20px; color:var(--text-secondary); font-size:13px;">
          No receipts yet. Operations generate StateTransitionProofs.
        </div>
      </div>
    `;
    return;
  }

  const sorted = [...receipts].reverse();
  const rows = sorted.map(r => `
    <tr>
      <td class="mono" style="font-size:11px;" title="${r.receiptId}">${r.receiptId.slice(0, 12)}...</td>
      <td class="mono" style="font-size:11px;" title="${r.walletId}">${truncHash(r.walletId, 6)}</td>
      <td>${r.isRegistration
        ? '<span class="seq-type-badge reg">REG</span>'
        : '<span class="seq-type-badge upd">UPD</span>'}</td>
      <td>${r.sequenceNumber}</td>
      <td><span class="seq-status-badge ${r.l1Status}">${r.l1Status}</span></td>
      <td style="font-size:11px; color:var(--text-secondary);">${formatTime(r.acceptedAt)}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="section-card">
      <div class="card-header sequencer">Receipts (${receipts.length})</div>
      <div class="card-body" style="max-height:300px; overflow-y:auto;">
        <table class="sortable-table">
          <thead>
            <tr>
              <th>Receipt ID</th>
              <th>Wallet</th>
              <th>Type</th>
              <th>Seq #</th>
              <th>L1 Status</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderBatches(batches) {
  const container = document.getElementById('section-batches');
  if (!batches || batches.length === 0) {
    container.innerHTML = `
      <div class="section-card">
        <div class="card-header sequencer">Batches (0)</div>
        <div class="card-body" style="text-align:center; padding:20px; color:var(--text-secondary); font-size:13px;">
          No batches yet. Click "Force Batch Now" or wait for auto-batch.
        </div>
      </div>
    `;
    return;
  }

  const sorted = [...batches].reverse();
  const rows = sorted.map(b => {
    const isEmpty = b.transitionCount === 0 && b.registrationCount === 0;
    return `
    <tr${isEmpty ? ' style="opacity: 0.5;"' : ''}>
      <td style="font-weight:600;">#${b.batchNumber}</td>
      <td>${b.registrationCount}</td>
      <td>${isEmpty ? '<span style="color:var(--text-secondary);">0 (empty)</span>' : b.transitionCount}</td>
      <td><span class="seq-status-badge ${b.l1Status}">${b.l1Status}</span></td>
      <td class="mono" style="font-size:11px;" title="${b.l1TxHash || ''}">${b.l1TxHash ? b.l1TxHash.slice(0, 16) + '...' : '—'}</td>
      <td style="font-size:11px; color:var(--text-secondary);">${formatTime(b.createdAt)}</td>
    </tr>
  `;}).join('');

  container.innerHTML = `
    <div class="section-card">
      <div class="card-header sequencer">Batches (${batches.length})</div>
      <div class="card-body">
        <table class="sortable-table">
          <thead>
            <tr>
              <th>Batch #</th>
              <th>Registrations</th>
              <th>Transitions</th>
              <th>L1 Status</th>
              <th>L1 Tx Hash</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAuditChain(auditLog) {
  const container = document.getElementById('section-audit');
  if (!auditLog) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="section-card">
      <div class="card-header sequencer">Audit Chain (Poseidon Hash Chain)</div>
      <div class="card-body">
        <div class="data-grid" style="grid-template-columns: 160px 1fr;">
          <div class="label">Event Count</div>
          <div class="value" style="color: var(--color-sequencer);">${auditLog.eventCount}</div>
          <div class="label">Latest Chain Hash</div>
          <div class="value mono" style="font-size:11px; word-break:break-all;">${auditLog.latestChainHash || '(genesis)'}</div>
          <div class="label">Genesis Hash</div>
          <div class="value mono" style="font-size:11px; word-break:break-all;">${auditLog.genesisHash || '—'}</div>
          <div class="label">Chain Integrity</div>
          <div class="value" style="color: #4caf50; font-weight:600;">
            ${auditLog.eventCount > 0 ? 'Verified (tamper-evident)' : 'No events'}
          </div>
        </div>
        <div class="seq-hash-formula">
          <span class="hf-fn">Poseidon.hash</span><span class="hf-paren">(</span><span class="hf-args">[prevChainHash, eventCommitment]</span><span class="hf-paren">)</span>
          <span class="hf-eq">=</span>
          <span class="hf-result">${auditLog.latestChainHash ? truncHash(auditLog.latestChainHash, 8) : 'N/A'}</span>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// Helpers
// ============================================================================

function formatUptime(ms) {
  if (!ms || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function formatTime(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleTimeString();
}

// ============================================================================
// Init
// ============================================================================

function init() {
  // Wire filter buttons
  document.querySelectorAll('.console-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.console-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilter(btn.dataset.filter);
    });
  });

  // Wire clear button
  document.getElementById('btn-console-clear').addEventListener('click', clearConsole);

  // Connect SSE console stream
  connectConsole();

  // Initial L2 status fetch
  fetchL2Status();

  // Auto-refresh L2 status every 3s
  refreshTimer = setInterval(fetchL2Status, 3000);
}

init();
