// zkTrident Pharmacy Nautilus Dashboard — SPA Application Logic
// Hash-based routing, REST API integration, SSE live events.

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let currentTab = 'overview';
  let onboardingStatus = null;
  let overviewRefreshTimer = null;
  let durCurrentWallet = null;
  let sseEvents = [];
  const MAX_EVENTS = 200;
  let durLookupCount = 0;

  // ── Utilities ────────────────────────────────────────────────

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function truncate(s, n) {
    if (!s) return '--';
    s = String(s);
    if (s.length <= n) return s;
    return s.slice(0, n) + '...';
  }

  function formatField(v) {
    if (v === null || v === undefined) return '--';
    return String(v);
  }

  function formatCents(cents) {
    if (cents === null || cents === undefined) return '--';
    const n = Number(cents);
    if (isNaN(n)) return String(cents);
    return '$' + (n / 100).toFixed(2);
  }

  function formatDate(d) {
    if (!d) return '--';
    const s = String(d);
    if (s.length === 8) {
      return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    }
    if (typeof d === 'number' && d > 1e12) {
      return new Date(d).toLocaleString();
    }
    return s;
  }

  function timeStr() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  function showEl(el) {
    if (typeof el === 'string') el = $(el);
    if (el) el.classList.remove('hidden');
  }

  function hideEl(el) {
    if (typeof el === 'string') el = $(el);
    if (el) el.classList.add('hidden');
  }

  function setHTML(sel, html) {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.innerHTML = html;
  }

  function setText(sel, text) {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.textContent = text;
  }

  // ── Router ───────────────────────────────────────────────────

  const TABS = ['overview', 'onboarding', 'dispensing', 'dur', 'nfc', 'messaging', 'proofs'];

  function navigate(tab) {
    if (!TABS.includes(tab)) tab = 'overview';
    currentTab = tab;
    location.hash = '#' + tab;

    // Update nav
    $$('.nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Update pages
    $$('.page').forEach(page => {
      page.classList.toggle('active', page.id === 'page-' + tab);
    });

    // Load data for tab
    onTabEnter(tab);
  }

  function onTabEnter(tab) {
    switch (tab) {
      case 'overview': loadOverview(); break;
      case 'onboarding': loadOnboarding(); break;
      case 'dispensing': loadDispensing(); break;
      case 'dur': break; // DUR is user-driven
      case 'nfc': break; // NFC is user-driven
      case 'messaging': loadMessaging('inbox'); break;
      case 'proofs': loadProofs(); break;
    }
  }

  // ── SSE ──────────────────────────────────────────────────────

  function initSSE() {
    API.sse.connect();
    API.sse.onEvent(function (ev) {
      if (ev.type === '__connection') {
        const dot = $('#connection-dot');
        if (ev.data.connected) {
          dot.classList.add('connected');
          dot.classList.remove('disconnected');
        } else {
          dot.classList.remove('connected');
          dot.classList.add('disconnected');
        }
        return;
      }
      // Store event
      sseEvents.unshift({ time: timeStr(), type: ev.type || 'event', data: ev });
      if (sseEvents.length > MAX_EVENTS) sseEvents.length = MAX_EVENTS;
      // Update live log if on overview
      if (currentTab === 'overview') {
        renderEventLog();
      }
    });
  }

  function renderEventLog() {
    const container = $('#ov-events');
    if (!container) return;
    if (sseEvents.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:24px;"><div class="empty-state-desc">Waiting for events...</div></div>';
      return;
    }
    const html = sseEvents.slice(0, 50).map(function (ev) {
      const detail = typeof ev.data === 'object' ? JSON.stringify(ev.data).slice(0, 120) : String(ev.data).slice(0, 120);
      return '<div class="event-entry">' +
        '<span class="event-time">' + ev.time + '</span>' +
        '<span class="event-type">' + escapeHtml(ev.type) + '</span>' +
        '<span class="event-detail">' + escapeHtml(detail) + '</span>' +
        '</div>';
    }).join('');
    container.innerHTML = html;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Overview ─────────────────────────────────────────────────

  async function loadOverview() {
    // Load onboarding status for phase
    try {
      const status = await API.onboarding.status();
      onboardingStatus = status;
      setText('#ov-phase', status.phase || status.step || '--');
      const wid = status.walletId || status.wallet || '--';
      setText('#ov-wallet', truncate(wid, 24));
      setText('#header-wallet', truncate(wid, 16));
    } catch (_) {
      setText('#ov-phase', 'Offline');
    }

    // Load dispensing summary for stats
    try {
      const summary = await API.dispensing.summary();
      setText('#ov-dispensed', formatField(summary.totalClaims || summary.total || 0));
      setText('#ov-patients', formatField(summary.uniquePatients || summary.patients || 0));
    } catch (_) {
      setText('#ov-dispensed', '0');
      setText('#ov-patients', '0');
    }

    setText('#ov-dur', String(durLookupCount));

    // Activity summary
    try {
      const summary = await API.dispensing.summary();
      let html = '<div class="mb-12">';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Total Claims</span><span class="fw-600">' + formatField(summary.totalClaims || summary.total || 0) + '</span></div>';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Unique Patients</span><span class="fw-600">' + formatField(summary.uniquePatients || summary.patients || 0) + '</span></div>';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Unique Medications</span><span class="fw-600">' + formatField(summary.uniqueMedications || summary.medications || 0) + '</span></div>';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Unique Prescribers</span><span class="fw-600">' + formatField(summary.uniquePrescribers || summary.prescribers || 0) + '</span></div>';
      if (summary.totalPatientPay !== undefined) {
        html += '<div class="flex justify-between mb-8"><span class="text-secondary">Total Patient Pay</span><span class="fw-600 text-yellow">' + formatCents(summary.totalPatientPay) + '</span></div>';
      }
      if (summary.totalPlanPay !== undefined) {
        html += '<div class="flex justify-between mb-8"><span class="text-secondary">Total Plan Pay</span><span class="fw-600 text-blue">' + formatCents(summary.totalPlanPay) + '</span></div>';
      }
      html += '</div>';
      setHTML('#ov-activity', html);
    } catch (_) {
      setHTML('#ov-activity', '<div class="text-muted">Unable to load summary</div>');
    }

    renderEventLog();

    // Auto-refresh
    clearInterval(overviewRefreshTimer);
    overviewRefreshTimer = setInterval(function () {
      if (currentTab === 'overview') loadOverview();
    }, 30000);
  }

  // ── Onboarding ───────────────────────────────────────────────

  const ONBOARDING_STEPS = [
    'accept-token', 'generate-key', 'derive-wallet', 'enroll', 'compile', 'done'
  ];

  async function loadOnboarding() {
    try {
      const status = await API.onboarding.status();
      onboardingStatus = status;
      const step = resolveOnboardingStep(status);
      updateWizardUI(step, status);
    } catch (err) {
      updateWizardUI(0, null);
    }
  }

  function resolveOnboardingStep(status) {
    if (!status) return 0;
    const phase = (status.phase || status.step || '').toLowerCase();
    if (phase.includes('ready') || phase.includes('done') || phase.includes('compiled') || phase.includes('complete')) return 5;
    if (phase.includes('compil')) return 4;
    if (phase.includes('enroll')) return 3;
    if (phase.includes('wallet') || phase.includes('deriv')) return 2;
    if (phase.includes('key') || phase.includes('generat')) return 1;
    if (phase.includes('token') || phase.includes('accept')) return 0;
    // Try numeric step
    if (typeof status.stepIndex === 'number') return Math.min(status.stepIndex, 5);
    return 0;
  }

  function updateWizardUI(currentStep, status) {
    // Update step indicators
    $$('.wizard-step').forEach(function (el) {
      const s = parseInt(el.dataset.step);
      el.classList.remove('done', 'current');
      if (s < currentStep) el.classList.add('done');
      else if (s === currentStep) el.classList.add('current');
    });

    // Show correct panel
    for (let i = 0; i <= 5; i++) {
      const panel = $('#wiz-panel-' + i);
      if (panel) {
        if (i === currentStep) panel.classList.remove('hidden');
        else panel.classList.add('hidden');
      }
    }

    // Done panel
    if (currentStep === 5 && status) {
      const result = $('#wiz-result-5');
      if (result) {
        result.style.display = 'block';
        result.textContent = 'Wallet: ' + (status.walletId || status.wallet || '--');
      }
      const statsEl = $('#wiz-done-stats');
      if (statsEl) {
        statsEl.innerHTML =
          '<div class="stat-card"><div class="stat-label">Phase</div><div class="stat-value accent">' + escapeHtml(status.phase || 'READY') + '</div></div>' +
          '<div class="stat-card"><div class="stat-label">Wallet</div><div class="stat-value text-mono" style="font-size:12px; word-break:break-all;">' + escapeHtml(status.walletId || status.wallet || '--') + '</div></div>';
      }
    }
  }

  async function wizardAction(step) {
    const resultEl = $('#wiz-result-' + step);
    const btn = $('#wiz-btn-' + step);
    if (btn) btn.disabled = true;
    if (resultEl) {
      resultEl.classList.remove('hidden', 'error');
      resultEl.textContent = 'Processing...';
    }

    try {
      let result;
      switch (step) {
        case 0:
          result = await API.onboarding.acceptToken({
            tokenId: $('#wiz-tokenId').value || undefined,
            groupId: $('#wiz-groupId').value || undefined,
            planId: $('#wiz-planId').value || undefined,
          });
          break;
        case 1:
          result = await API.onboarding.generateKey({
            enrollmentKey: $('#wiz-enrollmentKey').value || undefined,
          });
          break;
        case 2:
          result = await API.onboarding.deriveWallet({
            serviceProviderIdQualifier: parseInt($('#wiz-qualifier').value) || 1,
            serviceProviderId: $('#wiz-providerId').value,
          });
          break;
        case 3:
          result = await API.onboarding.enroll({
            insurerUrl: $('#wiz-insurerUrl').value || undefined,
          });
          break;
        case 4:
          result = await API.onboarding.compile();
          break;
      }
      if (resultEl) {
        resultEl.classList.remove('error');
        resultEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      }
      // Advance to next step after brief delay
      setTimeout(function () { loadOnboarding(); }, 800);
    } catch (err) {
      if (resultEl) {
        resultEl.classList.add('error');
        resultEl.textContent = 'Error: ' + (err.message || String(err));
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Dispensing ───────────────────────────────────────────────

  async function loadDispensing() {
    // Summary stats
    try {
      const summary = await API.dispensing.summary();
      setText('#disp-total', formatField(summary.totalClaims || summary.total || 0));
      setText('#disp-patients', formatField(summary.uniquePatients || summary.patients || 0));
      setText('#disp-meds', formatField(summary.uniqueMedications || summary.medications || 0));
      setText('#disp-prescribers', formatField(summary.uniquePrescribers || summary.prescribers || 0));
    } catch (_) { }

    // Main table
    await loadDispensingTable();

    // Breakdowns
    loadMedBreakdown();
    loadPrescriberBreakdown();
  }

  async function loadDispensingTable(params) {
    const tbody = $('#disp-table-body');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading...</td></tr>';

    try {
      let claims;
      if (params) {
        if (params.patient) {
          claims = await API.dispensing.byPatient(params.patient);
        } else if (params.prescriber) {
          claims = await API.dispensing.byPrescriber(params.prescriber);
        } else if (params.medication) {
          claims = await API.dispensing.byMedication(params.medication);
        } else if (params.start && params.end) {
          claims = await API.dispensing.range(params.start, params.end);
        } else {
          claims = await API.dispensing.list();
        }
      } else {
        claims = await API.dispensing.list();
      }

      const arr = Array.isArray(claims) ? claims : (claims.claims || claims.history || []);
      setText('#disp-count', arr.length + ' claims');

      if (arr.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">No dispensing records found</td></tr>';
        return;
      }

      tbody.innerHTML = arr.map(function (c) {
        return '<tr>' +
          '<td class="mono muted">' + formatField(c.leafIndex || c.index) + '</td>' +
          '<td class="mono truncate">' + truncate(c.memberWalletId || c.patient || c.patientWalletId, 18) + '</td>' +
          '<td class="mono truncate">' + truncate(c.ndcHash || c.medication, 18) + '</td>' +
          '<td class="mono truncate">' + truncate(c.prescriberWalletId || c.prescriber, 18) + '</td>' +
          '<td class="muted">' + formatDate(c.dateOfService || c.date) + '</td>' +
          '<td class="text-yellow">' + formatCents(c.patientPayCents || c.patientPay) + '</td>' +
          '<td class="text-blue">' + formatCents(c.planPayCents || c.planPay) + '</td>' +
          '</tr>';
      }).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-red">Error: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  async function loadMedBreakdown() {
    const tbody = $('#disp-med-breakdown');
    try {
      const data = await API.dispensing.medicationsBreakdown();
      const arr = Array.isArray(data) ? data : (data.breakdown || data.medications || []);
      if (arr.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="muted">No data</td></tr>';
        return;
      }
      tbody.innerHTML = arr.map(function (m) {
        return '<tr>' +
          '<td class="mono truncate">' + truncate(m.ndcHash || m.medication, 20) + '</td>' +
          '<td>' + formatField(m.count || m.claimCount) + '</td>' +
          '<td class="text-blue">' + formatCents(m.totalPlanPay || m.planPay) + '</td>' +
          '</tr>';
      }).join('');
    } catch (_) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">Unable to load</td></tr>';
    }
  }

  async function loadPrescriberBreakdown() {
    const tbody = $('#disp-presc-breakdown');
    try {
      const data = await API.dispensing.prescribersBreakdown();
      const arr = Array.isArray(data) ? data : (data.breakdown || data.prescribers || []);
      if (arr.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="muted">No data</td></tr>';
        return;
      }
      tbody.innerHTML = arr.map(function (p) {
        return '<tr>' +
          '<td class="mono truncate">' + truncate(p.prescriberWalletId || p.prescriber, 20) + '</td>' +
          '<td>' + formatField(p.count || p.claimCount) + '</td>' +
          '<td>' + formatField(p.uniquePatients || p.patients) + '</td>' +
          '</tr>';
      }).join('');
    } catch (_) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">Unable to load</td></tr>';
    }
  }

  function applyDispensingFilter() {
    const patient = $('#disp-filter-patient').value.trim();
    const prescriber = $('#disp-filter-prescriber').value.trim();
    const medication = $('#disp-filter-medication').value.trim();
    const start = $('#disp-filter-start').value.replace(/-/g, '');
    const end = $('#disp-filter-end').value.replace(/-/g, '');

    const params = {};
    if (patient) params.patient = patient;
    else if (prescriber) params.prescriber = prescriber;
    else if (medication) params.medication = medication;
    else if (start && end) { params.start = start; params.end = end; }

    loadDispensingTable(Object.keys(params).length > 0 ? params : null);
  }

  function clearDispensingFilter() {
    $('#disp-filter-patient').value = '';
    $('#disp-filter-prescriber').value = '';
    $('#disp-filter-medication').value = '';
    $('#disp-filter-start').value = '';
    $('#disp-filter-end').value = '';
    loadDispensingTable();
  }

  // ── DUR (Drug Utilization Review) ────────────────────────────

  async function durLookup(walletId) {
    if (!walletId) return;
    durCurrentWallet = walletId;
    durLookupCount++;

    showEl('#dur-results-area');
    hideEl('#dur-claim-detail');
    setHTML('#dur-alerts', '');
    setHTML('#dur-active-meds', '<li class="loading">Loading active medications...</li>');
    setHTML('#dur-history-table', '<tr><td colspan="6" class="loading">Loading cross-pharmacy history...</td></tr>');

    // Load active medications
    try {
      const active = await API.dur.activeMedications(walletId);
      const meds = Array.isArray(active) ? active : (active.medications || active.activeMedications || []);
      setText('#dur-active-count', String(meds.length));

      if (meds.length === 0) {
        setHTML('#dur-active-meds', '<li class="empty-state" style="padding:24px;"><div class="empty-state-desc">No active medications</div></li>');
      } else {
        setHTML('#dur-active-meds', meds.map(function (m) {
          const remaining = m.daysRemaining !== undefined ? m.daysRemaining + ' days remaining' : '';
          return '<li class="dur-med-item">' +
            '<div><div class="dur-med-name">' + truncate(m.ndcHash || m.medication || m.name, 20) + '</div>' +
            '<div class="dur-med-detail">' + (m.pharmacy ? 'Pharmacy: ' + truncate(m.pharmacy || m.pharmacyWalletId, 16) : '') + '</div></div>' +
            '<div>' + (remaining ? '<span class="badge badge-green">' + escapeHtml(remaining) + '</span>' : '') + '</div>' +
            '</li>';
        }).join(''));
      }
    } catch (err) {
      setHTML('#dur-active-meds', '<li class="dur-alert dur-alert-warn">Unable to load active medications: ' + escapeHtml(err.message) + '</li>');
    }

    // Load full history
    try {
      const history = await API.dur.fullHistory(walletId);
      const claims = Array.isArray(history) ? history : (history.claims || history.history || []);
      setText('#dur-history-count', String(claims.length));

      if (claims.length === 0) {
        setHTML('#dur-history-table', '<tr><td colspan="6" class="muted">No cross-pharmacy history found</td></tr>');
      } else {
        setHTML('#dur-history-table', claims.map(function (c) {
          const idx = c.leafIndex || c.index || '';
          return '<tr>' +
            '<td class="mono truncate">' + truncate(c.ndcHash || c.medication, 16) + '</td>' +
            '<td class="mono truncate">' + truncate(c.pharmacyWalletId || c.pharmacy, 16) + '</td>' +
            '<td class="muted">' + formatDate(c.dateOfService || c.date) + '</td>' +
            '<td class="text-yellow">' + formatCents(c.patientPayCents || c.patientPay) + '</td>' +
            '<td class="text-blue">' + formatCents(c.planPayCents || c.planPay) + '</td>' +
            '<td>' + (idx !== '' ? '<button class="btn btn-sm" onclick="App.durClaimDetail(\'' + idx + '\')">View</button>' : '--') + '</td>' +
            '</tr>';
        }).join(''));

        // Check for duplicate pharmacies dispensing same medication (cross-pharmacy alert)
        const medPharmMap = {};
        claims.forEach(function (c) {
          const med = c.ndcHash || c.medication || '';
          const pharm = c.pharmacyWalletId || c.pharmacy || '';
          if (!med) return;
          if (!medPharmMap[med]) medPharmMap[med] = new Set();
          medPharmMap[med].add(pharm);
        });

        let alertHtml = '';
        Object.keys(medPharmMap).forEach(function (med) {
          if (medPharmMap[med].size > 1) {
            alertHtml += '<div class="dur-alert dur-alert-warn">' +
              '<span class="fw-600">[MULTI-PHARMACY]</span> Medication ' + truncate(med, 20) +
              ' dispensed at ' + medPharmMap[med].size + ' different pharmacies' +
              '</div>';
          }
        });

        if (alertHtml) {
          setHTML('#dur-alerts', alertHtml);
        }
      }
    } catch (err) {
      setHTML('#dur-history-table', '<tr><td colspan="6" class="text-red">Error: ' + escapeHtml(err.message) + '</td></tr>');
    }
  }

  async function durCheckDuplicate() {
    if (!durCurrentWallet) return;
    const ndcHash = $('#dur-check-ndc').value.trim();
    if (!ndcHash) return;

    setHTML('#dur-check-result', '<div class="loading">Checking...</div>');

    try {
      const result = await API.dur.checkDuplicate(durCurrentWallet, ndcHash);
      const isDuplicate = result.duplicate || result.isDuplicate || result.found || false;
      if (isDuplicate) {
        let detail = '';
        if (result.existingClaim || result.claim) {
          const c = result.existingClaim || result.claim;
          detail = ' -- Last filled at pharmacy ' + truncate(c.pharmacyWalletId || c.pharmacy, 16) +
            ' on ' + formatDate(c.dateOfService || c.date);
        }
        setHTML('#dur-check-result',
          '<div class="dur-alert dur-alert-danger">' +
          '<span class="fw-600">[DUPLICATE THERAPY]</span> Patient already has an active claim for this medication.' +
          escapeHtml(detail) +
          '</div>');
      } else {
        setHTML('#dur-check-result',
          '<div class="dur-alert dur-alert-ok">' +
          '<span class="fw-600">[CLEAR]</span> No active duplicate therapy found for this medication.' +
          '</div>');
      }
    } catch (err) {
      setHTML('#dur-check-result',
        '<div class="dur-alert dur-alert-warn">Error checking: ' + escapeHtml(err.message) + '</div>');
    }
  }

  async function durClaimDetail(leafIndex) {
    showEl('#dur-claim-detail');
    setHTML('#dur-claim-detail-body', '<div class="loading">Loading claim detail with Merkle proof...</div>');

    try {
      const detail = await API.dur.claimDetail(leafIndex);
      let html = '<div class="mb-16">';

      // Claim fields
      const fields = [
        ['Leaf Index', detail.leafIndex || detail.index || leafIndex],
        ['Member Wallet', detail.memberWalletId || detail.patient],
        ['NDC Hash', detail.ndcHash || detail.medication],
        ['Pharmacy Wallet', detail.pharmacyWalletId || detail.pharmacy],
        ['Prescriber Wallet', detail.prescriberWalletId || detail.prescriber],
        ['Date of Service', formatDate(detail.dateOfService || detail.date)],
        ['Patient Pay', formatCents(detail.patientPayCents || detail.patientPay)],
        ['Plan Pay', formatCents(detail.planPayCents || detail.planPay)],
        ['Deductible Credit', formatCents(detail.deductibleCreditCents || detail.deductibleCredit)],
      ];

      fields.forEach(function (f) {
        html += '<div class="flex justify-between mb-8">' +
          '<span class="text-secondary">' + f[0] + '</span>' +
          '<span class="fw-600 text-mono" style="word-break:break-all; max-width:60%; text-align:right;">' + escapeHtml(formatField(f[1])) + '</span>' +
          '</div>';
      });

      html += '</div>';

      // Merkle proof
      if (detail.merkleProof || detail.proof || detail.witness) {
        const proof = detail.merkleProof || detail.proof || detail.witness;
        html += '<div class="mb-8 fw-600 text-secondary">Merkle Proof</div>';
        html += '<div style="background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px; font-family:var(--font-mono); font-size:11px; max-height:200px; overflow-y:auto; word-break:break-all;">';
        html += escapeHtml(typeof proof === 'string' ? proof : JSON.stringify(proof, null, 2));
        html += '</div>';
      }

      setHTML('#dur-claim-detail-body', html);
    } catch (err) {
      setHTML('#dur-claim-detail-body', '<div class="text-red">Error loading claim: ' + escapeHtml(err.message) + '</div>');
    }
  }

  // ── NFC Scan ─────────────────────────────────────────────────

  async function nfcScan(walletId) {
    const scanArea = $('#nfc-scan-area');
    scanArea.classList.add('scanning');

    try {
      const params = {};
      if (walletId) {
        params.walletId = walletId;
      }
      // If no walletId, send empty body (hardware scan)

      const result = await API.nfc.scan(params);

      scanArea.classList.remove('scanning');
      hideEl('#nfc-scan-area');
      showEl('#nfc-patient-result');

      // Populate patient card
      setText('#nfc-patient-wallet', result.walletId || '--');
      setText('#nfc-active-meds', formatField(result.activeMedicationCount || result.activeMedications || 0));
      setText('#nfc-total-claims', formatField(result.totalClaims || 0));
      setText('#nfc-scan-status', 'Verified');

      // Drug history
      const history = result.fullHistory || result.history || [];
      const tbody = $('#nfc-history-table');
      if (Array.isArray(history) && history.length > 0) {
        tbody.innerHTML = history.map(function (c) {
          return '<tr>' +
            '<td class="mono truncate">' + truncate(c.ndcHash || c.medication, 18) + '</td>' +
            '<td class="mono truncate">' + truncate(c.pharmacyWalletId || c.pharmacy, 18) + '</td>' +
            '<td class="muted">' + formatDate(c.dateOfService || c.date) + '</td>' +
            '<td class="text-yellow">' + formatCents(c.patientPayCents || c.patientPay) + '</td>' +
            '<td class="text-blue">' + formatCents(c.planPayCents || c.planPay) + '</td>' +
            '</tr>';
        }).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="5" class="muted">No drug history found</td></tr>';
      }
    } catch (err) {
      scanArea.classList.remove('scanning');
      alert('NFC scan failed: ' + (err.message || String(err)));
    }
  }

  function nfcClear() {
    hideEl('#nfc-patient-result');
    showEl('#nfc-scan-area');
    $('#nfc-wallet-input').value = '';
    $('#nfc-scan-area').classList.remove('scanning');
  }

  // ── Messaging ────────────────────────────────────────────────

  let msgCurrentView = 'inbox';

  function switchMsgView(view) {
    msgCurrentView = view;
    $$('.msg-sidebar-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    ['inbox', 'sent', 'compose', 'thread'].forEach(function (v) {
      const el = $('#msg-' + v + '-view');
      if (el) {
        if (v === view) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
    });

    if (view === 'inbox') loadMessaging('inbox');
    else if (view === 'sent') loadMessaging('sent');
  }

  async function loadMessaging(type) {
    const listEl = type === 'inbox' ? '#msg-inbox-list' : '#msg-sent-list';

    try {
      const data = type === 'inbox' ? await API.messaging.inbox() : await API.messaging.sent();
      const messages = Array.isArray(data) ? data : (data.messages || []);

      if (messages.length === 0) {
        setHTML(listEl,
          '<div class="empty-state"><div class="empty-state-title">No messages</div>' +
          '<div class="empty-state-desc">' + (type === 'inbox' ? 'Your inbox is empty.' : 'No sent messages.') + '</div></div>');
        return;
      }

      setHTML(listEl, messages.map(function (m) {
        const from = m.senderWalletId || m.sender || m.from || '--';
        const to = m.recipientWalletId || m.recipient || m.to || '--';
        const subject = m.subject || m.message || '(no subject)';
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString() : '--';
        const threadId = m.threadIdHash || m.threadId || '';
        return '<div class="msg-item" data-thread="' + escapeHtml(threadId) + '">' +
          '<div class="msg-item-header">' +
          '<span class="msg-item-from">' + (type === 'inbox' ? truncate(from, 20) : 'To: ' + truncate(to, 20)) + '</span>' +
          '<span class="msg-item-time">' + escapeHtml(time) + '</span>' +
          '</div>' +
          '<div class="msg-item-preview">' + escapeHtml(subject) + '</div>' +
          '</div>';
      }).join(''));

      // Click to view thread
      $$(listEl + ' .msg-item').forEach(function (item) {
        item.addEventListener('click', function () {
          const threadId = this.dataset.thread;
          if (threadId) loadThread(threadId);
        });
      });
    } catch (err) {
      setHTML(listEl, '<div class="empty-state"><div class="empty-state-desc text-red">Error: ' + escapeHtml(err.message) + '</div></div>');
    }
  }

  async function loadThread(threadIdHash) {
    switchMsgViewRaw('thread');
    setHTML('#msg-thread-list', '<div class="loading">Loading thread...</div>');

    try {
      const data = await API.messaging.thread(threadIdHash);
      const messages = Array.isArray(data) ? data : (data.messages || []);

      if (messages.length === 0) {
        setHTML('#msg-thread-list', '<div class="empty-state"><div class="empty-state-desc">Thread is empty</div></div>');
        return;
      }

      setHTML('#msg-thread-list', messages.map(function (m) {
        return '<div class="msg-thread-entry">' +
          '<div class="msg-thread-meta">' +
          '<span class="mono">' + truncate(m.senderWalletId || m.sender || m.from, 20) + '</span>' +
          '<span>' + (m.timestamp ? new Date(m.timestamp).toLocaleString() : '--') + '</span>' +
          '</div>' +
          '<div class="msg-thread-body">' + escapeHtml(m.message || m.body || m.content || '') + '</div>' +
          '</div>';
      }).join(''));
    } catch (err) {
      setHTML('#msg-thread-list', '<div class="empty-state text-red">Error: ' + escapeHtml(err.message) + '</div>');
    }
  }

  function switchMsgViewRaw(view) {
    ['inbox', 'sent', 'compose', 'thread'].forEach(function (v) {
      const el = $('#msg-' + v + '-view');
      if (el) {
        if (v === view) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
    });
  }

  async function sendMessage() {
    const recipient = $('#msg-recipient').value.trim();
    const subject = $('#msg-subject').value.trim();
    const body = $('#msg-body').value.trim();
    const thread = $('#msg-thread').value.trim();
    const resultEl = $('#msg-send-result');

    if (!recipient || !body) {
      resultEl.classList.remove('hidden');
      resultEl.classList.add('error');
      resultEl.textContent = 'Recipient and message body are required.';
      return;
    }

    resultEl.classList.remove('hidden', 'error');
    resultEl.textContent = 'Sending...';

    try {
      const payload = {
        recipientWalletId: recipient,
        subject: subject,
        body: body,
      };
      if (thread) payload.threadIdHash = thread;

      await API.messaging.send({
        message: subject || body.slice(0, 100),
        payload: payload,
      });

      resultEl.classList.remove('error');
      resultEl.textContent = 'Message sent successfully.';
      $('#msg-recipient').value = '';
      $('#msg-subject').value = '';
      $('#msg-body').value = '';
      $('#msg-thread').value = '';
    } catch (err) {
      resultEl.classList.add('error');
      resultEl.textContent = 'Error: ' + (err.message || String(err));
    }
  }

  // ── Proofs ───────────────────────────────────────────────────

  async function loadProofs() {
    // Status
    try {
      const status = await API.onboarding.status();
      let html = '<div>';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Phase</span><span class="fw-600 text-accent">' + escapeHtml(status.phase || '--') + '</span></div>';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Wallet</span><span class="fw-600 text-mono" style="font-size:12px;">' + escapeHtml(truncate(status.walletId || status.wallet, 28)) + '</span></div>';
      if (status.compiled !== undefined) {
        html += '<div class="flex justify-between mb-8"><span class="text-secondary">Compiled</span><span class="fw-600 ' + (status.compiled ? 'text-green' : 'text-red') + '">' + (status.compiled ? 'Yes' : 'No') + '</span></div>';
      }
      html += '</div>';
      setHTML('#proof-status', html);
    } catch (_) {
      setHTML('#proof-status', '<div class="text-muted">Unable to load status</div>');
    }

    // Timings
    try {
      const timings = await API.proof.timings();
      const entries = Array.isArray(timings) ? timings : (timings.timings || Object.entries(timings || {}).map(function (e) { return { name: e[0], ms: e[1] }; }));

      if (entries.length === 0) {
        setHTML('#proof-timings', '<div class="text-muted">No proof timings recorded yet.</div>');
        return;
      }

      const maxMs = Math.max.apply(null, entries.map(function (e) { return e.ms || e.duration || e.time || 0; }));

      setHTML('#proof-timings', entries.map(function (e) {
        const ms = e.ms || e.duration || e.time || 0;
        const pct = maxMs > 0 ? Math.max(2, (ms / maxMs) * 100) : 2;
        const label = e.name || e.label || e.program || '--';
        const secs = (ms / 1000).toFixed(2);
        return '<div class="timing-bar">' +
          '<div class="timing-label">' + escapeHtml(label) + '</div>' +
          '<div class="timing-track"><div class="timing-fill" style="width:' + pct + '%;">' + secs + 's</div></div>' +
          '</div>';
      }).join(''));
    } catch (_) {
      setHTML('#proof-timings', '<div class="text-muted">No proof timings available.</div>');
    }
  }

  async function generateRegistrationProof() {
    const btn = $('#proof-reg-btn');
    const resultEl = $('#proof-reg-result');
    btn.disabled = true;
    resultEl.classList.remove('hidden', 'error');
    resultEl.textContent = 'Generating registration proof... This may take a moment.';

    try {
      const result = await API.proof.registration();
      resultEl.classList.remove('error');
      resultEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      resultEl.classList.add('error');
      resultEl.textContent = 'Error: ' + (err.message || String(err));
    } finally {
      btn.disabled = false;
    }
  }

  // ── Event Binding ────────────────────────────────────────────

  function bindEvents() {
    // Nav tabs
    $$('.nav-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(this.dataset.tab);
      });
    });

    // Hash change
    window.addEventListener('hashchange', function () {
      const hash = location.hash.replace('#', '') || 'overview';
      navigate(hash);
    });

    // Onboarding wizard buttons
    for (let i = 0; i <= 4; i++) {
      (function (step) {
        var btn = $('#wiz-btn-' + step);
        if (btn) btn.addEventListener('click', function () { wizardAction(step); });
      })(i);
    }

    // Dispensing filters
    $('#disp-filter-btn').addEventListener('click', applyDispensingFilter);
    $('#disp-clear-btn').addEventListener('click', clearDispensingFilter);

    // DUR
    $('#dur-lookup-btn').addEventListener('click', function () {
      durLookup($('#dur-wallet-input').value.trim());
    });
    $('#dur-wallet-input').addEventListener('keypress', function (e) {
      if (e.key === 'Enter') durLookup(this.value.trim());
    });
    $('#dur-check-btn').addEventListener('click', durCheckDuplicate);
    $('#dur-check-ndc').addEventListener('keypress', function (e) {
      if (e.key === 'Enter') durCheckDuplicate();
    });
    $('#dur-detail-close').addEventListener('click', function () {
      hideEl('#dur-claim-detail');
    });

    // NFC
    $('#nfc-scan-btn').addEventListener('click', function () {
      nfcScan();
    });
    $('#nfc-manual-btn').addEventListener('click', function () {
      const wid = $('#nfc-wallet-input').value.trim();
      if (wid) nfcScan(wid);
    });
    $('#nfc-wallet-input').addEventListener('keypress', function (e) {
      if (e.key === 'Enter') {
        const wid = this.value.trim();
        if (wid) nfcScan(wid);
      }
    });
    $('#nfc-clear-btn').addEventListener('click', nfcClear);

    // Messaging
    $$('.msg-sidebar-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchMsgView(this.dataset.view);
      });
    });
    $('#msg-send-btn').addEventListener('click', sendMessage);
    $('#msg-thread-back').addEventListener('click', function () {
      switchMsgView('inbox');
    });

    // Proofs
    $('#proof-reg-btn').addEventListener('click', generateRegistrationProof);
  }

  // ── Init ─────────────────────────────────────────────────────

  function init() {
    bindEvents();
    initSSE();

    // Route from hash
    const hash = location.hash.replace('#', '') || 'overview';
    navigate(hash);
  }

  // Expose for inline onclick handlers
  window.App = {
    durClaimDetail: durClaimDetail,
  };

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
