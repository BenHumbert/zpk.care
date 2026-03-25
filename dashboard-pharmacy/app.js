// Adjuda-GATOR Pharmacy Workstation — SPA Application Logic
// 4-column dispensing workflow (Adjudicated → Filled → Dispensed → History), script history, DUR, messaging, onboarding, proofs.

(function () {
  'use strict';

  // ── Pharmacies (loaded from server — real NPPES data) ───────
  var PHARMACIES = [];

  const PHARMACY_KEY = 'zkp_pharmacy_selected';

  function getSelectedPharmacy() {
    var saved = localStorage.getItem(PHARMACY_KEY);
    if (saved) {
      var found = PHARMACIES.find(function (p) { return p.npi === saved; });
      if (found) return found;
    }
    return PHARMACIES[0];
  }

  function setSelectedPharmacy(npi) {
    localStorage.setItem(PHARMACY_KEY, npi);
  }

  // ── State ────────────────────────────────────────────────────
  let currentTab = 'workstation';
  let onboardingStatus = null;
  let sseEvents = [];
  const MAX_EVENTS = 200;
  let durCurrentWallet = null;
  let durLookupCount = 0;

  // Script workflow state — transient UI state only (memberVerified, proofStatus, filling/dispensing in-progress).
  // Permanent status comes from the server via API.prescriptions.list().
  // { [scriptKey]: { _transientStatus?, memberVerified?, proofStatus?, proofError?, proofResult?, _claim?, ... } }
  let scriptWorkflow = {};

  // Verified member wallet for the Filled column — keyed by pharmacy NPI
  // Restore verified member wallets from sessionStorage (survives refresh, clears on tab close)
  let verifiedMemberWallets = {};
  try { verifiedMemberWallets = JSON.parse(sessionStorage.getItem('zkt_pharmacy_verified') || '{}'); } catch { verifiedMemberWallets = {}; }
  function getVerifiedMemberWallet() {
    var pharm = getSelectedPharmacy();
    return pharm ? (verifiedMemberWallets[pharm.npi] || null) : null;
  }
  function setVerifiedMemberWallet(walletId) {
    var pharm = getSelectedPharmacy();
    if (pharm) verifiedMemberWallets[pharm.npi] = walletId;
    try { sessionStorage.setItem('zkt_pharmacy_verified', JSON.stringify(verifiedMemberWallets)); } catch {}
  }

  // Messaging state
  let msgActiveThread = null;
  let msgContacts = [];

  // ── Utilities ────────────────────────────────────────────────

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function toast(msg, type) {
    type = type || 'info';
    var container = document.getElementById('toast-container');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(function () { el.remove(); }, 300);
    }, 4000);
  }

  function truncate(s, n) {
    if (!s) return '--';
    s = escapeHtml(String(s));
    return s.length <= n ? s : s.slice(0, n) + '\u2026';
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
    if (s.length === 8) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    if (typeof d === 'number' && d > 1e12) return new Date(d).toLocaleString();
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

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Workflow State (in-memory, no localStorage) ─────────────

  function resetWorkflow() {
    scriptWorkflow = {};
  }

  function scriptKey(claim) {
    // Unique key for a script: leafIndex or hash of fields
    const idx = claim.leafIndex || claim.index;
    if (idx !== undefined && idx !== null) return 'leaf_' + idx;
    return 'h_' + (claim.memberWalletId || '') + '_' + (claim.ndcHash || '') + '_' + (claim.dateOfService || '');
  }

  function getScriptStatus(claim) {
    var key = scriptKey(claim);
    var w = scriptWorkflow[key];
    // Transient states override server state (filling, dispensing in progress)
    if (w && w._transientStatus) return w._transientStatus;
    // Server-side status is the truth
    var s = (claim.status || 'ADJUDICATED').toLowerCase();
    if (s === 'pending') return 'adjudicated'; // proofs generating
    if (s === 'adjudicated') return 'adjudicated';
    if (s === 'filled') return 'filled';
    if (s === 'dispensed') return 'dispensed';
    if (s === 'completed') return 'completed'; // completed = dispensed + paid → history column
    if (s === 'reversed') return 'reversed';
    if (s === 'cancelled') return 'cancelled';
    if (s === 'rejected') return 'rejected';
    if (s === 'transferred') return 'transferred';
    return 'adjudicated'; // default
  }

  function setScriptStatus(claim, status, extra) {
    var key = scriptKey(claim);
    // For transient states (filling, dispensing), store in workflow
    if (status === 'filling' || status === 'dispensing') {
      scriptWorkflow[key] = Object.assign(scriptWorkflow[key] || {}, {
        _transientStatus: status,
        updatedAt: Date.now(),
      }, extra || {});
    } else {
      // For permanent states, update the claim object directly
      // (it will be overwritten on next server poll)
      claim.status = status.toUpperCase();
      // Store extra metadata (issue, transferTo, etc.) in workflow for UI display
      if (extra) {
        scriptWorkflow[key] = Object.assign(scriptWorkflow[key] || {}, extra, { updatedAt: Date.now() });
      }
      // Clear transient status since we've moved to a permanent state
      if (scriptWorkflow[key]) {
        delete scriptWorkflow[key]._transientStatus;
      }
    }
  }

  function getScriptIssue(claim) {
    const key = scriptKey(claim);
    return scriptWorkflow[key]?.issue || null;
  }

  // ── Router ───────────────────────────────────────────────────

  const TABS = ['workstation', 'history', 'dur', 'messaging', 'onboarding', 'proofs'];

  function navigate(tab) {
    if (!TABS.includes(tab)) tab = 'workstation';
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
      case 'workstation': loadWorkstation(); break;
      case 'history': loadHistory(); break;
      case 'dur': break;
      case 'messaging': loadMessaging(); break;
      case 'onboarding': loadOnboarding(); break;
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
      sseEvents.unshift({ time: timeStr(), type: ev.type || 'event', data: ev });
      if (sseEvents.length > MAX_EVENTS) sseEvents.length = MAX_EVENTS;

      // Auto-refresh workstation on new claims
      if (currentTab === 'workstation' && (ev.type || '').includes('proof')) {
        loadWorkstation();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  WORKSTATION — 4-Column Dispensing Workflow
  //  Adjudicated → Filled → Dispensed → History
  // ══════════════════════════════════════════════════════════════

  let allClaims = [];

  async function loadWorkstation() {
    var pharm = getSelectedPharmacy();

    // Show loading indicators in workstation columns
    ['ws-adjudicated-list', 'ws-filled-list', 'ws-dispensed-list', 'ws-history-list'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="ws-empty" style="opacity:0.6">Loading...</div>';
    });

    try {
      const status = await API.onboarding.status();
      onboardingStatus = status;
      const wid = status.walletId || status.wallet || '--';
      setText('#header-wallet', truncate(wid, 16));
    } catch (_) { }

    // FIRST: fetch server-side prescription state (the source of truth)
    // THEN: merge with claim accumulator data for settlement details on completed claims
    var rxPromise = API.prescriptions.list().catch(function () { return []; });
    var claimsPromise = API.dispensing.list().catch(function () { return []; });
    var results = await Promise.all([rxPromise, claimsPromise]);

    // Process prescriptions from server (source of truth for status)
    var rxData = results[0];
    var prescriptions = Array.isArray(rxData) ? rxData : (rxData.prescriptions || rxData.data || []);

    // Process claims from accumulator (settlement data for completed claims)
    var claimsData = results[1];
    var accumulatorClaims = Array.isArray(claimsData) ? claimsData : (claimsData.claims || claimsData.history || []);

    // Build a lookup of accumulator claims by key for merging settlement data
    var accumulatorByKey = {};
    accumulatorClaims.forEach(function (c) {
      accumulatorByKey[scriptKey(c)] = c;
      // Also index by hash key for cross-referencing
      var hashKey = 'h_' + (c.memberWalletId || '') + '_' + (c.ndcHash || '') + '_' + (c.dateOfService || '');
      accumulatorByKey[hashKey] = c;
    });

    // Merge: prescriptions get settlement data from accumulator where available
    prescriptions.forEach(function (rx) {
      var key = scriptKey(rx);
      var hashKey = 'h_' + (rx.memberWalletId || '') + '_' + (rx.ndcHash || '') + '_' + (rx.dateOfService || '');
      var acc = accumulatorByKey[key] || accumulatorByKey[hashKey];
      if (acc) {
        // Merge settlement data from accumulator into prescription
        if (acc.patientPayCents != null && !rx.patientPayCents) rx.patientPayCents = acc.patientPayCents;
        if (acc.planPayCents != null && !rx.planPayCents) rx.planPayCents = acc.planPayCents;
        if (acc.deductibleCreditCents != null) rx.deductibleCreditCents = acc.deductibleCreditCents;
        if (acc.leafIndex != null && rx.leafIndex == null) rx.leafIndex = acc.leafIndex;
        if (acc.ingredientCostCents != null) rx.ingredientCostCents = acc.ingredientCostCents;
        if (acc.dispensingFeeCents != null) rx.dispensingFeeCents = acc.dispensingFeeCents;
        if (acc.metadata) rx.metadata = Object.assign(rx.metadata || {}, acc.metadata);
      }
    });

    // Filter to selected pharmacy (by NPI wallet match) — if no pharmacy field, show all
    allClaims = prescriptions.filter(function (c) {
      var cPharm = c.pharmacyWalletId || c.pharmacy || '';
      if (!cPharm) return true; // no pharmacy tag — show in all
      return cPharm === pharm.npi || cPharm.indexOf(pharm.npi) !== -1;
    });
    // If filter yields nothing, show all (sequencer may not tag by NPI)
    if (allClaims.length === 0 && prescriptions.length > 0) allClaims = prescriptions;

    // FALLBACK: if prescription list is empty but accumulator has claims,
    // use accumulator data filtered to this pharmacy only.
    if (allClaims.length === 0 && accumulatorClaims.length > 0) {
      allClaims = accumulatorClaims.filter(function (c) {
        var cPharm = c.pharmacyWalletId || c.pharmacy || '';
        if (!cPharm) return true; // no pharmacy tag — include (may be pre-tagged data)
        return cPharm === pharm.npi || cPharm.indexOf(pharm.npi) !== -1;
      });
    }

    // Clear transient workflow states when server state catches up —
    // but ONLY if no proof is actively in progress for this claim.
    allClaims.forEach(function (rx) {
      var key = scriptKey(rx);
      var w = scriptWorkflow[key];
      if (w && w._transientStatus) {
        // Don't clear transient status while a proof is still generating
        if (w.proofStatus === 'pending') return;
        var serverStatus = (rx.status || '').toUpperCase();
        // Server has moved past PENDING — clear transient override
        if (serverStatus && serverStatus !== 'PENDING') {
          delete w._transientStatus;
        }
      }
    });

    // Restore payment state from sessionStorage
    var savedPayments = {};
    try { savedPayments = JSON.parse(sessionStorage.getItem('zkt_pharmacy_payments') || '{}'); } catch {}

    // Reconcile server-side terminal states into scriptWorkflow
    // so dispensed/reversed/completed prescriptions render correctly after page refresh
    allClaims.forEach(function (rx) {
      var key = scriptKey(rx);
      var serverStatus = (rx.status || '').toUpperCase();
      if (serverStatus === 'DISPENSED' || serverStatus === 'REVERSED' || serverStatus === 'COMPLETED' ||
          serverStatus === 'PARTIALLY_FILLED') {
        if (!scriptWorkflow[key]) scriptWorkflow[key] = {};
        if (!scriptWorkflow[key].proofStatus) {
          scriptWorkflow[key].proofStatus = rx.proofStatus || 'complete';
        }
        if (rx.prescriptionId && !scriptWorkflow[key].prescriptionId) {
          scriptWorkflow[key].prescriptionId = rx.prescriptionId;
        }
        // Use != null (not !value) so zero amounts are preserved
        if (rx.patientPayCents != null) {
          scriptWorkflow[key].patientPayCents = String(rx.patientPayCents);
        }
        if (rx.planPayCents != null) {
          scriptWorkflow[key].planPayCents = String(rx.planPayCents);
        }
        // Restore payment state from sessionStorage
        if (savedPayments[key]) {
          scriptWorkflow[key].paymentReceived = true;
          scriptWorkflow[key].paymentReceivedAt = savedPayments[key].receivedAt;
        }
      }
    });

    // Only re-render if we have data (don't wipe the UI if fetch returned empty)
    if (allClaims.length > 0 || !window._lastHadClaims) {
      window._lastHadClaims = allClaims.length > 0;
      renderWorkstationColumns();
    }

    // Auto-refresh workstation every 10s (set once, not every call)
    if (!window._overviewTimer) {
      window._overviewTimer = setInterval(loadWorkstation, 10000);
    }
  }

  function renderWorkstationColumns() {
    const adjudicated = [];
    const filled = [];
    const dispensed = [];
    const history = [];
    let completedToday = 0;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    allClaims.forEach(function (claim) {
      const status = getScriptStatus(claim);

      switch (status) {
        case 'adjudicated':
          adjudicated.push(claim);
          break;
        case 'filling':
          adjudicated.push(claim); // stays in adjudicated column, grayed out + pulsing
          break;
        case 'filled':
          filled.push(claim);
          break;
        case 'dispensing':
          filled.push(claim); // stays in filled column with "Proving..." badge
          break;
        case 'dispensed':
          dispensed.push(claim);
          if (scriptWorkflow[scriptKey(claim)]?.updatedAt >= todayStart.getTime()) {
            completedToday++;
          }
          break;
        case 'completed':
        case 'reversed':
        case 'cancelled':
        case 'rejected':
        case 'transferred':
          history.push(claim);
          if (scriptWorkflow[scriptKey(claim)]?.updatedAt >= todayStart.getTime()) {
            completedToday++;
          }
          break;
        default:
          adjudicated.push(claim);
      }
    });

    // Sort: issues pinned to top
    const sortWithIssues = function (a, b) {
      const aIssue = getScriptIssue(a) ? 0 : 1;
      const bIssue = getScriptIssue(b) ? 0 : 1;
      if (aIssue !== bIssue) return aIssue - bIssue;
      // Then by date descending
      const aDate = Number(a.dateOfService || a.date || 0);
      const bDate = Number(b.dateOfService || b.date || 0);
      return bDate - aDate;
    };

    adjudicated.sort(sortWithIssues);
    filled.sort(sortWithIssues);
    dispensed.sort(sortWithIssues);
    history.sort(sortWithIssues);

    // Stats
    setText('#ws-adjudicated-count', String(adjudicated.length));
    setText('#ws-filled-count', String(filled.length));
    setText('#ws-dispensed-count', String(dispensed.length));
    setText('#ws-history-count', String(history.length));
    setText('#ws-completed-count', String(completedToday));
    setText('#ws-adjudicated-badge', String(adjudicated.length));
    setText('#ws-filled-badge', String(filled.length));
    setText('#ws-dispensed-badge', String(dispensed.length));
    setText('#ws-history-badge', String(history.length));

    // Render columns
    renderColumn('#ws-adjudicated-list', adjudicated, 'adjudicated');
    renderColumn('#ws-filled-list', filled, 'filled');
    renderColumn('#ws-dispensed-list', dispensed, 'dispensed');
    renderColumn('#ws-history-list', history, 'history');
  }

  function renderColumn(sel, claims, columnType) {
    const container = typeof sel === 'string' ? $(sel) : sel;
    if (!container) return;

    if (claims.length === 0) {
      const emptyMessages = {
        adjudicated: 'No adjudicated scripts — waiting for eScripts from prescribers',
        filled: 'No scripts awaiting pickup',
        dispensed: 'No dispensed scripts',
        history: 'No completed scripts',
      };
      container.innerHTML = '<div class="ws-empty">' + (emptyMessages[columnType] || 'No scripts') + '</div>';
      return;
    }

    container.innerHTML = claims.map(function (claim) {
      const issue = getScriptIssue(claim);
      const recordingError = scriptWorkflow[scriptKey(claim)]?.recordingError || null;
      const proofStatus = scriptWorkflow[scriptKey(claim)]?.proofStatus || null;
      const currentClaimStatus = getScriptStatus(claim);
      const isFilling = currentClaimStatus === 'filling';
      const isDispensing = currentClaimStatus === 'dispensing';
      const isEscript = !!claim._isEscript;
      const medLabel = claim.brandName ? claim.brandName : (claim.ndcHash || claim.medication || '');
      const med = truncate(medLabel, 20);
      const patient = truncate(claim.memberWalletId || claim.patient || claim.patientWalletId, 14);
      const prescriber = truncate(claim.prescriberWalletId || claim.prescriber, 14);
      const date = formatDate(claim.dateOfService || claim.date);
      // Use workflow data first (from proof result), then server data. Use != null to preserve $0.00 amounts.
      var wf = scriptWorkflow[scriptKey(claim)] || {};
      const patientPayVal = wf.patientPayCents != null ? wf.patientPayCents : (claim.patientPayCents != null ? claim.patientPayCents : claim.patientPay);
      const patientPay = isEscript ? 'Pending' : formatCents(patientPayVal);
      const planPayVal = wf.planPayCents != null ? wf.planPayCents : (claim.planPayCents != null ? claim.planPayCents : claim.planPay);
      const planPay = isEscript ? '' : formatCents(planPayVal);
      const key = scriptKey(claim);

      let actionsHtml = '';
      if (columnType === 'adjudicated') {
        actionsHtml =
          '<button class="btn btn-sm btn-primary" onclick="App.fillScript(\'' + escapeHtml(key) + '\')">Fill</button>' +
          '<button class="btn btn-sm btn-danger" onclick="App.rejectScript(\'' + escapeHtml(key) + '\')">Reject</button>' +
          '<button class="btn btn-sm" onclick="App.transferScript(\'' + escapeHtml(key) + '\')">Transfer</button>';
      } else if (columnType === 'filled') {
        var memberVerified = isScriptVerified(claim);
        actionsHtml =
          (memberVerified
            ? '<span class="btn btn-sm" style="background:#10b981;color:#fff;cursor:default;font-size:10px">Verified</span>'
            : '<button class="btn btn-sm" onclick="App.verifyMemberForScript(\'' + escapeHtml(key) + '\')">Verify Member</button>') +
          '<button class="btn btn-sm btn-primary" onclick="App.dispenseScript(\'' + escapeHtml(key) + '\')"' +
            (memberVerified ? '' : ' disabled title="Verify member first"') + '>Dispense</button>';
      } else if (columnType === 'dispensed') {
        var paymentReceived = scriptWorkflow[key]?.paymentReceived;
        actionsHtml =
          (!paymentReceived
            ? '<button class="btn btn-sm btn-primary" onclick="App.confirmPayment(\'' + escapeHtml(key) + '\')">Payment Received</button>'
            : '<span class="btn btn-sm" style="background:#10b981;color:#fff;cursor:default;font-size:10px">Paid</span>') +
          '<button class="btn btn-sm btn-reverse" onclick="App.reverseScript(\'' + escapeHtml(key) + '\')">Reverse</button>';
      }
      // history column: no action buttons

      return '<div class="script-card' + (issue ? ' has-issue' : '') + (isEscript ? ' is-escript' : '') + (isDispensing || isFilling ? ' is-dispensing' : '') + '" data-key="' + escapeHtml(key) + '" onclick="App.showScriptDetail(\'' + escapeHtml(key) + '\')">' +
        '<div class="script-card-top">' +
          '<span class="script-med">' + escapeHtml(med) + '</span>' +
          (isFilling ? '<span class="script-issue-badge" style="background:#6b7280;color:#fff;animation:pulse 2s infinite">Filling...</span>' : '') +
          (isDispensing ? '<span class="script-issue-badge" style="background:#6b7280;color:#fff;animation:pulse 2s infinite">Dispensing...</span>' : '') +
          (isEscript ? '<span class="script-issue-badge" style="background:#0ea5e9;color:#fff">eRx</span>' : '') +
          (issue ? '<span class="script-issue-badge">' + escapeHtml(issue) + '</span>' : '') +
          (recordingError ? '<span class="script-issue-badge" style="background:#dc2626;color:#fff" title="' + escapeHtml(recordingError) + '">Not Recorded</span>' : '') +
          (proofStatus === 'pending' ? '<span class="script-issue-badge" style="background:#f59e0b;color:#fff;animation:pulse 2s infinite">Proving...</span>' : '') +
          (proofStatus === 'complete' ? '<span class="script-issue-badge" style="background:#10b981;color:#fff">ZK Proved</span>' : '') +
          (proofStatus === 'error' ? '<span class="script-issue-badge" style="background:#dc2626;color:#fff" title="' + escapeHtml(scriptWorkflow[scriptKey(claim)]?.proofError || 'Unknown') + '">Proof Failed</span>' : '') +
          (proofStatus === 'timeout' ? '<span class="script-issue-badge" style="background:#6b7280;color:#fff">Proof Timeout</span>' : '') +
          (columnType === 'filled' && isScriptVerified(claim) ? '<span class="script-issue-badge" style="background:#10b981;color:#fff">Member Verified</span>' : '') +
          (columnType === 'dispensed' ? '<span class="script-issue-badge" style="background:#10b981;color:#fff">Settlement Complete</span>' : '') +
          (columnType === 'history' && currentClaimStatus === 'reversed' ? '<span class="script-issue-badge" style="background:#dc2626;color:#fff">Reversed</span>' : '') +
          (columnType === 'history' && currentClaimStatus === 'rejected' ? '<span class="script-issue-badge" style="background:#dc2626;color:#fff">Rejected</span>' : '') +
          (columnType === 'history' && currentClaimStatus === 'transferred' ? '<span class="script-issue-badge" style="background:#6b7280;color:#fff">Transferred</span>' : '') +
          (columnType === 'history' && currentClaimStatus === 'cancelled' ? '<span class="script-issue-badge" style="background:#6b7280;color:#fff">Cancelled</span>' : '') +
        '</div>' +
        '<div class="script-card-meta">' +
          '<span class="script-patient" title="Patient">' + escapeHtml(patient) + '</span>' +
          '<span title="Prescriber">' + escapeHtml(prescriber) + '</span>' +
          '<span>' + escapeHtml(date) + '</span>' +
        '</div>' +
        '<div class="script-card-bottom">' +
          '<div class="script-pricing">' +
            '<span class="script-price-tag patient-pay" title="Member Copay">' + escapeHtml(patientPay) + '</span>' +
            '<span class="script-price-tag plan-pay" title="Plan Pays">' + escapeHtml(planPay) + '</span>' +
            (claim.ingredientCostCents || (claim.metadata && claim.metadata.ingredientCostCents)
              ? '<span class="script-price-tag drug-cost" title="NADAC + Dispensing Fee">' + formatCents(Number(claim.ingredientCostCents || claim.metadata.ingredientCostCents) + Number(claim.dispensingFeeCents || (claim.metadata && claim.metadata.dispensingFeeCents) || 0)) + '</span>'
              : '') +
          '</div>' +
          '<div class="script-actions" onclick="event.stopPropagation();">' + actionsHtml + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── Workstation Actions ──────────────────────────────────────

  function findClaimByKey(key) {
    var found = allClaims.find(function (c) { return scriptKey(c) === key; });
    // Fallback: if allClaims was refreshed and lost the reference, check workflow backup
    if (!found && scriptWorkflow[key] && scriptWorkflow[key]._claim) {
      found = scriptWorkflow[key]._claim;
      // Re-add to allClaims so it appears in the columns
      if (allClaims.indexOf(found) === -1) allClaims.push(found);
    }
    return found;
  }

  // Cached formulary entries for copay lookups during dispensing
  let cachedFormularyEntries = null;

  async function loadFormularyCache() {
    if (cachedFormularyEntries) return cachedFormularyEntries;
    try {
      var data = await API.formulary.get('default');
      if (data && data.entriesJson) {
        cachedFormularyEntries = JSON.parse(data.entriesJson);
      }
    } catch (_) { /* formulary unavailable */ }
    return cachedFormularyEntries || [];
  }

  function lookupCopay(entries, ndcHash) {
    if (!entries || !ndcHash) return { patientPayCents: 0, planPayCents: 0 };
    var entry = entries.find(function (e) { return e.ndcHash === ndcHash; });
    if (!entry) return { patientPayCents: 0, planPayCents: 0 };
    // Use formulary copay as patient pay; estimate plan pay from tier
    var copay = Number(entry.copay) || 0;
    var tierMultiplier = [0, 80, 60, 40, 20]; // T1=80% plan, T2=60%, T3=40%, T4=20%
    var tier = Number(entry.tierLevel) || 1;
    var planPercent = tierMultiplier[tier] || 60;
    var planPay = Math.round(copay * planPercent / (100 - planPercent || 1));
    return { patientPayCents: copay, planPayCents: planPay };
  }

  async function dispenseScript(key) {
    const claim = findClaimByKey(key);
    if (!claim) return;
    // Guard: only dispense from FILLED status
    var currentStatus = getScriptStatus(claim);
    if (currentStatus === 'dispensed' || currentStatus === 'completed') {
      // Already dispensed (e.g., by bootstrap auto-fill) — just refresh and show
      toast('Already dispensed — refreshing view', 'info');
      loadWorkstation();
      return;
    }
    if (currentStatus !== 'filled') return;
    // Guard: must be member-verified before dispensing
    if (!isScriptVerified(claim)) {
      toast('Verify member first (NFC/attestation) before dispensing', 'error');
      return;
    }

    // Set to dispensing — card stays in filled column with "Dispensing..." badge
    setScriptStatus(claim, 'dispensing');
    if (!scriptWorkflow[key]) scriptWorkflow[key] = {};
    scriptWorkflow[key].proofStatus = 'pending';
    scriptWorkflow[key].proofError = null;
    scriptWorkflow[key].proofResult = null;
    scriptWorkflow[key]._claim = claim; // preserve claim ref in case allClaims refreshes
    renderWorkstationColumns();

    // NADAC transparent pricing — pharmacy reports actual cost breakdown
    var ingredientCostCents = Number(claim.ingredientCostCents || claim.ingredientCost || 0);
    var dispensingFeeCents = Number(claim.dispensingFeeCents || claim.dispensingFee || 1300);
    var quantityDispensed = Number(claim.quantityDispensed || claim.quantity || 30);

    // Fire async ZK proof pipeline via pharmacy route → sequencer interactive service
    // Uses prescriptionId from the existing eScript (prescriber already adjudicated)
    var prescriptionId = claim.rxId || claim.prescriptionId || claim.id;
    if (!prescriptionId) {
      toast('Cannot dispense: no prescription ID on this script', 'error');
      setScriptStatus(claim, 'filled');
      renderWorkstationColumns();
      return;
    }
    API.dispensing.dispense({
      prescriptionId: prescriptionId,
      quantityDispensed: quantityDispensed,
      ingredientCostCents: ingredientCostCents,
      dispensingFeeCents: dispensingFeeCents,
    }).then(function (result) {
      var jobKey = result.jobKey;
      if (!jobKey) {
        scriptWorkflow[key].proofStatus = 'error';
        scriptWorkflow[key].proofError = 'No job key returned';
        setScriptStatus(claim, 'filled'); // back to filled on error
        renderWorkstationColumns();
        return;
      }
      scriptWorkflow[key].fillJobKey = jobKey;
      pollDispenseStatus(jobKey, key);
    }).catch(function (err) {
      console.warn('[Dispense] Proof pipeline failed:', err);
      scriptWorkflow[key].proofStatus = 'error';
      scriptWorkflow[key].proofError = err.message || 'Proof generation failed';
      setScriptStatus(claim, 'filled'); // back to filled on error
      renderWorkstationColumns();
    });
  }

  function pollDispenseStatus(jobKey, key, attempts) {
    attempts = attempts || 0;
    if (attempts >= 120) { // 120 × 5s = 10 min timeout
      if (scriptWorkflow[key]) {
        scriptWorkflow[key].proofStatus = 'timeout';
        scriptWorkflow[key].proofError = 'Proof generation timed out';
      }
      setScriptStatus(findClaimByKey(key), 'filled'); // back to filled on timeout
      renderWorkstationColumns();
      return;
    }

    setTimeout(function () {
      API.dispensing.fillStatus(jobKey).then(function (resp) {
        if (resp.status === 'complete') {
          var r = resp.result || resp;
          // Normalize: unwrap nested result.result from sequencer proxy layer
          var inner = r.result || r;
          // Extract prescriptionId from any level for reversal
          var rxId = inner.prescriptionId || r.prescriptionId || '';
          // Extract adjudication data from any level
          var adj = inner.adjudication || r.adjudication || inner;

          if (scriptWorkflow[key]) {
            scriptWorkflow[key].proofStatus = 'complete';
            scriptWorkflow[key].proofResult = resp.result;
            if (rxId) scriptWorkflow[key].prescriptionId = rxId;
            // Store adjudication in workflow (not on mutable claim object)
            if (adj.patientPayCents != null) scriptWorkflow[key].patientPayCents = String(adj.patientPayCents);
            if (adj.planPayCents != null) scriptWorkflow[key].planPayCents = String(adj.planPayCents);
            if (adj.phase) scriptWorkflow[key].adjudicationPhase = adj.phase;
          }
          var claim = findClaimByKey(key);
          if (claim) {
            claim._isEscript = false;
            setScriptStatus(claim, 'dispensed'); // terminal — settlement complete
          }
          renderWorkstationColumns();
          toast('Dispensed — ZK settlement proof submitted', 'success');
        } else if (resp.status === 'error') {
          if (scriptWorkflow[key]) {
            scriptWorkflow[key].proofStatus = 'error';
            scriptWorkflow[key].proofError = resp.error || 'Proof failed';
          }
          setScriptStatus(findClaimByKey(key), 'filled'); // back to filled on error
          renderWorkstationColumns();
        } else if (resp.status === 'not_started') {
          // Job was already processed and cleaned up by the sequencer.
          // Refresh from server to get the current prescription status.
          if (scriptWorkflow[key]) {
            scriptWorkflow[key].proofStatus = 'complete';
          }
          loadWorkstation();
          toast('Dispense completed (confirmed by sequencer)', 'success');
        } else {
          // Still pending — update elapsed time and poll again
          renderWorkstationColumns();
          pollDispenseStatus(jobKey, key, attempts + 1);
        }
      }).catch(function () {
        // Network error — retry
        pollDispenseStatus(jobKey, key, attempts + 1);
      });
    }, 5000);
  }

  function rejectScript(key) {
    const claim = findClaimByKey(key);
    if (!claim) return;
    const reason = prompt('Rejection reason (optional):');
    setScriptStatus(claim, 'rejected', { issue: reason || 'Rejected' });
    renderWorkstationColumns();
    API.dispensing.summary().catch(function () { /* best effort refresh */ });
  }

  function transferScript(key) {
    const claim = findClaimByKey(key);
    if (!claim) return;
    const pharmacyId = prompt('Transfer to pharmacy wallet ID:');
    if (!pharmacyId) return;
    setScriptStatus(claim, 'transferred', { transferTo: pharmacyId });

    // Attempt API call (best effort)
    var myWallet = onboardingStatus?.walletId || onboardingStatus?.wallet || '';
    API.messaging.send({
      message: { messageCommitment: '0', senderWalletId: myWallet, recipientWalletId: pharmacyId, messageType: '4', threadIdHash: '0' },
      payload: { ciphertext: btoa('SCRIPT_TRANSFER:' + (claim.ndcHash || '') + ':' + (claim.memberWalletId || '') + ':' + (claim.leafIndex || '')), iv: '0', tag: '0', timestamp: Date.now() },
    }).catch(function () { /* best effort */ });

    renderWorkstationColumns();
  }

  async function fillScript(key) {
    const claim = findClaimByKey(key);
    if (!claim) return;
    // Guard: only fill from adjudicated status
    var currentStatus = getScriptStatus(claim);
    if (currentStatus !== 'adjudicated') return;

    // Mark as filling (visual feedback) — no ZK proofs, just a status update
    setScriptStatus(claim, 'filling');
    renderWorkstationColumns();

    try {
      await API.dispensing.markFilled({
        prescriptionId: claim.rxId || claim.prescriptionId || claim.id || '',
        memberWalletId: claim.memberWalletId || claim.patient || claim.patientWalletId || '',
        ndcHash: claim.ndcHash || '',
      });
    } catch (err) {
      console.warn('[Fill] mark-filled API call failed (continuing locally):', err.message);
    }

    // Transition to Filled column
    setScriptStatus(claim, 'filled');
    renderWorkstationColumns();
    toast('Script filled — awaiting member pickup', 'info');
  }

  function verifyMemberForScript(key) {
    // Open the NFC/attestation verify flow — requires actual attestation, NOT just wallet ID.
    // The pharmacist must scan the member's NFC tag or paste a signed attestation credential.
    const claim = findClaimByKey(key);
    if (!claim) return;
    var memberId = claim.memberWalletId || claim.patient || claim.patientWalletId || '';

    // Pre-fill the wallet ID for reference but do NOT auto-verify.
    // The pharmacist must provide an attestation (NFC tap or pasted credential).
    if (memberId) {
      $('#ws-verify-wallet').value = '';
      $('#ws-verify-wallet').placeholder = 'Scan NFC tag or paste attestation for ' + truncate(memberId, 20);
    }
    toast('Scan member NFC tag or paste attestation credential to verify', 'info');
    // Focus the verify input for manual paste
    $('#ws-verify-wallet').focus();
  }

  function confirmPayment(key) {
    var claim = findClaimByKey(key);
    if (!claim) return;
    if (!scriptWorkflow[key]) scriptWorkflow[key] = {};
    scriptWorkflow[key].paymentReceived = true;
    scriptWorkflow[key].paymentReceivedAt = Date.now();

    // Update claim display values from proof result or server data
    var w = scriptWorkflow[key];
    if (w.proofResult) {
      var adj = w.proofResult.adjudication || w.proofResult;
      if (adj.patientPayCents != null) claim.patientPayCents = String(adj.patientPayCents);
      if (adj.planPayCents != null) claim.planPayCents = String(adj.planPayCents);
      if (adj.phase) claim.adjudicationPhase = adj.phase;
    }

    // Persist paymentReceived in sessionStorage so it survives refresh
    try {
      var payments = JSON.parse(sessionStorage.getItem('zkt_pharmacy_payments') || '{}');
      payments[key] = { receivedAt: Date.now() };
      sessionStorage.setItem('zkt_pharmacy_payments', JSON.stringify(payments));
    } catch {}

    // Stay in dispensed column with "Paid" badge — don't move to history
    // (History is for reversals/cancellations, not completed payments)
    renderWorkstationColumns();
    toast('Payment confirmed — claim lifecycle complete', 'success');
  }

  function reverseScript(key) {
    const claim = findClaimByKey(key);
    if (!claim) return;
    const reason = prompt('Reversal reason:');
    if (reason === null) return; // cancelled

    // Need a prescriptionId from the fill proof result or the original claim
    var prescriptionId = scriptWorkflow[key]?.prescriptionId
      || claim.rxId || claim.prescriptionId || claim.id;
    if (!prescriptionId) {
      toast('Cannot reverse: no prescription ID available', 'error');
      return;
    }

    setScriptStatus(claim, 'reversed', { issue: reason || 'Reversing — ZK proof generating...' });
    if (scriptWorkflow[key]) {
      scriptWorkflow[key].reversalStatus = 'pending';
    }
    renderWorkstationColumns();

    // Fire async ZK reversal proof via pharmacy route → sequencer
    API.dispensing.reverse({
      prescriptionId: prescriptionId,
      reason: reason || 'Pharmacy reversal',
    }).then(function (result) {
      var jobKey = result.jobKey;
      if (!jobKey) {
        if (scriptWorkflow[key]) scriptWorkflow[key].reversalStatus = 'error';
        renderWorkstationColumns();
        return;
      }
      pollReversalStatus(jobKey, key);
    }).catch(function (err) {
      console.warn('[Reverse] Reversal proof failed:', err);
      if (scriptWorkflow[key]) {
        scriptWorkflow[key].reversalStatus = 'error';
        scriptWorkflow[key].reversalError = err.message || 'Reversal failed';
      }
      renderWorkstationColumns();
    });
  }

  function pollReversalStatus(jobKey, key, attempts) {
    attempts = attempts || 0;
    if (attempts >= 120) {
      if (scriptWorkflow[key]) scriptWorkflow[key].reversalStatus = 'timeout';
      renderWorkstationColumns();
      return;
    }

    setTimeout(function () {
      API.dispensing.reverseStatus(jobKey).then(function (resp) {
        if (resp.status === 'complete') {
          if (scriptWorkflow[key]) scriptWorkflow[key].reversalStatus = 'complete';
          setScriptStatus(findClaimByKey(key), 'reversed', { issue: 'Reversed — ZK proof verified' });
          renderWorkstationColumns();
          toast('Reversal ZK proof verified', 'success');
        } else if (resp.status === 'error') {
          if (scriptWorkflow[key]) {
            scriptWorkflow[key].reversalStatus = 'error';
            scriptWorkflow[key].reversalError = resp.error || 'Reversal proof failed';
          }
          renderWorkstationColumns();
        } else {
          pollReversalStatus(jobKey, key, attempts + 1);
        }
      }).catch(function () {
        pollReversalStatus(jobKey, key, attempts + 1);
      });
    }, 5000);
  }

  // Mark filled scripts as verified for a member (member NFC/attestation scan)
  function verifyScriptsForMember(memberWalletId) {
    let verified = 0;
    allClaims.forEach(function (claim) {
      const cMember = claim.memberWalletId || claim.patient || claim.patientWalletId || '';
      if (cMember === memberWalletId && getScriptStatus(claim) === 'filled') {
        var k = scriptKey(claim);
        if (!scriptWorkflow[k]) scriptWorkflow[k] = {};
        scriptWorkflow[k].memberVerified = true;
        verified++;
      }
    });
    return verified;
  }

  function isScriptVerified(claim) {
    var k = scriptKey(claim);
    if (scriptWorkflow[k] && scriptWorkflow[k].memberVerified) return true;
    // Also check global verified wallet (single source of truth)
    var currentVerified = getVerifiedMemberWallet();
    var memberWid = claim.memberWalletId || claim.patient || claim.patientWalletId || '';
    return !!(currentVerified && memberWid && currentVerified === memberWid);
  }

  // NFC Scan / Verify Member
  async function verifyMember(walletId) {
    const statusEl = $('#ws-verify-status');
    if (!walletId) {
      walletId = $('#ws-verify-wallet').value.trim();
    }
    if (!walletId) return;

    statusEl.classList.remove('hidden', 'verified', 'error');
    statusEl.textContent = 'Verifying...';

    try {
      // Try to parse as JSON attestation (credential-attestation or wrapper)
      var scanParams = {};
      try {
        var parsed = JSON.parse(walletId);
        if (parsed.type === 'credential-attestation' && parsed.attestation) {
          // Full wrapper: { type, version, walletId, attestation }
          scanParams = { attestation: parsed.attestation };
        } else if (parsed.v === 2 && parsed.t === 'credential-attestation' && parsed.sig) {
          // Raw attestation object
          scanParams = { attestation: parsed };
        } else if (parsed.w) {
          // Some NFC payload with a wallet field
          scanParams = { payloadObject: parsed };
        } else {
          scanParams = { walletId: walletId };
        }
      } catch (_) {
        // Not JSON — require attestation, raw wallet IDs are NOT sufficient for verification.
        // The member must present a signed attestation credential (NFC or pasted).
        throw new Error('Invalid credential — paste a signed attestation JSON or scan an NFC tag. Raw wallet IDs are not accepted.');
      }

      const result = await API.nfc.scan(scanParams);
      if (!result.attestationVerified) {
        throw new Error('Attestation signature NOT verified — member identity not confirmed');
      }
      if (result.attestationExpired) {
        throw new Error('Attestation EXPIRED — member must obtain a fresh credential');
      }
      setVerifiedMemberWallet(result.walletId || walletId);

      // Mark their filled scripts as member-verified (Dispense now enabled)
      const verified = verifyScriptsForMember(getVerifiedMemberWallet());

      // Build verification status text
      var statusText = 'Verified: ' + truncate(getVerifiedMemberWallet(), 20);
      if (result.attestationVerified) {
        statusText += ' [Attestation: Ed25519 signature valid';
        if (result.attestationExpired) statusText += ', EXPIRED';
        statusText += ']';
      }
      if (verified > 0) statusText += ' — ' + verified + ' script(s) ready for dispensing';
      else statusText += ' — no filled scripts awaiting pickup';

      statusEl.classList.add('verified');
      statusEl.textContent = statusText;

      renderWorkstationColumns();
    } catch (err) {
      statusEl.classList.add('error');
      statusEl.textContent = 'Verification failed: ' + (err.message || String(err));
    }
  }

  async function nfcScanHardware() {
    // If the textarea already has content, treat it as a pasted credential/walletId
    const pastedContent = $('#ws-verify-wallet').value.trim();
    if (pastedContent) {
      return verifyMember(pastedContent);
    }

    const statusEl = $('#ws-verify-status');
    statusEl.classList.remove('hidden', 'verified', 'error');
    statusEl.textContent = 'Scanning NFC tag...';

    try {
      const result = await API.nfc.scan({});
      if (result.walletId) {
        $('#ws-verify-wallet').value = result.walletId;
        await verifyMember(result.walletId);
      } else {
        statusEl.classList.add('error');
        statusEl.textContent = 'No wallet ID found on tag';
      }
    } catch (err) {
      statusEl.classList.add('error');
      statusEl.textContent = 'NFC scan failed: ' + (err.message || String(err));
    }
  }

  // Script Detail Modal
  function showScriptDetail(key) {
    const claim = findClaimByKey(key);
    if (!claim) return;

    const status = getScriptStatus(claim);
    const issue = getScriptIssue(claim);
    const w = scriptWorkflow[key] || {};

    // Resolve pricing metadata from leaf or claim-level data
    var meta = claim.metadata || {};
    var ingredientCost = meta.ingredientCostCents || claim.ingredientCostCents || claim.ingredientCost;
    var dispensingFee = meta.dispensingFeeCents || claim.dispensingFeeCents || claim.dispensingFee;
    var totalDrugCost = meta.totalDrugCostCents || claim.totalDrugCostCents;
    if (!totalDrugCost && ingredientCost != null && dispensingFee != null) {
      totalDrugCost = Number(ingredientCost) + Number(dispensingFee);
    }
    var qty = meta.quantityDispensed || claim.quantityDispensed || claim.quantity;

    const fields = [
      ['Leaf Index', claim.leafIndex || claim.index],
      ['Member Wallet', claim.memberWalletId || claim.patient || claim.patientWalletId],
      ['Medication (NDC Hash)', claim.ndcHash || claim.medication],
      ['Brand Name', meta.brandName || claim.brandName],
      ['Prescriber Wallet', claim.prescriberWalletId || claim.prescriber],
      ['Pharmacy Wallet', claim.pharmacyWalletId || claim.pharmacy],
      ['Date of Service', formatDate(claim.dateOfService || claim.date)],
      ['Qty Dispensed', qty || '--'],
      ['Days Supply', meta.daysSupply || claim.daysSupply || '--'],
    ];

    // NADAC transparent pricing breakdown
    if (ingredientCost != null || dispensingFee != null) {
      fields.push(['--- COST BREAKDOWN ---', '']);
      fields.push(['NADAC Ingredient Cost', formatCents(ingredientCost)]);
      fields.push(['Dispensing Fee', formatCents(dispensingFee)]);
      fields.push(['Total Drug Cost', formatCents(totalDrugCost)]);
    }

    fields.push(['--- SETTLEMENT ---', '']);
    fields.push(['Patient Copay', formatCents(claim.patientPayCents || claim.patientPay)]);
    fields.push(['Plan Pays', formatCents(claim.planPayCents || claim.planPay)]);
    fields.push(['Deductible Credit', formatCents(claim.deductibleCreditCents || claim.deductibleCredit)]);
    fields.push(['Workflow Status', status.toUpperCase()]);
    fields.push(['Member Verified', isScriptVerified(claim) ? 'YES' : 'NO']);

    if (issue) fields.push(['Issue', issue]);
    if (w.transferTo) fields.push(['Transferred To', w.transferTo]);
    if (w.updatedAt) fields.push(['Last Updated', new Date(w.updatedAt).toLocaleString()]);

    // ZK Proof status
    if (w.proofStatus) {
      fields.push(['--- ZK PROOF ---', '']);
      if (w.proofStatus === 'pending') {
        fields.push(['Proof Status', 'GENERATING (AccumulatorFulfillmentProgram)...']);
      } else if (w.proofStatus === 'complete') {
        fields.push(['Proof Status', 'VERIFIED']);
        if (w.proofResult) {
          var adj = w.proofResult.adjudication || {};
          var acc = w.proofResult.accumulator || {};
          var timings = w.proofResult.proofTimesMs || {};
          fields.push(['Adjudication Phase', adj.phase || '--']);
          fields.push(['ZK Patient Pay', formatCents(adj.patientPayCents)]);
          fields.push(['ZK Plan Pay', formatCents(adj.planPayCents)]);
          if (adj.familyPoolingApplied) {
            fields.push(['Family Pooling', adj.familyPoolingReason || 'Applied']);
          }
          if (acc.after) {
            fields.push(['Deductible After', formatCents(acc.after.deductiblePaidCents) + ' / ' + formatCents((acc.limits || {}).deductibleAmountCents)]);
            fields.push(['OOP After', formatCents(acc.after.oopPaidCents) + ' / ' + formatCents((acc.limits || {}).oopMaxCents)]);
          }
          if (timings.total) {
            fields.push(['Proof Time', (timings.total / 1000).toFixed(1) + 's (' +
              'Gate:' + (timings.proofGate / 1000).toFixed(1) + 's + ' +
              'Rx:' + (timings.prescriptionStatus / 1000).toFixed(1) + 's + ' +
              'Claim:' + (timings.accumulatorFulfillment / 1000).toFixed(1) + 's)']);
          }
        }
      } else if (w.proofStatus === 'error') {
        fields.push(['Proof Status', 'FAILED: ' + (w.proofError || 'Unknown error')]);
      } else if (w.proofStatus === 'timeout') {
        fields.push(['Proof Status', 'TIMEOUT']);
      }
    }

    let html = fields.map(function (f) {
      return '<div class="modal-row">' +
        '<span class="modal-row-label">' + escapeHtml(f[0]) + '</span>' +
        '<span class="modal-row-value">' + escapeHtml(formatField(f[1])) + '</span>' +
        '</div>';
    }).join('');

    // Actions
    html += '<div class="modal-actions">';
    if (status === 'adjudicated') {
      html += '<button class="btn btn-primary" onclick="App.fillScript(\'' + escapeHtml(key) + '\'); App.closeModal();">Fill</button>';
      html += '<button class="btn btn-danger" onclick="App.rejectScript(\'' + escapeHtml(key) + '\'); App.closeModal();">Reject</button>';
      html += '<button class="btn" onclick="App.transferScript(\'' + escapeHtml(key) + '\'); App.closeModal();">Transfer</button>';
    }
    if (status === 'filled') {
      var isVerified = isScriptVerified(claim);
      if (isVerified) {
        html += '<button class="btn btn-primary" onclick="App.dispenseScript(\'' + escapeHtml(key) + '\'); App.closeModal();">Dispense (Collect Payment + Settle)</button>';
      } else {
        html += '<div style="color:var(--text-muted);font-size:12px;margin:8px 0">Verify member (NFC/attestation) to enable dispensing</div>';
        html += '<button class="btn" onclick="App.verifyMemberForScript(\'' + escapeHtml(key) + '\'); App.closeModal();">Verify Member</button>';
      }
    }
    if (status === 'dispensed') {
      html += '<button class="btn btn-reverse" onclick="App.reverseScript(\'' + escapeHtml(key) + '\'); App.closeModal();">Reverse</button>';
    }
    if (status === 'adjudicated' || status === 'filled') {
      html += '<button class="btn" onclick="App.flagIssue(\'' + escapeHtml(key) + '\')">Flag Issue</button>';
    }
    html += '<button class="btn" onclick="App.durLookupFromScript(\'' + escapeHtml(key) + '\')">DUR Lookup</button>';
    html += '</div>';

    setHTML('#ws-modal-body', html);
    showEl('#ws-modal-overlay');
  }

  function closeModal() {
    hideEl('#ws-modal-overlay');
  }

  function flagIssue(key) {
    const reason = prompt('Issue description:');
    if (!reason) return;
    const claim = findClaimByKey(key);
    if (!claim) return;
    const w = scriptWorkflow[scriptKey(claim)] || { status: getScriptStatus(claim) };
    w.issue = reason;
    w.updatedAt = Date.now();
    scriptWorkflow[scriptKey(claim)] = w;
    // workflow state kept in-memory only
    renderWorkstationColumns();
    closeModal();
  }

  function durLookupFromScript(key) {
    const claim = findClaimByKey(key);
    if (!claim) return;
    const memberId = claim.memberWalletId || claim.patient || claim.patientWalletId || '';
    if (!memberId) return;
    closeModal();
    navigate('dur');
    $('#dur-wallet-input').value = memberId;
    durLookup(memberId);
  }

  // ══════════════════════════════════════════════════════════════
  //  HISTORY TAB
  // ══════════════════════════════════════════════════════════════

  async function loadHistory(params) {
    // Stats
    try {
      const summary = await API.dispensing.summary();
      setText('#hist-total', formatField(summary.totalClaims || summary.total || 0));
      setText('#hist-patients', formatField(summary.uniquePatients || summary.patients || 0));
      if (summary.totalPatientPayCents !== undefined || summary.totalPatientPay !== undefined) {
        setText('#hist-patient-pay', formatCents(summary.totalPatientPayCents || summary.totalPatientPay));
      }
      if (summary.totalPlanPayCents !== undefined || summary.totalPlanPay !== undefined) {
        setText('#hist-plan-pay', formatCents(summary.totalPlanPayCents || summary.totalPlanPay));
      }
    } catch (_) { }

    await loadHistoryTable(params);
  }

  async function loadHistoryTable(params) {
    const tbody = $('#hist-table-body');
    tbody.innerHTML = '<tr><td colspan="8" class="loading">Loading...</td></tr>';

    try {
      let claims;
      if (params) {
        if (params.patient) {
          claims = await API.dispensing.byPatient(params.patient);
        } else if (params.start && params.end) {
          claims = await API.dispensing.range(params.start, params.end);
        } else {
          claims = await API.dispensing.list();
        }
      } else {
        claims = await API.dispensing.list();
      }

      const arr = Array.isArray(claims) ? claims : (claims.claims || claims.history || []);

      // Filter by status if set
      const statusFilter = params?.statusFilter;
      const filtered = statusFilter ? arr.filter(function (c) { return getScriptStatus(c) === statusFilter; }) : arr;

      setText('#hist-count', filtered.length + ' scripts');

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="muted">No scripts found</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(function (c) {
        const status = getScriptStatus(c);
        const statusClass = 'status-' + status;
        return '<tr>' +
          '<td class="mono muted">' + formatField(c.leafIndex || c.index) + '</td>' +
          '<td class="mono truncate">' + truncate(c.memberWalletId || c.patient || c.patientWalletId, 16) + '</td>' +
          '<td class="mono truncate">' + truncate(c.ndcHash || c.medication, 16) + '</td>' +
          '<td class="mono truncate">' + truncate(c.prescriberWalletId || c.prescriber, 16) + '</td>' +
          '<td class="muted">' + formatDate(c.dateOfService || c.date) + '</td>' +
          '<td class="text-yellow">' + formatCents(c.patientPayCents || c.patientPay) + '</td>' +
          '<td class="text-blue">' + formatCents(c.planPayCents || c.planPay) + '</td>' +
          '<td><span class="script-status-badge ' + statusClass + '">' + escapeHtml(status) + '</span></td>' +
          '</tr>';
      }).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-red">Error: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function applyHistoryFilter() {
    const patient = $('#hist-filter-patient').value.trim();
    const start = $('#hist-filter-start').value.replace(/-/g, '');
    const end = $('#hist-filter-end').value.replace(/-/g, '');
    const statusFilter = $('#hist-filter-status').value;

    const params = {};
    if (patient) params.patient = patient;
    if (start && end) { params.start = start; params.end = end; }
    if (statusFilter) params.statusFilter = statusFilter;

    loadHistoryTable(Object.keys(params).length > 0 ? params : null);
  }

  function clearHistoryFilter() {
    $('#hist-filter-patient').value = '';
    $('#hist-filter-start').value = '';
    $('#hist-filter-end').value = '';
    $('#hist-filter-status').value = '';
    loadHistoryTable();
  }

  // ══════════════════════════════════════════════════════════════
  //  DUR (Drug Utilization Review)
  // ══════════════════════════════════════════════════════════════

  async function durLookup(walletId) {
    if (!walletId) return;
    durCurrentWallet = walletId;
    durLookupCount++;

    showEl('#dur-results-area');
    hideEl('#dur-claim-detail');
    setHTML('#dur-alerts', '');
    setHTML('#dur-active-meds', '<li class="loading">Loading active medications...</li>');
    setHTML('#dur-history-table', '<tr><td colspan="6" class="loading">Loading cross-pharmacy history...</td></tr>');

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
      setHTML('#dur-active-meds', '<li class="dur-alert dur-alert-warn">Unable to load: ' + escapeHtml(err.message) + '</li>');
    }

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

        // Multi-pharmacy alert
        var medPharmMap = {};
        claims.forEach(function (c) {
          var med = c.ndcHash || c.medication || '';
          var pharm = c.pharmacyWalletId || c.pharmacy || '';
          if (!med) return;
          if (!medPharmMap[med]) medPharmMap[med] = new Set();
          medPharmMap[med].add(pharm);
        });

        var alertHtml = '';
        Object.keys(medPharmMap).forEach(function (med) {
          if (medPharmMap[med].size > 1) {
            alertHtml += '<div class="dur-alert dur-alert-warn">' +
              '<span class="fw-600">[MULTI-PHARMACY]</span> ' + truncate(med, 20) +
              ' dispensed at ' + medPharmMap[med].size + ' pharmacies' +
              '</div>';
          }
        });
        if (alertHtml) setHTML('#dur-alerts', alertHtml);
      }
    } catch (err) {
      setHTML('#dur-history-table', '<tr><td colspan="6" class="text-red">Error: ' + escapeHtml(err.message) + '</td></tr>');
    }
  }

  async function durCheckDuplicate() {
    if (!durCurrentWallet) return;
    var ndcHash = $('#dur-check-ndc').value.trim();
    if (!ndcHash) return;

    setHTML('#dur-check-result', '<div class="loading">Checking...</div>');

    try {
      var result = await API.dur.checkDuplicate(durCurrentWallet, ndcHash);
      var isDuplicate = result.activeClaim || result.duplicate || result.isDuplicate || result.found || false;
      if (isDuplicate) {
        var detail = '';
        if (result.existingClaim || result.claim) {
          var c = result.existingClaim || result.claim;
          detail = ' — Last filled at ' + truncate(c.pharmacyWalletId || c.pharmacy, 16) +
            ' on ' + formatDate(c.dateOfService || c.date);
        }
        setHTML('#dur-check-result',
          '<div class="dur-alert dur-alert-danger">' +
          '<span class="fw-600">[DUPLICATE THERAPY]</span> Active claim exists.' + escapeHtml(detail) + '</div>');
      } else {
        setHTML('#dur-check-result',
          '<div class="dur-alert dur-alert-ok"><span class="fw-600">[CLEAR]</span> No duplicate therapy found.</div>');
      }
    } catch (err) {
      setHTML('#dur-check-result',
        '<div class="dur-alert dur-alert-warn">Error: ' + escapeHtml(err.message) + '</div>');
    }
  }

  async function durClaimDetail(leafIndex) {
    showEl('#dur-claim-detail');
    setHTML('#dur-claim-detail-body', '<div class="loading">Loading claim detail...</div>');

    try {
      var detail = await API.dur.claimDetail(leafIndex);
      var claim = detail.claim || detail;
      var html = '<div class="mb-16">';

      var fields = [
        ['Leaf Index', detail.leafIndex || detail.index || leafIndex],
        ['Member Wallet', claim.memberWalletId || claim.patient],
        ['NDC Hash', claim.ndcHash || claim.medication],
        ['Pharmacy Wallet', claim.pharmacyWalletId || claim.pharmacy],
        ['Prescriber Wallet', claim.prescriberWalletId || claim.prescriber],
        ['Date of Service', formatDate(claim.dateOfService || claim.date)],
        ['Patient Pay', formatCents(claim.patientPayCents || claim.patientPay)],
        ['Plan Pay', formatCents(claim.planPayCents || claim.planPay)],
        ['Deductible Credit', formatCents(claim.deductibleCreditCents || claim.deductibleCredit)],
      ];

      fields.forEach(function (f) {
        html += '<div class="modal-row">' +
          '<span class="modal-row-label">' + f[0] + '</span>' +
          '<span class="modal-row-value">' + escapeHtml(formatField(f[1])) + '</span></div>';
      });
      html += '</div>';

      if (detail.merkleProof || detail.proof || detail.witness || detail.witnessJson) {
        var proof = detail.merkleProof || detail.proof || detail.witness || detail.witnessJson;
        html += '<div class="mb-8 fw-600 text-secondary">Merkle Proof</div>';
        html += '<div style="background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px; font-family:var(--font-mono); font-size:10px; max-height:180px; overflow-y:auto; word-break:break-all;">';
        html += escapeHtml(typeof proof === 'string' ? proof : JSON.stringify(proof, null, 2));
        html += '</div>';
      }

      setHTML('#dur-claim-detail-body', html);
    } catch (err) {
      setHTML('#dur-claim-detail-body', '<div class="text-red">Error: ' + escapeHtml(err.message) + '</div>');
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  MESSAGING
  // ══════════════════════════════════════════════════════════════

  async function loadMessaging() {
    // Load all messages and build contact list
    try {
      var data = await API.messaging.inbox();
      var inbox = Array.isArray(data) ? data : (data.messages || []);

      var sentData = await API.messaging.sent();
      var sent = Array.isArray(sentData) ? sentData : (sentData.messages || []);

      var allMessages = inbox.concat(sent);

      // Build thread map
      var threadMap = {};
      allMessages.forEach(function (m) {
        var tid = m.threadIdHash || m.threadId || '';
        if (!tid) return;
        if (!threadMap[tid]) threadMap[tid] = [];
        threadMap[tid].push(m);
      });

      // Build contacts from threads
      msgContacts = Object.keys(threadMap).map(function (tid) {
        var msgs = threadMap[tid].sort(function (a, b) {
          return (b.timestamp || 0) - (a.timestamp || 0);
        });
        var latest = msgs[0];
        var other = latest.senderWalletId || latest.sender || latest.from || '';
        if (other === (onboardingStatus?.walletId || onboardingStatus?.wallet)) {
          other = latest.recipientWalletId || latest.recipient || latest.to || '';
        }
        return {
          threadId: tid,
          otherWallet: other,
          latestMessage: latest.message || latest.body || latest.content || latest.subject || '',
          latestTime: latest.timestamp,
          messageCount: msgs.length,
        };
      }).sort(function (a, b) {
        return (b.latestTime || 0) - (a.latestTime || 0);
      });

      renderContactsList();
    } catch (err) {
      setHTML('#msg-contacts-list', '<div class="empty-state"><div class="empty-state-desc text-red">Error: ' + escapeHtml(err.message) + '</div></div>');
    }
  }

  function renderContactsList() {
    var container = $('#msg-contacts-list');
    if (msgContacts.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:24px;"><div class="empty-state-desc">No conversations</div></div>';
      return;
    }

    container.innerHTML = msgContacts.map(function (c) {
      var initial = (c.otherWallet || '?').slice(0, 2).toUpperCase();
      var time = c.latestTime ? new Date(c.latestTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
      var active = msgActiveThread === c.threadId ? ' active' : '';
      return '<div class="msg-contact-item' + active + '" data-thread="' + escapeHtml(c.threadId) + '">' +
        '<div class="msg-contact-avatar">' + escapeHtml(initial) + '</div>' +
        '<div class="msg-contact-info">' +
          '<div class="msg-contact-name">' + truncate(c.otherWallet, 20) + '</div>' +
          '<div class="msg-contact-preview">' + escapeHtml(truncate(c.latestMessage, 30)) + '</div>' +
        '</div>' +
        '<span class="msg-contact-time">' + escapeHtml(time) + '</span>' +
      '</div>';
    }).join('');

    // Click handlers
    container.querySelectorAll('.msg-contact-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var tid = this.dataset.thread;
        openThread(tid);
      });
    });
  }

  async function openThread(threadIdHash) {
    msgActiveThread = threadIdHash;
    renderContactsList();

    var contact = msgContacts.find(function (c) { return c.threadId === threadIdHash; });
    setText('#msg-conv-title', contact ? truncate(contact.otherWallet, 28) : 'Thread');
    showEl('#msg-conv-input');
    setHTML('#msg-conv-body', '<div class="loading">Loading...</div>');

    try {
      var data = await API.messaging.thread(threadIdHash);
      var messages = Array.isArray(data) ? data : (data.messages || []);

      var myWallet = onboardingStatus?.walletId || onboardingStatus?.wallet || '';

      if (messages.length === 0) {
        setHTML('#msg-conv-body', '<div class="empty-state"><div class="empty-state-desc">No messages in thread</div></div>');
        return;
      }

      // Sort oldest first
      messages.sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });

      var html = messages.map(function (m) {
        var sender = m.senderWalletId || m.sender || m.from || '';
        var isOutgoing = sender === myWallet;
        var time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
        var body = m.message || m.body || m.content || '';
        return '<div class="msg-bubble ' + (isOutgoing ? 'outgoing' : 'incoming') + '">' +
          escapeHtml(body) +
          '<div class="msg-bubble-meta">' + escapeHtml(time) + '</div>' +
        '</div>';
      }).join('');

      setHTML('#msg-conv-body', html);

      // Scroll to bottom
      var convBody = $('#msg-conv-body');
      convBody.scrollTop = convBody.scrollHeight;
    } catch (err) {
      setHTML('#msg-conv-body', '<div class="empty-state text-red">Error: ' + escapeHtml(err.message) + '</div>');
    }
  }

  async function sendThreadMessage() {
    if (!msgActiveThread) return;
    var text = $('#msg-input-text').value.trim();
    if (!text) return;

    var contact = msgContacts.find(function (c) { return c.threadId === msgActiveThread; });
    if (!contact) return;

    $('#msg-input-text').value = '';

    try {
      var myWallet = onboardingStatus?.walletId || onboardingStatus?.wallet || '';
      await API.messaging.send({
        message: { messageCommitment: '0', senderWalletId: myWallet, recipientWalletId: contact.otherWallet, messageType: '1', threadIdHash: msgActiveThread },
        payload: { ciphertext: btoa(text), iv: '0', tag: '0', timestamp: Date.now() },
      });
      // Reload thread
      openThread(msgActiveThread);
    } catch (err) {
      alert('Send failed: ' + (err.message || String(err)));
    }
  }

  async function sendComposeMessage() {
    var recipient = $('#msg-compose-recipient').value.trim();
    var body = $('#msg-compose-body').value.trim();
    var resultEl = $('#msg-compose-result');

    if (!recipient || !body) {
      resultEl.classList.remove('hidden');
      resultEl.classList.add('error');
      resultEl.textContent = 'Recipient and message are required.';
      return;
    }

    resultEl.classList.remove('hidden', 'error');
    resultEl.textContent = 'Sending...';

    try {
      var myWallet = onboardingStatus?.walletId || onboardingStatus?.wallet || '';
      await API.messaging.send({
        message: { messageCommitment: '0', senderWalletId: myWallet, recipientWalletId: recipient, messageType: '1', threadIdHash: '0' },
        payload: { ciphertext: btoa(body), iv: '0', tag: '0', timestamp: Date.now() },
      });
      resultEl.classList.remove('error');
      resultEl.textContent = 'Sent!';
      $('#msg-compose-recipient').value = '';
      $('#msg-compose-body').value = '';
      setTimeout(function () {
        hideEl('#msg-compose-overlay');
        resultEl.classList.add('hidden');
        loadMessaging();
      }, 800);
    } catch (err) {
      resultEl.classList.add('error');
      resultEl.textContent = 'Error: ' + (err.message || String(err));
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  ONBOARDING
  // ══════════════════════════════════════════════════════════════

  async function loadOnboarding() {
    try {
      var status = await API.onboarding.status();
      onboardingStatus = status;
      var step = resolveOnboardingStep(status);
      updateWizardUI(step, status);
    } catch (err) {
      updateWizardUI(0, null);
    }
  }

  function resolveOnboardingStep(status) {
    if (!status) return 0;
    var phase = (status.phase || status.step || '').toLowerCase();
    if (phase.includes('ready') || phase.includes('done') || phase.includes('compiled') || phase.includes('complete')) return 5;
    if (phase.includes('compil')) return 4;
    if (phase.includes('enroll')) return 3;
    if (phase.includes('wallet') || phase.includes('deriv')) return 2;
    if (phase.includes('key') || phase.includes('generat')) return 1;
    if (phase.includes('token') || phase.includes('accept')) return 0;
    if (typeof status.stepIndex === 'number') return Math.min(status.stepIndex, 5);
    return 0;
  }

  function updateWizardUI(currentStep, status) {
    $$('.wizard-step').forEach(function (el) {
      var s = parseInt(el.dataset.step);
      el.classList.remove('done', 'current');
      if (s < currentStep) el.classList.add('done');
      else if (s === currentStep) el.classList.add('current');
    });

    for (var i = 0; i <= 5; i++) {
      var panel = $('#wiz-panel-' + i);
      if (panel) {
        if (i === currentStep) panel.classList.remove('hidden');
        else panel.classList.add('hidden');
      }
    }

    if (currentStep === 5 && status) {
      var result = $('#wiz-result-5');
      if (result) {
        result.style.display = 'block';
        result.textContent = 'Wallet: ' + (status.walletId || status.wallet || '--');
      }
      var statsEl = $('#wiz-done-stats');
      if (statsEl) {
        statsEl.innerHTML =
          '<div class="stat-card"><div class="stat-label">Phase</div><div class="stat-value accent">' + escapeHtml(status.phase || 'READY') + '</div></div>' +
          '<div class="stat-card"><div class="stat-label">Wallet</div><div class="stat-value text-mono" style="font-size:11px; word-break:break-all;">' + escapeHtml(status.walletId || status.wallet || '--') + '</div></div>';
      }
    }
  }

  async function wizardAction(step) {
    var resultEl = $('#wiz-result-' + step);
    var btn = $('#wiz-btn-' + step);
    if (btn) btn.disabled = true;
    if (resultEl) {
      resultEl.classList.remove('hidden', 'error');
      resultEl.textContent = 'Processing...';
    }

    try {
      var result;
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
          // Auto-submit registration proof after compile (phase is now 'ready')
          if (resultEl) {
            resultEl.classList.remove('error');
            resultEl.textContent = 'Compiled — generating registration proof (30-120s)...';
          }
          try {
            var proofRes = await API.proof.registration();
            if (resultEl) resultEl.textContent = 'Compiled + proof submitted. Receipt: ' + (proofRes.receiptId || 'ok');
            console.log('[onboard] Registration proof submitted to sequencer:', proofRes.receiptId);
          } catch (proofErr) {
            console.error('[onboard] Registration proof failed after compile:', proofErr.message);
            if (resultEl) {
              resultEl.classList.add('error');
              resultEl.textContent = 'Compiled but proof failed: ' + (proofErr.message || String(proofErr)) + ' — use Proofs tab to retry';
            }
          }
          break;
      }
      if (resultEl && !resultEl.textContent) {
        resultEl.classList.remove('error');
        resultEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      }
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

  // ══════════════════════════════════════════════════════════════
  //  PROOFS
  // ══════════════════════════════════════════════════════════════

  async function loadProofs() {
    try {
      var status = await API.onboarding.status();
      var html = '<div>';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Phase</span><span class="fw-600 text-accent">' + escapeHtml(status.phase || '--') + '</span></div>';
      html += '<div class="flex justify-between mb-8"><span class="text-secondary">Wallet</span><span class="fw-600 text-mono" style="font-size:11px;">' + escapeHtml(truncate(status.walletId || status.wallet, 28)) + '</span></div>';
      if (status.compiled !== undefined) {
        html += '<div class="flex justify-between mb-8"><span class="text-secondary">Compiled</span><span class="fw-600 ' + (status.compiled ? 'text-green' : 'text-red') + '">' + (status.compiled ? 'Yes' : 'No') + '</span></div>';
      }
      html += '</div>';
      setHTML('#proof-status', html);
    } catch (_) {
      setHTML('#proof-status', '<div class="text-muted">Unable to load status</div>');
    }

    try {
      var timings = await API.proof.timings();
      var entries = Array.isArray(timings) ? timings : (timings.timings || Object.entries(timings || {}).map(function (e) { return { name: e[0], ms: e[1] }; }));

      if (entries.length === 0) {
        setHTML('#proof-timings', '<div class="text-muted">No proof timings recorded yet.</div>');
        return;
      }

      var maxMs = Math.max.apply(null, entries.map(function (e) { return e.ms || e.duration || e.time || 0; }));

      setHTML('#proof-timings', entries.map(function (e) {
        var ms = e.ms || e.duration || e.time || 0;
        var pct = maxMs > 0 ? Math.max(2, (ms / maxMs) * 100) : 2;
        var label = e.name || e.label || e.program || '--';
        var secs = (ms / 1000).toFixed(2);
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
    var btn = $('#proof-reg-btn');
    var resultEl = $('#proof-reg-result');
    btn.disabled = true;
    resultEl.classList.remove('hidden', 'error');
    resultEl.textContent = 'Generating registration proof...';

    try {
      var result = await API.proof.registration();
      resultEl.classList.remove('error');
      resultEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      resultEl.classList.add('error');
      resultEl.textContent = 'Error: ' + (err.message || String(err));
    } finally {
      btn.disabled = false;
    }
  }

  // ── Event Binding ──────────────────────────────────────────

  function bindEvents() {
    // Nav tabs
    $$('.nav-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(this.dataset.tab);
      });
    });

    window.addEventListener('hashchange', function () {
      var hash = location.hash.replace('#', '') || 'workstation';
      navigate(hash);
    });

    // Workstation
    $('#ws-refresh-btn').addEventListener('click', loadWorkstation);
    $('#ws-nfc-scan-btn').addEventListener('click', nfcScanHardware);
    $('#ws-verify-lookup-btn').addEventListener('click', function () {
      verifyMember();
    });
    $('#ws-verify-wallet').addEventListener('keypress', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); verifyMember(); }
    });
    $('#ws-verify-wallet').addEventListener('input', function () {
      // Auto-resize textarea for JSON attestation payloads
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    $('#ws-modal-close').addEventListener('click', closeModal);
    $('#ws-modal-overlay').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });

    // History
    $('#hist-filter-btn').addEventListener('click', applyHistoryFilter);
    $('#hist-clear-btn').addEventListener('click', clearHistoryFilter);

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

    // Messaging
    $('#msg-compose-btn').addEventListener('click', function () {
      showEl('#msg-compose-overlay');
    });
    $('#msg-compose-close').addEventListener('click', function () {
      hideEl('#msg-compose-overlay');
    });
    $('#msg-compose-overlay').addEventListener('click', function (e) {
      if (e.target === this) hideEl('#msg-compose-overlay');
    });
    $('#msg-compose-send-btn').addEventListener('click', sendComposeMessage);
    $('#msg-send-btn').addEventListener('click', sendThreadMessage);
    $('#msg-input-text').addEventListener('keypress', function (e) {
      if (e.key === 'Enter') sendThreadMessage();
    });

    // Onboarding wizard
    for (var i = 0; i <= 4; i++) {
      (function (step) {
        var btn = $('#wiz-btn-' + step);
        if (btn) btn.addEventListener('click', function () { wizardAction(step); });
      })(i);
    }

    // Proofs
    $('#proof-reg-btn').addEventListener('click', generateRegistrationProof);
  }

  // ── Init ─────────────────────────────────────────────────────

  function initPharmacySelector() {
    var sel = $('#pharmacy-selector');
    if (!sel) return;
    var current = getSelectedPharmacy();
    sel.innerHTML = PHARMACIES.map(function (p) {
      var loc = p.city ? (p.city + ', ' + p.state) : (p.state || '');
      return '<option value="' + p.npi + '"' + (p.npi === current.npi ? ' selected' : '') + '>' +
        escapeHtml(p.name) + ' — ' + escapeHtml(p.type || 'Pharmacy') + (loc ? ' (' + escapeHtml(loc) + ')' : '') +
        '</option>';
    }).join('');
    sel.addEventListener('change', function () {
      switchPharmacy(sel.value);
    });
  }

  function switchPharmacy(npi) {
    setSelectedPharmacy(npi);
    // Reset in-memory workflow state for the new pharmacy
    resetWorkflow();
    setVerifiedMemberWallet(null);
    // Refresh current tab
    onTabEnter(currentTab);
  }

  // ══════════════════════════════════════════════════════════════
  //  BADGE TAP — ALIAS IN
  // ══════════════════════════════════════════════════════════════

  var INTERACTIVE_BASE = window.INTERACTIVE_BASE || location.origin;

  function pharmacyInitials(name) {
    var parts = (name || '').split(/[\s-]+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (name || '??').slice(0, 2).toUpperCase();
  }

  function initBadgeTap() {
    var btn = $('#badge-tap-btn');
    var modal = $('#badge-modal');
    var closeBtn = $('#badge-modal-close');

    if (!btn || !modal) return;

    btn.addEventListener('click', function () {
      var p = getSelectedPharmacy();
      var idx = PHARMACIES.findIndex(function (x) { return x.npi === p.npi; });
      showBadgeModal(p, idx >= 0 ? idx : 0);
    });

    closeBtn.addEventListener('click', function () {
      modal.style.display = 'none';
    });

    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.style.display = 'none';
    });
  }

  function showBadgeModal(pharmacy, index) {
    var modal = $('#badge-modal');
    var card = $('#badge-card');
    var steps = $('#badge-steps');
    var result = $('#badge-result');

    // Update badge card
    setText('#badge-card-name', pharmacy.name);
    setText('#badge-card-specialty', pharmacy.type);
    setText('#badge-card-npi', 'NPI: ' + pharmacy.npi + ' | NCPDP: ' + pharmacy.ncpdp);
    setText('#badge-card-avatar', pharmacyInitials(pharmacy.name));

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
    runBadgeTap(pharmacy, index);
  }

  async function runBadgeTap(pharmacy, index) {
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
          el.innerHTML += ' <span class="step-error">' + escapeHtml(msg) + '</span>';
        }
      });
    }

    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // Step 1: Tap
    activateStep('tap');
    await sleep(400);
    completeStep('tap');

    // Call the interactive backend
    try {
      activateStep('decrypt');

      var providerWalletId = onboardingStatus?.walletId || onboardingStatus?.wallet || '';
      var response = await fetch(location.origin + '/interactive/badge/tap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletId: providerWalletId }),
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
            result.innerHTML = '<div class="badge-result-error">Authentication failed: ' + escapeHtml(evt.error || 'Unknown') + '</div>';
            return;
        }
      }

      if (data.authenticated) {
        card.classList.add('badge-authenticated');
        var sessionEvt = events.find(function (e) { return e.type === 'badge:session'; });
        var proofEvt = events.find(function (e) { return e.type === 'badge:proof'; });
        result.style.display = 'block';
        result.innerHTML =
          '<div class="badge-result-success">' +
          '<div class="badge-result-title">Authenticated</div>' +
          '<div class="badge-result-detail">Pharmacy: ' + escapeHtml(pharmacy.name) + '</div>' +
          '<div class="badge-result-detail">Wallet: ' + escapeHtml((events.find(function (e) { return e.type === 'badge:derive'; }) || {}).data?.walletId?.slice(0, 20) || '--') + '...</div>' +
          (proofEvt && proofEvt.data && proofEvt.data.proofHash ? '<div class="badge-result-detail">ZK Proof: ' + escapeHtml(proofEvt.data.proofHash) + '</div>' : '') +
          (sessionEvt ? '<div class="badge-result-detail">Session: 8h shift</div>' : '') +
          '</div>';
      }

    } catch (err) {
      errorStep('decrypt', err.message || 'Network error');
      result.style.display = 'block';
      result.innerHTML = '<div class="badge-result-error">Connection failed: ' + escapeHtml(err.message) + '</div>';
    }
  }

  async function loadPharmacyList() {
    try {
      var res = await fetch(location.origin + '/pharmacies/list');
      var json = await res.json();
      if (json.ok && Array.isArray(json.data)) {
        PHARMACIES = json.data;
      }
    } catch (_) { /* server not ready — PHARMACIES stays empty */ }
  }

  async function init() {
    await loadPharmacyList();
    initPharmacySelector();
    initBadgeTap();
    resetWorkflow();
    bindEvents();
    initSSE();

    var hash = location.hash.replace('#', '') || 'workstation';
    navigate(hash);
  }

  // Expose for inline onclick handlers
  window.App = {
    dispenseScript: dispenseScript,
    fillScript: fillScript,
    rejectScript: rejectScript,
    transferScript: transferScript,
    verifyMemberForScript: verifyMemberForScript,
    confirmPayment: confirmPayment,
    showScriptDetail: showScriptDetail,
    closeModal: closeModal,
    flagIssue: flagIssue,
    reverseScript: reverseScript,
    durLookupFromScript: durLookupFromScript,
    durClaimDetail: durClaimDetail,
    switchPharmacy: switchPharmacy,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
