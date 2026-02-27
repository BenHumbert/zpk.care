/**
 * block-timeline.js — Batch timeline strip at the bottom of the dashboard.
 *
 * Polls /flowchart/batch-detail every 5s and renders batch cards
 * with enriched receipt details (member name, drug, amounts, operation type).
 *
 * Features:
 *   - Pending transaction queue with live accumulation display
 *   - 90-second countdown timer with smooth local ticking
 *   - "Building batch..." phase with leviathan animation trigger
 *   - Empty batch support
 *   - L2-only mode: batches settle immediately
 */

/** Operation type config: color + label. */
const OP_CONFIG = {
  registration: { color: '#4fc3f7', label: 'REG' },
  fulfillment:  { color: '#66bb6a', label: 'FILL' },
  reversal:     { color: '#ef5350', label: 'REV' },
  transition:   { color: '#ab47bc', label: 'TX' },
};

class BlockTimeline {
  constructor(containerEl, timerEl, popupEl) {
    this.container = containerEl;
    this.timerEl = timerEl;
    this.popupEl = popupEl;
    this.pollInterval = null;
    this.countdownInterval = null;
    this.lastFingerprint = '';

    // Timer state: smooth local countdown between server polls
    this.serverNextBatchMs = null;     // raw value from server
    this.serverBatchIntervalMs = 90000; // default 90s
    this.localCountdownMs = 90000;     // local countdown (ticks every second)
    this.lastServerPollAt = 0;         // when we last got server data
    this.isBuilding = false;           // true during batch build phase

    // Track pending transactions for the queue
    this.lastPendingReceipts = [];
    this.lastBatches = [];
  }

