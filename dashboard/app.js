/**
 * zkTrident Explorer — Main Application
 */
const App = (() => {
  let currentPage = 'overview';
  let eventSource = null;
  let formularyData = null;
  let healthPollTimer = null;
  let lastPoolState = null;

  // ── Utilities ──

  function $(id) { return document.getElementById(id); }

  function truncHash(h, n = 8) {
    if (!h || h.length <= n * 2 + 2) return h || '-';
    return h.slice(0, n) + '...' + h.slice(-n);
  }

  function timeAgo(ts) {
    if (!ts) return '-';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
  }

  function formatMs(ms) {
    if (!ms) return '-';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function statusBadge(status) {
    const cls = { settled: 'badge-settled', pending: 'badge-pending', failed: 'badge-failed', building: 'badge-building' };
    return `<span class="badge ${cls[status] || 'badge-pending'}">${status || 'pending'}</span>`;
  }

  function tierBadge(tier) {
    const cls = { 1: 'badge-tier1', 2: 'badge-tier2', 3: 'badge-tier3', 4: 'badge-tier4' };
    const names = { 1: 'T1 Generic', 2: 'T2 Preferred', 3: 'T3 Brand', 4: 'T4 Specialty' };
    return `<span class="badge ${cls[tier] || ''}">${names[tier] || 'T' + tier}</span>`;
  }

  function hashLink(hash, type) {
    if (!hash) return '-';
    if (type === 'receipt') return `<a href="#/receipt/${hash}" class="hash" title="${hash}">${truncHash(hash)}</a>`;
    if (type === 'wallet') return `<a href="#/wallet/${hash}" class="hash" title="${hash}">${truncHash(hash)}</a>`;
    if (type === 'batch') return `<a href="#/batch/${hash}">#${hash}</a>`;
    return `<span class="hash" title="${hash}">${truncHash(hash)}</span>`;
  }

  // ── Router ──

  function navigate() {
    const hash = location.hash || '#/';
    const parts = hash.slice(2).split('/');
    const page = parts[0] || 'overview';
    const param = parts[1];

    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    if (page === 'batch' && param) {
      $('page-batch-detail').classList.remove('hidden');
      loadBatchDetail(param);
    } else if (page === 'receipt' && param) {
      $('page-receipt-detail').classList.remove('hidden');
      loadReceiptDetail(param);
    } else if (page === 'wallet' && param) {
      $('page-wallets').classList.remove('hidden');
      document.querySelector('[data-page="wallets"]').classList.add('active');
      $('walletInput').value = param;
      loadWallet(param);
    } else {
      const el = $('page-' + page);
      if (el) {
        el.classList.remove('hidden');
        const navEl = document.querySelector(`[data-page="${page}"]`);
        if (navEl) navEl.classList.add('active');
      }
      if (page === 'overview') loadOverview();
      else if (page === 'batches') loadBatches();
      else if (page === 'receipts') loadReceipts();
      else if (page === 'formulary') loadFormulary();
    }
    currentPage = page;
  }

  // ── Overview ──

  async function loadOverview() {
    try {
      const status = await RPC.getStatus();
      $('statBlockHeight').textContent = status.blockHeight || '0';
      $('statWalletCount').textContent = status.currentWalletCount || '0';
      $('statBatchCount').textContent = status.totalBatchesBuilt || '0';
      $('statPendingProofs').textContent = status.pendingProofs || '0';
      $('statProofsAccepted').textContent = status.totalProofsAccepted || '0';
      $('statUptime').textContent = formatUptime(status.uptimeMs || 0);

      $('statusDot').classList.add('connected');
      $('statusText').textContent = 'Connected';
    } catch (err) {
      $('statusDot').classList.add('error');
      $('statusText').textContent = 'Error';
    }

    // Latest batches
    try {
      const batches = await RPC.getAllBatches();
      const recent = (batches || []).slice(-5).reverse();
      if (recent.length === 0) {
        $('latestBatches').innerHTML = '<div class="no-data">No batches yet</div>';
      } else {
        $('latestBatches').innerHTML = '<ul class="mini-list">' + recent.map(b => `
          <li class="mini-item">
            <div class="mini-left">
              <div class="mini-icon">B</div>
              <div>
                <div class="mini-label">${hashLink(b.batchNumber, 'batch')}</div>
                <div class="mini-sub">${b.registrationCount || 0} reg, ${b.transitionCount || 0} txn</div>
              </div>
            </div>
            <div class="mini-right">
              ${statusBadge(b.l1Status || b.status)}
              <div class="mini-time">${timeAgo(b.createdAt)}</div>
            </div>
          </li>
        `).join('') + '</ul>';
      }
    } catch { $('latestBatches').innerHTML = '<div class="no-data">Failed to load batches</div>'; }

    // Latest receipts
    try {
      const receipts = await RPC.getAllReceipts();
      const recent = (receipts || []).slice(-5).reverse();
      if (recent.length === 0) {
        $('latestReceipts').innerHTML = '<div class="no-data">No receipts yet</div>';
      } else {
        $('latestReceipts').innerHTML = '<ul class="mini-list">' + recent.map(r => `
          <li class="mini-item">
            <div class="mini-left">
              <div class="mini-icon">${r.isRegistration ? 'R' : 'T'}</div>
              <div>
                <div class="mini-label">${hashLink(r.receiptId, 'receipt')}</div>
                <div class="mini-sub">${hashLink(r.walletId, 'wallet')}</div>
              </div>
            </div>
            <div class="mini-right">
              ${statusBadge(r.l1Status || r.status)}
              <div class="mini-time">${timeAgo(r.acceptedAt)}</div>
            </div>
          </li>
        `).join('') + '</ul>';
      }
    } catch { $('latestReceipts').innerHTML = '<div class="no-data">Failed to load receipts</div>'; }

    // Chain state
    try {
      const cs = await RPC.getChainState();
      $('chainState').innerHTML = `<div class="detail-grid">
        <div class="detail-key">Registry Root</div><div class="detail-val">${cs.registryRoot || '-'}</div>
        <div class="detail-key">Lifecycle Root</div><div class="detail-val">${cs.lifecycleRoot || '-'}</div>
        <div class="detail-key">Global State Root</div><div class="detail-val">${cs.globalStateRoot || '-'}</div>
        <div class="detail-key">Audit Chain Hash</div><div class="detail-val">${cs.auditChainHash || '-'}</div>
        <div class="detail-key">Latest Batch</div><div class="detail-val">${cs.latestBatchNumber ? hashLink(cs.latestBatchNumber, 'batch') : '-'} ${cs.latestBatchStatus ? statusBadge(cs.latestBatchStatus) : ''}</div>
        <div class="detail-key">Chain Proof</div><div class="detail-val">${cs.chainProofEnabled ? '<span class="badge badge-settled">enabled</span>' : '<span class="badge badge-pending">disabled</span>'}</div>
      </div>`;
    } catch { $('chainState').innerHTML = '<div class="no-data">Failed to load chain state</div>'; }
  }

  // ── Batches ──

  async function loadBatches() {
    try {
      const batches = await RPC.getAllBatches();
      const rows = (batches || []).reverse();
      if (rows.length === 0) {
        $('batchesTableBody').innerHTML = '<tr><td colspan="7" class="no-data">No batches yet</td></tr>';
        return;
      }
      $('batchesTableBody').innerHTML = rows.map(b => `
        <tr>
          <td>${hashLink(b.batchNumber, 'batch')}</td>
          <td>${(b.blockNumbers || []).length}</td>
          <td>${b.registrationCount || 0}</td>
          <td>${b.transitionCount || 0}</td>
          <td>${statusBadge(b.l1Status || b.status)}</td>
          <td>${formatMs(b.proveTimeMs)}</td>
          <td>${timeAgo(b.createdAt)}</td>
        </tr>
      `).join('');
    } catch { $('batchesTableBody').innerHTML = '<tr><td colspan="7" class="no-data">Failed to load</td></tr>'; }
  }

  async function loadBatchDetail(num) {
    $('batchDetailNum').textContent = '#' + num;
    try {
      const b = await RPC.getBatch(num);
      if (!b) { $('batchDetailContent').innerHTML = '<div class="no-data">Batch not found</div>'; return; }
      $('batchDetailContent').innerHTML = `<div class="detail-grid">
        <div class="detail-key">Batch Number</div><div class="detail-val">${b.batchNumber}</div>
        <div class="detail-key">Status</div><div class="detail-val">${statusBadge(b.l1Status || b.status)}</div>
        <div class="detail-key">Blocks</div><div class="detail-val">${(b.blockNumbers || []).join(', ') || '-'}</div>
        <div class="detail-key">Registrations</div><div class="detail-val">${b.registrationCount || 0}</div>
        <div class="detail-key">Transitions</div><div class="detail-val">${b.transitionCount || 0}</div>
        <div class="detail-key">Old Registry Root</div><div class="detail-val">${b.oldRegistryRoot || '-'}</div>
        <div class="detail-key">New Registry Root</div><div class="detail-val">${b.newRegistryRoot || '-'}</div>
        <div class="detail-key">Old Lifecycle Root</div><div class="detail-val">${b.oldLifecycleRoot || '-'}</div>
        <div class="detail-key">New Lifecycle Root</div><div class="detail-val">${b.newLifecycleRoot || '-'}</div>
        <div class="detail-key">Global State Root</div><div class="detail-val">${b.globalStateRoot || '-'}</div>
        <div class="detail-key">Block Height</div><div class="detail-val">${b.blockHeight || '-'}</div>
        <div class="detail-key">Claim Accum. Root</div><div class="detail-val">${b.claimAccumulatorRoot || '-'}</div>
        <div class="detail-key">Message Store Root</div><div class="detail-val">${b.messageStoreRoot || '-'}</div>
        <div class="detail-key">Prove Time</div><div class="detail-val">${formatMs(b.proveTimeMs)}</div>
        <div class="detail-key">Worker ID</div><div class="detail-val">${b.workerId ?? '-'}</div>
        <div class="detail-key">Created</div><div class="detail-val">${b.createdAt ? new Date(b.createdAt).toISOString() : '-'}</div>
        <div class="detail-key">Failure Reason</div><div class="detail-val">${b.failureReason || '-'}</div>
        <div class="detail-key">Batch Proof</div><div class="detail-val" style="max-height:100px;overflow:auto">${b.batchProofJson ? '<code>' + truncHash(b.batchProofJson, 40) + '</code>' : '-'}</div>
      </div>`;
    } catch { $('batchDetailContent').innerHTML = '<div class="no-data">Failed to load batch</div>'; }
  }

  // ── Receipts ──

  async function loadReceipts() {
    try {
      const receipts = await RPC.getAllReceipts();
      const rows = (receipts || []).reverse();
      if (rows.length === 0) {
        $('receiptsTableBody').innerHTML = '<tr><td colspan="7" class="no-data">No receipts yet</td></tr>';
        return;
      }
      $('receiptsTableBody').innerHTML = rows.map(r => `
        <tr>
          <td>${hashLink(r.receiptId, 'receipt')}</td>
          <td>${hashLink(r.walletId, 'wallet')}</td>
          <td>${r.sequenceNumber || '0'}</td>
          <td><span class="badge ${r.isRegistration ? 'badge-registration' : 'badge-transition'}">${r.isRegistration ? 'registration' : 'transition'}</span></td>
          <td>${statusBadge(r.l1Status || r.status)}</td>
          <td>${r.l1BatchNumber ? hashLink(r.l1BatchNumber, 'batch') : '-'}</td>
          <td>${timeAgo(r.acceptedAt)}</td>
        </tr>
      `).join('');
    } catch { $('receiptsTableBody').innerHTML = '<tr><td colspan="7" class="no-data">Failed to load</td></tr>'; }
  }

  async function loadReceiptDetail(id) {
    $('receiptDetailId').textContent = truncHash(id, 12);
    try {
      const r = await RPC.getReceipt(id);
      if (!r) { $('receiptDetailContent').innerHTML = '<div class="no-data">Receipt not found</div>'; return; }
      $('receiptDetailContent').innerHTML = `<div class="detail-grid">
        <div class="detail-key">Receipt ID</div><div class="detail-val">${r.receiptId}</div>
        <div class="detail-key">Wallet ID</div><div class="detail-val">${hashLink(r.walletId, 'wallet')}</div>
        <div class="detail-key">Type</div><div class="detail-val"><span class="badge ${r.isRegistration ? 'badge-registration' : 'badge-transition'}">${r.isRegistration ? 'registration' : 'transition'}</span></div>
        <div class="detail-key">Sequence Number</div><div class="detail-val">${r.sequenceNumber || '0'}</div>
        <div class="detail-key">Status</div><div class="detail-val">${statusBadge(r.l1Status || r.status)}</div>
        <div class="detail-key">Batch Number</div><div class="detail-val">${r.l1BatchNumber ? hashLink(r.l1BatchNumber, 'batch') : '-'}</div>
        <div class="detail-key">L2 Block</div><div class="detail-val">${r.l2BlockNumber || '-'}</div>
        <div class="detail-key">Old Registry Root</div><div class="detail-val">${r.oldRegistryRoot || '-'}</div>
        <div class="detail-key">New Registry Root</div><div class="detail-val">${r.newRegistryRoot || '-'}</div>
        <div class="detail-key">Old Lifecycle Root</div><div class="detail-val">${r.oldLifecycleRoot || '-'}</div>
        <div class="detail-key">New Lifecycle Root</div><div class="detail-val">${r.newLifecycleRoot || '-'}</div>
        <div class="detail-key">Audit Event Hash</div><div class="detail-val">${r.auditEventHash || '-'}</div>
        <div class="detail-key">Claim Leaf Index</div><div class="detail-val">${r.claimLeafIndex || '-'}</div>
        <div class="detail-key">Accepted At</div><div class="detail-val">${r.acceptedAt ? new Date(r.acceptedAt).toISOString() : '-'}</div>
      </div>`;
    } catch { $('receiptDetailContent').innerHTML = '<div class="no-data">Failed to load receipt</div>'; }
  }

  // ── Wallet ──

  async function loadWallet(walletId) {
    const container = $('walletResults');
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
      const receipts = await RPC.getReceiptsByWallet(walletId);
      if (!receipts || receipts.length === 0) {
        container.innerHTML = '<div class="no-data">No receipts found for this wallet</div>';
        return;
      }
      container.innerHTML = `
        <p style="margin-bottom:12px;color:var(--text-secondary)">${receipts.length} receipt(s) found</p>
        <table class="data-table">
          <thead><tr><th>Receipt ID</th><th>Seq #</th><th>Type</th><th>Status</th><th>Batch</th><th>Time</th></tr></thead>
          <tbody>${receipts.map(r => `
            <tr>
              <td>${hashLink(r.receiptId, 'receipt')}</td>
              <td>${r.sequenceNumber || '0'}</td>
              <td><span class="badge ${r.isRegistration ? 'badge-registration' : 'badge-transition'}">${r.isRegistration ? 'registration' : 'transition'}</span></td>
              <td>${statusBadge(r.l1Status || r.status)}</td>
              <td>${r.l1BatchNumber ? hashLink(r.l1BatchNumber, 'batch') : '-'}</td>
              <td>${timeAgo(r.acceptedAt)}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<div class="no-data">Error: ${err.message}</div>`;
    }
  }

  // ── Formulary ──

  async function loadFormulary() {
    if (formularyData) { renderFormulary(formularyData); return; }
    try {
      const result = await RPC.getFormulary();
      if (result && result.entriesJson) {
        formularyData = JSON.parse(result.entriesJson);
        $('formularyCount').textContent = `(${formularyData.length} NDCs)`;
        renderFormulary(formularyData);
      } else {
        $('formularyTableBody').innerHTML = '<tr><td colspan="7" class="no-data">No formulary data</td></tr>';
      }
    } catch {
      $('formularyTableBody').innerHTML = '<tr><td colspan="7" class="no-data">Failed to load formulary</td></tr>';
    }
  }

  function renderFormulary(data) {
    const filter = ($('formularyFilter')?.value || '').toLowerCase();
    const filtered = filter ? data.filter(e =>
      (e.ndc || '').toLowerCase().includes(filter) ||
      (e.brandName || '').toLowerCase().includes(filter) ||
      (e.genericName || '').toLowerCase().includes(filter) ||
      (e.therapeuticClass || '').toLowerCase().includes(filter)
    ) : data;

    if (filtered.length === 0) {
      $('formularyTableBody').innerHTML = '<tr><td colspan="7" class="no-data">No matching entries</td></tr>';
      return;
    }

    // Show max 100 at a time
    const shown = filtered.slice(0, 100);
    $('formularyTableBody').innerHTML = shown.map(e => `
      <tr>
        <td><span class="hash-full" style="font-size:12px">${e.ndc || '-'}</span></td>
        <td>${e.brandName || '-'}</td>
        <td>${e.genericName || '-'}</td>
        <td>${tierBadge(e.tierLevel || 1)}</td>
        <td>${e.therapeuticClass || '-'}</td>
        <td>${e.strength || '-'}</td>
        <td>${e.pricePerUnit != null ? '$' + e.pricePerUnit.toFixed(2) : '-'}</td>
      </tr>
    `).join('') + (filtered.length > 100 ? `<tr><td colspan="7" class="no-data">Showing 100 of ${filtered.length} — refine filter</td></tr>` : '');
  }

  // ── Admin ──

  async function loadAdmin() {
    try {
      const status = await RPC.getStatus();
      $('adminNodeStatus').textContent = status.running ? 'Running' : 'Stopped';
      $('adminPoolStatus').textContent = status.pendingProofs + ' pending';
      $('adminMemory').textContent = '-';
      $('adminSseClients').textContent = '-';

      $('adminNodeInfo').innerHTML = `<div class="detail-grid">
        <div class="detail-key">Running</div><div class="detail-val">${status.running}</div>
        <div class="detail-key">Uptime</div><div class="detail-val">${formatUptime(status.uptimeMs)}</div>
        <div class="detail-key">Proofs Accepted</div><div class="detail-val">${status.totalProofsAccepted}</div>
        <div class="detail-key">Batches Built</div><div class="detail-val">${status.totalBatchesBuilt}</div>
        <div class="detail-key">Batches Settled</div><div class="detail-val">${status.totalBatchesSettled}</div>
        <div class="detail-key">Batches Failed</div><div class="detail-val">${status.totalBatchesFailed}</div>
        <div class="detail-key">Batch Interval</div><div class="detail-val">${formatMs(status.batchIntervalMs)}</div>
        <div class="detail-key">Next Batch In</div><div class="detail-val">${formatMs(status.nextBatchInMs)}</div>
        <div class="detail-key">In-Flight Batch</div><div class="detail-val">${status.inFlightBatch || '-'}</div>
        <div class="detail-key">Chain Proof</div><div class="detail-val">${status.chainProofEnabled ? 'enabled' : 'disabled'}</div>
        <div class="detail-key">L2 Only</div><div class="detail-val">${status.l2Only}</div>
      </div>`;

      // Audit log
      try {
        const audit = await RPC.getAuditLog();
        const events = (audit || []).slice(-10).reverse();
        if (events.length === 0) {
          $('adminAuditLog').innerHTML = '<div class="no-data">No audit events</div>';
        } else {
          $('adminAuditLog').innerHTML = `<table class="data-table">
            <thead><tr><th>Chain Hash</th><th>Wallet</th><th>Seq</th><th>Reg?</th></tr></thead>
            <tbody>${events.map(e => `
              <tr>
                <td><span class="hash" title="${e.chainHash || ''}">${truncHash(e.chainHash)}</span></td>
                <td>${hashLink(e.walletId, 'wallet')}</td>
                <td>${e.sequenceNumber || '-'}</td>
                <td>${e.isRegistration ? 'Yes' : 'No'}</td>
              </tr>
            `).join('')}</tbody>
          </table>`;
        }
      } catch { $('adminAuditLog').innerHTML = '<div class="no-data">Failed to load audit log</div>'; }
    } catch (err) {
      $('adminNodeInfo').innerHTML = `<div class="no-data">Error: ${err.message}</div>`;
    }
  }

  // ── Search ──

  function handleSearch(query) {
    if (!query) return;
    query = query.trim();

    // NDC pattern (11 digits with dashes)
    if (/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(query) || /^\d{11}$/.test(query)) {
      location.hash = '#/formulary';
      setTimeout(() => {
        $('formularyFilter').value = query;
        if (formularyData) renderFormulary(formularyData);
      }, 100);
      return;
    }
    // Short number = batch
    if (/^\d{1,6}$/.test(query)) {
      location.hash = '#/batch/' + query;
      return;
    }
    // Long hash = try receipt first, then wallet
    if (query.length > 20) {
      location.hash = '#/receipt/' + query;
      return;
    }
    // Default: wallet lookup
    location.hash = '#/wallet/' + query;
  }

  // ── Pipeline & Pool ──

  async function updatePipeline() {
    try {
      const health = await RPC.getHealthData();
      const status = await RPC.getStatus();

      // Pipeline: Incoming Proofs
      const pending = status.pendingProofs || 0;
      $('pip-pending').textContent = pending;
      const proofStage = $('pip-pending').closest('.pipeline-stage');
      if (proofStage) proofStage.classList.toggle('active', pending > 0);

      // Pipeline: Workers
      const pool = health.provingPool;
      const workers = health.workers || [];
      if (workers.length > 0) {
        $('pip-workers').innerHTML = workers.map(w => {
          const cls = w.busy ? 'proving' : (w.status === 'dead' ? 'dead' : 'idle');
          const label = w.busy ? `W${w.id}: proving` : `W${w.id}: ${w.status || 'idle'}`;
          return `<div class="worker-box ${cls}">${label}</div>`;
        }).join('');
      } else if (pool) {
        const workerCount = pool.poolSize || 1;
        const boxes = [];
        for (let i = 0; i < workerCount; i++) {
          boxes.push(`<div class="worker-box idle">W${i}: idle</div>`);
        }
        $('pip-workers').innerHTML = boxes.join('');
      }

      // Pipeline: arrows flow when busy
      const anyBusy = workers.some(w => w.busy);
      document.querySelectorAll('.pipeline-arrow').forEach((a, i) => {
        if (i === 0) a.classList.toggle('flowing', pending > 0 || anyBusy);
        else if (i === 1) a.classList.toggle('flowing', anyBusy || status.inFlightBatch);
        else a.classList.toggle('flowing', !!status.inFlightBatch);
      });

      // Worker stage glow
      const workerStage = $('pip-workers').closest('.pipeline-stage');
      if (workerStage) {
        workerStage.classList.toggle('proving', anyBusy);
        workerStage.classList.toggle('active', !anyBusy && pending > 0);
      }

      // Pipeline: Batch Builder
      const batchStage = $('pip-batch').closest('.pipeline-stage');
      if (status.inFlightBatch) {
        $('pip-batch').textContent = 'building';
        $('pip-batch-detail').textContent = `batch #${status.inFlightBatch}`;
        if (batchStage) batchStage.classList.add('building');
      } else {
        $('pip-batch').textContent = 'idle';
        $('pip-batch-detail').textContent = `next in ${formatMs(status.nextBatchInMs)}`;
        if (batchStage) batchStage.classList.remove('building');
      }

      // Pipeline: Chain
      $('pip-height').textContent = status.blockHeight || '0';
      $('pip-settled').textContent = `${status.totalBatchesSettled || 0} settled`;

      // Pool detail section
      if (pool) {
        $('pool-jobs-done').textContent = `${pool.totalJobsCompleted || 0} jobs`;
        $('pool-avg-time').textContent = `avg: ${formatMs(pool.avgProveTimeMs)}`;
        $('pool-queue').textContent = `queue: ${pool.queueDepth || 0}`;

        if (workers.length > 0) {
          $('poolDetail').innerHTML = '<div class="pool-workers">' + workers.map(w => {
            const cls = w.busy ? 'busy' : (w.status === 'dead' ? 'dead' : 'idle');
            return `<div class="pool-worker-card ${cls}">
              <div class="pool-worker-header">
                <span class="pool-worker-id">Worker ${w.id}</span>
                <span class="pool-worker-status ${cls}">${w.busy ? 'proving' : (w.status || 'idle')}</span>
              </div>
              <div class="pool-worker-meta">
                <span>Jobs: ${w.jobsProcessed || 0}</span>
                ${w.currentJobId ? `<span>Job: ${w.currentJobId}</span>` : ''}
                ${w.lastProveTimeMs ? `<span>Last: ${formatMs(w.lastProveTimeMs)}</span>` : ''}
              </div>
            </div>`;
          }).join('') + '</div>';
        } else {
          $('poolDetail').innerHTML = `<div class="pool-workers">
            <div class="pool-worker-card idle">
              <div class="pool-worker-header">
                <span class="pool-worker-id">Pool</span>
                <span class="pool-worker-status idle">active</span>
              </div>
              <div class="pool-worker-meta">
                <span>Size: ${pool.poolSize || 0}</span>
                <span>Alive: ${pool.workersAlive || 0}</span>
              </div>
            </div>
          </div>`;
        }
      } else {
        $('poolDetail').innerHTML = '<div class="no-data">No proving pool (single-process mode)</div>';
        $('pool-jobs-done').textContent = '0 jobs';
        $('pool-avg-time').textContent = 'avg: --';
        $('pool-queue').textContent = 'queue: 0';
      }

      lastPoolState = pool;
    } catch {
      // Silently ignore health poll failures
    }
  }

  function startHealthPoll() {
    updatePipeline();
    healthPollTimer = setInterval(() => {
      if (currentPage === 'overview') updatePipeline();
    }, 3000);
  }

  // ── SSE ──

  function connectSSE() {
    const badge = $('sseBadge');
    eventSource = RPC.connectSSE((event) => {
      badge.classList.add('badge-live');
      addEvent(event);
    }, () => {
      badge.classList.remove('badge-live');
      // Auto-reconnect after 5s
      setTimeout(() => { if (!eventSource || eventSource.readyState === 2) connectSSE(); }, 5000);
    });
  }

  function addEvent(event) {
    const log = $('eventLog');
    const placeholder = log.querySelector('.event-placeholder');
    if (placeholder) placeholder.remove();

    const item = document.createElement('div');
    item.className = 'event-item';
    item.innerHTML = `
      <span class="event-time">${new Date().toLocaleTimeString()}</span>
      <span class="event-type">${event.type || 'event'}</span>
      <span class="event-data">${JSON.stringify(event.data || event).slice(0, 200)}</span>
    `;
    log.prepend(item);

    // Keep max 50 events
    while (log.children.length > 50) log.lastChild.remove();

    // Refresh overview stats and pipeline on proof/batch/pool events
    const evtType = event.type || '';
    if (currentPage === 'overview' && (evtType.includes('proof') || evtType.includes('batch') || evtType.includes('pool'))) {
      loadOverview();
      updatePipeline();
    }
  }

  // ── Init ──

  function init() {
    // Router
    window.addEventListener('hashchange', navigate);

    // Search
    $('searchBtn').addEventListener('click', () => handleSearch($('searchInput').value));
    $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch($('searchInput').value); });

    // Wallet search
    $('walletSearchBtn').addEventListener('click', () => {
      const wid = $('walletInput').value.trim();
      if (wid) { location.hash = '#/wallet/' + wid; }
    });
    $('walletInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const wid = $('walletInput').value.trim();
        if (wid) location.hash = '#/wallet/' + wid;
      }
    });

    // Formulary filter
    $('formularyFilter')?.addEventListener('input', () => {
      if (formularyData) renderFormulary(formularyData);
    });

    // Admin auth
    $('adminLoginBtn').addEventListener('click', () => {
      const token = $('adminTokenInput').value.trim();
      if (token) {
        RPC.setAdminToken(token);
        $('adminAuth').classList.add('hidden');
        $('adminContent').classList.remove('hidden');
        loadAdmin();
      }
    });
    $('adminTokenInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('adminLoginBtn').click();
    });
    $('adminRefreshBtn')?.addEventListener('click', loadAdmin);

    // Admin actions
    $('forceBatchBtn')?.addEventListener('click', async () => {
      try {
        await RPC.forceBatch();
        alert('Batch forced successfully');
        loadAdmin();
      } catch (err) { alert('Force batch failed: ' + err.message); }
    });

    // Initial health check
    RPC.health().then(ok => {
      $('statusDot').classList.add(ok ? 'connected' : 'error');
      $('statusText').textContent = ok ? 'Connected' : 'Disconnected';
    }).catch(() => {
      $('statusDot').classList.add('error');
      $('statusText').textContent = 'Disconnected';
    });

    // SSE
    connectSSE();

    // Pipeline health polling (every 3s)
    startHealthPoll();

    // Navigate to current hash
    navigate();

    // Auto-refresh overview every 30s
    setInterval(() => { if (currentPage === 'overview') loadOverview(); }, 30000);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { init };
})();
