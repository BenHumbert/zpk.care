// zkp.Care Insurer Dashboard — SPA Application Logic
// Overview, Formulary, Plans, Employers & Groups, Eligibility, Pricing, Claims, Audit, Admin.

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var sseEvents = [];
  var sseCount = 0;
  var formularyData = [];       // cached formulary entries (localStorage)
  var planData = [];             // cached plans (localStorage)
  var employerData = [];         // demo employers/groups
  var priceHistory = [];         // recent pricing estimates
  var FORM_KEY = 'zkp_insurer_formulary';
  var PLAN_KEY = 'zkp_insurer_plans';

  // ── Demo Employers & Groups ────────────────────────────────
  var EMPLOYERS = [
    {
      id: 'EMP-001', name: 'Acme Corporation', industry: 'Technology', state: 'CA',
      groups: [
        { id: 'GRP-001', name: 'Acme Engineering', planId: 'PLAN-GOLD-001', members: [
          { walletId: '18927346501...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '29038475612...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '37482910563...', lifecycle: 'ELIGIBLE', role: 'member' },
        ]},
        { id: 'GRP-002', name: 'Acme Sales', planId: 'PLAN-SILVER-002', members: [
          { walletId: '48219305746...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '52948371065...', lifecycle: 'REGISTERED', role: 'member' },
        ]},
      ]
    },
    {
      id: 'EMP-002', name: 'Global Health Partners', industry: 'Healthcare', state: 'NY',
      groups: [
        { id: 'GRP-003', name: 'GHP Clinical Staff', planId: 'PLAN-PLATINUM-003', members: [
          { walletId: '61039284756...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '72940185637...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '83051296748...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '94162307859...', lifecycle: 'REVOKED', role: 'member' },
        ]},
      ]
    },
    {
      id: 'EMP-003', name: 'Pinnacle Manufacturing', industry: 'Manufacturing', state: 'TX',
      groups: [
        { id: 'GRP-004', name: 'Pinnacle Factory Floor', planId: 'PLAN-BRONZE-004', members: [
          { walletId: '10527384961...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '21638495072...', lifecycle: 'ELIGIBLE', role: 'member' },
        ]},
        { id: 'GRP-005', name: 'Pinnacle Office Staff', planId: 'PLAN-GOLD-001', members: [
          { walletId: '32749506183...', lifecycle: 'ACTIVE', role: 'member' },
        ]},
      ]
    },
    {
      id: 'EMP-004', name: 'Summit Financial Group', industry: 'Finance', state: 'IL',
      groups: [
        { id: 'GRP-006', name: 'Summit Advisors', planId: 'PLAN-PLATINUM-003', members: [
          { walletId: '43850617294...', lifecycle: 'ACTIVE', role: 'member' },
          { walletId: '54961728305...', lifecycle: 'ACTIVE', role: 'member' },
        ]},
      ]
    },
  ];

  // ── Demo Formulary Seed ────────────────────────────────────
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

  // ── localStorage persistence ───────────────────────────────
  function loadFormulary() {
    try {
      var raw = localStorage.getItem(FORM_KEY);
      formularyData = raw ? JSON.parse(raw) : DEFAULT_FORMULARY.slice();
    } catch (e) { formularyData = DEFAULT_FORMULARY.slice(); }
  }

  function saveFormulary() {
    localStorage.setItem(FORM_KEY, JSON.stringify(formularyData));
  }

  function loadPlans() {
    try {
      var raw = localStorage.getItem(PLAN_KEY);
      planData = raw ? JSON.parse(raw) : DEFAULT_PLANS.slice();
    } catch (e) { planData = DEFAULT_PLANS.slice(); }
  }

  function savePlans() {
    localStorage.setItem(PLAN_KEY, JSON.stringify(planData));
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

  function loadFormularyPage() {
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

    saveFormulary();

    // Attempt to publish to sequencer via RPC
    var publishBtn = $('form-publish-btn');
    if (publishBtn) { publishBtn.disabled = true; publishBtn.textContent = 'Publishing...'; }
    try {
      var entriesJson = JSON.stringify(formularyData);
      // Use a default plan ID hash or derive from first plan
      var planIdHash = (planData.length > 0 ? planData[0].id : 'default-plan');
      // formularyRoot is computed server-side; send '0' as placeholder
      await API.publishFormulary(planIdHash, '0', entriesJson);
      toast('Published ' + added + ' new, ' + updated + ' updated to sequencer', 'success');
      showResult('form-upload-result', 'Published to sequencer: ' + (added + updated) + ' formulary entries', true);
    } catch (e) {
      // Local save succeeded even if sequencer publish fails
      toast('Saved locally. Sequencer publish: ' + e.message, 'info');
      showResult('form-upload-result', 'Saved locally (' + (added + updated) + ' entries). Sequencer: ' + e.message, false);
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
    saveFormulary();
    renderTierStats();
    renderFormularyTable();
    toast('Entry added to formulary', 'success');
    showResult('form-add-result', 'Added ' + (brand || ndc.trim()), true);
    if ($('form-ndc')) $('form-ndc').value = '';
    if ($('form-brand')) $('form-brand').value = '';
  }

  function removeFormularyEntry(idx) {
    if (idx >= 0 && idx < formularyData.length) {
      var name = formularyData[idx].brandName || formularyData[idx].ndcHash;
      formularyData.splice(idx, 1);
      saveFormulary();
      renderTierStats();
      renderFormularyTable();
      toast('Removed ' + name, 'info');
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  PLANS
  // ═══════════════════════════════════════════════════════════

  function loadPlansPage() {
    renderPlanList();
    initPlanCreate();
  }

  function renderPlanList() {
    var el = $('plan-list-container');
    if (!el) return;
    if (planData.length === 0) {
      el.innerHTML = '<div class="empty-state">No plans registered yet</div>';
      return;
    }
    el.innerHTML =
      '<table class="data-table"><thead><tr>' +
        '<th>Plan ID</th><th>Name</th><th>Copay</th><th>Deductible</th><th>OOP Max</th><th>Annual Max</th><th>Coverage</th>' +
      '</tr></thead><tbody>' +
      planData.map(function (p) {
        return '<tr>' +
          '<td style="font-family:var(--font-mono);font-size:12px">' + esc(p.id) + '</td>' +
          '<td>' + esc(p.name) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.copay) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.deductible) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.oopMax) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + fmtCents(p.annualMax) + '</td>' +
          '<td>' + esc(p.coverage || 'pharmacy') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
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
    if (refreshBtn) refreshBtn.onclick = renderPlanList;
  }

  function createPlan() {
    var name = ($('plan-name') || {}).value || '';
    var id = ($('plan-id') || {}).value || '';
    if (!name.trim() || !id.trim()) { toast('Plan Name and Plan ID are required', 'error'); return; }

    if (planData.some(function (p) { return p.id === id.trim(); })) {
      toast('Plan ID already exists', 'error');
      return;
    }

    planData.push({
      id: id.trim(),
      name: name.trim(),
      copay: Number(($('plan-copay') || {}).value) || 2000,
      deductible: Number(($('plan-deductible') || {}).value) || 100000,
      oopMax: Number(($('plan-oop') || {}).value) || 500000,
      annualMax: Number(($('plan-annual') || {}).value) || 10000000,
      famDeductible: Number(($('plan-fam-ded') || {}).value) || 200000,
      famOopMax: Number(($('plan-fam-oop') || {}).value) || 1000000,
      coverage: ($('plan-coverage') || {}).value || 'pharmacy',
    });
    savePlans();
    renderPlanList();
    toast('Plan created: ' + name.trim(), 'success');
    showResult('plan-create-result', 'Created plan ' + id.trim(), true);
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

  function init() {
    loadFormulary();
    loadPlans();
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
