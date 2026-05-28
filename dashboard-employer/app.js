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
 * Adjuda-GATOR Employer — SPA Application
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
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  // ---- Connection Status ----
  function setConnectionStatus(state) {
    statusDot.className = 'status-dot ' + state;
    statusLabel.textContent = state === 'connected' ? 'Connected' :
      state === 'connecting' ? 'Connecting...' : 'Disconnected';
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
    try {
      return new Date(val).toLocaleString();
    } catch {
      return String(val);
    }
  }

  function fmtDateShort(val) {
    if (!val) return '--';
    try {
      return new Date(val).toLocaleDateString();
    } catch {
      return String(val);
    }
  }

  function loading() {
    return '<div class="loading-row"><span class="spinner"></span> Loading...</div>';
  }

  function emptyState(title, detail) {
    return '<div class="empty-state"><div class="empty-title">' + esc(title) + '</div>' +
      (detail ? '<div class="empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  // ---- Router ----
  function navigate(page) {
    currentPage = page || 'overview';
    navLinks.forEach(l => {
      l.classList.toggle('active', l.dataset.tab === currentPage);
    });
    clearInterval(refreshTimer);
    renderPage();
  }

  window.addEventListener('hashchange', () => {
    const hash = location.hash.replace('#', '') || 'overview';
    navigate(hash);
  });

  // ---- Page Renderers ----

  function renderPage() {
    switch (currentPage) {
      case 'overview': renderOverview(); break;
      case 'groups': renderGroups(); break;
      case 'roster': renderRoster(); break;
      case 'messaging': renderMessaging(); break;
      case 'admin': renderAdmin(); break;
      default: renderOverview();
    }
  }

  // ==== OVERVIEW ====
  async function renderOverview() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Overview</div></div>' +
      '<div class="stats-grid" id="ov-stats">' + loading() + '</div>' +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Onboarding Status</span></div><div class="panel-body" id="ov-onboard">' + loading() + '</div></div>' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Live Events</span><span id="ov-event-count" style="font-size:11px;color:var(--text-muted)"></span></div><div class="events-log" id="ov-events">' + emptyState('No events yet', 'Events appear as they arrive via SSE') + '</div></div>' +
      '</div>';

    loadOverviewStats();
    loadOnboardingStatus();
    renderEventLog();

    refreshTimer = setInterval(() => {
      loadOverviewStats();
    }, 30000);
  }

  async function loadOverviewStats() {
    const grid = document.getElementById('ov-stats');
    if (!grid) return;
    try {
      const [groups, roster, health] = await Promise.allSettled([
        API.listGroups(),
        API.listRoster(),
        API.getHealth(),
      ]);

      const groupCount = groups.status === 'fulfilled' && Array.isArray(groups.value) ? groups.value.length : (groups.status === 'fulfilled' && groups.value && groups.value.groups ? groups.value.groups.length : '--');
      const rosterEntries = roster.status === 'fulfilled' ? (Array.isArray(roster.value) ? roster.value : (roster.value && roster.value.entries ? roster.value.entries : [])) : [];
      const rosterCount = Array.isArray(rosterEntries) ? rosterEntries.length : '--';
      const healthOk = health.status === 'fulfilled';
      const healthData = healthOk ? health.value : null;

      grid.innerHTML =
        statCard('Groups', groupCount, 'blue') +
        statCard('Roster Entries', rosterCount, 'green') +
        statCard('Node Health', healthOk ? 'Healthy' : 'Unavailable', healthOk ? 'green' : 'red') +
        statCard('SSE Events', sseEvents.length, 'purple');
    } catch {
      grid.innerHTML = statCard('Status', 'Error loading', 'red');
    }
  }

  function statCard(label, value, color) {
    return '<div class="stat-card"><div class="stat-label">' + esc(label) + '</div><div class="stat-value ' + (color || '') + '">' + esc(String(value)) + '</div></div>';
  }

  async function loadOnboardingStatus() {
    const el = document.getElementById('ov-onboard');
    if (!el) return;
    try {
      const data = await API.getOnboardingStatus();
      el.innerHTML = '<div class="detail-grid"><div>' +
        detailRow('Role', data.role || '--') +
        detailRow('Phase', data.phase || (data.onboarding && data.onboarding.phase) || '--') +
        detailRow('Configured', (data.phase === 'ready' || data.configured) ? 'Yes' : 'No') +
        detailRow('Display Name', data.displayName || '--') +
        '</div></div>';
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed to load onboarding status: ' + esc(e.message) + '</div>';
    }
  }

  function detailRow(label, value) {
    return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span><span class="detail-value mono">' + esc(String(value)) + '</span></div>';
  }

  function renderEventLog() {
    const el = document.getElementById('ov-events');
    if (!el) return;
    if (sseEvents.length === 0) {
      el.innerHTML = emptyState('No events yet', 'Events appear as they arrive via SSE');
      return;
    }
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

  // ==== GROUPS ====
  async function renderGroups() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Groups</div><button class="btn primary" id="btn-show-create-group">Create Group</button></div>' +
      '<div id="attestation-banner"></div>' +
      '<div id="create-group-form" style="display:none"></div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">All Groups</span><button class="btn sm" id="btn-refresh-groups">Refresh</button></div><div class="panel-body no-pad" id="groups-table">' + loading() + '</div></div>';

    document.getElementById('btn-show-create-group').onclick = toggleCreateGroupForm;
    document.getElementById('btn-refresh-groups').onclick = loadGroupsTable;
    loadAttestationBanner();
    loadGroupsTable();
  }

  // Phase 3.4: Fetch current attestation status and render a banner at the top of the Groups tab.
  async function loadAttestationBanner() {
    var banner = document.getElementById('attestation-banner');
    if (!banner) return;
    try {
      var res = await API.getAttestation();
      var data = res && res.data ? res.data : res;
      if (data && data.loaded) {
        var plans = (data.authorizedPlanIds || []).map(function(p) { return '<span class="badge primary">' + esc(p) + '</span>'; }).join(' ');
        var eff = data.effectiveDate ? data.effectiveDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : 'n/a';
        banner.innerHTML = '<div class="panel" style="margin-bottom:12px;border-left:3px solid #10b981"><div class="panel-body" style="padding:12px 16px">' +
          '<div style="font-size:12px;color:#10b981;font-weight:600;margin-bottom:4px">MARKETPLACE ATTESTATION LOADED</div>' +
          '<div style="font-size:13px">Authorized plans: ' + (plans || '<em>none</em>') + '</div>' +
          '<div style="font-size:11px;color:#888;margin-top:4px">Effective: ' + esc(eff) + ' | Cap: ' + esc(String(data.enrollmentCap || 'n/a')) + ' members</div>' +
          '</div></div>';
      } else {
        banner.innerHTML = '<div class="panel" style="margin-bottom:12px;border-left:3px solid #f59e0b"><div class="panel-body" style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">' +
          '<div>' +
            '<div style="font-size:12px;color:#f59e0b;font-weight:600;margin-bottom:4px">WAITING FOR MARKETPLACE ATTESTATION</div>' +
            '<div style="font-size:13px">No attestation loaded. Groups cannot be created yet. Complete the marketplace flow at <a href="http://localhost:4004/marketplace/" target="_blank">http://localhost:4004/marketplace/</a> first.</div>' +
          '</div>' +
          '<button class="btn sm" id="btn-refresh-attestation">Refresh Attestation</button>' +
        '</div></div>';
        var refreshBtn = document.getElementById('btn-refresh-attestation');
        if (refreshBtn) refreshBtn.onclick = async function() {
          refreshBtn.disabled = true;
          refreshBtn.textContent = 'Refreshing...';
          try {
            var r = await API.refreshAttestation();
            var d = r && r.data ? r.data : r;
            if (d && d.loaded) {
              toast('Attestation loaded (' + (d.authorizedPlanIds || []).length + ' plan(s))', 'success');
              loadAttestationBanner();
              loadGroupsTable();
            } else {
              toast('No attestation on sequencer: ' + (d && d.reason ? d.reason : 'unknown'), 'error');
              refreshBtn.disabled = false;
              refreshBtn.textContent = 'Refresh Attestation';
            }
          } catch (e) {
            toast('Refresh failed: ' + e.message, 'error');
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Refresh Attestation';
          }
        };
      }
    } catch (e) {
      banner.innerHTML = '';
    }
  }

  async function toggleCreateGroupForm() {
    const el = document.getElementById('create-group-form');
    if (el.style.display === 'none') {
      el.style.display = 'block';

      // Fetch available plans from insurer
      let planOptions = '<option value="">-- Select a Plan --</option>';
      try {
        const plans = await API.getAvailablePlans();
        if (Array.isArray(plans) && plans.length > 0) {
          planOptions += plans.map(function (p) {
            var pid = p.planId || p.id;
            var label = esc(p.name) + ' (' + esc(pid) + ')';
            if (p.published) label += ' [Published]';
            return '<option value="' + esc(pid) + '">' + label + '</option>';
          }).join('');
        }
      } catch { /* insurer not reachable — allow manual entry */ }

      el.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Create New Group</span></div><div class="panel-body">' +
        '<div class="form-grid">' +
          formField('cg-groupId', 'Group ID', 'text', 'e.g. GRP-EPIC-ENG') +
          '<div class="form-group"><label for="cg-planId">Benefit Plan</label>' +
            '<select id="cg-planId" style="width:100%;padding:8px;border:1px solid var(--border-color,#ccc);border-radius:4px;font-size:13px">' + planOptions + '</select>' +
            '<span class="field-error" id="cg-planId-err"></span></div>' +
          formField('cg-effectiveDate', 'Effective Date', 'date', '') +
          formField('cg-enrollmentCap', 'Enrollment Cap', 'number', 'e.g. 100') +
        '</div>' +
        '<div class="form-actions"><button class="btn primary" id="btn-create-group">Create</button><button class="btn" id="btn-cancel-create-group">Cancel</button><span id="cg-status"></span></div>' +
        '</div></div>';
      document.getElementById('btn-create-group').onclick = doCreateGroup;
      document.getElementById('btn-cancel-create-group').onclick = () => { el.style.display = 'none'; };
    } else {
      el.style.display = 'none';
    }
  }

  function formField(id, label, type, placeholder) {
    return '<div class="form-group"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="' + type + '" id="' + id + '" placeholder="' + esc(placeholder) + '">' +
      '<span class="field-error" id="' + id + '-err"></span></div>';
  }

  async function doCreateGroup() {
    clearErrors('cg-groupId', 'cg-planId', 'cg-effectiveDate', 'cg-enrollmentCap');
    const groupId = val('cg-groupId');
    const planId = val('cg-planId');
    const effectiveDate = val('cg-effectiveDate');
    const enrollmentCap = val('cg-enrollmentCap');
    let valid = true;

    if (!groupId) { setErr('cg-groupId', 'Group ID is required'); valid = false; }
    if (!planId) { setErr('cg-planId', 'Plan ID is required'); valid = false; }
    if (!effectiveDate) { setErr('cg-effectiveDate', 'Effective date is required'); valid = false; }
    if (!enrollmentCap || isNaN(Number(enrollmentCap)) || Number(enrollmentCap) < 1) { setErr('cg-enrollmentCap', 'Must be a positive number'); valid = false; }
    if (!valid) return;

    const btn = document.getElementById('btn-create-group');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    try {
      await API.createGroup(groupId, planId, effectiveDate, Number(enrollmentCap));
      toast('Group created: ' + groupId, 'success');
      document.getElementById('create-group-form').style.display = 'none';
      loadGroupsTable();
    } catch (e) {
      toast('Failed to create group: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create';
    }
  }

  async function loadGroupsTable() {
    const el = document.getElementById('groups-table');
    if (!el) return;
    el.innerHTML = loading();
    try {
      const data = await API.listGroups();
      const groups = Array.isArray(data) ? data : (data && data.groups ? data.groups : []);
      if (groups.length === 0) {
        el.innerHTML = emptyState('No groups', 'Create a group to get started');
        return;
      }
      el.innerHTML = '<div class="hint-banner" style="margin-bottom:12px;padding:10px 14px;background:var(--accent-light);border-left:3px solid var(--accent);font-size:13px;border-radius:var(--radius-sm)">' +
        'To issue enrollment codes to employees, use the <strong>HR Tool</strong>. ' +
        'The HR Tool is designed to handle PII safely — this dashboard intentionally does not generate tokens.' +
        '</div>' +
        '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Group ID</th><th>Plan ID</th><th>Effective Date</th><th>Utilization</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
        groups.map(g => {
          const gid = g.groupId || g.id || '--';
          const status = g.status || g.state || 'active';
          const badgeClass = status === 'active' ? 'green' : status === 'terminated' ? 'red' : 'yellow';
          // Phase F1: stats inlined in /groups response — show used/cap
          const cap = g.enrollmentCap || 0;
          const used = (g.enrolledCount || 0) + (g.pendingTokens || 0);
          const isUnlimited = g.isUnlimited === true || cap === 0;
          const capDisplay = isUnlimited
            ? (used + ' (unlimited)')
            : (used + ' / ' + cap);
          const capPct = isUnlimited ? 0 : Math.round((used / cap) * 100);
          const capColor = capPct >= 90 ? 'var(--red)' : capPct >= 70 ? 'var(--yellow)' : 'var(--text-primary)';
          return '<tr><td class="mono">' + esc(gid) + '</td>' +
            '<td class="mono">' + esc(g.planId || '--') + '</td>' +
            '<td>' + esc(fmtDateShort(g.effectiveDate)) + '</td>' +
            '<td style="color:' + capColor + ';font-variant-numeric:tabular-nums">' + esc(capDisplay) + '</td>' +
            '<td><span class="badge ' + badgeClass + '">' + esc(status) + '</span></td>' +
            '<td class="actions-cell"><button class="btn sm danger btn-delete-group" data-gid="' + esc(gid) + '">Delete</button></td></tr>';
        }).join('') +
        '</tbody></table></div>';
      el.querySelectorAll('.btn-delete-group').forEach(btn => {
        btn.onclick = () => doDeleteGroup(btn.dataset.gid);
      });
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed to load groups: ' + esc(e.message) + '</div>';
    }
  }

  async function doDeleteGroup(groupId) {
    if (!confirm('Terminate group ' + groupId + '?')) return;
    try {
      await API.deleteGroup(groupId, new Date().toISOString().slice(0, 10));
      toast('Group terminated: ' + groupId, 'success');
      loadGroupsTable();
    } catch (e) {
      toast('Failed to delete group: ' + e.message, 'error');
    }
  }

  // ==== TOKENS ==== (Phase F2: removed — token generation is now HR Tool only.
  // The HR Tool is a PII-safe workstation that hashes plaintext employee data
  // with a per-group seed before calling the employer node's token endpoints.
  // This dashboard never sees plaintext PII, so it cannot generate valid tokens.)

  // ==== ROSTER ====
  async function renderRoster() {
    app.innerHTML = '<div class="section-header"><div class="section-title">Roster</div></div>' +
      '<div class="panel"><div class="filter-bar">' +
        '<label for="roster-filter">Status:</label>' +
        '<select id="roster-filter"><option value="">All</option><option value="pending">Pending</option><option value="enrolled">Enrolled</option><option value="terminated">Terminated</option></select>' +
        '<button class="btn sm" id="btn-refresh-roster">Refresh</button>' +
      '</div><div class="panel-body no-pad" id="roster-table">' + loading() + '</div></div>';

    document.getElementById('roster-filter').onchange = loadRosterTable;
    document.getElementById('btn-refresh-roster').onclick = loadRosterTable;
    loadRosterTable();
  }

  async function loadRosterTable() {
    const el = document.getElementById('roster-table');
    if (!el) return;
    el.innerHTML = loading();
    const filterEl = document.getElementById('roster-filter');
    const status = filterEl ? filterEl.value : '';
    try {
      const data = await API.listRoster(status || undefined);
      const entries = Array.isArray(data) ? data : (data && data.entries ? data.entries : []);
      if (entries.length === 0) {
        el.innerHTML = emptyState('No roster entries', status ? 'Try a different filter' : 'No employees enrolled yet');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>Employee ID Hash</th><th>Group ID</th><th>Wallet ID</th><th>Status</th><th>Enrolled</th><th>Actions</th></tr></thead><tbody>' +
        entries.map(r => {
          const eHash = r.employeeIdHash || r.id || '--';
          const st = r.status || r.state || 'pending';
          const bc = st === 'enrolled' ? 'green' : st === 'terminated' ? 'red' : 'yellow';
          return '<tr><td class="mono truncate" title="' + esc(eHash) + '">' + esc(truncHash(eHash, 16)) + '</td>' +
            '<td class="mono">' + esc(r.groupId || '--') + '</td>' +
            '<td class="mono truncate" title="' + esc(r.consumedByWalletId || r.walletId || '') + '">' + esc(truncHash(r.consumedByWalletId || r.walletId, 16)) + '</td>' +
            '<td><span class="badge ' + bc + '">' + esc(st) + '</span></td>' +
            '<td>' + esc(fmtDateShort(r.enrolledAt || r.enrollmentDate || r.consumedAt || r.createdAt)) + '</td>' +
            '<td class="actions-cell">' +
              (st !== 'terminated' ? '<button class="btn sm danger btn-terminate-roster" data-id="' + esc(eHash) + '">Terminate</button>' : '') +
            '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
      el.querySelectorAll('.btn-terminate-roster').forEach(btn => {
        btn.onclick = () => doTerminateRoster(btn.dataset.id);
      });
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed to load roster: ' + esc(e.message) + '</div>';
    }
  }

  async function doTerminateRoster(employeeIdHash) {
    if (!confirm('Terminate roster entry ' + truncHash(employeeIdHash, 20) + '?')) return;
    try {
      await API.terminateRosterEntry(employeeIdHash);
      toast('Roster entry terminated', 'success');
      loadRosterTable();
    } catch (e) {
      toast('Failed to terminate: ' + e.message, 'error');
    }
  }

  // ==== MESSAGING ====
  let msgSubTab = 'inbox';
  let currentThread = null;

  async function renderMessaging() {
    msgSubTab = 'inbox';
    currentThread = null;
    app.innerHTML = '<div class="section-header"><div class="section-title">Messaging</div><button class="btn primary" id="btn-show-compose">Compose</button></div>' +
      '<div id="compose-form" style="display:none"></div>' +
      '<div class="panel" id="msg-panel">' +
        '<div class="sub-tabs" id="msg-tabs">' +
          '<button class="sub-tab active" data-sub="inbox">Inbox</button>' +
          '<button class="sub-tab" data-sub="sent">Sent</button>' +
        '</div>' +
        '<div id="msg-content">' + loading() + '</div>' +
      '</div>';

    document.getElementById('btn-show-compose').onclick = toggleComposeForm;
    document.querySelectorAll('#msg-tabs .sub-tab').forEach(btn => {
      btn.onclick = () => {
        msgSubTab = btn.dataset.sub;
        currentThread = null;
        document.querySelectorAll('#msg-tabs .sub-tab').forEach(b => b.classList.toggle('active', b.dataset.sub === msgSubTab));
        loadMessages();
      };
    });
    loadMessages();
  }

  function toggleComposeForm() {
    const el = document.getElementById('compose-form');
    if (el.style.display === 'none') {
      el.style.display = 'block';
      el.innerHTML = '<div class="panel"><div class="panel-header"><span class="panel-title">Compose Message</span></div><div class="panel-body">' +
        '<div class="form-grid">' +
          formField('cm-recipient', 'Recipient Wallet ID', 'text', 'Wallet ID of recipient') +
          formField('cm-subject', 'Subject', 'text', 'Message subject') +
        '</div>' +
        '<div class="form-group" style="margin-top:12px"><label for="cm-body">Message</label><textarea id="cm-body" placeholder="Type your message..."></textarea><span class="field-error" id="cm-body-err"></span></div>' +
        '<div class="form-actions"><button class="btn primary" id="btn-send-msg">Send</button><button class="btn" id="btn-cancel-compose">Cancel</button></div>' +
        '</div></div>';
      document.getElementById('btn-send-msg').onclick = doSendMessage;
      document.getElementById('btn-cancel-compose').onclick = () => { el.style.display = 'none'; };
    } else {
      el.style.display = 'none';
    }
  }

  async function doSendMessage() {
    clearErrors('cm-recipient', 'cm-subject', 'cm-body');
    const recipient = val('cm-recipient');
    const subject = val('cm-subject');
    const body = val('cm-body');
    let valid = true;

    if (!recipient) { setErr('cm-recipient', 'Recipient is required'); valid = false; }
    if (!subject) { setErr('cm-subject', 'Subject is required'); valid = false; }
    if (!body) { setErr('cm-body', 'Message body is required'); valid = false; }
    if (!valid) return;

    const btn = document.getElementById('btn-send-msg');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      await API.sendMessage(recipient, subject, body);
      toast('Message sent', 'success');
      document.getElementById('compose-form').style.display = 'none';
      msgSubTab = 'sent';
      document.querySelectorAll('#msg-tabs .sub-tab').forEach(b => b.classList.toggle('active', b.dataset.sub === 'sent'));
      loadMessages();
    } catch (e) {
      toast('Failed to send message: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  }

  async function loadMessages() {
    const el = document.getElementById('msg-content');
    if (!el) return;

    if (currentThread) {
      el.innerHTML = loading();
      try {
        const data = await API.getThread(currentThread);
        const messages = Array.isArray(data) ? data : (data && data.messages ? data.messages : [data]);
        el.innerHTML = '<div><span class="back-link" id="msg-back-btn">[back] Return to ' + esc(msgSubTab) + '</span></div>' +
          messages.map(m => {
            var msg = m.message || {};
            var payload = m.payload || {};
            var sender = msg.senderWalletId || m.senderWalletId || m.sender || '--';
            var ts = payload.timestamp || m.timestamp || m.createdAt;
            var msgType = msg.messageType || m.messageType || 'message';
            return '<div class="thread-message"><div class="thread-message-header">' +
              '<span class="thread-message-sender">' + esc(truncHash(sender, 20)) + '</span>' +
              '<span class="thread-message-time">' + esc(fmtDate(ts)) + '</span></div>' +
              '<div class="thread-message-body"><span style="color:var(--text-secondary)">[' + esc(msgType) + '] Encrypted content</span></div></div>';
          }).join('');
        const backBtn = document.getElementById('msg-back-btn');
        if (backBtn) backBtn.onclick = () => { currentThread = null; loadMessages(); };
      } catch (e) {
        el.innerHTML = '<div class="error-banner">Failed to load thread: ' + esc(e.message) + '</div>';
      }
      return;
    }

    el.innerHTML = loading();
    try {
      const data = msgSubTab === 'inbox' ? await API.getInbox() : await API.getSent();
      const messages = Array.isArray(data) ? data : (data && data.messages ? data.messages : []);
      if (messages.length === 0) {
        el.innerHTML = emptyState('No messages', msgSubTab === 'inbox' ? 'Your inbox is empty' : 'No sent messages');
        return;
      }
      el.innerHTML = messages.map(m => {
        // MessageStoreEntry: m.message is an object, m.payload is encrypted
        const msg = m.message || {};
        const payload = m.payload || {};
        const peer = msgSubTab === 'inbox'
          ? (msg.senderWalletId || m.senderWalletId || m.sender || '--')
          : (msg.recipientWalletId || m.recipientWalletId || m.recipient || '--');
        const threadId = msg.threadIdHash || m.threadIdHash || m.threadId || null;
        const ts = payload.timestamp || m.timestamp || m.createdAt;
        const msgType = msg.messageType || m.messageType || 'message';
        return '<div class="message-item" ' + (threadId ? 'data-thread="' + esc(threadId) + '"' : '') + '>' +
          '<div class="message-item-header">' +
            '<span class="message-subject">' + esc(msgType) + '</span>' +
            '<span class="message-meta">' + esc(fmtDate(ts)) + '</span>' +
          '</div>' +
          '<span class="message-sender">' + (msgSubTab === 'inbox' ? 'From: ' : 'To: ') + esc(truncHash(peer, 20)) + '</span>' +
          '<div class="message-preview" style="color:var(--text-secondary);font-style:italic">Encrypted content</div>' +
        '</div>';
      }).join('');
      el.querySelectorAll('.message-item[data-thread]').forEach(item => {
        item.onclick = () => {
          currentThread = item.dataset.thread;
          loadMessages();
        };
      });
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Failed to load messages: ' + esc(e.message) + '</div>';
    }
  }

  // ==== ADMIN ====
  async function renderAdmin() {
    const savedToken = API.getAdminToken();
    app.innerHTML = '<div class="section-header"><div class="section-title">Admin</div></div>' +
      '<div class="admin-token-bar"><label>Admin Token:</label><input type="password" id="admin-token-input" placeholder="Enter admin bearer token" value="' + esc(savedToken) + '"><button class="btn sm" id="btn-set-token">Set</button></div>' +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Node Health</span><button class="btn sm" id="btn-refresh-health">Refresh</button></div><div class="panel-body" id="admin-health">' + loading() + '</div></div>' +
        '<div class="panel"><div class="panel-header"><span class="panel-title">Chain State</span><button class="btn sm" id="btn-refresh-chain">Refresh</button></div><div class="panel-body" id="admin-chain">' + loading() + '</div></div>' +
      '</div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Sequencer Status</span><button class="btn sm" id="btn-refresh-seq">Refresh</button></div><div class="panel-body" id="admin-seq">' + loading() + '</div></div>' +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Onboarding Configuration</span></div><div class="panel-body">' +
        '<div class="form-grid">' +
          formField('adm-employerId', 'Employer ID', 'text', 'Your employer ID') +
          formField('adm-insurerUrl', 'Insurer URL', 'text', 'e.g. http://localhost:3001') +
        '</div>' +
        '<div class="form-actions" style="margin-top:12px"><button class="btn primary" id="btn-configure">Configure</button></div>' +
      '</div></div>';

    document.getElementById('btn-set-token').onclick = () => {
      API.setAdminToken(document.getElementById('admin-token-input').value.trim());
      toast('Admin token updated', 'info');
    };
    document.getElementById('btn-refresh-health').onclick = loadAdminHealth;
    document.getElementById('btn-refresh-chain').onclick = loadAdminChain;
    document.getElementById('btn-refresh-seq').onclick = loadAdminSeq;
    document.getElementById('btn-configure').onclick = doOnboardingConfigure;

    loadAdminHealth();
    loadAdminChain();
    loadAdminSeq();
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

  async function loadAdminChain() {
    const el = document.getElementById('admin-chain');
    if (!el) return;
    try {
      const data = await API.getChainState();
      el.innerHTML = renderDetailObj(data);
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Chain state unavailable: ' + esc(e.message) + '</div>';
    }
  }

  async function loadAdminSeq() {
    const el = document.getElementById('admin-seq');
    if (!el) return;
    try {
      const data = await API.getSequencerStatus();
      el.innerHTML = renderDetailObj(data);
    } catch (e) {
      el.innerHTML = '<div class="error-banner">Sequencer status unavailable: ' + esc(e.message) + '</div>';
    }
  }

  async function doOnboardingConfigure() {
    clearErrors('adm-employerId', 'adm-insurerUrl');
    const employerId = val('adm-employerId');
    const insurerUrl = val('adm-insurerUrl');
    let valid = true;
    if (!employerId) { setErr('adm-employerId', 'Employer ID is required'); valid = false; }
    if (!insurerUrl) { setErr('adm-insurerUrl', 'Insurer URL is required'); valid = false; }
    if (!valid) return;
    try {
      await API.configure(employerId, insurerUrl);
      toast('Onboarding configured', 'success');
    } catch (e) {
      toast('Configure failed: ' + e.message, 'error');
    }
  }

  function renderDetailObj(obj) {
    if (!obj || typeof obj !== 'object') return '<div class="detail-value mono">' + esc(String(obj)) + '</div>';
    const keys = Object.keys(obj);
    if (keys.length === 0) return emptyState('Empty', 'No data returned');
    return '<div class="detail-grid"><div>' +
      keys.map(k => {
        const v = obj[k];
        const display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
        return detailRow(k, display);
      }).join('') +
      '</div></div>';
  }

  // ---- Form helpers ----
  function val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function setErr(id, msg) {
    const el = document.getElementById(id + '-err');
    if (el) el.textContent = msg;
  }

  function clearErrors() {
    for (let i = 0; i < arguments.length; i++) {
      setErr(arguments[i], '');
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
    API.onConnectionChange((state) => {
      setConnectionStatus(state);
    });
  }

  // ---- Init ----
  async function init() {
    // Admin token is restored from localStorage by rpc.js on load.
    // If not set, prompt user to enter it in the Admin/Settings section.
    if (!API.getAdminToken()) {
      console.info('[employer] No admin token — set one in Admin tab to manage groups');
    }
    checkConnection();
    initSSE();
    const hash = location.hash.replace('#', '') || 'overview';
    navigate(hash);
  }

  init();
})();
