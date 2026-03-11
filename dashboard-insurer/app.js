/**
 * zkTrident Insurer Nautilus — SPA Application
 * Hash-based routing, auto-refresh, SSE live events.
 */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const navLinks = document.querySelectorAll('.nav-link');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');

  let currentPage = 'overview';
  let refreshTimer = null;
  let sseEvents = [];
  const MAX_EVENTS = 200;

  // ---- Toast ----
  function toast(msg, type) {
    type = type || 'info';
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 4000);
  }

  // ---- Connection Status ----
  function setConnectionStatus(state) {
    statusDot.className = 'status-dot ' + state;
    statusLabel.textContent = state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : 'Disconnected';
  }

  async function checkConnection() {
    setConnectionStatus('connecting');
    const ok = await API.checkConnection();
    setConnectionStatus(ok ? 'connected' : 'disconnected');
  }

  // ---- Helpers ----
  function esc(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function truncHash(h, len) {
    len = len || 12;
    if (!h) return '--';
    const s = String(h);
    return s.length > len ? s.slice(0, len) + '...' : s;
  }

  function fmtDate(val) {
    if (!val) return '--';
    try { return new Date(val).toLocaleString(); } catch { return String(val); }
  }

  function fmtDateShort(val) {
    if (!val) return '--';
    try { return new Date(val).toLocaleDateString(); } catch { return String(val); }
  }

  function loading() {
    return '<div class="loading-row"><span class="spinner"></span> Loading...</div>';
  }

  function emptyState(title, detail) {
    return '<div class="empty-state"><div class="empty-title">' + esc(title) + '</div>' +
      (detail ? '<div class="empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  function statCard(label, value, color, detail) {
    return '<div class="stat-card"><div class="stat-label">' + esc(label) + '</div><div class="stat-value ' + (color || '') + '">' + esc(String(value)) + '</div>' +
      (detail ? '<div class="stat-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  function detailRow(label, value) {
    return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span><span class="detail-value mono">' + esc(String(value)) + '</span></div>';
  }

  function formField(id, label, type, placeholder) {
    return '<div class="form-group"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="' + type + '" id="' + id + '" placeholder="' + esc(placeholder) + '">' +
      '<span class="field-error" id="' + id + '-err"></span></div>';
  }

  function val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function setErr(id, msg) { const el = document.getElementById(id + '-err'); if (el) el.textContent = msg; }
  function clearErrors() { for (let i = 0; i < arguments.length; i++) setErr(arguments[i], ''); }

  function renderDetailObj(obj) {
    if (!obj || typeof obj !== 'object') return '<div class="detail-value mono">' + esc(String(obj)) + '</div>';
    const keys = Object.keys(obj);
    if (keys.length === 0) return emptyState('Empty', 'No data returned');
    return '<div class="detail-grid"><div>' +
      keys.map(k => {
        const v = obj[k];
        const display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
        return detailRow(k, display);
      }).join('') + '</div></div>';
  }

  // ---- Router ----
  function navigate(page) {
    currentPage = page || 'overview';
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.tab === currentPage));
    clearInterval(refreshTimer);
    renderPage();
  }

  window.addEventListener('hashchange', () => {
    navigate(location.hash.replace('#', '') || 'overview');
  });

  function renderPage() {
    switch (currentPage) {
      case 'overview': renderOverview(); break;
      case 'receipts': renderReceipts(); break;
      case 'batches': renderBatches(); break;
      case 'claims': renderClaims(); break;
      case 'audit': renderAudit(); break;
      case 'messaging': renderMessaging(); break;
      case 'admin': renderAdmin(); break;
      default: renderOverview();
    }
  }

  // ==== OVERVIEW ====
  async function renderOverview() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Insurer Overview</div></div>' +
      '<div class="stats-grid" id="ov-stats">' + loading() + '</div>' +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Onboarding Status</span></div><div class="panel-body" id="ov-onboard">' + loading() + '</div></div>' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Live Events</span><span id="ov-event-count" style="font-size:11px;color:var(--text-muted)"></span></div><div class="events-log" id="ov-events">' + emptyState('No events yet') + '</div></div>' +
      '</div>';
    loadOverviewStats();
    loadOnboardingStatus();
    renderEventLog();
    refreshTimer = setInterval(loadOverviewStats, 30000);
  }

  async function loadOverviewStats() {
    const grid = document.getElementById('ov-stats');
    if (!grid) return;
    try {
      const [receipts, batches, health] = await Promise.allSettled([
        API.getReceipts(1, 0),
        API.getBatches(1, 0),
        API.getHealth(),
      ]);

      const receiptData = receipts.status === 'fulfilled' ? receipts.value : null;
      const batchData = batches.status === 'fulfilled' ? batches.value : null;
      const healthData = health.status === 'fulfilled' ? health.value : null;
      const healthOk = health.status === 'fulfilled';

      // Extract counts from response data
      const rData = receiptData && receiptData.data ? receiptData.data : receiptData;
      const bData = batchData && batchData.data ? batchData.data : batchData;
      const receiptCount = Array.isArray(rData) ? rData.length : '--';
      const batchCount = Array.isArray(bData) ? bData.length : '--';

      grid.innerHTML =
        statCard('Receipts', receiptCount, 'blue') +
        statCard('Batches', batchCount, 'purple') +
        statCard('Node Health', healthOk ? 'Healthy' : 'Unavailable', healthOk ? 'green' : 'red') +
        statCard('SSE Events', sseEvents.length, 'yellow');
    } catch {
      grid.innerHTML = statCard('Status', 'Error', 'red');
    }
  }

  async function loadOnboardingStatus() {
    const el = document.getElementById('ov-onboard');
    if (!el) return;
    try {
      const res = await API.getOnboardingStatus();
      const data = res.data || res;
      el.innerHTML = '<div class="detail-grid"><div>' +
        detailRow('Phase', data.phase || data.onboarding?.phase || '--') +
        detailRow('Role', data.role || '--') +
        '</div></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed: ' + esc(e.message) + '</div>';
    }
  }

  function renderEventLog() {
    const el = document.getElementById('ov-events');
    if (!el) return;
    if (sseEvents.length === 0) { el.innerHTML = emptyState('No events yet'); return; }
    el.innerHTML = sseEvents.slice(-50).reverse().map(ev => {
      const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '--';
      const type = ev.type || ev.event || 'event';
      const data = ev.data || ev.message || JSON.stringify(ev).slice(0, 120);
      return '<div class="event-item"><span class="event-time">' + esc(time) +
        '</span><span class="event-type">' + esc(type) +
        '</span><span class="event-data">' + esc(String(data)) + '</span></div>';
    }).join('');
    const countEl = document.getElementById('ov-event-count');
    if (countEl) countEl.textContent = sseEvents.length + ' total';
  }

  // ==== RECEIPTS ====
  async function renderReceipts() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Proof Receipts</div><button class="btn sm" id="btn-refresh-receipts">Refresh</button></div>' +
      '<div class="panel"><div class="panel-body no-pad" id="receipts-table">' + loading() + '</div></div>';
    document.getElementById('btn-refresh-receipts').onclick = loadReceiptsTable;
    loadReceiptsTable();
  }

  async function loadReceiptsTable() {
    const el = document.getElementById('receipts-table');
    if (!el) return;
    el.innerHTML = loading();
    try {
      const res = await API.getReceipts(200, 0);
      const receipts = Array.isArray(res) ? res : (res.data || []);
      if (receipts.length === 0) {
        el.innerHTML = emptyState('No receipts', 'No proofs have been submitted yet');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>#</th><th>Wallet ID</th><th>Type</th><th>Status</th><th>Timestamp</th></tr></thead><tbody>' +
        receipts.map((r, i) => {
          const wid = r.walletId || r.publicOutput?.walletId || '--';
          const type = r.operationType || r.type || '--';
          const status = r.l1Status || r.status || 'pending';
          const bc = status === 'accepted' || status === 'settled' ? 'green' : status === 'rejected' ? 'red' : 'yellow';
          return '<tr><td class="mono">' + (i + 1) + '</td>' +
            '<td class="mono truncate" title="' + esc(wid) + '">' + esc(truncHash(wid, 16)) + '</td>' +
            '<td>' + esc(type) + '</td>' +
            '<td><span class="badge ' + bc + '">' + esc(status) + '</span></td>' +
            '<td class="mono">' + esc(fmtDate(r.timestamp || r.acceptedAt)) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed to load receipts: ' + esc(e.message) + '</div>';
    }
  }

  // ==== BATCHES ====
  async function renderBatches() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Batches</div><button class="btn sm" id="btn-refresh-batches">Refresh</button></div>' +
      '<div class="panel"><div class="panel-body no-pad" id="batches-table">' + loading() + '</div></div>';
    document.getElementById('btn-refresh-batches').onclick = loadBatchesTable;
    loadBatchesTable();
  }

  async function loadBatchesTable() {
    const el = document.getElementById('batches-table');
    if (!el) return;
    el.innerHTML = loading();
    try {
      const res = await API.getBatches(200, 0);
      const batches = Array.isArray(res) ? res : (res.data || []);
      if (batches.length === 0) {
        el.innerHTML = emptyState('No batches', 'No batches have been built yet');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Batch #</th><th>Receipts</th><th>Status</th><th>Block Height</th><th>Built At</th></tr></thead><tbody>' +
        batches.map(b => {
          const batchNum = b.batchNumber ?? b.id ?? '--';
          const receiptCount = b.receiptCount ?? (b.receipts ? b.receipts.length : '--');
          const status = b.l1Status || b.status || 'pending';
          const bc = status === 'settled' ? 'green' : status === 'failed' ? 'red' : 'yellow';
          const height = b.blockHeight ?? b.chainState?.blockHeight ?? '--';
          return '<tr><td class="mono">' + esc(batchNum) + '</td>' +
            '<td class="mono">' + esc(receiptCount) + '</td>' +
            '<td><span class="badge ' + bc + '">' + esc(status) + '</span></td>' +
            '<td class="mono">' + esc(height) + '</td>' +
            '<td class="mono">' + esc(fmtDate(b.builtAt || b.timestamp)) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed to load batches: ' + esc(e.message) + '</div>';
    }
  }

  // ==== CLAIMS ====
  async function renderClaims() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Claims Lookup</div></div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Query Claims by Entity</span></div><div class="panel-body">' +
        '<div class="form-grid">' +
          '<div class="form-group"><label for="cl-type">Entity Type</label>' +
            '<select id="cl-type"><option value="member">Member</option><option value="prescriber">Prescriber</option><option value="pharmacy">Pharmacy</option><option value="drug">Drug (NDC Hash)</option></select></div>' +
          formField('cl-id', 'Wallet ID / NDC Hash', 'text', 'Enter wallet ID or NDC hash') +
        '</div>' +
        '<div class="form-actions"><button class="btn primary" id="btn-query-claims">Query</button></div>' +
      '</div></div>' +
      '<div class="panel" id="claims-results-panel" style="display:none"><div class="panel-header"><span class="panel-title">Results</span></div><div class="panel-body no-pad" id="claims-results">' + loading() + '</div></div>';

    document.getElementById('btn-query-claims').onclick = doQueryClaims;
  }

  async function doQueryClaims() {
    const type = document.getElementById('cl-type').value;
    const id = val('cl-id');
    if (!id) { toast('Enter an ID to query', 'error'); return; }

    const resultsPanel = document.getElementById('claims-results-panel');
    const el = document.getElementById('claims-results');
    resultsPanel.style.display = 'block';
    el.innerHTML = loading();

    try {
      let data;
      switch (type) {
        case 'member': data = await API.getMemberClaims(id); break;
        case 'prescriber': data = await API.getPrescriberClaims(id); break;
        case 'pharmacy': data = await API.getPharmacyClaims(id); break;
        case 'drug': data = await API.getDrugClaims(id); break;
      }
      const claims = Array.isArray(data) ? data : (data && data.data ? data.data : []);
      if (claims.length === 0) {
        el.innerHTML = emptyState('No claims found', 'No claims match this ' + type + ' ID');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>#</th><th>Member</th><th>NDC Hash</th><th>Patient Pay</th><th>Plan Pay</th><th>Date</th></tr></thead><tbody>' +
        claims.map((c, i) => {
          return '<tr><td class="mono">' + (i + 1) + '</td>' +
            '<td class="mono truncate">' + esc(truncHash(c.memberWalletId || c.walletId, 14)) + '</td>' +
            '<td class="mono truncate">' + esc(truncHash(c.ndcHash, 14)) + '</td>' +
            '<td class="mono">' + esc(c.patientPayCents != null ? '$' + (Number(c.patientPayCents) / 100).toFixed(2) : '--') + '</td>' +
            '<td class="mono">' + esc(c.planPayCents != null ? '$' + (Number(c.planPayCents) / 100).toFixed(2) : '--') + '</td>' +
            '<td class="mono">' + esc(c.dateOfService || fmtDateShort(c.timestamp)) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Query failed: ' + esc(e.message) + '</div>';
    }
  }

  // ==== AUDIT ====
  async function renderAudit() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Audit</div></div>' +
      '<div class="stats-grid">' +
        '<div class="stat-card" style="cursor:pointer" id="btn-chain-integrity"><div class="stat-label">Chain Integrity</div><div class="stat-value blue" id="audit-chain-val">Check</div></div>' +
        '<div class="stat-card" style="cursor:pointer" id="btn-financial-balance"><div class="stat-label">Financial Balance</div><div class="stat-value blue" id="audit-finance-val">Check</div></div>' +
        '<div class="stat-card" style="cursor:pointer" id="btn-duplicate-claims"><div class="stat-label">Duplicate Claims</div><div class="stat-value blue" id="audit-dup-val">Check</div></div>' +
      '</div>' +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Audit Log</span><button class="btn sm" id="btn-refresh-audit-log">Refresh</button></div><div class="panel-body no-pad" id="audit-log-table">' + loading() + '</div></div>' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Chain Proof</span><button class="btn sm" id="btn-refresh-chain-proof">Refresh</button></div><div class="panel-body" id="chain-proof-detail">' + loading() + '</div></div>' +
      '</div>';

    document.getElementById('btn-chain-integrity').onclick = doChainIntegrity;
    document.getElementById('btn-financial-balance').onclick = doFinancialBalance;
    document.getElementById('btn-duplicate-claims').onclick = doDuplicateClaims;
    document.getElementById('btn-refresh-audit-log').onclick = loadAuditLog;
    document.getElementById('btn-refresh-chain-proof').onclick = loadChainProof;
    loadAuditLog();
    loadChainProof();
  }

  async function doChainIntegrity() {
    const el = document.getElementById('audit-chain-val');
    el.textContent = '...';
    el.className = 'stat-value yellow';
    try {
      const res = await API.verifyChainIntegrity();
      const data = res.data || res;
      const ok = data.valid || data.integrity || data.ok;
      el.textContent = ok ? 'PASS' : 'FAIL';
      el.className = 'stat-value ' + (ok ? 'green' : 'red');
      toast('Chain integrity: ' + (ok ? 'PASS' : 'FAIL'), ok ? 'success' : 'error');
    } catch (e) {
      el.textContent = 'Error';
      el.className = 'stat-value red';
      toast('Chain integrity check failed: ' + e.message, 'error');
    }
  }

  async function doFinancialBalance() {
    const el = document.getElementById('audit-finance-val');
    el.textContent = '...';
    el.className = 'stat-value yellow';
    try {
      const res = await API.verifyFinancialBalance();
      const data = res.data || res;
      const ok = data.balanced || data.valid || data.ok;
      el.textContent = ok ? 'PASS' : 'FAIL';
      el.className = 'stat-value ' + (ok ? 'green' : 'red');
      toast('Financial balance: ' + (ok ? 'PASS' : 'FAIL'), ok ? 'success' : 'error');
    } catch (e) {
      el.textContent = 'Error';
      el.className = 'stat-value red';
      toast('Financial balance check failed: ' + e.message, 'error');
    }
  }

  async function doDuplicateClaims() {
    const el = document.getElementById('audit-dup-val');
    el.textContent = '...';
    el.className = 'stat-value yellow';
    try {
      const res = await API.detectDuplicateClaims();
      const data = res.data || res;
      const count = data.duplicateCount ?? (Array.isArray(data.duplicates) ? data.duplicates.length : 0);
      el.textContent = count === 0 ? 'None' : count;
      el.className = 'stat-value ' + (count === 0 ? 'green' : 'red');
      toast('Duplicate claims: ' + count, count === 0 ? 'success' : 'error');
    } catch (e) {
      el.textContent = 'Error';
      el.className = 'stat-value red';
      toast('Duplicate claim check failed: ' + e.message, 'error');
    }
  }

  async function loadAuditLog() {
    const el = document.getElementById('audit-log-table');
    if (!el) return;
    el.innerHTML = loading();
    try {
      const res = await API.getAuditLog(50, 0);
      const data = res.data || res;
      const events = data.events || (Array.isArray(data) ? data : []);
      if (events.length === 0) {
        el.innerHTML = emptyState('No audit events', 'Audit log is empty');
        return;
      }
      el.innerHTML = '<div class="table-wrap" style="max-height:400px;overflow-y:auto"><table class="data-table"><thead><tr>' +
        '<th>#</th><th>Wallet ID</th><th>Type</th><th>Seq</th><th>Chain Hash</th></tr></thead><tbody>' +
        events.map((e, i) => {
          return '<tr><td class="mono">' + (i + 1) + '</td>' +
            '<td class="mono truncate">' + esc(truncHash(e.walletId, 14)) + '</td>' +
            '<td>' + esc(e.isRegistration ? 'Registration' : 'Update') + '</td>' +
            '<td class="mono">' + esc(e.sequenceNumber ?? '--') + '</td>' +
            '<td class="mono truncate">' + esc(truncHash(e.chainHash, 14)) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed to load audit log: ' + esc(e.message) + '</div>';
    }
  }

  async function loadChainProof() {
    const el = document.getElementById('chain-proof-detail');
    if (!el) return;
    el.innerHTML = loading();
    try {
      const res = await API.getChainProof();
      const data = res.data || res;
      el.innerHTML = renderDetailObj(data);
    } catch (e) {
      el.innerHTML = '<div class="error-banner">No chain proof available: ' + esc(e.message) + '</div>';
    }
  }

  // ==== MESSAGING ====
  async function renderMessaging() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Messaging</div></div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Message Store Status</span><button class="btn sm" id="btn-refresh-msg-status">Refresh</button></div><div class="panel-body" id="msg-status">' + loading() + '</div></div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Lookup Messages by Wallet</span></div><div class="panel-body">' +
        '<div style="display:flex;gap:12px;align-items:flex-end">' +
          '<div class="form-group" style="flex:1"><label for="msg-wallet-id">Wallet ID</label><input type="text" id="msg-wallet-id" placeholder="Enter wallet ID"></div>' +
          '<button class="btn primary" id="btn-lookup-msgs" style="margin-bottom:22px">Lookup</button>' +
        '</div>' +
      '</div></div>' +
      '<div class="panel" id="msg-results-panel" style="display:none"><div class="panel-header"><span class="panel-title">Messages</span></div><div class="panel-body no-pad" id="msg-results"></div></div>';

    document.getElementById('btn-refresh-msg-status').onclick = loadMsgStatus;
    document.getElementById('btn-lookup-msgs').onclick = doLookupMessages;
    loadMsgStatus();
  }

  async function loadMsgStatus() {
    const el = document.getElementById('msg-status');
    if (!el) return;
    try {
      const res = await API.getMessageStoreStatus();
      const data = res.data || res;
      el.innerHTML = renderDetailObj(data);
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed: ' + esc(e.message) + '</div>';
    }
  }

  async function doLookupMessages() {
    const walletId = val('msg-wallet-id');
    if (!walletId) { toast('Enter a wallet ID', 'error'); return; }

    const panel = document.getElementById('msg-results-panel');
    const el = document.getElementById('msg-results');
    panel.style.display = 'block';
    el.innerHTML = loading();

    try {
      const res = await API.getMessagesByWallet(walletId);
      const messages = Array.isArray(res) ? res : (res.data || []);
      if (messages.length === 0) {
        el.innerHTML = emptyState('No messages', 'No messages found for this wallet');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>#</th><th>Sender</th><th>Recipient</th><th>Thread</th><th>Timestamp</th></tr></thead><tbody>' +
        messages.map((m, i) => {
          return '<tr><td class="mono">' + (i + 1) + '</td>' +
            '<td class="mono truncate">' + esc(truncHash(m.senderWalletId || m.sender, 14)) + '</td>' +
            '<td class="mono truncate">' + esc(truncHash(m.recipientWalletId || m.recipient, 14)) + '</td>' +
            '<td class="mono truncate">' + esc(truncHash(m.threadIdHash || m.threadId, 14)) + '</td>' +
            '<td class="mono">' + esc(fmtDate(m.timestamp || m.storedAt)) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Lookup failed: ' + esc(e.message) + '</div>';
    }
  }

  // ==== ADMIN ====
  async function renderAdmin() {
    const savedToken = API.getAdminToken();
    app.innerHTML = '<div class="section-header"><div class="section-title">Admin</div></div>' +
      '<div class="admin-token-bar"><label>Admin Token:</label><input type="password" id="admin-token-input" placeholder="Enter admin bearer token" value="' + esc(savedToken) + '"><button class="btn sm" id="btn-set-token">Set</button></div>' +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Node Health</span><button class="btn sm" id="btn-refresh-health">Refresh</button></div><div class="panel-body" id="admin-health">' + loading() + '</div></div>' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Actions</span></div><div class="panel-body">' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
            '<button class="btn primary" id="btn-force-batch">Force Batch</button>' +
          '</div>' +
        '</div></div>' +
      '</div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Enrollment Processing</span></div><div class="panel-body">' +
        '<div class="form-grid">' +
          formField('enr-walletId', 'Wallet ID', 'text', 'Wallet ID to enroll') +
          formField('enr-tokenId', 'Token ID', 'text', 'Enrollment token (optional)') +
          formField('enr-role', 'Role', 'text', 'member / prescriber / pharmacy') +
        '</div>' +
        '<div class="form-actions"><button class="btn primary" id="btn-process-enrollment">Process Enrollment</button><span id="enr-status"></span></div>' +
      '</div></div>';

    document.getElementById('btn-set-token').onclick = () => {
      API.setAdminToken(document.getElementById('admin-token-input').value.trim());
      toast('Admin token updated', 'info');
    };
    document.getElementById('btn-refresh-health').onclick = loadAdminHealth;
    document.getElementById('btn-force-batch').onclick = doForceBatch;
    document.getElementById('btn-process-enrollment').onclick = doProcessEnrollment;
    loadAdminHealth();
  }

  async function loadAdminHealth() {
    const el = document.getElementById('admin-health');
    if (!el) return;
    try {
      const data = await API.getHealth();
      el.innerHTML = renderDetailObj(data);
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Health check failed: ' + esc(e.message) + '</div>';
    }
  }

  async function doForceBatch() {
    const btn = document.getElementById('btn-force-batch');
    btn.disabled = true;
    btn.textContent = 'Forcing...';
    try {
      const res = await API.forceBatch();
      toast('Batch forced successfully', 'success');
    } catch (e) {
      toast('Force batch failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Force Batch';
    }
  }

  async function doProcessEnrollment() {
    clearErrors('enr-walletId', 'enr-role');
    const walletId = val('enr-walletId');
    const tokenId = val('enr-tokenId');
    const role = val('enr-role');
    if (!walletId) { setErr('enr-walletId', 'Wallet ID is required'); return; }

    const btn = document.getElementById('btn-process-enrollment');
    btn.disabled = true;
    btn.textContent = 'Processing...';
    try {
      await API.processEnrollment(walletId, tokenId || undefined, role || undefined);
      toast('Enrollment processed', 'success');
    } catch (e) {
      toast('Enrollment failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Process Enrollment';
    }
  }

  // ---- SSE ----
  function initSSE() {
    API.connectSSE((event) => {
      if (!event.timestamp) event.timestamp = Date.now();
      sseEvents.push(event);
      if (sseEvents.length > MAX_EVENTS) sseEvents = sseEvents.slice(-MAX_EVENTS);
      if (currentPage === 'overview') renderEventLog();
    });
    API.onConnectionChange(setConnectionStatus);
  }

  // ---- Init ----
  function init() {
    checkConnection();
    initSSE();
    navigate(location.hash.replace('#', '') || 'overview');
  }

  init();
})();
