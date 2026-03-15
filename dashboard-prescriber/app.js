// zkp.Care Prescriber Dashboard — SPA Application Logic
// Overview, Write Rx, Patients, Formulary, Providers, Messaging, Onboarding, Proofs.

(function () {
  'use strict';

  // ── Demo Prescribers ─────────────────────────────────────────
  var PRESCRIBERS = [
    { npi: '1234567890', name: 'Dr. Sarah Chen', credential: 'MD', specialty: 'Internal Medicine', state: 'CA' },
    { npi: '1345678901', name: 'Dr. Raj Patel', credential: 'MD', specialty: 'Cardiology', state: 'NY' },
    { npi: '1456789012', name: 'Dr. Michael Jones', credential: 'DO', specialty: 'Family Medicine', state: 'TX' },
    { npi: '1567890123', name: 'Dr. Jennifer Kim', credential: 'MD', specialty: 'Endocrinology', state: 'IL' },
    { npi: '1678901234', name: 'Maria Garcia', credential: 'NP', specialty: 'Nurse Practitioner', state: 'FL' },
    { npi: '1789012345', name: 'Dr. David Thompson', credential: 'MD', specialty: 'Psychiatry', state: 'PA' },
    { npi: '1890123456', name: 'Emily Wilson', credential: 'PA', specialty: 'Physician Assistant', state: 'OH' },
    { npi: '1901234567', name: 'Dr. Thanh Nguyen', credential: 'MD', specialty: 'Pulmonology', state: 'WA' },
    { npi: '1012345678', name: 'Dr. Robert Smith', credential: 'MD', specialty: 'Oncology', state: 'MA' },
    { npi: '1123456789', name: 'Dr. Lisa Brown', credential: 'PharmD', specialty: 'Clinical Pharmacist', state: 'AZ' },
  ];

  var PRESCRIBER_KEY = 'zkp_prescriber_selected';

  function getSelectedPrescriber() {
    var saved = localStorage.getItem(PRESCRIBER_KEY);
    if (saved) {
      var found = PRESCRIBERS.find(function (p) { return p.npi === saved; });
      if (found) return found;
    }
    return PRESCRIBERS[0];
  }

  function setSelectedPrescriber(npi) {
    localStorage.setItem(PRESCRIBER_KEY, npi);
  }

  // ── State ────────────────────────────────────────────────────
  var currentTab = 'overview';
  var onboardingPhase = 'awaiting_token';
  var walletId = null;
  var sseEvents = [];
  var MAX_EVENTS = 100;

  // Messaging
  var msgActiveThread = null;
  var msgContacts = [];

  // Rx form data cache
  var cachedMembers = [];
  var cachedPharmacies = [];
  var cachedMedications = [];

  // ── Utilities ──────────────────────────────────────────────

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function truncate(s, n) {
    if (!s) return '--';
    s = String(s);
    return s.length <= n ? s : s.slice(0, n) + '\u2026';
  }

  function truncHash(h, n) {
    if (!h) return '--';
    var s = esc(String(h));
    n = n || 16;
    if (s.length <= n) return s;
    return s.slice(0, 8) + '...' + s.slice(-6);
  }

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function formatCents(cents) {
    if (cents == null) return '--';
    var n = Number(cents);
    if (isNaN(n)) return String(cents);
    return '$' + (n / 100).toFixed(2);
  }

  function fmtYMD(s) {
    if (!s || String(s).length !== 8) return s || '--';
    s = String(s);
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }

  function fmtDate(ts) {
    if (!ts) return '--';
    var d = new Date(typeof ts === 'number' ? ts : ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  function fmtTime(ts) {
    if (!ts) return '--';
    return new Date(typeof ts === 'number' ? ts : ts).toLocaleTimeString();
  }

  function setText(sel, text) {
    var el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.textContent = text;
  }

  function setHTML(sel, html) {
    var el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.innerHTML = html;
  }

  function showEl(sel) {
    var el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.classList.remove('hidden');
  }

  function hideEl(sel) {
    var el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.classList.add('hidden');
  }

  function toast(msg, type) {
    var container = $('#toast-container');
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function initials(name) {
    if (!name) return '?';
    return name.replace(/^Dr\.\s*/, '').split(/\s+/).map(function (w) { return w[0]; }).filter(Boolean).slice(0, 2).join('').toUpperCase();
  }

  // ── Router ───────────────────────────────────────────────────

  var TABS = ['overview', 'prescriptions', 'patients', 'formulary', 'providers', 'messaging', 'onboarding', 'proofs'];

  function navigate(tab) {
    if (!TABS.includes(tab)) tab = 'overview';
    currentTab = tab;
    location.hash = '#' + tab;
    if (window._overviewTimer) { clearInterval(window._overviewTimer); window._overviewTimer = null; }

    $$('.nav-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    $$('.page').forEach(function (page) {
      page.classList.toggle('active', page.id === 'page-' + tab);
    });

    onTabEnter(tab);
  }

  function onTabEnter(tab) {
    switch (tab) {
      case 'overview': loadOverview(); break;
      case 'prescriptions': loadPrescriptions(); break;
      case 'patients': loadPatients(); break;
      case 'formulary': autoLoadFormulary(); break;
      case 'providers': loadProviders(); break;
      case 'messaging': loadMessaging(); break;
      case 'onboarding': loadOnboarding(); break;
      case 'proofs': loadProofs(); break;
    }
  }

  // ── SSE ──────────────────────────────────────────────────────

  function initSSE() {
    API.connectSSE(
      function (event) {
        sseEvents.unshift(event);
        if (sseEvents.length > MAX_EVENTS) sseEvents.length = MAX_EVENTS;
        if (currentTab === 'overview') renderEventLog();
      },
      function () {
        var dot = $('#connection-dot');
        dot.classList.remove('connected');
        dot.classList.add('disconnected');
        // rpc.js connectSSE() handles reconnection with exponential backoff
      },
      function () {
        var dot = $('#connection-dot');
        dot.classList.add('connected');
        dot.classList.remove('disconnected');
      }
    );
  }

  // ══════════════════════════════════════════════════════════════
  //  OVERVIEW
  // ══════════════════════════════════════════════════════════════

  async function loadOverview() {
    // Identity
    try {
      var status = await API.getOnboardingStatus();
      onboardingPhase = status.phase || 'awaiting_token';
      walletId = status.walletId || null;
      var name = status.displayName || getSelectedPrescriber().name;
      setText('#header-wallet', truncHash(walletId, 16));
      setText('#ov-name', name);
      setText('#ov-avatar', initials(name));
      setText('#ov-detail', walletId ? 'Wallet: ' + truncHash(walletId, 24) : 'No wallet');
      var badge = $('#ov-phase-badge');
      if (badge) {
        badge.textContent = onboardingPhase;
        badge.className = 'badge ' + (onboardingPhase === 'ready' ? 'badge-ready' : 'badge-pending');
      }
    } catch (_) { }

    // Stats
    try {
      var summary = await API.getPrescriptionSummary();
      setText('#ov-total-rx', summary.totalClaims || summary.totalPrescriptions || summary.total || '0');
      var ovSummary = $('#ov-summary');
      if (ovSummary && summary) {
        var displayKeys = {totalClaims:'Total Claims', totalPatientPayCents:'Patient Pay', totalPlanPayCents:'Plan Pay'};
        var keys = Object.keys(displayKeys);
        if (keys.length > 0) {
          ovSummary.innerHTML = '<div class="detail-grid">' +
            keys.filter(function(k){return summary[k] !== undefined;}).map(function (k) {
              var v = summary[k];
              var label = displayKeys[k] || k;
              if (k.indexOf('Cents') > -1) v = '$' + (Number(v) / 100).toFixed(2);
              return '<div class="detail-key">' + esc(label) + '</div><div class="detail-val">' + esc(v) + '</div>';
            }).join('') +
            '</div>';
        } else {
          ovSummary.innerHTML = '<div class="empty-state">No activity yet</div>';
        }
      }
    } catch (_) {
      setHTML('#ov-summary', '<div class="empty-state">Complete onboarding first</div>');
    }

    try {
      var pc = await API.getPatientCount();
      setText('#ov-patients', pc.count || '0');
    } catch (_) { setText('#ov-patients', '0'); }

    try {
      var phc = await API.getPharmacyCount();
      setText('#ov-pharmacies', phc.count || '0');
    } catch (_) { setText('#ov-pharmacies', '0'); }

    try {
      var pcp = await API.getPcpPatients();
      var count = Array.isArray(pcp) ? pcp.length : (pcp.count || '0');
      setText('#ov-pcp', count);
    } catch (_) { setText('#ov-pcp', '0'); }

    // Medication breakdown
    try {
      var breakdown = await API.getMedicationBreakdown();
      var mbEl = $('#ov-meds');
      if (mbEl) {
        var entries = Array.isArray(breakdown) ? breakdown : Object.entries(breakdown || {}).map(function (e) { return { ndcHash: e[0], count: e[1] }; });
        if (entries.length > 0) {
          mbEl.innerHTML = '<table class="data-table"><thead><tr><th>NDC Hash</th><th>Count</th></tr></thead><tbody>' +
            entries.map(function (b) { return '<tr><td><span class="hash">' + esc(b.ndcHash || b.ndc) + '</span></td><td>' + esc(b.claimCount || b.count) + '</td></tr>'; }).join('') +
            '</tbody></table>';
        } else {
          mbEl.innerHTML = '<div class="empty-state">No medications prescribed yet</div>';
        }
      }
    } catch (_) {
      setHTML('#ov-meds', '<div class="empty-state">Node not initialized</div>');
    }

    // Network prescribers
    try {
      var providers = await API.getProviders('prescriber');
      var provEl = $('#ov-providers');
      if (provEl && Array.isArray(providers) && providers.length > 0) {
        provEl.innerHTML = '<table class="data-table"><thead><tr><th>Name</th><th>Specialty</th><th>Wallet ID</th></tr></thead><tbody>' +
          providers.map(function (p) { return '<tr><td style="font-weight:600;">' + esc(p.displayName || 'Unknown') + '</td><td>' + esc(p.specialty || '--') + '</td><td><span class="hash">' + esc(truncHash(p.walletId, 18)) + '</span></td></tr>'; }).join('') +
          '</tbody></table>';
      } else if (provEl) {
        provEl.innerHTML = '<div class="empty-state">No prescribers on network</div>';
      }
    } catch (_) {
      setHTML('#ov-providers', '<div class="empty-state">Could not load providers</div>');
    }

    renderEventLog();

    // Auto-refresh overview stats every 30s
    if (window._overviewTimer) clearInterval(window._overviewTimer);
    window._overviewTimer = setInterval(loadOverview, 30000);
  }

  function renderEventLog() {
    var el = $('#ov-events');
    if (!el) return;
    if (sseEvents.length === 0) {
      el.innerHTML = '<div class="empty-state">Waiting for events...</div>';
      return;
    }
    el.innerHTML = sseEvents.map(function (ev) {
      return '<div class="event-item">' +
        '<span class="event-time">' + fmtTime(ev.timestamp || ev.ts) + '</span>' +
        '<span class="event-type">' + esc(ev.type || ev.event || 'event') + '</span>' +
        '<span class="event-data">' + esc(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data || ev)) + '</span>' +
        '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════════════════════════
  //  PRESCRIPTIONS (Write Rx + History)
  // ══════════════════════════════════════════════════════════════

  async function loadPrescriptions() {
    loadPrescriptionStats();
    loadPrescriptionHistory();

    // Enable write button if ready
    var btn = $('#rx-write-btn');
    if (btn) btn.disabled = (onboardingPhase !== 'ready');
  }

  async function loadPrescriptionStats() {
    try {
      var summary = await API.getPrescriptionSummary();
      setText('#rx-total', summary.totalClaims || summary.totalPrescriptions || summary.total || '0');
    } catch (_) { }

    try {
      var pc = await API.getPatientCount();
      setText('#rx-patients', pc.count || '0');
    } catch (_) { }

    try {
      var phc = await API.getPharmacyCount();
      setText('#rx-pharmacies', phc.count || '0');
    } catch (_) { }
  }

  async function populateRxDropdowns() {
    // Always refetch patients and pharmacies (PCP assignments may arrive after first load)
    try {
      var results = await Promise.all([
        API.getPcpPatients().catch(function () { return { patients: [] }; }),
        API.getProviders('pharmacy').catch(function () { return []; }),
      ]);
      // PCP patients are the prescriber's assigned patients
      var pcpData = results[0];
      var patients = Array.isArray(pcpData) ? pcpData : (pcpData.patients || []);
      cachedMembers = patients.map(function (p) {
        return { walletId: p.memberWalletId || p.walletId, displayName: p.displayName || truncHash(p.memberWalletId || p.walletId, 16) };
      });
      cachedPharmacies = Array.isArray(results[1]) ? results[1] : [];
    } catch (_) { }
    if (cachedMedications.length === 0) {
      try {
        var meds = await API.getMedicationBreakdown();
        cachedMedications = Array.isArray(meds) ? meds : [];
      } catch (_) { }
    }
    // Fallback: load from formulary if no claims history yet
    if (cachedMedications.length === 0) {
      try {
        var formData = await API.getFormulary('default');
        if (formData && formData.entriesJson) {
          var entries = JSON.parse(formData.entriesJson);
          if (Array.isArray(entries)) {
            cachedMedications = entries.filter(function (e) { return e.ndcHash && e.tierLevel > 0; }).map(function (e) {
              return { ndcHash: e.ndcHash, brandName: e.brandName || e.drugName || '', claimCount: 0 };
            });
          }
        }
      } catch (_) { }
    }

    var patientSel = $('#rx-patient-select');
    var pharmSel = $('#rx-pharmacy-select');
    var medSel = $('#rx-med-select');

    if (patientSel && cachedMembers.length > 0) {
      patientSel.innerHTML = '<option value="">-- Select Patient --</option>' +
        cachedMembers.map(function (m) { return '<option value="' + esc(m.walletId) + '">' + esc(m.displayName || truncHash(m.walletId)) + '</option>'; }).join('');
    }
    if (pharmSel && cachedPharmacies.length > 0) {
      pharmSel.innerHTML = '<option value="">-- Select Pharmacy --</option>' +
        cachedPharmacies.map(function (p) { return '<option value="' + esc(p.walletId) + '">' + esc(p.displayName || truncHash(p.walletId)) + '</option>'; }).join('');
    }
    if (medSel && cachedMedications.length > 0) {
      medSel.innerHTML = '<option value="">-- Select Medication --</option>' +
        cachedMedications.map(function (m) { return '<option value="' + esc(m.ndcHash) + '" data-name="' + esc(m.brandName || m.drugName || '') + '">' + esc(m.brandName || m.drugName || truncHash(m.ndcHash)) + ' (' + (m.claimCount || 0) + ')</option>'; }).join('');
    }
  }

  async function writeRx() {
    var memberWalletId = $('#rx-patient-select').value;
    var pharmacyWalletId = $('#rx-pharmacy-select').value;
    var ndcHash = $('#rx-med-select').value || $('#rx-ndc-manual').value.trim();

    if (!memberWalletId) { toast('Select a patient', 'error'); return; }
    if (!pharmacyWalletId) { toast('Select a pharmacy', 'error'); return; }
    if (!ndcHash) { toast('Select a medication or enter NDC hash', 'error'); return; }

    var btn = $('#rx-write-btn');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      var medSelect = $('#rx-med-select');
      var brandName = medSelect.selectedOptions[0] ? medSelect.selectedOptions[0].dataset.name || '' : '';
      var res = await API.writePrescription({
        memberWalletId: memberWalletId,
        pharmacyWalletId: pharmacyWalletId,
        ndcHash: ndcHash,
        brandName: brandName,
        quantity: parseInt($('#rx-quantity').value) || 30,
        daysSupply: parseInt($('#rx-days-supply').value) || 30,
        refills: parseInt($('#rx-refills').value) || 0,
        directions: $('#rx-directions').value.trim(),
        diagnosis: $('#rx-diagnosis').value.trim(),
      });

      setHTML('#rx-write-result', '<div class="form-result success">Prescription sent! Rx ID: ' + esc(res.rxId) +
        (res.sentToPharmacy ? ' | Pharmacy notified' : '') +
        (res.sentToMember ? ' | Patient notified' : '') + '</div>');
      toast('Prescription sent to pharmacy', 'success');
      loadPrescriptionHistory();
    } catch (err) {
      setHTML('#rx-write-result', '<div class="form-result error">' + esc(err.message) + '</div>');
    }

    btn.disabled = false;
    btn.textContent = 'Send Prescription';
  }

  async function loadPrescriptionHistory() {
    var container = $('#rx-table-container');
    if (!container) return;
    container.innerHTML = '<div class="loading">Loading...</div>';

    var filterType = $('#rx-filter-type') ? $('#rx-filter-type').value : 'all';
    var filterValue = $('#rx-filter-value') ? $('#rx-filter-value').value.trim() : '';

    try {
      var data;
      switch (filterType) {
        case 'patient':
          if (!filterValue) { toast('Enter a patient wallet ID', 'error'); return; }
          data = await API.getPrescriptionsByPatient(filterValue);
          break;
        case 'medication':
          if (!filterValue) { toast('Enter an NDC hash', 'error'); return; }
          data = await API.getPrescriptionsByMedication(filterValue);
          break;
        case 'pharmacy':
          if (!filterValue) { toast('Enter a pharmacy wallet ID', 'error'); return; }
          data = await API.getPrescriptionsByPharmacy(filterValue);
          break;
        case 'daterange':
          var start = $('#rx-start-date') ? $('#rx-start-date').value.trim() : '';
          var end = $('#rx-end-date') ? $('#rx-end-date').value.trim() : '';
          if (!start || !end) { toast('Enter start and end dates', 'error'); return; }
          data = await API.getPrescriptionsByRange(start, end);
          break;
        default:
          data = await API.getPrescriptions();
      }

      var rows = Array.isArray(data) ? data : (data.claims || data.prescriptions || []);
      setText('#rx-total', rows.length);
      setText('#rx-count', rows.length + ' records');

      if (rows.length === 0) {
        container.innerHTML = '<div class="empty-state">No prescriptions found</div>';
        return;
      }

      container.innerHTML =
        '<table class="data-table"><thead><tr>' +
        '<th>Date</th><th>Patient</th><th>Medication</th><th>Pharmacy</th><th>Patient Pay</th><th>Plan Pay</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (rx) {
          return '<tr>' +
            '<td>' + esc(fmtYMD(rx.dateOfService) || fmtDate(rx.timestamp)) + '</td>' +
            '<td><span class="hash" title="' + esc(rx.memberWalletId || rx.patientWalletId) + '">' + truncHash(rx.memberWalletId || rx.patientWalletId) + '</span></td>' +
            '<td><span class="hash" title="' + esc(rx.ndcHash) + '">' + truncHash(rx.ndcHash) + '</span></td>' +
            '<td><span class="hash" title="' + esc(rx.pharmacyWalletId) + '">' + truncHash(rx.pharmacyWalletId) + '</span></td>' +
            '<td>' + formatCents(rx.patientPayCents) + '</td>' +
            '<td>' + formatCents(rx.planPayCents) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table>';
    } catch (err) {
      container.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  PATIENTS (PCP Panel + DUR)
  // ══════════════════════════════════════════════════════════════

  async function loadPatients() {
    var listEl = $('#pt-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var data = await API.getPcpPatients();
      var patients = Array.isArray(data) ? data : (data.patients || []);
      if (patients.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No PCP patients assigned</div>';
        return;
      }

      listEl.innerHTML = patients.map(function (p) {
        var name = p.displayName || truncHash(p.walletId || p.memberWalletId, 16);
        return '<div class="patient-item" data-wallet="' + esc(p.walletId || p.memberWalletId) + '">' +
          '<div class="patient-avatar">' + initials(name) + '</div>' +
          '<div class="provider-info">' +
            '<div class="provider-name">' + esc(name) + '</div>' +
            '<div class="provider-sub hash">' + truncHash(p.walletId || p.memberWalletId, 20) + '</div>' +
          '</div>' +
          '</div>';
      }).join('');

      // Click to DUR lookup
      listEl.querySelectorAll('.patient-item').forEach(function (item) {
        item.addEventListener('click', function () {
          var wallet = item.dataset.wallet;
          var durInput = $('#dur-wallet');
          if (durInput) durInput.value = wallet;
          durLookup(wallet);
        });
      });
    } catch (err) {
      listEl.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  async function durLookup(walletId) {
    if (!walletId) {
      walletId = $('#dur-wallet') ? $('#dur-wallet').value.trim() : '';
    }
    if (!walletId) { toast('Enter a patient wallet ID', 'error'); return; }

    var resultEl = $('#dur-result');
    if (!resultEl) return;
    resultEl.innerHTML = '<div class="loading">Loading DUR data...</div>';

    try {
      var results = await Promise.all([
        API.getInbox().catch(function () { return []; }), // placeholder — DUR uses dispensing data
        API.getPrescriptionsByPatient(walletId).catch(function () { return []; }),
      ]);

      var rxHistory = Array.isArray(results[1]) ? results[1] : (results[1].claims || results[1].prescriptions || []);

      if (rxHistory.length === 0) {
        resultEl.innerHTML = '<div class="empty-state">No prescription history for this patient</div>';
        return;
      }

      resultEl.innerHTML =
        '<h4 style="font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--text-secondary);">Prescription History (' + rxHistory.length + ' records)</h4>' +
        '<table class="data-table"><thead><tr>' +
        '<th>Date</th><th>Medication</th><th>Pharmacy</th><th>Pt Pay</th><th>Plan Pay</th>' +
        '</tr></thead><tbody>' +
        rxHistory.map(function (rx) {
          return '<tr>' +
            '<td>' + esc(fmtYMD(rx.dateOfService)) + '</td>' +
            '<td><span class="hash">' + truncHash(rx.ndcHash) + '</span></td>' +
            '<td><span class="hash">' + truncHash(rx.pharmacyWalletId) + '</span></td>' +
            '<td>' + formatCents(rx.patientPayCents) + '</td>' +
            '<td>' + formatCents(rx.planPayCents) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table>';
    } catch (err) {
      resultEl.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  FORMULARY
  // ══════════════════════════════════════════════════════════════

  var formularyAutoLoaded = false;
  async function autoLoadFormulary() {
    if (formularyAutoLoaded) return;
    formularyAutoLoaded = true;
    var planInput = $('#form-plan-id');
    if (planInput && !planInput.value.trim()) {
      planInput.value = 'default';
    }
    formularyLookup();
  }

  async function formularyLookup() {
    var planId = $('#form-plan-id') ? $('#form-plan-id').value.trim() : '';
    if (!planId) { toast('Enter a plan ID hash', 'error'); return; }

    var resultEl = $('#form-result');
    resultEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var data = await API.getFormulary(planId);
      if (data.entriesJson) {
        try {
          var entries = JSON.parse(data.entriesJson);
          if (Array.isArray(entries) && entries.length > 0) {
            resultEl.innerHTML =
              '<table class="data-table"><thead><tr><th>NDC Hash</th><th>Tier</th><th>Copay</th></tr></thead><tbody>' +
              entries.map(function (e) {
                return '<tr><td><span class="hash" title="' + esc(e.ndcHash) + '">' + truncHash(e.ndcHash) + '</span></td>' +
                  '<td>' + esc(e.tierLevel || '--') + '</td>' +
                  '<td>' + (e.copay != null ? '$' + Number(e.copay).toFixed(2) : '--') + '</td></tr>';
              }).join('') +
              '</tbody></table>';
          } else {
            resultEl.innerHTML = '<div class="empty-state">Formulary is empty</div>';
          }
        } catch (_) {
          resultEl.innerHTML = '<div class="detail-grid"><div class="detail-key">Raw Data</div><div class="detail-val">' + esc(data.entriesJson) + '</div></div>';
        }
      } else {
        var keys = Object.keys(data);
        resultEl.innerHTML = '<div class="detail-grid">' +
          keys.map(function (k) { return '<div class="detail-key">' + esc(k) + '</div><div class="detail-val">' + esc(typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k]) + '</div>'; }).join('') +
          '</div>';
      }
    } catch (err) {
      resultEl.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  async function checkDrugCoverage() {
    var planId = $('#form-check-plan') ? $('#form-check-plan').value.trim() : '';
    var ndc = $('#form-check-ndc') ? $('#form-check-ndc').value.trim() : '';
    if (!planId || !ndc) { toast('Enter both plan ID hash and NDC hash', 'error'); return; }

    var resultEl = $('#form-check-result');
    resultEl.innerHTML = '<div class="loading">Checking...</div>';

    try {
      var data = await API.checkDrugCoverage(planId, ndc);
      var covered = data.onFormulary;
      resultEl.innerHTML = '<div class="form-result ' + (covered ? 'success' : 'error') + '">' +
        '<strong>' + (covered ? 'COVERED' : 'NOT ON FORMULARY') + '</strong> — NDC: ' + esc(data.ndcHash) +
        (data.tierLevel != null ? ' | Tier: ' + data.tierLevel : '') +
        (data.copay != null ? ' | Copay: $' + Number(data.copay).toFixed(2) : '') +
        '</div>';
    } catch (err) {
      resultEl.innerHTML = '<div class="form-result error">' + esc(err.message) + '</div>';
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  PROVIDERS
  // ══════════════════════════════════════════════════════════════

  async function loadProviders() {
    // Prescribers
    try {
      var prescribers = await API.getProviders('prescriber');
      var el = $('#prov-prescriber-list');
      if (el && Array.isArray(prescribers) && prescribers.length > 0) {
        el.innerHTML = prescribers.map(function (p) {
          return '<div class="provider-item">' +
            '<div class="provider-avatar prescriber">' + initials(p.displayName) + '</div>' +
            '<div class="provider-info">' +
              '<div class="provider-name">' + esc(p.displayName || 'Unknown') + '</div>' +
              '<div class="provider-sub">' + esc(p.specialty || 'General') + '</div>' +
            '</div>' +
            '<div class="provider-wallet">' + truncHash(p.walletId, 14) + '</div>' +
            '</div>';
        }).join('');
      } else if (el) {
        el.innerHTML = '<div class="empty-state">No prescribers on network</div>';
      }
    } catch (_) {
      setHTML('#prov-prescriber-list', '<div class="empty-state">Could not load prescribers</div>');
    }

    // Pharmacies
    try {
      var pharmacies = await API.getProviders('pharmacy');
      var el2 = $('#prov-pharmacy-list');
      if (el2 && Array.isArray(pharmacies) && pharmacies.length > 0) {
        el2.innerHTML = pharmacies.map(function (p) {
          return '<div class="provider-item">' +
            '<div class="provider-avatar pharmacy">Rx</div>' +
            '<div class="provider-info">' +
              '<div class="provider-name">' + esc(p.displayName || 'Unknown Pharmacy') + '</div>' +
              '<div class="provider-sub">' + esc(p.pharmacyType || p.group || '--') + '</div>' +
            '</div>' +
            '<div class="provider-wallet">' + truncHash(p.walletId, 14) + '</div>' +
            '</div>';
        }).join('');
      } else if (el2) {
        el2.innerHTML = '<div class="empty-state">No pharmacies on network</div>';
      }
    } catch (_) {
      setHTML('#prov-pharmacy-list', '<div class="empty-state">Could not load pharmacies</div>');
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  MESSAGING
  // ══════════════════════════════════════════════════════════════

  async function loadMessaging() {
    var listEl = $('#msg-contacts-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var results = await Promise.all([
        API.getInbox().catch(function () { return []; }),
        API.getSent().catch(function () { return []; }),
      ]);

      var inbox = Array.isArray(results[0]) ? results[0] : (results[0].messages || []);
      var sent = Array.isArray(results[1]) ? results[1] : (results[1].messages || []);

      // Build contacts from unique threads/wallets
      var contactMap = {};
      inbox.forEach(function (m) {
        var key = m.threadIdHash || m.senderWalletId || m.from;
        if (!contactMap[key]) contactMap[key] = { wallet: m.senderWalletId || m.from, threadId: m.threadIdHash, messages: [], lastTime: 0, name: m.senderName || truncHash(m.senderWalletId || m.from, 14) };
        contactMap[key].messages.push(m);
        var t = m.timestamp || 0;
        if (t > contactMap[key].lastTime) contactMap[key].lastTime = t;
      });
      sent.forEach(function (m) {
        var key = m.threadIdHash || m.recipientWalletId || m.to;
        if (!contactMap[key]) contactMap[key] = { wallet: m.recipientWalletId || m.to, threadId: m.threadIdHash, messages: [], lastTime: 0, name: m.recipientName || truncHash(m.recipientWalletId || m.to, 14) };
        contactMap[key].messages.push(m);
        var t = m.timestamp || 0;
        if (t > contactMap[key].lastTime) contactMap[key].lastTime = t;
      });

      msgContacts = Object.values(contactMap).sort(function (a, b) { return b.lastTime - a.lastTime; });

      if (msgContacts.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No conversations yet</div>';
        return;
      }

      listEl.innerHTML = msgContacts.map(function (c, i) {
        var preview = c.messages.length > 0 ? (c.messages[0].subject || c.messages[0].body || '(encrypted)') : '';
        return '<div class="msg-contact-item" data-idx="' + i + '">' +
          '<div class="msg-contact-avatar">' + initials(c.name) + '</div>' +
          '<div class="msg-contact-info">' +
            '<div class="msg-contact-name">' + esc(c.name) + '</div>' +
            '<div class="msg-contact-preview">' + esc(truncate(preview, 40)) + '</div>' +
          '</div>' +
          '<span class="msg-contact-time">' + (c.lastTime ? fmtTime(c.lastTime) : '') + '</span>' +
          '</div>';
      }).join('');

      listEl.querySelectorAll('.msg-contact-item').forEach(function (item) {
        item.addEventListener('click', function () {
          var idx = parseInt(item.dataset.idx);
          openThread(idx);
        });
      });
    } catch (err) {
      listEl.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  async function openThread(idx) {
    var contact = msgContacts[idx];
    if (!contact) return;
    msgActiveThread = contact;

    // Highlight active contact
    $$('.msg-contact-item').forEach(function (item, i) {
      item.classList.toggle('active', i === idx);
    });

    setText('#msg-conv-header', contact.name);
    showEl('#msg-conv-input');

    var messagesEl = $('#msg-conv-messages');
    messagesEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var messages;
      if (contact.threadId) {
        var data = await API.getThread(contact.threadId);
        messages = Array.isArray(data) ? data : (data.messages || []);
      } else {
        messages = contact.messages || [];
      }

      if (messages.length === 0) {
        messagesEl.innerHTML = '<div class="empty-state">No messages</div>';
        return;
      }

      messagesEl.innerHTML = messages.map(function (m) {
        var isOutgoing = (m.senderWalletId || m.from) === walletId;
        return '<div class="msg-bubble ' + (isOutgoing ? 'outgoing' : 'incoming') + '">' +
          '<div>' + esc(m.body || m.content || m.subject || '(encrypted)') + '</div>' +
          '<div class="msg-bubble-time">' + fmtTime(m.timestamp) + '</div>' +
          '</div>';
      }).join('');

      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      messagesEl.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  async function sendThreadMessage() {
    if (!msgActiveThread) return;
    var input = $('#msg-input-text');
    var body = input.value.trim();
    if (!body) return;

    try {
      await API.sendMessage(
        { messageCommitment: '0', recipientWalletId: msgActiveThread.wallet, senderWalletId: walletId || '', messageType: '1', threadIdHash: msgActiveThread.threadId || '' },
        { ciphertext: btoa(body), iv: '0', tag: '0', timestamp: Date.now() }
      );
      input.value = '';
      toast('Message sent', 'success');
      // Re-open thread to show new message
      var idx = msgContacts.indexOf(msgActiveThread);
      if (idx >= 0) openThread(idx);
    } catch (err) {
      toast('Send failed: ' + err.message, 'error');
    }
  }

  async function sendComposeMessage() {
    var recipient = $('#msg-compose-recipient').value.trim();
    var body = $('#msg-compose-body').value.trim();
    if (!recipient) { toast('Recipient wallet ID is required', 'error'); return; }
    if (!body) { toast('Message body is required', 'error'); return; }

    try {
      await API.sendMessage(
        { messageCommitment: '0', recipientWalletId: recipient, senderWalletId: walletId || '', messageType: '1', threadIdHash: '0' },
        { ciphertext: btoa(body), iv: '0', tag: '0', timestamp: Date.now() }
      );
      toast('Message sent', 'success');
      hideEl('#msg-compose-overlay');
      $('#msg-compose-recipient').value = '';
      $('#msg-compose-body').value = '';
      loadMessaging();
    } catch (err) {
      toast('Send failed: ' + err.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  ONBOARDING
  // ══════════════════════════════════════════════════════════════

  var PHASE_ORDER = ['awaiting_token', 'token_received', 'key_generated', 'wallet_derived', 'enrolled', 'compiling', 'ready'];
  var STEP_LABELS = ['Accept Token', 'Generate Key', 'Derive Wallet', 'Enroll', 'Compile', 'Ready'];

  function phaseIndex(phase) {
    var idx = PHASE_ORDER.indexOf(phase);
    return idx >= 0 ? idx : 0;
  }

  function activeStepIndex() {
    var pi = phaseIndex(onboardingPhase);
    if (pi <= 0) return 0;
    if (pi === 1) return 1;
    if (pi === 2) return 2;
    if (pi === 3) return 3;
    if (pi === 4 || pi === 5) return 4;
    return 5;
  }

  async function loadOnboarding() {
    try {
      var status = await API.getOnboardingStatus();
      onboardingPhase = status.phase || 'awaiting_token';
      walletId = status.walletId || null;
      setText('#header-wallet', truncHash(walletId, 16));
    } catch (_) { }

    var asi = activeStepIndex();
    renderWizardProgress(asi);
    renderWizardPanels(asi);
  }

  function renderWizardProgress(asi) {
    var el = $('#wiz-progress');
    if (!el) return;
    el.innerHTML = STEP_LABELS.map(function (label, i) {
      var cls = '';
      if (i < asi) cls = 'completed';
      else if (i === asi && onboardingPhase !== 'ready') cls = 'active';
      else if (onboardingPhase === 'ready') cls = 'completed';
      return '<div class="wizard-step ' + cls + '">' +
        '<span class="wizard-step-num">' + (i + 1) + '</span>' +
        '<span class="wizard-step-label">' + label + '</span>' +
        '</div>';
    }).join('');
  }

  function renderWizardPanels(asi) {
    for (var i = 0; i <= 5; i++) {
      var panel = $('#wiz-panel-' + i);
      if (!panel) continue;
      if (i === asi) {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    }

    // Ready panel detail
    if (asi === 5) {
      var detailEl = $('#wiz-ready-detail');
      if (detailEl) {
        detailEl.innerHTML =
          '<div class="detail-key">Status</div><div class="detail-val"><span class="badge badge-ready">READY</span></div>' +
          '<div class="detail-key">Wallet ID</div><div class="detail-val">' + esc(walletId || '--') + '</div>' +
          '<div class="detail-key">Phase</div><div class="detail-val">' + esc(onboardingPhase) + '</div>';
      }
    }

    // Disable fields for completed steps
    for (var j = 0; j < asi; j++) {
      var p = $('#wiz-panel-' + j);
      if (p) {
        p.querySelectorAll('input, button').forEach(function (el) { el.disabled = true; });
      }
    }
  }

  async function wizardAction(step) {
    var resultEl = $('#wiz-result-' + step);
    var btn = $('#wiz-btn-' + step);
    if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }

    try {
      var res;
      switch (step) {
        case 0:
          var tokenId = $('#wiz-token-id').value.trim();
          if (!tokenId) { toast('Token ID is required', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Accept Token'; } return; }
          res = await API.acceptToken(tokenId, ($('#wiz-group-id').value || '').trim(), ($('#wiz-plan-id').value || '').trim());
          break;
        case 1:
          res = await API.generateKey();
          break;
        case 2:
          var prescriberId = $('#wiz-prescriber-id').value.trim();
          if (!prescriberId) { toast('Prescriber ID is required', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Derive Wallet'; } return; }
          res = await API.deriveWallet($('#wiz-qualifier').value || '1', prescriberId);
          walletId = res.walletId;
          setText('#header-wallet', truncHash(walletId, 16));
          break;
        case 3:
          var insurerUrl = $('#wiz-insurer-url') ? $('#wiz-insurer-url').value.trim() : '';
          res = await API.enroll(insurerUrl || undefined);
          break;
        case 4:
          if (btn) btn.textContent = 'Compiling... (3-5 min)';
          onboardingPhase = 'compiling';
          res = await API.compile();
          // Auto-submit registration proof after compile (phase is now 'ready')
          if (resultEl) resultEl.innerHTML = '<div class="form-result">Compiled — generating registration proof (30-120s)...</div>';
          try {
            var proofRes = await API.generateRegistrationProof();
            if (resultEl) resultEl.innerHTML = '<div class="form-result success">Compiled + proof submitted. Receipt: ' + esc(proofRes.receiptId || 'ok') + '</div>';
            console.log('[onboard] Registration proof submitted to sequencer:', proofRes.receiptId);
          } catch (proofErr) {
            console.error('[onboard] Registration proof failed after compile:', proofErr.message);
            if (resultEl) resultEl.innerHTML = '<div class="form-result error">Compiled but proof failed: ' + esc(proofErr.message) + ' — use Proofs tab to retry</div>';
          }
          break;
      }
      onboardingPhase = res.phase;
      if (resultEl && !resultEl.innerHTML.includes('form-result')) resultEl.innerHTML = '<div class="form-result success">Success! Phase: ' + esc(res.phase) + (res.walletId ? ' | Wallet: ' + esc(truncHash(res.walletId, 24)) : '') + '</div>';
      toast('Step completed', 'success');
      setTimeout(function () { loadOnboarding(); }, 600);
    } catch (err) {
      if (step === 4) onboardingPhase = 'enrolled';
      if (resultEl) resultEl.innerHTML = '<div class="form-result error">' + esc(err.message) + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = STEP_LABELS[step] || 'Retry'; }
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  PROOFS
  // ══════════════════════════════════════════════════════════════

  function loadProofs() {
    var btn = $('#proof-reg-btn');
    if (btn) btn.disabled = (onboardingPhase !== 'ready');
    loadProofTimings();
  }

  async function generateRegistrationProof() {
    var btn = $('#proof-reg-btn');
    btn.disabled = true;
    btn.textContent = 'Generating proof...';

    try {
      var res = await API.generateRegistrationProof();
      setHTML('#proof-reg-result', '<div class="form-result success">Proof generated and submitted. Receipt ID: ' + esc(res.receiptId) + ' | Wallet: ' + esc(res.walletId) + '</div>');
      toast('Registration proof generated', 'success');
      loadProofTimings();
    } catch (err) {
      setHTML('#proof-reg-result', '<div class="form-result error">' + esc(err.message) + '</div>');
    }

    btn.disabled = false;
    btn.textContent = 'Generate Registration Proof';
  }

  async function loadProofTimings() {
    var container = $('#proof-timings-container');
    if (!container) return;
    container.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var data = await API.getProofTimings();
      var timings = Array.isArray(data) ? data : (data.timings || []);
      if (timings.length === 0) {
        container.innerHTML = '<div class="empty-state">No proof timings recorded yet</div>';
        return;
      }

      container.innerHTML =
        '<table class="data-table"><thead><tr><th>Program</th><th>Method</th><th>Duration (ms)</th><th>Timestamp</th></tr></thead><tbody>' +
        timings.map(function (t) {
          return '<tr>' +
            '<td>' + esc(t.program || t.name || '--') + '</td>' +
            '<td>' + esc(t.method || t.type || '--') + '</td>' +
            '<td>' + esc(t.durationMs || t.duration || '--') + '</td>' +
            '<td>' + fmtDate(t.timestamp) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table>';
    } catch (err) {
      container.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  PRESCRIBER SELECTOR
  // ══════════════════════════════════════════════════════════════

  function initPrescriberSelector() {
    var sel = $('#prescriber-selector');
    if (!sel) return;
    var current = getSelectedPrescriber();
    sel.innerHTML = PRESCRIBERS.map(function (p) {
      return '<option value="' + p.npi + '"' + (p.npi === current.npi ? ' selected' : '') + '>' +
        esc(p.name) + ' — ' + esc(p.specialty) + ', ' + esc(p.state) +
        '</option>';
    }).join('');
    sel.addEventListener('change', function () {
      switchPrescriber(sel.value);
    });
  }

  function switchPrescriber(npi) {
    setSelectedPrescriber(npi);
    var p = getSelectedPrescriber();
    setText('#ov-name', p.name);
    setText('#ov-avatar', initials(p.name));
    onTabEnter(currentTab);
  }

  // ══════════════════════════════════════════════════════════════
  //  BADGE TAP — ALIAS IN
  // ══════════════════════════════════════════════════════════════

  var INTERACTIVE_BASE = window.INTERACTIVE_BASE || location.origin;

  function initBadgeTap() {
    var btn = $('#badge-tap-btn');
    var modal = $('#badge-modal');
    var closeBtn = $('#badge-modal-close');

    if (!btn || !modal) return;

    btn.addEventListener('click', function () {
      var p = getSelectedPrescriber();
      var idx = PRESCRIBERS.findIndex(function (x) { return x.npi === p.npi; });
      showBadgeModal(p, idx >= 0 ? idx : 0);
    });

    closeBtn.addEventListener('click', function () {
      modal.style.display = 'none';
    });

    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.style.display = 'none';
    });
  }

  function showBadgeModal(prescriber, index) {
    var modal = $('#badge-modal');
    var card = $('#badge-card');
    var steps = $('#badge-steps');
    var result = $('#badge-result');

    // Update badge card
    var nameStr = prescriber.name + ', ' + prescriber.credential;
    setText('#badge-card-name', nameStr);
    setText('#badge-card-specialty', prescriber.specialty);
    setText('#badge-card-npi', 'NPI: ' + prescriber.npi);
    setText('#badge-card-avatar', initials(prescriber.name));

    // Reset steps (classes + remove accumulated timing/error spans)
    var stepEls = steps.querySelectorAll('.badge-step');
    stepEls.forEach(function (el) {
      el.classList.remove('active', 'done', 'error');
      var spans = el.querySelectorAll('.step-time, .step-error');
      spans.forEach(function (s) { s.remove(); });
    });
    result.style.display = 'none';
    result.innerHTML = '';
    card.classList.remove('badge-authenticated');

    // Show modal
    modal.style.display = 'flex';

    // Run the badge tap animation
    runBadgeTap(prescriber, index);
  }

  async function runBadgeTap(prescriber, index) {
    var steps = $('#badge-steps');
    var result = $('#badge-result');
    var card = $('#badge-card');
    var stepEls = steps.querySelectorAll('.badge-step');

    function activateStep(name) {
      stepEls.forEach(function (el) {
        if (el.dataset.step === name) el.classList.add('active');
      });
    }

    function completeStep(name, ms) {
      stepEls.forEach(function (el) {
        if (el.dataset.step === name) {
          el.classList.remove('active');
          el.classList.add('done');
          if (ms !== undefined) {
            el.innerHTML += ' <span class="step-time">(' + ms + 'ms)</span>';
          }
        }
      });
    }

    function errorStep(name, msg) {
      stepEls.forEach(function (el) {
        if (el.dataset.step === name) {
          el.classList.remove('active');
          el.classList.add('error');
          el.innerHTML += ' <span class="step-error">' + esc(msg) + '</span>';
        }
      });
    }

    // Step 1: Tap
    activateStep('tap');
    await sleep(400);
    completeStep('tap');

    // Call the interactive backend
    try {
      activateStep('decrypt');

      var response = await fetch(INTERACTIVE_BASE + '/interactive/badge/tap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerType: 'prescriber', providerIndex: index }),
      });

      if (!response.ok) throw new Error('Server error: HTTP ' + response.status);
      var data = await response.json();
      var events = data.events || [];

      // Process events to update UI steps
      for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        switch (evt.type) {
          case 'badge:decrypt':
            completeStep('decrypt', evt.elapsedMs);
            activateStep('derive');
            await sleep(200);
            break;
          case 'badge:derive':
            completeStep('derive');
            activateStep('proof');
            break;
          case 'badge:proof':
            if (evt.data && evt.data.skipped) {
              completeStep('proof');
            } else {
              completeStep('proof', evt.elapsedMs);
            }
            activateStep('verify');
            await sleep(200);
            break;
          case 'badge:verify':
            completeStep('verify');
            activateStep('session');
            await sleep(200);
            break;
          case 'badge:session':
            completeStep('session');
            break;
          case 'badge:error':
            errorStep('decrypt', evt.error || 'Unknown error');
            result.style.display = 'block';
            result.innerHTML = '<div class="badge-result-error">Authentication failed: ' + esc(evt.error || 'Unknown') + '</div>';
            return;
        }
      }

      if (data.authenticated) {
        card.classList.add('badge-authenticated');
        var sessionEvt = events.find(function (e) { return e.type === 'badge:session'; });
        var proofEvt = events.find(function (e) { return e.type === 'badge:proof'; });
        var verifyEvt = events.find(function (e) { return e.type === 'badge:verify'; });
        var isNewWallet = verifyEvt && verifyEvt.data && verifyEvt.data.isNewWallet;
        result.style.display = 'block';
        result.innerHTML =
          '<div class="badge-result-success">' +
          '<div class="badge-result-title">' + (isNewWallet ? 'Wallet Created &amp; Authenticated' : 'Authenticated') + '</div>' +
          (isNewWallet ? '<div class="badge-result-detail" style="color:#3fb950;font-weight:600">New wallet registered on sequencer</div>' : '') +
          '<div class="badge-result-detail">Provider: ' + esc(prescriber.name) + '</div>' +
          '<div class="badge-result-detail">Wallet: ' + esc((data.events.find(function (e) { return e.type === 'badge:derive'; }) || {}).data?.walletId?.slice(0, 20) || '--') + '...</div>' +
          (proofEvt && proofEvt.data && proofEvt.data.proofHash ? '<div class="badge-result-detail">ZK Proof: ' + esc(proofEvt.data.proofHash) + '</div>' : '') +
          (sessionEvt ? '<div class="badge-result-detail">Session: 8h shift</div>' : '') +
          '</div>';
      }

    } catch (err) {
      errorStep('decrypt', err.message || 'Network error');
      result.style.display = 'block';
      result.innerHTML = '<div class="badge-result-error">Connection failed: ' + esc(err.message) + '</div>';
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ══════════════════════════════════════════════════════════════
  //  EVENT BINDING
  // ══════════════════════════════════════════════════════════════

  function bindEvents() {
    // Navigation
    $$('.nav-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(btn.dataset.tab);
      });
    });

    window.addEventListener('hashchange', function () {
      var hash = location.hash.replace('#', '') || 'overview';
      navigate(hash);
    });

    // Rx write toggle
    var rxToggle = $('#rx-write-toggle');
    if (rxToggle) {
      rxToggle.addEventListener('click', function () {
        var body = $('#rx-write-body');
        var arrow = $('#rx-write-arrow');
        if (body.classList.contains('hidden')) {
          body.classList.remove('hidden');
          arrow.innerHTML = '&#9650;';
          populateRxDropdowns();
        } else {
          body.classList.add('hidden');
          arrow.innerHTML = '&#9660;';
        }
      });
    }

    // Rx med select vs manual
    var rxMedSel = $('#rx-med-select');
    var rxNdcManual = $('#rx-ndc-manual');
    if (rxMedSel) rxMedSel.addEventListener('change', function () { if (rxMedSel.value) rxNdcManual.value = ''; });
    if (rxNdcManual) rxNdcManual.addEventListener('input', function () { if (rxNdcManual.value.trim()) rxMedSel.value = ''; });

    // Rx write button
    var rxWriteBtn = $('#rx-write-btn');
    if (rxWriteBtn) rxWriteBtn.addEventListener('click', writeRx);

    // Rx filter
    var rxFilterType = $('#rx-filter-type');
    if (rxFilterType) {
      rxFilterType.addEventListener('change', function () {
        var type = rxFilterType.value;
        var valGroup = $('#rx-filter-value-group');
        var dateRow = $('#rx-daterange-row');
        if (type === 'daterange') { hideEl(valGroup); showEl(dateRow); }
        else if (type === 'all') { hideEl(valGroup); hideEl(dateRow); }
        else {
          showEl(valGroup);
          hideEl(dateRow);
          var labels = { patient: 'Patient Wallet ID', medication: 'NDC Hash', pharmacy: 'Pharmacy Wallet ID' };
          setText('#rx-filter-value-label', labels[type] || 'Value');
        }
      });
      rxFilterType.dispatchEvent(new Event('change'));
    }

    var rxFilterBtn = $('#rx-filter-btn');
    if (rxFilterBtn) rxFilterBtn.addEventListener('click', loadPrescriptionHistory);

    var rxClearBtn = $('#rx-clear-btn');
    if (rxClearBtn) rxClearBtn.addEventListener('click', function () {
      if (rxFilterType) { rxFilterType.value = 'all'; rxFilterType.dispatchEvent(new Event('change')); }
      loadPrescriptionHistory();
    });

    // Patients
    var ptRefresh = $('#pt-refresh-btn');
    if (ptRefresh) ptRefresh.addEventListener('click', loadPatients);

    var durBtn = $('#dur-lookup-btn');
    if (durBtn) durBtn.addEventListener('click', function () { durLookup(); });

    // Formulary
    var formLookup = $('#form-lookup-btn');
    if (formLookup) formLookup.addEventListener('click', formularyLookup);

    var formCheck = $('#form-check-btn');
    if (formCheck) formCheck.addEventListener('click', checkDrugCoverage);

    // Providers
    var provRefresh = $('#prov-refresh-btn');
    if (provRefresh) provRefresh.addEventListener('click', loadProviders);

    // Messaging
    var msgComposeBtn = $('#msg-compose-btn');
    if (msgComposeBtn) msgComposeBtn.addEventListener('click', function () { showEl('#msg-compose-overlay'); });

    var msgComposeClose = $('#msg-compose-close');
    if (msgComposeClose) msgComposeClose.addEventListener('click', function () { hideEl('#msg-compose-overlay'); });

    var msgComposeOverlay = $('#msg-compose-overlay');
    if (msgComposeOverlay) msgComposeOverlay.addEventListener('click', function (e) { if (e.target === this) hideEl('#msg-compose-overlay'); });

    var msgComposeSend = $('#msg-compose-send-btn');
    if (msgComposeSend) msgComposeSend.addEventListener('click', sendComposeMessage);

    var msgSendBtn = $('#msg-send-btn');
    if (msgSendBtn) msgSendBtn.addEventListener('click', sendThreadMessage);

    var msgInput = $('#msg-input-text');
    if (msgInput) msgInput.addEventListener('keypress', function (e) { if (e.key === 'Enter') sendThreadMessage(); });

    // Onboarding wizard
    for (var i = 0; i <= 4; i++) {
      (function (step) {
        var btn = $('#wiz-btn-' + step);
        if (btn) btn.addEventListener('click', function () { wizardAction(step); });
      })(i);
    }

    var wizBackup = $('#wiz-backup-btn');
    if (wizBackup) wizBackup.addEventListener('click', function () {
      var pin = prompt('Enter a PIN to encrypt your backup:');
      if (!pin) return;
      API.backupKey(pin).then(function (res) {
        setHTML('#wiz-result-5', '<div class="form-result success">Backup created. Store safely: ' + esc(JSON.stringify(res.backup)) + '</div>');
        toast('Backup created', 'success');
      }).catch(function (err) {
        setHTML('#wiz-result-5', '<div class="form-result error">' + esc(err.message) + '</div>');
      });
    });

    // Proofs
    var proofRegBtn = $('#proof-reg-btn');
    if (proofRegBtn) proofRegBtn.addEventListener('click', generateRegistrationProof);

    var proofRefresh = $('#proof-refresh-btn');
    if (proofRefresh) proofRefresh.addEventListener('click', loadProofTimings);
  }

  // ── Init ─────────────────────────────────────────────────────

  async function init() {
    initPrescriberSelector();
    initBadgeTap();
    bindEvents();

    // Initial health + status
    try {
      var status = await API.getOnboardingStatus();
      onboardingPhase = status.phase || 'awaiting_token';
      walletId = status.walletId || null;
      setText('#header-wallet', truncHash(walletId, 16));
    } catch (_) { }

    initSSE();

    var hash = location.hash.replace('#', '') || 'overview';
    navigate(hash);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
