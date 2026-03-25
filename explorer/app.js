/**
 * Adjuda-GATOR Leviathan Explorer — Application Logic
 * 8 tabs: Overview, Batches, Receipts, Wallets, Claims, Messages, Audit, Network
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────
  var currentTab = 'overview';
  var eventLog = [];
  var statusCache = null;
  var allReceipts = [];
  var allBatches = [];
  var pollTimer = null;
  var MAX_LOG = 150;

  // ── Helpers ───────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return document.querySelectorAll(sel); }

  function shortHash(h) {
    if (!h) return '--';
    var s = String(h);
    return s.length > 16 ? s.slice(0, 8) + '\u2026' + s.slice(-6) : s;
  }

  function fmtTime(t) {
    if (!t) return '--';
    var d = new Date(t);
    return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDate(t) {
    if (!t) return '--';
    var d = new Date(t);
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + fmtTime(t);
  }

  function fmtAgo(ms) {
    if (!ms && ms !== 0) return '--';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
    return Math.floor(ms / 3600000) + 'h ago';
  }

  function fmtCents(c) {
    if (c === undefined || c === null) return '--';
    return '$' + (Number(c) / 100).toFixed(2);
  }

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    $('toast-container').appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function setConn(state) {
    var dot = $('conn-dot');
    dot.className = 'conn-dot ' + state;
    $('conn-label').textContent = state === 'connected' ? 'Live' : 'Offline';
  }

  function statusBadge(s) {
    var st = String(s || '').toLowerCase();
    if (st === 'settled') return '<span class="badge badge-success">Settled</span>';
    if (st === 'batched') return '<span class="badge badge-info">Batched</span>';
    if (st === 'accepted' || st === 'pending') return '<span class="badge badge-warning">Pending</span>';
    if (st === 'failed') return '<span class="badge badge-error">Failed</span>';
    return '<span class="badge badge-info">' + esc(s || '--') + '</span>';
  }

  function typeBadge(isReg) {
    return isReg ? '<span class="badge badge-purple">Registration</span>'
                 : '<span class="badge badge-info">Transition</span>';
  }

  function msgTypeBadge(t) {
    var labels = { '1': 'Clinical', '2': 'Admin', '3': 'eScript' };
    var label = labels[String(t)] || 'Type ' + t;
    return '<span class="badge msg-type-' + t + '">' + esc(label) + '</span>';
  }

  function statCard(label, value, detail, accent) {
    return '<div class="stat-card' + (accent ? ' stat-accent' : '') + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + esc(String(value)) + '</div>' +
      (detail ? '<div class="stat-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  function detailRow(key, val) {
    return '<div class="detail-key">' + esc(key) + '</div>' +
      '<div class="detail-val">' + esc(String(val)) + '</div>';
  }

  // ── Router ────────────────────────────────────────────
  function navigate(tab) {
    currentTab = tab;
    qsa('.page').forEach(function (p) { p.classList.add('hidden'); });
    qsa('.nav-link').forEach(function (l) { l.classList.remove('active'); });
    var page = $('page-' + tab);
    if (page) page.classList.remove('hidden');
    var link = qs('.nav-link[data-tab="' + tab + '"]');
    if (link) link.classList.add('active');
    loadTab(tab);
  }

  function loadTab(tab) {
    switch (tab) {
      case 'overview': loadOverview(); break;
      case 'batches': loadBatches(); break;
      case 'receipts': loadReceipts(); break;
      case 'wallets': break; // on-demand lookup
      case 'claims': loadClaimsStats(); break;
      case 'messages': loadMessageStats(); break;
      case 'audit': loadAudit(); break;
      case 'network': loadNetwork(); break;
    }
  }

  // ── Global Search ─────────────────────────────────────
  function setupGlobalSearch() {
    $('global-search').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = this.value.trim();
      if (!q) return;
      if (q.startsWith('rcpt-') || q.startsWith('rcpt_')) {
        navigate('receipts');
        setTimeout(function () { $('receipt-search').value = q; searchReceipts(); }, 100);
      } else if (q.match(/^#?\d+$/)) {
        navigate('batches');
        setTimeout(function () { showBatchDetail(parseInt(q.replace('#', ''), 10)); }, 100);
      } else {
        // Assume wallet ID
        navigate('wallets');
        setTimeout(function () { $('wallet-search').value = q; lookupWallet(); }, 100);
      }
    });
  }

  // ══════════════════════════════════════════════════════
  //  OVERVIEW
  // ══════════════════════════════════════════════════════
  async function loadOverview() {
    try {
      var status = await RPC.getStatus();
      statusCache = status;
      setConn('connected');

      // Footer
      $('footer-node').textContent = status.nodeId || 'sequencer';
      $('footer-height').textContent = status.blockHeight !== undefined ? status.blockHeight : '--';
      try { var pi = await RPC.getPeerInfo(); $('footer-peers').textContent = (pi.connectedPeers || pi.peers || []).length || 0; } catch {}

      // Stats
      var pending = status.pendingProofs || status.pending || 0;
      var totalR = status.totalReceipts || status.receiptCount || 0;
      var totalB = status.totalBatches || status.batchCount || 0;
      var wallets = status.walletCount || '--';
      var height = status.blockHeight !== undefined ? status.blockHeight : '--';
      $('ov-stats').innerHTML =
        statCard('Block Height', height, '', true) +
        statCard('Total Receipts', totalR, '', true) +
        statCard('Total Batches', totalB, '', true) +
        statCard('Wallets', wallets, '', true) +
        statCard('Pending Proofs', pending, 'Awaiting next batch') +
        statCard('Uptime', status.uptimeMs ? fmtAgo(status.uptimeMs) : '--');

      // Pipeline counts
      $('pipe-pending').textContent = pending;
      $('pipe-proving').textContent = status.provingCount || 0;
      $('pipe-batching').textContent = status.batchingCount || 0;
      $('pipe-settled').textContent = totalR;
      $('pipe-workers-sub').textContent = (status.workerCount || status.poolSize || '--') + ' workers';

      // Throughput strip
      var avgProve = status.avgProveMs ? (status.avgProveMs / 1000).toFixed(1) + 's' : '--';
      $('throughput-strip').innerHTML =
        '<div class="tp-stat"><span class="tp-val">' + totalR + '</span><span class="tp-label">Processed</span></div>' +
        '<div class="tp-stat"><span class="tp-val">' + totalB + '</span><span class="tp-label">Batches</span></div>' +
        '<div class="tp-stat"><span class="tp-val">' + (status.proofsPerSec || '0.0') + '</span><span class="tp-label">Proofs/sec</span></div>' +
        '<div class="tp-stat"><span class="tp-val">' + avgProve + '</span><span class="tp-label">Avg Prove</span></div>' +
        '<div class="tp-stat"><span class="tp-val">' + (status.workerCount || status.poolSize || '--') + '</span><span class="tp-label">Workers</span></div>';

      // Recent batches
      try {
        var batches = await RPC.getAllBatches(5);
        if (!Array.isArray(batches)) batches = batches ? [batches] : [];
        allBatches = batches;
        $('ov-batches').innerHTML = batches.length ? renderBatchTable(batches, true) : '<div class="empty-state">No batches</div>';
      } catch { $('ov-batches').innerHTML = '<div class="empty-state">--</div>'; }

      // Recent receipts
      try {
        var receipts = await RPC.getAllReceipts(5);
        if (!Array.isArray(receipts)) receipts = receipts ? [receipts] : [];
        $('ov-receipts').innerHTML = receipts.length ? renderReceiptTable(receipts, true) : '<div class="empty-state">No receipts</div>';
      } catch { $('ov-receipts').innerHTML = '<div class="empty-state">--</div>'; }
    } catch (e) {
      setConn('disconnected');
      toast('Failed to load: ' + e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════
  //  BATCHES
  // ══════════════════════════════════════════════════════
  async function loadBatches() {
    try {
      var batches = await RPC.getAllBatches(200);
      if (!Array.isArray(batches)) batches = batches ? [batches] : [];
      allBatches = batches;

      var settled = batches.filter(function (b) { return (b.l1Status || b.status) === 'settled'; }).length;
      var totalTxns = batches.reduce(function (a, b) {
        return a + (b.registrationCount || 0) + (b.transitionCount || 0);
      }, 0);
      $('batch-stats').innerHTML =
        statCard('Total Batches', batches.length, '', true) +
        statCard('Settled', settled, '', true) +
        statCard('Total Txns', totalTxns) +
        statCard('Latest', batches.length ? '#' + (batches[0].batchNumber || batches[0].index || 0) : '--');

      $('batch-table-wrap').innerHTML = batches.length ? '<div class="table-wrap">' + renderBatchTable(batches, false) + '</div>' : '<div class="empty-state">No batches</div>';
    } catch (e) {
      toast('Batches failed: ' + e.message, 'error');
    }
  }

  function renderBatchTable(batches, compact) {
    var html = '<table class="data-table"><thead><tr>' +
      '<th>Batch</th><th>Regs</th><th>Txns</th><th>Status</th>' +
      (compact ? '' : '<th>Prove</th><th>Chain Root</th>') +
      '<th>Height</th><th>Time</th></tr></thead><tbody>';
    batches.forEach(function (b) {
      var num = b.batchNumber !== undefined ? b.batchNumber : (b.index || '--');
      var st = b.l1Status || b.status || '--';
      html += '<tr onclick="window._showBatch(' + num + ')">' +
        '<td class="mono">#' + num + '</td>' +
        '<td>' + (b.registrationCount || 0) + '</td>' +
        '<td>' + (b.transitionCount || 0) + '</td>' +
        '<td>' + statusBadge(st) + '</td>' +
        (compact ? '' : '<td class="mono">' + (b.proveTimeMs ? (b.proveTimeMs / 1000).toFixed(1) + 's' : '--') + '</td>' +
          '<td><span class="hash">' + shortHash(b.globalStateRoot || b.stateRoot) + '</span></td>') +
        '<td class="mono">' + (b.blockHeight || '--') + '</td>' +
        '<td class="text-muted" style="color:var(--text-muted)">' + fmtTime(b.createdAt || b.timestamp) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  window._showBatch = function (n) { showBatchDetail(n); };

  async function showBatchDetail(batchNum) {
    var panel = $('batch-detail-panel');
    panel.classList.remove('hidden');
    $('batch-detail').innerHTML = '<div class="loading">Loading batch #' + batchNum + '...</div>';
    try {
      var b = await RPC.getBatch(batchNum);
      if (!b) { $('batch-detail').innerHTML = '<div class="empty-state">Batch not found</div>'; return; }
      $('batch-detail').innerHTML =
        '<div class="detail-grid">' +
        detailRow('Batch Number', b.batchNumber || b.index) +
        detailRow('Registrations', b.registrationCount || 0) +
        detailRow('Transitions', b.transitionCount || 0) +
        detailRow('Status', b.l1Status || b.status || '--') +
        detailRow('Block Height', b.blockHeight || '--') +
        detailRow('Prove Duration', b.proveTimeMs ? (b.proveTimeMs / 1000).toFixed(1) + 's' : '--') +
        detailRow('Worker', b.workerId !== undefined ? 'W-' + b.workerId : '--') +
        detailRow('Registry Root (old)', shortHash(b.oldRegistryRoot)) +
        detailRow('Registry Root (new)', shortHash(b.newRegistryRoot)) +
        detailRow('Lifecycle Root (old)', shortHash(b.oldLifecycleRoot)) +
        detailRow('Lifecycle Root (new)', shortHash(b.newLifecycleRoot)) +
        detailRow('Global State Root', shortHash(b.globalStateRoot)) +
        detailRow('Claim Accum. Root', shortHash(b.claimAccumulatorRoot)) +
        detailRow('Message Store Root', shortHash(b.messageStoreRoot)) +
        detailRow('Batch Proof', b.batchProofJson ? (b.batchProofJson.length / 1024).toFixed(1) + ' KB (ZK proof blob)' : '--') +
        detailRow('Chain Proof', b.chainProofJson ? (b.chainProofJson.length / 1024).toFixed(1) + ' KB (recursive)' : '--') +
        detailRow('State Certificate', b.stateCertificate ? (b.stateCertificate.signatures || []).length + ' signatures' : '--') +
        detailRow('Created At', fmtDate(b.createdAt || b.timestamp)) +
        '</div>';
    } catch (e) {
      $('batch-detail').innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  }

  // ══════════════════════════════════════════════════════
  //  RECEIPTS
  // ══════════════════════════════════════════════════════
  async function loadReceipts() {
    try {
      var receipts = await RPC.getAllReceipts(200);
      if (!Array.isArray(receipts)) receipts = receipts ? [receipts] : [];
      allReceipts = receipts;
      $('receipt-table-wrap').innerHTML = receipts.length ? '<div class="table-wrap">' + renderReceiptTable(receipts, false) + '</div>' : '<div class="empty-state">No receipts</div>';
    } catch (e) {
      toast('Receipts failed: ' + e.message, 'error');
    }
  }

  function renderReceiptTable(receipts, compact) {
    var html = '<table class="data-table"><thead><tr>' +
      '<th>Receipt ID</th><th>Wallet</th><th>Type</th><th>Status</th><th>Batch</th><th>Time</th></tr></thead><tbody>';
    receipts.forEach(function (r) {
      var rid = r.receiptId || r.id || '--';
      var st = r.l1Status || r.status || '--';
      html += '<tr onclick="window._showReceipt(\'' + esc(rid) + '\')">' +
        '<td><span class="mono truncate">' + esc(rid) + '</span></td>' +
        '<td><span class="hash">' + shortHash(r.walletId) + '</span></td>' +
        '<td>' + typeBadge(r.isRegistration) + '</td>' +
        '<td>' + statusBadge(st) + '</td>' +
        '<td class="mono">' + (r.l1BatchNumber !== undefined && r.l1BatchNumber !== null ? '#' + r.l1BatchNumber : '--') + '</td>' +
        '<td class="text-muted" style="color:var(--text-muted)">' + fmtTime(r.acceptedAt || r.timestamp) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  window._showReceipt = function (id) { showReceiptDetail(id); };

  async function showReceiptDetail(receiptId) {
    var panel = $('receipt-detail-panel');
    panel.classList.remove('hidden');
    $('receipt-detail').innerHTML = '<div class="loading">Loading...</div>';
    try {
      var r = await RPC.getReceipt(receiptId);
      if (!r) { $('receipt-detail').innerHTML = '<div class="empty-state">Receipt not found</div>'; return; }
      $('receipt-detail').innerHTML =
        '<div class="detail-grid">' +
        detailRow('Receipt ID', r.receiptId || r.id) +
        detailRow('Wallet ID', r.walletId || '--') +
        detailRow('Type', r.isRegistration ? 'Registration' : 'State Transition') +
        detailRow('Sequence #', r.sequenceNumber || '--') +
        detailRow('Status', r.l1Status || r.status || '--') +
        detailRow('Batch #', r.l1BatchNumber !== undefined ? r.l1BatchNumber : '--') +
        detailRow('Block #', r.l2BlockNumber || '--') +
        detailRow('Registry Root (old)', shortHash(r.oldRegistryRoot)) +
        detailRow('Registry Root (new)', shortHash(r.newRegistryRoot)) +
        detailRow('Lifecycle Root (old)', shortHash(r.oldLifecycleRoot)) +
        detailRow('Lifecycle Root (new)', shortHash(r.newLifecycleRoot)) +
        detailRow('Audit Event Hash', shortHash(r.auditEventHash)) +
        detailRow('Claim Leaf Index', r.claimLeafIndex !== undefined ? r.claimLeafIndex : '--') +
        detailRow('Quorum Certificate', r.quorumCertificate ? (r.quorumCertificate.votes || []).length + ' votes' : '--') +
        detailRow('Accepted At', fmtDate(r.acceptedAt || r.timestamp)) +
        '</div>';
    } catch (e) {
      $('receipt-detail').innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  }

  function searchReceipts() {
    var q = $('receipt-search').value.trim().toLowerCase();
    if (!q) { loadReceipts(); return; }
    // Filter locally if we have data, else try wallet lookup
    if (allReceipts.length) {
      var filtered = allReceipts.filter(function (r) {
        return (r.receiptId || '').toLowerCase().indexOf(q) >= 0 ||
               (r.walletId || '').toLowerCase().indexOf(q) >= 0;
      });
      $('receipt-table-wrap').innerHTML = filtered.length ? '<div class="table-wrap">' + renderReceiptTable(filtered, false) + '</div>' : '<div class="empty-state">No matching receipts</div>';
    } else {
      // Try wallet-specific query
      RPC.getReceiptsByWallet(q).then(function (receipts) {
        if (!Array.isArray(receipts)) receipts = receipts ? [receipts] : [];
        $('receipt-table-wrap').innerHTML = receipts.length ? '<div class="table-wrap">' + renderReceiptTable(receipts, false) + '</div>' : '<div class="empty-state">No receipts for this wallet</div>';
      }).catch(function () {
        $('receipt-table-wrap').innerHTML = '<div class="empty-state">Search failed</div>';
      });
    }
  }

  // ══════════════════════════════════════════════════════
  //  WALLETS
  // ══════════════════════════════════════════════════════
  async function lookupWallet() {
    var walletId = $('wallet-search').value.trim();
    if (!walletId) return;

    $('wallet-detail-panel').classList.remove('hidden');
    $('wallet-data-row').classList.remove('hidden');
    $('wallet-messages-panel').classList.remove('hidden');
    $('wallet-detail').innerHTML = '<div class="loading">Looking up wallet...</div>';
    $('wallet-receipts').innerHTML = '<div class="loading">Loading...</div>';
    $('wallet-claims').innerHTML = '<div class="loading">Loading...</div>';
    $('wallet-messages').innerHTML = '<div class="loading">Loading...</div>';

    // Receipts for wallet
    try {
      var receipts = await RPC.getReceiptsByWallet(walletId);
      if (!Array.isArray(receipts)) receipts = receipts ? [receipts] : [];
      var regs = receipts.filter(function (r) { return r.isRegistration; }).length;
      var txns = receipts.length - regs;

      // Accumulator
      var accum = null;
      try { accum = await RPC.reconstructAccumulator(walletId); } catch {}

      $('wallet-detail').innerHTML =
        '<div class="detail-grid">' +
        detailRow('Wallet ID', walletId) +
        detailRow('Total Receipts', receipts.length) +
        detailRow('Registrations', regs) +
        detailRow('Transitions', txns) +
        (accum ? detailRow('Patient Pay (total)', fmtCents(accum.patientPayCents || accum.totalPatientPay)) : '') +
        (accum ? detailRow('Plan Pay (total)', fmtCents(accum.planPayCents || accum.totalPlanPay)) : '') +
        (accum ? detailRow('Deductible Used', fmtCents(accum.deductibleCreditCents || accum.totalDeductibleCredit)) : '') +
        '</div>';

      $('wallet-receipts').innerHTML = receipts.length ? '<div class="table-wrap">' + renderReceiptTable(receipts, true) + '</div>' : '<div class="empty-state">No receipts</div>';
    } catch (e) {
      $('wallet-detail').innerHTML = '<div class="empty-state">Wallet not found or error: ' + esc(e.message) + '</div>';
      $('wallet-receipts').innerHTML = '<div class="empty-state">--</div>';
    }

    // Claims
    try {
      var claims = await RPC.getClaimsByMember(walletId);
      if (!Array.isArray(claims)) claims = claims ? [claims] : [];
      $('wallet-claims').innerHTML = claims.length ? renderClaimTable(claims) : '<div class="empty-state">No claims</div>';
    } catch { $('wallet-claims').innerHTML = '<div class="empty-state">--</div>'; }

    // Messages
    try {
      var msgs = await RPC.getMessagesByWallet(walletId);
      if (!Array.isArray(msgs)) msgs = msgs ? [msgs] : [];
      $('wallet-messages').innerHTML = msgs.length ? renderMessageTable(msgs) : '<div class="empty-state">No messages</div>';
    } catch { $('wallet-messages').innerHTML = '<div class="empty-state">--</div>'; }
  }

  // ══════════════════════════════════════════════════════
  //  CLAIMS
  // ══════════════════════════════════════════════════════
  async function loadClaimsStats() {
    try {
      var root = await RPC.getClaimAccumulatorRoot();
      $('claims-stats').innerHTML =
        statCard('Claim Tree Root', shortHash(root.root || root.claimAccumulatorRoot), '', true) +
        statCard('Total Claims', root.leafCount || root.count || '--', '', true);
    } catch {
      $('claims-stats').innerHTML = statCard('Claim Accumulator', '--');
    }
  }

  function setupClaimSearch() {
    $('claim-search-btn').addEventListener('click', async function () {
      var type = $('claim-search-type').value;
      var val = $('claim-search-input').value.trim();
      if (!val) return;
      $('claim-results').innerHTML = '<div class="loading">Searching...</div>';
      try {
        var claims = [];
        if (type === 'member') claims = await RPC.getClaimsByMember(val);
        else if (type === 'pharmacy') claims = await RPC.getClaimsByPharmacy(val);
        else if (type === 'prescriber') claims = await RPC.getClaimsByPrescriber(val);
        else if (type === 'ndc') claims = await RPC.getClaimsByNdc(val);
        else if (type === 'leaf') {
          var c = await RPC.getClaimWithProof(val);
          claims = c ? [c] : [];
        }
        if (!Array.isArray(claims)) claims = claims ? [claims] : [];
        $('claim-results').innerHTML = claims.length ? '<div class="table-wrap">' + renderClaimTable(claims) + '</div>' : '<div class="empty-state">No claims found</div>';
      } catch (e) {
        $('claim-results').innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
      }
    });
  }

  function renderClaimTable(claims) {
    var html = '<table class="data-table"><thead><tr>' +
      '<th>Member</th><th>NDC Hash</th><th>Pharmacy</th><th>Prescriber</th>' +
      '<th>Date</th><th>Patient Pay</th><th>Plan Pay</th><th>Type</th></tr></thead><tbody>';
    claims.forEach(function (c) {
      var leaf = c.leaf || c.claimLeaf || c;
      var meta = c.metadata || {};
      html += '<tr>' +
        '<td><span class="hash">' + shortHash(leaf.memberWalletId) + '</span></td>' +
        '<td><span class="hash">' + shortHash(leaf.ndcHash) + '</span></td>' +
        '<td><span class="hash">' + shortHash(leaf.pharmacyWalletId) + '</span></td>' +
        '<td><span class="hash">' + shortHash(leaf.prescriberWalletId) + '</span></td>' +
        '<td class="mono">' + esc(leaf.dateOfService || '--') + '</td>' +
        '<td class="mono">' + fmtCents(leaf.patientPayCents) + '</td>' +
        '<td class="mono">' + fmtCents(leaf.planPayCents) + '</td>' +
        '<td>' + (leaf.operationType === '2' || leaf.operationType === 2 ?
          '<span class="badge badge-error">Reversal</span>' :
          '<span class="badge badge-success">Fill</span>') + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // ══════════════════════════════════════════════════════
  //  MESSAGES
  // ══════════════════════════════════════════════════════
  async function loadMessageStats() {
    try {
      var root = await RPC.getMessageStoreRoot();
      $('msg-stats').innerHTML =
        statCard('Message Tree Root', shortHash(root.root || root.messageStoreRoot), '', true) +
        statCard('Total Messages', root.messageCount || root.count || '--', '', true);
    } catch {
      $('msg-stats').innerHTML = statCard('Message Store', '--');
    }
  }

  function setupMessageSearch() {
    $('msg-search-btn').addEventListener('click', async function () {
      var type = $('msg-search-type').value;
      var val = $('msg-search-input').value.trim();
      if (!val) return;
      $('msg-results').innerHTML = '<div class="loading">Searching...</div>';
      try {
        var msgs = [];
        if (type === 'wallet') msgs = await RPC.getMessagesByWallet(val);
        else if (type === 'sender') msgs = await RPC.getMessagesBySender(val);
        else if (type === 'recipient') msgs = await RPC.getMessagesByRecipient(val);
        else if (type === 'thread') msgs = await RPC.getMessagesByThread(val);
        if (!Array.isArray(msgs)) msgs = msgs ? [msgs] : [];
        $('msg-results').innerHTML = msgs.length ? '<div class="table-wrap">' + renderMessageTable(msgs) + '</div>' : '<div class="empty-state">No messages found</div>';
      } catch (e) {
        $('msg-results').innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
      }
    });
  }

  function renderMessageTable(msgs) {
    var html = '<table class="data-table"><thead><tr>' +
      '<th>Sender</th><th>Recipient</th><th>Type</th><th>Thread</th>' +
      '<th>Content</th><th>Time</th></tr></thead><tbody>';
    msgs.forEach(function (m) {
      var msg = m.message || m;
      var payload = m.payload || {};
      html += '<tr>' +
        '<td><span class="hash">' + shortHash(msg.senderWalletId) + '</span></td>' +
        '<td><span class="hash">' + shortHash(msg.recipientWalletId) + '</span></td>' +
        '<td>' + msgTypeBadge(msg.messageType || '--') + '</td>' +
        '<td><span class="hash">' + shortHash(msg.threadIdHash) + '</span></td>' +
        '<td style="color:var(--text-muted);font-style:italic;font-size:11px">' +
          (payload.ciphertext ? esc(payload.ciphertext.slice(0, 24)) + '... (encrypted)' : 'encrypted') +
        '</td>' +
        '<td class="text-muted" style="color:var(--text-muted)">' + fmtTime(payload.timestamp || m.timestamp) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // ══════════════════════════════════════════════════════
  //  AUDIT
  // ══════════════════════════════════════════════════════
  async function loadAudit() {
    // Reset check cards
    ['audit-chain-val', 'audit-finance-val', 'audit-dup-val'].forEach(function (id) {
      $(id).textContent = 'Check';
      $(id).closest('.stat-card').className = 'stat-card stat-clickable';
    });

    // Audit log
    try {
      var log = await RPC.getAuditLog(100);
      if (!Array.isArray(log)) log = log ? [log] : [];
      var html = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Seq</th><th>Wallet</th><th>Type</th><th>Patient</th><th>Plan</th><th>Chain Hash</th><th>Time</th></tr></thead><tbody>';
      log.slice(0, 50).forEach(function (ev) {
        html += '<tr><td class="mono">' + (ev.sequenceNumber || ev.seqNum || '--') + '</td>' +
          '<td><span class="hash">' + shortHash(ev.walletId) + '</span></td>' +
          '<td>' + typeBadge(ev.isRegistration) + '</td>' +
          '<td class="mono">' + fmtCents(ev.patientPayCents) + '</td>' +
          '<td class="mono">' + fmtCents(ev.planPayCents) + '</td>' +
          '<td><span class="hash">' + shortHash(ev.chainHash) + '</span></td>' +
          '<td class="text-muted" style="color:var(--text-muted)">' + fmtTime(ev.timestamp) + '</td></tr>';
      });
      html += '</tbody></table></div>';
      $('audit-log-container').innerHTML = log.length ? html : '<div class="empty-state">No audit events</div>';
    } catch { $('audit-log-container').innerHTML = '<div class="empty-state">Audit log unavailable</div>'; }

    // Chain proof
    try {
      var proof = await RPC.getChainProof();
      if (proof) {
        var gs = proof.globalState || proof.publicOutput || proof;
        $('audit-proof-container').innerHTML =
          '<div class="detail-grid">' +
          detailRow('Block Height', gs.blockHeight || proof.blockHeight || '--') +
          detailRow('Wallet Count', gs.walletCount || '--') +
          detailRow('Audit Chain Hash', shortHash(gs.auditChainHash)) +
          detailRow('Registry Root', shortHash(gs.walletRegistryRoot || gs.registryRoot)) +
          detailRow('Lifecycle Root', shortHash(gs.lifecycleRoot)) +
          detailRow('Benefit Plan Root', shortHash(gs.benefitPlanRoot)) +
          detailRow('Credential Registry', shortHash(gs.credentialRegistryRoot)) +
          detailRow('Messaging Root', shortHash(gs.messagingRoot)) +
          detailRow('Eligibility VK Hash', shortHash(gs.eligibilityVkHash)) +
          detailRow('Global State Root', shortHash(proof.globalStateRoot)) +
          '</div>';
      } else {
        $('audit-proof-container').innerHTML = '<div class="empty-state">No chain proof</div>';
      }
    } catch { $('audit-proof-container').innerHTML = '<div class="empty-state">Chain proof unavailable</div>'; }
  }

  function setupAuditChecks() {
    $('audit-chain-card').addEventListener('click', async function () {
      runAuditCheck(this, $('audit-chain-val'), RPC.verifyChainIntegrity, function (r) { return r && (r.valid || r.integrity === true); });
    });
    $('audit-finance-card').addEventListener('click', async function () {
      runAuditCheck(this, $('audit-finance-val'), RPC.verifyFinancialBalance, function (r) { return r && (r.balanced || r.valid); });
    });
    $('audit-dup-card').addEventListener('click', async function () {
      var card = this, val = $('audit-dup-val');
      card.className = 'stat-card stat-clickable check-running';
      val.textContent = '...';
      try {
        var res = await RPC.detectDuplicateClaims();
        var dups = Array.isArray(res) ? res.length : (res && res.duplicates ? res.duplicates.length : 0);
        card.className = 'stat-card stat-clickable ' + (dups === 0 ? 'check-pass' : 'check-fail');
        val.textContent = dups === 0 ? 'CLEAN' : dups + ' found';
      } catch { card.className = 'stat-card stat-clickable check-fail'; val.textContent = 'ERROR'; }
    });
  }

  async function runAuditCheck(card, valEl, rpcFn, checkFn) {
    card.className = 'stat-card stat-clickable check-running';
    valEl.textContent = '...';
    try {
      var res = await rpcFn();
      var ok = checkFn(res);
      card.className = 'stat-card stat-clickable ' + (ok ? 'check-pass' : 'check-fail');
      valEl.textContent = ok ? 'PASS' : 'FAIL';
    } catch {
      card.className = 'stat-card stat-clickable check-fail';
      valEl.textContent = 'ERROR';
    }
  }

  // ══════════════════════════════════════════════════════
  //  NETWORK
  // ══════════════════════════════════════════════════════
  async function loadNetwork() {
    // Node info
    try {
      var health = await RPC.getHealth();
      var info = typeof health === 'object' ? health : {};
      var digest = {};
      try { digest = await RPC.getStateDigest(); } catch {}

      $('net-stats').innerHTML =
        statCard('Node', info.nodeId || '--', '', true) +
        statCard('Role', info.role || 'sequencer') +
        statCard('Latest Seq', digest.latestSequenceNumber || '--') +
        statCard('Latest Batch', digest.latestBatchNumber || '--');

      var infoHtml = '<div class="detail-grid">';
      Object.keys(info).forEach(function (k) {
        var v = info[k];
        if (typeof v === 'object') v = JSON.stringify(v);
        infoHtml += detailRow(k, String(v));
      });
      infoHtml += '</div>';
      $('net-info').innerHTML = infoHtml;
    } catch { $('net-info').innerHTML = '<div class="empty-state">Node info unavailable</div>'; }

    // Peers
    try {
      var peerInfo = await RPC.getPeerInfo();
      var peers = [];
      try { peers = await RPC.getPeerList(); } catch {}
      if (!Array.isArray(peers)) peers = peerInfo.peers || [];

      $('footer-peers').textContent = peers.length;

      if (!peers.length) {
        $('net-peers').innerHTML = '<div class="empty-state">No peers connected</div>';
      } else {
        var html = '';
        peers.forEach(function (p) {
          var nid = p.nodeId || p.id || p;
          var status = p.status || 'active';
          var avatarClass = status === 'stale' ? 'stale' : status === 'dead' ? 'dead' : '';
          html += '<div class="peer-item">' +
            '<div class="peer-avatar ' + avatarClass + '">' + String(nid).slice(0, 2).toUpperCase() + '</div>' +
            '<div class="peer-info">' +
            '<div class="peer-name">' + esc(nid) + '</div>' +
            '<div class="peer-sub">' + esc(p.url || p.address || '--') + '</div></div>' +
            '<span class="badge ' + (status === 'active' ? 'badge-success' : status === 'stale' ? 'badge-warning' : 'badge-error') + '">' +
            esc(status.toUpperCase()) + '</span></div>';
        });
        $('net-peers').innerHTML = html;
      }
    } catch { $('net-peers').innerHTML = '<div class="empty-state">Peer info unavailable</div>'; }

    // Leviathan status (if available)
    try {
      var lev = await RPC.getLeviathanStatus();
      if (lev && lev.nodeId) {
        $('net-leviathan-panel').classList.remove('hidden');
        $('net-leviathan').innerHTML =
          '<div class="detail-grid">' +
          detailRow('Node ID', lev.nodeId) +
          detailRow('Partition Count', lev.partitionCount || '--') +
          detailRow('Primary Partition', lev.primaryPartition !== undefined ? lev.primaryPartition : '--') +
          detailRow('Leader Partitions', (lev.activeLeaderPartitions || []).map(function (p) { return 'P' + p; }).join(', ') || '--') +
          detailRow('Total Proofs Accepted', lev.globalTotals ? lev.globalTotals.totalProofsAccepted : '--') +
          detailRow('Total Batches Built', lev.globalTotals ? lev.globalTotals.totalBatchesBuilt : '--') +
          detailRow('Pending Proofs', lev.globalTotals ? lev.globalTotals.pendingProofs : '--') +
          detailRow('L2-Only', String(lev.l2Only !== undefined ? lev.l2Only : true)) +
          detailRow('Running', String(lev.running !== undefined ? lev.running : '--')) +
          detailRow('Uptime', lev.uptimeMs ? fmtAgo(lev.uptimeMs) : '--') +
          '</div>';
      }
    } catch {
      // Not a leviathan node — that's fine
      $('net-leviathan-panel').classList.add('hidden');
    }
  }

  // ══════════════════════════════════════════════════════
  //  SSE + EVENT LOG
  // ══════════════════════════════════════════════════════
  function addEvent(ev) {
    eventLog.unshift(ev);
    if (eventLog.length > MAX_LOG) eventLog.pop();
    if (currentTab === 'overview') renderEventLog();
    updatePipelineFromEvent(ev);
  }

  function renderEventLog() {
    var el = $('ov-events');
    if (!eventLog.length) { el.innerHTML = '<div class="empty-state">Waiting for events...</div>'; return; }
    var html = '';
    eventLog.slice(0, 40).forEach(function (ev) {
      var type = ev.type || ev.event || 'unknown';
      var data = ev.data ? (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data).slice(0, 80)) : '';
      html += '<div class="event-item">' +
        '<span class="event-time">' + fmtTime(ev.timestamp || Date.now()) + '</span>' +
        '<span class="event-type">' + esc(type) + '</span>' +
        '<span class="event-data">' + esc(data) + '</span></div>';
    });
    el.innerHTML = html;
  }

  function updatePipelineFromEvent(ev) {
    var type = ev.type || ev.event || '';
    if (type.indexOf('proof:accepted') >= 0) {
      var pending = $('pipe-pending');
      pending.textContent = parseInt(pending.textContent || 0) + 1;
      flashStage('ss-pending');
    } else if (type.indexOf('batch:built') >= 0) {
      flashStage('ss-batching');
    } else if (type.indexOf('batch:settled') >= 0) {
      flashStage('ss-settled');
      var cnt = parseInt($('pipe-batching').textContent || 0);
      $('pipe-settled').textContent = parseInt($('pipe-settled').textContent || 0) + cnt;
      $('pipe-batching').textContent = '0';
    }
    // triggerRefresh() is called by the SSE handler in startSSE()
  }

  function flashStage(cls) {
    var stage = qs('.' + cls);
    if (!stage) return;
    stage.classList.add('active');
    setTimeout(function () { stage.classList.remove('active'); }, 2000);
  }

  var lastRefresh = 0;
  var REFRESH_THROTTLE = 1000; // min 1s between full refreshes

  function triggerRefresh() {
    var now = Date.now();
    if (now - lastRefresh < REFRESH_THROTTLE) return;
    lastRefresh = now;
    loadTab(currentTab);
  }

  function startSSE() {
    RPC.connectSSE(function (ev) {
      addEvent(ev);
      // Immediate refresh on any chain event
      var type = (ev.type || ev.event || '').toLowerCase();
      if (type.indexOf('proof') >= 0 || type.indexOf('batch') >= 0 ||
          type.indexOf('wallet') >= 0 || type.indexOf('message') >= 0 ||
          type.indexOf('settled') >= 0) {
        triggerRefresh();
      }
    });
    RPC.onConnectionChange(function (state) {
      setConn(state);
      if (state === 'connected') triggerRefresh();
    });
  }

  // ── Polling (fallback: refresh every 3s in case SSE is delayed) ──
  function startPolling() {
    pollTimer = setInterval(async function () {
      try {
        var status = await RPC.getStatus();
        statusCache = status;
        setConn('connected');
        // Update footer on every poll regardless of tab
        $('footer-height').textContent = status.blockHeight !== undefined ? status.blockHeight : '--';
        try { var pi = await RPC.getPeerInfo(); $('footer-peers').textContent = (pi.connectedPeers || pi.peers || []).length || 0; } catch {}
      } catch { setConn('disconnected'); return; }
      // Reload current tab data
      triggerRefresh();
    }, 3000);
  }

  // ── Refresh Buttons ───────────────────────────────────
  function setupRefreshButtons() {
    var map = {
      'batch-refresh': loadBatches,
      'receipt-refresh': loadReceipts,
      'audit-log-refresh': loadAudit,
      'audit-proof-refresh': loadAudit,
      'net-refresh': loadNetwork,
    };
    Object.keys(map).forEach(function (id) {
      var btn = $(id);
      if (btn) btn.addEventListener('click', map[id]);
    });

    $('receipt-search-btn').addEventListener('click', searchReceipts);
    $('receipt-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') searchReceipts();
    });

    $('wallet-lookup-btn').addEventListener('click', lookupWallet);
    $('wallet-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') lookupWallet();
    });
  }

  // ── Init ──────────────────────────────────────────────
  function init() {
    // Router
    qsa('.nav-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var tab = this.getAttribute('data-tab') || this.getAttribute('href').replace('#', '');
        navigate(tab);
        history.pushState(null, '', '#' + tab);
      });
    });

    var hash = location.hash.replace('#', '') || 'overview';
    navigate(hash);

    window.addEventListener('hashchange', function () {
      var h = location.hash.replace('#', '');
      if (h && h !== currentTab) navigate(h);
    });

    // Setup all interactions
    setupGlobalSearch();
    setupClaimSearch();
    setupMessageSearch();
    setupAuditChecks();
    setupRefreshButtons();

    // SSE + polling
    startSSE();
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
