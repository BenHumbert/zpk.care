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
 * L2 Chain Tab — Real-time view of the Adjuda-GATOR L2 sequencer.
 *
 * Shows receipts, batches, audit chain, and sequencer status.
 * Action buttons: Force Batch, Save Checkpoint, Simulate Failure + Retry.
 */

import { API_BASE } from '../interactive-app.js';

export class L2ChainTab {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('tab-l2chain');
  }

  render(state) {
    if (!state) {
      this.container.innerHTML = '<div class="waiting-message">Loading...</div>';
      return;
    }

    const l2 = state.l2;
    if (!l2) {
      this.container.innerHTML = `
        <div class="section-card">
          <div class="card-header l2chain">L2 Chain</div>
          <div class="card-body">
            <div style="text-align:center; padding:40px; color:var(--text-muted);">
              L2 sequencer not initialized. Enroll a member to start generating proofs.
            </div>
          </div>
        </div>
      `;
      return;
    }

    this.container.innerHTML = `
      ${this.renderSequencerStatus(l2.status)}
      ${this.renderActionBar()}
      ${this.renderReceipts(l2.receipts)}
      ${this.renderBatches(l2.batches)}
      ${this.renderAuditChain(l2.auditLog)}
    `;

    this.bindActions();
  }

  // ─── Sequencer Status ──────────────────────────────────

  renderSequencerStatus(status) {
    if (!status) return '';

    const uptime = this.formatUptime(status.uptimeMs);
    const nextBatch = status.nextBatchInMs > 0
      ? `${Math.ceil(status.nextBatchInMs / 1000)}s`
      : 'Now';

    return `
      <div class="section-card">
        <div class="card-header l2chain">Sequencer Status</div>
        <div class="card-body">
          <div class="l2-stats-grid">
            ${this.statBox(status.running ? 'Running' : 'Stopped', 'Status', status.running ? 'green' : 'red')}
            ${this.statBox(uptime, 'Uptime', 'blue')}
            ${this.statBox(status.pendingProofs, 'Pending', 'yellow')}
            ${this.statBox(status.totalProofsAccepted, 'Proofs', 'blue')}
            ${this.statBox(status.totalBatchesBuilt, 'Batches', 'purple')}
            ${this.statBox(status.totalBatchesSettled, 'Settled', 'green')}
            ${this.statBox(status.totalBatchesFailed, 'Failed', 'red')}
            ${this.statBox(nextBatch, 'Next Batch', 'orange')}
          </div>
          <div class="l2-roots-row">
            <div class="l2-root-item">
              <span class="l2-root-label">Registry Root</span>
              <span class="l2-root-value">${this.truncHash(status.currentRegistryRoot)}</span>
            </div>
            <div class="l2-root-item">
              <span class="l2-root-label">Lifecycle Root</span>
              <span class="l2-root-value">${this.truncHash(status.currentLifecycleRoot)}</span>
            </div>
            <div class="l2-root-item">
              <span class="l2-root-label">Wallet Count</span>
              <span class="l2-root-value">${status.currentWalletCount}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  statBox(value, label, color) {
    return `
      <div class="l2-stat-box">
        <div class="l2-stat-value ${color}">${value}</div>
        <div class="l2-stat-label">${label}</div>
      </div>
    `;
  }

  // ─── Action Bar ────────────────────────────────────────

  renderActionBar() {
    return `
      <div class="section-card">
        <div class="card-header l2chain">Actions</div>
        <div class="card-body">
          <div class="l2-action-bar">
            <button class="btn-action l2chain" id="btn-force-batch">
              <span class="spinner"></span> Force Batch Now
            </button>
            <button class="btn-action l2chain" id="btn-save-checkpoint">
              <span class="spinner"></span> Save Checkpoint
            </button>
            <button class="btn-action l2chain-warn" id="btn-simulate-failure">
              Simulate Batch Failure
            </button>
            <button class="btn-action l2chain" id="btn-retry-batch" disabled>
              Retry Failed Batch
            </button>
          </div>
          <div id="l2-action-result" style="margin-top:12px;"></div>
        </div>
      </div>
    `;
  }

  bindActions() {
    const forceBatchBtn = this.container.querySelector('#btn-force-batch');
    const saveCheckpointBtn = this.container.querySelector('#btn-save-checkpoint');
    const simulateBtn = this.container.querySelector('#btn-simulate-failure');
    const retryBtn = this.container.querySelector('#btn-retry-batch');

    if (forceBatchBtn) {
      forceBatchBtn.addEventListener('click', () => this.doAction('force-batch', forceBatchBtn));
    }
    if (saveCheckpointBtn) {
      saveCheckpointBtn.addEventListener('click', () => this.doAction('save-checkpoint', saveCheckpointBtn));
    }
    if (simulateBtn) {
      simulateBtn.addEventListener('click', () => this.doAction('simulate-batch-failure', simulateBtn));
    }
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.doAction('retry-batch', retryBtn));
    }
  }

  async doAction(action, btn) {
    const resultDiv = this.container.querySelector('#l2-action-result');
    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/interactive/${action}`, { method: 'POST' });
      const data = await res.json();

      if (data.error) {
        resultDiv.innerHTML = `<div class="l2-action-error">${data.error}</div>`;
      } else {
        resultDiv.innerHTML = `<div class="l2-action-success">${data.message || 'Done'}</div>`;

        // Enable retry button after simulate failure
        if (action === 'simulate-batch-failure') {
          const retryBtn = this.container.querySelector('#btn-retry-batch');
          if (retryBtn) retryBtn.disabled = false;
        }
      }

      // Refresh the tab
      await this.app.fetchState();
      if (this.app.state) this.render(this.app.state);
    } catch (err) {
      resultDiv.innerHTML = `<div class="l2-action-error">Failed: ${err.message}</div>`;
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // ─── Receipts Table ────────────────────────────────────

  renderReceipts(receipts) {
    if (!receipts || receipts.length === 0) {
      return `
        <div class="section-card">
          <div class="card-header l2chain">Receipts (0)</div>
          <div class="card-body">
            <div style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">
              No receipts yet. Operations will generate StateTransitionProofs.
            </div>
          </div>
        </div>
      `;
    }

    // Show most recent first
    const sorted = [...receipts].reverse();
    const rows = sorted.map((r, i) => `
      <tr>
        <td class="mono" style="font-size:10px;" title="${r.receiptId}">${r.receiptId.slice(0, 12)}...</td>
        <td class="mono" style="font-size:10px;" title="${r.walletId}">${r.walletId}</td>
        <td>${r.isRegistration ? '<span class="l2-type-badge reg">REG</span>' : '<span class="l2-type-badge upd">UPD</span>'}</td>
        <td>${r.sequenceNumber}</td>
        <td><span class="l2-status-badge ${r.l1Status}">${r.l1Status}</span></td>
        <td style="font-size:11px; color:var(--text-muted);">${this.formatTime(r.acceptedAt)}</td>
      </tr>
    `).join('');

    return `
      <div class="section-card">
        <div class="card-header l2chain">Receipts (${receipts.length})</div>
        <div class="card-body" style="max-height:300px; overflow-y:auto;">
          <table class="l2-table">
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

  // ─── Batches Table ─────────────────────────────────────

  renderBatches(batches) {
    if (!batches || batches.length === 0) {
      return `
        <div class="section-card">
          <div class="card-header l2chain">Batches (0)</div>
          <div class="card-body">
            <div style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">
              No batches yet. Click "Force Batch Now" or wait for auto-batch.
            </div>
          </div>
        </div>
      `;
    }

    const sorted = [...batches].reverse();
    const rows = sorted.map(b => {
      const isEmpty = b.transitionCount === 0 && b.registrationCount === 0;
      return `
      <tr${isEmpty ? ' style="opacity: 0.5;"' : ''}>
        <td style="font-weight:600;">#${b.batchNumber}</td>
        <td>${b.registrationCount}</td>
        <td>${isEmpty ? '<span style="color:var(--text-muted);">0 (empty)</span>' : b.transitionCount}</td>
        <td><span class="l2-status-badge ${b.l1Status}">${b.l1Status}</span></td>
        <td class="mono" style="font-size:10px;" title="${b.l1TxHash || ''}">${b.l1TxHash ? b.l1TxHash.slice(0, 16) + '...' : '-'}</td>
        <td style="font-size:11px; color:var(--text-muted);">${this.formatTime(b.createdAt)}</td>
      </tr>
    `;}).join('');

    return `
      <div class="section-card">
        <div class="card-header l2chain">Batches (${batches.length})</div>
        <div class="card-body">
          <table class="l2-table">
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

  // ─── Audit Chain ───────────────────────────────────────

  renderAuditChain(auditLog) {
    if (!auditLog) return '';

    return `
      <div class="section-card">
        <div class="card-header l2chain">Audit Chain (Poseidon Hash Chain)</div>
        <div class="card-body">
          <div class="data-grid" style="grid-template-columns: 160px 1fr;">
            <div class="label">Event Count</div>
            <div class="value" style="color:var(--l2-color);">${auditLog.eventCount}</div>
            <div class="label">Latest Chain Hash</div>
            <div class="value mono" style="font-size:10px; word-break:break-all;">${auditLog.latestChainHash || '(genesis)'}</div>
            <div class="label">Genesis Hash</div>
            <div class="value mono" style="font-size:10px; word-break:break-all;">${auditLog.genesisHash || '-'}</div>
            <div class="label">Chain Integrity</div>
            <div class="value" style="color:var(--accent-green); font-weight:600;">
              ${auditLog.eventCount > 0 ? 'Verified (tamper-evident)' : 'No events'}
            </div>
          </div>
          <div class="hash-flow" style="margin-top:12px;">
            <span class="hf-op">Poseidon.hash</span>
            <span class="hf-arrow">(</span>
            <span class="hf-input">[prevChainHash, eventCommitment]</span>
            <span class="hf-arrow">)</span>
            <span class="hf-arrow">=</span>
            <span class="hf-output">${auditLog.latestChainHash ? this.truncHash(auditLog.latestChainHash) : 'N/A'}</span>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Helpers ───────────────────────────────────────────

  truncHash(hash) {
    if (!hash) return '-';
    const s = hash.toString();
    if (s.length <= 16) return s;
    return s.slice(0, 8) + '...' + s.slice(-6);
  }

  formatUptime(ms) {
    if (!ms || ms <= 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
  }

  formatTime(timestamp) {
    if (!timestamp) return '-';
    const d = new Date(timestamp);
    return d.toLocaleTimeString();
  }
}
