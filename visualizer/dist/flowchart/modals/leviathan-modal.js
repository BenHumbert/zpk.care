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
 * leviathan-modal.js — Production control panel for leviathan nodes.
 *
 * Features:
 *   - Heartbeat health indicator (HEALTHY / STALE / DEAD) with color badges
 *   - Failover chain visualization per partition
 *   - Per-partition status cards with leader identity
 *   - Partitioned wallets table
 *   - Operations panel: Start/Stop, Simulate Failover, Reclaim Partition,
 *     Force Batch, Save Checkpoint, Retry Failed Batch, Simulate Batch Failure
 *   - Recent activity feed (last 5 VizEvents for this node)
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
    const failoverChain = statusData?.failoverChain || {};
    const chainData = statusData?.chain || {};

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
          <h4>Heartbeat</h4>
          <div class="modal-row">
            <span class="label">Health</span>
            <span class="value">${this.renderHealthBadge(heartbeatAge, isRunning)}</span>
          </div>
          <div class="modal-row">
            <span class="label">Last Heartbeat</span>
            <span class="value" title="${lev.lastHeartbeat ? new Date(lev.lastHeartbeat).toISOString() : 'Never'}">${heartbeatAge != null ? heartbeatAge + 's ago' : 'Never'}</span>
          </div>
          <div class="modal-row">
            <span class="label">Interval / Timeout</span>
            <span class="value">5s / 15s</span>
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

        ${this.renderFailoverChains(lev, failoverChain, partitionMap)}

        ${this.renderPartitionCards(lev, partitionMap, walletsByPartition, chainData)}

        <div class="modal-section">
          <h4>Partitioned Wallets (${totalWallets})</h4>
          ${isRunning && totalWallets > 0 ? this.renderPartitionWallets(walletsByPartition) : ''}
          ${isRunning && totalWallets === 0 ? '<div style="font-size:11px;color:var(--text-muted);">No enrolled wallets in active partitions</div>' : ''}
          ${!isRunning ? '<div style="font-size:11px;color:var(--text-muted);">0 wallets (stopped)</div>' : ''}
        </div>

        <div class="modal-section">
          <h4>Operations</h4>
          <div class="operation-group">
            <div class="operation-group-label">Node Control</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${isRunning
                ? `<button class="btn-action btn-terminate" id="btn-lev-stop">Simulate Failover</button>`
                : `<button class="btn-action btn-enroll" id="btn-lev-start">Reclaim Partition</button>`
              }
            </div>
          </div>
          <div class="operation-group">
            <div class="operation-group-label">Batch Management</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${isRunning ? `<button class="btn-action btn-report" id="btn-lev-force-batch">Force Batch</button>` : ''}
              <button class="btn-action btn-prescribe" id="btn-lev-retry-batch">Retry Failed Batch</button>
              <button class="btn-action btn-terminate" id="btn-lev-simulate-failure">Simulate Batch Failure</button>
            </div>
          </div>
          <div class="operation-group">
            <div class="operation-group-label">Persistence</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${isRunning ? `<button class="btn-action btn-checkpoint" id="btn-lev-checkpoint">Save Checkpoint</button>` : ''}
            </div>
          </div>
          <div id="lev-action-status" class="action-status"></div>
        </div>

        <div class="modal-section">
          <h4>Recent Activity</h4>
          <div id="lev-activity-feed" style="font-size:11px;color:var(--text-muted);">Loading...</div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="document.getElementById('leviathan-modal').classList.add('hidden')">Close</button>
        </div>
      </div>
    `;

    this.modalEl.classList.remove('hidden');
    this.bindActions();
    this.loadRecentActivity(lev.id, lev.name);
  }

  renderHealthBadge(heartbeatAge, isRunning) {
    if (!isRunning) {
      return '<span class="health-badge health-dead"><span class="health-dot"></span>OFFLINE</span>';
    }
    if (heartbeatAge === null) {
      return '<span class="health-badge health-dead"><span class="health-dot"></span>DEAD</span>';
    }
    if (heartbeatAge <= 10) {
      return '<span class="health-badge health-healthy"><span class="health-dot"></span>HEALTHY</span>';
    }
    if (heartbeatAge <= 15) {
      return '<span class="health-badge health-stale"><span class="health-dot"></span>STALE</span>';
    }
    return '<span class="health-badge health-dead"><span class="health-dot"></span>DEAD</span>';
  }

  renderFailoverChains(lev, failoverChain, partitionMap) {
    const activePartitions = lev.activePartitions || [];
    if (activePartitions.length === 0) return '';

    const levNames = { 'lev-alpha': 'Alpha', 'lev-beta': 'Beta', 'lev-gamma': 'Gamma' };

    let html = '<div class="modal-section"><h4>Failover Chains</h4>';

    for (const partition of activePartitions) {
      const chain = failoverChain[partition] || [];
      const currentLeader = partitionMap[partition];

      html += `<div class="failover-chain-row">`;
      html += `<span class="failover-partition-label">P${partition}:</span>`;
      html += `<span class="failover-chain">`;

      chain.forEach((nodeId, idx) => {
        const name = levNames[nodeId] || nodeId;
        const isLeader = nodeId === currentLeader;
        const isSelf = nodeId === lev.id;
        const cls = isLeader ? 'failover-node failover-leader' : 'failover-node';
        const selfMark = isSelf ? ' (you)' : '';

        if (idx > 0) html += '<span class="failover-arrow">&rarr;</span>';
        html += `<span class="${cls}">${escapeHtml(name)}${selfMark}</span>`;
      });

      html += '</span></div>';
    }

    html += '</div>';
    return html;
  }

  renderPartitionCards(lev, partitionMap, walletsByPartition, chainData) {
    const activePartitions = lev.activePartitions || [];
    if (activePartitions.length === 0) return '';

    const levNames = { 'lev-alpha': 'Alpha', 'lev-beta': 'Beta', 'lev-gamma': 'Gamma' };

    let html = '<div class="modal-section"><h4>Partition Details</h4><div class="partition-cards">';

    for (const partition of activePartitions) {
      const leader = partitionMap[partition];
      const leaderName = levNames[leader] || leader;
      const isLeading = leader === lev.id;
      const walletCount = (walletsByPartition.get(partition) || []).length;

      html += `
        <div class="partition-card">
          <div class="partition-card-header">
            <span class="partition-card-label">P${partition}</span>
            <span class="badge ${isLeading ? 'badge-success' : 'badge-info'}" style="font-size:8px;">${isLeading ? 'LEADING' : 'BACKUP'}</span>
          </div>
          <div class="partition-card-body">
            <div class="partition-card-row"><span>Leader</span><span>${escapeHtml(leaderName)}</span></div>
            <div class="partition-card-row"><span>Wallets</span><span>${walletCount}</span></div>
            <div class="partition-card-row"><span>Receipts</span><span>${chainData.receiptCount ?? '—'}</span></div>
            <div class="partition-card-row"><span>Batches</span><span>${chainData.batchCount ?? '—'}</span></div>
          </div>
        </div>
      `;
    }

    html += '</div></div>';
    return html;
  }

  renderPartitionWallets(walletsByPartition) {
    const levNames = ['Alpha', 'Beta', 'Gamma'];
    const priv = PrivacyMode.isActive();
    let html = '<div class="partition-wallets">';

    for (const [partition, members] of walletsByPartition) {
      html += `<div class="partition-section-header">P${partition} (${levNames[partition] || ''}) — ${members.length} wallet${members.length !== 1 ? 's' : ''}</div>`;
      html += '<div style="margin-bottom:8px;">';
      for (const m of members) {
        const chipLabel = priv ? truncHash(m.walletId) : escapeHtml(shortMember(m.displayName));
        const chipTitle = priv ? m.walletId : `${escapeHtml(m.displayName)}: ${m.walletId}`;
        html += `<span class="wallet-chip" title="${chipTitle}">${chipLabel}</span>`;
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  async loadRecentActivity(levId, levName) {
    const feed = document.getElementById('lev-activity-feed');
    if (!feed) return;

    try {
      const res = await fetch('/viz/history');
      if (!res.ok) { feed.textContent = 'Unable to load activity'; return; }
      const events = await res.json();

      // Filter events involving this leviathan (as actor or target)
      const levEvents = events.filter(e =>
        e.actor === levId || e.target === levId ||
        e.actor === levName || e.target === levName ||
        (e.actorType === 'leviathan' && (e.actor || '').includes(levName.split(' ').pop())) ||
        (e.targetType === 'leviathan' && (e.target || '').includes(levName.split(' ').pop()))
      );

      const recent = levEvents.slice(-8).reverse();

      if (recent.length === 0) {
        feed.textContent = 'No recent activity for this node';
        return;
      }

      feed.innerHTML = recent.map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const type = (e.type || '').replace('viz:', '');
        const detail = e.data?.reason || e.data?.partitionIndex != null ? `P${e.data.partitionIndex}` : '';
        return `<div class="lev-activity-row"><span class="lev-activity-time">${time}</span><span class="lev-activity-type">${escapeHtml(type)}</span>${detail ? `<span class="lev-activity-detail">${escapeHtml(String(detail))}</span>` : ''}</div>`;
      }).join('');
    } catch {
      feed.textContent = 'Unable to load activity';
    }
  }

  bindActions() {
    const stopBtn = document.getElementById('btn-lev-stop');
    const startBtn = document.getElementById('btn-lev-start');
    const batchBtn = document.getElementById('btn-lev-force-batch');
    const checkpointBtn = document.getElementById('btn-lev-checkpoint');
    const retryBtn = document.getElementById('btn-lev-retry-batch');
    const simFailBtn = document.getElementById('btn-lev-simulate-failure');

    if (stopBtn) stopBtn.addEventListener('click', () => this.toggleNode('stop'));
    if (startBtn) startBtn.addEventListener('click', () => this.toggleNode('start'));
    if (batchBtn) batchBtn.addEventListener('click', () => this.forceBatch());
    if (checkpointBtn) checkpointBtn.addEventListener('click', () => this.saveCheckpoint());
    if (retryBtn) retryBtn.addEventListener('click', () => this.retryFailedBatch());
    if (simFailBtn) simFailBtn.addEventListener('click', () => this.simulateBatchFailure());
  }

  async toggleNode(action) {
    if (!this.currentLev) return;
    const btn = document.getElementById(action === 'stop' ? 'btn-lev-stop' : 'btn-lev-start');
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="action-spinner"></span> ${action === 'stop' ? 'Stopping...' : 'Starting...'}`; }

    try {
      const res = await fetch(`/flowchart/leviathan/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.currentLev.id }),
      });
      if (res.ok) {
        this.showStatus(action === 'stop' ? 'Node stopped — failover triggered' : 'Node started — partition reclaimed', 'success');
        if (window._dashboardPollStatus) window._dashboardPollStatus();
        setTimeout(() => this.close(), 1500);
      } else {
        const data = await res.json();
        this.showStatus(data.error || 'Failed', 'error');
      }
    } catch (err) {
      this.showStatus('Failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = action === 'stop' ? 'Simulate Failover' : 'Reclaim Partition'; }
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

  async retryFailedBatch() {
    const btn = document.getElementById('btn-lev-retry-batch');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Retrying...'; }

    try {
      const res = await fetch('/interactive/retry-batch', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(data.message, 'success');
        if (window._dashboardPollStatus) window._dashboardPollStatus();
      } else {
        this.showStatus(data.error || 'No failed batches to retry', 'error');
      }
    } catch (err) {
      this.showStatus(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Retry Failed Batch'; }
    }
  }

  async simulateBatchFailure() {
    const btn = document.getElementById('btn-lev-simulate-failure');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Simulating...'; }

    try {
      const res = await fetch('/interactive/simulate-batch-failure', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(data.message, 'success');
        if (window._dashboardPollStatus) window._dashboardPollStatus();
      } else {
        this.showStatus(data.error || 'No settled batches to fail', 'error');
      }
    } catch (err) {
      this.showStatus(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Simulate Batch Failure'; }
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
