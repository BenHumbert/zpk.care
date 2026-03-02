/**
 * block-timeline.js — Zoomable batch timeline strip at the bottom of the dashboard.
 *
 * Polls /flowchart/batch-detail every 5s and renders batch cards
 * with enriched receipt details (member name, drug, amounts, operation type).
 *
 * Features:
 *   - Hierarchical zoom: Year → Quarter → Month → Day → Individual batches
 *   - LIVE button — auto-follows latest batches (green pulsing indicator)
 *   - Drill-down — click a group card to zoom into that time period
 *   - Breadcrumb navigation — click to jump back to any level
 *   - Auto-zoom — selects appropriate zoom level based on total batch count
 *   - Pending transaction queue with live accumulation display
 *   - 90-second countdown timer with smooth local ticking
 *   - "Building batch..." phase with leviathan animation trigger
 */

/** Operation type config: color + label. */
const OP_CONFIG = {
  registration: { color: '#4fc3f7', label: 'REG' },
  fulfillment:  { color: '#66bb6a', label: 'FILL' },
  reversal:     { color: '#ef5350', label: 'REV' },
  transition:   { color: '#ab47bc', label: 'TX' },
};

const ZOOM_LABELS = ['Batches', 'Days', 'Months', 'Quarters', 'Years'];

class BlockTimeline {
  constructor(containerEl, timerEl, popupEl) {
    this.container = containerEl;
    this.timerEl = timerEl;
    this.popupEl = popupEl;
    this.pollInterval = null;
    this.countdownInterval = null;
    this.lastFingerprint = '';

    // Timer state: smooth local countdown between server polls
    this.serverNextBatchMs = null;
    this.serverBatchIntervalMs = 90000;
    this.localCountdownMs = 90000;
    this.lastServerPollAt = 0;
    this.isBuilding = false;

    // Track pending transactions for the queue
    this.lastPendingReceipts = [];
    this.lastBatches = [];

    // Zoom state
    this.zoomLevel = 0;         // 0=individual, 1=day, 2=month, 3=quarter, 4=year
    this.dateFilter = null;     // { from: ISO, to: ISO } — null = show all
    this.breadcrumb = [];       // [{ label, zoom, from, to }]
    this.totalBatches = 0;
    this.manualZoom = false;    // true once user manually zooms
    this.liveMode = true;       // LIVE auto-follow mode
    this.autoZoomDone = false;  // true after first auto-zoom check

    // DOM refs for zoom controls + LIVE button (created in start())
    this.liveBtn = null;
    this.zoomWrap = null;
    this.zoomLabelEl = null;
    this.breadcrumbEl = null;
  }

