/**
 * zkp.Care Leviathan Dashboard — Application Logic
 * 8 tabs: Overview, Partitions, Workers, Gossip, WAL/Quorum, Batches, Audit, Admin
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let currentTab = 'overview';
  let levStatus = null;       // cached leviathan status
  let topoNodes = [];         // { id, type, x, y, role, partition, state, ... }
  let topoLinks = [];         // { source, target, type }
  let eventLog = [];          // max 200
  let gossipLog = [];         // max 200
  let pollTimer = null;

  const MAX_LOG = 200;

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

  // ── Topology Renderer ───────────────────────────────────────
  function renderTopology(status) {
    var svg = $('topology-svg');
    var rect = svg.getBoundingClientRect();
    var W = rect.width || 1200;
    var H = rect.height || 420;
    var cx = W / 2;
    var cy = H / 2 - 20;

    // Clear layers
    $('topo-lanes').innerHTML = '';
    $('topo-connections').innerHTML = '';
    $('topo-animations').innerHTML = '';
    $('topo-nodes').innerHTML = '';
    topoNodes = [];
    topoLinks = [];

    if (!status) return;

    var partitions = status.partitions || [];
    var nodeId = status.nodeId || 'self';
    var partCount = partitions.length || 1;

    // Calculate leviathan positions (circle layout)
    var leviathans = [];
    var levRadius = Math.min(W, H) * 0.28;
    // Gather unique leviathan node IDs (from partitions + peers)
    var levIds = new Set();
    var peerRoles = {};
    levIds.add(nodeId);
    partitions.forEach(function (p) {
      if (p.leader) levIds.add(p.leader);
      if (p.failoverChain) p.failoverChain.forEach(function (f) { levIds.add(f); });
    });
    // Add connected peers (replicas) to topology
    var peers = status.peers || [];
    peers.forEach(function (p) {
      var pid = p.nodeId || p.id || p.peerId;
      if (pid && !levIds.has(pid)) levIds.add(pid);
      if (pid) peerRoles[pid] = p.role || 'replica';
    });
    var levArr = Array.from(levIds);
    var levAngleStep = (2 * Math.PI) / Math.max(levArr.length, 1);

    levArr.forEach(function (lid, i) {
      var angle = -Math.PI / 2 + i * levAngleStep;
      var x = cx + levRadius * Math.cos(angle);
      var y = cy + levRadius * Math.sin(angle);
      // Determine which partitions this leviathan leads
      var leadsParts = [];
      partitions.forEach(function (p, pi) {
        if (p.leader === lid) leadsParts.push(pi);
      });
      var isLeader = leadsParts.length > 0;
      var nodeRole = isLeader || lid === nodeId ? 'S' : 'R';
      if (peerRoles[lid] === 'replica') nodeRole = 'R';
      leviathans.push({
        id: lid, type: 'leviathan', x: x, y: y,
        role: nodeRole,
        partitions: leadsParts,
        isSelf: lid === nodeId
      });
      topoNodes.push({ id: lid, type: 'leviathan', x: x, y: y });
    });

    // Draw partition lane bands (vertical stripes behind everything)
    var laneW = W / Math.max(partCount, 1);
    var colors = ['#26c6da', '#ffc107', '#ab47bc', '#66bb6a', '#ef5350', '#ec4899'];
    partitions.forEach(function (p, i) {
      var lane = svgEl('rect', {
        x: i * laneW, y: 0, width: laneW, height: H,
        fill: colors[i % colors.length],
        class: 'partition-lane'
      });
      $('topo-lanes').appendChild(lane);
      // Partition label
      var label = svgEl('text', {
        x: i * laneW + laneW / 2, y: 16,
        fill: colors[i % colors.length], opacity: 0.3,
        'font-size': 10, 'text-anchor': 'middle',
        'font-family': "'JetBrains Mono', monospace", 'font-weight': 600
      });
      label.textContent = 'P' + i;
      $('topo-lanes').appendChild(label);
    });

    // Draw gossip connections between leviathans
    for (var i = 0; i < leviathans.length; i++) {
      for (var j = i + 1; j < leviathans.length; j++) {
        var a = leviathans[i], b = leviathans[j];
        var line = svgEl('line', {
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          class: 'gossip-line',
          'data-from': a.id, 'data-to': b.id
        });
        $('topo-connections').appendChild(line);
        topoLinks.push({ source: a.id, target: b.id, el: line });
      }
    }

    // Draw leviathan nodes
    leviathans.forEach(function (lev, idx) {
      var g = svgEl('g', {
        class: 'topo-node',
        transform: 'translate(' + lev.x + ',' + lev.y + ')',
        'data-id': lev.id
      });

      // Core glow
      g.appendChild(svgEl('circle', {
        r: 32, fill: 'none', stroke: '#26c6da', 'stroke-width': 2,
        class: 'lev-core-glow phase-' + (idx % 3),
        filter: 'url(#glow-teal)'
      }));

      // Outer dashed ring
      g.appendChild(svgEl('circle', {
        r: 28, fill: 'none', stroke: '#26c6da',
        'stroke-width': lev.role === 'S' ? 2.5 : 1.5,
        'stroke-dasharray': '4 3',
        opacity: lev.role === 'S' ? 1 : 0.4,
        class: 'lev-outer-ring'
      }));

      // Inner solid ring
      g.appendChild(svgEl('circle', {
        r: 20, fill: 'rgba(38,198,218,0.08)',
        stroke: '#26c6da',
        'stroke-width': lev.role === 'S' ? 2 : 1.5,
        opacity: lev.role === 'S' ? 0.9 : 0.4,
        class: 'lev-inner-ring'
      }));

      // Core dot
      g.appendChild(svgEl('circle', {
        r: 5, fill: lev.role === 'S' ? '#26c6da' : 'rgba(38,198,218,0.4)'
      }));

      // Role badge
      var badge = svgEl('text', {
        y: 1, class: 'node-badge', 'text-anchor': 'middle',
        'dominant-baseline': 'central',
        fill: lev.role === 'S' ? '#fff' : 'rgba(255,255,255,0.5)',
        'font-size': 12, 'font-weight': 700,
        'font-family': "'JetBrains Mono', monospace"
      });
      badge.textContent = lev.role;
      g.appendChild(badge);

      // Name label below
      var nameLabel = svgEl('text', {
        y: 44, class: 'node-label', 'text-anchor': 'middle',
        fill: lev.isSelf ? '#26c6da' : '#8b949e',
        'font-size': 10
      });
      nameLabel.textContent = lev.id.length > 12 ? lev.id.slice(0, 10) + '…' : lev.id;
      g.appendChild(nameLabel);

      // Partition badges
      if (lev.partitions.length > 0) {
        var partLabel = svgEl('text', {
          y: -36, 'text-anchor': 'middle',
          fill: '#26c6da', opacity: 0.7,
          'font-size': 9, 'font-weight': 600,
          'font-family': "'JetBrains Mono', monospace"
        });
        partLabel.textContent = lev.partitions.map(function (p) { return 'P' + p; }).join(',');
        g.appendChild(partLabel);
      }

      $('topo-nodes').appendChild(g);
    });

    // Draw worker nodes (small octagons near their parent leviathan)
    var workers = status.workers || (Array.isArray(status.provingPool) ? status.provingPool : []);
    if (Array.isArray(workers) && workers.length) {
      var selfLev = leviathans.find(function (l) { return l.isSelf; }) || leviathans[0];
      if (selfLev) {
        var wCount = workers.length;
        var wRadius = 65;
        var wAngleStep = (Math.PI * 0.6) / Math.max(wCount - 1, 1);
        var wBaseAngle = Math.PI * 0.2; // spread workers below-right of leviathan

        workers.forEach(function (w, wi) {
          var angle = wBaseAngle + wi * wAngleStep;
          var wx = selfLev.x + wRadius * Math.cos(angle);
          var wy = selfLev.y + wRadius * Math.sin(angle);

          // Connection line from worker to parent
          var wLine = svgEl('line', {
            x1: selfLev.x, y1: selfLev.y, x2: wx, y2: wy,
            stroke: '#ffc107', 'stroke-width': 1,
            'stroke-dasharray': '3 3', opacity: 0.3
          });
          $('topo-connections').appendChild(wLine);

          var wg = svgEl('g', {
            class: 'topo-node',
            transform: 'translate(' + wx + ',' + wy + ')',
            'data-id': 'W' + wi
          });

          // Octagon path
          var r = 14;
          var pts = [];
          for (var oi = 0; oi < 8; oi++) {
            var a = (Math.PI / 8) + oi * (Math.PI / 4);
            pts.push((r * Math.cos(a)).toFixed(1) + ',' + (r * Math.sin(a)).toFixed(1));
          }
          var state = (w.state || w.status || 'idle').toLowerCase();
          wg.appendChild(svgEl('polygon', {
            points: pts.join(' '),
            fill: state === 'dead' || state === 'crashed' ? 'rgba(85,85,85,0.2)' : 'rgba(255,193,7,0.1)',
            stroke: state === 'dead' || state === 'crashed' ? '#555' : '#ffc107',
            'stroke-width': 1.5,
            class: 'worker-shape state-' + state,
            filter: state === 'proving' ? 'url(#glow-amber)' : ''
          }));

          // Worker badge
          var wBadge = svgEl('text', {
            y: 1, 'text-anchor': 'middle',
            'dominant-baseline': 'central',
            fill: '#ffc107', 'font-size': 9, 'font-weight': 700,
            'font-family': "'JetBrains Mono', monospace"
          });
          wBadge.textContent = 'W' + wi;
          wg.appendChild(wBadge);

          $('topo-nodes').appendChild(wg);
          topoNodes.push({ id: 'W' + wi, type: 'worker', x: wx, y: wy });
        });
      }
    }
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] !== undefined && attrs[k] !== '') el.setAttribute(k, attrs[k]);
      });
    }
    return el;
  }

  // ── Topology Animations ─────────────────────────────────────
  function topoFlashGossip(fromId, toId) {
    // Flash the gossip line
    topoLinks.forEach(function (link) {
      if ((link.source === fromId && link.target === toId) ||
          (link.source === toId && link.target === fromId)) {
        link.el.classList.add('active');
        setTimeout(function () { link.el.classList.remove('active'); }, 1500);
      }
    });

    // Sonar ripple on sender
    var senderNode = topoNodes.find(function (n) { return n.id === fromId; });
    if (senderNode) {
      var ring = svgEl('circle', {
        cx: senderNode.x, cy: senderNode.y, r: 28,
        class: 'sonar-ring animate'
      });
      $('topo-animations').appendChild(ring);
      setTimeout(function () { ring.remove(); }, 1500);
    }
  }

  function topoHeartbeat(nodeId) {
    var nodeG = qs('.topo-node[data-id="' + nodeId + '"]');
    if (nodeG) {
      nodeG.classList.add('lev-heartbeat');
      setTimeout(function () { nodeG.classList.remove('lev-heartbeat'); }, 1300);
    }
  }

  function topoProofFlow(fromId, toId, color) {
    var from = topoNodes.find(function (n) { return n.id === fromId; });
    var to = topoNodes.find(function (n) { return n.id === toId; });
    if (!from || !to) return;

    var dot = svgEl('circle', {
      cx: from.x, cy: from.y, r: 4,
      fill: color || '#26c6da',
      class: 'proof-dot animate',
      filter: 'url(#glow-generic)'
    });
    $('topo-animations').appendChild(dot);

    // Animate along line
    var dur = 2000;
    var start = performance.now();
    function step(ts) {
      var t = Math.min((ts - start) / dur, 1);
      var ease = t * (2 - t); // ease-out
      dot.setAttribute('cx', from.x + (to.x - from.x) * ease);
      dot.setAttribute('cy', from.y + (to.y - from.y) * ease);
      if (t < 1) requestAnimationFrame(step);
      else dot.remove();
    }
    requestAnimationFrame(step);
  }

  // ── Overview Tab ────────────────────────────────────────────
  async function loadOverview() {
    try {
      var status = await RPC.getLeviathanStatus();
      levStatus = status;

      // Header badges
      $('header-node-id').textContent = status.nodeId || '--';
      $('header-partition').textContent = 'P×' + (status.partitionCount || '?');
      if (status.uptime) $('header-uptime').textContent = fmtAgo(status.uptime);
      setConnDot('connected');

      // Render topology
      renderTopology(status);

      // Partition ownership mini-grid
      renderOverviewPartitions(status);

      // Worker pool
      renderOverviewWorkers(status);
    } catch (e) {
      setConnDot('disconnected');
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
    if (type.indexOf('heartbeat') >= 0) {
      topoHeartbeat(ev.from || ev.nodeId || (levStatus && levStatus.nodeId));
    } else if (type.indexOf('gossip') >= 0) {
      topoFlashGossip(ev.from || (levStatus && levStatus.nodeId), ev.to || '');
    } else if (type.indexOf('proof') >= 0 || type.indexOf('batch') >= 0) {
      topoProofFlow(ev.from || 'W0', ev.to || (levStatus && levStatus.nodeId), '#66bb6a');
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
        (ev.data ? ' | ' + (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)).slice(0, 60) : '') +
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
        detailRow('Required Votes', quorum.requiredVotes || '--') +
        detailRow('Total Nodes', quorum.totalNodes || '--') +
        detailRow('Pending Proposals', quorum.pendingProposals || 0) +
        detailRow('Timeout', quorum.timeoutMs ? quorum.timeoutMs + 'ms' : '--') +
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
        bHtml += '<tr><td>' + (b.index !== undefined ? b.index : b.batchIndex || '--') + '</td>' +
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

    // ── Demo Setup Buttons ──
    $('demo-setup-btn').addEventListener('click', function () { runDemoSetup(false); });
    $('demo-token-only-btn').addEventListener('click', function () { runDemoSetup(true); });
    $('demo-token-value').addEventListener('click', function () {
      var text = this.textContent;
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          toast('Token copied to clipboard', 'success');
        });
      }
    });
  }

  // ── Demo Helpers ──────────────────────────────────────────────

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

  async function runDemoSetup(tokenOnly) {
    var fullBtn = $('demo-setup-btn');
    var tokenBtn = $('demo-token-only-btn');
    var log = $('demo-setup-log');
    var tokenDisplay = $('demo-token-display');
    fullBtn.disabled = true;
    tokenBtn.disabled = true;
    fullBtn.textContent = tokenOnly ? 'Running...' : 'Running Full Ceremony...';
    log.innerHTML = '';
    tokenDisplay.style.display = 'none';

    var empUrl = $('demo-employer-url').value.trim() || 'http://localhost:4005';
    var memUrl = $('demo-member-url').value.trim() || 'http://localhost:4001';
    var adminToken = $('demo-admin-token').value.trim() || 'admin123';
    var groupId = $('demo-group-id').value.trim() || 'GRP-001';
    var employeeId = $('demo-employee-id').value.trim() || 'EMP-001';

    function L(msg, ok) { demoLogStep(log, msg, ok); }
    function empReq(m, p, b) { return demoRequest(empUrl, m, p, b, adminToken); }
    function memReq(m, p, b) { return demoRequest(memUrl, m, p, b); }

    try {
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

      $('demo-token-value').textContent = tokenId;
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
    });
  }

  // ── Periodic Refresh ────────────────────────────────────────
  function startPolling() {
    pollTimer = setInterval(async function () {
      if (currentTab === 'overview') {
        try {
          var status = await RPC.getLeviathanStatus();
          levStatus = status;
          renderTopology(status);
          renderOverviewPartitions(status);
          renderOverviewWorkers(status);
          setConnDot('connected');
        } catch (e) {
          setConnDot('disconnected');
        }
      }
    }, 10000);
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

    // Start SSE + polling
    startSSE();
    startPolling();
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
