// zkp.Care Insurer Dashboard — SPA Application Logic
// Overview, Formulary, Plans, Employers & Groups, Eligibility, Pricing, Claims, Audit, Admin.

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var sseEvents = [];
  var sseCount = 0;
  var formularyData = [];       // in-memory, fetched from sequencer
  var planData = [];             // in-memory, initialized from defaults
  var employerData = [];         // employers/groups
  var priceHistory = [];         // recent pricing estimates

  // ── Employer defaults (fallback — live data comes from sequencer roster) ──
  var EMPLOYERS = [
    {
      id: 'EMP-10001', name: 'Epic Systems Corporation', industry: 'Healthcare IT', state: 'WI',
      groups: [
        { id: 'GRP-EPIC-ENG', name: 'Epic Engineering', planId: 'PLAN-GOLD-001', members: [] },
        { id: 'GRP-EPIC-OPS', name: 'Epic Operations', planId: 'PLAN-SILVER-002', members: [] },
      ]
    },
    {
      id: 'EMP-10002', name: 'Exact Sciences Corporation', industry: 'Diagnostics', state: 'WI',
      groups: [
        { id: 'GRP-EXACT-RD', name: 'Exact Sciences R&D', planId: 'PLAN-PLATINUM-003', members: [] },
      ]
    },
  ];

  // ── Formulary fallback (live data loaded from sequencer) ──
  var DEFAULT_FORMULARY = [
    { ndcHash: '2819374650192837465019283746', brandName: 'Lisinopril 10mg', tierLevel: 1, copayAmountCents: 500, requiresPriorAuth: false },
    { ndcHash: '3920485761203948576120394857', brandName: 'Metformin 500mg', tierLevel: 1, copayAmountCents: 500, requiresPriorAuth: false },
    { ndcHash: '5031596872314059687231405968', brandName: 'Atorvastatin 20mg', tierLevel: 1, copayAmountCents: 500, requiresPriorAuth: false },
    { ndcHash: '6142607983425160798342516079', brandName: 'Omeprazole 20mg', tierLevel: 1, copayAmountCents: 750, requiresPriorAuth: false },
    { ndcHash: '7253718094536271809453627180', brandName: 'Amlodipine 5mg', tierLevel: 1, copayAmountCents: 500, requiresPriorAuth: false },
    { ndcHash: '8364829105647382910564738291', brandName: 'Eliquis 5mg', tierLevel: 2, copayAmountCents: 3500, requiresPriorAuth: false },
    { ndcHash: '9475930216758493021675849302', brandName: 'Jardiance 10mg', tierLevel: 2, copayAmountCents: 4500, requiresPriorAuth: false },
    { ndcHash: '1586041327869504132786950413', brandName: 'Ozempic 0.5mg', tierLevel: 3, copayAmountCents: 7500, requiresPriorAuth: true },
    { ndcHash: '2697152438970615243897061524', brandName: 'Humira 40mg', tierLevel: 4, copayAmountCents: 15000, requiresPriorAuth: true },
    { ndcHash: '3708263549081726354908172635', brandName: 'Keytruda 200mg', tierLevel: 4, copayAmountCents: 25000, requiresPriorAuth: true },
  ];

  var DEFAULT_PLANS = [
    { id: 'PLAN-GOLD-001', name: 'Gold PPO 2026', copay: 2000, deductible: 100000, oopMax: 500000, annualMax: 10000000, famDeductible: 200000, famOopMax: 1000000, coverage: 'pharmacy' },
    { id: 'PLAN-SILVER-002', name: 'Silver HMO 2026', copay: 3500, deductible: 200000, oopMax: 700000, annualMax: 8000000, famDeductible: 400000, famOopMax: 1400000, coverage: 'pharmacy' },
    { id: 'PLAN-PLATINUM-003', name: 'Platinum PPO 2026', copay: 1000, deductible: 50000, oopMax: 300000, annualMax: 15000000, famDeductible: 100000, famOopMax: 600000, coverage: 'pharmacy' },
    { id: 'PLAN-BRONZE-004', name: 'Bronze HDHP 2026', copay: 5000, deductible: 350000, oopMax: 900000, annualMax: 5000000, famDeductible: 700000, famOopMax: 1800000, coverage: 'pharmacy' },
  ];

  // ── Helpers ────────────────────────────────────────────────
  function esc(s) {
    if (s === null || s === undefined) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function truncHash(h, len) {
    len = len || 12;
    if (!h) return '--';
    var s = String(h);
    return s.length > len ? s.slice(0, len) + '...' : s;
  }

  function fmtCents(c) {
    if (c == null) return '--';
    return '$' + (Number(c) / 100).toFixed(2);
  }

  function fmtDate(v) {
    if (!v) return '--';
    try { return new Date(v).toLocaleString(); } catch (e) { return String(v); }
  }

  function $(id) { return document.getElementById(id); }

  function toast(msg, type) {
    type = type || 'info';
    var c = $('toast-container');
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(function () { el.remove(); }, 300); }, 4000);
  }

  function showResult(id, msg, ok) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = '<div class="form-result ' + (ok ? 'success' : 'error') + '">' + esc(msg) + '</div>';
  }

  function clearResult(id) { var el = $(id); if (el) el.innerHTML = ''; }

  // ── Data Loading (from sequencer, no localStorage) ─────────
  async function loadFormularyFromSequencer() {
    try {
      var result = await API.getFormulary('default');
      if (result && result.entriesJson) {
        formularyData = JSON.parse(result.entriesJson);
        return;
      }
    } catch (_) { /* sequencer unavailable, use defaults */ }
    if (formularyData.length === 0) formularyData = DEFAULT_FORMULARY.slice();
  }

  async function loadPlans() {
    try {
      var plans = await API.getPlans();
      planData = Array.isArray(plans) ? plans : [];
    } catch {
      // Server not available — seed from defaults
      if (planData.length === 0) planData = DEFAULT_PLANS.slice();
    }
  }

  // ── Router ─────────────────────────────────────────────────
  var tabs = document.querySelectorAll('.nav-tab');
  var pages = document.querySelectorAll('.page');

  function navigate(tab) {
    tab = tab || 'overview';
    if (window._overviewTimer) { clearInterval(window._overviewTimer); window._overviewTimer = null; }
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
    pages.forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + tab); });
    window.location.hash = tab;
    onPageEnter(tab);
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { navigate(t.dataset.tab); });
  });

  window.addEventListener('hashchange', function () {
    navigate(location.hash.replace('#', '') || 'overview');
  });

  function onPageEnter(tab) {
    switch (tab) {
      case 'overview': loadOverview(); break;
      case 'formulary': loadFormularyPage(); break;
      case 'plans': loadPlansPage(); break;
      case 'employers': loadEmployersPage(); break;
      case 'eligibility': loadEligibilityPage(); break;
      case 'credentialing': loadCredentialingPage(); break;
      case 'reports': loadReportsPage(); break;
      case 'pricing': break;
      case 'claims': break;
      case 'audit': loadAuditPage(); break;
      case 'admin': loadAdminPage(); break;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  OVERVIEW
  // ═══════════════════════════════════════════════════════════

  function loadOverview() {
    loadOverviewStats();
    loadOnboardingStatus();
    if (window._overviewTimer) clearInterval(window._overviewTimer);
    window._overviewTimer = setInterval(loadOverviewStats, 30000);
  }

  async function loadOverviewStats() {
    try {
      var results = await Promise.allSettled([
        API.getReceipts(1000, 0),
        API.getBatches(1000, 0),
        API.getHealth(),
      ]);
      var rData = results[0].status === 'fulfilled' ? results[0].value : null;
      var bData = results[1].status === 'fulfilled' ? results[1].value : null;
      var hOk = results[2].status === 'fulfilled';

      var receipts = rData ? (Array.isArray(rData) ? rData : (rData.data || [])) : [];
      var batches = bData ? (Array.isArray(bData) ? bData : (bData.data || [])) : [];

      setTextContent('ov-receipts', Array.isArray(receipts) ? receipts.length : '--');
      setTextContent('ov-batches', Array.isArray(batches) ? batches.length : '--');
      setTextContent('ov-health', hOk ? 'Healthy' : 'Down');

      var badge = $('ov-health-badge');
      if (badge) {
        badge.textContent = hOk ? 'Online' : 'Offline';
        badge.className = 'badge ' + (hOk ? 'badge-ready' : 'badge-error');
      }
    } catch (e) {
      setTextContent('ov-health', 'Error');
    }
  }

  async function loadOnboardingStatus() {
    var el = $('ov-onboard');
    if (!el) return;
    try {
      var res = await API.getOnboardingStatus();
      var data = res.data || res;
      el.innerHTML =
        '<div class="detail-grid">' +
          '<div class="detail-key">Phase</div><div class="detail-val">' + esc(data.phase || data.onboarding?.phase || '--') + '</div>' +
          '<div class="detail-key">Role</div><div class="detail-val">' + esc(data.role || 'insurer') + '</div>' +
          '<div class="detail-key">Status</div><div class="detail-val">' + esc(data.status || '--') + '</div>' +
        '</div>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">' + esc(e.message) + '</div>';
    }
  }

  function setTextContent(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  // ═══════════════════════════════════════════════════════════
  //  FORMULARY
  // ═══════════════════════════════════════════════════════════

  var csvParsedData = null;

  async function loadFormularyPage() {
    await loadFormularyFromSequencer();
    renderTierStats();
    renderFormularyTable();
    initUploadZone();
    initManualAdd();
  }

  function renderTierStats() {
    var el = $('form-tier-stats');
    if (!el) return;
    var tiers = [0, 0, 0, 0];
    formularyData.forEach(function (f) {
      var t = Number(f.tierLevel);
      if (t >= 1 && t <= 4) tiers[t - 1]++;
    });
    el.innerHTML =
      '<div class="stat-card"><span class="stat-label">Tier 1 — Generic</span><span class="stat-value">' + tiers[0] + '</span></div>' +
      '<div class="stat-card"><span class="stat-label">Tier 2 — Preferred</span><span class="stat-value">' + tiers[1] + '</span></div>' +
      '<div class="stat-card"><span class="stat-label">Tier 3 — Non-Preferred</span><span class="stat-value">' + tiers[2] + '</span></div>' +
      '<div class="stat-card"><span class="stat-label">Tier 4 — Specialty</span><span class="stat-value">' + tiers[3] + '</span></div>';
  }

  function renderFormularyTable(filter) {
    var el = $('form-table-container');
    if (!el) return;
    var items = formularyData;
    if (filter) {
      var f = filter.toLowerCase();
      items = items.filter(function (e) {
        return (e.ndcHash && e.ndcHash.toLowerCase().indexOf(f) !== -1) ||
               (e.brandName && e.brandName.toLowerCase().indexOf(f) !== -1);
      });
    }
    if (items.length === 0) {
      el.innerHTML = '<div class="empty-state">No formulary entries' + (filter ? ' matching "' + esc(filter) + '"' : '') + '</div>';
      return;
    }
    el.innerHTML =
      '<table class="data-table"><thead><tr>' +
        '<th>NDC Hash</th><th>Brand Name</th><th>Tier</th><th>Copay</th><th>Prior Auth</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      items.map(function (e, i) {
        var tierNames = ['', 'Generic', 'Preferred', 'Non-Preferred', 'Specialty'];
        return '<tr>' +
          '<td><span class="hash" title="' + esc(e.ndcHash) + '">' + esc(truncHash(e.ndcHash, 16)) + '</span></td>' +
          '<td>' + esc(e.brandName || '--') + '</td>' +
          '<td><span class="badge tier-' + e.tierLevel + '">T' + e.tierLevel + ' ' + tierNames[e.tierLevel] + '</span></td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(e.copayAmountCents) + '</td>' +
          '<td>' + (e.requiresPriorAuth ? '<span class="badge badge-pending">Yes</span>' : 'No') + '</td>' +
          '<td><button class="btn btn-sm btn-danger" onclick="App.removeFormularyEntry(' + i + ')">Remove</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function initUploadZone() {
    var zone = $('form-upload-zone');
    var fileInput = $('form-file-input');
    if (!zone || !fileInput) return;

    zone.onclick = function () { fileInput.click(); };
    fileInput.onchange = function () { if (fileInput.files.length) parseCSV(fileInput.files[0]); };

    zone.ondragover = function (e) { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = function () { zone.classList.remove('drag-over'); };
    zone.ondrop = function (e) { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files.length) parseCSV(e.dataTransfer.files[0]); };

    var cancelBtn = $('form-cancel-upload');
    var publishBtn = $('form-publish-btn');
    if (cancelBtn) cancelBtn.onclick = cancelUpload;
    if (publishBtn) publishBtn.onclick = publishUpload;
  }

  function parseCSV(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result;
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (lines.length < 2) { toast('CSV must have a header row and at least one data row', 'error'); return; }

      var header = lines[0].split(',').map(function (h) { return h.trim().toLowerCase(); });
      var ndcIdx = header.indexOf('ndchash');
      var tierIdx = header.indexOf('tierlevel');
      var copayIdx = header.indexOf('copayamountcents');
      var brandIdx = header.indexOf('brandname');
      var paIdx = header.indexOf('requirespriorauth');

      if (ndcIdx === -1) { toast('CSV must have an "ndcHash" column', 'error'); return; }

      var entries = [];
      for (var i = 1; i < lines.length; i++) {
        var cols = lines[i].split(',').map(function (c) { return c.trim(); });
        if (!cols[ndcIdx]) continue;
        entries.push({
          ndcHash: cols[ndcIdx],
          brandName: brandIdx !== -1 ? cols[brandIdx] || '' : '',
          tierLevel: tierIdx !== -1 ? Number(cols[tierIdx]) || 1 : 1,
          copayAmountCents: copayIdx !== -1 ? Number(cols[copayIdx]) || 1000 : 1000,
          requiresPriorAuth: paIdx !== -1 ? cols[paIdx] === 'true' || cols[paIdx] === '1' : false,
        });
      }

      if (entries.length === 0) { toast('No valid entries found in CSV', 'error'); return; }

      csvParsedData = entries;
      showUploadPreview(entries);
    };
    reader.readAsText(file);
  }

  function showUploadPreview(entries) {
    var preview = $('form-upload-preview');
    var countEl = $('form-preview-count');
    var tableEl = $('form-preview-table');
    if (!preview || !tableEl) return;

    preview.classList.remove('hidden');
    if (countEl) countEl.textContent = entries.length;

    var html = '<table class="data-table"><thead><tr><th>NDC Hash</th><th>Brand</th><th>Tier</th><th>Copay</th><th>PA</th></tr></thead><tbody>';
    entries.slice(0, 50).forEach(function (e) {
      html += '<tr>' +
        '<td><span class="hash">' + esc(truncHash(e.ndcHash, 16)) + '</span></td>' +
        '<td>' + esc(e.brandName || '--') + '</td>' +
        '<td>' + e.tierLevel + '</td>' +
        '<td>' + fmtCents(e.copayAmountCents) + '</td>' +
        '<td>' + (e.requiresPriorAuth ? 'Yes' : 'No') + '</td></tr>';
    });
    if (entries.length > 50) html += '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">... and ' + (entries.length - 50) + ' more</td></tr>';
    html += '</tbody></table>';
    tableEl.innerHTML = html;
  }

  function cancelUpload() {
    csvParsedData = null;
    var preview = $('form-upload-preview');
    if (preview) preview.classList.add('hidden');
    var fileInput = $('form-file-input');
    if (fileInput) fileInput.value = '';
    clearResult('form-upload-result');
  }

  async function publishUpload() {
    if (!csvParsedData || csvParsedData.length === 0) return;

    // Merge locally: update existing by ndcHash or add new
    var existingMap = {};
    formularyData.forEach(function (e, i) { existingMap[e.ndcHash] = i; });

    var added = 0, updated = 0;
    csvParsedData.forEach(function (e) {
      if (existingMap[e.ndcHash] !== undefined) {
        formularyData[existingMap[e.ndcHash]] = e;
        updated++;
      } else {
        formularyData.push(e);
        added++;
      }
    });

    // Publish to sequencer immediately (single source of truth)
    var publishBtn = $('form-publish-btn');
    if (publishBtn) { publishBtn.disabled = true; publishBtn.textContent = 'Publishing...'; }
    try {
      var entriesJson = JSON.stringify(formularyData);
      var planIdHash = (planData.length > 0 ? planData[0].id : 'default-plan');
      await API.publishFormulary(planIdHash, '0', entriesJson);
      toast('Published ' + added + ' new, ' + updated + ' updated to sequencer', 'success');
      showResult('form-upload-result', 'Published to sequencer: ' + (added + updated) + ' formulary entries', true);
    } catch (e) {
      toast('Sequencer publish failed: ' + e.message, 'error');
      showResult('form-upload-result', 'Publish failed: ' + e.message, false);
    } finally {
      if (publishBtn) { publishBtn.disabled = false; publishBtn.textContent = 'Publish to Sequencer'; }
    }

    cancelUpload();
    renderTierStats();
    renderFormularyTable();
  }

  function initManualAdd() {
    var toggle = $('form-manual-toggle');
    var body = $('form-manual-body');
    if (toggle && body) {
      toggle.onclick = function () { body.classList.toggle('hidden'); };
    }
    var addBtn = $('form-add-btn');
    if (addBtn) addBtn.onclick = addFormularyEntry;

    var searchInput = $('form-search');
    if (searchInput) searchInput.oninput = function () { renderFormularyTable(searchInput.value); };

    var refreshBtn = $('form-refresh-btn');
    if (refreshBtn) refreshBtn.onclick = function () { renderFormularyTable(); };
  }

  function addFormularyEntry() {
    var ndc = ($('form-ndc') || {}).value || '';
    var brand = ($('form-brand') || {}).value || '';
    var tier = Number(($('form-tier') || {}).value) || 1;
    var copay = Number(($('form-copay') || {}).value) || 1000;

    if (!ndc.trim()) { toast('NDC Hash is required', 'error'); return; }

    formularyData.push({
      ndcHash: ndc.trim(),
      brandName: brand.trim(),
      tierLevel: tier,
      copayAmountCents: copay,
      requiresPriorAuth: false,
    });
    renderTierStats();
    renderFormularyTable();
    toast('Entry added to formulary', 'success');
    showResult('form-add-result', 'Added ' + (brand || ndc.trim()), true);
    if ($('form-ndc')) $('form-ndc').value = '';
    if ($('form-brand')) $('form-brand').value = '';
    // Publish updated formulary to sequencer
    publishFormularyToSequencer();
  }

  function removeFormularyEntry(idx) {
    if (idx >= 0 && idx < formularyData.length) {
      var name = formularyData[idx].brandName || formularyData[idx].ndcHash;
      formularyData.splice(idx, 1);
      renderTierStats();
      renderFormularyTable();
      toast('Removed ' + name, 'info');
      // Publish updated formulary to sequencer
      publishFormularyToSequencer();
    }
  }

  async function publishFormularyToSequencer() {
    try {
      var entriesJson = JSON.stringify(formularyData);
      var planIdHash = (planData.length > 0 ? planData[0].id : 'default-plan');
      await API.publishFormulary(planIdHash, '0', entriesJson);
    } catch (e) {
      console.warn('[Formulary] Sequencer publish failed:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  PLANS
  // ═══════════════════════════════════════════════════════════

  async function loadPlansPage() {
    await fetchPlans();
    renderPlanList();
    initPlanCreate();
    initPlanTemplates();
  }

  async function fetchPlans() {
    try {
      var plans = await API.getPlans();
      planData = Array.isArray(plans) ? plans : [];
    } catch { /* keep existing planData */ }
  }

  function coverageLabel(t) {
    if (t === 1 || t === 'pharmacy') return 'Pharmacy';
    if (t === 2 || t === 'medical') return 'Medical';
    if (t === 3 || t === 'dental') return 'Dental';
    return String(t || 'Pharmacy');
  }

  function renderPlanList() {
    var el = $('plan-list-container');
    if (!el) return;
    if (planData.length === 0) {
      el.innerHTML = '<div class="empty-state">No plans registered yet. Create one above.</div>';
      return;
    }
    el.innerHTML =
      '<table class="data-table"><thead><tr>' +
        '<th>Plan ID</th><th>Name</th><th>Copay</th><th>Deductible</th><th>OOP Max</th><th>Annual Max</th><th>Coverage</th><th>Formulary</th><th>Network</th><th>Status</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      planData.map(function (p) {
        var pid = p.planId || p.id;
        var published = p.published;
        var formularyCount = (p.formularyNdcs && p.formularyNdcs.length) || 0;
        var networkCount = (p.networkProviderWalletIds && p.networkProviderWalletIds.length) || 0;
        return '<tr>' +
          '<td style="font-family:var(--font-mono);font-size:12px">' + esc(pid) + '</td>' +
          '<td><a href="#" class="plan-edit-link" data-plan-id="' + esc(pid) + '" style="color:var(--accent-blue);text-decoration:underline;cursor:pointer">' + esc(p.name) + '</a></td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.copayAmountCents || p.copay || 0) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.deductibleAmountCents || p.deductible || 0) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.oopMaxCents || p.oopMax || 0) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.annualBenefitMaxCents || p.annualMax || 0) + '</td>' +
          '<td>' + coverageLabel(p.coverageType || p.coverage) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + (formularyCount > 0 ? formularyCount + ' NDCs' : 'All') + '</td>' +
          '<td style="font-family:var(--font-mono)">' + (networkCount > 0 ? networkCount + ' providers' : 'All') + '</td>' +
          '<td>' + (published ? '<span class="badge badge-active">Published</span>' : '<span class="badge badge-pending">Draft</span>') + '</td>' +
          '<td style="white-space:nowrap">' +
            '<button class="btn btn-sm btn-primary plan-publish-btn" data-plan-id="' + esc(pid) + '"' + (published ? ' disabled' : '') + '>Publish</button> ' +
            '<button class="btn btn-sm plan-delete-btn" data-plan-id="' + esc(pid) + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';

    // Bind publish/delete buttons
    el.querySelectorAll('.plan-publish-btn').forEach(function (btn) {
      btn.onclick = async function () {
        var pid = btn.dataset.planId;
        btn.disabled = true;
        btn.textContent = 'Publishing...';
        try {
          var result = await API.publishPlan(pid);
          toast('Plan published: ' + pid + ' (' + (result.formularyEntryCount || 0) + ' formulary entries)', 'success');
          await fetchPlans();
          renderPlanList();
        } catch (err) {
          toast('Publish failed: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Publish';
        }
      };
    });

    el.querySelectorAll('.plan-delete-btn').forEach(function (btn) {
      btn.onclick = async function () {
        var pid = btn.dataset.planId;
        if (!confirm('Delete plan ' + pid + '?')) return;
        try {
          await API.deletePlan(pid);
          toast('Plan deleted: ' + pid, 'success');
          await fetchPlans();
          renderPlanList();
        } catch (err) {
          toast('Delete failed: ' + err.message, 'error');
        }
      };
    });

    el.querySelectorAll('.plan-edit-link').forEach(function (link) {
      link.onclick = function (e) {
        e.preventDefault();
        openPlanDetail(link.dataset.planId);
      };
    });
  }

  // ── Transparent PBM Plan Templates ─────────────────────

  var PLAN_TEMPLATES = [
    {
      planId: 'COST-PLUS-BASIC',
      name: 'Cost Plus Basic',
      desc: 'NADAC + 2% + $3.50 dispensing fee. $0 generic copay, 100% rebate passthrough.',
      coverageType: 1,
      copayAmountCents: 0,
      deductibleAmountCents: 0,
      oopMaxCents: 200000,
      annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 0,
      familyOopMaxCents: 400000,
      familyAnnualBenefitMaxCents: 0,
    },
    {
      planId: 'TRANSPARENT-VALUE',
      name: 'Transparent Value',
      desc: 'Flat admin fee, pass-through pricing. Low deductible with moderate copays.',
      coverageType: 1,
      copayAmountCents: 500,
      deductibleAmountCents: 10000,
      oopMaxCents: 300000,
      annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 20000,
      familyOopMaxCents: 600000,
      familyAnnualBenefitMaxCents: 0,
    },
    {
      planId: 'HDHP-RX-INTEGRATED',
      name: 'HDHP Pharmacy Integrated',
      desc: 'HSA-compatible. IRS-compliant $1,650/$3,300 deductible. Per-claim admin fee.',
      coverageType: 1,
      copayAmountCents: 1000,
      deductibleAmountCents: 165000,
      oopMaxCents: 450000,
      annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 330000,
      familyOopMaxCents: 900000,
      familyAnnualBenefitMaxCents: 0,
    },
    {
      planId: 'EMPLOYER-PREMIER',
      name: 'Employer Premier',
      desc: 'Richest benefit. $0 generic, flat specialty copay, $0 deductible.',
      coverageType: 1,
      copayAmountCents: 0,
      deductibleAmountCents: 0,
      oopMaxCents: 150000,
      annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 0,
      familyOopMaxCents: 300000,
      familyAnnualBenefitMaxCents: 0,
    },
    {
      planId: 'COSTPLUS-COPAY-ASSIST',
      name: 'Cost Plus + Copay Assist',
      desc: 'NADAC + 3% + $2 dispensing. 5-tier with manufacturer copay assistance.',
      coverageType: 1,
      copayAmountCents: 300,
      deductibleAmountCents: 15000,
      oopMaxCents: 350000,
      annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 30000,
      familyOopMaxCents: 700000,
      familyAnnualBenefitMaxCents: 0,
    },
    {
      planId: 'SMALL-EMPLOYER-ESSENTIAL',
      name: 'Small Employer Essential',
      desc: 'Simplified 3-tier for groups under 100 lives. Annual benefit max included.',
      coverageType: 1,
      copayAmountCents: 1000,
      deductibleAmountCents: 20000,
      oopMaxCents: 400000,
      annualBenefitMaxCents: 5000000,
      familyDeductibleAmountCents: 40000,
      familyOopMaxCents: 800000,
      familyAnnualBenefitMaxCents: 10000000,
    },
    {
      planId: 'GLP1-INCLUSIVE',
      name: 'GLP-1 Inclusive',
      desc: 'Dedicated GLP-1/metabolic tier with clinical guardrails and annual sub-limit.',
      coverageType: 1,
      copayAmountCents: 500,
      deductibleAmountCents: 25000,
      oopMaxCents: 400000,
      annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 50000,
      familyOopMaxCents: 800000,
      familyAnnualBenefitMaxCents: 0,
    },
    {
      planId: 'MUNICIPAL-PUBLIC',
      name: 'Municipal / Public Sector',
      desc: 'Broad access, $0 deductible, flat $50 specialty copay. Public sector compliant.',
      coverageType: 1,
      copayAmountCents: 500,
      deductibleAmountCents: 0,
      oopMaxCents: 200000,
      annualBenefitMaxCents: 0,
      familyDeductibleAmountCents: 0,
      familyOopMaxCents: 400000,
      familyAnnualBenefitMaxCents: 0,
    },
  ];

  var selectedTemplates = new Set();

  function renderTemplateCards() {
    var container = $('plan-template-cards');
    if (!container) return;
    // check which planIds already exist
    var existingIds = new Set(planData.map(function (p) { return p.planId || p.id; }));
    container.innerHTML = PLAN_TEMPLATES.map(function (t) {
      var exists = existingIds.has(t.planId);
      var selected = selectedTemplates.has(t.planId);
      return '<div class="template-card' + (selected ? ' template-selected' : '') + (exists ? ' template-exists' : '') + '" data-plan-id="' + esc(t.planId) + '" style="' +
        'border:2px solid ' + (exists ? 'var(--border)' : selected ? 'var(--accent-blue)' : 'var(--border)') + ';' +
        'border-radius:8px;padding:12px;width:220px;cursor:' + (exists ? 'default' : 'pointer') + ';' +
        'background:' + (exists ? 'var(--bg-secondary)' : selected ? 'rgba(59,130,246,0.08)' : 'var(--bg-primary)') + ';' +
        'opacity:' + (exists ? '0.6' : '1') + ';transition:all 0.15s' +
      '">' +
        '<div style="font-weight:600;font-size:13px;margin-bottom:4px">' + esc(t.name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;line-height:1.4">' + esc(t.desc) + '</div>' +
        '<div style="font-size:11px;font-family:var(--font-mono);color:var(--text-secondary)">' +
          'Copay ' + fmtCents(t.copayAmountCents) +
          ' | Ded ' + fmtCents(t.deductibleAmountCents) +
          ' | OOP ' + fmtCents(t.oopMaxCents) +
        '</div>' +
        (exists ? '<div style="font-size:11px;color:var(--accent-green);margin-top:6px;font-weight:600">Already created</div>' : '') +
      '</div>';
    }).join('');

    container.querySelectorAll('.template-card').forEach(function (card) {
      var pid = card.dataset.planId;
      if (existingIds.has(pid)) return;
      card.onclick = function () {
        if (selectedTemplates.has(pid)) {
          selectedTemplates.delete(pid);
        } else {
          selectedTemplates.add(pid);
        }
        renderTemplateCards();
      };
    });
  }

  async function createSelectedTemplates() {
    if (selectedTemplates.size === 0) {
      toast('Select at least one plan template', 'error');
      return;
    }
    var btn = $('plan-template-create-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
    var created = 0;
    var errors = [];
    for (var i = 0; i < PLAN_TEMPLATES.length; i++) {
      var t = PLAN_TEMPLATES[i];
      if (!selectedTemplates.has(t.planId)) continue;
      try {
        await API.createPlan({
          planId: t.planId,
          name: t.name,
          coverageType: t.coverageType,
          copayAmountCents: t.copayAmountCents,
          deductibleAmountCents: t.deductibleAmountCents,
          oopMaxCents: t.oopMaxCents,
          annualBenefitMaxCents: t.annualBenefitMaxCents,
          familyDeductibleAmountCents: t.familyDeductibleAmountCents,
          familyOopMaxCents: t.familyOopMaxCents,
          familyAnnualBenefitMaxCents: t.familyAnnualBenefitMaxCents || 0,
          formularyNdcs: [],
          networkProviderWalletIds: [],
        });
        created++;
      } catch (err) {
        errors.push(t.planId + ': ' + err.message);
      }
    }
    selectedTemplates.clear();
    await fetchPlans();
    renderPlanList();
    renderTemplateCards();
    if (btn) { btn.disabled = false; btn.textContent = 'Create Selected Plans'; }
    if (created > 0) toast('Created ' + created + ' plan(s)', 'success');
    if (errors.length > 0) toast('Errors: ' + errors.join('; '), 'error');
    showResult('plan-template-result', 'Created ' + created + ' of ' + (created + errors.length) + ' plans', errors.length === 0);
  }

  function initPlanTemplates() {
    var toggle = $('plan-templates-toggle');
    var body = $('plan-templates-body');
    if (toggle && body) {
      toggle.onclick = function () { body.classList.toggle('hidden'); };
    }
    var selectAll = $('plan-template-select-all');
    var clearBtn = $('plan-template-clear');
    var createBtn = $('plan-template-create-btn');
    var existingIds = new Set(planData.map(function (p) { return p.planId || p.id; }));
    if (selectAll) selectAll.onclick = function () {
      PLAN_TEMPLATES.forEach(function (t) { if (!existingIds.has(t.planId)) selectedTemplates.add(t.planId); });
      renderTemplateCards();
    };
    if (clearBtn) clearBtn.onclick = function () {
      selectedTemplates.clear();
      renderTemplateCards();
    };
    if (createBtn) createBtn.onclick = createSelectedTemplates;
    renderTemplateCards();
  }

  function initPlanCreate() {
    var toggle = $('plan-create-toggle');
    var body = $('plan-create-body');
    if (toggle && body) {
      toggle.onclick = function () { body.classList.toggle('hidden'); };
    }
    var createBtn = $('plan-create-btn');
    if (createBtn) createBtn.onclick = createPlan;

    var refreshBtn = $('plan-refresh-btn');
    if (refreshBtn) refreshBtn.onclick = async function () {
      await fetchPlans();
      renderPlanList();
    };
  }

  async function createPlan() {
    var name = ($('plan-name') || {}).value || '';
    var id = ($('plan-id') || {}).value || '';
    if (!name.trim() || !id.trim()) { toast('Plan Name and Plan ID are required', 'error'); return; }

    var coverageMap = { pharmacy: 1, medical: 2, dental: 3 };
    var coverageVal = ($('plan-coverage') || {}).value || 'pharmacy';

    try {
      await API.createPlan({
        planId: id.trim(),
        name: name.trim(),
        coverageType: coverageMap[coverageVal] || 1,
        copayAmountCents: Number(($('plan-copay') || {}).value) || 2000,
        deductibleAmountCents: Number(($('plan-deductible') || {}).value) || 100000,
        oopMaxCents: Number(($('plan-oop') || {}).value) || 500000,
        annualBenefitMaxCents: Number(($('plan-annual') || {}).value) || 10000000,
        familyDeductibleAmountCents: Number(($('plan-fam-ded') || {}).value) || 200000,
        familyOopMaxCents: Number(($('plan-fam-oop') || {}).value) || 1000000,
        formularyNdcs: [],
        networkProviderWalletIds: [],
      });
      toast('Plan created: ' + name.trim(), 'success');
      showResult('plan-create-result', 'Created plan ' + id.trim(), true);
      await fetchPlans();
      renderPlanList();
    } catch (err) {
      toast('Create failed: ' + err.message, 'error');
      showResult('plan-create-result', err.message, false);
    }
  }

  // ── Plan Detail — Formulary + Network Selection ──────────

  var editingPlanId = null;
  var allFormularyEntries = [];
  var allNetworkProviders = [];
  var selectedFormularyNdcs = new Set();
  var selectedNetworkWalletIds = new Set();

  async function openPlanDetail(planId) {
    var plan = planData.find(function (p) { return (p.planId || p.id) === planId; });
    if (!plan) { toast('Plan not found', 'error'); return; }

    editingPlanId = planId;
    selectedFormularyNdcs = new Set(plan.formularyNdcs || []);
    selectedNetworkWalletIds = new Set(plan.networkProviderWalletIds || []);

    var panel = $('plan-detail-panel');
    if (panel) panel.classList.remove('hidden');
    var nameEl = $('plan-detail-name');
    if (nameEl) nameEl.textContent = plan.name + ' (' + planId + ')';

    // Fetch formulary + providers in parallel
    try {
      var [formData, provData] = await Promise.all([
        API.getFormulary('default').catch(function () { return { entries: [] }; }),
        API.getProviderRegistry().catch(function () { return { providers: [] }; }),
      ]);
      allFormularyEntries = (formData && formData.entries) || formData || [];
      if (!Array.isArray(allFormularyEntries)) allFormularyEntries = [];
      allNetworkProviders = (provData && provData.providers) || provData || [];
      if (!Array.isArray(allNetworkProviders)) allNetworkProviders = [];
    } catch {
      allFormularyEntries = [];
      allNetworkProviders = [];
    }

    renderFormularySelection();
    renderNetworkSelection();
    initPlanDetailEvents();
  }

  function renderFormularySelection() {
    var search = (($('plan-formulary-search') || {}).value || '').toLowerCase();
    var tierFilter = ($('plan-formulary-tier-filter') || {}).value || '';

    var filtered = allFormularyEntries.filter(function (e) {
      if (tierFilter && String(e.tierLevel) !== tierFilter) return false;
      if (search) {
        var name = (e.brandName || e.genericName || e.description || '').toLowerCase();
        var ndc = (e.ndc || '').toLowerCase();
        if (!name.includes(search) && !ndc.includes(search)) return false;
      }
      return true;
    });

    var statsEl = $('plan-formulary-stats');
    if (statsEl) statsEl.textContent = selectedFormularyNdcs.size + ' selected / ' + allFormularyEntries.length + ' total (' + filtered.length + ' shown)';

    var listEl = $('plan-formulary-list');
    if (!listEl) return;

    // Show max 200 for performance
    var visible = filtered.slice(0, 200);
    listEl.innerHTML = visible.map(function (e) {
      var checked = selectedFormularyNdcs.has(e.ndc) ? ' checked' : '';
      var tier = 'T' + (e.tierLevel || '?');
      return '<label style="display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--border)">' +
        '<input type="checkbox" class="plan-form-ndc-cb" data-ndc="' + esc(e.ndc) + '"' + checked + '>' +
        '<span style="font-family:var(--font-mono);min-width:90px">' + esc(e.ndc) + '</span>' +
        '<span style="flex:1">' + esc(e.brandName || e.genericName || e.description || 'Unknown') + '</span>' +
        '<span class="badge badge-' + (e.tierLevel === 1 ? 'active' : e.tierLevel === 2 ? 'info' : e.tierLevel === 3 ? 'pending' : 'error') + '" style="font-size:10px">' + tier + '</span>' +
      '</label>';
    }).join('') + (filtered.length > 200 ? '<div style="padding:8px;text-align:center;color:var(--text-secondary);font-size:11px">Showing 200 of ' + filtered.length + ' — use search to narrow</div>' : '');

    // Bind checkbox changes
    listEl.querySelectorAll('.plan-form-ndc-cb').forEach(function (cb) {
      cb.onchange = function () {
        if (cb.checked) selectedFormularyNdcs.add(cb.dataset.ndc);
        else selectedFormularyNdcs.delete(cb.dataset.ndc);
        var s = $('plan-formulary-stats');
        if (s) s.textContent = selectedFormularyNdcs.size + ' selected / ' + allFormularyEntries.length + ' total (' + filtered.length + ' shown)';
      };
    });
  }

  function renderNetworkSelection() {
    var search = (($('plan-network-search') || {}).value || '').toLowerCase();
    var typeFilter = ($('plan-network-type-filter') || {}).value || '';

    var filtered = allNetworkProviders.filter(function (p) {
      if (typeFilter && p.providerType !== typeFilter) return false;
      if (search) {
        var name = (p.displayName || '').toLowerCase();
        var npi = (p.npi || '').toLowerCase();
        if (!name.includes(search) && !npi.includes(search)) return false;
      }
      return true;
    });

    var statsEl = $('plan-network-stats');
    if (statsEl) statsEl.textContent = selectedNetworkWalletIds.size + ' selected / ' + allNetworkProviders.length + ' total (' + filtered.length + ' shown)';

    var listEl = $('plan-network-list');
    if (!listEl) return;

    listEl.innerHTML = filtered.map(function (p) {
      var checked = selectedNetworkWalletIds.has(p.walletId) ? ' checked' : '';
      var typeIcon = p.providerType === 'pharmacy' ? 'Rx' : 'Dr';
      return '<label style="display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--border)">' +
        '<input type="checkbox" class="plan-net-cb" data-wallet="' + esc(p.walletId) + '"' + checked + '>' +
        '<span class="badge badge-info" style="font-size:10px;min-width:24px;text-align:center">' + typeIcon + '</span>' +
        '<span style="flex:1">' + esc(p.displayName || 'Unknown') + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">' + esc(p.npi || '') + '</span>' +
      '</label>';
    }).join('');

    listEl.querySelectorAll('.plan-net-cb').forEach(function (cb) {
      cb.onchange = function () {
        if (cb.checked) selectedNetworkWalletIds.add(cb.dataset.wallet);
        else selectedNetworkWalletIds.delete(cb.dataset.wallet);
        var s = $('plan-network-stats');
        if (s) s.textContent = selectedNetworkWalletIds.size + ' selected / ' + allNetworkProviders.length + ' total (' + filtered.length + ' shown)';
      };
    });
  }

  var planDetailEventsInitialized = false;
  function initPlanDetailEvents() {
    if (planDetailEventsInitialized) return;
    planDetailEventsInitialized = true;

    var closeBtn = $('plan-detail-close');
    if (closeBtn) closeBtn.onclick = function () {
      var panel = $('plan-detail-panel');
      if (panel) panel.classList.add('hidden');
      editingPlanId = null;
    };

    // Search/filter handlers
    var formSearch = $('plan-formulary-search');
    if (formSearch) formSearch.oninput = renderFormularySelection;
    var formTier = $('plan-formulary-tier-filter');
    if (formTier) formTier.onchange = renderFormularySelection;
    var netSearch = $('plan-network-search');
    if (netSearch) netSearch.oninput = renderNetworkSelection;
    var netType = $('plan-network-type-filter');
    if (netType) netType.onchange = renderNetworkSelection;

    // Select all / clear
    var formSelectAll = $('plan-formulary-select-all');
    if (formSelectAll) formSelectAll.onclick = function () {
      $('plan-formulary-list').querySelectorAll('.plan-form-ndc-cb').forEach(function (cb) {
        cb.checked = true;
        selectedFormularyNdcs.add(cb.dataset.ndc);
      });
      renderFormularySelection();
    };
    var formClear = $('plan-formulary-clear');
    if (formClear) formClear.onclick = function () {
      selectedFormularyNdcs.clear();
      renderFormularySelection();
    };
    var netSelectAll = $('plan-network-select-all');
    if (netSelectAll) netSelectAll.onclick = function () {
      $('plan-network-list').querySelectorAll('.plan-net-cb').forEach(function (cb) {
        cb.checked = true;
        selectedNetworkWalletIds.add(cb.dataset.wallet);
      });
      renderNetworkSelection();
    };
    var netClear = $('plan-network-clear');
    if (netClear) netClear.onclick = function () {
      selectedNetworkWalletIds.clear();
      renderNetworkSelection();
    };

    // Save
    var saveBtn = $('plan-detail-save');
    if (saveBtn) saveBtn.onclick = async function () {
      if (!editingPlanId) return;
      try {
        await API.updatePlan(editingPlanId, {
          formularyNdcs: Array.from(selectedFormularyNdcs),
          networkProviderWalletIds: Array.from(selectedNetworkWalletIds),
        });
        toast('Plan configuration saved', 'success');
        showResult('plan-detail-result', 'Saved formulary (' + selectedFormularyNdcs.size + ' NDCs) + network (' + selectedNetworkWalletIds.size + ' providers)', true);
        await fetchPlans();
        renderPlanList();
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
        showResult('plan-detail-result', err.message, false);
      }
    };

    // Save & Publish
    var publishBtn = $('plan-detail-publish');
    if (publishBtn) publishBtn.onclick = async function () {
      if (!editingPlanId) return;
      publishBtn.disabled = true;
      publishBtn.textContent = 'Publishing...';
      try {
        await API.updatePlan(editingPlanId, {
          formularyNdcs: Array.from(selectedFormularyNdcs),
          networkProviderWalletIds: Array.from(selectedNetworkWalletIds),
        });
        var result = await API.publishPlan(editingPlanId);
        toast('Plan published: ' + (result.formularyEntryCount || 0) + ' formulary entries, ' + (result.networkProviderCount || 0) + ' network providers', 'success');
        showResult('plan-detail-result', 'Published successfully', true);
        await fetchPlans();
        renderPlanList();
      } catch (err) {
        toast('Publish failed: ' + err.message, 'error');
        showResult('plan-detail-result', err.message, false);
      } finally {
        publishBtn.disabled = false;
        publishBtn.textContent = 'Save & Publish';
      }
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  EMPLOYERS & GROUPS (live from sequencer roster)
  // ═══════════════════════════════════════════════════════════

  var selectedGroup = null;
  var rosterData = null;

  function loadEmployersPage() {
    loadRosterData();
    var refreshBtn = $('emp-refresh-btn');
    if (refreshBtn) refreshBtn.onclick = loadRosterData;
  }

  async function loadRosterData() {
    var listEl = $('emp-list');
    var detailBody = $('emp-detail-body');
    if (listEl) listEl.innerHTML = '<div class="loading">Loading roster from sequencer...</div>';
    try {
      var res = await API.getRoster();
      rosterData = res.data || res;
      var entries = rosterData.entries || [];
      var summary = rosterData.groupSummary || {};

      // Build group list from summary
      var groupIds = Object.keys(summary);
      if (groupIds.length === 0 && entries.length === 0) {
        if (listEl) listEl.innerHTML = '<div class="empty-state">No enrolled members yet. Process enrollments from the Admin tab.</div>';
        return;
      }

      if (listEl) {
        listEl.innerHTML = groupIds.map(function (gid, i) {
          var s = summary[gid];
          var roles = Object.keys(s.roles || {}).map(function (r) { return s.roles[r] + ' ' + r; }).join(', ');
          return '<div class="emp-item' + (selectedGroup === gid ? ' active' : '') + '" onclick="App.selectGroup(\'' + esc(gid) + '\')">' +
            '<div class="emp-avatar">' + esc(gid.charAt(0).toUpperCase()) + '</div>' +
            '<div class="emp-info">' +
              '<div class="emp-name">' + esc(gid) + '</div>' +
              '<div class="emp-sub">' + s.count + ' member' + (s.count !== 1 ? 's' : '') + ' · ' + esc(roles) + '</div>' +
            '</div>' +
          '</div>';
        }).join('');
      }

      // Auto-select first group
      if (!selectedGroup && groupIds.length > 0) selectGroup(groupIds[0]);
    } catch (e) {
      if (listEl) listEl.innerHTML = '<div class="form-result error">Failed to load roster: ' + esc(e.message) + '</div>';
    }
  }

  function selectGroup(gid) {
    selectedGroup = gid;
    loadRosterData(); // re-render to highlight
    renderGroupDetail(gid);
  }

  function renderGroupDetail(gid) {
    var headerEl = $('emp-detail-header');
    var bodyEl = $('emp-detail-body');
    if (!headerEl || !bodyEl || !rosterData) return;

    var entries = (rosterData.entries || []).filter(function (e) { return (e.groupId || 'unassigned') === gid; });
    headerEl.innerHTML = esc(gid) + ' <span style="font-size:12px;color:var(--text-secondary);font-weight:400;margin-left:8px">' + entries.length + ' members</span>';

    if (entries.length === 0) {
      bodyEl.innerHTML = '<div class="empty-state">No members in this group</div>';
      return;
    }

    bodyEl.innerHTML =
      '<table class="data-table"><thead><tr><th>Wallet ID</th><th>Role</th><th>Display Name</th><th>Registered</th></tr></thead><tbody>' +
      entries.map(function (e) {
        return '<tr>' +
          '<td><span class="hash" title="' + esc(e.walletId) + '">' + esc(truncHash(e.walletId, 16)) + '</span></td>' +
          '<td><span class="badge badge-info">' + esc(e.role || 'member') + '</span></td>' +
          '<td>' + esc(e.displayName || '--') + '</td>' +
          '<td style="font-family:var(--font-mono);font-size:12px">' + esc(fmtDate(e.registeredAt)) + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  // ═══════════════════════════════════════════════════════════
  //  ELIGIBILITY
  // ═══════════════════════════════════════════════════════════

  function loadEligibilityPage() {
    loadEligibilityStats();
    initEligibilityActions();
  }

  async function loadEligibilityStats() {
    // Get live roster data from sequencer
    try {
      var res = await API.getRoster();
      var data = res.data || res;
      var entries = data.entries || [];

      // Count by role
      var roleCounts = {};
      entries.forEach(function (e) {
        var r = e.role || 'unknown';
        roleCounts[r] = (roleCounts[r] || 0) + 1;
      });

      var total = data.totalRegistered || entries.length;
      setTextContent('elig-registered', total);
      setTextContent('elig-eligible', total);
      setTextContent('elig-active', data.active || total);
      setTextContent('elig-revoked', data.revoked || 0);

      // Pending enrollments — recently registered entries
      var pendingEl = $('elig-pending-container');
      if (pendingEl) {
        var recent = entries.slice(-10).reverse();
        if (recent.length === 0) {
          pendingEl.innerHTML = '<div class="empty-state">No enrollments</div>';
        } else {
          pendingEl.innerHTML =
            '<table class="data-table"><thead><tr><th>Wallet ID</th><th>Role</th><th>Group</th><th>Registered</th></tr></thead><tbody>' +
            recent.map(function (e) {
              return '<tr>' +
                '<td><span class="hash" title="' + esc(e.walletId) + '">' + esc(truncHash(e.walletId, 16)) + '</span></td>' +
                '<td><span class="badge badge-info">' + esc(e.role || 'member') + '</span></td>' +
                '<td>' + esc(e.groupId || '--') + '</td>' +
                '<td style="font-family:var(--font-mono);font-size:12px">' + esc(fmtDate(e.registeredAt)) + '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';
        }
      }
    } catch (e) {
      setTextContent('elig-registered', '--');
      setTextContent('elig-eligible', '--');
      setTextContent('elig-active', '--');
      setTextContent('elig-revoked', '--');
      var pendingEl = $('elig-pending-container');
      if (pendingEl) pendingEl.innerHTML = '<div class="form-result error">Failed to load roster: ' + esc(e.message) + '</div>';
    }
  }

  function initEligibilityActions() {
    var lookupBtn = $('elig-lookup-btn');
    if (lookupBtn) lookupBtn.onclick = doEligibilityLookup;

    var actionBtn = $('elig-action-btn');
    if (actionBtn) actionBtn.onclick = doEligibilityAction;

    var pendingRefresh = $('elig-pending-refresh');
    if (pendingRefresh) pendingRefresh.onclick = loadEligibilityStats;
  }

  async function doEligibilityLookup() {
    var walletId = ($('elig-wallet') || {}).value || '';
    if (!walletId.trim()) { toast('Enter a wallet ID', 'error'); return; }

    var resultEl = $('elig-lookup-result');
    if (!resultEl) return;
    resultEl.innerHTML = '<div class="loading">Looking up...</div>';

    try {
      var res = await API.getRoster();
      var entries = (res.data || res).entries || [];
      var found = entries.find(function (e) { return e.walletId === walletId.trim(); });

      if (found) {
        resultEl.innerHTML =
          '<div class="member-card">' +
            '<div class="member-card-header">' +
              '<span class="member-card-wallet" title="' + esc(found.walletId) + '">' + esc(truncHash(found.walletId, 20)) + '</span>' +
              '<span class="badge badge-info">' + esc(found.role || 'member') + '</span>' +
            '</div>' +
            '<div class="detail-grid">' +
              '<div class="detail-key">Display Name</div><div class="detail-val">' + esc(found.displayName || '--') + '</div>' +
              '<div class="detail-key">Group</div><div class="detail-val">' + esc(found.groupId || '--') + '</div>' +
              '<div class="detail-key">Employer</div><div class="detail-val">' + esc(found.employerId || '--') + '</div>' +
              '<div class="detail-key">Registered</div><div class="detail-val">' + esc(fmtDate(found.registeredAt)) + '</div>' +
            '</div>' +
          '</div>';
      } else {
        resultEl.innerHTML = '<div class="form-result error">Wallet not found in enrolled members</div>';
      }
    } catch (e) {
      resultEl.innerHTML = '<div class="form-result error">Lookup failed: ' + esc(e.message) + '</div>';
    }
  }

  async function doEligibilityAction() {
    var wallet = ($('elig-action-wallet') || {}).value || '';
    var action = ($('elig-action-type') || {}).value || 'promote';
    var reason = ($('elig-action-reason') || {}).value || '';

    if (!wallet.trim()) { toast('Enter a wallet ID', 'error'); return; }

    try {
      if (action === 'revoke') {
        await API.terminateProvider(wallet.trim());
        toast('Member revoked' + (reason ? ': ' + reason : ''), 'info');
      } else {
        // Register/re-register via roster
        await API.registerRoster(wallet.trim(), 'member');
        toast('Member registered', 'success');
      }
      loadEligibilityStats();
      showResult('elig-action-result', (action === 'revoke' ? 'Revoked' : 'Registered') + ' ' + truncHash(wallet.trim()), true);
    } catch (e) {
      toast('Action failed: ' + e.message, 'error');
      showResult('elig-action-result', e.message, false);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  CREDENTIALING (H6)
  // ═══════════════════════════════════════════════════════════

  function loadCredentialingPage() {
    loadProviderRegistry();
    loadCredentialingApps();
    initCredentialingActions();
  }

  function initCredentialingActions() {
    var regRefresh = $('cred-registry-refresh');
    if (regRefresh) regRefresh.onclick = loadProviderRegistry;
    var appRefresh = $('cred-app-refresh');
    if (appRefresh) appRefresh.onclick = loadCredentialingApps;
    var roleFilter = $('cred-role-filter');
    if (roleFilter) roleFilter.onchange = loadProviderRegistry;
    var appFilter = $('cred-app-filter');
    if (appFilter) appFilter.onchange = loadCredentialingApps;
    var lookupBtn = $('cred-lookup-btn');
    if (lookupBtn) lookupBtn.onclick = doCredentialingLookup;
  }

  async function loadProviderRegistry() {
    var el = $('cred-registry-container');
    var statsEl = $('cred-stats');
    if (!el) return;
    el.innerHTML = '<div class="loading">Loading provider registry...</div>';
    try {
      var role = ($('cred-role-filter') || {}).value || '';
      var res = await API.getProviderRegistry(role || undefined);
      var data = res.data || res;
      var providers = Array.isArray(data) ? data : (data.providers || data.entries || []);

      // Stats
      if (statsEl) {
        var prescribers = providers.filter(function (p) { return p.providerType === 'prescriber' || p.metadata?.providerType === 'prescriber'; }).length;
        var pharmacies = providers.filter(function (p) { return p.providerType === 'pharmacy' || p.metadata?.providerType === 'pharmacy'; }).length;
        statsEl.innerHTML =
          '<div class="stat-card"><span class="stat-label">Total Providers</span><span class="stat-value">' + providers.length + '</span></div>' +
          '<div class="stat-card"><span class="stat-label">Prescribers</span><span class="stat-value">' + prescribers + '</span></div>' +
          '<div class="stat-card"><span class="stat-label">Pharmacies</span><span class="stat-value">' + pharmacies + '</span></div>';
      }

      if (providers.length === 0) {
        el.innerHTML = '<div class="empty-state">No providers in registry' + (role ? ' (filtered by ' + esc(role) + ')' : '') + '</div>';
        return;
      }

      el.innerHTML =
        '<table class="data-table"><thead><tr>' +
          '<th>Wallet ID</th><th>Name</th><th>Type</th><th>NPI</th><th>State</th><th>Actions</th>' +
        '</tr></thead><tbody>' +
        providers.map(function (p) {
          var meta = p.metadata || p;
          var wid = p.walletId || meta.walletId || (p.leaf && p.leaf.walletId) || '--';
          var name = meta.displayName || '--';
          var type = meta.providerType || '--';
          var npi = meta.npi || '--';
          var state = meta.credentialState || p.credentialState || '--';
          return '<tr>' +
            '<td><span class="hash" title="' + esc(wid) + '">' + esc(truncHash(wid, 14)) + '</span></td>' +
            '<td>' + esc(name) + '</td>' +
            '<td><span class="badge badge-info">' + esc(type) + '</span></td>' +
            '<td style="font-family:var(--font-mono)">' + esc(npi) + '</td>' +
            '<td>' + esc(state) + '</td>' +
            '<td>' +
              '<button class="btn btn-sm" onclick="App.suspendProvider(\'' + esc(wid) + '\')">Suspend</button> ' +
              '<button class="btn btn-sm btn-danger" onclick="App.terminateProvider(\'' + esc(wid) + '\')">Terminate</button>' +
            '</td></tr>';
        }).join('') +
        '</tbody></table>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">Failed to load registry: ' + esc(e.message) + '</div>';
    }
  }

  async function loadCredentialingApps() {
    var el = $('cred-app-container');
    if (!el) return;
    el.innerHTML = '<div class="loading">Loading applications...</div>';
    try {
      var status = ($('cred-app-filter') || {}).value || '';
      var res = await API.getCredentialingApplications(status || undefined);
      var data = res.data || res;
      var apps = data.applications || (Array.isArray(data) ? data : []);

      if (apps.length === 0) {
        el.innerHTML = '<div class="empty-state">No applications' + (status ? ' with status "' + esc(status) + '"' : '') + '</div>';
        return;
      }

      el.innerHTML =
        '<table class="data-table"><thead><tr>' +
          '<th>Application ID</th><th>Name</th><th>Type</th><th>NPI</th><th>Status</th><th>Submitted</th><th>Actions</th>' +
        '</tr></thead><tbody>' +
        apps.map(function (a) {
          var statusClass = a.status === 'approved' ? 'badge-ready' : a.status === 'denied' ? 'badge-error' : a.status === 'verified' ? 'badge-info' : 'badge-pending';
          return '<tr>' +
            '<td style="font-family:var(--font-mono);font-size:12px">' + esc(truncHash(a.applicationId, 20)) + '</td>' +
            '<td>' + esc(a.displayName) + '</td>' +
            '<td><span class="badge badge-info">' + esc(a.providerType) + '</span></td>' +
            '<td style="font-family:var(--font-mono)">' + esc(a.npi) + '</td>' +
            '<td><span class="badge ' + statusClass + '">' + esc(a.status) + '</span></td>' +
            '<td style="font-family:var(--font-mono);font-size:12px">' + esc(fmtDate(a.submittedAt)) + '</td>' +
            '<td>' + credAppActions(a) + '</td></tr>';
        }).join('') +
        '</tbody></table>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">Failed to load applications: ' + esc(e.message) + '</div>';
    }
  }

  function credAppActions(app) {
    var btns = [];
    if (app.status === 'pending') {
      btns.push('<button class="btn btn-sm" onclick="App.verifyApp(\'' + esc(app.applicationId) + '\')">Verify</button>');
      btns.push('<button class="btn btn-sm btn-danger" onclick="App.denyApp(\'' + esc(app.applicationId) + '\')">Deny</button>');
    }
    if (app.status === 'verified' || app.status === 'pending') {
      btns.push('<button class="btn btn-sm btn-primary" onclick="App.approveApp(\'' + esc(app.applicationId) + '\')">Approve</button>');
    }
    return btns.join(' ') || '--';
  }

  async function doCredentialingLookup() {
    var wallet = ($('cred-lookup-wallet') || {}).value || '';
    if (!wallet.trim()) { toast('Enter a wallet ID', 'error'); return; }
    var el = $('cred-lookup-result');
    if (!el) return;
    el.innerHTML = '<div class="loading">Looking up...</div>';
    try {
      var res = await API.getCredentialingStatus(wallet.trim());
      var data = res.data || res;
      el.innerHTML = '<div class="detail-grid" style="margin-top:12px">' +
        Object.keys(data).map(function (k) {
          var v = data[k];
          var display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
          return '<div class="detail-key">' + esc(k) + '</div><div class="detail-val">' + esc(display) + '</div>';
        }).join('') + '</div>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">' + esc(e.message) + '</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  REPORTS (M5 — UI for 12 report endpoints)
  // ═══════════════════════════════════════════════════════════

  function loadReportsPage() {
    var btn = $('rpt-generate-btn');
    if (btn) btn.onclick = doGenerateReport;
  }

  async function doGenerateReport() {
    var type = ($('rpt-type') || {}).value || 'claims-register';
    var source = ($('rpt-source') || {}).value || 'member';
    var sourceId = ($('rpt-source-id') || {}).value || '';

    if (!sourceId.trim()) { toast('Enter a source ID', 'error'); return; }

    var resultsPanel = $('rpt-results-panel');
    var resultsEl = $('rpt-results');
    var typeBadge = $('rpt-type-badge');
    if (!resultsPanel || !resultsEl) return;

    resultsPanel.classList.remove('hidden');
    resultsEl.innerHTML = '<div class="loading">Fetching claims and generating report...</div>';
    if (typeBadge) typeBadge.textContent = type;

    try {
      // Step 1: Fetch claims by source type
      var claims;
      switch (source) {
        case 'member': claims = await API.getMemberClaims(sourceId.trim()); break;
        case 'pharmacy': claims = await API.getPharmacyClaims(sourceId.trim()); break;
        case 'prescriber': claims = await API.getPrescriberClaims(sourceId.trim()); break;
        case 'drug': claims = await API.getDrugClaims(sourceId.trim()); break;
      }
      var claimsList = Array.isArray(claims) ? claims : (claims && claims.data ? claims.data : []);

      if (claimsList.length === 0) {
        resultsEl.innerHTML = '<div class="empty-state">No claims found for this source. Cannot generate report.</div>';
        return;
      }

      // Step 2: POST claims to report endpoint
      var reportData;
      var url = '/reports/' + type;
      var body = { claims: claimsList };
      var res = await fetch(location.origin + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': API.getAdminToken() ? 'Bearer ' + API.getAdminToken() : '' },
        body: JSON.stringify(body),
      });
      var json = await res.json();
      reportData = (json && json.data) || json;

      // Step 3: Render report
      resultsEl.innerHTML = renderReportData(reportData, type);
      toast('Report generated: ' + type, 'success');
    } catch (e) {
      resultsEl.innerHTML = '<div class="form-result error">Report failed: ' + esc(e.message) + '</div>';
    }
  }

  function renderReportData(data, type) {
    if (!data) return '<div class="empty-state">No data</div>';

    // Try to render as table if array
    if (Array.isArray(data)) {
      if (data.length === 0) return '<div class="empty-state">Report returned empty results</div>';
      var keys = Object.keys(data[0]);
      return '<div style="max-height:500px;overflow:auto">' +
        '<table class="data-table"><thead><tr>' +
        keys.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        data.slice(0, 200).map(function (row) {
          return '<tr>' + keys.map(function (k) {
            var v = row[k];
            var display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v != null ? v : '--');
            return '<td style="font-size:12px">' + esc(display) + '</td>';
          }).join('') + '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    // Render as key-value pairs
    if (typeof data === 'object') {
      var keys = Object.keys(data);
      return '<div class="detail-grid">' +
        keys.map(function (k) {
          var v = data[k];
          if (Array.isArray(v)) return '<div class="detail-key">' + esc(k) + '</div><div class="detail-val">' + v.length + ' items</div>';
          var display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
          return '<div class="detail-key">' + esc(k) + '</div><div class="detail-val">' + esc(display) + '</div>';
        }).join('') + '</div>';
    }

    return '<pre style="white-space:pre-wrap;font-size:12px">' + esc(JSON.stringify(data, null, 2)) + '</pre>';
  }

  // ═══════════════════════════════════════════════════════════
  //  PRICING
  // ═══════════════════════════════════════════════════════════

  function initPricing() {
    var btn = $('price-estimate-btn');
    if (btn) btn.onclick = doPriceEstimate;
  }

  function doPriceEstimate() {
    var ndcHash = ($('price-ndc') || {}).value || '';
    var ingredientCost = Number(($('price-ingredient') || {}).value) || 0;
    var qty = Number(($('price-qty') || {}).value) || 30;
    var memberWallet = ($('price-member') || {}).value || '';
    var pharmacyWallet = ($('price-pharmacy') || {}).value || '';
    var planIdHash = ($('price-plan') || {}).value || '';

    if (!ndcHash.trim()) { toast('NDC Hash is required', 'error'); return; }

    // Look up formulary entry
    var entry = formularyData.find(function (f) { return f.ndcHash === ndcHash.trim(); });

    var resultEl = $('price-result');
    if (!resultEl) return;

    if (!entry) {
      resultEl.innerHTML = '<div class="form-result error">NDC Hash not found in formulary. Cannot estimate cost.</div>';
      return;
    }

    // Settlement logic: patientPay = min(totalCost, copayAmount), planPay = totalCost - patientPay
    var totalCost = ingredientCost;
    var copay = entry.copayAmountCents;
    var patientPay = Math.min(totalCost, copay);
    var planPay = totalCost - patientPay;

    var estimate = {
      ndcHash: ndcHash.trim(),
      brandName: entry.brandName,
      tier: entry.tierLevel,
      copay: copay,
      ingredientCost: ingredientCost,
      totalCost: totalCost,
      patientPay: patientPay,
      planPay: planPay,
      qty: qty,
      priorAuth: entry.requiresPriorAuth,
      timestamp: new Date().toISOString(),
    };

    resultEl.innerHTML =
      '<div class="price-result-card">' +
        '<div class="price-result-header">Cost Estimate: ' + esc(entry.brandName || truncHash(ndcHash, 16)) + '</div>' +
        '<div class="price-breakdown">' +
          '<div class="price-item"><div class="price-item-label">Patient Pays</div><div class="price-item-value patient">' + fmtCents(patientPay) + '</div></div>' +
          '<div class="price-item"><div class="price-item-label">Plan Pays</div><div class="price-item-value plan">' + fmtCents(planPay) + '</div></div>' +
          '<div class="price-item"><div class="price-item-label">Total Cost</div><div class="price-item-value total">' + fmtCents(totalCost) + '</div></div>' +
        '</div>' +
        '<div class="detail-grid" style="margin-top:12px">' +
          '<div class="detail-key">Tier</div><div class="detail-val">T' + entry.tierLevel + '</div>' +
          '<div class="detail-key">Plan Copay</div><div class="detail-val">' + fmtCents(copay) + '</div>' +
          '<div class="detail-key">Quantity</div><div class="detail-val">' + qty + '</div>' +
          '<div class="detail-key">Prior Auth Required</div><div class="detail-val">' + (entry.requiresPriorAuth ? 'Yes' : 'No') + '</div>' +
        '</div>' +
      '</div>';

    // Add to history
    priceHistory.unshift(estimate);
    if (priceHistory.length > 20) priceHistory.pop();
    renderPriceHistory();
    toast('Estimate calculated', 'success');
  }

  function renderPriceHistory() {
    var el = $('price-history');
    if (!el) return;
    if (priceHistory.length === 0) {
      el.innerHTML = '<div class="empty-state">Run an estimate above to see results here</div>';
      return;
    }
    el.innerHTML = priceHistory.map(function (e) {
      return '<div class="price-history-item">' +
        '<span class="price-history-ndc" title="' + esc(e.ndcHash) + '">' + esc(e.brandName || truncHash(e.ndcHash, 12)) + '</span>' +
        '<span class="badge tier-' + e.tier + '">T' + e.tier + '</span>' +
        '<span style="color:var(--text-muted);font-size:12px">' + fmtDate(e.timestamp).split(',')[1] + '</span>' +
        '<span class="price-history-split">' +
          '<span style="color:var(--yellow)">' + fmtCents(e.patientPay) + '</span> / ' +
          '<span style="color:var(--green)">' + fmtCents(e.planPay) + '</span>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════
  //  CLAIMS
  // ═══════════════════════════════════════════════════════════

  function initClaims() {
    var btn = $('cl-query-btn');
    if (btn) btn.onclick = doQueryClaims;
  }

  async function doQueryClaims() {
    var type = ($('cl-type') || {}).value || 'member';
    var id = ($('cl-id') || {}).value || '';
    if (!id.trim()) { toast('Enter an ID to query', 'error'); return; }

    var resultsPanel = $('cl-results-panel');
    var resultsEl = $('cl-results');
    var countBadge = $('cl-count');
    if (!resultsPanel || !resultsEl) return;

    resultsPanel.classList.remove('hidden');
    resultsEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var data;
      switch (type) {
        case 'member': data = await API.getMemberClaims(id.trim()); break;
        case 'prescriber': data = await API.getPrescriberClaims(id.trim()); break;
        case 'pharmacy': data = await API.getPharmacyClaims(id.trim()); break;
        case 'drug': data = await API.getDrugClaims(id.trim()); break;
      }
      var claims = Array.isArray(data) ? data : (data && data.data ? data.data : []);
      if (countBadge) countBadge.textContent = claims.length + ' results';

      if (claims.length === 0) {
        resultsEl.innerHTML = '<div class="empty-state">No claims found for this ' + type + '</div>';
        return;
      }

      resultsEl.innerHTML =
        '<table class="data-table"><thead><tr>' +
          '<th>#</th><th>Member</th><th>NDC Hash</th><th>Patient Pay</th><th>Plan Pay</th><th>Date</th>' +
        '</tr></thead><tbody>' +
        claims.map(function (c, i) {
          return '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td><span class="hash" title="' + esc(c.memberWalletId || c.walletId) + '">' + esc(truncHash(c.memberWalletId || c.walletId, 14)) + '</span></td>' +
            '<td><span class="hash" title="' + esc(c.ndcHash) + '">' + esc(truncHash(c.ndcHash, 14)) + '</span></td>' +
            '<td style="font-family:var(--font-mono)">' + (c.patientPayCents != null ? fmtCents(c.patientPayCents) : '--') + '</td>' +
            '<td style="font-family:var(--font-mono)">' + (c.planPayCents != null ? fmtCents(c.planPayCents) : '--') + '</td>' +
            '<td style="font-family:var(--font-mono);font-size:12px">' + esc(c.dateOfService || fmtDate(c.timestamp)) + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    } catch (e) {
      resultsEl.innerHTML = '<div class="form-result error">Query failed: ' + esc(e.message) + '</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  AUDIT
  // ═══════════════════════════════════════════════════════════

  function loadAuditPage() {
    initAuditChecks();
    loadAuditLog();
    loadChainProof();
  }

  function initAuditChecks() {
    var chainCard = $('audit-chain-card');
    var finCard = $('audit-finance-card');
    var dupCard = $('audit-dup-card');
    if (chainCard) chainCard.onclick = doChainIntegrity;
    if (finCard) finCard.onclick = doFinancialBalance;
    if (dupCard) dupCard.onclick = doDuplicateClaims;

    var logRefresh = $('audit-log-refresh');
    var proofRefresh = $('audit-proof-refresh');
    if (logRefresh) logRefresh.onclick = loadAuditLog;
    if (proofRefresh) proofRefresh.onclick = loadChainProof;
  }

  async function doChainIntegrity() {
    var el = $('audit-chain-val');
    var card = $('audit-chain-card');
    if (el) el.textContent = '...';
    if (card) card.className = 'stat-card stat-clickable check-running';
    try {
      var res = await API.verifyChainIntegrity();
      var data = res.data || res;
      var ok = data.isValid || data.valid || data.integrity || data.ok;
      if (el) el.textContent = ok ? 'PASS' : 'FAIL';
      if (card) card.className = 'stat-card stat-clickable ' + (ok ? 'check-pass' : 'check-fail');
      toast('Chain integrity: ' + (ok ? 'PASS' : 'FAIL'), ok ? 'success' : 'error');
    } catch (e) {
      if (el) el.textContent = 'Error';
      if (card) card.className = 'stat-card stat-clickable check-fail';
      toast('Chain integrity check failed: ' + e.message, 'error');
    }
  }

  async function doFinancialBalance() {
    var el = $('audit-finance-val');
    var card = $('audit-finance-card');
    if (el) el.textContent = '...';
    if (card) card.className = 'stat-card stat-clickable check-running';
    try {
      var res = await API.verifyFinancialBalance();
      var data = res.data || res;
      var ok = data.isValid || data.balanced || data.valid || data.ok;
      if (el) el.textContent = ok ? 'PASS' : 'FAIL';
      if (card) card.className = 'stat-card stat-clickable ' + (ok ? 'check-pass' : 'check-fail');
      toast('Financial balance: ' + (ok ? 'PASS' : 'FAIL'), ok ? 'success' : 'error');
    } catch (e) {
      if (el) el.textContent = 'Error';
      if (card) card.className = 'stat-card stat-clickable check-fail';
      toast('Financial balance check failed: ' + e.message, 'error');
    }
  }

  async function doDuplicateClaims() {
    var el = $('audit-dup-val');
    var card = $('audit-dup-card');
    if (el) el.textContent = '...';
    if (card) card.className = 'stat-card stat-clickable check-running';
    try {
      var res = await API.detectDuplicateClaims();
      var data = res.data || res;
      var count = data.totalDuplicates !== undefined ? data.totalDuplicates : (data.duplicateCount !== undefined ? data.duplicateCount : (Array.isArray(data.duplicateGroups || data.duplicates) ? (data.duplicateGroups || data.duplicates).length : 0));
      if (el) el.textContent = count === 0 ? 'None' : String(count);
      if (card) card.className = 'stat-card stat-clickable ' + (count === 0 ? 'check-pass' : 'check-fail');
      toast('Duplicate claims: ' + count, count === 0 ? 'success' : 'error');
    } catch (e) {
      if (el) el.textContent = 'Error';
      if (card) card.className = 'stat-card stat-clickable check-fail';
      toast('Duplicate claim check failed: ' + e.message, 'error');
    }
  }

  async function loadAuditLog() {
    var el = $('audit-log-container');
    if (!el) return;
    el.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var res = await API.getAuditLog(50, 0);
      var data = res.data || res;
      var events = data.events || (Array.isArray(data) ? data : []);
      if (events.length === 0) {
        el.innerHTML = '<div class="empty-state">No audit events</div>';
        return;
      }
      el.innerHTML =
        '<div style="max-height:350px;overflow-y:auto">' +
        '<table class="data-table"><thead><tr><th>#</th><th>Wallet</th><th>Type</th><th>Seq</th><th>Chain Hash</th></tr></thead><tbody>' +
        events.map(function (e, i) {
          return '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td><span class="hash">' + esc(truncHash(e.walletId, 14)) + '</span></td>' +
            '<td>' + esc(e.isRegistration ? 'Registration' : 'Update') + '</td>' +
            '<td style="font-family:var(--font-mono)">' + esc(e.sequenceNumber !== undefined ? e.sequenceNumber : '--') + '</td>' +
            '<td><span class="hash">' + esc(truncHash(e.chainHash, 14)) + '</span></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">Failed to load audit log: ' + esc(e.message) + '</div>';
    }
  }

  async function loadChainProof() {
    var el = $('audit-proof-container');
    if (!el) return;
    el.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var res = await API.getChainProof();
      var data = res.data || res;
      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        el.innerHTML = '<div class="empty-state">No chain proof available</div>';
        return;
      }
      var keys = Object.keys(data);
      el.innerHTML =
        '<div class="detail-grid">' +
        keys.map(function (k) {
          var v = data[k];
          var display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
          return '<div class="detail-key">' + esc(k) + '</div><div class="detail-val">' + esc(display) + '</div>';
        }).join('') +
        '</div>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">No chain proof: ' + esc(e.message) + '</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  ADMIN
  // ═══════════════════════════════════════════════════════════

  function loadAdminPage() {
    initAdminTokenBar();
    loadAdminHealth();
    loadMsgStoreStatus();
    initAdminActions();
  }

  function initAdminTokenBar() {
    var setBtn = $('admin-set-token');
    var input = $('admin-token-input');
    if (setBtn && input) {
      // Restore saved token
      var saved = API.getAdminToken();
      if (saved) input.value = saved;
      setBtn.onclick = function () {
        API.setAdminToken(input.value.trim());
        toast('Admin token updated', 'info');
      };
    }
  }

  function initAdminActions() {
    var forceBatchBtn = $('admin-force-batch');
    if (forceBatchBtn) forceBatchBtn.onclick = doForceBatch;

    var enrollBtn = $('admin-enr-btn');
    if (enrollBtn) enrollBtn.onclick = doProcessEnrollment;

    var healthRefresh = $('admin-health-refresh');
    if (healthRefresh) healthRefresh.onclick = loadAdminHealth;

    var msgRefresh = $('admin-msg-refresh');
    if (msgRefresh) msgRefresh.onclick = loadMsgStoreStatus;

    var msgLookupBtn = $('admin-msg-lookup');
    if (msgLookupBtn) msgLookupBtn.onclick = doMsgLookup;
  }

  async function loadAdminHealth() {
    var el = $('admin-health-container');
    if (!el) return;
    el.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var data = await API.getHealth();
      var obj = data.data || data;
      var keys = Object.keys(obj);
      el.innerHTML =
        '<div class="detail-grid">' +
        keys.map(function (k) {
          var v = obj[k];
          var display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
          return '<div class="detail-key">' + esc(k) + '</div><div class="detail-val">' + esc(display) + '</div>';
        }).join('') +
        '</div>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">Health check failed: ' + esc(e.message) + '</div>';
    }
  }

  async function doForceBatch() {
    var btn = $('admin-force-batch');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Forcing...';
    try {
      await API.forceBatch();
      toast('Batch forced successfully', 'success');
      showResult('admin-action-result', 'Batch forced at ' + new Date().toLocaleTimeString(), true);
    } catch (e) {
      toast('Force batch failed: ' + e.message, 'error');
      showResult('admin-action-result', e.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Force Batch';
    }
  }

  async function doProcessEnrollment() {
    var wallet = ($('admin-enr-wallet') || {}).value || '';
    var token = ($('admin-enr-token') || {}).value || '';
    var role = ($('admin-enr-role') || {}).value || 'member';

    if (!wallet.trim()) { toast('Wallet ID is required', 'error'); return; }

    var btn = $('admin-enr-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }
    try {
      await API.processEnrollment(wallet.trim(), token.trim() || undefined, role);
      toast('Enrollment processed', 'success');
      showResult('admin-enr-result', 'Enrolled ' + wallet.trim() + ' as ' + role, true);
    } catch (e) {
      toast('Enrollment failed: ' + e.message, 'error');
      showResult('admin-enr-result', e.message, false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Process Enrollment'; }
    }
  }

  async function loadMsgStoreStatus() {
    var el = $('admin-msg-status');
    if (!el) return;
    el.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var res = await API.getMessageStoreStatus();
      var data = res.data || res;
      var keys = Object.keys(data);
      el.innerHTML =
        '<div class="detail-grid">' +
        keys.map(function (k) {
          var v = data[k];
          var display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
          return '<div class="detail-key">' + esc(k) + '</div><div class="detail-val">' + esc(display) + '</div>';
        }).join('') +
        '</div>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">Failed: ' + esc(e.message) + '</div>';
    }
  }

  async function doMsgLookup() {
    var walletId = ($('admin-msg-wallet') || {}).value || '';
    if (!walletId.trim()) { toast('Enter a wallet ID', 'error'); return; }

    var el = $('admin-msg-results');
    if (!el) return;
    el.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var res = await API.getMessagesByWallet(walletId.trim());
      var messages = Array.isArray(res) ? res : (res.data || []);
      if (messages.length === 0) {
        el.innerHTML = '<div class="empty-state">No messages found for this wallet</div>';
        return;
      }
      el.innerHTML =
        '<table class="data-table" style="margin-top:12px"><thead><tr>' +
          '<th>#</th><th>Sender</th><th>Recipient</th><th>Thread</th><th>Timestamp</th>' +
        '</tr></thead><tbody>' +
        messages.map(function (m, i) {
          return '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td><span class="hash">' + esc(truncHash(m.senderWalletId || m.sender, 14)) + '</span></td>' +
            '<td><span class="hash">' + esc(truncHash(m.recipientWalletId || m.recipient, 14)) + '</span></td>' +
            '<td><span class="hash">' + esc(truncHash(m.threadIdHash || m.threadId, 14)) + '</span></td>' +
            '<td style="font-family:var(--font-mono);font-size:12px">' + esc(fmtDate(m.timestamp || m.storedAt)) + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    } catch (e) {
      el.innerHTML = '<div class="form-result error">Lookup failed: ' + esc(e.message) + '</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  SSE + CONNECTION
  // ═══════════════════════════════════════════════════════════

  function initSSE() {
    API.connectSSE(function (event) {
      if (!event.timestamp) event.timestamp = Date.now();
      sseEvents.push(event);
      sseCount++;
      if (sseEvents.length > 200) sseEvents = sseEvents.slice(-200);
      setTextContent('ov-sse-count', sseCount);
      renderEventLog();
    });
    API.onConnectionChange(function (state) {
      var dot = $('connection-dot');
      if (dot) dot.className = 'connection-dot ' + state;
    });
  }

  function renderEventLog() {
    var el = $('ov-events');
    if (!el) return;
    if (sseEvents.length === 0) {
      el.innerHTML = '<div class="empty-state">Waiting for events...</div>';
      return;
    }
    el.innerHTML = sseEvents.slice(-50).reverse().map(function (ev) {
      var time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '--';
      var type = ev.type || ev.event || 'event';
      var data = ev.data || ev.message || JSON.stringify(ev).slice(0, 120);
      return '<div class="event-item">' +
        '<span class="event-time">' + esc(time) + '</span>' +
        '<span class="event-type">' + esc(type) + '</span>' +
        '<span class="event-data">' + esc(String(data)) + '</span>' +
      '</div>';
    }).join('');
  }

  async function checkConnection() {
    var dot = $('connection-dot');
    var ok = await API.checkConnection();
    if (dot) dot.className = 'connection-dot ' + (ok ? 'connected' : 'disconnected');
  }

  // ═══════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════

  async function init() {
    await loadPlans();
    await loadFormularyFromSequencer();
    checkConnection();
    initSSE();
    initPricing();
    initClaims();
    navigate(location.hash.replace('#', '') || 'overview');
  }

  // Expose to window for onclick handlers in HTML
  window.App = {
    removeFormularyEntry: removeFormularyEntry,
    selectGroup: selectGroup,
    suspendProvider: async function (wid) {
      if (!confirm('Suspend provider ' + wid.slice(0, 16) + '...?')) return;
      try { await API.suspendProvider(wid); toast('Provider suspended', 'success'); loadProviderRegistry(); }
      catch (e) { toast('Failed: ' + e.message, 'error'); }
    },
    terminateProvider: async function (wid) {
      if (!confirm('Terminate provider ' + wid.slice(0, 16) + '...? This is permanent.')) return;
      try { await API.terminateProvider(wid); toast('Provider terminated', 'success'); loadProviderRegistry(); }
      catch (e) { toast('Failed: ' + e.message, 'error'); }
    },
    verifyApp: async function (appId) {
      try { await API.verifyApplication(appId); toast('Application verified', 'success'); loadCredentialingApps(); }
      catch (e) { toast('Failed: ' + e.message, 'error'); }
    },
    approveApp: async function (appId) {
      var walletId = prompt('Enter provider wallet ID to credential:');
      if (!walletId) return;
      try { await API.approveApplication(appId, walletId); toast('Application approved & credentialed', 'success'); loadCredentialingApps(); loadProviderRegistry(); }
      catch (e) { toast('Failed: ' + e.message, 'error'); }
    },
    denyApp: async function (appId) {
      var reason = prompt('Denial reason (optional):');
      try { await API.denyApplication(appId, reason || 'Denied by insurer'); toast('Application denied', 'info'); loadCredentialingApps(); }
      catch (e) { toast('Failed: ' + e.message, 'error'); }
    },
  };

  init();
})();