  start() {
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), 5000);

    // Smooth countdown — tick every second
    this.countdownInterval = setInterval(() => this.tickCountdown(), 1000);
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.countdownInterval) clearInterval(this.countdownInterval);
  }

  /** Smooth local countdown between server polls. */
  tickCountdown() {
    if (this.serverNextBatchMs == null) return;

    // Calculate remaining time based on time elapsed since last server poll
    const elapsed = Date.now() - this.lastServerPollAt;
    this.localCountdownMs = Math.max(0, this.serverNextBatchMs - elapsed);

    this.updateTimerDisplay();

    // When countdown reaches 0, enter "building" phase
    if (this.localCountdownMs <= 0 && !this.isBuilding) {
      this.isBuilding = true;
      this.updateTimerDisplay();
      this.triggerBuildAnimation();
    }
  }

  updateTimerDisplay() {
    if (!this.timerEl) return;

    if (this.isBuilding) {
      this.timerEl.innerHTML = '<span class="timer-building"><span class="action-spinner"></span> Building batch...</span>';
      return;
    }

    const sec = Math.max(0, Math.ceil(this.localCountdownMs / 1000));
    const pct = this.serverBatchIntervalMs > 0
      ? ((this.serverBatchIntervalMs - this.localCountdownMs) / this.serverBatchIntervalMs) * 100
      : 0;

    this.timerEl.innerHTML = `
      <span class="timer-countdown">${sec}s</span>
      <span class="timer-bar"><span class="timer-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
    `;
  }

  /** Trigger leviathan building animation via the force graph. */
  triggerBuildAnimation() {
    // Pulse all running leviathans
    const statusData = window._lastStatusData ? window._lastStatusData() : null;
    if (statusData && statusData.leviathans) {
      for (const lev of statusData.leviathans) {
        if (lev.status === 'running') {
          // Access the global forceGraph to pulse nodes
          const svg = document.getElementById('graph-svg');
          if (svg && svg.__forceGraph) {
            svg.__forceGraph.pulseNode(lev.id, '#26c6da', 3);
          }
        }
      }
    }
  }

  async poll() {
    try {
      const res = await fetch('/flowchart/batch-detail');
      if (!res.ok) return;
      const data = await res.json();

      // Update timer state from server
      if (data.nextBatchInMs != null) {
        // If server says we're past 0 and we were building, reset
        if (data.nextBatchInMs > 5000 && this.isBuilding) {
          this.isBuilding = false;
        }
        this.serverNextBatchMs = data.nextBatchInMs;
        this.lastServerPollAt = Date.now();
        this.localCountdownMs = data.nextBatchInMs;
      }
      if (data.batchIntervalMs) {
        this.serverBatchIntervalMs = data.batchIntervalMs;
      }

      this.render(data);
    } catch { /* ignore */ }
  }

  render(data) {
    const { batches = [], pendingReceipts = [] } = data;

    this.lastPendingReceipts = pendingReceipts;
    this.lastBatches = batches;

    // Fingerprint to avoid unnecessary DOM churn
    const fp = JSON.stringify({
      b: batches.map(b => b.batchNumber + ':' + (b.receipts ? b.receipts.length : 0) + ':' + b.l1Status),
      p: pendingReceipts.length,
    });
    if (fp === this.lastFingerprint) return;
    this.lastFingerprint = fp;

    this.container.innerHTML = '';

    // Render settled/built batch cards
    for (const batch of batches) {
      const card = this.createBatchCard(batch);
      this.container.appendChild(card);
    }

    // Always show pending card — either with pending receipts or "Waiting..."
    const pendingCard = this.createPendingCard(pendingReceipts);
    this.container.appendChild(pendingCard);

    // Scroll to end
    this.container.scrollLeft = this.container.scrollWidth;
  }

  /** Determine batch status class. In L2-only mode, batches are 'settled' immediately. */
  getBatchStatusClass(batch) {
    if (batch.l1Status === 'settled' || batch.l1Status === 'batched') return 'bc-settled';
    if (batch.l1Status === 'failed') return 'bc-failed';
    return 'bc-pending';
  }

  getBatchStatusLabel(batch) {
    if (batch.l1Status === 'settled') return 'Settled';
    if (batch.l1Status === 'batched') return 'Batched';
    if (batch.l1Status === 'failed') return 'Failed';
    return 'Pending';
  }

  createBatchCard(batch) {
    const card = document.createElement('div');
    const isEmpty = !batch.receipts || batch.receipts.length === 0;
    const statusClass = isEmpty ? 'bc-empty' : this.getBatchStatusClass(batch);
    card.className = `batch-card ${statusClass}`;

    // Compute totals for receipts that have costs
    let totalPatient = 0;
    let totalPlan = 0;
    for (const r of (batch.receipts || [])) {
      if (r.patientPayCents) totalPatient += r.patientPayCents;
      if (r.planPayCents) totalPlan += r.planPayCents;
    }

    const header = document.createElement('div');
    header.className = 'bc-header';
    header.innerHTML = `
      <span class="bc-batch-num">Batch #${batch.batchNumber}</span>
      <span class="bc-status-badge">${this.getBatchStatusLabel(batch)}</span>
    `;
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'bc-meta';
    let metaHtml = `<span>${formatTimestamp(batch.createdAt)}</span>`;
    metaHtml += `<span>${batch.transitionCount || 0} tx</span>`;
    if (totalPatient > 0 || totalPlan > 0) {
      metaHtml += `<span class="bc-cost">$${((totalPatient + totalPlan) / 100).toFixed(2)}</span>`;
    }
    meta.innerHTML = metaHtml;
    card.appendChild(meta);

    if (isEmpty) {
      // Empty batch — show distinct label
      const emptyLabel = document.createElement('div');
      emptyLabel.className = 'bc-empty-label';
      emptyLabel.textContent = 'Empty batch';
      card.appendChild(emptyLabel);
    } else {
      const receipts = document.createElement('div');
      receipts.className = 'bc-receipts';

      for (const r of batch.receipts) {
        const row = document.createElement('div');
        row.className = 'bc-receipt';

        const op = OP_CONFIG[r.operationType] || OP_CONFIG.transition;
        const memberLabel = shortMember(r.memberName) || truncHash(r.walletId);

        let costHtml = '';
        if (r.patientPayCents || r.planPayCents) {
          costHtml = `<span class="amount" title="Patient: ${formatCents(r.patientPayCents)} / Plan: ${formatCents(r.planPayCents)}">${formatCents(r.patientPayCents)}</span>`;
        }

        row.innerHTML = `
          <span class="op-badge" style="background:${op.color}20;color:${op.color}">${op.label}</span>
          <span class="member-name">${memberLabel}</span>
          ${r.brandName ? `<span class="drug-name">${escapeHtml(r.brandName)}</span>` : ''}
          ${costHtml}
        `;
        receipts.appendChild(row);
      }
      card.appendChild(receipts);
    }

    // Click for detail popup
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showBatchPopup(batch, card);
    });

    return card;
  }

  createPendingCard(pendingReceipts) {
    const card = document.createElement('div');
    card.className = 'batch-card bc-pending-pool';

    const header = document.createElement('div');
    header.className = 'bc-header';

    if (pendingReceipts.length > 0) {
      header.innerHTML = `
        <span class="bc-batch-num">Pending Queue</span>
        <span class="bc-count">${pendingReceipts.length} tx</span>
      `;
    } else {
      header.innerHTML = `
        <span class="bc-batch-num">Pending Queue</span>
        <span class="bc-count">0 tx</span>
      `;
    }
    card.appendChild(header);

    if (pendingReceipts.length > 0) {
      const receipts = document.createElement('div');
      receipts.className = 'bc-receipts';

      // Build walletId → name map from state
      const stateData = window._lastStateData ? window._lastStateData() : null;
      const walletNameMap = {};
      if (stateData && stateData.enrolledMembers) {
        for (const m of stateData.enrolledMembers) {
          if (m.walletId) walletNameMap[String(m.walletId)] = m.displayName;
        }
      }

      for (const r of pendingReceipts) {
        const row = document.createElement('div');
        row.className = 'bc-receipt';
        const memberName = walletNameMap[r.walletId] ? shortMember(walletNameMap[r.walletId]) : truncHash(r.walletId);
        const opColor = r.isRegistration ? '#4fc3f7' : '#ab47bc';
        const opLabel = r.isRegistration ? 'REG' : 'TX';
        row.innerHTML = `
          <span class="op-badge" style="background:${opColor}20;color:${opColor}">${opLabel}</span>
          <span class="member-name">${memberName}</span>
          <span class="bc-time">${formatTimestamp(r.acceptedAt)}</span>
        `;
        receipts.appendChild(row);
      }
      card.appendChild(receipts);
    } else {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'bc-empty-label';
      emptyMsg.textContent = 'Waiting for transactions...';
      card.appendChild(emptyMsg);
    }

    return card;
  }

  showBatchPopup(batch, cardEl) {
    const popup = this.popupEl;
    if (!popup) return;

    // Position near the card
    const rect = cardEl.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    popup.style.top = 'auto';

    // Compute totals
    let totalPatient = 0, totalPlan = 0;
    for (const r of batch.receipts) {
      if (r.patientPayCents) totalPatient += r.patientPayCents;
      if (r.planPayCents) totalPlan += r.planPayCents;
    }

    const statusLabel = this.getBatchStatusLabel(batch);
    const statusCls = batch.l1Status === 'settled' ? 'complete' : batch.l1Status === 'failed' ? 'error' : 'complete';

    // Build content
    let html = `
      <button class="btn-close-popup" onclick="document.getElementById('batch-popup').classList.add('hidden')">&times;</button>
      <h3>Batch #${batch.batchNumber}</h3>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;">
        ${formatTimestamp(batch.createdAt)} &middot; ${batch.transitionCount} transitions &middot;
        ${statusBadge(statusCls, statusLabel)}
      </div>
      ${(totalPatient > 0 || totalPlan > 0) ? `
        <div style="font-size:11px;margin-bottom:10px;display:flex;gap:16px;">
          <span>Patient Total: <strong>${formatCents(totalPatient)}</strong></span>
          <span>Plan Total: <strong>${formatCents(totalPlan)}</strong></span>
        </div>
      ` : ''}
      <table>
        <thead><tr>
          <th>Op</th><th>Member</th><th>Drug</th><th>Patient</th><th>Plan</th>
        </tr></thead>
        <tbody>
    `;
    for (const r of batch.receipts) {
      const op = OP_CONFIG[r.operationType] || OP_CONFIG.transition;
      html += `<tr>
        <td><span class="badge" style="background:${op.color}20;color:${op.color}">${op.label}</span></td>
        <td>${shortMember(r.memberName) || truncHash(r.walletId)}</td>
        <td>${r.brandName ? escapeHtml(r.brandName) : '—'}</td>
        <td>${r.patientPayCents ? formatCents(r.patientPayCents) : '—'}</td>
        <td>${r.planPayCents ? formatCents(r.planPayCents) : '—'}</td>
      </tr>`;
    }
    html += '</tbody></table>';

    popup.innerHTML = html;
    popup.classList.remove('hidden');

    // Close on outside click
    const closeHandler = (e) => {
      if (!popup.contains(e.target) && !cardEl.contains(e.target)) {
        popup.classList.add('hidden');
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 100);
  }
}