  start() {
    this.createControls();
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), 5000);
    this.countdownInterval = setInterval(() => this.tickCountdown(), 1000);
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.countdownInterval) clearInterval(this.countdownInterval);
  }

  // ─── Controls ─────────────────────────────────────────

  createControls() {
    const header = this.container.parentElement?.querySelector('.timeline-header');
    if (!header) return;

    const titleEl = header.querySelector('.timeline-title');

    // LIVE button — insert right after title
    this.liveBtn = document.createElement('button');
    this.liveBtn.className = 'live-btn live-active';
    this.liveBtn.innerHTML = '<span class="live-dot"></span> LIVE';
    this.liveBtn.addEventListener('click', () => this.goLive());
    if (titleEl) {
      titleEl.after(this.liveBtn);
    } else {
      header.prepend(this.liveBtn);
    }

    // Breadcrumb — after LIVE button
    this.breadcrumbEl = document.createElement('span');
    this.breadcrumbEl.className = 'timeline-breadcrumb';
    this.liveBtn.after(this.breadcrumbEl);

    // Zoom controls — before the timer (right side of header)
    this.zoomWrap = document.createElement('div');
    this.zoomWrap.className = 'timeline-zoom';

    const zoomOut = document.createElement('button');
    zoomOut.className = 'zoom-btn';
    zoomOut.textContent = '\u2212'; // minus sign
    zoomOut.title = 'Zoom out (group by larger time period)';
    zoomOut.addEventListener('click', () => this.zoomOut());

    this.zoomLabelEl = document.createElement('span');
    this.zoomLabelEl.className = 'zoom-label';
    this.zoomLabelEl.textContent = ZOOM_LABELS[this.zoomLevel];

    const zoomIn = document.createElement('button');
    zoomIn.className = 'zoom-btn';
    zoomIn.textContent = '+';
    zoomIn.title = 'Zoom in (show more detail)';
    zoomIn.addEventListener('click', () => this.zoomIn());

    this.zoomWrap.appendChild(zoomOut);
    this.zoomWrap.appendChild(this.zoomLabelEl);
    this.zoomWrap.appendChild(zoomIn);

    const timerEl = header.querySelector('.next-batch-timer');
    if (timerEl) {
      timerEl.before(this.zoomWrap);
    } else {
      header.appendChild(this.zoomWrap);
    }
  }

  // ─── LIVE Mode ────────────────────────────────────────

  goLive() {
    this.liveMode = true;
    this.zoomLevel = 0;
    this.dateFilter = null;
    this.breadcrumb = [];
    this.manualZoom = false;
    this.autoZoomDone = false;
    this.lastFingerprint = ''; // force re-render
    this.updateLiveButton();
    this.updateBreadcrumb();
    this.updateZoomLabel();
    this.poll();
  }

  setLiveMode(active) {
    if (this.liveMode === active) return;
    this.liveMode = active;
    this.updateLiveButton();
  }

  updateLiveButton() {
    if (!this.liveBtn) return;
    this.liveBtn.classList.toggle('live-active', this.liveMode);
    this.liveBtn.classList.toggle('live-inactive', !this.liveMode);
  }

  // ─── Zoom Controls ───────────────────────────────────

  zoomOut() {
    if (this.zoomLevel >= 4) return;
    this.zoomLevel++;
    this.manualZoom = true;
    this.setLiveMode(false);
    this.dateFilter = null;
    this.breadcrumb = [];
    this.lastFingerprint = '';
    this.updateZoomLabel();
    this.updateBreadcrumb();
    this.poll();
  }

  zoomIn() {
    if (this.zoomLevel <= 0) return;
    this.zoomLevel--;
    this.manualZoom = true;
    if (this.zoomLevel === 0 && !this.dateFilter) {
      this.setLiveMode(true);
    }
    this.lastFingerprint = '';
    this.updateZoomLabel();
    this.poll();
  }

  updateZoomLabel() {
    if (this.zoomLabelEl) {
      this.zoomLabelEl.textContent = ZOOM_LABELS[this.zoomLevel];
    }
  }

  // ─── Breadcrumb ──────────────────────────────────────

  updateBreadcrumb() {
    if (!this.breadcrumbEl) return;
    if (this.breadcrumb.length === 0) {
      this.breadcrumbEl.innerHTML = '';
      return;
    }

    let html = '';
    // "All" root
    html += '<span class="breadcrumb-item" data-bc-idx="-1">All</span>';

    for (let i = 0; i < this.breadcrumb.length; i++) {
      html += '<span class="breadcrumb-sep">\u203A</span>';
      html += `<span class="breadcrumb-item" data-bc-idx="${i}">${escapeHtml(this.breadcrumb[i].label)}</span>`;
    }

    this.breadcrumbEl.innerHTML = html;

    // Attach click handlers
    this.breadcrumbEl.querySelectorAll('.breadcrumb-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.bcIdx, 10);
        this.navigateBreadcrumb(idx);
      });
    });
  }

  navigateBreadcrumb(index) {
    if (index === -1) {
      // Navigate to root — clear everything
      this.zoomLevel = 0;
      this.dateFilter = null;
      this.breadcrumb = [];
      this.manualZoom = false;
      this.autoZoomDone = false;
      this.setLiveMode(true);
    } else {
      const entry = this.breadcrumb[index];
      this.zoomLevel = entry.zoom;
      this.dateFilter = entry.from ? { from: entry.from, to: entry.to } : null;
      this.breadcrumb = this.breadcrumb.slice(0, index);
    }
    this.lastFingerprint = '';
    this.updateZoomLabel();
    this.updateBreadcrumb();
    this.poll();
  }

  // ─── Drill Down ──────────────────────────────────────

  drillDown(group) {
    // Push current state to breadcrumb
    this.breadcrumb.push({
      label: ZOOM_LABELS[this.zoomLevel],
      zoom: this.zoomLevel,
      from: this.dateFilter?.from ?? null,
      to: this.dateFilter?.to ?? null,
    });

    // Zoom in one level + filter to this group's time range
    this.zoomLevel = Math.max(0, this.zoomLevel - 1);
    this.dateFilter = {
      from: new Date(group.firstBatchAt).toISOString(),
      to: new Date(group.lastBatchAt + 1).toISOString(), // +1ms to include last batch
    };
    this.manualZoom = true;
    this.setLiveMode(false);
    this.lastFingerprint = '';
    this.updateZoomLabel();
    this.updateBreadcrumb();
    this.poll();
  }

  // ─── Auto-Zoom ───────────────────────────────────────

  autoZoomLevel(count) {
    if (count <= 50) return 0;
    if (count <= 365) return 1;
    if (count <= 1500) return 2;
    if (count <= 6000) return 3;
    return 4;
  }

  // ─── Timer ────────────────────────────────────────────

  tickCountdown() {
    if (this.serverNextBatchMs == null) return;
    const elapsed = Date.now() - this.lastServerPollAt;
    this.localCountdownMs = Math.max(0, this.serverNextBatchMs - elapsed);
    this.updateTimerDisplay();
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

  triggerBuildAnimation() {
    const statusData = window._lastStatusData ? window._lastStatusData() : null;
    if (statusData && statusData.leviathans) {
      for (const lev of statusData.leviathans) {
        if (lev.status === 'running') {
          const svg = document.getElementById('graph-svg');
          if (svg && svg.__forceGraph) {
            svg.__forceGraph.pulseNode(lev.id, '#26c6da', 3);
          }
        }
      }
    }
  }

  // ─── Polling ──────────────────────────────────────────

  async poll() {
    try {
      let url = '/flowchart/batch-detail?zoom=' + this.zoomLevel;
      if (this.dateFilter) {
        url += '&from=' + encodeURIComponent(this.dateFilter.from);
        url += '&to=' + encodeURIComponent(this.dateFilter.to);
      }
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      // Update timer state from server
      if (data.nextBatchInMs != null) {
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
      this.totalBatches = data.totalBatches ?? 0;

      // Auto-zoom on first poll if there are many batches
      if (!this.autoZoomDone && !this.manualZoom && this.liveMode && this.totalBatches > 50) {
        this.autoZoomDone = true;
        this.zoomLevel = this.autoZoomLevel(this.totalBatches);
        this.setLiveMode(false); // auto-zoom implies historical view
        this.updateZoomLabel();
        this.poll(); // re-poll at correct zoom
        return;
      }
      this.autoZoomDone = true;

      this.render(data);
    } catch { /* ignore */ }
  }

  // ─── Rendering ────────────────────────────────────────

  render(data) {
    const { pendingReceipts = [] } = data;
    this.lastPendingReceipts = pendingReceipts;

    if (data.type === 'grouped') {
      this.renderGroups(data);
    } else {
      this.renderIndividual(data);
    }
  }

  renderIndividual(data) {
    const { batches = [], pendingReceipts = [] } = data;
    this.lastBatches = batches;

    // Fingerprint to avoid unnecessary DOM churn
    const fp = JSON.stringify({
      z: this.zoomLevel,
      b: batches.map(b => b.batchNumber + ':' + (b.receipts ? b.receipts.length : 0) + ':' + b.l1Status),
      p: pendingReceipts.length,
    });
    if (fp === this.lastFingerprint) return;
    this.lastFingerprint = fp;

    this.container.innerHTML = '';

    for (const batch of batches) {
      this.container.appendChild(this.createBatchCard(batch));
    }

    // Always show pending card
    this.container.appendChild(this.createPendingCard(pendingReceipts));

    // Auto-scroll to end in LIVE mode
    if (this.liveMode) {
      this.container.scrollLeft = this.container.scrollWidth;
    }
  }

  renderGroups(data) {
    const { groups = [], pendingReceipts = [] } = data;

    const fp = JSON.stringify({
      z: this.zoomLevel,
      g: groups.map(g => g.key + ':' + g.batchCount),
      p: pendingReceipts.length,
    });
    if (fp === this.lastFingerprint) return;
    this.lastFingerprint = fp;

    this.container.innerHTML = '';

    for (const group of groups) {
      this.container.appendChild(this.createGroupCard(group));
    }

    // Pending card at end
    this.container.appendChild(this.createPendingCard(pendingReceipts));
  }

  // ─── Group Card ───────────────────────────────────────

  createGroupCard(group) {
    const card = document.createElement('div');
    card.className = 'batch-card bc-group';

    // Header: label + batch count
    const header = document.createElement('div');
    header.className = 'bc-header';
    header.innerHTML = `
      <span class="bc-batch-num">${escapeHtml(group.label)}</span>
      <span class="bc-count">${group.batchCount} batch${group.batchCount !== 1 ? 'es' : ''}</span>
    `;
    card.appendChild(header);

    // Stats grid
    const stats = document.createElement('div');
    stats.className = 'bc-group-stats';

    const totalCostCents = group.totalPatientPayCents + group.totalPlanPayCents;

    stats.innerHTML = `
      <div><span class="bc-group-stat-label">REG</span> <span class="bc-group-stat-value">${group.registrationCount}</span></div>
      <div><span class="bc-group-stat-label">FILL</span> <span class="bc-group-stat-value">${group.fulfillmentCount}</span></div>
      <div><span class="bc-group-stat-label">REV</span> <span class="bc-group-stat-value">${group.reversalCount}</span></div>
    `;
    card.appendChild(stats);

    // Cost total
    if (totalCostCents > 0) {
      const total = document.createElement('div');
      total.className = 'bc-group-total';
      total.innerHTML = `
        <span class="bc-group-stat-label">Patient</span> <span class="bc-group-stat-value">${formatCents(group.totalPatientPayCents)}</span>
        &middot;
        <span class="bc-group-stat-label">Plan</span> <span class="bc-group-stat-value">${formatCents(group.totalPlanPayCents)}</span>
      `;
      card.appendChild(total);
    }

    // Worker badges (if any)
    if (group.workerIds && group.workerIds.length > 0) {
      const workers = document.createElement('div');
      workers.className = 'bc-group-workers';
      workers.innerHTML = group.workerIds.sort((a, b) => a - b)
        .map(id => `<span class="bc-worker-badge">W${id}</span>`).join(' ');
      card.appendChild(workers);
    }

    // Click → drill down (only if we can zoom in further)
    if (this.zoomLevel > 0) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        this.drillDown(group);
      });
    }

    return card;
  }

  // ─── Individual Batch Card ────────────────────────────

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

    let totalPatient = 0;
    let totalPlan = 0;
    for (const r of (batch.receipts || [])) {
      if (r.patientPayCents) totalPatient += r.patientPayCents;
      if (r.planPayCents) totalPlan += r.planPayCents;
    }

    const header = document.createElement('div');
    header.className = 'bc-header';
    const workerBadge = batch.workerId != null
      ? ` <span class="bc-worker-badge">W${batch.workerId}</span>` : '';
    header.innerHTML = `
      <span class="bc-batch-num">Batch #${batch.batchNumber}</span>
      ${workerBadge}
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
        const memberLabel = PrivacyMode.isActive()
          ? truncHash(r.walletId)
          : (shortMember(r.memberName) || truncHash(r.walletId));

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

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showBatchPopup(batch, card);
    });

    return card;
  }

  // ─── Pending Card ─────────────────────────────────────

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
        const memberName = PrivacyMode.isActive()
          ? truncHash(r.walletId)
          : (walletNameMap[r.walletId] ? shortMember(walletNameMap[r.walletId]) : truncHash(r.walletId));
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

  // ─── Batch Detail Popup ───────────────────────────────

  showBatchPopup(batch, cardEl) {
    const popup = this.popupEl;
    if (!popup) return;

    const rect = cardEl.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    popup.style.top = 'auto';

    let totalPatient = 0, totalPlan = 0;
    for (const r of batch.receipts) {
      if (r.patientPayCents) totalPatient += r.patientPayCents;
      if (r.planPayCents) totalPlan += r.planPayCents;
    }

    const statusLabel = this.getBatchStatusLabel(batch);
    const statusCls = batch.l1Status === 'settled' ? 'complete' : batch.l1Status === 'failed' ? 'error' : 'complete';

    let html = `
      <button class="btn-close-popup" onclick="document.getElementById('batch-popup').classList.add('hidden')">&times;</button>
      <h3>Batch #${batch.batchNumber}</h3>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;">
        ${formatTimestamp(batch.createdAt)} &middot; ${batch.transitionCount} transitions &middot;
        ${statusBadge(statusCls, statusLabel)}
        ${batch.workerId != null ? ` &middot; <span class="bc-worker-badge">W${batch.workerId}</span>` : ''}
        ${batch.proveTimeMs ? ` &middot; ${(batch.proveTimeMs / 1000).toFixed(1)}s prove` : ''}
      </div>
      ${(totalPatient > 0 || totalPlan > 0) ? `
        <div style="font-size:11px;margin-bottom:10px;display:flex;gap:16px;">
          <span>Patient Total: <strong>${formatCents(totalPatient)}</strong></span>
          <span>Plan Total: <strong>${formatCents(totalPlan)}</strong></span>
        </div>
      ` : ''}
      <table>
        <thead><tr>
          <th>Op</th><th>${PrivacyMode.isActive() ? 'Wallet' : 'Member'}</th><th>Drug</th><th>Patient</th><th>Plan</th>
        </tr></thead>
        <tbody>
    `;
    for (const r of batch.receipts) {
      const op = OP_CONFIG[r.operationType] || OP_CONFIG.transition;
      html += `<tr>
        <td><span class="badge" style="background:${op.color}20;color:${op.color}">${op.label}</span></td>
        <td>${PrivacyMode.isActive() ? truncHash(r.walletId) : (shortMember(r.memberName) || truncHash(r.walletId))}</td>
        <td>${r.brandName ? escapeHtml(r.brandName) : '\u2014'}</td>
        <td>${r.patientPayCents ? formatCents(r.patientPayCents) : '\u2014'}</td>
        <td>${r.planPayCents ? formatCents(r.planPayCents) : '\u2014'}</td>
      </tr>`;
    }
    html += '</tbody></table>';

    popup.innerHTML = html;
    popup.classList.remove('hidden');

    const closeHandler = (e) => {
      if (!popup.contains(e.target) && !cardEl.contains(e.target)) {
        popup.classList.add('hidden');
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 100);
  }
}
