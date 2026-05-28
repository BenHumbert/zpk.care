/**
 * zkpCare HR Tool — SPA Application
 *
 * Manages PII locally. Only hashes leave this machine.
 * Tabs: Dashboard, Import, Employees, Enrollment Codes, Reconcile, Settings
 *
 * Council fixes applied:
 *   - Renamed "Tokens" → "Enrollment Codes" (UX)
 *   - Replaced crypto jargon with plain English (UX)
 *   - Show employee names in reconciliation report (UX)
 *   - CSV export injection fix: escape quotes per RFC 4180
 *   - Pipeline values escaped via esc()
 *   - Debounced search
 *   - CSV secure-delete warning after import
 *   - Session timeout handling (auto-lock overlay)
 *   - Health polling every 30s with cleanup
 */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const navLinks = document.querySelectorAll('.nav-link');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const unlockOverlay = document.getElementById('unlock-overlay');
  // Phase F8: new-group modal is removed. Guard against null in case the
  // modal element is still in the HTML (backward-compat with un-refreshed browsers).
  const newGroupModal = document.getElementById('new-group-modal');

  let currentPage = 'dashboard';
  let healthTimer = null;
  let searchDebounce = null;
  // Phase F3/F4: the active group within the unlocked workspace. Set by
  // the Group Selection Screen or by deep-linking; cleared on deselect.
  let activeGroup = null; // { groupId, planId, effectiveDate, enrollmentCap, isUnlimited, enrolledCount, pendingTokens, remainingSlots }
  // Guard flag to prevent re-entering the router during async rehydration
  let _rehydrating = false;

  // ─── API Client ───────────────────────────────────────────

  const API = {
    async call(method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!data.ok) {
        if (res.status === 401) { showLockScreen(); }
        throw new Error(data.error || 'Unknown error');
      }
      return data.data;
    },
    // Phase F3: unlock no longer takes groupId — one passphrase opens the
    // employer-keyed workspace. Groups are listed from the employer node.
    unlock(passphrase)        { return this.call('POST', '/api/unlock', { passphrase }); },
    lock()                    { return this.call('POST', '/api/lock'); },
    getSession()              { return this.call('GET', '/api/session'); },
    // Phase F3: listGroups now proxies to the employer node and returns
    // groups with stats inlined (used/cap/remainingSlots).
    listGroups()              { return this.call('GET', '/api/groups'); },
    // Phase F4: select a group as the active import context.
    selectGroup(groupId)      { return this.call('POST', '/api/group/select', { groupId }); },
    deselectGroup()           { return this.call('POST', '/api/group/deselect'); },
    getStats()                { return this.call('GET', '/api/stats'); },
    previewCsv(csvContent)    { return this.call('POST', '/api/csv/preview', { csvContent }); },
    importCsv(csvContent, validUntil, dryRun) {
      return this.call('POST', '/api/import', { csvContent, validUntil, dryRun });
    },
    listEmployees(status, search) {
      let q = '/api/employees';
      const params = [];
      if (status) params.push('status=' + encodeURIComponent(status));
      if (search) params.push('search=' + encodeURIComponent(search));
      if (params.length) q += '?' + params.join('&');
      return this.call('GET', q);
    },
    getEmployee(id) { return this.call('GET', '/api/employees/' + encodeURIComponent(id)); },
    reconcile()     { return this.call('POST', '/api/reconcile'); },
    exportTokens()  { return this.call('GET', '/api/export/tokens'); },
    employerHealth() { return this.call('GET', '/api/employer/health'); },
    employerPlans()  { return this.call('GET', '/api/employer/plans'); },
  };

  // ─── Helpers ──────────────────────────────────────────────

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

  function toast(msg, type) {
    type = type || 'info';
    const container = document.getElementById('toast-container');
    // Cap at 10 toasts
    while (container.children.length >= 10) container.removeChild(container.firstChild);
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function() { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(function() { el.remove(); }, 300); }, 4000);
  }

  function loading() { return '<div class="loading-row"><span class="spinner"></span> Loading...</div>'; }
  function emptyState(title, detail) {
    return '<div class="empty-state"><div class="empty-title">' + esc(title) + '</div>' +
      (detail ? '<div class="empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  function detailRow(label, value) {
    return '<div class="detail-row"><span class="detail-label">' + esc(label) +
      '</span><span class="detail-value mono">' + esc(String(value)) + '</span></div>';
  }

  function statCard(label, value, color, detail) {
    return '<div class="stat-card"><div class="stat-label">' + esc(label) +
      '</div><div class="stat-value ' + (color || '') + '">' + esc(String(value)) + '</div>' +
      (detail ? '<div class="stat-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  function badgeHtml(status) {
    var colors = { pending: 'yellow', token_generated: 'blue', enrolled: 'green', terminated: 'red' };
    var labels = { pending: 'Pending', token_generated: 'Code Issued', enrolled: 'Enrolled', terminated: 'Terminated' };
    return '<span class="badge ' + (colors[status] || 'yellow') + '">' + esc(labels[status] || status) + '</span>';
  }

  /** Escape a value for CSV output per RFC 4180 */
  function csvEscape(val) {
    var s = String(val);
    if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ─── Connection Status ────────────────────────────────────

  function setConnection(state) {
    statusDot.className = 'status-dot ' + state;
    statusLabel.textContent = state === 'connected' ? 'Node Online' : state === 'connecting' ? 'Checking...' : 'Node Offline';
  }

  async function checkEmployerNode() {
    setConnection('connecting');
    try {
      var data = await API.employerHealth();
      setConnection(data.online ? 'connected' : 'disconnected');
    } catch {
      setConnection('disconnected');
    }
  }

  function startHealthPolling() {
    stopHealthPolling();
    checkEmployerNode();
    healthTimer = setInterval(checkEmployerNode, 30000);
  }

  function stopHealthPolling() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  // ─── Lock Screen ──────────────────────────────────────────

  function showLockScreen() {
    stopHealthPolling();
    app.classList.add('hidden');
    unlockOverlay.classList.remove('hidden');
    activeGroup = null;
  }

  // ─── Unlock / Workspace Open ──────────────────────────────
  // Phase F3: single passphrase opens the employer-keyed workspace.
  // No groupId prompt — groups are picked from the Group Selection Screen
  // AFTER the workspace is unlocked.

  document.getElementById('btn-unlock').onclick = async function() {
    var passphrase = document.getElementById('unlock-passphrase').value;
    var errEl = document.getElementById('unlock-error');
    errEl.textContent = '';

    if (!passphrase) { errEl.textContent = 'Enter passphrase'; return; }
    if (passphrase.length < 8) { errEl.textContent = 'Passphrase must be at least 8 characters'; return; }

    try {
      var result = await API.unlock(passphrase);
      unlockOverlay.classList.add('hidden');
      app.classList.remove('hidden');
      startHealthPolling();
      if (result.workspace && result.workspace.firstRun) {
        toast('Workspace created for ' + result.workspace.employerNodeUrl, 'success');
      } else {
        toast('Workspace unlocked', 'success');
      }
      // After unlock, always land on the Group Selection Screen.
      navigate('groups');
    } catch (e) {
      errEl.textContent = e.message || 'Unlock failed — check your passphrase';
    }
  };

  document.getElementById('unlock-passphrase').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('btn-unlock').click();
  });

  // Phase F8: new-group modal handlers removed. Groups are created in the
  // Employer Dashboard; the HR Tool only imports into existing groups.
  // Legacy modal HTML (if still present in index.html) is hidden on load.
  if (newGroupModal) newGroupModal.classList.add('hidden');
  var btnNewGroup = document.getElementById('btn-new-group');
  if (btnNewGroup) btnNewGroup.style.display = 'none';

  // ─── Router ───────────────────────────────────────────────

  function navigate(page) {
    currentPage = page || 'dashboard';
    navLinks.forEach(function(l) { l.classList.toggle('active', l.dataset.tab === currentPage); });
    window.scrollTo(0, 0);
    renderPage();
  }

  window.addEventListener('hashchange', function() {
    var hash = location.hash.replace('#', '') || 'dashboard';
    navigate(hash);
  });

  function renderPage() {
    // Phase F4: most pages require an active group. If the user deep-links
    // to a group-scoped page without selecting one, bounce them to the
    // Group Selection Screen with a toast.
    var groupScopedPages = ['dashboard', 'import', 'employees', 'tokens', 'reconcile'];
    if (groupScopedPages.includes(currentPage) && !activeGroup && !_rehydrating) {
      _rehydrating = true;
      // Check server-side session — we may have lost local activeGroup state
      // but the server still holds it (e.g. page refresh).
      API.getSession().then(async function(sess) {
        if (sess && sess.groupSelected && sess.groupId) {
          // Rehydrate local state from the server session, then fetch the
          // utilization stats so the banner shows correct counts.
          activeGroup = {
            groupId: sess.groupId,
            planId: sess.planId,
          };
          await hydrateActiveGroupStats();
          _rehydrating = false;
          renderPage();
        } else {
          _rehydrating = false;
          toast('Select a group first', 'info');
          navigate('groups');
        }
      }).catch(function() {
        _rehydrating = false;
        navigate('groups');
      });
      return;
    }

    switch (currentPage) {
      case 'groups': renderGroupSelection(); break;
      case 'dashboard': renderDashboard(); break;
      case 'import': renderImport(); break;
      case 'employees': renderEmployees(); break;
      case 'tokens': renderTokens(); break;
      case 'reconcile': renderReconcile(); break;
      case 'settings': renderSettings(); break;
      default: renderGroupSelection();
    }
  }

  // ════════════════════════════════════════════════════════════
  //  GROUP SELECTION SCREEN (Phase F4)
  // ════════════════════════════════════════════════════════════

  async function renderGroupSelection() {
    app.innerHTML =
      '<div class="section-header"><div><div class="section-title">Select a Group</div>' +
        '<div class="section-subtitle">Groups are created in the Employer Dashboard. Pick the group you want to import employees into.</div></div></div>' +
      (activeGroup ? '<div class="info-banner security" style="margin-bottom:12px">Currently working in: <strong>' + esc(activeGroup.groupId) + '</strong> (plan: ' + esc(activeGroup.planId || '--') + ') &nbsp;&nbsp; <button class="btn sm" id="btn-deselect-group">Switch Group</button></div>' : '') +
      '<div class="info-banner warning" style="margin-bottom:12px">' +
        'The HR Tool does not create groups. To add a new group, open the <strong>Employer Dashboard</strong> (Groups tab) and create it there, then refresh this screen.' +
      '</div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Available Groups</span>' +
        '<button class="btn sm" id="btn-refresh-groups">Refresh</button></div>' +
        '<div class="panel-body no-pad" id="group-list">' + loading() + '</div></div>';

    var refreshBtn = document.getElementById('btn-refresh-groups');
    if (refreshBtn) refreshBtn.onclick = loadGroupSelectionList;
    var deselectBtn = document.getElementById('btn-deselect-group');
    if (deselectBtn) deselectBtn.onclick = async function() {
      try { await API.deselectGroup(); } catch (_) { /* ignore */ }
      activeGroup = null;
      renderGroupSelection();
    };

    loadGroupSelectionList();
  }

  async function loadGroupSelectionList() {
    var el = document.getElementById('group-list');
    if (!el) return;
    el.innerHTML = loading();
    try {
      var data = await API.listGroups();
      var groups = data.groups || [];
      if (groups.length === 0) {
        el.innerHTML = emptyState('No groups yet', 'Create a group in the Employer Dashboard first — then click Refresh here');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Group ID</th><th>Plan</th><th>Effective Date</th><th>Utilization</th><th>Local State</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
        groups.map(function(g) {
          var gid = g.groupId || '--';
          var status = g.status || 'active';
          var statusBadge = '<span class="badge ' + (status === 'active' ? 'green' : 'red') + '">' + esc(status) + '</span>';
          var cap = g.enrollmentCap || 0;
          var used = (g.enrolledCount || 0) + (g.pendingTokens || 0);
          var capDisplay = g.isUnlimited || cap === 0 ? (used + ' (unlimited)') : (used + ' / ' + cap);
          var local = g.hasLocalState
            ? '<span style="color:var(--green)">Seed ready</span>' + (g.localEntryCount ? ' (' + g.localEntryCount + ' employees)' : '')
            : '<span style="color:var(--text-muted)">Not initialized</span>';
          var action = status === 'active'
            ? '<button class="btn sm primary btn-select-group" data-gid="' + esc(gid) + '">' + (g.hasLocalState ? 'Select' : 'Initialize &amp; Select') + '</button>'
            : '<button class="btn sm" disabled>Terminated</button>';
          return '<tr><td class="mono">' + esc(gid) + '</td>' +
            '<td class="mono">' + esc(g.planId || '--') + '</td>' +
            '<td>' + esc(g.effectiveDate || '--').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + '</td>' +
            '<td style="font-variant-numeric:tabular-nums">' + capDisplay + '</td>' +
            '<td>' + local + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td>' + action + '</td></tr>';
        }).join('') + '</tbody></table></div>';

      el.querySelectorAll('.btn-select-group').forEach(function(btn) {
        btn.onclick = async function() {
          var gid = btn.dataset.gid;
          btn.disabled = true;
          btn.textContent = 'Selecting...';
          try {
            var result = await API.selectGroup(gid);
            activeGroup = {
              groupId: result.groupId,
              planId: result.planId,
              effectiveDate: result.effectiveDate,
              enrollmentCap: result.enrollmentCap,
              isUnlimited: result.isUnlimited,
              enrolledCount: result.enrolledCount,
              pendingTokens: result.pendingTokens,
              remainingSlots: result.remainingSlots,
            };
            if (result.firstSelect) {
              toast('First import into ' + gid + ' — hash seed generated and encrypted locally', 'success');
            } else {
              toast('Working in group: ' + gid, 'success');
            }
            navigate('dashboard');
          } catch (e) {
            toast('Failed to select group: ' + e.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Select';
          }
        };
      });
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Could not load groups: ' + esc(e.message) + '<br><span style="font-size:12px">The employer node may be offline, or the workspace may need to be re-unlocked.</span></div>';
    }
  }

  // ════════════════════════════════════════════════════════════
  //  DASHBOARD
  // ════════════════════════════════════════════════════════════

  async function renderDashboard() {
    app.innerHTML =
      '<div class="section-header"><div><div class="section-title">Dashboard</div>' +
        '<div class="section-subtitle" id="dash-group-label"></div></div></div>' +
      activeGroupBanner() +
      '<div class="info-banner security">Employee names and personal data never leave this computer. Only anonymous identifiers are sent to the enrollment system.</div>' +
      '<div class="stats-grid" id="dash-stats">' + loading() + '</div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Enrollment Progress</span></div>' +
        '<div class="pipeline" id="dash-pipeline">' + loading() + '</div></div>' +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Recent Employees</span></div>' +
          '<div class="panel-body no-pad" id="dash-recent">' + loading() + '</div></div>' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Quick Actions</span></div>' +
          '<div class="panel-body" id="dash-actions"></div></div>' +
      '</div>';

    loadDashStats();
    loadDashRecent();
    renderQuickActions();
  }

  async function loadDashStats() {
    var grid = document.getElementById('dash-stats');
    var groupLabel = document.getElementById('dash-group-label');
    var pipeline = document.getElementById('dash-pipeline');
    if (!grid) return;

    try {
      var stats = await API.getStats();
      var session = await API.getSession();
      if (groupLabel) groupLabel.textContent = 'Group: ' + (session.groupId || '--') + '  /  Plan: ' + (session.planId || '--');

      grid.innerHTML =
        statCard('Total Employees', stats.total, 'accent') +
        statCard('Pending', stats.pending, 'yellow') +
        statCard('Codes Issued', stats.issued, 'blue') +
        statCard('Enrolled', stats.enrolled, 'green') +
        statCard('Terminated', stats.terminated, 'red') +
        statCard('Employer Node', stats.employerNodeOnline ? 'Online' : 'Offline', stats.employerNodeOnline ? 'green' : 'red');

      if (pipeline) {
        pipeline.innerHTML =
          '<div class="pipeline-stage"><div class="pipeline-count pending">' + esc(stats.pending) + '</div><div class="pipeline-label">Pending</div></div>' +
          '<div class="pipeline-stage"><div class="pipeline-count issued">' + esc(stats.issued) + '</div><div class="pipeline-label">Code Issued</div></div>' +
          '<div class="pipeline-stage"><div class="pipeline-count enrolled">' + esc(stats.enrolled) + '</div><div class="pipeline-label">Enrolled</div></div>' +
          '<div class="pipeline-stage"><div class="pipeline-count terminated">' + esc(stats.terminated) + '</div><div class="pipeline-label">Terminated</div></div>';
      }
    } catch (e) {
      grid.innerHTML = statCard('Error', e.message, 'red');
    }
  }

  async function loadDashRecent() {
    var el = document.getElementById('dash-recent');
    if (!el) return;
    try {
      var data = await API.listEmployees();
      var entries = data.entries || [];
      var recent = entries.slice(-5).reverse();
      if (recent.length === 0) {
        el.innerHTML = emptyState('No employees yet', 'Import a CSV roster to get started');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Name</th><th>Employee ID</th><th>Status</th></tr></thead><tbody>' +
        recent.map(function(e) {
          return '<tr><td>' + esc(e.firstName + ' ' + e.lastName) + '</td>' +
          '<td class="mono">' + esc(e.employeeId) + '</td>' +
          '<td>' + badgeHtml(e.status) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">' + esc(e.message) + '</div>';
    }
  }

  function renderQuickActions() {
    var el = document.getElementById('dash-actions');
    if (!el) return;
    el.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<button class="btn primary full-width" onclick="location.hash=\'import\'">Import Employee Roster</button>' +
        '<button class="btn full-width" onclick="location.hash=\'employees\'">View All Employees</button>' +
        '<button class="btn full-width" onclick="location.hash=\'reconcile\'">Check Enrollment Status</button>' +
        '<button class="btn full-width" onclick="location.hash=\'tokens\'">Export Enrollment Codes</button>' +
      '</div>';
  }

  // ════════════════════════════════════════════════════════════
  //  IMPORT
  // ════════════════════════════════════════════════════════════

  var pendingCsvContent = null;

  // Phase F4: hydrate activeGroup with utilization stats from the employer node.
  // Used after session rehydration (page refresh) so the banner shows correct counts.
  async function hydrateActiveGroupStats() {
    if (!activeGroup || !activeGroup.groupId) return;
    try {
      var data = await API.listGroups();
      var groups = data.groups || [];
      var match = groups.find(function(g) { return g.groupId === activeGroup.groupId; });
      if (match) {
        activeGroup.planId = match.planId;
        activeGroup.effectiveDate = match.effectiveDate;
        activeGroup.enrollmentCap = match.enrollmentCap;
        activeGroup.isUnlimited = match.isUnlimited === true || match.enrollmentCap === 0;
        activeGroup.enrolledCount = match.enrolledCount || 0;
        activeGroup.pendingTokens = match.pendingTokens || 0;
        activeGroup.remainingSlots = match.remainingSlots || 0;
      }
    } catch { /* silent — banner will just show dashes */ }
  }

  // Phase F4/F5: render a banner showing the active group context. Used on
  // Import, Dashboard, Employees, Tokens, and Reconcile tabs so the user
  // always knows which group they're operating on.
  function activeGroupBanner() {
    if (!activeGroup) return '';
    var cap = activeGroup.enrollmentCap || 0;
    var used = (activeGroup.enrolledCount || 0) + (activeGroup.pendingTokens || 0);
    var capDisplay = activeGroup.isUnlimited || cap === 0
      ? (used + ' (unlimited)')
      : (used + ' / ' + cap);
    return '<div class="info-banner security" style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px">' +
      '<div>Working in group: <strong>' + esc(activeGroup.groupId) + '</strong> &nbsp; Plan: <strong>' + esc(activeGroup.planId || '--') + '</strong> &nbsp; Utilization: <strong>' + capDisplay + '</strong></div>' +
      '<button class="btn sm" onclick="location.hash=\'groups\'">Switch Group</button>' +
      '</div>';
  }

  async function renderImport() {
    pendingCsvContent = null;
    app.innerHTML =
      '<div class="section-header"><div><div class="section-title">Import Roster</div>' +
        '<div class="section-subtitle">Upload a CSV file with employee data. Personal information is processed locally and never sent over the network.</div></div></div>' +
      activeGroupBanner() +
      '<div class="info-banner warning">CSV columns required: <span class="code">employee_id</span>, <span class="code">family_id</span>, <span class="code">first_name</span>, <span class="code">last_name</span>, <span class="code">dob</span>. Optional: <span class="code">email</span>.</div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Step 1: Select CSV File</span></div><div class="panel-body">' +
        '<div class="drop-zone" id="csv-drop-zone">' +
          '<div class="drop-zone-icon">&#128196;</div>' +
          '<div class="drop-zone-text">Drop CSV file here or click to browse</div>' +
          '<div class="drop-zone-hint">Accepts .csv files</div>' +
          '<input type="file" accept=".csv" id="csv-file-input">' +
        '</div>' +
      '</div></div>' +
      '<div id="csv-preview-panel" style="display:none"></div>' +
      '<div id="csv-import-panel" style="display:none"></div>' +
      '<div id="csv-results-panel" style="display:none"></div>';

    setupDropZone();
  }

  function setupDropZone() {
    var zone = document.getElementById('csv-drop-zone');
    var input = document.getElementById('csv-file-input');
    zone.onclick = function() { input.click(); };
    zone.ondragover = function(e) { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = function() { zone.classList.remove('drag-over'); };
    zone.ondrop = function(e) { e.preventDefault(); zone.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); };
    input.onchange = function() { if (input.files[0]) handleFile(input.files[0]); };
  }

  function handleFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.csv')) { toast('Please select a .csv file', 'error'); return; }
    var reader = new FileReader();
    reader.onload = async function(e) {
      pendingCsvContent = e.target.result;
      try {
        var data = await API.previewCsv(pendingCsvContent);
        showCsvPreview(data, file.name);
      } catch (err) {
        toast('Could not read CSV: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  function showCsvPreview(data, filename) {
    var panel = document.getElementById('csv-preview-panel');
    panel.style.display = 'block';

    var rows = data.preview || [];
    panel.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Step 2: Preview (' + esc(data.count) + ' employees from ' + esc(filename) + ')</span></div>' +
      '<div class="panel-body no-pad"><div class="csv-preview"><table class="data-table"><thead><tr>' +
      '<th>Employee ID</th><th>Family ID</th><th>First Name</th><th>Last Name</th><th>DOB</th><th>Email</th></tr></thead><tbody>' +
      rows.map(function(r) {
        return '<tr><td class="mono">' + esc(r.employeeId) + '</td>' +
        '<td class="mono">' + esc(r.familyId) + '</td>' +
        '<td>' + esc(r.firstName) + '</td>' +
        '<td>' + esc(r.lastName) + '</td>' +
        '<td>' + esc(r.dob) + '</td>' +
        '<td>' + esc(r.email || '--') + '</td></tr>';
      }).join('') +
      (data.count > 10 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">... and ' + esc(data.count - 10) + ' more rows</td></tr>' : '') +
      '</tbody></table></div></div></div>';

    var importPanel = document.getElementById('csv-import-panel');
    importPanel.style.display = 'block';
    importPanel.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Step 3: Generate Enrollment Codes</span></div><div class="panel-body">' +
      '<div class="form-grid">' +
        '<div class="form-group"><label for="imp-valid-until">Code Expiration Date</label>' +
          '<input type="date" id="imp-valid-until" value="' + defaultExpiry() + '"></div>' +
      '</div>' +
      '<div class="form-actions" style="margin-top:16px">' +
        '<button class="btn" id="btn-dry-run">Preview (No Changes)</button>' +
        '<button class="btn primary" id="btn-import-go">Import &amp; Generate Codes</button>' +
      '</div></div></div>';

    document.getElementById('btn-dry-run').onclick = function() { doImport(true); };
    document.getElementById('btn-import-go').onclick = function() { doImport(false); };
  }

  function defaultExpiry() {
    var d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }

  async function doImport(dryRun) {
    if (!pendingCsvContent) { toast('No CSV loaded', 'error'); return; }
    var validUntil = document.getElementById('imp-valid-until').value;
    if (!validUntil) { toast('Set an expiration date', 'error'); return; }

    var resultsPanel = document.getElementById('csv-results-panel');
    resultsPanel.style.display = 'block';
    resultsPanel.innerHTML = '<div class="panel"><div class="panel-body">' + loading() + '</div></div>';

    try {
      var data = await API.importCsv(pendingCsvContent, validUntil, dryRun);

      if (dryRun) {
        resultsPanel.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Preview Results</span></div><div class="panel-body">' +
          '<div class="stats-grid">' +
            statCard('Total in CSV', data.total, '') +
            statCard('New Employees', data.newEntries, 'blue') +
            statCard('Already Imported', data.skipped, 'yellow') +
          '</div>' +
          (data.preview && data.preview.length > 0 ?
            '<div class="table-wrap" style="margin-top:16px"><table class="data-table"><thead><tr>' +
            '<th>Employee ID</th><th>Name</th><th>Identifier (preview)</th></tr></thead><tbody>' +
            data.preview.map(function(p) {
              return '<tr><td class="mono">' + esc(p.employeeId) + '</td>' +
              '<td>' + esc(p.name) + '</td>' +
              '<td class="mono">' + esc(p.employeeIdHash) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : '') +
          '</div></div>';
        toast('Preview complete — no changes made', 'info');
      } else {
        var pct = data.processed > 0 ? Math.round((data.success / data.processed) * 100) : 0;
        resultsPanel.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Import Results</span></div><div class="panel-body">' +
          '<div class="stats-grid">' +
            statCard('Processed', data.processed, '') +
            statCard('Success', data.success, 'green') +
            statCard('Failed', data.failed, data.failed > 0 ? 'red' : '') +
            statCard('Already Imported', data.skipped, 'yellow') +
          '</div>' +
          '<div class="progress-bar" style="margin-top:16px"><div class="progress-fill green" style="width:' + pct + '%"></div></div>' +
          '<div style="text-align:center;margin-top:8px;font-size:12px;color:var(--text-muted)">' + esc(pct) + '% success rate</div>' +
          (data.csvWarning ? '<div class="info-banner warning" style="margin-top:16px">' + esc(data.csvWarning) + '</div>' : '') +
          (data.results && data.results.some(function(r) { return r.status === 'error'; }) ?
            '<div style="margin-top:16px"><div class="recon-section-title recon-danger">Failed — Will Retry on Next Import</div>' +
            data.results.filter(function(r) { return r.status === 'error'; }).map(function(r) {
              return '<div style="padding:4px 0;font-size:12px"><span class="mono">' + esc(r.employeeId) + '</span>: <span style="color:var(--red)">' + esc(r.error) + '</span></div>';
            }).join('') + '</div>' : '') +
          '</div></div>';
        toast(data.success + ' enrollment codes generated', 'success');
      }
    } catch (e) {
      resultsPanel.innerHTML = '<div class="error-banner">' + esc(e.message) + '</div>';
      toast('Import failed: ' + e.message, 'error');
    }
  }

  // ════════════════════════════════════════════════════════════
  //  EMPLOYEES
  // ════════════════════════════════════════════════════════════

  async function renderEmployees() {
    app.innerHTML =
      '<div class="section-header"><div class="section-title">Employees</div></div>' +
      activeGroupBanner() +
      '<div class="search-bar">' +
        '<input type="text" id="emp-search" placeholder="Search by name, ID, or email...">' +
        '<select id="emp-filter"><option value="">All Statuses</option><option value="pending">Pending</option><option value="token_generated">Code Issued</option><option value="enrolled">Enrolled</option><option value="terminated">Terminated</option></select>' +
        '<button class="btn sm" id="btn-emp-search">Search</button>' +
      '</div>' +
      '<div class="panel"><div class="panel-body no-pad" id="emp-table">' + loading() + '</div></div>' +
      '<div id="emp-detail" style="display:none"></div>';

    document.getElementById('btn-emp-search').onclick = loadEmployeeTable;
    document.getElementById('emp-search').addEventListener('input', function() {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(loadEmployeeTable, 300);
    });
    document.getElementById('emp-filter').onchange = loadEmployeeTable;
    loadEmployeeTable();
  }

  async function loadEmployeeTable() {
    var el = document.getElementById('emp-table');
    if (!el) return;
    el.innerHTML = loading();
    var search = document.getElementById('emp-search').value.trim();
    var status = document.getElementById('emp-filter').value;

    try {
      var data = await API.listEmployees(status, search);
      var entries = data.entries || [];
      if (entries.length === 0) {
        el.innerHTML = emptyState('No employees found', search ? 'Try a different search term' : 'Import a CSV roster to add employees');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Name</th><th>Employee ID</th><th>Family ID</th><th>DOB</th><th>Email</th><th>Status</th><th>Code</th></tr></thead><tbody>' +
        entries.map(function(e) {
          return '<tr class="emp-row" data-id="' + esc(e.employeeId) + '" style="cursor:pointer">' +
          '<td>' + esc(e.firstName + ' ' + e.lastName) + '</td>' +
          '<td class="mono">' + esc(e.employeeId) + '</td>' +
          '<td class="mono">' + esc(e.familyId) + '</td>' +
          '<td>' + esc(e.dob) + '</td>' +
          '<td>' + esc(e.email || '--') + '</td>' +
          '<td>' + badgeHtml(e.status) + '</td>' +
          '<td class="mono truncate" title="' + esc(e.tokenId || '') + '">' + esc(truncHash(e.tokenId, 16)) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>';

      el.querySelectorAll('.emp-row').forEach(function(row) {
        row.onclick = function() { showEmployeeDetail(row.dataset.id); };
      });
    } catch (e) {
      el.innerHTML = '<div class="error-banner">' + esc(e.message) + '</div>';
    }
  }

  async function showEmployeeDetail(employeeId) {
    var el = document.getElementById('emp-detail');
    el.style.display = 'block';
    el.innerHTML = '<div class="panel"><div class="panel-body">' + loading() + '</div></div>';
    try {
      var e = await API.getEmployee(employeeId);
      el.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Employee Detail</span>' +
        '<button class="btn sm" id="btn-close-detail">Close</button></div><div class="panel-body">' +
        '<div class="detail-grid"><div>' +
          detailRow('Employee ID', e.employeeId) +
          detailRow('Family ID', e.familyId) +
          detailRow('Name', e.firstName + ' ' + e.lastName) +
          detailRow('Date of Birth', e.dob) +
          detailRow('Email', e.email || '--') +
          detailRow('Status', e.status) +
          detailRow('Enrollment Code', e.tokenId || 'Not yet issued') +
          detailRow('Added', e.createdAt) +
        '</div></div></div></div>';
      document.getElementById('btn-close-detail').onclick = function() { el.style.display = 'none'; };
      el.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      el.innerHTML = '<div class="error-banner">' + esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════
  //  ENROLLMENT CODES (was "TOKENS")
  // ════════════════════════════════════════════════════════════

  async function renderTokens() {
    app.innerHTML =
      '<div class="section-header"><div><div class="section-title">Enrollment Codes</div>' +
        '<div class="section-subtitle">Each employee needs TWO things to enroll: their enrollment code AND their PIN.</div></div></div>' +
      activeGroupBanner() +
      '<div class="info-banner warning">Distribute the enrollment code via portal or sealed letter. Send the PIN separately via SMS to the employee\'s personal phone. Never send both through the same channel.</div>' +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Channel A: Enrollment Codes</span>' +
          '<button class="btn sm primary" id="btn-export-codes">Download Codes CSV</button></div>' +
          '<div class="panel-body no-pad" id="codes-table">' + loading() + '</div></div>' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Channel B: PINs (SMS)</span>' +
          '<button class="btn sm" id="btn-export-pins">Download PINs CSV</button></div>' +
          '<div class="panel-body no-pad" id="pins-table">' + loading() + '</div></div>' +
      '</div>';

    document.getElementById('btn-export-codes').onclick = function() { doExportCsv('codes'); };
    document.getElementById('btn-export-pins').onclick = function() { doExportCsv('pins'); };
    loadTokenTable();
  }

  async function loadTokenTable() {
    var codesEl = document.getElementById('codes-table');
    var pinsEl = document.getElementById('pins-table');
    if (!codesEl || !pinsEl) return;
    try {
      var data = await API.exportTokens();
      var tokens = data.tokens || [];
      if (tokens.length === 0) {
        var empty = emptyState('No enrollment codes yet', 'Import a CSV roster and generate codes first');
        codesEl.innerHTML = empty;
        pinsEl.innerHTML = empty;
        return;
      }
      // Channel A: Codes (for portal / sealed letter)
      codesEl.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Employee</th><th>Enrollment Code</th></tr></thead><tbody>' +
        tokens.map(function(t) {
          return '<tr><td>' + esc(t.displayName) + '</td>' +
          '<td class="mono">' + esc(t.tokenId) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      // Channel B: PINs (for SMS)
      pinsEl.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Employee</th><th>PIN</th></tr></thead><tbody>' +
        tokens.map(function(t) {
          return '<tr><td>' + esc(t.displayName) + '</td>' +
          '<td class="mono" style="font-size:16px;letter-spacing:2px">' + esc(t.tokenPIN || '--') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } catch (e) {
      codesEl.innerHTML = '<div class="error-banner">' + esc(e.message) + '</div>';
      pinsEl.innerHTML = '<div class="error-banner">' + esc(e.message) + '</div>';
    }
  }

  function doExportCsv(type) {
    API.exportTokens().then(function(data) {
      var tokens = data.tokens || [];
      if (tokens.length === 0) { toast('No codes to export', 'info'); return; }
      var csv, filename;
      if (type === 'pins') {
        csv = 'Name,PIN\n' + tokens.map(function(t) {
          return csvEscape(t.displayName) + ',' + csvEscape(t.tokenPIN || '');
        }).join('\n');
        filename = 'enrollment-pins-SMS.csv';
      } else {
        csv = 'Name,EnrollmentCode\n' + tokens.map(function(t) {
          return csvEscape(t.displayName) + ',' + csvEscape(t.tokenId);
        }).join('\n');
        filename = 'enrollment-codes.csv';
      }
      var blob = new Blob([csv], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      toast('CSV downloaded — ' + (type === 'pins' ? 'send PINs via SMS only' : 'distribute codes via portal or sealed letter'), 'info');
    }).catch(function(e) { toast('Export failed: ' + e.message, 'error'); });
  }

  // ════════════════════════════════════════════════════════════
  //  RECONCILE
  // ════════════════════════════════════════════════════════════

  async function renderReconcile() {
    app.innerHTML =
      '<div class="section-header"><div><div class="section-title">Enrollment Check</div>' +
        '<div class="section-subtitle">Compare your employee list with the enrollment system to find discrepancies.</div></div></div>' +
      activeGroupBanner() +
      '<div class="info-banner info">This compares every employee individually — not just counts. It will detect if someone was enrolled who shouldn\'t be, or if an employee is missing from the system.</div>' +
      '<div class="panel"><div class="panel-body" style="text-align:center;padding:32px">' +
        '<p style="margin-bottom:16px;color:var(--text-secondary)">This will connect to the employer node and compare enrollment records.</p>' +
        '<button class="btn primary" id="btn-reconcile">Run Enrollment Check</button>' +
      '</div></div>' +
      '<div id="recon-results" style="display:none"></div>';

    document.getElementById('btn-reconcile').onclick = doReconcile;
  }

  async function doReconcile() {
    var el = document.getElementById('recon-results');
    el.style.display = 'block';
    el.innerHTML = '<div class="panel"><div class="panel-body">' + loading() + '</div></div>';

    try {
      var r = await API.reconcile();

      var allOk = r.missingFromNode.length === 0 && r.unknownOnNode.length === 0 && r.statusMismatches.length === 0;
      var missingDetail = r.missingFromNodeDetail || [];
      var unknownDetail = r.unknownOnNodeDetail || [];
      var mismatchDetail = r.statusMismatchDetail || r.statusMismatches || [];

      el.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Enrollment Check Report</span></div><div class="panel-body">' +
        '<div class="stats-grid">' +
          statCard('Your Employees', r.totalLocal, '') +
          statCard('On System', r.totalNode, '') +
          statCard('Matched', r.matched, 'green') +
          statCard('Status Synced', r.synced || 0, r.synced > 0 ? 'blue' : '') +
        '</div>' +

        (allOk ?
          '<div class="success-banner" style="margin-top:16px">All employees match. No discrepancies found.</div>' :
          '<div style="margin-top:20px">' +
            (missingDetail.length > 0 ?
              '<div class="recon-section"><div class="recon-section-title recon-warn">' + esc(missingDetail.length) + ' employees not yet in the enrollment system</div>' +
              '<table class="data-table"><thead><tr><th>Name</th><th>Employee ID</th></tr></thead><tbody>' +
              missingDetail.map(function(d) {
                return '<tr><td>' + esc(d.name) + '</td><td class="mono">' + esc(d.employeeId || truncHash(d.hash, 16)) + '</td></tr>';
              }).join('') + '</tbody></table></div>' : '') +
            (unknownDetail.length > 0 ?
              '<div class="recon-section"><div class="recon-section-title recon-danger">' + esc(unknownDetail.length) + ' unknown entries found in enrollment system</div>' +
              '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">These entries exist on the employer node but are not in your roster. This could indicate unauthorized enrollment.</p>' +
              unknownDetail.map(function(d) {
                return '<div style="padding:2px 0;font-size:12px;font-family:var(--font-mono)">' + esc(truncHash(d.hash, 24)) + '</div>';
              }).join('') + '</div>' : '') +
            (mismatchDetail.length > 0 ?
              '<div class="recon-section"><div class="recon-section-title recon-warn">' + esc(mismatchDetail.length) + ' status differences</div>' +
              '<table class="data-table"><thead><tr><th>Employee</th><th>Your Records</th><th>System Status</th></tr></thead><tbody>' +
              mismatchDetail.map(function(m) {
                return '<tr><td>' + esc(m.name || m.employeeId || truncHash(m.employeeIdHash, 16)) + '</td>' +
                '<td>' + badgeHtml(m.localStatus) + '</td>' +
                '<td><span class="badge blue">' + esc(m.nodeStatus) + '</span></td></tr>';
              }).join('') + '</tbody></table></div>' : '') +
          '</div>'
        ) +

        '</div></div>';

      toast(allOk ? 'All employees verified' : 'Enrollment check complete — see report', allOk ? 'success' : 'info');
    } catch (e) {
      el.innerHTML = '<div class="panel"><div class="panel-body"><div class="error-banner">' + esc(e.message) + '</div></div></div>';
      toast('Could not connect to employer node', 'error');
    }
  }

  // ════════════════════════════════════════════════════════════
  //  SETTINGS
  // ════════════════════════════════════════════════════════════

  async function renderSettings() {
    var session;
    try { session = await API.getSession(); } catch { session = { workspaceActive: false }; }

    app.innerHTML =
      '<div class="section-header"><div class="section-title">Settings</div></div>' +
      activeGroupBanner() +
      '<div class="settings-section"><h3>Workspace</h3>' +
        '<div class="panel"><div class="panel-body">' +
          '<div class="detail-grid"><div>' +
            detailRow('Employer Node', session.employerNodeUrl || 'None') +
            detailRow('Active Group', session.groupSelected ? session.groupId : '(none selected)') +
            detailRow('Plan (current group)', session.planId || '--') +
            detailRow('Employees (current group)', String(session.entryCount || 0)) +
            detailRow('Auth Mode', session.authMode || 'none') +
          '</div></div>' +
          '<div class="info-banner info" style="margin-top:12px">Your session will automatically lock after 15 minutes of inactivity.</div>' +
          '<div class="form-actions" style="margin-top:16px;gap:8px">' +
            '<button class="btn" onclick="location.hash=\'groups\'">Switch Group</button>' +
            '<button class="btn danger" id="btn-lock">Lock Workspace</button>' +
          '</div>' +
        '</div></div></div>' +

      '<div class="settings-section"><h3>Employer Node</h3>' +
        '<div class="panel"><div class="panel-body" id="settings-node">' + loading() + '</div></div></div>' +

      '<div class="settings-section"><h3>How It Works</h3>' +
        '<div class="panel"><div class="panel-body">' +
          '<div class="info-banner security" style="margin-bottom:12px">' +
            'This tool keeps all employee names and personal data encrypted on your computer. ' +
            'When you import a roster, each employee gets a unique anonymous identifier (like a fingerprint ' +
            'that can\'t be reversed). Only these identifiers are sent to the enrollment system. ' +
            'If you lose your passphrase, the connection between identifiers and employee names ' +
            'cannot be recovered.' +
          '</div>' +
          '<div style="font-size:13px;color:var(--text-secondary);line-height:1.6">' +
            '<strong>Groups are managed in the Employer Dashboard.</strong> This HR Tool is a secure workstation for importing employees ' +
            'into groups that already exist. To create a new group, open the Employer Dashboard, go to the Groups tab, and create it there. ' +
            'Then come back here and click Refresh on the Groups tab to see the new group.' +
          '</div>' +
        '</div></div></div>';

    document.getElementById('btn-lock').onclick = async function() {
      try {
        await API.lock();
        toast('Workspace locked', 'info');
        showLockScreen();
      } catch (e) { toast('Lock failed: ' + e.message, 'error'); }
    };

    loadSettingsNode();
  }

  async function loadSettingsNode() {
    var el = document.getElementById('settings-node');
    if (!el) return;
    try {
      var data = await API.employerHealth();
      if (data.online) {
        var info = data.data || {};
        el.innerHTML = '<div class="detail-grid"><div>' +
          detailRow('Status', 'Online') +
          detailRow('Role', info.role || '--') +
          detailRow('Phase', info.phase || '--') +
          detailRow('Display Name', info.displayName || '--') +
          detailRow('Sequencer', info.sequencerConnected ? 'Connected' : 'Disconnected') +
          '</div></div>';
      } else {
        el.innerHTML = '<div class="error-banner">Employer node is not running. Start it to enable enrollment.</div>';
      }
    } catch (e) {
      el.innerHTML = '<div class="error-banner">' + esc(e.message) + '</div>';
    }
  }

  // ─── Init ─────────────────────────────────────────────────

  async function init() {
    try {
      var session = await API.getSession();
      if (session.workspaceActive) {
        // Workspace is already unlocked server-side — skip the passphrase prompt.
        unlockOverlay.classList.add('hidden');
        app.classList.remove('hidden');
        startHealthPolling();
        if (session.groupSelected) {
          activeGroup = {
            groupId: session.groupId,
            planId: session.planId,
          };
          // Fetch utilization stats for the banner before navigating
          await hydrateActiveGroupStats();
          var hash = location.hash.replace('#', '') || 'dashboard';
          navigate(hash);
        } else {
          navigate('groups');
        }
        return;
      }
    } catch { /* no session */ }
    // Fall through to showing the unlock overlay (default HTML state).
  }

  init();
})();
