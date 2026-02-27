/**
 * app.js — Main controller for the Network Topology Dashboard.
 *
 * Boots the force graph, connects SSE streams, polls state,
 * and dispatches VizEvents to the graph, timeline, and activity log.
 */

(function () {
  'use strict';

  // ─── Static Entity Definitions ──────────────────────────
  const MEMBERS = [
    { idx: 0, name: 'Alice Johnson', family: 'FAM-ACME-10001', rel: 'SELF' },
    { idx: 1, name: 'Bob Martinez', family: 'FAM-ACME-10002', rel: 'SELF' },
    { idx: 2, name: 'Carol Williams', family: 'FAM-ACME-10003', rel: 'SELF' },
    { idx: 3, name: 'Daniel Williams', family: 'FAM-ACME-10003', rel: 'SPOUSE' },
    { idx: 4, name: 'Emma Williams', family: 'FAM-ACME-10003', rel: 'CHILD' },
    { idx: 5, name: 'Frank Lee', family: 'FAM-GX-50001', rel: 'SELF' },
    { idx: 6, name: 'Grace Nakamura', family: 'FAM-GX-50002', rel: 'SELF' },
    { idx: 7, name: 'Henry Okafor', family: 'FAM-GX-50003', rel: 'SELF' },
  ];

  const PRESCRIBERS = [
    { idx: 0, name: 'Dr. Chen', specialty: 'Internal Med' },
    { idx: 1, name: 'Dr. Patel', specialty: 'Endocrinology' },
    { idx: 2, name: 'Dr. Okonkwo', specialty: 'Rheumatology' },
    { idx: 3, name: 'Dr. Yamamoto', specialty: 'Pulmonology' },
    { idx: 4, name: 'Dr. Singh', specialty: 'Cardiology' },
    { idx: 5, name: 'Dr. Rodriguez', specialty: 'Psychiatry' },
    { idx: 6, name: 'Dr. Kim', specialty: 'Dermatology' },
    { idx: 7, name: 'Dr. Novak', specialty: 'Oncology' },
    { idx: 8, name: 'Dr. Okafor', specialty: 'Neurology' },
    { idx: 9, name: 'Dr. Anderson', specialty: 'Family Med' },
  ];

  const PHARMACIES = [
    { idx: 0, name: 'CVS #1001' },
    { idx: 1, name: 'Walgreens #2001' },
    { idx: 2, name: 'Rite Aid #3001' },
    { idx: 3, name: 'Walmart #4001' },
    { idx: 4, name: 'Costco #5001' },
    { idx: 5, name: 'Kroger #6001' },
    { idx: 6, name: 'Express Scripts' },
    { idx: 7, name: 'OptumRx' },
  ];

  // ─── Human-readable event descriptions ────────────────
  const EVENT_LABELS = {
    'viz:token:generated':          { verb: 'generated enrollment token', icon: '🔑', color: '#ffa726' },
    'viz:enrollment:wallet_derived': { verb: 'derived wallet', icon: '🔐', color: '#4fc3f7' },
    'viz:enrollment:proof_gate':    { verb: 'generating enrollment proof', icon: '⚡', color: '#ab47bc' },
    'viz:enrollment:started':       { verb: 'submitted enrollment proof', icon: '📤', color: '#4fc3f7' },
    'viz:enrollment:registration':  { verb: 'registered wallet on-chain', icon: '✅', color: '#66bb6a' },
    'viz:enrollment:credential_mint': { verb: 'minted credential', icon: '🪪', color: '#ffa726' },
    'viz:enrollment:lifecycle':     { verb: 'lifecycle transition', icon: '🔄', color: '#26c6da' },
    'viz:enrollment:provider_notify': { verb: 'notified provider', icon: '📨', color: '#ab47bc' },
    'viz:enrollment:complete':      { verb: 'enrollment complete', icon: '🎉', color: '#66bb6a' },
    'viz:enrollment:terminated':    { verb: 'terminated enrollment', icon: '🚫', color: '#ef5350' },
    'viz:eligibility:check':        { verb: 'checking eligibility', icon: '🔍', color: '#ffa726' },
    'viz:eligibility:verified':     { verb: 'eligibility verified', icon: '✅', color: '#66bb6a' },
    'viz:prescription:written':     { verb: 'wrote prescription', icon: '📝', color: '#66bb6a' },
    'viz:prescription:sent':        { verb: 'sent Rx to pharmacy', icon: '📨', color: '#66bb6a' },
    'viz:prescription:received':    { verb: 'received prescription', icon: '📩', color: '#66bb6a' },
    'viz:prescription:status':      { verb: 'Rx status changed', icon: '🔄', color: '#ffa726' },
    'viz:fulfillment:started':      { verb: 'started fulfillment', icon: '💊', color: '#66bb6a' },
    'viz:fulfillment:settled':      { verb: 'settled fulfillment', icon: '✅', color: '#66bb6a' },
    'viz:fulfillment:reversed':     { verb: 'reversed fulfillment', icon: '↩️', color: '#ef5350' },
    'viz:pharmacy:dispensed':       { verb: 'dispensed medication', icon: '💊', color: '#ffa726' },
    'viz:pharmacy:rejected':        { verb: 'rejected prescription', icon: '❌', color: '#ef5350' },
    'viz:pharmacy:credential_scan': { verb: 'scanned credential', icon: '📱', color: '#ffa726' },
    'viz:accumulator:updated':      { verb: 'accumulator updated', icon: '📊', color: '#26c6da' },
    'viz:reversal:processed':       { verb: 'reversal processed', icon: '↩️', color: '#ef5350' },
    'viz:batch:submitted':          { verb: 'batch built', icon: '📦', color: '#26c6da' },
    'viz:batch:settled':            { verb: 'batch settled', icon: '✅', color: '#66bb6a' },
    'viz:message:sent':             { verb: 'sent message', icon: '💬', color: '#ec4899' },
    'viz:message:received':         { verb: 'received message', icon: '💬', color: '#ec4899' },
    'viz:delegation:created':       { verb: 'created delegation', icon: '🤝', color: '#ffa726' },
    'viz:formulary:check':          { verb: 'checking formulary', icon: '📋', color: '#ffa726' },
    'viz:formulary:verified':       { verb: 'formulary verified', icon: '✅', color: '#66bb6a' },
    'viz:leviathan:heartbeat':      { verb: 'heartbeat', icon: '💚', color: '#26c6da' },
    'viz:leviathan:gossip':         { verb: 'gossip relay', icon: '📡', color: '#26c6da' },
    'viz:leviathan:failover':       { verb: 'failover', icon: '⚠️', color: '#ef5350' },
  };

  // ─── State ──────────────────────────────────────────────
  let forceGraph = null;
  let blockTimeline = null;
  let leviathanModal = null;
  let entityModal = null;
  let compilationReady = false;
  let statusPollInterval = null;
  let compilationPollInterval = null;
  let lastStatusData = null;
  let lastStateData = null;
  const enrolledWalletIds = new Set();

  // Activity log
  const MAX_LOG_ENTRIES = 200;
  let activityLogEl = null;
  let logCount = 0;

  // Console panel
  let consoleOutputEl = null;
  let consoleActiveFilter = 'all';
  let consoleEventSource = null;

  // ─── Init ───────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const svgEl = document.getElementById('graph-svg');
    forceGraph = new ForceGraph(svgEl);
    // Expose on SVG element so block-timeline can trigger leviathan animations
    svgEl.__forceGraph = forceGraph;

    blockTimeline = new BlockTimeline(
      document.getElementById('timeline-cards'),
      document.getElementById('next-batch-timer'),
      document.getElementById('batch-popup'),
    );

    leviathanModal = new LeviathanModal(document.getElementById('leviathan-modal'));
    entityModal = new EntityModal(document.getElementById('entity-modal'));
    activityLogEl = document.getElementById('activity-log-entries');

    // Toggle activity log
    document.getElementById('btn-toggle-log').addEventListener('click', () => {
      document.getElementById('activity-log-panel').classList.toggle('hidden');
    });
    document.getElementById('btn-close-log').addEventListener('click', () => {
      document.getElementById('activity-log-panel').classList.add('hidden');
    });

    // Click any node → open its modal
    forceGraph.onNodeClick = (d, event) => {
      if (d.entityType === 'leviathan' && lastStatusData) {
        const lev = lastStatusData.leviathans.find(l => l.id === d.id);
        if (lev) leviathanModal.show(lev, lastStatusData.partitionMap);
      } else {
        entityModal.show(d, lastStateData);
      }
    };

    document.getElementById('btn-smoke-test').addEventListener('click', runSmokeTest);
    document.getElementById('btn-reset').addEventListener('click', resetDashboard);
    document.getElementById('btn-close-smoke').addEventListener('click', () => {
      document.getElementById('smoke-test-panel').classList.add('hidden');
    });

    buildInitialEntities();

    compilationPollInterval = setInterval(pollCompilation, 2000);
    pollCompilation();

    statusPollInterval = setInterval(pollStatus, 4000);
    pollStatus();

    connectVizSse();
    connectConsoleSse();
    initConsolePanel();
    blockTimeline.start();

    // Expose pollStatus globally so modals can trigger data refresh after actions
    window._dashboardPollStatus = pollStatus;
    window._lastStateData = () => lastStateData;
    window._lastStatusData = () => lastStatusData;
  });

  // ─── Activity Log ──────────────────────────────────────
  function addLogEntry(event) {
    if (!activityLogEl) return;

    const info = EVENT_LABELS[event.type];
    if (!info) return;

    // Skip heartbeats from cluttering the log
    if (event.type === 'viz:leviathan:heartbeat') return;

    const { actor, target, data = {} } = event;
    logCount++;

    // Build description
    let desc = `<strong>${escapeHtml(actor || 'System')}</strong> ${info.verb}`;
    if (target) desc += ` → <strong>${escapeHtml(target)}</strong>`;

    // Add contextual detail from data
    const detail = buildLogDetail(event.type, data);
    if (detail) desc += ` <span class="log-detail">${detail}</span>`;

    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
      <span class="log-icon" style="color:${info.color}">${info.icon}</span>
      <span class="log-time">${formatTimestamp(event.timestamp || Date.now())}</span>
      <span class="log-desc">${desc}</span>
    `;

    activityLogEl.appendChild(entry);

    // Trim old entries
    while (activityLogEl.children.length > MAX_LOG_ENTRIES) {
      activityLogEl.removeChild(activityLogEl.firstChild);
    }

    // Auto-scroll
    activityLogEl.scrollTop = activityLogEl.scrollHeight;

    // Update counter badge
    const badge = document.getElementById('log-count');
    if (badge) badge.textContent = logCount;
  }

  function buildLogDetail(type, data) {
    if (!data) return '';
    if (data.medication) return `(${escapeHtml(data.medication)})`;
    if (data.prescriptionId && data.medication) return `(Rx: ${escapeHtml(data.medication)})`;
    if (data.patientPayCents && data.planPayCents) {
      return `(patient $${(data.patientPayCents/100).toFixed(2)}, plan $${(data.planPayCents/100).toFixed(2)})`;
    }
    if (data.newStatus) return `(→ ${escapeHtml(data.newStatus)})`;
    if (data.walletId) return `(${truncHash(data.walletId)})`;
    if (data.partitionIndex != null) return `(partition ${data.partitionIndex})`;
    return '';
  }

  // ─── Build Initial Entity Set ───────────────────────────
  function buildInitialEntities() {
    const entities = [];

    entities.push({
      id: 'insurer', label: 'Insurer', sublabel: 'Attestation Authority',
      entityType: 'insurer',
    });

    entities.push({
      id: 'employer', label: 'Employer', sublabel: 'Token Authority',
      entityType: 'employer',
    });

    entities.push({
      id: 'lev-alpha', label: 'Alpha', sublabel: 'Sequencer',
      entityType: 'leviathan', role: 'sequencer', primaryPartition: 0,
      activePartitions: [0], status: 'running',
    });
    entities.push({
      id: 'lev-beta', label: 'Beta', sublabel: 'Replica',
      entityType: 'leviathan', role: 'replica', primaryPartition: 1,
      activePartitions: [1], status: 'running',
    });
    entities.push({
      id: 'lev-gamma', label: 'Gamma', sublabel: 'Replica',
      entityType: 'leviathan', role: 'replica', primaryPartition: 2,
      activePartitions: [2], status: 'running',
    });

    // All 8 members — start as gray (unenrolled)
    for (const m of MEMBERS) {
      entities.push({
        id: `member-${m.idx}`, label: m.name, sublabel: m.rel,
        entityType: 'member', memberIndex: m.idx,
        enrollmentState: 'unenrolled',
      });
    }

    for (const p of PRESCRIBERS) {
      entities.push({
        id: `prescriber-${p.idx}`, label: p.name, sublabel: p.specialty,
        entityType: 'prescriber', prescriberIndex: p.idx,
      });
    }

    for (const ph of PHARMACIES) {
      entities.push({
        id: `pharmacy-${ph.idx}`, label: ph.name,
        entityType: 'pharmacy', pharmacyIndex: ph.idx,
      });
    }

    forceGraph.setEntities(entities);
  }

  // ─── Compilation Polling ────────────────────────────────
  async function pollCompilation() {
    try {
      const res = await fetch('/flowchart/compilation');
      if (!res.ok) return;
      const data = await res.json();
      renderCompilationOverlay(data);

      if (data.status === 'complete' && !compilationReady) {
        compilationReady = true;
        document.getElementById('btn-smoke-test').disabled = false;
        clearInterval(compilationPollInterval);
      }
    } catch { /* ignore */ }
  }

  function renderCompilationOverlay(data) {
    const overlay = document.getElementById('compilation-overlay');
    if (data.status === 'complete') {
      document.getElementById('compilation-progress-fill').style.width = '100%';
      document.getElementById('compilation-percent').textContent = '100%';
      document.getElementById('compilation-current').textContent = 'All programs compiled';
      setTimeout(() => overlay.classList.add('hidden'), 600);
      return;
    }
    overlay.classList.remove('hidden');

    const programs = data.programs || [];
    const total = programs.length || 1;
    const done = programs.filter(p => p.status === 'complete').length;
    const compiling = programs.find(p => p.status === 'compiling');

    const progress = ((done + (compiling ? 0.5 : 0)) / total) * 100;
    document.getElementById('compilation-progress-fill').style.width = `${progress.toFixed(1)}%`;
    document.getElementById('compilation-percent').textContent = `${Math.round(progress)}%`;

    const currentEl = document.getElementById('compilation-current');
    if (compiling) {
      currentEl.textContent = `Compiling ${compiling.name}...`;
    } else if (done === 0) {
      currentEl.textContent = 'Waiting for compilation to start...';
    } else {
      currentEl.textContent = `${done}/${total} compiled`;
    }

    const programsEl = document.getElementById('compilation-programs');
    programsEl.innerHTML = programs.map(p => {
      const cls = p.status === 'complete' ? 'comp-complete' : p.status === 'compiling' ? 'comp-compiling' : '';
      let icon;
      if (p.status === 'complete') {
        icon = '<span style="color:var(--accent-teal)">&#10003;</span>';
      } else if (p.status === 'compiling') {
        icon = '<span class="comp-spinner"></span>';
      } else {
        icon = '<span style="color:var(--text-muted)">&#183;</span>';
      }
      const time = p.elapsedMs ? formatTime(p.elapsedMs) : '';
      return `<div class="comp-row ${cls}">
        <span class="comp-icon">${icon}</span>
        <span class="comp-name">${escapeHtml(p.name)}</span>
        <span class="comp-time">${time}</span>
      </div>`;
    }).join('');
  }

  // ─── Status Polling ─────────────────────────────────────
  async function pollStatus() {
    try {
      const [statusRes, stateRes] = await Promise.all([
        fetch('/flowchart/status'),
        fetch('/interactive/state'),
      ]);
      if (!statusRes.ok) return;

      const statusData = await statusRes.json();
      lastStatusData = statusData;

      document.getElementById('stat-block-height').textContent = statusData.chain.blockHeight;
      document.getElementById('stat-receipts').textContent = statusData.chain.receiptCount;
      document.getElementById('stat-batches').textContent = statusData.chain.batchCount;
      document.getElementById('stat-wallets').textContent = statusData.chain.walletCount;

      const entities = buildEntitiesFromStatus(statusData);

      if (stateRes.ok) {
        const stateData = await stateRes.json();
        lastStateData = stateData;
        const enrolledMembers = stateData.enrolledMembers || [];

        enrolledWalletIds.clear();
        for (const m of enrolledMembers) {
          enrolledWalletIds.add(String(m.walletId));
          const entity = entities.find(e => e.id === `member-${m.memberIndex}`);
          if (entity) {
            entity.enrollmentState = 'enrolled';
            entity.walletId = m.walletId;
            entity.sublabel = truncHash(m.walletId);
          }
        }

        forceGraph.setEntities(entities);

        forceGraph.updateRelationships({
          members: enrolledMembers,
          leviathans: statusData.leviathans,
          partitionMap: statusData.partitionMap,
          partitionCount: statusData.partitionCount,
          prescriptions: stateData.prescriptions || [],
        });
      } else {
        forceGraph.setEntities(entities);
      }

      if (statusData.smokeTest && statusData.smokeTest.status !== 'idle') {
        renderSmokeTestPanel(statusData.smokeTest);
      }
    } catch { /* ignore */ }
  }

  function buildEntitiesFromStatus(statusData) {
    const entities = [];

    entities.push({
      id: 'insurer', label: 'Insurer', sublabel: 'Attestation Authority',
      entityType: 'insurer',
    });

    entities.push({
      id: 'employer', label: 'Employer', sublabel: 'Token Authority',
      entityType: 'employer',
    });

    for (const lev of statusData.leviathans) {
      entities.push({
        id: lev.id,
        label: lev.name.replace('Leviathan ', ''),
        sublabel: lev.role === 'sequencer' ? 'Sequencer' : 'Replica',
        entityType: 'leviathan',
        role: lev.role,
        primaryPartition: lev.primaryPartition,
        activePartitions: lev.activePartitions,
        status: lev.status,
        lastHeartbeat: lev.lastHeartbeat,
      });
    }

    for (const m of MEMBERS) {
      entities.push({
        id: `member-${m.idx}`, label: m.name, sublabel: m.rel,
        entityType: 'member', memberIndex: m.idx,
        enrollmentState: 'unenrolled',
      });
    }

    for (const p of PRESCRIBERS) {
      entities.push({
        id: `prescriber-${p.idx}`, label: p.name, sublabel: p.specialty,
        entityType: 'prescriber', prescriberIndex: p.idx,
      });
    }

    for (const ph of PHARMACIES) {
      entities.push({
        id: `pharmacy-${ph.idx}`, label: ph.name,
        entityType: 'pharmacy', pharmacyIndex: ph.idx,
      });
    }

    return entities;
  }

  // ─── SSE Connection ─────────────────────────────────────
  function connectVizSse() {
    const evtSource = new EventSource('/viz/events');

    // SSE named events: server sends `event: viz:enrollment:started\ndata: {...}\n\n`
    // We must addEventListener for each specific event type (SSE requires exact name match).
    const vizEventTypes = Object.keys(EVENT_LABELS);
    for (const evtType of vizEventTypes) {
      evtSource.addEventListener(evtType, (e) => {
        try {
          const event = JSON.parse(e.data);
          handleVizEvent(event);
        } catch { /* ignore */ }
      });
    }

    evtSource.onerror = () => {};
  }

  // ─── VizEvent Handler ──────────────────────────────────
  function handleVizEvent(event) {
    const { type, actor, actorType, target, targetType } = event;

    // Always log the event
    addLogEntry(event);

    if (type === 'viz:leviathan:heartbeat') {
      forceGraph.handleHeartbeat(actor);
      return;
    }
    if (type === 'viz:leviathan:gossip') {
      forceGraph.animateGossipRelay(actor, target);
      return;
    }
    if (type === 'viz:leviathan:failover') {
      forceGraph.pulseNode(actor, '#ef5350', 2);
      forceGraph.pulseNode(target, '#66bb6a', 3);
      return;
    }

    const fromId = resolveNodeId(actor, actorType, event);
    const toId = target ? resolveNodeId(target, targetType, event) : null;

    // Enrollment lifecycle — gray → blue → green
    if (type === 'viz:enrollment:started') {
      if (fromId) {
        forceGraph.setMemberState(fromId, 'enrolling');
        forceGraph.setEnrollingOverlay(fromId, true);
      }
    }
    if (type === 'viz:enrollment:complete') {
      if (fromId) {
        forceGraph.setMemberState(fromId, 'enrolled');
        forceGraph.setEnrollingOverlay(fromId, false);
      }
      pollStatus();
    }

    if (type === 'viz:enrollment:proof_gate' || type === 'viz:fulfillment:started') {
      if (fromId) forceGraph.setProvingSpinner(fromId, true);
    }
    if (type === 'viz:enrollment:registration' || type === 'viz:fulfillment:settled') {
      if (fromId) forceGraph.setProvingSpinner(fromId, false);
    }

    if (fromId && toId) {
      forceGraph.animateEvent(fromId, toId, type);
    }

    // Batch events — pulse all running leviathans
    if (type === 'viz:batch:submitted') {
      // Batch building — pulse cyan on all running leviathans
      if (lastStatusData && lastStatusData.leviathans) {
        for (const lev of lastStatusData.leviathans) {
          if (lev.status === 'running') {
            forceGraph.pulseNode(lev.id, '#26c6da', 3);
          }
        }
      }
      // Reset building state on timeline
      if (blockTimeline) blockTimeline.isBuilding = false;
      pollStatus();
    }
    if (type === 'viz:batch:settled') {
      if (lastStatusData && lastStatusData.leviathans) {
        for (const lev of lastStatusData.leviathans) {
          if (lev.status === 'running') {
            forceGraph.pulseNode(lev.id, '#66bb6a', 2);
          }
        }
      }
      pollStatus();
    }
  }

  function resolveNodeId(name, type, event) {
    if (!name) return null;

    // Already a node ID
    if (name.startsWith('member-') || name.startsWith('prescriber-') ||
        name.startsWith('pharmacy-') || name.startsWith('lev-') ||
        name === 'insurer' || name === 'employer') {
      return name;
    }

    if (type === 'insurer') return 'insurer';
    if (type === 'employer') return 'employer';
    if (type === 'leviathan') {
      // Could be 'lev-alpha', 'leviathan', or a display name
      if (name.startsWith('lev-')) return name;
      return 'lev-alpha'; // default to primary leader
    }

    const data = event.data || {};

    // Try explicit index first (if service includes it)
    if (type === 'prescriber') {
      const idx = data.prescriberIndex ?? data.providerIndex;
      if (idx != null) return `prescriber-${idx}`;
    }
    if (type === 'pharmacy') {
      const idx = data.pharmacyIndex;
      if (idx != null) return `pharmacy-${idx}`;
    }
    if (type === 'member') {
      const idx = data.memberIndex;
      if (idx != null) return `member-${idx}`;
    }

    // Name-based fallback: match display name → node ID
    const lowerName = name.toLowerCase();

    if (type === 'member') {
      const match = MEMBERS.find(m => m.name.toLowerCase() === lowerName);
      if (match) return `member-${match.idx}`;
    }
    if (type === 'prescriber') {
      const match = PRESCRIBERS.find(p => p.name.toLowerCase() === lowerName);
      if (match) return `prescriber-${match.idx}`;
    }
    if (type === 'pharmacy') {
      const match = PHARMACIES.find(p => p.name.toLowerCase() === lowerName);
      if (match) return `pharmacy-${match.idx}`;
    }

    // Universal name scan if type wasn't provided or didn't match
    if (!type) {
      for (const m of MEMBERS) {
        if (m.name.toLowerCase() === lowerName) return `member-${m.idx}`;
      }
      for (const p of PRESCRIBERS) {
        if (p.name.toLowerCase() === lowerName) return `prescriber-${p.idx}`;
      }
      for (const ph of PHARMACIES) {
        if (ph.name.toLowerCase() === lowerName) return `pharmacy-${ph.idx}`;
      }
      if (lowerName.includes('insurer') || lowerName.includes('attestation')) return 'insurer';
      if (lowerName.includes('employer') || lowerName.includes('acme') || lowerName.includes('hr')) return 'employer';
    }

    return null;
  }

  // ─── Smoke Test ─────────────────────────────────────────
  async function runSmokeTest() {
    try {
      const res = await fetch('/flowchart/smoke-test', { method: 'POST' });
      if (res.ok) {
        document.getElementById('smoke-test-panel').classList.remove('hidden');
        const pollSmoke = setInterval(async () => {
          try {
            const r = await fetch('/flowchart/smoke-test-status');
            if (!r.ok) return;
            const data = await r.json();
            renderSmokeTestPanel(data);
            if (data.status === 'complete' || data.status === 'error') {
              clearInterval(pollSmoke);
            }
          } catch { /* ignore */ }
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to start smoke test:', err);
    }
  }

  function renderSmokeTestPanel(data) {
    const panel = document.getElementById('smoke-test-panel');
    panel.classList.remove('hidden');

    const stepsEl = document.getElementById('smoke-test-steps');
    stepsEl.innerHTML = data.steps.map((step) => {
      const cls = step.status === 'running' ? 'step-running'
        : step.status === 'complete' ? 'step-complete'
        : step.status === 'error' ? 'step-error' : '';
      let icon;
      if (step.status === 'complete') icon = '<span style="color:var(--accent-teal)">&#10003;</span>';
      else if (step.status === 'running') icon = '<span class="comp-spinner"></span>';
      else if (step.status === 'error') icon = '<span style="color:var(--accent-red)">&#10007;</span>';
      else icon = '<span style="color:var(--text-muted)">&#9679;</span>';
      const time = step.elapsedMs ? formatTime(step.elapsedMs) : '';
      return `<div class="smoke-step ${cls}">
        <span class="step-icon">${icon}</span>
        <span class="step-desc">${escapeHtml(step.description)}</span>
        <span class="step-time">${time}</span>
      </div>`;
    }).join('');
  }

  // ─── Reset ──────────────────────────────────────────────
  async function resetDashboard() {
    try {
      await fetch('/flowchart/reset', { method: 'POST' });
      document.getElementById('smoke-test-panel').classList.add('hidden');
      enrolledWalletIds.clear();
      if (activityLogEl) activityLogEl.innerHTML = '';
      logCount = 0;
      const badge = document.getElementById('log-count');
      if (badge) badge.textContent = '0';
      if (consoleOutputEl) consoleOutputEl.innerHTML = '';
      buildInitialEntities();
      pollStatus();
    } catch (err) {
      console.error('Reset failed:', err);
    }
  }

  // ─── Console Panel ──────────────────────────────────────
  function initConsolePanel() {
    consoleOutputEl = document.getElementById('console-output');
    const panel = document.getElementById('console-panel');
    const resizeHandle = document.getElementById('console-resize-handle');
    const clearBtn = document.getElementById('btn-console-clear');

    // Filter buttons
    document.querySelectorAll('.console-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.console-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        consoleActiveFilter = btn.dataset.filter;
        applyConsoleFilter();
      });
    });

    // Clear button
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (consoleOutputEl) consoleOutputEl.innerHTML = '';
      });
    }

    // Resize handle
    if (resizeHandle && panel) {
      let startY = 0, startHeight = 0;
      const onMouseMove = (e) => {
        const delta = startY - e.clientY;
        const newHeight = Math.max(80, Math.min(window.innerHeight * 0.5, startHeight + delta));
        panel.style.height = `${newHeight}px`;
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      resizeHandle.addEventListener('mousedown', (e) => {
        startY = e.clientY;
        startHeight = panel.offsetHeight;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    }
  }

  function connectConsoleSse() {
    consoleEventSource = new EventSource('/interactive/console');

    consoleEventSource.addEventListener('console', (e) => {
      try {
        const event = JSON.parse(e.data);
        addConsoleLine(event);
      } catch { /* ignore */ }
    });

    consoleEventSource.onopen = () => {
      addConsoleSystemLine('Connected to console stream');
    };

    consoleEventSource.onerror = () => {};
  }

  function addConsoleLine(event) {
    if (!consoleOutputEl) return;

    const ts = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const elapsed = event.elapsedMs ? ` (${(event.elapsedMs / 1000).toFixed(2)}s)` : '';

    const el = document.createElement('div');
    el.className = `console-line ${event.type || 'info'}`;
    el.dataset.type = event.type || 'info';
    el.innerHTML = `<span class="ts">[${ts}]</span> ${escapeHtml(event.message || '')}${elapsed}`;

    if (consoleActiveFilter !== 'all' && event.type !== consoleActiveFilter) {
      el.classList.add('hidden');
    }

    consoleOutputEl.appendChild(el);

    // Trim old entries (keep last 500 lines)
    while (consoleOutputEl.children.length > 500) {
      consoleOutputEl.removeChild(consoleOutputEl.firstChild);
    }

    // Auto-scroll
    requestAnimationFrame(() => {
      consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
    });
  }

  function addConsoleSystemLine(message) {
    if (!consoleOutputEl) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const el = document.createElement('div');
    el.className = 'console-line system';
    el.dataset.type = 'system';
    el.innerHTML = `<span class="ts">[${ts}]</span> ${escapeHtml(message)}`;
    consoleOutputEl.appendChild(el);
    requestAnimationFrame(() => {
      consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
    });
  }

  function applyConsoleFilter() {
    if (!consoleOutputEl) return;
    consoleOutputEl.querySelectorAll('.console-line').forEach(el => {
      if (consoleActiveFilter === 'all') {
        el.classList.remove('hidden');
      } else {
        if (el.dataset.type === consoleActiveFilter) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
    });
  }

})();
