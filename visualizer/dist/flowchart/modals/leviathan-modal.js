/**
 * leviathan-modal.js — Modal for leviathan node details + actions.
 *
 * Features:
 *   - Status, role, partitions, heartbeat, leader map (existing)
 *   - Partitioned wallets table (NEW) — shows which enrolled wallets belong to this node's partitions
 *   - Force batch button (NEW) — triggers immediate batch settlement
 *   - Save checkpoint button (NEW) — saves current state to disk
 *   - Start/stop node toggle (existing)
 */

class LeviathanModal {
  constructor(modalEl) {
    this.modalEl = modalEl;
    this.currentLev = null;

    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.close();
    });
  }

  show(lev, partitionMap) {
    this.currentLev = lev;

    const isRunning = lev.status === 'running';
    const heartbeatAge = lev.lastHeartbeat ? Math.floor((Date.now() - lev.lastHeartbeat) / 1000) : null;
    const partitions = (lev.activePartitions || []).map(p => `P${p}`).join(', ') || 'None';

    // Get enrolled members for partition wallet display
    const stateData = window._lastStateData ? window._lastStateData() : null;
    const statusData = window._lastStatusData ? window._lastStatusData() : null;
    const enrolledMembers = stateData?.enrolledMembers || [];
    const partitionCount = statusData?.partitionCount || 3;

    // Compute which wallets belong to this leviathan's active partitions
    const activePartitions = new Set(lev.activePartitions || []);
    const walletsByPartition = new Map();

    for (const p of activePartitions) {
      walletsByPartition.set(p, []);
    }

    for (const m of enrolledMembers) {
      if (!m.walletId) continue;
      const partition = Number(BigInt(m.walletId) % BigInt(partitionCount));
      if (activePartitions.has(partition)) {
        if (!walletsByPartition.has(partition)) walletsByPartition.set(partition, []);
        walletsByPartition.get(partition).push(m);
      }
    }

    const totalWallets = Array.from(walletsByPartition.values()).reduce((sum, arr) => sum + arr.length, 0);

    this.modalEl.innerHTML = `
      <div class="modal-content">
        <button class="modal-close" onclick="document.getElementById('leviathan-modal').classList.add('hidden')">&times;</button>

        <div class="modal-title-row">
          <div class="modal-header-accent" style="background:${isRunning ? '#26c6da' : '#ef5350'};">L</div>
          <div>
            <h2>${escapeHtml(lev.name)}</h2>
            <div class="modal-type-label">Leviathan ${lev.role === 'sequencer' ? '(Leader)' : '(Replica)'}</div>
          </div>
        </div>

        <div class="modal-section">
          <h4>Status</h4>
          <div class="modal-row">
            <span class="label">State</span>
            <span class="value">${statusBadge(lev.status)}</span>
          </div>
          <div class="modal-row">
            <span class="label">Role</span>
            <span class="value">${lev.role === 'sequencer' ? 'Sequencer (Leader)' : 'Replica'}</span>
          </div>
          <div class="modal-row">
            <span class="label">Node ID</span>
            <span class="value" style="font-family:monospace;font-size:11px;">${escapeHtml(lev.id)}</span>
          </div>
        </div>

        <div class="modal-section">
          <h4>Partitions</h4>
          <div class="modal-row">
            <span class="label">Primary Partition</span>
            <span class="value">P${lev.primaryPartition}</span>
          </div>
          <div class="modal-row">
            <span class="label">Active Partitions</span>
            <span class="value">${partitions}</span>
          </div>
          <div class="modal-row">
            <span class="label">Leader Map</span>
            <span class="value" style="font-size:10px;">${Object.entries(partitionMap).map(([k,v]) => `P${k}=${v.replace('lev-','')}`).join(', ')}</span>
          </div>
        </div>

        <div class="modal-section">
          <h4>Heartbeat</h4>
          <div class="modal-row">
            <span class="label">Last Heartbeat</span>
            <span class="value">${heartbeatAge != null ? heartbeatAge + 's ago' : 'Never'}</span>
          </div>
          <div class="modal-row">
            <span class="label">Interval</span>
            <span class="value">5s</span>
          </div>
        </div>

        <div class="modal-section">
          <h4>Partitioned Wallets (${totalWallets})</h4>
          ${isRunning && totalWallets > 0 ? this.renderPartitionWallets(walletsByPartition) : ''}
          ${isRunning && totalWallets === 0 ? '<div style="font-size:11px;color:var(--text-muted);">No enrolled wallets in active partitions</div>' : ''}
          ${!isRunning ? '<div style="font-size:11px;color:var(--text-muted);">0 wallets (stopped)</div>' : ''}
        </div>

        <div class="modal-section">
          <h4>Actions</h4>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${isRunning
              ? `<button class="btn-action btn-terminate" id="btn-lev-stop">Stop Node</button>`
              : `<button class="btn-action btn-enroll" id="btn-lev-start">Start Node</button>`
            }
            ${isRunning ? `<button class="btn-action btn-report" id="btn-lev-force-batch">Force Batch</button>` : ''}
            ${isRunning ? `<button class="btn-action btn-checkpoint" id="btn-lev-checkpoint">Save Checkpoint</button>` : ''}
          </div>
          <div id="lev-action-status" class="action-status"></div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="document.getElementById('leviathan-modal').classList.add('hidden')">Close</button>
        </div>
      </div>
    `;

    this.modalEl.classList.remove('hidden');
    this.bindActions();
  }

  renderPartitionWallets(walletsByPartition) {
    const levNames = ['Alpha', 'Beta', 'Gamma'];
    let html = '<div class="partition-wallets">';

    for (const [partition, members] of walletsByPartition) {
      html += `<div class="partition-section-header">P${partition} (${levNames[partition] || ''}) — ${members.length} wallet${members.length !== 1 ? 's' : ''}</div>`;
      html += '<div style="margin-bottom:8px;">';
      for (const m of members) {
        html += `<span class="wallet-chip" title="${escapeHtml(m.displayName)}: ${m.walletId}">${escapeHtml(shortMember(m.displayName))}</span>`;
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  bindActions() {
    const stopBtn = document.getElementById('btn-lev-stop');
    const startBtn = document.getElementById('btn-lev-start');
    const batchBtn = document.getElementById('btn-lev-force-batch');
    const checkpointBtn = document.getElementById('btn-lev-checkpoint');

    if (stopBtn) stopBtn.addEventListener('click', () => this.toggleNode('stop'));
    if (startBtn) startBtn.addEventListener('click', () => this.toggleNode('start'));
    if (batchBtn) batchBtn.addEventListener('click', () => this.forceBatch());
    if (checkpointBtn) checkpointBtn.addEventListener('click', () => this.saveCheckpoint());
  }

  async toggleNode(action) {
    if (!this.currentLev) return;
    try {
      const res = await fetch(`/flowchart/leviathan/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.currentLev.id }),
      });
      if (res.ok) {
        this.showStatus('Node ' + (action === 'stop' ? 'stopped' : 'started'), 'success');
        if (window._dashboardPollStatus) window._dashboardPollStatus();
        setTimeout(() => this.close(), 1000);
      }
    } catch (err) {
      this.showStatus('Failed: ' + err.message, 'error');
    }
  }

  async forceBatch() {
    const btn = document.getElementById('btn-lev-force-batch');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Building...'; }

    try {
      const res = await fetch('/interactive/force-batch', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(data.message, 'success');
        if (window._dashboardPollStatus) window._dashboardPollStatus();
      } else {
        this.showStatus(data.error || 'Failed', 'error');
      }
    } catch (err) {
      this.showStatus(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Force Batch'; }
    }
  }

  async saveCheckpoint() {
    const btn = document.getElementById('btn-lev-checkpoint');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Saving...'; }

    try {
      const res = await fetch('/interactive/save-checkpoint', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(data.message, 'success');
      } else {
        this.showStatus(data.error || 'Failed', 'error');
      }
    } catch (err) {
      this.showStatus(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Checkpoint'; }
    }
  }

  showStatus(message, type) {
    const el = document.getElementById('lev-action-status');
    if (!el) return;
    el.className = `action-status visible status-${type}`;
    el.textContent = message;
  }

  close() {
    this.modalEl.classList.add('hidden');
    this.currentLev = null;
  }
}
