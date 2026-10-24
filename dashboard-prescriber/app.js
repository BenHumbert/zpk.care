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

// Adjuda-GATOR Prescriber Dashboard — SPA Application Logic
// Overview, Write Rx, Patients, Formulary, Providers, Messaging, Onboarding, Proofs.

(function () {
  'use strict';

  // ── Prescribers (loaded from server at init) ────────────────
  var PRESCRIBERS = [];

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

  // Normalize a value into a safe error message string (avoids "[object Object]")
  function errMsg(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.error === 'string') return e.error;
    if (e.error && typeof e.error.message === 'string') return e.error.message;
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

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

  // Escapes for text and for attribute values: the Write Rx options carry esc() output in quoted values.
  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // VULNERABILITY: Messages are currently base64-encoded (prescriber) or AES-GCM with
  // ephemeral keys (member). Neither side shares keys, so true E2E decryption is not
  // implemented. This helper decodes what it can — base64 plaintext or hex ciphertext —
  // but does NOT provide real encryption. See project memory for tracking.
  function decodePayload(ciphertext, iv) {
    if (!ciphertext) return '(no content)';
    // Prescriber sends btoa(plaintext) with iv='0' — decode as base64
    if (iv === '0' || iv === '') {
      try { return atob(ciphertext); } catch (_) { return '(decode error)'; }
    }
    // Member sends hex-encoded AES-GCM — we lack the key, show hex length hint
    // When real E2E encryption is implemented, decrypt here with shared secret
    if (/^[0-9a-f]+$/i.test(ciphertext)) {
      return '(encrypted \u2014 ' + Math.floor(ciphertext.length / 2) + ' bytes)';
    }
    // Fallback: try base64
    try { return atob(ciphertext); } catch (_) { return '(encrypted)'; }
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
    populateRxDropdowns();

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

  /**
   * Replaces a select's options, keeping the choice already made while the new options still offer it. The Write Rx
   * lists are refetched each time the tab or the form opens, and a refetch can answer after the prescriber has picked:
   * replacing the options alone selects the first one, the placeholder, and fires no change event. The choice is read
   * here, as the options are replaced, so a refetch that started before the pick keeps it too.
   */
  function setSelectOptions(sel, html) {
    var chosen = sel.value;
    sel.innerHTML = html;
    if (chosen && Array.from(sel.options).some(function (o) { return o.value === chosen; })) sel.value = chosen;
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
    // Load medications from paginated formulary service (Option C)
    if (cachedMedications.length === 0) {
      try {
        // Load first 500 drugs sorted by name for the Rx dropdown
        var page = await API.getFormularyPage({ limit: 500, offset: 0 });
        if (page && Array.isArray(page.drugs)) {
          cachedMedications = page.drugs.map(function (d) {
            return { ndcHash: d.ndcHash, brandName: d.brandName || '', genericName: d.genericName || '', ndc: d.ndc || '', strength: d.strength || '', dosageForm: d.dosageForm || '', pricingUnit: d.pricingUnit || '', tierLevel: d.tierLevel, copay: d.copayAmount != null ? d.copayAmount / 100 : 0, claimCount: 0 };
          });
          // Store total count for UI
          window._formularyTotalCount = page.total || cachedMedications.length;
        }
      } catch (formErr) {
        console.warn('[rx] Formulary page load failed, trying legacy:', formErr);
        try {
          var formData = await API.getFormulary('default');
          if (formData && formData.entriesJson) {
            var entries = JSON.parse(formData.entriesJson);
            if (Array.isArray(entries)) {
              cachedMedications = entries.filter(function (e) { return e.ndcHash; }).map(function (e) {
                return { ndcHash: e.ndcHash, brandName: e.brandName || e.genericName || '', genericName: e.genericName || '', ndc: e.ndc || '', strength: e.strength || '', dosageForm: e.dosageForm || '', tierLevel: e.tierLevel, copay: e.copayAmountCents != null ? e.copayAmountCents / 100 : e.copay, claimCount: 0 };
              });
            }
          }
        } catch (legacyErr) {
          console.warn('[rx] Legacy formulary also failed:', legacyErr);
        }
      }
    }
    // Overlay claim counts from prescribing history
    try {
      var meds = await API.getMedicationBreakdown();
      if (Array.isArray(meds) && meds.length > 0) {
        var countMap = {};
        meds.forEach(function (m) { if (m.ndcHash) countMap[m.ndcHash] = m.claimCount || 0; });
        cachedMedications.forEach(function (m) { if (countMap[m.ndcHash]) m.claimCount = countMap[m.ndcHash]; });
      }
    } catch (_) { }

    var patientSel = $('#rx-patient-select');
    var pharmSel = $('#rx-pharmacy-select');
    var medSel = $('#rx-med-select');

    if (patientSel && cachedMembers.length > 0) {
      setSelectOptions(patientSel, '<option value="">-- Select Patient --</option>' +
        cachedMembers.map(function (m) { return '<option value="' + esc(m.walletId) + '">' + esc(m.displayName || truncHash(m.walletId)) + '</option>'; }).join(''));
    }
    if (pharmSel && cachedPharmacies.length > 0) {
      setSelectOptions(pharmSel, '<option value="">-- Select Pharmacy --</option>' +
        cachedPharmacies.map(function (p) { return '<option value="' + esc(p.walletId) + '">' + esc(p.displayName || truncHash(p.walletId)) + '</option>'; }).join(''));
    }
    if (medSel && cachedMedications.length > 0) {
      setSelectOptions(medSel, '<option value="">-- Select Medication (' + cachedMedications.length + ' available) --</option>' +
        cachedMedications.map(function (m) {
          var label = m.brandName || m.genericName || truncHash(m.ndcHash);
          if (m.strength) label += ' ' + m.strength;
          if (m.dosageForm) label += ' ' + m.dosageForm;
          if (m.claimCount > 0) label += ' (' + m.claimCount + ' Rx)';
          return '<option value="' + esc(m.ndcHash) + '" data-name="' + esc(m.brandName || m.genericName || '') + '">' + esc(label) + '</option>';
        }).join(''));
    } else if (medSel) {
      medSel.innerHTML = '<option value="">-- No medications loaded (check formulary tab) --</option>';
    }
  }

  async function writeRx() {
    var memberWalletId = $('#rx-patient-select').value;
    var pharmacyWalletId = $('#rx-pharmacy-select').value;
    var ndcHash = $('#rx-med-select').value || $('#rx-ndc-manual').value.trim();

    if (!memberWalletId) { toast('Select a patient', 'error'); return; }
    if (!pharmacyWalletId) { toast('Select a pharmacy', 'error'); return; }
    if (!ndcHash) { toast('Select a medication or enter NDC hash', 'error'); return; }
    var quantity = parseQuantity($('#rx-quantity').value);
    if (isNaN(quantity)) { toast(QUANTITY_RULE, 'error'); return; }

    var btn = $('#rx-write-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      var medSelect = $('#rx-med-select');
      var brandName = medSelect.selectedOptions[0] ? medSelect.selectedOptions[0].dataset.name || '' : '';
      var res = await API.prescribeWithProof({
        memberWalletId: memberWalletId,
        pharmacyWalletId: pharmacyWalletId,
        ndcHash: ndcHash,
        brandName: brandName,
        quantity: quantity,
        daysSupply: parseInt($('#rx-days-supply').value) || 30,
        refills: parseInt($('#rx-refills').value) || 0,
        directions: $('#rx-directions').value.trim(),
        diagnosis: $('#rx-diagnosis').value.trim(),
      });

      // eScript delivered immediately, proof generating in background
      setHTML('#rx-write-result',
        '<div class="form-result info">' +
          '<div><strong>eScript delivered</strong> — Rx ID: ' + esc(res.rxId) + '</div>' +
          '<div style="margin-top:8px">' +
            '<span class="badge badge-pending" id="rx-proof-badge">ZK Proof: Generating...</span>' +
          '</div>' +
          // the timings and the summary wrap between words; the box around them breaks anywhere, for its hashes
          '<div id="rx-proof-detail" style="margin-top:8px;font-size:0.85em;color:var(--text-secondary);word-break:normal;overflow-wrap:anywhere"></div>' +
        '</div>');
      toast('eScript sent — ZK proof generating', 'info');

      // Poll for proof completion
      pollPrescribeStatus(res.jobKey, res.rxId, 0);
    } catch (err) {
      setHTML('#rx-write-result', '<div class="form-result error">' + esc(err.message) + '</div>');
      btn.disabled = false;
      btn.textContent = 'Send Prescription';
    }
  }

  // The proofs prescribing makes, by the keys of createPrescription's proofTimesMs (interactive-service.ts), under the
  // one name the result box gives each of them, in its timings and in its summary.
  var PRESCRIBE_PROOF_NAMES = { proofGate: 'ProofGate.verifyPrescriber', eligibility: 'Eligibility', accessControl: 'FormularyAccess', priorAuth: 'PriorAuth', messaging: 'Messaging (eScript)' };

  /**
   * The result box's timings: one total, the sum of the proof times the engine measured, then each proof by its name.
   * The status's elapsedMs (the job's age when a poll found it done, so up to a poll late) stands in only when the
   * engine sent no times.
   */
  function prescribeProofTimes(result, elapsedMs) {
    var times = (result && result.proofTimesMs) || {};
    var keys = Object.keys(times).filter(function (k) { return k !== 'total'; });
    var secs = function (ms) { return (Number(ms) / 1000).toFixed(2) + 's'; };
    if (!keys.length) return elapsedMs ? '<div>Proved in ' + esc(secs(elapsedMs)) + '</div>' : '';
    var total = keys.reduce(function (sum, k) { return sum + Number(times[k]); }, 0);
    return '<div>Proved in ' + esc(secs(total)) + '</div>' +
      '<div style="margin-top:4px">' + keys.map(function (k) { return esc(PRESCRIBE_PROOF_NAMES[k] || k) + ': ' + esc(secs(times[k])); }).join(' | ') + '</div>';
  }

  // What prescribing proved. The engine generates these proofs, keeps none of them and submits none to the ledger, so
  // no one else verifies them (A-22).
  function prescribeProofSummary(result) {
    var list = Object.keys((result && result.proofTimesMs) || {})
      .filter(function (k) { return k !== 'total'; })
      .map(function (k) { return PRESCRIBE_PROOF_NAMES[k] || k; });
    var what = list.length ? list.length + ' ZK proofs generated by the engine: ' + list.join(' + ') + '.' : 'ZK proofs generated by the engine.';
    return what + ' Not kept and not sent to the ledger, so no one outside the engine verifies them yet.';
  }

  function pollPrescribeStatus(jobKey, rxId, attempt) {
    if (attempt > 120) { // 120 × 5s = 10 min timeout
      var badge = document.getElementById('rx-proof-badge');
      if (badge) { badge.className = 'badge badge-error'; badge.textContent = 'ZK Proof: Timeout'; }
      var btn = $('#rx-write-btn');
      if (btn) { btn.disabled = false; btn.textContent = 'Send Prescription'; }
      return;
    }

    setTimeout(async function() {
      try {
        var status = await API.prescribeStatus(jobKey);

        if (status.status === 'complete') {
          var badge = document.getElementById('rx-proof-badge');
          if (badge) { badge.className = 'badge badge-settled'; badge.textContent = 'ZK Proofs: Generated'; }
          var detail = document.getElementById('rx-proof-detail');
          if (detail) {
            detail.innerHTML = prescribeProofTimes(status.result, status.elapsedMs) +
              '<div style="margin-top:4px;color:var(--accent)">' + esc(prescribeProofSummary(status.result)) + '</div>';
          }
          toast('Prescription adjudicated. ZK proofs generated by the engine.', 'success');
          loadPrescriptionHistory();
          var btn = $('#rx-write-btn');
          if (btn) { btn.disabled = false; btn.textContent = 'Send Prescription'; }
        } else if (status.status === 'error') {
          var badge = document.getElementById('rx-proof-badge');
          if (badge) { badge.className = 'badge badge-failed'; badge.textContent = 'ZK Proof: Failed'; }
          var detail = document.getElementById('rx-proof-detail');
          if (detail) { detail.innerHTML = '<div style="color:#ef4444">' + esc(errMsg(status.error) || 'Unknown error') + '</div>'; }
          toast('Prescription proof failed: ' + (errMsg(status.error) || 'Unknown'), 'error');
          var btn = $('#rx-write-btn');
          if (btn) { btn.disabled = false; btn.textContent = 'Send Prescription'; }
        } else {
          // Still pending — poll again
          var detail = document.getElementById('rx-proof-detail');
          if (detail) {
            var elapsed = status.elapsedMs ? (status.elapsedMs / 1000).toFixed(0) : '0';
            detail.innerHTML = '<div>Proving... ' + esc(elapsed) + 's elapsed</div>';
          }
          pollPrescribeStatus(jobKey, rxId, attempt + 1);
        }
      } catch (err) {
        // Network error — retry
        pollPrescribeStatus(jobKey, rxId, attempt + 1);
      }
    }, 5000);
  }

  // A quantity counts the drug's NADAC pricing unit (EA, ML or GM: the NCPDP billing units), to thousandths of it,
  // NCPDP's precision. A typed value with a fourth decimal, or 0, is refused, never rounded.
  var QUANTITY_RULE = 'Quantity must be greater than 0, with at most three decimals, in the drug\'s pricing unit (EA, ML or GM)';
  function parseQuantity(text) {
    var s = String(text == null ? '' : text).trim();
    if (!/^(\d+(\.\d{0,3})?|\.\d{1,3})$/.test(s)) return NaN;
    var q = Number(s);
    return q > 0 ? q : NaN;
  }

  /** The pricing unit of the medication picked in the form, from the formulary page; '' when unknown (an NDC hash typed in). */
  function selectedPricingUnit(ndcHash) {
    for (var i = 0; i < cachedMedications.length; i++) {
      if (cachedMedications[i].ndcHash === ndcHash) return cachedMedications[i].pricingUnit || '';
    }
    return '';
  }

  /** The unit beside the quantity input: "(EA)", "(ML)" or "(GM)". */
  function showQuantityUnit(unit) {
    var el = document.getElementById('rx-quantity-unit');
    if (el) el.textContent = unit ? '(' + unit + ')' : '(pricing unit)';
  }

  // What decided the patient's share, as the engine's quote names it (the fill circuit's phases). A fixture member's
  // copay is its drug's tier copay; a member with a device pays its plan's copay whatever the tier.
  var PHASE_LABELS = {
    'deductible': 'Deductible phase',
    'copay': 'Plan copay',
    'oop-max-reached': 'Out-of-pocket max reached',
    'benefit-max-reached': 'Annual benefit max reached',
    'not-covered': 'Not covered',
  };
  function memberPaysLabel(est) {
    if (est.phase === 'copay' && est.copayBasis === 'tier') return 'Tier ' + esc(est.tierLevel) + ' copay';
    return esc(PHASE_LABELS[est.phase] || est.phase || '');
  }

  // What the plan's share is, for the phase and the amounts of the same quote: in the deductible phase, within the
  // copay and past the annual benefit max the plan may pay nothing, and the card says so.
  function planPaysLabel(est) {
    var planPays = Number(est.employerPayCents) > 0;
    switch (est.phase) {
      case 'deductible': return planPays ? 'The rest, after the deductible and the copay' : 'Deductible phase: the plan pays nothing yet';
      case 'copay': return planPays ? 'The rest, after the copay' : 'Total within the copay: the plan pays nothing';
      case 'oop-max-reached': return Number(est.memberPayCents) > 0 ? 'The rest, past the out-of-pocket max' : 'Out-of-pocket max reached: the plan pays it all';
      case 'benefit-max-reached': return planPays ? 'What is left of the annual benefit max' : 'Annual benefit max reached: the plan pays nothing more';
      default: return planPays ? 'The rest of the total' : 'The plan pays nothing';
    }
  }

  // A prior authorization's status on the patient's plan, as the engine records it.
  var PA_LABELS = {
    'none': 'Not requested',
    'pending': 'Pending with the insurer',
    'approved': 'Approved',
    'denied': 'Denied',
  };

  /**
   * The drug's availability on the patient's plan, from her quote: covered, prior authorization, step therapy and the
   * limit per fill (in the pricing unit), with the quantity typed held against the limit.
   */
  function coverageLine(est, quantity) {
    var unit = est.pricingUnit || 'unit';
    var over = est.maxQuantityPerFill != null && quantity > est.maxQuantityPerFill;
    // a quote that does not report the plan's rules says only that the drug is covered, never "no prior authorization"
    var rulesKnown = typeof est.priorAuthRequired === 'boolean';
    var items = ['<span class="rx-coverage-item ok">Covered on the patient\'s plan</span>'];
    if (rulesKnown) {
      items.push(est.priorAuthRequired
        ? '<span class="rx-coverage-item warn">Prior authorization required</span>'
        : '<span class="rx-coverage-item ok">No prior authorization</span>');
      items.push(est.stepTherapyRequired
        ? '<span class="rx-coverage-item warn">Step therapy required</span>'
        : '<span class="rx-coverage-item ok">No step therapy</span>');
    }
    if (est.maxQuantityPerFill != null) {
      items.push('<span class="rx-coverage-item ' + (over ? 'bad' : 'ok') + '" id="rx-est-limit">Limit ' + esc(est.maxQuantityPerFill) + ' ' + esc(unit) + ' per fill' +
        (over ? ': ' + esc(quantity) + ' ' + esc(unit) + ' is over it' : '') + '</span>');
    }
    return '<div id="rx-est-coverage" class="rx-coverage" data-covered="true"' +
      ' data-prior-auth="' + (!rulesKnown ? 'unknown' : est.priorAuthRequired ? 'required' : 'not-required') + '"' +
      ' data-step-therapy="' + (!rulesKnown ? 'unknown' : est.stepTherapyRequired ? 'required' : 'not-required') + '">' + items.join('') + '</div>';
  }

  /** The prior-authorization row: the patient's status for this drug, and the request button while none is pending or in force. */
  function priorAuthBlock(pa) {
    var status = (pa && pa.status) || 'none';
    var text = PA_LABELS[status] || status;
    if (status === 'approved' && pa.expiresOn) text += ' through ' + pa.expiresOn;
    var canRequest = status === 'none' || status === 'denied';
    return '<div id="rx-pa" class="rx-pa" data-pa-status="' + esc(status) + '">' +
      '<span class="rx-pa-label">Prior authorization:</span> ' +
      '<span id="rx-pa-status" class="rx-pa-status ' + esc(status) + '">' + esc(text) + '</span>' +
      (canRequest
        ? '<input type="text" class="form-input rx-pa-reason" id="rx-pa-reason" maxlength="500" placeholder="Reason for the request (optional)">' +
          '<button class="btn btn-sm btn-primary" id="rx-pa-request-btn">Request prior authorization</button>'
        : '<button class="btn btn-sm" id="rx-pa-refresh-btn">Refresh status</button>') +
      '</div>';
  }

  /**
   * The estimate card for one quote. refusal: null for the patient's own quote (or no patient selected), 'token' when
   * this node's admin token is missing or wrong, 'consent' when the network refused the patient's price to this
   * prescriber; then est is the price with no patient, and the card shows its ingredient and says why. Returns the
   * card's state (the data-state the page shows) and its HTML.
   */
  function estimateCardHtml(est, memberWalletId, refusal, quantity) {
    var title = '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Cost Estimate — ' + esc(est ? est.drugName : '') + '</div>';
    var forMember = !!memberWalletId && !refusal;
    if (!est || !est.covered) {
      return {
        state: 'not-covered',
        html: title + '<div id="rx-est-coverage" class="rx-coverage" data-covered="false"><span class="rx-coverage-item bad">' +
          (forMember ? 'Not covered on the patient\'s plan' : 'Not covered') + ': ' + esc(est && est.reason ? est.reason : 'Drug not found') + '</span></div>',
      };
    }
    var unit = est.pricingUnit || 'unit';
    var money = function (cents) { return '$' + (Number(cents) / 100).toFixed(2); };
    var box = 'padding:8px;background:var(--bg-surface,#222);border-radius:6px;text-align:center';
    var why = refusal === 'token'
      ? ['Needs this node\'s admin token', 'Set it on the Onboarding tab to see the patient\'s own price']
      : refusal === 'consent'
        ? ['Needs the patient\'s consent', 'Her primary-care prescriber, or a prescriber her phone authorized for this visit, sees her price']
        : ['Select a patient', 'The share depends on the patient\'s plan'];
    var memberBox = forMember
      ? '<div id="rx-est-member-pays" data-cents="' + esc(est.memberPayCents) + '" style="font-size:16px;font-weight:700;color:var(--accent-blue,#58a6ff);font-family:var(--font-mono)">' + money(est.memberPayCents) + '</div>' +
        '<div id="rx-est-phase" data-phase="' + esc(est.phase) + '" style="color:var(--text-muted);margin-top:2px">' + memberPaysLabel(est) + '</div>'
      : '<div style="font-size:13px;font-weight:600;color:var(--text-muted)">' + esc(why[0]) + '</div>' +
        '<div style="color:var(--text-muted);margin-top:2px">' + esc(why[1]) + '</div>';
    var planBox = forMember
      ? '<div id="rx-est-plan-pays" data-cents="' + esc(est.employerPayCents) + '" style="font-size:16px;font-weight:700;color:var(--green,#3fb950);font-family:var(--font-mono)">' + money(est.employerPayCents) + '</div>' +
        '<div style="color:var(--text-muted);margin-top:2px">' + esc(planPaysLabel(est)) + '</div>'
      : '<div style="font-size:13px;font-weight:600;color:var(--text-muted)">&mdash;</div>';
    var html = title +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px">' +
        '<div style="' + box + '">' +
          '<div style="color:var(--text-muted);margin-bottom:4px">Ingredient (NADAC)</div>' +
          '<div id="rx-est-ingredient" data-cents="' + esc(est.ingredientCostCents) + '" style="font-size:16px;font-weight:700;font-family:var(--font-mono)">' + money(est.ingredientCostCents) + '</div>' +
          '<div style="color:var(--text-muted);margin-top:2px">$' + Number(est.nadacPerUnit).toFixed(5) + '/' + esc(unit) + ' x ' + esc(est.quantity) + ' ' + esc(unit) + '</div>' +
        '</div>' +
        '<div style="' + box + '">' +
          '<div style="color:var(--text-muted);margin-bottom:4px">Patient Pays</div>' + memberBox +
        '</div>' +
        '<div style="' + box + '">' +
          '<div style="color:var(--text-muted);margin-bottom:4px">Plan Pays</div>' + planBox +
        '</div>' +
      '</div>' +
      '<div id="rx-est-total" style="margin-top:8px;font-size:11px;color:var(--text-muted)">' +
        (forMember
          ? 'Total: ' + money(est.totalCostCents) + ' (ingredient ' + money(est.ingredientCostCents) + ' + dispensing fee <span id="rx-est-fee" data-cents="' + esc(est.dispensingFeeCents) + '">' + money(est.dispensingFeeCents) + '</span>' +
            (est.dispensingFeeSource === 'plan' ? ', the plan\'s' : est.dispensingFeeSource === 'network-default' ? ', the network default' : '') + ')'
          : 'The dispensing fee and the patient\'s share come from the patient\'s plan') +
      '</div>' +
      (forMember ? coverageLine(est, quantity) : '') +
      (forMember && est.priorAuthRequired ? priorAuthBlock(est.priorAuth) : '');
    var state = forMember ? 'member' : refusal === 'token' ? 'token-needed' : refusal === 'consent' ? 'consent-needed' : 'list-price';
    return { state: state, html: html };
  }

  // What the card shows: the patient, drug and quantity it was asked for (the prior-authorization row acts on these),
  // and a counter so an answer to an older selection never replaces a newer one.
  var estimateContext = null;
  var estimateSeq = 0;

  async function updateCostEstimate() {
    var el = document.getElementById('rx-cost-estimate');
    if (!el) {
      // Create the estimate container if it doesn't exist
      var writeResult = document.getElementById('rx-write-result');
      if (writeResult) {
        var div = document.createElement('div');
        div.id = 'rx-cost-estimate';
        div.style.cssText = 'margin:12px 0;padding:12px;border-radius:8px;background:var(--bg-card,#1a1a2e);border:1px solid var(--border,#333)';
        writeResult.parentNode.insertBefore(div, writeResult);
        el = div;
      } else return;
    }

    var seq = ++estimateSeq;
    estimateContext = null;
    var ndcHash = $('#rx-med-select').value || ($('#rx-ndc-manual') ? $('#rx-ndc-manual').value.trim() : '');
    var memberWalletId = $('#rx-patient-select') ? $('#rx-patient-select').value : '';
    showQuantityUnit(selectedPricingUnit(ndcHash));

    if (!ndcHash) { el.dataset.state = 'empty'; el.innerHTML = ''; return; }
    var quantity = parseQuantity($('#rx-quantity') ? $('#rx-quantity').value : '30');
    if (isNaN(quantity)) { el.dataset.state = 'error'; el.innerHTML = '<div style="color:var(--red,#f85149);font-size:12px">' + esc(QUANTITY_RULE) + '</div>'; return; }

    el.dataset.state = 'loading';
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Estimating cost...</div>';

    try {
      // The engine's quote for the selected patient: the price the fill would charge her today, the drug's availability
      // on her plan and her prior-authorization status. This node asks the network signed as the prescriber, and the
      // network answers her primary-care prescriber or a prescriber her phone authorized for this visit; the node itself
      // answers only its administrator (the token set on the Onboarding tab). Refused, the card shows the drug's
      // ingredient cost with no patient and says why, never another price list as hers.
      var est;
      var refusal = null;
      try {
        est = await API.estimateCost({ ndcHash: ndcHash, walletId: memberWalletId || undefined, quantity: quantity });
      } catch (err) {
        if (!memberWalletId || !err || (err.status !== 401 && err.status !== 403)) throw err;
        refusal = err.status === 401 ? 'token' : 'consent';
        est = await API.estimateCost({ ndcHash: ndcHash, quantity: quantity });
      }
      if (seq !== estimateSeq) return;   // a newer selection is being estimated
      if (est && est.pricingUnit) showQuantityUnit(est.pricingUnit);
      var card = estimateCardHtml(est, memberWalletId, refusal, quantity);
      el.dataset.state = card.state;
      el.innerHTML = card.html;
      if (card.state === 'member') {
        estimateContext = { walletId: memberWalletId, ndcHash: ndcHash, quantity: quantity };
        bindPriorAuthControls();
      }
    } catch (err) {
      if (seq !== estimateSeq) return;
      el.dataset.state = 'error';
      el.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Cost estimate unavailable' + (err && err.message ? ': ' + esc(err.message) : '') + '</div>';
    }
  }

  /** The prior-authorization row's buttons act on the patient and drug the card shows. */
  function bindPriorAuthControls() {
    var requestBtn = document.getElementById('rx-pa-request-btn');
    if (requestBtn) requestBtn.addEventListener('click', requestPriorAuthFromCard);
    var refreshBtn = document.getElementById('rx-pa-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshPriorAuthStatus);
  }

  /** Redraws the prior-authorization row, if the card still shows the patient and drug the status is about. */
  function showPriorAuthStatus(pa, ctx) {
    if (!estimateContext || estimateContext !== ctx) return;
    var row = document.getElementById('rx-pa');
    if (!row) return;
    row.outerHTML = priorAuthBlock(pa);
    bindPriorAuthControls();
  }

  async function requestPriorAuthFromCard() {
    var ctx = estimateContext;
    if (!ctx) return;
    var btn = document.getElementById('rx-pa-request-btn');
    var reasonEl = document.getElementById('rx-pa-reason');
    if (btn) { btn.disabled = true; btn.textContent = 'Requesting...'; }
    try {
      var body = { walletId: ctx.walletId, ndcHash: ctx.ndcHash, quantity: ctx.quantity };
      var reason = reasonEl ? reasonEl.value.trim() : '';
      if (reason) body.reason = reason;
      var answer = await API.requestPriorAuth(body);
      toast('Prior authorization requested: pending with the insurer', 'success');
      showPriorAuthStatus({ status: (answer && answer.status) || 'pending', requestedAt: answer && answer.requestedAt }, ctx);
    } catch (err) {
      toast('Prior authorization not requested: ' + errMsg(err), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Request prior authorization'; }
    }
  }

  async function refreshPriorAuthStatus() {
    var ctx = estimateContext;
    if (!ctx) return;
    try {
      showPriorAuthStatus(await API.getPriorAuthStatus(ctx.walletId, ctx.ndcHash), ctx);
    } catch (err) {
      toast('Prior authorization status unavailable: ' + errMsg(err), 'error');
    }
  }

  /**
   * This node's admin token, typed on the Onboarding tab. The page holds it in memory only (rpc.js), and the field is
   * cleared once it is set, so the token is never written into the page or into browser storage.
   */
  function initAdminTokenBar() {
    var setBtn = $('#admin-set-token');
    var input = $('#admin-token-input');
    if (!setBtn || !input) return;
    setBtn.addEventListener('click', function () {
      var token = input.value.trim();
      API.setAdminToken(token);
      input.value = '';
      toast(token ? 'Node admin token set for this page' : 'Node admin token cleared', 'info');
      updateCostEstimate();
    });
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
  var formularyCurrentOffset = 0;
  var formularyCurrentFilter = {};
  var formularyTotalDrugs = 0;
  var formularyPageSize = 100;
  var formularyAvailableRoutes = [];

  async function autoLoadFormulary() {
    if (formularyAutoLoaded) return;
    formularyAutoLoaded = true;
    // Load route filter options and categories
    try {
      var routes = await API.getFormularyRoutes();
      if (Array.isArray(routes)) {
        formularyAvailableRoutes = routes;
        var routeSel = $('#form-route-filter');
        if (routeSel) {
          routeSel.innerHTML = '<option value="">All Routes</option>' +
            routes.map(function (r) { return '<option value="' + esc(r.route) + '">' + esc(r.route) + ' (' + r.count + ')</option>'; }).join('');
        }
      }
    } catch (_) { }
    try {
      var rootData = await API.getFormularyRoot();
      if (rootData) {
        formularyTotalDrugs = rootData.drugCount || 0;
        var countEl = $('#form-drug-count');
        if (countEl) countEl.textContent = formularyTotalDrugs.toLocaleString() + ' drugs in formulary';
        var rootEl = $('#form-merkle-root');
        if (rootEl && rootData.formularyRoot) {
          rootEl.innerHTML = '<span class="hash" title="' + esc(rootData.formularyRoot) + '">Merkle Root: ' + esc(rootData.formularyRoot.slice(0, 16)) + '...</span>';
        }
      }
    } catch (_) { }
    formularySearch();
  }

  // Paginated search — called by UI controls
  window._filterFormulary = function (query) {
    formularyCurrentFilter.namePrefix = query || '';
    formularyCurrentOffset = 0;
    formularySearch();
  };

  window._formularySetRoute = function (route) {
    formularyCurrentFilter.route = route || '';
    formularyCurrentOffset = 0;
    formularySearch();
  };

  window._formularySetTier = function (tier) {
    formularyCurrentFilter.tierLevel = tier ? parseInt(tier, 10) : 0;
    formularyCurrentOffset = 0;
    formularySearch();
  };

  window._formularySetClassification = function (cls) {
    formularyCurrentFilter.classification = cls || '';
    formularyCurrentOffset = 0;
    formularySearch();
  };

  window._formularyNextPage = function () {
    formularyCurrentOffset += formularyPageSize;
    formularySearch();
  };

  window._formularyPrevPage = function () {
    formularyCurrentOffset = Math.max(0, formularyCurrentOffset - formularyPageSize);
    formularySearch();
  };

  async function formularySearch() {
    var resultEl = $('#form-result');
    if (!resultEl) return;
    resultEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var params = { offset: formularyCurrentOffset, limit: formularyPageSize };
      if (formularyCurrentFilter.namePrefix) params.namePrefix = formularyCurrentFilter.namePrefix;
      if (formularyCurrentFilter.route) params.route = formularyCurrentFilter.route;
      if (formularyCurrentFilter.tierLevel) params.tierLevel = formularyCurrentFilter.tierLevel;
      if (formularyCurrentFilter.classification) params.classification = formularyCurrentFilter.classification;

      var page = await API.getFormularyPage(params);
      if (!page || !page.drugs) {
        resultEl.innerHTML = '<div class="empty-state">No drugs returned from sequencer</div>';
        return;
      }
      formularyTotalDrugs = page.total || 0;
      renderFormularyTable(page.drugs, page.total, page.offset, page.hasMore);
    } catch (err) {
      resultEl.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  function renderFormularyTable(drugs, total, offset, hasMore) {
    var resultEl = $('#form-result');
    if (!resultEl) return;
    if (!drugs.length) {
      resultEl.innerHTML = '<div class="empty-state">No matching medications</div>';
      return;
    }
    var from = offset + 1;
    var to = offset + drugs.length;
    var paginationHtml = '<div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;font-size:12px;color:var(--text-muted)">' +
      '<span>Showing ' + from + '–' + to + ' of ' + (total || '?').toLocaleString() + ' medications</span>' +
      '<span>' +
      (offset > 0 ? '<button onclick="window._formularyPrevPage()" style="margin-right:8px;cursor:pointer">&laquo; Prev</button>' : '') +
      (hasMore ? '<button onclick="window._formularyNextPage()" style="cursor:pointer">Next &raquo;</button>' : '') +
      '</span></div>';

    resultEl.innerHTML = paginationHtml +
      '<table class="data-table"><thead><tr><th>Drug Name</th><th>NDC</th><th>Strength</th><th>Form</th><th>Route</th><th>Tier</th><th title="The catalog tier copay; a member with a plan pays its plan\'s copay">Tier Copay</th><th>NADAC / Unit</th><th>Proof</th></tr></thead><tbody>' +
      drugs.map(function (d) {
        var name = d.brandName || d.genericName || d.ndc;
        var tierNames = { 1: 'T1 Generic', 2: 'T2 Preferred', 3: 'T3 Non-Pref', 4: 'T4 Specialty' };
        var tierLabel = tierNames[d.tierLevel] || ('T' + d.tierLevel);
        return '<tr>' +
          '<td><strong>' + esc(name) + '</strong>' +
          (d.genericName && d.brandName && d.genericName !== d.brandName ? '<br><small style="color:var(--text-muted)">' + esc(d.genericName) + '</small>' : '') +
          (d.requiresPriorAuth ? '<br><span style="color:var(--warning);font-size:11px">Prior Auth Required</span>' : '') +
          '</td>' +
          '<td><span class="hash" title="' + esc(d.ndc) + '">' + esc(d.ndcFormatted || d.ndc) + '</span></td>' +
          '<td>' + esc(d.strength || '--') + '</td>' +
          '<td>' + esc(d.dosageForm || '--') + '</td>' +
          '<td>' + esc(d.route || '--') + '</td>' +
          '<td><span class="badge tier-' + d.tierLevel + '">' + esc(tierLabel) + '</span></td>' +
          '<td>$' + (d.copayAmount / 100).toFixed(2) + '</td>' +
          '<td>' + (d.nadacPerUnit != null ? '$' + Number(d.nadacPerUnit).toFixed(5) + ' / ' + esc(d.pricingUnit || 'unit') : '--') + '</td>' +
          '<td><button class="btn btn-sm" onclick="window._showWitness(\'' + esc(d.ndcHash) + '\')" title="Show Merkle inclusion proof">Verify</button></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>' + paginationHtml;
  }

  // Show Merkle witness for a drug (proves it exists in the formulary tree)
  window._showWitness = async function (ndcHash) {
    try {
      var data = await API.getFormularyWitness(ndcHash);
      var modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999';
      modal.onclick = function (e) { if (e.target === modal) modal.remove(); };
      var pathHtml = data.witnessPath.map(function (h, i) {
        var dir = data.witnessIsLeft[i] ? 'L' : 'R';
        return '<div style="font-size:11px;font-family:monospace;margin:2px 0"><span style="color:var(--text-muted)">[' + i + '] ' + dir + '</span> ' + h.slice(0, 24) + '...</div>';
      }).join('');
      modal.innerHTML = '<div style="background:var(--bg-secondary);border-radius:12px;padding:24px;max-width:520px;width:90%;max-height:80%;overflow-y:auto">' +
        '<h3 style="margin:0 0 12px">Merkle Inclusion Proof</h3>' +
        '<div style="margin-bottom:8px"><strong>Drug:</strong> ' + esc(data.drug ? data.drug.genericName : ndcHash) + '</div>' +
        '<div style="margin-bottom:8px"><strong>Leaf Index:</strong> ' + esc(data.leafIndex) + '</div>' +
        '<div style="margin-bottom:8px"><strong>Formulary Root:</strong></div>' +
        '<div class="hash" style="font-size:11px;word-break:break-all;margin-bottom:12px">' + esc(data.formularyRoot) + '</div>' +
        '<div style="margin-bottom:4px"><strong>Witness Path (' + data.witnessPath.length + ' nodes):</strong></div>' +
        pathHtml +
        '<div style="margin-top:16px;font-size:11px;color:var(--text-muted)">This 16-hash path proves this drug is committed in the formulary MerkleTree(16). ' +
        'A ZK circuit can verify this witness against the root without revealing the full formulary.</div>' +
        '<button class="btn btn-primary" onclick="this.closest(\'div[style*=fixed]\').remove()" style="margin-top:12px;width:100%">Close</button></div>';
      document.body.appendChild(modal);
    } catch (err) {
      toast('Witness error: ' + err.message, 'error');
    }
  };

  // Legacy lookup kept for backward compat
  async function formularyLookup() {
    formularySearch();
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
      // MessageStoreEntry shape: { message: { senderWalletId, recipientWalletId, threadIdHash, ... }, payload: { ciphertext, iv, tag, timestamp }, leafIndex, leafHash }
      var contactMap = {};
      inbox.forEach(function (entry) {
        var m = entry.message || entry;
        var p = entry.payload || {};
        var key = m.threadIdHash || m.senderWalletId || m.from;
        if (!contactMap[key]) contactMap[key] = { wallet: m.senderWalletId || m.from, threadId: m.threadIdHash, messages: [], lastTime: 0, name: m.senderName || truncHash(m.senderWalletId || m.from, 14) };
        contactMap[key].messages.push(entry);
        var t = p.timestamp || entry.timestamp || 0;
        if (t > contactMap[key].lastTime) contactMap[key].lastTime = t;
      });
      sent.forEach(function (entry) {
        var m = entry.message || entry;
        var p = entry.payload || {};
        var key = m.threadIdHash || m.recipientWalletId || m.to;
        if (!contactMap[key]) contactMap[key] = { wallet: m.recipientWalletId || m.to, threadId: m.threadIdHash, messages: [], lastTime: 0, name: m.recipientName || truncHash(m.recipientWalletId || m.to, 14) };
        contactMap[key].messages.push(entry);
        var t = p.timestamp || entry.timestamp || 0;
        if (t > contactMap[key].lastTime) contactMap[key].lastTime = t;
      });

      msgContacts = Object.values(contactMap).sort(function (a, b) { return b.lastTime - a.lastTime; });

      if (msgContacts.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No conversations yet</div>';
        return;
      }

      listEl.innerHTML = msgContacts.map(function (c, i) {
        var preview = '';
        if (c.messages.length > 0) {
          var lastEntry = c.messages[c.messages.length - 1];
          var lp = lastEntry.payload || {};
          preview = decodePayload(lp.ciphertext, lp.iv);
        }
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

      messagesEl.innerHTML = messages.map(function (entry) {
        var m = entry.message || entry;
        var p = entry.payload || {};
        var isOutgoing = (m.senderWalletId || m.from) === walletId;
        var body = decodePayload(p.ciphertext, p.iv);
        return '<div class="msg-bubble ' + (isOutgoing ? 'outgoing' : 'incoming') + '">' +
          '<div>' + esc(body) + '</div>' +
          '<div class="msg-bubble-time">' + fmtTime(p.timestamp || entry.timestamp) + '</div>' +
          '</div>';
      }).join('');

      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      messagesEl.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
  }

  var _sendingMessage = false;
  async function sendThreadMessage() {
    if (!msgActiveThread) return;
    if (_sendingMessage) return; // prevent double-send from Enter + click
    var input = $('#msg-input-text');
    var body = input.value.trim();
    if (!body) return;
    _sendingMessage = true;

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
    } finally {
      _sendingMessage = false;
    }
  }

  async function sendComposeMessage() {
    var recipient = $('#msg-compose-recipient').value.trim();
    var body = $('#msg-compose-body').value.trim();
    if (!recipient) { toast('Recipient wallet ID is required', 'error'); return; }
    if (!body) { toast('Message body is required', 'error'); return; }
    if (_sendingMessage) return; // prevent double-send
    _sendingMessage = true;

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
    } finally {
      _sendingMessage = false;
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
      var loc = p.city ? (p.city + ', ' + p.state) : p.state;
      return '<option value="' + p.npi + '"' + (p.npi === current.npi ? ' selected' : '') + '>' +
        esc(p.name) + ', ' + esc(p.credential) + ' — ' + esc(p.specialty) + ' (' + esc(loc) + ')' +
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
      // navigate() sets the hash itself, and the hashchange that follows names the tab it just opened: entering that
      // tab again would load it twice.
      if (hash !== currentTab) navigate(hash);
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
    if (rxMedSel) rxMedSel.addEventListener('change', function () { if (rxMedSel.value) rxNdcManual.value = ''; updateCostEstimate(); });
    if (rxNdcManual) rxNdcManual.addEventListener('input', function () { if (rxNdcManual.value.trim()) rxMedSel.value = ''; updateCostEstimate(); });

    // Cost estimate on patient/drug/quantity change
    var rxPatientSel = $('#rx-patient-select');
    var rxQtyInput = $('#rx-quantity');
    if (rxPatientSel) rxPatientSel.addEventListener('change', updateCostEstimate);
    if (rxQtyInput) rxQtyInput.addEventListener('change', updateCostEstimate);

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

    // Proofs
    var proofRegBtn = $('#proof-reg-btn');
    if (proofRegBtn) proofRegBtn.addEventListener('click', generateRegistrationProof);

    var proofRefresh = $('#proof-refresh-btn');
    if (proofRefresh) proofRefresh.addEventListener('click', loadProofTimings);
  }

  // ── Init ─────────────────────────────────────────────────────

  async function loadPrescriberList() {
    try {
      var res = await fetch(location.origin + '/prescribers/list');
      var json = await res.json();
      if (json.ok && Array.isArray(json.data)) {
        PRESCRIBERS = json.data;
      }
    } catch (_) { /* server not ready — PRESCRIBERS stays empty */ }
  }

  async function init() {
    await loadPrescriberList();
    initPrescriberSelector();
    initBadgeTap();
    bindEvents();
    initAdminTokenBar();

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
