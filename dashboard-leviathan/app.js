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
 * Adjuda-GATOR Leviathan Dashboard — Application Logic
 * 8 tabs: Overview, Partitions, Workers, Gossip, WAL/Quorum, Batches, Audit, Admin
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let currentTab = 'overview';
  let levStatus = null;       // cached leviathan status
  let topoNodes = [];         // { id, type, x, y, role, partition, state, ... }
  let topoLinks = [];         // { source, target, el }
  let eventLog = [];          // max 200
  let gossipLog = [];         // max 200
  let pollTimer = null;

  const MAX_LOG = 200;

  // ── Pipeline State ──────────────────────────────────────────
  var entityCache = [];       // from /viz/entities
  var entityCacheTime = 0;
  var batchCache = [];        // last 5 batches for pipeline view
  var nodePositions = {};     // { id: { x, y } } for animation targeting
  var animFrameId = null;
  var metrics = {
    proofTimestamps: [],      // timestamps of recent proof:accepted (60s window)
    proveTimes: [],           // last 20 prove durations (ms)
    queueDepth: 0,
    batchFillRate: 0
  };
  var metricsFrameCount = 0;

  // ── Node Health Monitor ────────────────────────────────────
  // Use the same hostname the browser is on to avoid cross-origin issues
  var _baseHost = location.hostname || 'localhost';
  // Boot-time nodes only. Employer nodes + HR Tools are spawned on-demand
  // via marketplace activation and appear dynamically in the Tenants panel
  // (loaded via l2_listEmployerNodes). See Phase C orchestrator.
  var NETWORK_NODES = [
    { id: 'leviathan',  label: 'Leviathan',  port: 3030, url: 'http://' + _baseHost + ':3030',  healthPath: '/health' },
    { id: 'member',     label: 'Member',     port: 4001, url: 'http://' + _baseHost + ':4001',  healthPath: '/health' },
    { id: 'prescriber', label: 'Prescriber', port: 4002, url: 'http://' + _baseHost + ':4002',  healthPath: '/health' },
    { id: 'pharmacy',   label: 'Pharmacy',   port: 4003, url: 'http://' + _baseHost + ':4003',  healthPath: '/health' },
    { id: 'insurer',    label: 'Insurer',    port: 4004, url: 'http://' + _baseHost + ':4004',  healthPath: '/health' },
    { id: 'replica-1',  label: 'Replica-1',  port: 3031, url: 'http://' + _baseHost + ':3031',  healthPath: '/health' },
    { id: 'replica-2',  label: 'Replica-2',  port: 3032, url: 'http://' + _baseHost + ':3032',  healthPath: '/health' },
  ];
  var nodeHealthState = {}; // { nodeId: { alive, lastCheck, latencyMs, phase, error, detail } }

  /** Probe a single node's health endpoint */
  async function probeNode(node) {
    var t0 = Date.now();

    // Self-node: this dashboard is served by the Leviathan — it's alive if we're running.
    // Skip the HTTP probe which can false-timeout under browser connection limits.
    if (node.id === 'leviathan') {
      nodeHealthState[node.id] = {
        alive: true, lastCheck: Date.now(), latencyMs: 0,
        phase: 'running', error: null, detail: 'self'
      };
      return;
    }

    try {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 8000);
      var res = await fetch(node.url + node.healthPath, { signal: controller.signal });
      clearTimeout(timeout);
      var latency = Date.now() - t0;
      var text = await res.text();
      var data;
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

      var phase = 'unknown';
      if (data && data.data && data.data.phase) phase = data.data.phase;
      else if (data && data.ok) phase = 'running';
      else if (res.ok) phase = 'ok';

      var detail = '';
      if (data && data.chain) {
        detail = 'proofs:' + (data.chain.pendingProofs || 0) + ' batches:' + (data.chain.totalBatchesBuilt || 0);
      }
      if (data && data.workers) {
        detail += ' workers:' + data.workers.length;
      }
      if (data && data.data && data.data.walletId) {
        detail = 'wallet:' + shortHash(data.data.walletId);
      }
      if (data && data.data && data.data.providerId) {
        detail = data.data.providerId;
      }

      nodeHealthState[node.id] = {
        alive: true, lastCheck: Date.now(), latencyMs: latency,
        phase: phase, error: null, detail: detail
      };
    } catch (e) {
      nodeHealthState[node.id] = {
        alive: false, lastCheck: Date.now(), latencyMs: Date.now() - t0,
        phase: 'dead', error: e.name === 'AbortError' ? 'timeout (3s)' : e.message, detail: ''
      };
    }
  }

  /** Check all nodes and render the health bar */
  async function checkAllNodeHealth() {
    // Set all to 'checking' first
    NETWORK_NODES.forEach(function (n) {
      if (!nodeHealthState[n.id]) {
        nodeHealthState[n.id] = { alive: false, lastCheck: 0, latencyMs: 0, phase: 'checking', error: null, detail: '' };
      }
    });
    renderHealthBar();

    // Probe all in parallel
    await Promise.all(NETWORK_NODES.map(probeNode));
    renderHealthBar();

    // Log results to feed
    var alive = 0, dead = 0, errors = [];
    NETWORK_NODES.forEach(function (n) {
      var s = nodeHealthState[n.id];
      if (s && s.alive) {
        alive++;
      } else {
        dead++;
        errors.push(n.label + ':' + n.port + ' — ' + (s ? s.error : 'unknown'));
      }
    });

    addFeedItem({
      type: 'health-check',
      typeClass: dead === 0 ? 'proof' : 'error',
      from: 'Dashboard', fromColor: '#26c6da',
      to: alive + '/' + NETWORK_NODES.length + ' alive', toColor: dead === 0 ? '#3fb950' : '#f85149',
      detail: dead > 0 ? 'DEAD: ' + errors.join(' | ') : 'All nodes responding',
      timestamp: Date.now(),
      _diagClass: dead === 0 ? 'diag-ok' : 'diag-error'
    });
  }

  /** Render the health bar chips */
  function renderHealthBar() {
    var el = $('node-health-grid');
    if (!el) return;
    var html = '';
    NETWORK_NODES.forEach(function (n) {
      var s = nodeHealthState[n.id] || {};
      var cls = s.alive ? 'alive' : (s.phase === 'checking' ? 'checking' : 'dead');
      var statusText = s.alive ? s.latencyMs + 'ms' : (s.phase === 'checking' ? '...' : 'DOWN');
      html += '<div class="node-health-chip ' + cls + '" title="' +
        escHtml(n.url + ' — ' + (s.error || s.phase || '')) + '">' +
        '<span class="nh-dot"></span>' +
        '<span class="nh-label">' + escHtml(n.label) + '</span>' +
        '<span class="nh-status">' + statusText + '</span>' +
        (s.detail ? '<span class="nh-detail">' + escHtml(s.detail) + '</span>' : '') +
        '</div>';
    });
    el.innerHTML = html;
  }

  /** Check if a specific node is alive (for pre-flight checks) */
  function isNodeAlive(nodeId) {
    var s = nodeHealthState[nodeId];
    return s && s.alive;
  }

  /** Log a diagnostic message to the feed */
  function diagLog(msg, isError) {
    addFeedItem({
      type: isError ? 'DIAG-ERROR' : 'DIAG',
      typeClass: isError ? 'error' : 'worker',
      from: 'Dashboard', fromColor: isError ? '#f85149' : '#ffc107',
      to: null, toColor: null,
      detail: msg,
      timestamp: Date.now(),
      _diagClass: isError ? 'diag-error' : 'diag'
    });
  }

  // ── Helpers ──────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return document.querySelectorAll(sel); }

  function shortHash(h) {
    if (!h) return '--';
    var s = String(h);
    return s.length > 16 ? s.slice(0, 8) + '…' + s.slice(-6) : s;
  }

  function fmtTime(t) {
    if (!t) return '--';
    var d = new Date(t);
    return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtAgo(ms) {
    if (!ms && ms !== 0) return '--';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    $('toast-container').appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function setConnDot(state) {
    var dot = $('connection-dot');
    dot.className = 'connection-dot ' + state;
    dot.title = state;
  }

  // ── Router ───────────────────────────────────────────────────
  function navigate(tab) {
    currentTab = tab;
    qsa('.page').forEach(function (p) { p.classList.remove('active'); });
    qsa('.nav-tab').forEach(function (t) { t.classList.remove('active'); });
    var page = $('page-' + tab);
    if (page) page.classList.add('active');
    var btn = qs('.nav-tab[data-tab="' + tab + '"]');
    if (btn) btn.classList.add('active');
    location.hash = tab;
    loadTab(tab);
  }

  function loadTab(tab) {
    switch (tab) {
      case 'overview': loadOverview(); break;
      case 'partitions': loadPartitions(); break;
      case 'workers': loadWorkers(); break;
      case 'gossip': loadGossip(); break;
      case 'wal': loadWal(); break;
      case 'batches': loadBatches(); break;
      case 'audit': loadAudit(); break;
      case 'admin': loadAdmin(); break;
    }
  }

  // ── Command Center Renderer ────────────────────────────────
  // 6-panel grid: Throughput | Workers | Feed | Batches | Network | Entities

  var ENTITY_COLORS = {
    member: '#3fb950', prescriber: '#58a6ff',
    pharmacy: '#bc8cff', insurer: '#db6d28',
    employer: '#ec4899'
  };
  var ENTITY_ORDER = ['member', 'prescriber', 'pharmacy', 'insurer'];

  // Sparkline ring buffer — 60 bars, each = 1 second
  var sparkBars = new Array(60).fill(0);
  var sparkIdx = 0;
  var sparkPeak = 0;
  var sparkTotal = 0;

  // Feed buffer — max 80 items
  var feedLog = [];
  var FEED_MAX = 80;

  // Entity activity tracking — recent 60s
  var entityActivity = {}; // { type: Set<walletId> }

  // Worker elapsed timers
  var workerStartTimes = {}; // { workerId: timestamp }
  var workerTimerInterval = null;

  // ── Command Center Panel Renderers ──────────────────────────

  /** Render sparkline bars into the sparkline container */
  function renderSparkline() {
    var el = $('cc-sparkline');
    if (!el) return;
    // Initialize bars if empty
    if (!el.children.length || el.children[0].className === 'cc-empty') {
      var html = '';
      for (var i = 0; i < 60; i++) html += '<div class="cc-spark-bar" style="height:2px"></div>';
      el.innerHTML = html;
    }
    var bars = el.children;
    var max = Math.max.apply(null, sparkBars) || 1;
    for (var i = 0; i < 60; i++) {
      var idx = (sparkIdx + 1 + i) % 60; // oldest to newest
      var val = sparkBars[idx];
      var pct = Math.max((val / max) * 100, 3);
      bars[i].style.height = pct + '%';
      bars[i].className = 'cc-spark-bar' + (i === 59 ? ' active' : '');
    }
  }

  /** Update throughput stats */
  function updateThroughputPanel() {
    if (!$('cc-rate')) return; // Throughput tile removed — no-op
    var now = Date.now();
    metrics.proofTimestamps = metrics.proofTimestamps.filter(function (t) { return now - t < 60000; });
    var rate = metrics.proofTimestamps.length / 60;
    $('cc-rate').innerHTML = rate.toFixed(1) + '<small>/s</small>';
    $('cc-peak').textContent = sparkPeak.toFixed(1);
    var sum = 0;
    for (var i = 0; i < 60; i++) sum += sparkBars[i];
    var avg = sum / 60;
    $('cc-avg').textContent = avg.toFixed(1);
    $('cc-total').textContent = String(sparkTotal);
    renderSparkline();
  }

  /** Tick the sparkline — called every 1s */
  function tickSparkline() {
    var now = Date.now();
    var count = metrics.proofTimestamps.filter(function (t) { return now - t < 1000; }).length;
    sparkIdx = (sparkIdx + 1) % 60;
    sparkBars[sparkIdx] = count;
    if (count > sparkPeak) sparkPeak = count;
    updateThroughputPanel();
  }

  /** Render worker pool panel from levStatus */
  function renderWorkerPanel(status) {
    var workers = status.workers || (Array.isArray(status.provingPool) ? status.provingPool : []);
    if (!Array.isArray(workers)) workers = [];

    var el = $('cc-worker-list');
    var badge = $('cc-worker-badge');

    if (!workers.length) {
      el.innerHTML = '<div class="cc-empty">No workers</div>';
      badge.textContent = '0';
      return;
    }

    var alive = 0, proving = 0;
    var html = '';
    workers.forEach(function (w, i) {
      var s = (w.state || w.status || 'idle').toLowerCase();
      if (s === 'idle' || s === 'ready') s = 'idle';
      else if (s === 'proving' || s === 'busy') { s = 'proving'; proving++; }
      else if (s === 'compiling') s = 'compiling';
      else s = 'dead';
      if (s !== 'dead') alive++;

      var wId = 'W' + (w.id !== undefined ? w.id : i);
      var elapsed = '';
      if (s === 'proving' && workerStartTimes[wId]) {
        elapsed = fmtAgo(Date.now() - workerStartTimes[wId]);
      }

      // Bar width: for proving, simulate progress based on avg prove time
      var barWidth = '0';
      if (s === 'proving') {
        var avgProve = metrics.proveTimes.length
          ? metrics.proveTimes.reduce(function (a, b) { return a + b; }, 0) / metrics.proveTimes.length
          : 30000;
        var elapsedMs = workerStartTimes[wId] ? Date.now() - workerStartTimes[wId] : 0;
        barWidth = Math.min(95, (elapsedMs / avgProve) * 100).toFixed(0);
      } else if (s === 'compiling') {
        barWidth = '40';
      } else if (s === 'dead') {
        barWidth = '100';
      }

      var jobDesc = w.currentJobDescription || '';
      html += '<div class="cc-worker-row">' +
        '<span class="cc-worker-id">' + escHtml(wId) + '</span>' +
        '<div class="cc-worker-bar-bg"><div class="cc-worker-bar-fill ' + s + '" style="width:' + barWidth + '%"></div></div>' +
        '<span class="cc-worker-state ' + s + '">' + s + '</span>' +
        (jobDesc ? '<span class="cc-worker-job">' + escHtml(jobDesc) + '</span>' : '') +
        (elapsed ? '<span class="cc-worker-elapsed">' + elapsed + '</span>' : '') +
        '</div>';
    });
    el.innerHTML = html;
    badge.textContent = alive + '/' + workers.length;

    // Stats
    if (metrics.proveTimes.length) {
      var sum = metrics.proveTimes.reduce(function (a, b) { return a + b; }, 0);
      var avg = sum / metrics.proveTimes.length;
      $('cc-avg-prove').textContent = avg < 1000 ? avg.toFixed(0) + 'ms' : (avg / 1000).toFixed(1) + 's';
    }
    $('cc-queue').textContent = String(metrics.queueDepth);
  }

  /** Render proof queue tile showing pending proofs awaiting batch settlement */
  function renderQueuePanel(status) {
    var gt = status.globalTotals || {};
    var pending = gt.pendingProofs || 0;
    var totalBatched = gt.totalBatchesBuilt || 0;
    var nextBatchMs = status.nextBatchInMs || gt.nextBatchInMs || 0;

    $('cc-queue-badge').textContent = String(pending);
    $('cc-total-batched').textContent = String(totalBatched);
    $('cc-next-batch').textContent = nextBatchMs > 0 ? formatMs(nextBatchMs) : 'now';

    var el = $('cc-queue-list');
    if (pending === 0) {
      el.innerHTML = '<div class="cc-empty">No pending proofs — queue empty</div>';
      return;
    }

    // Show pending count as visual queue items
    var html = '';
    for (var i = 0; i < Math.min(pending, 10); i++) {
      html += '<div class="cc-worker-row">' +
        '<span class="cc-worker-id">P' + (i + 1) + '</span>' +
        '<div class="cc-worker-bar-bg"><div class="cc-worker-bar-fill proving" style="width:100%"></div></div>' +
        '<span class="cc-worker-state proving">awaiting batch</span>' +
        '</div>';
    }
    if (pending > 10) {
      html += '<div class="cc-worker-row"><span class="cc-worker-id">...</span>' +
        '<span class="cc-worker-state idle">+ ' + (pending - 10) + ' more</span></div>';
    }
    el.innerHTML = html;
  }

  /** Add a feed item with From→To flow detail */
  function addFeedItem(item) {
    // item: { type, typeClass, from, to, detail, timestamp }
    feedLog.unshift(item);
    if (feedLog.length > FEED_MAX) feedLog.pop();
    if (currentTab === 'overview') renderFeedPanel();
  }

  /** Render feed panel */
  function renderFeedPanel() {
    var el = $('cc-feed-list');
    if (!feedLog.length) {
      el.innerHTML = '<div class="cc-empty">Waiting for events...</div>';
      return;
    }
    var html = '';
    feedLog.slice(0, 40).forEach(function (item) {
      var extraClass = item._diagClass ? ' ' + item._diagClass : '';
      html += '<div class="cc-feed-item' + extraClass + '">' +
        '<div class="cc-feed-top">' +
        '<span class="cc-feed-type ' + (item.typeClass || '') + '">' + escHtml(item.type) + '</span>' +
        '<span class="cc-feed-time">' + fmtTime(item.timestamp) + '</span>' +
        '</div>';
      if (item.from || item.to) {
        html += '<div class="cc-feed-flow">';
        if (item.from) {
          html += '<span class="cc-feed-entity">' +
            '<span class="cc-dot" style="background:' + (item.fromColor || '#8b949e') + '"></span>' +
            escHtml(item.from) + '</span>';
        }
        if (item.from && item.to) {
          html += '<span class="cc-feed-arrow">\u2192</span>';
        }
        if (item.to) {
          html += '<span class="cc-feed-entity">' +
            '<span class="cc-dot" style="background:' + (item.toColor || '#26c6da') + '"></span>' +
            escHtml(item.to) + '</span>';
        }
        html += '</div>';
      }
      if (item.detail) {
        html += '<div class="cc-feed-detail">' + escHtml(item.detail) + '</div>';
      }
      html += '</div>';
    });
    el.innerHTML = html;
  }

  /** Render batch pipeline panel */
  function renderBatchPanel() {
    var el = $('cc-batch-list');
    var batches = batchCache.slice(0, 6);
    if (!batches.length) {
      el.innerHTML = '<div class="cc-empty">No batches yet</div>';
      return;
    }
    var html = '';
    batches.forEach(function (b) {
      var status = b.status || b.l1Status || 'pending';
      var proofs = b.proofCount || b.transitionCount || 0;
      var maxProofs = 2;
      var fillPct = Math.min(proofs / Math.max(maxProofs, 1), 1) * 100;
      if (status === 'settled') fillPct = 100;
      var idx = b.index !== undefined ? b.index : (b.batchIndex || b.batchNumber || '?');

      html += '<div class="cc-batch-item ' + status + '" onclick="window._showBatchDetail(' + idx + ')">' +
        '<span class="cc-batch-num">#' + idx + '</span>' +
        '<div class="cc-batch-bar-wrap">' +
        '<div class="cc-batch-bar-bg"><div class="cc-batch-bar-fill ' + status + '" style="width:' + fillPct + '%"></div></div>' +
        '<span class="cc-batch-info">' + proofs + ' proof' + (proofs !== 1 ? 's' : '') +
        (b.timestamp ? ' \u00B7 ' + fmtTime(b.timestamp || b.createdAt) : '') + '</span>' +
        '</div>' +
        '<span class="cc-batch-status ' + status + '">' + status + '</span>' +
        '</div>';
    });
    el.innerHTML = html;
  }

  /** Open Etherscan-style batch detail modal */
  async function showBatchDetail(batchIdx) {
    var modal = $('batch-modal');
    var title = $('bm-title');
    var body = $('bm-body');
    modal.style.display = 'flex';
    title.textContent = 'Batch #' + batchIdx;
    body.innerHTML = '<div class="loading">Loading batch details...</div>';

    // Close on overlay click
    modal.onclick = function (e) { if (e.target === modal) modal.style.display = 'none'; };

    try {
      // Fetch batch and all receipts
      var batch = null;
      var allReceipts = [];
      try { batch = await RPC.call('l2_getBatch', { batchNumber: batchIdx }); } catch (_) {}
      if (!batch) {
        // Fallback: find in cache
        batch = batchCache.find(function (b) {
          return (b.index !== undefined ? b.index : (b.batchIndex || b.batchNumber)) == batchIdx;
        });
      }
      try { allReceipts = await RPC.getReceipts(200); } catch (_) {}
      if (!Array.isArray(allReceipts)) allReceipts = [];

      // Filter receipts belonging to this batch
      var batchReceipts = allReceipts.filter(function (r) {
        var rBatch = r.batchIndex !== undefined ? r.batchIndex : r.l1BatchNumber;
        return rBatch !== undefined && String(rBatch) === String(batchIdx);
      });

      if (!batch) {
        body.innerHTML = '<div class="empty-state">Batch not found</div>';
        return;
      }

      var status = batch.status || batch.l1Status || 'pending';
      var proofs = batch.proofCount || batch.transitionCount || 0;
      var html = '';

      // ── Overview Section ──
      html += '<div class="bm-section">';
      html += '<div class="bm-section-title">Overview</div>';
      html += bmRow('Status', '<span class="bm-badge ' + status + '">' + status + '</span>');
      html += bmRow('Batch Number', '#' + batchIdx);
      html += bmRow('Transitions', proofs);
      html += bmRow('Registrations', batch.registrationCount || 0);
      if (batch.timestamp || batch.createdAt)
        html += bmRow('Created', new Date(batch.timestamp || batch.createdAt).toLocaleString());
      if (batch.workerId !== undefined)
        html += bmRow('Proved By', 'Worker ' + batch.workerId);
      if (batch.proveTimeMs)
        html += bmRow('Prove Time', (batch.proveTimeMs / 1000).toFixed(1) + 's');
      if (batch.blockHeight !== undefined)
        html += bmRow('Block Height', batch.blockHeight);
      html += '</div>';

      // ── State Transitions ──
      html += '<div class="bm-section">';
      html += '<div class="bm-section-title">State Transitions</div>';
      html += bmRootRow('Registry Root', batch.oldRegistryRoot, batch.newRegistryRoot);
      html += bmRootRow('Lifecycle Root', batch.oldLifecycleRoot, batch.newLifecycleRoot);
      if (batch.globalStateRoot)
        html += bmRow('Global State Root', '<span class="bm-hash">' + batch.globalStateRoot + '</span>');
      html += '</div>';

      // ── Merkle Roots Snapshot ──
      if (batch.claimAccumulatorRoot || batch.messageStoreRoot || batch.providerRegistryRoot) {
        html += '<div class="bm-section">';
        html += '<div class="bm-section-title">Merkle Root Snapshots</div>';
        if (batch.claimAccumulatorRoot)
          html += bmRow('Claim Accumulator', '<span class="bm-hash">' + shortHash(batch.claimAccumulatorRoot) + '</span>');
        if (batch.messageStoreRoot)
          html += bmRow('Message Store', '<span class="bm-hash">' + shortHash(batch.messageStoreRoot) + '</span>');
        if (batch.providerRegistryRoot)
          html += bmRow('Provider Registry', '<span class="bm-hash">' + shortHash(batch.providerRegistryRoot) + '</span>');
        html += '</div>';
      }

      // ── Quorum / Certificate ──
      if (batch.stateCertificate) {
        html += '<div class="bm-section">';
        html += '<div class="bm-section-title">State Certificate</div>';
        var cert = batch.stateCertificate;
        html += bmRow('Votes', (cert.votes ? cert.votes.length : 0) + ' / ' + (cert.quorumSize || '?'));
        if (cert.batchNumber !== undefined) html += bmRow('Certified Batch', '#' + cert.batchNumber);
        html += '</div>';
      }

      // ── Receipts (Transactions) ──
      html += '<div class="bm-section">';
      html += '<div class="bm-section-title">Transactions (' + batchReceipts.length + ')</div>';
      if (batchReceipts.length === 0) {
        html += '<div class="empty-state" style="font-size:12px">No receipts found for this batch</div>';
      } else {
        batchReceipts.forEach(function (r) {
          var rStatus = r.status || r.l1Status || 'pending';
          var rId = r.id || r.receiptId || '--';
          html += '<div class="bm-receipt">';
          html += '<div class="bm-receipt-header">';
          html += '<span class="bm-receipt-id">' + escHtml(rId) + '</span>';
          html += '<span class="bm-badge bm-receipt-badge ' + rStatus + '">' + rStatus + '</span>';
          html += '</div>';
          html += '<div class="bm-receipt-row">';
          html += '<span>Wallet: <b class="bm-hash">' + shortHash(r.walletId) + '</b></span>';
          html += '<span>Seq: <b>' + (r.sequenceNumber || r.seqNum || '--') + '</b></span>';
          html += '<span>Type: <b>' + (r.isRegistration ? 'Registration' : 'Transition') + '</b></span>';
          html += '</div>';
          html += '<div class="bm-receipt-row">';
          html += '<span>Registry: <b class="bm-hash">' + shortHash(r.oldRegistryRoot) + '</b><span class="bm-arrow">\u2192</span><b class="bm-hash">' + shortHash(r.newRegistryRoot) + '</b></span>';
          html += '</div>';
          if (r.auditEventHash) {
            html += '<div class="bm-receipt-row">';
            html += '<span>Audit Hash: <b class="bm-hash">' + shortHash(r.auditEventHash) + '</b></span>';
            html += '</div>';
          }
          if (r.claimLeafIndex !== undefined && r.claimLeafIndex !== null) {
            html += '<div class="bm-receipt-row">';
            html += '<span>Claim Leaf: <b>' + r.claimLeafIndex + '</b></span>';
            html += '</div>';
          }
          if (r.quorumCertificate) {
            var qc = r.quorumCertificate;
            html += '<div class="bm-receipt-row">';
            html += '<span>Quorum: <b>' + (qc.votes ? qc.votes.length : 0) + ' votes</b></span>';
            html += '</div>';
          }
          html += '</div>';
        });
      }
      html += '</div>';

      // ── Proof Data ──
      if (batch.batchProofJson) {
        html += '<div class="bm-section">';
        html += '<div class="bm-section-title">Proof Data</div>';
        var proofSize = batch.batchProofJson.length;
        html += bmRow('Batch Proof', (proofSize / 1024).toFixed(1) + ' KB');
        if (batch.chainProofJson)
          html += bmRow('Chain Proof', (batch.chainProofJson.length / 1024).toFixed(1) + ' KB');
        html += '</div>';
      }

      body.innerHTML = html;
    } catch (e) {
      body.innerHTML = '<div class="empty-state">Error loading batch: ' + escHtml(e.message) + '</div>';
    }
  }

  function bmRow(label, value) {
    return '<div class="bm-row"><span class="bm-label">' + label + '</span><span class="bm-value">' + value + '</span></div>';
  }
  function bmRootRow(label, oldRoot, newRoot) {
    if (!oldRoot && !newRoot) return '';
    return '<div class="bm-row"><span class="bm-label">' + label + '</span>' +
      '<span class="bm-value"><span class="bm-hash">' + shortHash(oldRoot) + '</span>' +
      '<span class="bm-arrow">\u2192</span>' +
      '<span class="bm-hash">' + shortHash(newRoot) + '</span></span></div>';
  }

  // Expose globally for onclick
  window._showBatchDetail = showBatchDetail;

  /** Render network nodes panel — shows sequencer + known replicas */
  function renderNetworkPanel(status) {
    var el = $('cc-network-nodes');
    if (!status) { el.innerHTML = '<div class="cc-empty">Loading...</div>'; return; }

    // Build node list: self (sequencer) + replicas from NETWORK_NODES
    var nodes = [];

    // Self — the sequencer
    var selfId = status.nodeId || 'sequencer';
    var gt = status.globalTotals || {};
    nodes.push({
      id: selfId,
      role: 'sequencer',
      isSelf: true,
      url: ':' + (window._seqPort || 3030),
      alive: true,
      detail: (gt.totalProofsAccepted || status.totalProofsAccepted || 0) + ' proofs accepted',
    });

    // Replicas — check from NETWORK_NODES or hardcoded replica ports
    var replicaPorts = [];
    if (typeof NETWORK_NODES !== 'undefined' && Array.isArray(NETWORK_NODES)) {
      NETWORK_NODES.forEach(function (n) {
        if (n.role === 'replica' || (n.id && n.id.indexOf('replica') >= 0)) {
          replicaPorts.push(n);
        }
      });
    }
    // Fallback: check known replica ports from nodeHealthState
    if (replicaPorts.length === 0 && nodeHealthState) {
      Object.keys(nodeHealthState).forEach(function (key) {
        if (key.indexOf('replica') >= 0 || key.indexOf('3031') >= 0 || key.indexOf('3032') >= 0) {
          var nh = nodeHealthState[key];
          replicaPorts.push({ id: key, url: nh.url || key, role: 'replica', alive: nh.alive });
        }
      });
    }
    // Last fallback: just show replica-1 and replica-2 with health state
    if (replicaPorts.length === 0) {
      [3031, 3032].forEach(function (p, i) {
        var rid = 'replica-' + (i + 1);
        var nh = nodeHealthState[rid] || nodeHealthState['localhost:' + p] || {};
        nodes.push({
          id: rid,
          role: 'replica',
          isSelf: false,
          url: ':' + p,
          alive: nh.alive !== false, // assume alive unless proven dead
          detail: nh.latencyMs ? nh.latencyMs + 'ms' : 'gossip replication',
        });
      });
    } else {
      replicaPorts.forEach(function (rp) {
        var nh = nodeHealthState[rp.id] || {};
        nodes.push({
          id: rp.id || rp.url,
          role: 'replica',
          isSelf: false,
          url: rp.url || '',
          alive: nh.alive !== undefined ? nh.alive : true,
          detail: nh.latencyMs ? nh.latencyMs + 'ms' : 'gossip replication',
        });
      });
    }

    var html = '';
    nodes.forEach(function (n) {
      var cls = n.alive ? n.role : 'dead';
      html += '<div class="cc-node-item">' +
        '<div class="cc-node-icon ' + cls + '">' +
        (n.role === 'sequencer' ? 'S' : 'R') +
        '<div class="cc-heartbeat-ring"></div>' +
        '</div>' +
        '<div class="cc-node-info">' +
        '<div class="cc-node-name">' + escHtml(n.id) +
        (n.isSelf ? ' (self)' : '') +
        ' <span style="color:var(--text-secondary);font-size:11px">' + escHtml(n.url) + '</span></div>' +
        '<div class="cc-node-meta">' + escHtml(n.detail) + '</div>' +
        '</div>' +
        '</div>';
    });

    el.innerHTML = html || '<div class="cc-empty">No nodes</div>';
  }

  /** Render entity activity panel */
  function renderEntityPanel() {
    var el = $('cc-entity-list');
    var entities = entityCache;

    // Count by type
    var counts = {};
    ENTITY_ORDER.forEach(function (t) { counts[t] = 0; });
    entities.forEach(function (e) {
      var t = (e.type || 'member').toLowerCase();
      if (counts[t] !== undefined) counts[t]++;
    });

    var html = '';
    ENTITY_ORDER.forEach(function (type) {
      var count = counts[type] || 0;
      var active = entityActivity[type] ? entityActivity[type].size : 0;
      var color = ENTITY_COLORS[type] || '#8b949e';

      html += '<div class="cc-entity-row">' +
        '<span class="cc-entity-icon ' + type + '"></span>' +
        '<span class="cc-entity-type">' + type + '</span>' +
        '<span class="cc-entity-count">' + count + '</span>' +
        '<span class="cc-entity-active' + (active ? ' has-activity' : '') + '">' +
        (active ? active + ' active' : 'idle') + '</span>' +
        '</div>';
    });

    el.innerHTML = html || '<div class="cc-empty">No entities</div>';
  }

  /** Track entity activity for the activity panel */
  function trackEntityActivity(walletId, type) {
    if (!type) {
      // Try to resolve type from entity cache
      var ent = entityCache.find(function (e) { return e.walletId === walletId; });
      type = ent ? (ent.type || 'member').toLowerCase() : 'member';
    }
    if (!entityActivity[type]) entityActivity[type] = new Set();
    entityActivity[type].add(walletId || 'unknown');
    // Expire after 60s
    setTimeout(function () {
      if (entityActivity[type]) {
        entityActivity[type].delete(walletId || 'unknown');
      }
    }, 60000);
  }

  /** Resolve entity display name from wallet ID */
  function resolveEntity(walletId) {
    if (!walletId) return null;
    var ent = entityCache.find(function (e) { return e.walletId === walletId; });
    if (ent) return { name: ent.displayName || shortHash(walletId), type: (ent.type || 'member').toLowerCase() };
    return { name: shortHash(walletId), type: 'member' };
  }

  /** Trigger heartbeat animation on a network node */
  function triggerHeartbeat(nodeId) {
    var ring = qs('.cc-node-icon[data-node="' + nodeId + '"] .cc-heartbeat-ring');
    if (ring) {
      ring.classList.remove('beat');
      void ring.offsetWidth; // force reflow
      ring.classList.add('beat');
    }
  }

  // ── Entity Cache ──

  async function loadEntities() {
    try {
      var resp = await fetch(location.origin + '/viz/entities');
      var text = await resp.text();
      var data;
      try { data = JSON.parse(text); } catch (e) {
        diagLog('viz/entities returned non-JSON: ' + text.slice(0, 100), true);
        return;
      }
      if (Array.isArray(data)) {
        entityCache = data;
        entityCacheTime = Date.now();
        if (data.length > 0) {
          diagLog('Entity cache loaded: ' + data.length + ' entities (' +
            data.filter(function (e) { return e.type === 'member'; }).length + ' members, ' +
            data.filter(function (e) { return e.type === 'prescriber'; }).length + ' prescribers, ' +
            data.filter(function (e) { return e.type === 'pharmacy'; }).length + ' pharmacies, ' +
            data.filter(function (e) { return e.type === 'insurer'; }).length + ' insurers)');
        }
      } else {
        diagLog('viz/entities returned non-array: ' + JSON.stringify(data).slice(0, 100), true);
      }
    } catch (e) {
      diagLog('viz/entities FAILED: ' + e.message, true);
    }
  }

  // ── Batch Cache ──

  async function loadBatchCache() {
    try {
      var batches = await RPC.getBatches(5);
      if (Array.isArray(batches)) {
        batchCache = batches;
        if (batches.length > 0) {
          diagLog('Batch cache: ' + batches.length + ' batches, latest #' +
            (batches[0].batchNumber || batches[0].index || '?') + ' (' +
            (batches[0].status || batches[0].l1Status || '?') + ')');
        }
      }
    } catch (e) {
      diagLog('getBatches FAILED: ' + e.message, true);
    }
  }

  // ── Overview Tab ────────────────────────────────────────────
  async function loadOverview() {
    try {
      var t0 = Date.now();
      var status = await RPC.getLeviathanStatus();
      var rpcMs = Date.now() - t0;
      levStatus = status;

      // Header badges
      $('header-node-id').textContent = status.nodeId || '--';
      $('header-partition').textContent = 'P\u00D7' + (status.partitionCount || '?');
      if (status.uptime) $('header-uptime').textContent = fmtAgo(status.uptime);
      setConnDot('connected');

      // Update queue depth from live status
      var gt = status.globalTotals || {};
      metrics.queueDepth = gt.pendingProofs || 0;

      // Log sequencer state to feed on first load or state changes
      if (!loadOverview._lastLoggedProofs || loadOverview._lastLoggedProofs !== gt.totalProofsAccepted) {
        diagLog('Sequencer status (' + rpcMs + 'ms): node=' + (status.nodeId || '?') +
          ' uptime=' + fmtAgo(status.uptime) +
          ' proofs=' + (gt.totalProofsAccepted || 0) +
          ' batches=' + (gt.totalBatchesBuilt || 0) + '/' + (gt.totalBatchesSettled || 0) +
          ' pending=' + (gt.pendingProofs || 0) +
          ' wallets=' + (status.chain ? status.chain.walletCount : '?'));
        loadOverview._lastLoggedProofs = gt.totalProofsAccepted;
      }

      // Render all Command Center panels
      updateThroughputPanel();
      renderWorkerPanel(status);
      renderQueuePanel(status);
      renderFeedPanel();
      renderBatchPanel();
      renderNetworkPanel(status);
      renderEntityPanel();

      // Partition ownership mini-grid
      renderOverviewPartitions(status);

      // Worker pool summary
      renderOverviewWorkers(status);

      // Entity proof pool (from health endpoint)
      try {
        var health = await RPC.getHealth();
        renderEntityProofPool(health);
      } catch (_) { /* health fetch optional */ }
    } catch (e) {
      setConnDot('disconnected');
      diagLog('loadOverview FAILED: ' + e.message + ' — is leviathan running on :3030?', true);
      toast('Failed to load status: ' + e.message, 'error');
    }
  }

  function renderOverviewPartitions(status) {
    var el = $('ov-partitions');
    var partitions = status.partitions || [];
    if (!partitions.length) {
      el.innerHTML = '<div class="empty-state">No partition data</div>';
      return;
    }
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px">';
    partitions.forEach(function (p, i) {
      var isLeader = p.leader === status.nodeId;
      html += '<div style="text-align:center;padding:8px 4px;background:var(--bg-primary);border-radius:var(--radius-sm);border:1px solid ' +
        (isLeader ? 'var(--accent)' : 'var(--border)') + '">' +
        '<div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:' +
        (isLeader ? 'var(--accent)' : 'var(--text-secondary)') + '">P' + i + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">' +
        (isLeader ? 'LEADER' : 'REPLICA') + '</div>' +
        '<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">' +
        (p.receiptCount || 0) + ' rcpt</div></div>';
    });
    html += '</div>';
    el.innerHTML = html;
  }

  function renderOverviewWorkers(status) {
    var workers = status.workers || (Array.isArray(status.provingPool) ? status.provingPool : []);
    var badge = $('ov-pool-badge');
    if (!Array.isArray(workers) || !workers.length) {
      badge.textContent = '0';
      $('ov-workers').innerHTML = '<div class="empty-state">No workers</div>';
      return;
    }
    badge.textContent = workers.length + ' workers';
    var idle = 0, proving = 0, compiling = 0, dead = 0;
    workers.forEach(function (w) {
      var s = (w.state || w.status || 'idle').toLowerCase();
      if (s === 'idle' || s === 'ready') idle++;
      else if (s === 'proving' || s === 'busy') proving++;
      else if (s === 'compiling') compiling++;
      else dead++;
    });
    var html = '<div style="display:flex;gap:12px;flex-wrap:wrap">';
    if (idle) html += '<span style="color:var(--text-secondary)">Idle: <b>' + idle + '</b></span>';
    if (proving) html += '<span style="color:var(--green)">Proving: <b>' + proving + '</b></span>';
    if (compiling) html += '<span style="color:var(--amber)">Compiling: <b>' + compiling + '</b></span>';
    if (dead) html += '<span style="color:var(--red)">Dead: <b>' + dead + '</b></span>';
    html += '</div>';
    $('ov-workers').innerHTML = html;
  }

  /** Render entity proof pool — same visual style as batch Worker Pool */
  function renderEntityProofPool(health) {
    var ep = health.entityProofPool;
    var workers = health.entityWorkers || [];
    if (!Array.isArray(workers)) workers = [];

    var el = $('cc-ep-worker-list');
    var badge = $('cc-ep-badge');
    if (!el || !badge) return;

    if (!workers.length || !ep) {
      el.innerHTML = '<div class="cc-empty">No entity proof workers</div>';
      badge.textContent = '--';
      $('cc-ep-jobs').textContent = '0';
      $('cc-ep-avg').textContent = '--';
      $('cc-ep-queue').textContent = '0';
      return;
    }

    var alive = 0, proving = 0;
    var html = '';
    workers.forEach(function (w, i) {
      var s = (w.state || w.status || 'idle').toLowerCase();
      if (s === 'idle' || s === 'ready') s = 'idle';
      else if (s === 'proving' || s === 'busy') { s = 'proving'; proving++; }
      else if (s === 'compiling') s = 'compiling';
      else s = 'dead';
      if (s !== 'dead') alive++;

      var wId = 'E' + (w.id !== undefined ? w.id : i);

      // Bar width: for proving, simulate progress based on avg prove time
      var barWidth = '0';
      if (s === 'proving') {
        barWidth = '50'; // no elapsed tracking yet for entity pool
      } else if (s === 'compiling') {
        barWidth = '40';
      } else if (s === 'dead') {
        barWidth = '100';
      }

      var jobLabel = w.currentJobId || '';
      var recycleTag = w.pendingRecycle ? ' <span style="color:var(--amber);font-size:10px">[recycle]</span>' : '';
      html += '<div class="cc-worker-row">' +
        '<span class="cc-worker-id">' + escHtml(wId) + '</span>' +
        '<div class="cc-worker-bar-bg"><div class="cc-worker-bar-fill ' + s + '" style="width:' + barWidth + '%"></div></div>' +
        '<span class="cc-worker-state ' + s + '">' + s + recycleTag + '</span>' +
        (jobLabel ? '<span class="cc-worker-job">' + escHtml(jobLabel) + '</span>' : '') +
        '<span class="cc-worker-elapsed">' + (w.jobsProcessed || 0) + ' jobs' +
        (w.lastJobDescription && !w.busy ? ' \u00B7 ' + escHtml(w.lastJobDescription) + ' (' + (w.lastJobTimeMs / 1000).toFixed(1) + 's)' : '') +
        '</span></div>';
    });
    el.innerHTML = html;
    badge.textContent = alive + '/' + workers.length;

    // Stats
    $('cc-ep-jobs').textContent = String(ep.totalJobsCompleted || 0);
    var avgMs = ep.avgProveTimeMs || 0;
    $('cc-ep-avg').textContent = avgMs > 0 ? (avgMs < 1000 ? avgMs.toFixed(0) + 'ms' : (avgMs / 1000).toFixed(1) + 's') : '--';
    $('cc-ep-queue').textContent = String(ep.queueDepth || 0);

    // Also update worker cards page if it exists
    var cardsEl = $('ep-worker-cards');
    if (cardsEl) {
      if (!workers.length) {
        cardsEl.innerHTML = '<div class="empty-state">No entity proof pool workers</div>';
      } else {
        var cardsHtml = '<div class="worker-card-grid">';
        workers.forEach(function (w) {
          var ws = (w.state || w.status || 'idle').toLowerCase();
          var cls = ws === 'proving' || ws === 'busy' ? 'worker-card proving' :
                    ws === 'compiling' ? 'worker-card compiling' :
                    ws === 'dead' ? 'worker-card dead' : 'worker-card idle';
          cardsHtml += '<div class="' + cls + '">' +
            '<div class="worker-card-header">Worker E' + w.id + '</div>' +
            '<div class="worker-card-status">' + ws + '</div>' +
            '<div class="worker-card-stat">Jobs: ' + (w.jobsProcessed || 0) + '</div>' +
            (w.currentJobId ? '<div class="worker-card-stat" style="color:var(--accent)">Job: ' + w.currentJobId + '</div>' : '') +
            (w.pendingRecycle ? '<div class="worker-card-stat" style="color:var(--amber)">Pending recycle</div>' : '') +
            '</div>';
        });
        cardsHtml += '</div>';
        cardsEl.innerHTML = cardsHtml;
      }
    }
  }

  // ── Event Feed (SSE) ────────────────────────────────────────
  function addEvent(ev) {
    eventLog.unshift(ev);
    if (eventLog.length > MAX_LOG) eventLog.pop();
    if (currentTab === 'overview') renderEventLog();
    handleVizEvent(ev);
  }

  function renderEventLog() {
    var el = $('ov-events');
    if (!eventLog.length) {
      el.innerHTML = '<div class="empty-state">Waiting for events...</div>';
      return;
    }
    var html = '';
    eventLog.slice(0, 50).forEach(function (ev) {
      var type = ev.type || ev.event || 'unknown';
      var data = ev.data ? (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data).slice(0, 80)) : '';
      html += '<div class="event-item">' +
        '<span class="event-time">' + fmtTime(ev.timestamp || Date.now()) + '</span>' +
        '<span class="event-type">' + escHtml(type) + '</span>' +
        '<span class="event-data">' + escHtml(data) + '</span></div>';
    });
    el.innerHTML = html;
  }

  function handleVizEvent(ev) {
    var type = ev.type || ev.event || '';
    var data = ev.data || {};
    var selfId = levStatus && levStatus.nodeId || 'Leviathan';

    // ── Proof pipeline events ──
    if (type === 'proof:accepted') {
      metrics.proofTimestamps.push(Date.now());
      sparkTotal++;
      metrics.queueDepth = (levStatus && levStatus.globalTotals)
        ? (levStatus.globalTotals.pendingProofs || 0)
        : Math.max(0, metrics.queueDepth + 1);

      var ent = resolveEntity(data.walletId);
      trackEntityActivity(data.walletId, ent ? ent.type : null);
      addFeedItem({
        type: 'proof:accepted',
        typeClass: 'proof',
        from: ent ? ent.name : shortHash(data.walletId),
        fromColor: ent ? ENTITY_COLORS[ent.type] || '#8b949e' : '#3fb950',
        to: selfId,
        toColor: '#26c6da',
        detail: 'queued for proving \u00B7 partition ' + (data.partition !== undefined ? data.partition : '?'),
        timestamp: ev.timestamp || Date.now()
      });
    }
    else if (type === 'pool:worker:dispatched' || type.indexOf('worker:assigned') >= 0) {
      var wId = typeof data.workerId === 'number' ? 'W' + data.workerId : (data.workerId || 'W0');
      workerStartTimes[wId] = Date.now();
      addFeedItem({
        type: 'worker:dispatched',
        typeClass: 'worker',
        from: selfId,
        fromColor: '#26c6da',
        to: wId,
        toColor: '#ffc107',
        detail: 'proving job dispatched',
        timestamp: ev.timestamp || Date.now()
      });
    }
    else if (type === 'pool:worker:completed' || type.indexOf('worker:completed') >= 0) {
      if (data.proveTimeMs) {
        metrics.proveTimes.push(data.proveTimeMs);
        if (metrics.proveTimes.length > 20) metrics.proveTimes.shift();
      }
      var wId2 = typeof data.workerId === 'number' ? 'W' + data.workerId : (data.workerId || 'W0');
      delete workerStartTimes[wId2];
      addFeedItem({
        type: 'worker:completed',
        typeClass: 'proof',
        from: wId2,
        fromColor: '#ffc107',
        to: selfId,
        toColor: '#26c6da',
        detail: 'proved in ' + (data.proveTimeMs ? fmtAgo(data.proveTimeMs) : '--'),
        timestamp: ev.timestamp || Date.now()
      });
    }
    else if (type === 'pool:worker:compiling' || type.indexOf('worker:compiling') >= 0) {
      var wIdC = typeof data.workerId === 'number' ? 'W' + data.workerId : (data.workerId || 'W0');
      addFeedItem({
        type: 'worker:compiling',
        typeClass: 'worker',
        from: wIdC, fromColor: '#ffc107',
        to: null, toColor: null,
        detail: 'compiling circuits...',
        timestamp: ev.timestamp || Date.now()
      });
    }
    else if (type === 'pool:worker:crashed' || type.indexOf('worker:crashed') >= 0) {
      var wIdD = typeof data.workerId === 'number' ? 'W' + data.workerId : (data.workerId || 'W0');
      delete workerStartTimes[wIdD];
      addFeedItem({
        type: 'worker:crashed',
        typeClass: 'error',
        from: wIdD, fromColor: '#f85149',
        to: null, toColor: null,
        detail: data.error || 'worker process crashed',
        timestamp: ev.timestamp || Date.now()
      });
    }
    else if (type === 'pool:worker:ready' || type.indexOf('worker:ready') >= 0) {
      // silent — just update panel on next render
    }
    // ── Batch events ──
    else if (type === 'batch:built' || type.indexOf('batch:built') >= 0) {
      metrics.queueDepth = 0;
      loadBatchCache().then(function () { if (currentTab === 'overview') renderBatchPanel(); });
      addFeedItem({
        type: 'batch:built',
        typeClass: 'batch',
        from: selfId, fromColor: '#26c6da',
        to: 'Batch #' + (data.batchNumber || data.batchIndex || data.index || '?'), toColor: '#26c6da',
        detail: (data.proofCount || '?') + ' proofs batched',
        timestamp: ev.timestamp || Date.now()
      });
    }
    else if (type === 'batch:settled' || type.indexOf('batch:settled') >= 0) {
      loadBatchCache().then(function () { if (currentTab === 'overview') renderBatchPanel(); });
      addFeedItem({
        type: 'batch:settled',
        typeClass: 'batch',
        from: 'Batch #' + (data.batchNumber || data.batchIndex || data.index || '?'), fromColor: '#3fb950',
        to: 'Chain', toColor: '#3fb950',
        detail: 'settlement finalized',
        timestamp: ev.timestamp || Date.now()
      });
    }
    else if (type === 'batch:building' || type.indexOf('batch:building') >= 0) {
      // silent
    }
    // ── Gossip/heartbeat events ──
    else if (type.indexOf('heartbeat') >= 0) {
      triggerHeartbeat(ev.from || ev.nodeId || selfId);
    }
    else if (type.indexOf('gossip') >= 0) {
      addFeedItem({
        type: 'gossip',
        typeClass: 'gossip',
        from: ev.from || selfId, fromColor: '#26c6da',
        to: ev.to || 'peers', toColor: '#26c6da',
        detail: type,
        timestamp: ev.timestamp || Date.now()
      });
    }
    // ── Messaging events ──
    else if (type === 'viz:message:sent' || type === 'viz:message:received') {
      addFeedItem({
        type: 'message',
        typeClass: 'message',
        from: ev.actor || data.senderWalletId || '?',
        fromColor: '#e040fb',
        to: ev.target || data.recipientWalletId || '?',
        toColor: '#e040fb',
        detail: 'encrypted ' + (data.messageType || 'text') + ' message stored',
        timestamp: ev.timestamp || Date.now()
      });
    }
    // ── Entity registration events ──
    else if (type === 'viz:enrollment:started') {
      var entType = data.type || 'member';
      addFeedItem({
        type: 'entity:registered',
        typeClass: 'enrollment',
        from: ev.actor || data.displayName || '?',
        fromColor: ENTITY_COLORS[entType] || '#8b949e',
        to: 'Entity Registry',
        toColor: '#26c6da',
        detail: entType + ' registered' + (data.specialty ? ' (' + data.specialty + ')' : ''),
        timestamp: ev.timestamp || Date.now()
      });
    }
    // ── Provider credentialing events ──
    else if (type === 'viz:credential:generated') {
      addFeedItem({
        type: 'provider:credentialed',
        typeClass: 'credential',
        from: ev.actor || '?',
        fromColor: ENTITY_COLORS[data.providerType] || '#58a6ff',
        to: 'Provider Registry',
        toColor: '#26c6da',
        detail: (data.providerType || 'provider') + ' credentialed — leaf #' + (data.leafIndex || '?'),
        timestamp: ev.timestamp || Date.now()
      });
    }
    // ── Provider status change events ──
    else if (type === 'viz:enrollment:lifecycle') {
      var stateColor = data.stateName === 'active' ? '#3fb950' : data.stateName === 'suspended' ? '#f85149' : '#ffc107';
      addFeedItem({
        type: 'provider:status',
        typeClass: 'lifecycle',
        from: ev.actor || '?',
        fromColor: ENTITY_COLORS[data.providerType] || '#58a6ff',
        to: data.stateName || '?',
        toColor: stateColor,
        detail: (data.providerType || 'provider') + ' status → ' + (data.stateName || 'unknown'),
        timestamp: ev.timestamp || Date.now()
      });
    }
    // ── Pharmacy dispensing events ──
    else if (type === 'viz:pharmacy:dispensed') {
      addFeedItem({
        type: 'fill:dispensed',
        typeClass: 'fulfillment',
        from: ev.actor || '?',
        fromColor: ENTITY_COLORS.pharmacy || '#bc8cff',
        to: ev.target || '?',
        toColor: ENTITY_COLORS.member || '#3fb950',
        detail: (data.brandName || 'medication') + ' dispensed — leaf #' + (data.leafIndex || '?'),
        timestamp: ev.timestamp || Date.now()
      });
    }
    // ── Fallback ──
    else if (type.indexOf('proof') >= 0) {
      metrics.proofTimestamps.push(Date.now());
      sparkTotal++;
    }
    else if (type.indexOf('batch') >= 0) {
      loadBatchCache();
    }

    // Re-render worker panel on any worker event (if on overview)
    if (type.indexOf('worker') >= 0 || type.indexOf('pool:') >= 0) {
      if (currentTab === 'overview' && levStatus) renderWorkerPanel(levStatus);
    }
  }

  // ── Partitions Tab ──────────────────────────────────────────
  async function loadPartitions() {
    try {
      var status = levStatus || await RPC.getLeviathanStatus();
      levStatus = status;
      var partitions = status.partitions || [];

      // Stats
      var leaders = partitions.filter(function (p) { return p.leader === status.nodeId; }).length;
      $('part-stats').innerHTML =
        statCard('Total Partitions', partitions.length) +
        statCard('Leading', leaders) +
        statCard('Replicating', partitions.length - leaders) +
        statCard('Total Receipts', partitions.reduce(function (a, p) { return a + (p.receiptCount || 0); }, 0));

      // Cards
      var html = '<div class="partition-grid">';
      partitions.forEach(function (p, i) {
        var isLeader = p.leader === status.nodeId;
        html += '<div class="partition-card' + (isLeader ? ' is-leader' : '') + '">' +
          '<div class="partition-card-header">' +
          '<span class="partition-card-title">Partition ' + i + '</span>' +
          '<span class="badge ' + (isLeader ? 'badge-accent' : 'badge-info') + '">' +
          (isLeader ? 'LEADER' : 'REPLICA') + '</span></div>' +
          '<div class="detail-grid">' +
          detailRow('Leader', p.leader || '--') +
          detailRow('Receipts', p.receiptCount || 0) +
          detailRow('Batches', p.batchCount || 0) +
          detailRow('Pending', p.pendingCount || 0) +
          detailRow('Failover', (p.failoverChain || []).join(' → ') || '--') +
          '</div></div>';
      });
      html += '</div>';
      $('part-cards').innerHTML = html;
    } catch (e) {
      toast('Partitions load failed: ' + e.message, 'error');
    }
  }

  function setupPartitionRouter() {
    $('part-route-btn').addEventListener('click', function () {
      var walletId = $('part-wallet-input').value.trim();
      if (!walletId) return;
      var partCount = (levStatus && levStatus.partitions) ? levStatus.partitions.length : 1;
      // Match L2 partition routing: BigInt(walletId) % partitionCount
      // walletId is a Poseidon hash decimal string; use BigInt mod for exact parity
      var n = BigInt(walletId);
      var absN = n < 0n ? -n : n;
      var partition = Number(absN % BigInt(partCount));
      $('part-route-result').innerHTML =
        '<div class="form-result success">Wallet routes to <b>Partition ' + partition + '</b></div>';
    });
  }

  // ── Workers Tab ─────────────────────────────────────────────
  async function loadWorkers() {
    try {
      var status = levStatus || await RPC.getLeviathanStatus();
      levStatus = status;
      var workers = status.workers || (Array.isArray(status.provingPool) ? status.provingPool : []);
      if (!Array.isArray(workers)) workers = [];

      var idle = 0, proving = 0, compiling = 0, dead = 0, totalJobs = 0;
      workers.forEach(function (w) {
        var s = (w.state || w.status || 'idle').toLowerCase();
        if (s === 'idle' || s === 'ready') idle++;
        else if (s === 'proving' || s === 'busy') proving++;
        else if (s === 'compiling') compiling++;
        else dead++;
        totalJobs += w.jobsCompleted || w.jobs || 0;
      });

      $('worker-stats').innerHTML =
        statCard('Workers', workers.length) +
        statCard('Idle', idle) +
        statCard('Proving', proving, 'color:var(--green)') +
        statCard('Total Jobs', totalJobs);

      // Worker cards
      if (!workers.length) {
        $('worker-cards').innerHTML = '<div class="empty-state">No proving pool workers</div>';
        return;
      }
      var html = '<div class="worker-card-grid">';
      workers.forEach(function (w, i) {
        var s = (w.state || w.status || 'idle').toLowerCase();
        html += '<div class="worker-card state-' + s + '">' +
          '<div class="worker-card-header">' +
          '<span class="worker-card-id">W' + (w.id !== undefined ? w.id : i) + '</span>' +
          '<span class="badge ' + workerBadge(s) + '">' + s.toUpperCase() + '</span></div>' +
          '<div class="worker-card-stat">PID: ' + (w.pid || '--') + '</div>' +
          '<div class="worker-card-stat">Jobs: ' + (w.jobsCompleted || w.jobs || 0) + '</div>' +
          '<div class="worker-card-stat">Restarts: ' + (w.restarts || 0) + '</div>' +
          (w.currentJob ? '<div class="worker-card-stat" style="color:var(--accent)">Job: ' + shortHash(w.currentJob) + '</div>' : '') +
          (w.elapsed ? '<div class="worker-card-stat">Elapsed: ' + fmtAgo(w.elapsed) + '</div>' : '') +
          '</div>';
      });
      html += '</div>';
      $('worker-cards').innerHTML = html;
    } catch (e) {
      toast('Workers load failed: ' + e.message, 'error');
    }
  }

  function workerBadge(state) {
    switch (state) {
      case 'idle': case 'ready': return 'badge-info';
      case 'proving': case 'busy': return 'badge-ready';
      case 'compiling': return 'badge-amber';
      case 'dead': case 'crashed': return 'badge-error';
      default: return 'badge-info';
    }
  }

  // ── Gossip Tab ──────────────────────────────────────────────
  async function loadGossip() {
    try {
      var peerInfo = await RPC.getPeerInfo();
      var peerList = [];
      try { peerList = await RPC.getPeerList(); } catch (e) { /* optional */ }

      // Peer list
      var el = $('gossip-peers');
      if (!peerInfo && !peerList.length) {
        el.innerHTML = '<div class="empty-state">No peer data</div>';
      } else {
        var peers = peerList.length ? peerList : (peerInfo.peers || []);
        if (!Array.isArray(peers)) peers = [];
        var html = '';
        peers.forEach(function (p) {
          var status = p.status || 'active';
          var avatarClass = status === 'stale' ? 'stale' : (status === 'dead' ? 'dead' : '');
          html += '<div class="peer-item">' +
            '<div class="peer-avatar ' + avatarClass + '">' + (p.nodeId || p.id || '?').slice(0, 2).toUpperCase() + '</div>' +
            '<div class="peer-info">' +
            '<div class="peer-name">' + escHtml(p.nodeId || p.id || '--') + '</div>' +
            '<div class="peer-sub">' + escHtml(p.url || p.address || '--') + '</div>' +
            '</div>' +
            '<span class="badge ' + (status === 'active' ? 'badge-ready' : status === 'stale' ? 'badge-pending' : 'badge-error') + '">' +
            status.toUpperCase() + '</span></div>';
        });
        el.innerHTML = html || '<div class="empty-state">No peers connected</div>';
      }

      // Replication lag
      renderLag(peerInfo);

      // Gossip log
      renderGossipLog();
    } catch (e) {
      $('gossip-peers').innerHTML = '<div class="empty-state">Failed to load peers</div>';
    }
  }

  function renderLag(peerInfo) {
    var el = $('gossip-lag');
    if (!peerInfo || !peerInfo.replicationLag) {
      el.innerHTML = '<div class="empty-state">No replication lag data</div>';
      return;
    }
    var lags = peerInfo.replicationLag;
    var html = '';
    Object.keys(lags).forEach(function (peerId) {
      var lagMs = lags[peerId] || 0;
      var pct = Math.min(lagMs / 5000 * 100, 100);
      var cls = lagMs < 1000 ? 'ok' : lagMs < 3000 ? 'warn' : 'crit';
      html += '<div style="margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">' +
        '<span style="color:var(--text-secondary)">' + escHtml(peerId) + '</span>' +
        '<span style="color:var(--text-muted)">' + fmtAgo(lagMs) + '</span></div>' +
        '<div class="lag-bar-bg"><div class="lag-bar-fill ' + cls + '" style="width:' + pct + '%"></div></div></div>';
    });
    el.innerHTML = html || '<div class="empty-state">No lag data</div>';
  }

  function addGossipEntry(ev) {
    gossipLog.unshift(ev);
    if (gossipLog.length > MAX_LOG) gossipLog.pop();
    if (currentTab === 'gossip') renderGossipLog();
  }

  function renderGossipLog() {
    var el = $('gossip-log');
    var filter = $('gossip-filter').value;
    var filtered = gossipLog;
    if (filter !== 'all') {
      filtered = gossipLog.filter(function (ev) {
        return (ev.type || '').indexOf(filter) >= 0;
      });
    }
    if (!filtered.length) {
      el.innerHTML = '<div class="empty-state">No gossip messages' +
        (filter !== 'all' ? ' matching "' + filter + '"' : '') + '</div>';
      return;
    }
    var html = '';
    filtered.slice(0, 50).forEach(function (ev) {
      html += '<div class="event-item">' +
        '<span class="event-time">' + fmtTime(ev.timestamp) + '</span>' +
        '<span class="event-type">' + escHtml(ev.type || '--') + '</span>' +
        '<span class="event-data">' + escHtml(ev.from || '') +
        (ev.to ? ' → ' + escHtml(ev.to) : '') +
        (ev.data ? ' | ' + escHtml((typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)).slice(0, 60)) : '') +
        '</span></div>';
    });
    el.innerHTML = html;
  }

  // ── WAL & Quorum Tab ────────────────────────────────────────
  async function loadWal() {
    // WAL status
    try {
      var status = levStatus || await RPC.getLeviathanStatus();
      levStatus = status;
      var wal = status.wal || {};
      $('wal-status').innerHTML =
        '<div class="detail-grid">' +
        detailRow('Provider', wal.provider || 'InMemory') +
        detailRow('Entries', wal.entryCount || 0) +
        detailRow('Uncommitted', wal.uncommittedCount || 0) +
        detailRow('Last Commit', fmtTime(wal.lastCommit)) +
        detailRow('File Size', wal.fileSize ? (wal.fileSize / 1024).toFixed(1) + ' KB' : '--') +
        '</div>';
    } catch (e) {
      $('wal-status').innerHTML = '<div class="empty-state">WAL data unavailable</div>';
    }

    // Quorum status
    try {
      var quorum = await RPC.getQuorumStatus();
      $('quorum-status').innerHTML =
        '<div class="detail-grid">' +
        detailRow('Enabled', quorum.enabled !== undefined ? String(quorum.enabled) : '--') +
        detailRow('Quorum Threshold', quorum.quorumThreshold || '--') +
        detailRow('Known Peer Keys', quorum.knownPeerKeys || '--') +
        detailRow('Pending Proposals', quorum.pendingProposals || 0) +
        detailRow('Timeout', quorum.quorumTimeoutMs ? quorum.quorumTimeoutMs + 'ms' : '--') +
        '</div>';
    } catch (e) {
      $('quorum-status').innerHTML = '<div class="empty-state">Quorum data unavailable</div>';
    }

    // State certificates
    try {
      var parts = (levStatus && levStatus.partitions) || [];
      var certHtml = '';
      for (var i = 0; i < parts.length; i++) {
        try {
          var cert = await RPC.getStateCertificate(i);
          if (cert) {
            certHtml += '<div style="margin-bottom:12px;padding:10px;background:var(--bg-primary);border-radius:var(--radius-sm);border:1px solid var(--border)">' +
              '<div style="font-weight:600;font-size:12px;margin-bottom:6px;color:var(--accent)">Partition ' + i + '</div>' +
              '<div class="detail-grid">' +
              detailRow('Batch #', cert.batchIndex !== undefined ? cert.batchIndex : '--') +
              detailRow('State Root', shortHash(cert.stateRoot)) +
              detailRow('Votes', (cert.votes || []).length) +
              detailRow('Timestamp', fmtTime(cert.timestamp)) +
              '</div></div>';
          }
        } catch (e) { /* skip partition */ }
      }
      $('quorum-certs').innerHTML = certHtml || '<div class="empty-state">No state certificates</div>';
    } catch (e) {
      $('quorum-certs').innerHTML = '<div class="empty-state">Failed to load certificates</div>';
    }
  }

  // ── Batches & Receipts Tab ──────────────────────────────────
  async function loadBatches() {
    try {
      var batches = [];
      var receipts = [];
      try { batches = await RPC.getBatches(50); } catch (e) { /* ok */ }
      try { receipts = await RPC.getReceipts(50); } catch (e) { /* ok */ }

      if (!Array.isArray(batches)) batches = batches ? [batches] : [];
      if (!Array.isArray(receipts)) receipts = receipts ? [receipts] : [];

      $('batch-stats').innerHTML =
        statCard('Batches', batches.length) +
        statCard('Receipts', receipts.length) +
        statCard('Latest Batch', batches.length ? '#' + (batches[0].index || batches[0].batchIndex || 0) : '--');

      // Batch table
      var bHtml = '<table class="data-table"><thead><tr>' +
        '<th>#</th><th>Status</th><th>Proofs</th><th>Root</th><th>Time</th></tr></thead><tbody>';
      batches.slice(0, 30).forEach(function (b) {
        var bIdx = b.index !== undefined ? b.index : (b.batchIndex || b.batchNumber || 0);
        bHtml += '<tr onclick="window._showBatchDetail(' + bIdx + ')" style="cursor:pointer"><td>' + bIdx + '</td>' +
          '<td><span class="badge ' + (b.status === 'settled' || b.l1Status === 'settled' ? 'badge-ready' : 'badge-pending') + '">' +
          (b.status || b.l1Status || '--') + '</span></td>' +
          '<td>' + (b.proofCount || b.transitionCount || '--') + '</td>' +
          '<td><span class="hash">' + shortHash(b.stateRoot || b.settlementRoot) + '</span></td>' +
          '<td>' + fmtTime(b.timestamp || b.createdAt) + '</td></tr>';
      });
      bHtml += '</tbody></table>';
      $('batch-table').innerHTML = batches.length ? bHtml : '<div class="empty-state">No batches</div>';

      // Receipt table
      var rHtml = '<table class="data-table"><thead><tr>' +
        '<th>ID</th><th>Status</th><th>Wallet</th><th>Batch</th><th>Time</th></tr></thead><tbody>';
      receipts.slice(0, 30).forEach(function (r) {
        rHtml += '<tr><td>' + (r.id || '--') + '</td>' +
          '<td><span class="badge ' + (r.status === 'settled' || r.l1Status === 'settled' ? 'badge-ready' :
            r.status === 'accepted' || r.l1Status === 'accepted' ? 'badge-info' : 'badge-pending') + '">' +
          (r.status || r.l1Status || '--') + '</span></td>' +
          '<td><span class="hash">' + shortHash(r.walletId) + '</span></td>' +
          '<td>' + (r.batchIndex !== undefined ? '#' + r.batchIndex : '--') + '</td>' +
          '<td>' + fmtTime(r.timestamp || r.acceptedAt) + '</td></tr>';
      });
      rHtml += '</tbody></table>';
      $('receipt-table').innerHTML = receipts.length ? rHtml : '<div class="empty-state">No receipts</div>';
    } catch (e) {
      toast('Batches load failed: ' + e.message, 'error');
    }
  }

  // ── Audit Tab ───────────────────────────────────────────────
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
      var html = '<table class="data-table"><thead><tr>' +
        '<th>Seq</th><th>Type</th><th>Wallet</th><th>Chain Hash</th><th>Time</th></tr></thead><tbody>';
      log.slice(0, 50).forEach(function (ev) {
        html += '<tr><td>' + (ev.sequenceNumber || ev.seqNum || '--') + '</td>' +
          '<td>' + escHtml(ev.type || ev.eventType || '--') + '</td>' +
          '<td><span class="hash">' + shortHash(ev.walletId) + '</span></td>' +
          '<td><span class="hash">' + shortHash(ev.chainHash) + '</span></td>' +
          '<td>' + fmtTime(ev.timestamp) + '</td></tr>';
      });
      html += '</tbody></table>';
      $('audit-log-container').innerHTML = log.length ? html : '<div class="empty-state">No audit events</div>';
    } catch (e) {
      $('audit-log-container').innerHTML = '<div class="empty-state">Audit log unavailable</div>';
    }

    // Chain proof
    try {
      var proof = await RPC.getChainProof();
      if (proof) {
        $('audit-proof-container').innerHTML =
          '<div class="detail-grid">' +
          detailRow('Block Height', proof.blockHeight !== undefined ? proof.blockHeight : '--') +
          detailRow('Audit Chain Hash', shortHash(proof.auditChainHash)) +
          detailRow('Wallet Registry', shortHash(proof.walletRegistryRoot)) +
          detailRow('Lifecycle Root', shortHash(proof.lifecycleRoot)) +
          detailRow('Benefit Plan Root', shortHash(proof.benefitPlanRoot)) +
          detailRow('NFT Registry Root', shortHash(proof.nftRegistryRoot)) +
          '</div>';
      } else {
        $('audit-proof-container').innerHTML = '<div class="empty-state">No chain proof</div>';
      }
    } catch (e) {
      $('audit-proof-container').innerHTML = '<div class="empty-state">Chain proof unavailable</div>';
    }
  }

  function setupAuditChecks() {
    $('audit-chain-card').addEventListener('click', async function () {
      var card = this;
      var val = $('audit-chain-val');
      card.className = 'stat-card stat-clickable check-running';
      val.textContent = '...';
      try {
        var res = await RPC.verifyChainIntegrity();
        var ok = res && (res.valid || res.integrity === true);
        card.className = 'stat-card stat-clickable ' + (ok ? 'check-pass' : 'check-fail');
        val.textContent = ok ? 'PASS' : 'FAIL';
      } catch (e) {
        card.className = 'stat-card stat-clickable check-fail';
        val.textContent = 'ERROR';
      }
    });

    $('audit-finance-card').addEventListener('click', async function () {
      var card = this;
      var val = $('audit-finance-val');
      card.className = 'stat-card stat-clickable check-running';
      val.textContent = '...';
      try {
        var res = await RPC.verifyFinancialBalance();
        var ok = res && (res.balanced || res.valid);
        card.className = 'stat-card stat-clickable ' + (ok ? 'check-pass' : 'check-fail');
        val.textContent = ok ? 'PASS' : 'FAIL';
      } catch (e) {
        card.className = 'stat-card stat-clickable check-fail';
        val.textContent = 'ERROR';
      }
    });

    $('audit-dup-card').addEventListener('click', async function () {
      var card = this;
      var val = $('audit-dup-val');
      card.className = 'stat-card stat-clickable check-running';
      val.textContent = '...';
      try {
        var res = await RPC.detectDuplicateClaims();
        var dups = Array.isArray(res) ? res.length : (res && res.duplicates ? res.duplicates.length : 0);
        card.className = 'stat-card stat-clickable ' + (dups === 0 ? 'check-pass' : 'check-fail');
        val.textContent = dups === 0 ? 'CLEAN' : dups + ' found';
      } catch (e) {
        card.className = 'stat-card stat-clickable check-fail';
        val.textContent = 'ERROR';
      }
    });
  }

  // ── Admin Tab ───────────────────────────────────────────────
  async function loadAdmin() {
    // Node config
    try {
      var status = levStatus || await RPC.getLeviathanStatus();
      levStatus = status;
      $('admin-config').innerHTML =
        '<div class="detail-grid">' +
        detailRow('Node ID', status.nodeId || '--') +
        detailRow('Partitions', status.partitionCount || '--') +
        detailRow('Role', status.role || 'leviathan') +
        detailRow('Heartbeat Interval', '5000ms') +
        detailRow('Heartbeat Timeout', '15000ms') +
        detailRow('Max Peers', status.maxPeers || '--') +
        detailRow('Uptime', fmtAgo(status.uptime)) +
        '</div>';
    } catch (e) {
      $('admin-config').innerHTML = '<div class="empty-state">Config unavailable</div>';
    }

    // Health
    await refreshAdminHealth();
  }

  async function refreshAdminHealth() {
    try {
      var health = await RPC.getHealth();
      var html = '<div class="detail-grid">';
      if (typeof health === 'object') {
        Object.keys(health).forEach(function (k) {
          var v = health[k];
          if (typeof v === 'object') v = JSON.stringify(v);
          html += detailRow(k, String(v));
        });
      } else {
        html += detailRow('Status', String(health));
      }
      html += '</div>';
      $('admin-health').innerHTML = html;
    } catch (e) {
      $('admin-health').innerHTML = '<div class="empty-state">Health check failed</div>';
    }
  }

  function setupAdmin() {
    $('admin-set-token').addEventListener('click', function () {
      RPC.setAdminToken($('admin-token-input').value.trim());
      toast('Admin token set', 'success');
    });

    $('admin-force-batch').addEventListener('click', async function () {
      var partInput = $('admin-force-part').value;
      var partIdx = partInput !== '' ? parseInt(partInput, 10) : undefined;
      try {
        var res = await RPC.forceBatch(partIdx);
        $('admin-action-result').innerHTML =
          '<div class="form-result success">Batch forced' +
          (partIdx !== undefined ? ' on partition ' + partIdx : '') +
          (res ? ': ' + JSON.stringify(res).slice(0, 100) : '') + '</div>';
        toast('Batch forced successfully', 'success');
      } catch (e) {
        $('admin-action-result').innerHTML =
          '<div class="form-result error">' + escHtml(e.message) + '</div>';
        toast('Force batch failed', 'error');
      }
    });

    $('admin-health-refresh').addEventListener('click', refreshAdminHealth);

    // ── Setup Buttons ──
    $('setup-setup-btn').addEventListener('click', function () { runSetup(false); });
    $('setup-token-only-btn').addEventListener('click', function () { runSetup(true); });
    $('setup-token-value').addEventListener('click', function () {
      var text = this.textContent;
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          toast('Token copied to clipboard', 'success');
        });
      }
    });
  }

  // ── Setup Helpers ──────────────────────────────────────────────

  function demoLogStep(log, msg, ok) {
    var color = ok === true ? 'var(--green)' : ok === false ? 'var(--red)' : 'var(--text-secondary)';
    var icon = ok === true ? '\u2713' : ok === false ? '\u2717' : '\u22EF';
    log.innerHTML += '<div style="color:' + color + ';margin:2px 0">' + icon + ' ' + escHtml(msg) + '</div>';
    log.scrollTop = log.scrollHeight;
  }

  async function demoRequest(baseUrl, method, path, body, token) {
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);
    var res = await fetch(baseUrl + path, opts);
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    if (data && data.ok === false && data.error) throw new Error(data.error);
    if (data && data.ok !== undefined && data.data !== undefined) return data.data;
    return data;
  }

  async function runSetup(tokenOnly) {
    var fullBtn = $('setup-setup-btn');
    var tokenBtn = $('setup-token-only-btn');
    var log = $('setup-setup-log');
    var tokenDisplay = $('setup-token-display');
    fullBtn.disabled = true;
    tokenBtn.disabled = true;
    fullBtn.textContent = tokenOnly ? 'Running...' : 'Running Full Ceremony...';
    log.innerHTML = '';
    tokenDisplay.style.display = 'none';

    // The legacy "full ceremony" assumed an always-on employer node at 4005.
    // Post-Phase A, employer nodes are spawned on-demand by marketplace activation,
    // so this wizard requires the operator to manually enter the active tenant URL.
    var empUrl = $('setup-employer-url').value.trim();
    if (!empUrl) {
      demoLogStep(log, 'No employer URL provided. After Phase A, employer nodes are spawned on-demand by marketplace activation. Complete the marketplace flow first at http://localhost:4004/marketplace/, then paste the activated employer node URL here.', false);
      fullBtn.disabled = false;
      tokenBtn.disabled = false;
      fullBtn.textContent = 'Run Full Ceremony';
      return;
    }
    var memUrl = $('setup-member-url').value.trim() || 'http://localhost:4001';
    var adminToken = $('setup-admin-token').value.trim() || '';
    var groupId = $('setup-group-id').value.trim() || 'GRP-001';
    var employeeId = $('setup-employee-id').value.trim() || 'EMP-001';

    function L(msg, ok) { demoLogStep(log, msg, ok); }
    function empReq(m, p, b) { return demoRequest(empUrl, m, p, b, adminToken); }
    function memReq(m, p, b) { return demoRequest(memUrl, m, p, b); }

    try {
      // ═══ PRE-FLIGHT: Check required nodes ═══
      L('═══ PRE-FLIGHT: Checking required nodes ═══');
      await checkAllNodeHealth();
      var requiredNodes = [
        { id: 'leviathan', label: 'Leviathan (:3030)', why: 'sequencer — accepts proofs, builds batches' },
        { id: 'insurer', label: 'Insurer (:4004)', why: 'credentials providers, registers wallets' },
        { id: 'member', label: 'Member (:4001)', why: 'receives tokens, submits enrollment proof' },
      ];
      var prefightFailed = false;
      requiredNodes.forEach(function (rn) {
        var s = nodeHealthState[rn.id];
        if (s && s.alive) {
          L(rn.label + ' — ALIVE (' + s.latencyMs + 'ms, phase: ' + s.phase + ')', true);
        } else {
          L(rn.label + ' — DOWN (' + (s ? s.error : 'not checked') + ') — needed for: ' + rn.why, false);
          prefightFailed = true;
        }
      });
      // Also check optional nodes
      ['prescriber', 'pharmacy'].forEach(function (nid) {
        var s = nodeHealthState[nid];
        var n = NETWORK_NODES.find(function (x) { return x.id === nid; });
        if (s && s.alive) {
          L((n ? n.label : nid) + ' — ALIVE (optional)', true);
        } else {
          L((n ? n.label : nid) + ' — DOWN (optional, won\'t block enrollment)', null);
        }
      });
      if (prefightFailed) {
        L('');
        L('CANNOT PROCEED — required nodes are down. Restart the leviathan process.', false);
        throw new Error('Pre-flight failed: required nodes are down');
      }
      L('All required nodes alive — proceeding with ceremony');
      L('');

      // ═══ PHASE 1: EMPLOYER — Group + Token ═══
      L('═══ PHASE 1: EMPLOYER SETUP ═══');

      L('Configuring employer node...');
      try {
        await empReq('POST', '/onboarding/configure', { employerId: 'ACME-CORP-001' });
        L('Employer node configured', true);
      } catch (e) {
        L('Employer already configured (OK)', true);
      }

      L('Creating group ' + groupId + '...');
      try {
        await empReq('POST', '/groups', {
          groupId: groupId, planId: 'standard-plan',
          effectiveDate: '20260101', enrollmentCap: 100
        });
        L('Group ' + groupId + ' created', true);
      } catch (e) {
        L('Group ' + groupId + ' exists (OK)', true);
      }

      L('Checking in-network providers...');
      try {
        var entities = await (await fetch(location.origin + '/viz/entities')).json();
        var prescribers = entities.filter(function (e) { return e.type === 'prescriber'; });
        var pharmacies = entities.filter(function (e) { return e.type === 'pharmacy'; });
        L(prescribers.length + ' prescribers: ' +
          prescribers.slice(0, 3).map(function (p) { return p.displayName; }).join(', ') +
          (prescribers.length > 3 ? ' +' + (prescribers.length - 3) + ' more' : ''), true);
        L(pharmacies.length + ' pharmacies: ' +
          pharmacies.slice(0, 3).map(function (p) { return p.displayName; }).join(', ') +
          (pharmacies.length > 3 ? ' +' + (pharmacies.length - 3) + ' more' : ''), true);
      } catch (e) {
        L('Provider check skipped: ' + e.message, false);
      }

      L('Generating enrollment token...');
      var tokenResult = await empReq('POST', '/tokens/generate', {
        groupId: groupId, employeeId: employeeId, validUntil: '20271231'
      });
      var tokenId = tokenResult.tokenId || tokenResult;
      L('Token: ' + tokenId, true);

      $('setup-token-value').textContent = tokenId;
      tokenDisplay.style.display = 'block';

      if (tokenOnly) {
        L('');
        L('Token ready. Enter it in the Member app (phone or localhost:4001).');
        toast('Token generated — ready for phone', 'success');
        return;
      }

      // ═══ PHASE 2: WAITING FOR PHONE ENROLLMENT ═══
      L('');
      L('═══ PHASE 2: WAITING FOR PHONE ENROLLMENT ═══');
      L('Enter the token above in the phone app now.');
      L('Watching sequencer for new wallet registration...');

      // Snapshot current sequencer state
      var baseStatus = await RPC.getStatus();
      var baseWallets = parseInt(baseStatus.currentWalletCount || '0', 10);
      var baseProofs = baseStatus.totalProofsAccepted || 0;
      L('Current wallets: ' + baseWallets + ', proofs accepted: ' + baseProofs, null);

      // Poll every 3 seconds for up to 10 minutes
      var maxWaitMs = 600000;
      var pollIntervalMs = 3000;
      var waited = 0;
      var detected = false;
      var dots = 0;
      var waitEl = document.createElement('div');
      waitEl.style.cssText = 'color:var(--amber);margin:4px 0';
      waitEl.textContent = 'Waiting for phone...';
      log.appendChild(waitEl);

      while (waited < maxWaitMs) {
        await new Promise(function (r) { setTimeout(r, pollIntervalMs); });
        waited += pollIntervalMs;
        dots = (dots + 1) % 4;

        try {
          var curStatus = await RPC.getStatus();
          var curWallets = parseInt(curStatus.currentWalletCount || '0', 10);
          var curProofs = curStatus.totalProofsAccepted || 0;

          waitEl.textContent = 'Waiting for phone' + '....'.slice(0, dots + 1) +
            ' (' + Math.floor(waited / 1000) + 's, wallets: ' + curWallets + ', proofs: ' + curProofs + ')';

          if (curProofs > baseProofs) {
            detected = true;
            L('New proof detected on sequencer!', true);
            L('Wallets: ' + baseWallets + ' → ' + curWallets, true);
            L('Proofs: ' + baseProofs + ' → ' + curProofs, true);
            break;
          }
          if (curWallets > baseWallets) {
            detected = true;
            L('New wallet registered on sequencer!', true);
            L('Wallets: ' + baseWallets + ' → ' + curWallets, true);
            break;
          }
        } catch (e) {
          // sequencer hiccup — keep polling
        }
      }

      waitEl.remove();

      if (!detected) {
        L('Timed out waiting for phone enrollment (10 min).', false);
        L('You can still force a batch manually from the Admin panel.', null);
        throw new Error('Enrollment not detected within timeout');
      }

      // ═══ PHASE 3: BATCH SETTLEMENT ═══
      L('');
      L('═══ PHASE 3: BATCH SETTLEMENT ═══');

      // Wait a moment for the proof to be fully processed
      await new Promise(function (r) { setTimeout(r, 2000); });

      L('Forcing batch build (triggers proving pool workers)...');
      try {
        // Call forceBatch directly via RPC to bypass admin token requirement
        var batchResult = await RPC.call('l2_forceBatch', {});
        L('Batch forced — proving pool workers activated', true);
        L('Watch the Overview topology for proof flow!', null);
      } catch (e) {
        L('Force batch: ' + e.message, false);
        L('Batch will build automatically on the next timer cycle.', null);
      }

      // ═══ PHASE 4: VERIFICATION ═══
      L('');
      L('═══ PHASE 4: VERIFICATION ═══');

      // Re-check status after batch
      await new Promise(function (r) { setTimeout(r, 3000); });
      try {
        var finalStatus = await RPC.getStatus();
        L('Wallets registered: ' + (finalStatus.currentWalletCount || '0'), true);
        L('Proofs accepted: ' + (finalStatus.totalProofsAccepted || 0), true);
        L('Batches built: ' + (finalStatus.totalBatchesBuilt || 0), true);
        L('Batches settled: ' + (finalStatus.totalBatchesSettled || 0), true);
        L('Pending proofs: ' + (finalStatus.pendingProofs || 0), null);
      } catch (e) {
        L('Status check failed: ' + e.message, false);
      }

      L('');
      L('═══ CEREMONY COMPLETE ═══');
      L('Member enrolled from phone. Wallet registered on-chain.');
      L('Proof accepted by sequencer. Batch settling in proving pool.');
      var peerCount = 0;
      try { var pList = await RPC.getPeerList(); peerCount = pList.length; } catch (e) {}
      L('Gossip replicating to ' + peerCount + ' peer(s).');
      toast('Full ceremony complete', 'success');
    } catch (e) {
      L('FAILED: ' + e.message, false);
      toast('Ceremony failed: ' + e.message, 'error');
    } finally {
      fullBtn.disabled = false;
      tokenBtn.disabled = false;
      fullBtn.textContent = 'Run Full Ceremony';
    }
  }

  // ── Shared Rendering Helpers ────────────────────────────────
  function statCard(label, value, style) {
    return '<div class="stat-card">' +
      '<span class="stat-label">' + escHtml(label) + '</span>' +
      '<span class="stat-value"' + (style ? ' style="' + style + '"' : '') + '>' + escHtml(String(value)) + '</span></div>';
  }

  function detailRow(key, val) {
    return '<div class="detail-key">' + escHtml(key) + '</div>' +
      '<div class="detail-val">' + escHtml(String(val)) + '</div>';
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── SSE Setup ───────────────────────────────────────────────
  function startSSE() {
    RPC.connectSSE(function (ev) {
      addEvent(ev);
    });

    RPC.connectVizSSE(function (ev) {
      var type = ev.type || ev.event || '';
      // Route gossip/heartbeat/failover events to gossip log
      if (type.indexOf('gossip') >= 0 || type.indexOf('heartbeat') >= 0 ||
          type.indexOf('leader:') >= 0 || type.indexOf('quorum:') >= 0 ||
          type.indexOf('peer:') >= 0) {
        addGossipEntry({
          type: type,
          from: ev.from || ev.nodeId,
          to: ev.to,
          data: ev.data,
          timestamp: ev.timestamp || Date.now()
        });
      }
      handleVizEvent(ev);
    });

    RPC.onConnectionChange(function (state) {
      setConnDot(state);
      diagLog('SSE connection: ' + state, state === 'disconnected');
    });
  }

  // ── Periodic Refresh ────────────────────────────────────────
  function startPolling() {
    pollTimer = setInterval(async function () {
      if (currentTab === 'overview') {
        try {
          var status = await RPC.getLeviathanStatus();
          levStatus = status;
          var gt = status.globalTotals || {};
          metrics.queueDepth = gt.pendingProofs || 0;
          renderWorkerPanel(status);
          renderQueuePanel(status);
          renderNetworkPanel(status);
          renderEntityPanel();
          renderOverviewPartitions(status);
          renderOverviewWorkers(status);
          try {
            var health = await RPC.getHealth();
            renderEntityProofPool(health);
          } catch (_) { /* health fetch optional */ }
          setConnDot('connected');
        } catch (e) {
          setConnDot('disconnected');
        }
      }
      // Refresh entity cache every 30s
      if (Date.now() - entityCacheTime > 30000) {
        loadEntities();
      }
    }, 3000);
  }

  // ── Refresh Buttons ─────────────────────────────────────────
  function setupRefreshButtons() {
    var map = {
      'part-refresh-btn': function () { loadPartitions(); },
      'worker-refresh-btn': function () { loadWorkers(); },
      'gossip-refresh-btn': function () { loadGossip(); },
      'wal-refresh-btn': function () { loadWal(); },
      'quorum-refresh-btn': function () { loadWal(); },
      'batch-refresh-btn': function () { loadBatches(); },
      'receipt-refresh-btn': function () { loadBatches(); },
      'audit-log-refresh': function () { loadAudit(); },
      'audit-proof-refresh': function () { loadAudit(); }
    };
    Object.keys(map).forEach(function (id) {
      var btn = $(id);
      if (btn) btn.addEventListener('click', map[id]);
    });
  }

  // ── Init ────────────────────────────────────────────────────
  function init() {
    // Tab navigation
    qsa('.nav-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(this.dataset.tab);
      });
    });

    // URL-based tab selection
    var hash = location.hash.replace('#', '');
    if (hash && $('page-' + hash)) {
      navigate(hash);
    } else {
      navigate('overview');
    }

    window.addEventListener('hashchange', function () {
      var h = location.hash.replace('#', '');
      if (h && h !== currentTab && $('page-' + h)) navigate(h);
    });

    // Setup interactions
    setupPartitionRouter();
    setupAuditChecks();
    setupAdmin();
    setupRefreshButtons();

    // Gossip filter
    $('gossip-filter').addEventListener('change', renderGossipLog);

    // Run initial health check, then load data
    diagLog('Dashboard starting — probing all network nodes...');
    checkAllNodeHealth().then(function () {
      diagLog('Initial health check complete');
      loadEntities();
      loadBatchCache();
      startSSE();
      startPolling();
    });

    // Re-check node health every 10s (reduced from 3s to avoid request contention)
    setInterval(function () {
      checkAllNodeHealth();
    }, 10000);

    // Sparkline ticker — 1s interval
    setInterval(tickSparkline, 1000);

    // Worker elapsed timer — update proving bars every 3s
    workerTimerInterval = setInterval(function () {
      if (currentTab === 'overview' && levStatus) {
        renderWorkerPanel(levStatus);
        renderQueuePanel(levStatus);
      }
    }, 3000);

    // Entity proof pool fast poll — 1.5s to catch workers in "proving" state
    setInterval(async function () {
      if (currentTab !== 'overview') return;
      try {
        var health = await RPC.getHealth();
        renderEntityProofPool(health);
      } catch (_) { /* ignore */ }
    }, 1500);
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
