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
 * zkpCare Employer Marketplace — SPA Application
 *
 * 4 screens: Browse Plans → Apply → Sign Agreement → Activate
 * Ed25519 keypair generated in-browser via WebCrypto.
 * No framework — vanilla JS matching existing dashboard patterns.
 */
(() => {
  'use strict';

  var app = document.getElementById('app');
  var navLinks = document.querySelectorAll('.nav-link');
  var currentScreen = 'browse';

  // State (applicationId + applicationStatus persisted to survive refresh)
  var plans = [];
  var selectedPlanIds = [];
  var applicationId = localStorage.getItem('zkmp_applicationId') || null;
  var applicationStatus = localStorage.getItem('zkmp_applicationStatus') || null;
  /*
   * A8: the one-time activation secret, used to collect the employer's admin credentials.
   *
   * sessionStorage rather than localStorage on purpose. It is needed only between submitting the
   * application and collecting the token, which is one sitting, and a secret that survives the
   * tab outlives its own usefulness. If the tab is closed in between, the employer re-enters the
   * activation code they were told to save, which is the same recovery path as the application
   * ID already had.
   */
  var claimSecret = sessionStorage.getItem('zkmp_claimSecret') || '';
  var keypair = null; // { publicKeyHex, privateKey (CryptoKey) } — NOT persisted (CryptoKey is non-exportable)
  var agreementData = null; // { terms, commitment, documentHash, canonicalMessage }

  function persistState() {
    if (applicationId) {
      localStorage.setItem('zkmp_applicationId', applicationId);
    } else {
      localStorage.removeItem('zkmp_applicationId');
    }
    if (applicationStatus) {
      localStorage.setItem('zkmp_applicationStatus', applicationStatus);
    } else {
      localStorage.removeItem('zkmp_applicationStatus');
    }
    try {
      if (claimSecret) sessionStorage.setItem('zkmp_claimSecret', claimSecret);
      else sessionStorage.removeItem('zkmp_claimSecret');
    } catch (e) { /* private mode — the employer re-enters the code instead */ }
  }

  // ─── Helpers ──────────────────────────────────────────────

  // Normalize a value into a safe error message string (avoids "[object Object]")
  function errMsg(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.error === 'string') return e.error;
    if (e.error && typeof e.error.message === 'string') return e.error.message;
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

  function esc(s) { if (s == null) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function fmtCents(c) { return '$' + (c / 100).toFixed(2); }

  function toast(msg, type) {
    var c = document.getElementById('toast-container');
    while (c.children.length >= 8) c.removeChild(c.firstChild);
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(function() { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(function() { el.remove(); }, 300); }, 4000);
  }

  function loading() { return '<div class="loading"><span class="spinner"></span> Loading...</div>'; }

  async function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    var res = await fetch(path, opts);
    var data = await res.json();
    if (!data.ok) throw new Error(errMsg(data.error) || 'Request failed');
    return data.data;
  }

  function stepBar(active) {
    var steps = ['Browse', 'Apply', 'Agreement', 'Activate'];
    var ids = ['browse', 'apply', 'sign', 'activate'];
    var idx = ids.indexOf(active);
    var maxStage = getMaxStage();
    return '<div class="steps">' + steps.map(function(s, i) {
      var cls = i < idx ? 'step done' : (i === idx ? 'step active' : (i > maxStage ? 'step locked' : 'step'));
      var num = i < idx ? '&#10003;' : (i > maxStage ? '&#128274;' : (i + 1));
      return '<div class="' + cls + '"><div class="step-number">' + num + '</div><div class="step-label">' + esc(s) + '</div></div>';
    }).join('') + '</div>';
  }

  // ─── Router (stage-gated) ──────────────────────────────────

  /** Determine the furthest stage the user can reach based on current state */
  function getMaxStage() {
    if (applicationStatus === 'active') return 3;         // activate
    if (applicationStatus === 'signed') return 3;         // activate
    if (applicationId) return 2;                          // sign (agreement/status check)
    if (selectedPlanIds.length > 0) return 1;             // apply
    return 0;                                             // browse only
  }

  var stageOrder = ['browse', 'apply', 'sign', 'activate'];

  function updateNavState() {
    var maxStage = getMaxStage();
    navLinks.forEach(function(l) {
      var stage = stageOrder.indexOf(l.dataset.tab);
      var reachable = stage <= maxStage;
      l.classList.toggle('active', l.dataset.tab === currentScreen);
      l.classList.toggle('disabled', !reachable);
      l.style.opacity = reachable ? '1' : '0.4';
      l.style.pointerEvents = reachable ? 'auto' : 'none';
    });
  }

  function navigate(screen) {
    var target = screen || 'browse';
    var targetStage = stageOrder.indexOf(target);
    var maxStage = getMaxStage();

    // Gate: cannot skip ahead beyond what state allows
    if (targetStage > maxStage) {
      var gateMessages = [
        'Select at least one plan first.',
        'Submit your application first.',
        'Your application must be signed before activation.'
      ];
      toast(gateMessages[maxStage] || 'Complete the previous step first.', 'error');
      return;
    }

    currentScreen = target;
    window.scrollTo(0, 0);
    updateNavState();
    render();
  }

  window.addEventListener('hashchange', function() {
    navigate(location.hash.replace('#', '') || 'browse');
  });

  function render() {
    switch (currentScreen) {
      case 'browse': renderBrowse(); break;
      case 'apply': renderApply(); break;
      case 'sign': renderSign(); break;
      case 'activate': renderActivate(); break;
      default: renderBrowse();
    }
  }

  // ════════════════════════════════════════════════════════════
  //  BROWSE PLANS
  // ════════════════════════════════════════════════════════════

  async function renderBrowse() {
    app.innerHTML = stepBar('browse') +
      (applicationId ? '<div class="info-banner info" style="display:flex;align-items:center;justify-content:space-between">' +
        '<span>You have an active application: <strong>' + esc(applicationId) + '</strong> (' + esc(applicationStatus || 'unknown') + ')</span>' +
        '<button class="btn btn-sm" id="btn-resume-app" style="margin-left:12px">Resume</button>' +
        '<button class="btn btn-sm" id="btn-start-over" style="margin-left:8px;color:var(--red)">Start Over</button></div>' : '') +
      '<div class="section-header"><div class="section-title">Choose a Health Plan</div>' +
      '<div class="section-subtitle">Transparent NADAC pricing. No rebates. No spread. Your employees pay the real cost.</div></div>' +
      '<div class="plans-grid" id="plans-grid">' + loading() + '</div>';

    // Wire resume / start-over buttons
    var resumeBtn = document.getElementById('btn-resume-app');
    if (resumeBtn) resumeBtn.onclick = function() {
      if (applicationStatus === 'signed' || applicationStatus === 'active') navigate('activate');
      else navigate('sign');
    };
    var startOverBtn = document.getElementById('btn-start-over');
    if (startOverBtn) startOverBtn.onclick = function() {
      applicationId = null;
      applicationStatus = null;
      selectedPlanIds = [];
      keypair = null;
      agreementData = null;
      persistState();
      updateNavState();
      renderBrowse();
      toast('Application cleared. Select plans to start a new application.', 'info');
    };

    try {
      plans = await api('GET', '/marketplace/api/plans');
      renderPlanCards();
    } catch (e) {
      document.getElementById('plans-grid').innerHTML = '<div class="info-banner warning">Could not load plans. The insurer node may be starting up.</div>';
    }
  }

  function renderPlanCards() {
    var grid = document.getElementById('plans-grid');
    if (!grid) return;
    if (plans.length === 0) {
      grid.innerHTML = '<div class="info-banner info">No plans published yet. Check back soon.</div>';
      return;
    }
    grid.innerHTML = plans.map(function(p) {
      var coverageLabels = { 1: 'Pharmacy', 2: 'Medical', 3: 'Dental' };
      var selected = selectedPlanIds.indexOf(p.planId) !== -1;
      return '<div class="plan-card' + (selected ? ' selected' : '') + '" data-plan="' + esc(p.planId) + '">' +
        '<div class="plan-name">' + esc(p.name) + '</div>' +
        '<div class="plan-type">' + esc(coverageLabels[p.coverageType] || 'Pharmacy') + ' Coverage</div>' +
        '<div class="plan-price">' + esc(fmtCents(p.copayAmountCents)) + ' <span>base copay</span></div>' +
        '<div class="plan-detail"><span class="plan-detail-label">Deductible</span><span class="plan-detail-value">' + esc(fmtCents(p.deductibleAmountCents)) + '</span></div>' +
        '<div class="plan-detail"><span class="plan-detail-label">Out-of-Pocket Max</span><span class="plan-detail-value">' + esc(fmtCents(p.oopMaxCents)) + '</span></div>' +
        '<div class="plan-detail"><span class="plan-detail-label">Annual Benefit Max</span><span class="plan-detail-value">' + esc(fmtCents(p.annualBenefitMaxCents)) + '</span></div>' +
        '<div class="plan-detail"><span class="plan-detail-label">Family Deductible</span><span class="plan-detail-value">' + esc(fmtCents(p.familyDeductibleAmountCents)) + '</span></div>' +
        '<div class="plan-detail"><span class="plan-detail-label">Family OOP Max</span><span class="plan-detail-value">' + esc(fmtCents(p.familyOopMaxCents)) + '</span></div>' +
        '<div class="plan-select-btn">' + (selected ? 'Selected' : 'Select This Plan') + '</div>' +
      '</div>';
    }).join('');

    grid.querySelectorAll('.plan-card').forEach(function(card) {
      card.onclick = function() {
        var pid = card.dataset.plan;
        var idx = selectedPlanIds.indexOf(pid);
        if (idx === -1) { selectedPlanIds.push(pid); } else { selectedPlanIds.splice(idx, 1); }
        renderPlanCards();
      };
    });

    if (selectedPlanIds.length > 0) {
      grid.innerHTML += '<div style="grid-column:1/-1;text-align:center;padding:20px">' +
        '<button class="btn btn-primary btn-lg" id="btn-to-apply">' + selectedPlanIds.length + ' plan' + (selectedPlanIds.length > 1 ? 's' : '') + ' selected — Continue to Application</button></div>';
      document.getElementById('btn-to-apply').onclick = function() { navigate('apply'); };
    }
  }

  // ════════════════════════════════════════════════════════════
  //  APPLY
  // ════════════════════════════════════════════════════════════

  async function renderApply() {
    if (selectedPlanIds.length === 0) {
      toast('Select at least one plan first.', 'error');
      navigate('browse');
      return;
    }
    var planLabels = selectedPlanIds.map(function(pid) {
      var p = plans.find(function(x) { return x.planId === pid; });
      return p ? p.name : pid;
    }).join(', ');

    app.innerHTML = stepBar('apply') +
      '<div class="section-header"><div class="section-title">Employer Application</div>' +
      '<div class="section-subtitle">Fill in your company details. Your application will be reviewed and approved.</div></div>' +
      (selectedPlanIds.length > 0 ? '<div class="info-banner info">Selected plans: ' + esc(planLabels) + '</div>' : '') +
      '<div class="card"><div class="card-body">' +
        '<div class="form-grid">' +
          fg('app-company', 'Company Name', 'text', 'e.g. Acme Corporation') +
          fg('app-employer-id', 'Employer ID', 'text', 'e.g. ACME-CORP (letters, numbers, hyphens)') +
          fg('app-contact', 'Contact Name', 'text', 'Primary contact for benefits') +
          fg('app-email', 'Contact Email', 'email', 'benefits@acme.com') +
          fg('app-phone', 'Phone (optional)', 'tel', '555-123-4567') +
          fg('app-ein', 'EIN', 'text', 'XX-XXXXXXX (required)') +
          fg('app-state', 'State of Incorporation', 'text', 'e.g. CA, NY, TX') +
          fg('app-industry', 'Industry (optional)', 'text', 'e.g. Technology, Healthcare') +
          fg('app-effective', 'Effective Date', 'date', '') +
          fg('app-cap', 'Enrollment Cap', 'number', 'Max employees') +
          '<div class="form-group"><label for="app-plan-type">Plan Type</label>' +
            '<select id="app-plan-type"><option value="erisa">ERISA (most common)</option><option value="government">Government Plan</option><option value="church">Church Plan</option><option value="other">Other</option></select></div>' +
        '</div>' +
        '<div style="margin-top:24px;padding:16px;background:var(--accent-light);border-radius:var(--radius-sm)">' +
          '<div style="font-weight:600;margin-bottom:8px">Security Key</div>' +
          '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">A cryptographic key pair will be generated in your browser. This key proves your identity when connecting your employer node.</div>' +
          '<div id="key-status" style="font-size:13px;color:var(--text-muted)">Key will be generated when you submit.</div>' +
        '</div>' +
        '<div class="form-actions" style="margin-top:24px">' +
          '<button class="btn btn-primary btn-lg" id="btn-submit-app">Submit Application</button>' +
          '<span id="app-status" style="font-size:13px;color:var(--text-muted)"></span>' +
        '</div>' +
      '</div></div>';

    // Set default effective date to 1 month from now
    var d = new Date(); d.setMonth(d.getMonth() + 1);
    var effEl = document.getElementById('app-effective');
    if (effEl) effEl.value = d.toISOString().slice(0, 10);

    document.getElementById('btn-submit-app').onclick = doSubmitApplication;

    // Phase B: live-validate the employerId as the user types.
    // Debounced to avoid hammering the sequencer on every keystroke.
    var employerIdInput = document.getElementById('app-employer-id');
    var employerIdErr = document.getElementById('app-employer-id-err');
    var checkTimer = null;
    var lastCheckedId = null;
    if (employerIdInput) {
      employerIdInput.addEventListener('input', function() {
        if (checkTimer) clearTimeout(checkTimer);
        var val = employerIdInput.value.trim();
        if (employerIdErr) { employerIdErr.textContent = ''; employerIdErr.style.color = ''; }
        if (!val) return;
        if (!/^[A-Za-z0-9_-]{2,64}$/.test(val)) {
          if (employerIdErr) {
            employerIdErr.textContent = 'Must be 2-64 chars: letters, numbers, hyphens, underscores';
            employerIdErr.style.color = 'var(--red)';
          }
          return;
        }
        checkTimer = setTimeout(async function() {
          if (val === lastCheckedId) return;
          lastCheckedId = val;
          try {
            var resp = await fetch('/marketplace/api/check-employer-id/' + encodeURIComponent(val));
            var data = await resp.json();
            if (employerIdInput.value.trim() !== val) return; // user typed more — ignore stale result
            if (data && data.ok && data.data) {
              if (data.data.available) {
                if (employerIdErr) {
                  employerIdErr.textContent = '✓ Available';
                  employerIdErr.style.color = 'var(--green)';
                }
              } else {
                if (employerIdErr) {
                  employerIdErr.textContent = data.data.reason || 'Not available';
                  employerIdErr.style.color = 'var(--red)';
                }
              }
            }
          } catch (_) { /* network error — ignore silently, the apply endpoint will catch it */ }
        }, 400);
      });
    }
  }

  function fg(id, label, type, placeholder) {
    return '<div class="form-group"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="' + type + '" id="' + id + '" placeholder="' + esc(placeholder || '') + '">' +
      '<span class="field-error" id="' + id + '-err"></span></div>';
  }

  async function doSubmitApplication() {
    var btn = document.getElementById('btn-submit-app');
    var status = document.getElementById('app-status');
    btn.disabled = true;
    status.textContent = 'Generating security key...';

    try {
      // Generate Ed25519 keypair in browser
      keypair = await generateKeypair();
      document.getElementById('key-status').innerHTML = '<span style="color:var(--green)">Key generated. Public key: ' + esc(keypair.publicKeyHex.slice(0, 16)) + '...</span>';
      status.textContent = 'Submitting application...';

      var body = {
        companyName: v('app-company'),
        employerId: v('app-employer-id'),
        contactName: v('app-contact'),
        contactEmail: v('app-email'),
        contactPhone: v('app-phone') || undefined,
        ein: v('app-ein'),
        state: v('app-state'),
        industry: v('app-industry') || undefined,
        planType: document.getElementById('app-plan-type') ? document.getElementById('app-plan-type').value : 'erisa',
        selectedPlanIds: selectedPlanIds,
        effectiveDate: v('app-effective'),
        enrollmentCap: parseInt(v('app-cap'), 10) || 100,
        publicKeyHex: keypair.publicKeyHex,
      };

      if (!body.companyName || !body.employerId || !body.contactName || !body.contactEmail || !body.ein || !body.state || !body.effectiveDate) {
        throw new Error('Please fill in all required fields (including EIN)');
      }
      // EIN format validation: XX-XXXXXXX
      if (!/^\d{2}-?\d{7}$/.test(body.ein)) {
        throw new Error('EIN must be in format XX-XXXXXXX (9 digits)');
      }

      var result = await api('POST', '/marketplace/api/apply', body);
      applicationId = result.applicationId;
      applicationStatus = 'submitted';
      // A8: everything after the first dot is the secret; the identifier is before it.
      var code = result.activationCode || '';
      claimSecret = code.indexOf('.') >= 0 ? code.slice(code.indexOf('.') + 1) : '';
      persistState();

      if (code) {
        alert([
          'Save your activation code now. It is shown once and cannot be recovered.',
          '',
          code,
          '',
          'You will need it to collect your administrator credentials after provisioning.',
        ].join(String.fromCharCode(10)));
      }
      toast('Application submitted! ID: ' + applicationId, 'success');
      status.textContent = '';
      navigate('sign');
    } catch (e) {
      toast(e.message, 'error');
      status.textContent = '';
    } finally {
      btn.disabled = false;
    }
  }

  function v(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  // ─── WebCrypto Ed25519 ────────────────────────────────────

  async function generateKeypair() {
    try {
      var kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    } catch (e) {
      throw new Error('Your browser does not support Ed25519 keys. Please use Chrome 113+, Edge 113+, or Firefox 125+.');
    }
    var spkiDer = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
    // SPKI DER prefix for Ed25519 is 12 bytes: 302a300506032b6570032100
    var rawPub = spkiDer.subarray(12);
    var publicKeyHex = Array.from(rawPub).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    return { publicKeyHex: publicKeyHex, privateKey: kp.privateKey };
  }

  /** Re-generate a keypair (for recovery after browser refresh) */
  async function regenerateKeypair() {
    keypair = await generateKeypair();
    return keypair;
  }

  async function signMessage(message) {
    if (!keypair || !keypair.privateKey) throw new Error('No signing key. Please generate a new key first.');
    var msgBytes = new TextEncoder().encode(message);
    var sigBuffer = await crypto.subtle.sign('Ed25519', keypair.privateKey, msgBytes);
    return Array.from(new Uint8Array(sigBuffer)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // ════════════════════════════════════════════════════════════
  //  SIGN AGREEMENT
  // ════════════════════════════════════════════════════════════

  async function renderSign() {
    app.innerHTML = stepBar('sign') +
      '<div class="section-header"><div class="section-title">Agreement</div>' +
      '<div class="section-subtitle">Review and digitally sign your benefit plan agreement.</div></div>';

    if (!applicationId) {
      app.innerHTML += '<div class="card"><div class="card-body">' +
        '<div class="form-group"><label for="sign-appid">Application ID</label>' +
        '<input type="text" id="sign-appid" placeholder="Enter your application ID (e.g. EMPAPP-...)"></div>' +
        '<div class="form-actions"><button class="btn btn-primary" id="btn-check-status">Check Status</button></div>' +
        '</div></div>';
      document.getElementById('btn-check-status').onclick = async function() {
        applicationId = v('sign-appid');
        if (!applicationId) { toast('Enter your application ID', 'error'); return; }
        persistState();
        renderSign();
      };
      return;
    }

    app.innerHTML += '<div id="sign-content">' + loading() + '</div>';

    try {
      var status = await api('GET', '/marketplace/api/status/' + encodeURIComponent(applicationId));
      applicationStatus = status.status;
      persistState();

      if (status.status === 'submitted' || status.status === 'under_review') {
        document.getElementById('sign-content').innerHTML =
          '<div class="card"><div class="card-body" style="text-align:center;padding:48px">' +
          '<div class="badge badge-yellow" style="font-size:14px;padding:6px 16px;margin-bottom:16px">' + esc(status.status) + '</div>' +
          '<div style="font-size:18px;font-weight:600;margin-bottom:8px">Application Under Review</div>' +
          '<div style="color:var(--text-secondary)">Your application for ' + esc(status.companyName) + ' is being reviewed. Check back soon.</div>' +
          '<div style="margin-top:16px;font-size:13px;color:var(--text-muted)">Application ID: ' + esc(applicationId) + '</div>' +
          '</div></div>';
        return;
      }

      if (status.status === 'needs_documents') {
        document.getElementById('sign-content').innerHTML =
          '<div class="card"><div class="card-body" style="text-align:center;padding:48px">' +
          '<div class="badge badge-yellow" style="font-size:14px;padding:6px 16px;margin-bottom:16px">Documents Required</div>' +
          '<div style="font-size:18px;font-weight:600;margin-bottom:8px">Please Upload Your IRS CP 575 Letter</div>' +
          '<div style="color:var(--text-secondary);margin-bottom:20px">Your EIN assignment letter (CP 575) or verification letter (147C) is required to verify your business identity.</div>' +
          '<div style="margin-bottom:16px"><input type="file" id="cp575-upload" accept=".pdf" style="display:none"><button class="btn btn-primary" id="btn-upload-cp575">Upload CP 575 (PDF)</button></div>' +
          '<div id="upload-status" style="font-size:13px;color:var(--text-muted)"></div>' +
          '<div style="margin-top:16px;font-size:12px;color:var(--text-muted)">Can\'t find your CP 575? Call the IRS at 800-829-4933 to request a 147C verification letter.</div>' +
          '</div></div>';
        document.getElementById('btn-upload-cp575').onclick = function() { document.getElementById('cp575-upload').click(); };
        document.getElementById('cp575-upload').onchange = async function() {
          var file = this.files[0];
          if (!file) return;
          if (!file.name.toLowerCase().endsWith('.pdf')) { toast('Only PDF files accepted', 'error'); return; }
          if (file.size > 5 * 1024 * 1024) { toast('File too large (max 5MB)', 'error'); return; }
          var statusEl = document.getElementById('upload-status');
          statusEl.textContent = 'Uploading...';
          try {
            var buf = await file.arrayBuffer();
            var resp = await fetch('/marketplace/api/upload-document/' + encodeURIComponent(applicationId), {
              method: 'POST', body: buf, headers: { 'Content-Type': 'application/pdf' },
            });
            var data = await resp.json();
            if (data.ok) { toast('Document uploaded. Your application is under review.', 'success'); renderSign(); }
            else { var uploadErr = errMsg(data.error) || 'Upload failed'; toast(uploadErr, 'error'); statusEl.textContent = uploadErr; }
          } catch (e) { toast('Upload failed: ' + e.message, 'error'); statusEl.textContent = ''; }
        };
        return;
      }

      if (status.status === 'denied') {
        document.getElementById('sign-content').innerHTML =
          '<div class="card"><div class="card-body" style="text-align:center;padding:48px">' +
          '<div class="badge badge-red" style="font-size:14px;padding:6px 16px;margin-bottom:16px">Denied</div>' +
          '<div style="font-size:18px;font-weight:600;margin-bottom:8px">Application Denied</div>' +
          '<div style="color:var(--text-secondary)">' + esc(status.denialReason || 'No reason provided') + '</div>' +
          '</div></div>';
        return;
      }

      if (status.status === 'signed' || status.status === 'active') {
        document.getElementById('sign-content').innerHTML =
          '<div class="info-banner success">Agreement already signed. Proceed to activation.</div>' +
          '<div class="form-actions"><button class="btn btn-primary btn-lg" id="btn-to-activate">Continue to Activation</button></div>';
        document.getElementById('btn-to-activate').onclick = function() { navigate('activate'); };
        return;
      }

      // Status is 'approved' — show agreement
      agreementData = await api('GET', '/marketplace/api/agreement/' + encodeURIComponent(applicationId));
      renderAgreement();

    } catch (e) {
      document.getElementById('sign-content').innerHTML = '<div class="info-banner warning">' + esc(e.message) + '</div>';
    }
  }

  function renderAgreement() {
    if (!agreementData) return;
    var t = agreementData.terms;
    var el = document.getElementById('sign-content');

    el.innerHTML =
      '<div class="card"><div class="card-header"><div class="card-title">Employer Benefit Plan Agreement</div>' +
      '<div class="card-subtitle">' + esc(t.insurerName) + ' &mdash; ' + esc(t.companyName) + '</div></div><div class="card-body">' +

      '<div class="agreement-section"><h3>1. Parties</h3>' +
      '<p>This Agreement is between <strong>' + esc(t.insurerName) + '</strong> ("Insurer") and <strong>' + esc(t.companyName) + '</strong> ("Employer"), ID: ' + esc(t.employerId) + '.</p>' +
      '<p>Effective Date: ' + esc(t.effectiveDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) + ' | Enrollment Cap: ' + esc(t.enrollmentCap) + ' members</p></div>' +

      '<div class="agreement-section"><h3>2. Benefit Plans</h3>' +
      '<table class="agreement-table"><thead><tr><th>Plan</th><th>Copay</th><th>Deductible</th><th>OOP Max</th><th>Annual Max</th></tr></thead><tbody>' +
      t.selectedPlans.map(function(p) {
        return '<tr><td>' + esc(p.planName) + '</td><td>' + esc(fmtCents(p.copayAmountCents)) + '</td><td>' + esc(fmtCents(p.deductibleAmountCents)) + '</td><td>' + esc(fmtCents(p.oopMaxCents)) + '</td><td>' + esc(fmtCents(p.annualBenefitMaxCents)) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +

      '<div class="agreement-section"><h3>3. Terms</h3>' +
      '<p>All drug pricing follows the <strong>NADAC Transparent Pricing</strong> model. No rebates, clawbacks, or spread pricing.</p>' +
      '<p>Either party may terminate with 30 days written notice.</p></div>' +

      '<div class="agreement-section" id="agreement-scroll-container" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-bottom:16px">' +
        '<h3>4. Business Associate Agreement</h3>' +
        '<p>Executed per HIPAA 45 CFR §164.504(e). Includes: permitted uses, safeguards, breach notification (60 days), subcontractor requirements, access rights, amendment, accounting, HHS access, termination provisions.</p>' +
        '<h3>5. ERISA §408(b)(2) Fee Disclosure</h3>' +
        '<p>Per-claim administrative fee only. NADAC pricing methodology. No rebates retained. No spread pricing. Annual audit rights with 2-year lookback.</p>' +
        '<h3>6. Representations, Warranties, and Indemnification</h3>' +
        '<p>Signer represents authority to bind the Employer. Personal indemnification for unauthorized execution.</p>' +
        '<h3>7. State-Specific Provisions</h3>' +
        '<p>MAC pricing appeal rights. Annual audit rights. Spread pricing prohibition. Rebate pass-through attestation.</p>' +
        '<h3>8. Claims Appeals and Grievance Procedure</h3>' +
        '<p>Per ERISA §503: 60-day appeal window, independent reviewer, 30-day decision, external review option.</p>' +
        '<h3>9. Cryptographic Binding</h3>' +
        '<p>Agreement Commitment:</p><div class="commitment-block">' + esc(agreementData.commitment) + '</div>' +
        '<p>Document Hash:</p><div class="commitment-block">' + esc(agreementData.documentHash) + '</div>' +
      '</div>' +
      '<div id="scroll-notice" style="font-size:12px;color:var(--text-muted);margin-bottom:16px">Please scroll to the bottom of the agreement above to enable signing.</div>' +

      '<div class="agreement-section"><h3>10. Officer Attestation</h3>' +
      '<div class="form-grid" style="margin-bottom:16px">' +
        '<div class="form-group"><label for="signer-name">Full Legal Name</label><input type="text" id="signer-name" placeholder="e.g. Jane Smith"></div>' +
        '<div class="form-group"><label for="signer-title">Title</label><select id="signer-title"><option value="">Select title...</option><option value="CEO">CEO</option><option value="CFO">CFO</option><option value="VP of HR">VP of HR</option><option value="Benefits Director">Benefits Director</option><option value="Authorized Representative">Authorized Representative</option></select></div>' +
      '</div>' +
      '<div style="margin-bottom:16px"><label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:14px">' +
        '<input type="checkbox" id="attest-checkbox" style="margin-top:3px">' +
        '<span>I, the undersigned, am an authorized representative of <strong>' + esc(t.companyName) + '</strong> with full authority to bind the organization to this agreement. I have reviewed the terms in their entirety. I understand this digital signature is legally binding under the ESIGN Act (15 USC §7001).</span>' +
      '</label></div>' +

      (keypair ? '<div class="info-banner success" style="margin-bottom:12px">Signing key loaded.</div>' :
        '<div class="info-banner warning" style="margin-bottom:12px">Signing key lost (browser refresh). <button class="btn btn-primary" id="btn-regen-key" style="margin-left:8px">Generate New Key</button></div>') +
      '<div class="form-actions">' +
        '<button class="btn btn-primary btn-lg" id="btn-sign" disabled>Sign Agreement</button>' +
        '<span id="sign-status" style="font-size:13px;color:var(--text-muted)"></span>' +
      '</div></div>' +

      '</div></div>';

    // Scroll confirmation: track when user scrolls to bottom
    var scrolled = false;
    var scrollContainer = document.getElementById('agreement-scroll-container');
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', function() {
        if (scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 10) {
          scrolled = true;
          var notice = document.getElementById('scroll-notice');
          if (notice) notice.textContent = 'Agreement reviewed.';
          checkSignReady();
        }
      });
      // If content doesn't overflow (short agreement), mark as scrolled
      if (scrollContainer.scrollHeight <= scrollContainer.clientHeight) {
        scrolled = true;
        var notice = document.getElementById('scroll-notice');
        if (notice) notice.textContent = 'Agreement reviewed.';
      }
    }

    // Enable sign button only when all conditions met
    function checkSignReady() {
      var nameOk = !!document.getElementById('signer-name')?.value?.trim();
      var titleOk = !!document.getElementById('signer-title')?.value;
      var attestOk = !!document.getElementById('attest-checkbox')?.checked;
      var btn = document.getElementById('btn-sign');
      if (btn) btn.disabled = !(scrolled && nameOk && titleOk && attestOk && keypair);
    }

    // Attach change listeners
    ['signer-name', 'signer-title', 'attest-checkbox'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', checkSignReady);
      if (el) el.addEventListener('input', checkSignReady);
    });

    if (keypair) {
      document.getElementById('btn-sign').onclick = doSign;
      checkSignReady();
    }

    var regenBtn = document.getElementById('btn-regen-key');
    if (regenBtn) regenBtn.onclick = async function() {
      try {
        keypair = await regenerateKeypair();
        // Auto-rekey: update the public key on the application so signature verification works
        await api('POST', '/employer-applications/' + encodeURIComponent(applicationId) + '/rekey', {
          publicKeyHex: keypair.publicKeyHex,
        });
        toast('New key generated and registered.', 'success');
        // Phase 1.1: Call renderSign() (not renderAgreement()) so the agreement is refetched
        // from the server — this repopulates the backend agreementCache which /rekey deleted.
        renderSign();
      } catch (e) {
        toast('Key regenerated but rekey failed: ' + e.message + '. Ask insurer admin to rekey manually.', 'error');
        renderSign();
      }
    };
  }

  async function doSign() {
    var btn = document.getElementById('btn-sign');
    var status = document.getElementById('sign-status');
    btn.disabled = true;
    status.textContent = 'Signing agreement...';

    var signerName = document.getElementById('signer-name').value.trim();
    var signerTitle = document.getElementById('signer-title').value;

    try {
      // Phase 1.2: Defensive refetch — guarantees the backend agreementCache is populated
      // and the frontend agreementData matches exactly what the server will verify against.
      // Protects against cache eviction, insurer restart mid-flow, or any stale state.
      status.textContent = 'Refreshing agreement...';
      agreementData = await api('GET', '/marketplace/api/agreement/' + encodeURIComponent(applicationId));
      status.textContent = 'Signing agreement...';

      // Build the final canonical message WITH signer name + title appended
      var canonicalWithSigner = agreementData.canonicalMessage + '|' + signerName + '|' + signerTitle;
      var signature = await signMessage(canonicalWithSigner);
      status.textContent = 'Registering attestation...';

      var result = await api('POST', '/marketplace/api/sign/' + encodeURIComponent(applicationId), {
        employerSignature: signature,
        ts: agreementData.ts,
        signerName: signerName,
        signerTitle: signerTitle,
        reviewedAt: Date.now(),
      });

      toast('Agreement signed and registered!', 'success');
      applicationStatus = 'signed';
      persistState();
      navigate('activate');
    } catch (e) {
      toast('Signing failed: ' + e.message, 'error');
      status.textContent = '';
      btn.disabled = false;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  ACTIVATE
  // ════════════════════════════════════════════════════════════

  async function renderActivate() {
    if (!applicationId) {
      toast('Submit and sign your application first.', 'error');
      navigate('browse');
      return;
    }
    if (applicationStatus && applicationStatus !== 'signed' && applicationStatus !== 'active') {
      toast('Your agreement must be signed before activation.', 'error');
      navigate('sign');
      return;
    }

    app.innerHTML = stepBar('activate') +
      '<div class="section-header"><div class="section-title">Activate Your Employer Node</div>' +
      '<div class="section-subtitle">Your agreement is signed. Set up your employer node to start enrolling employees.</div></div>' +
      '<div id="activate-content">' + loading() + '</div>';

    // The activate screen may take 10-90 seconds (child process spawn + ZK
    // attestation load + HR Tool boot). The backend returns 202 immediately
    // with a jobKey and we poll /activate-status/:jobKey every 2s until done.
    document.getElementById('activate-content').innerHTML =
      '<div class="info-banner info" id="activate-progress">Provisioning your employer node and HR Tool... this takes up to a minute.</div>' +
      '<div class="spinner" style="margin:24px auto;width:40px;height:40px"></div>';

    try {
      // Kick off the spawn (202 returned immediately)
      var kickoff = await api('POST', '/marketplace/api/activate/' + encodeURIComponent(applicationId));
      var jobKey = kickoff.jobKey || applicationId;

      // Poll for completion
      var config = null;
      var maxPolls = 60; // 60 * 2s = 120s max
      for (var i = 0; i < maxPolls; i++) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        var status = await api('GET', '/marketplace/api/activate-status/' + encodeURIComponent(jobKey));
        var progressEl = document.getElementById('activate-progress');
        if (status.status === 'complete') {
          config = status;
          break;
        }
        if (status.status === 'error') {
          throw new Error(errMsg(status.error) || 'Activation failed');
        }
        // pending — update progress message
        if (progressEl) {
          var secs = Math.floor((status.elapsedMs || 0) / 1000);
          progressEl.textContent = 'Provisioning your employer node and HR Tool... (' + secs + 's)';
        }
      }
      if (!config) throw new Error('Activation timed out after 120 seconds');

      var el = document.getElementById('activate-content');

      /*
       * A8: collect the administrator credentials with the one-time activation secret.
       *
       * The progress poll above no longer carries the admin token. It used to, on an open route
       * keyed by the application ID, which is written to the insurer's plaintext store and
       * printed to its console, so anyone who read it from either could collect the token and
       * drive the employer's tenant. Collection is now a separate request that carries the
       * secret in its body and works exactly once.
       */
      if (!claimSecret) {
        claimSecret = prompt(
          'Enter your activation code to collect your administrator credentials:'
        ) || '';
        // Accept the whole code or just the secret half, since that is what people will paste.
        if (claimSecret.indexOf('.') >= 0) claimSecret = claimSecret.slice(claimSecret.indexOf('.') + 1);
        persistState();
      }
      if (!claimSecret) throw new Error('An activation code is required to collect your credentials.');

      var creds = await api(
        'POST',
        '/marketplace/api/activate-credentials/' + encodeURIComponent(applicationId),
        { claimSecret: claimSecret }
      );

      // Phase C: live URLs from the orchestrator, token from the one-time collection
      var hrToolUrl = creds.hrToolUrl || config.hrToolUrl || '';
      var employerNodeUrl = creds.employerNodeUrl || config.employerNodeUrl || '';
      var adminToken = creds.adminToken || '';
      // It has been handed over; keep it out of storage from here on.
      claimSecret = '';
      persistState();

      el.innerHTML =
        '<div class="info-banner success">Your employer infrastructure is live. Save the admin token below — it will not be shown again.</div>' +

        '<div class="card" style="margin-bottom:20px"><div class="card-header"><div class="card-title">Your Employer URLs</div></div><div class="card-body">' +
        '<div style="display:flex;flex-direction:column;gap:12px">' +
          '<div><strong>HR Tool (for your HR Admin)</strong><br>' +
            '<a href="' + esc(hrToolUrl) + '" target="_blank" style="font-family:monospace;font-size:14px">' + esc(hrToolUrl) + '</a>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">This is where you import employees and generate enrollment codes.</div>' +
          '</div>' +
          '<div><strong>Employer Dashboard</strong><br>' +
            '<a href="' + esc(employerNodeUrl) + '" target="_blank" style="font-family:monospace;font-size:14px">' + esc(employerNodeUrl) + '</a>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">Groups, roster, messaging, and direct employer node controls.</div>' +
          '</div>' +
          '<div><strong>Admin Token</strong> <span style="font-size:11px;color:var(--red)">(shown once — save now)</span><br>' +
            '<code style="background:var(--bg-secondary);padding:8px 12px;border-radius:4px;display:inline-block;margin-top:4px;user-select:all">' + esc(adminToken) + '</code>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">Enter this in the HR Tool and Employer Dashboard admin panels to authenticate.</div>' +
          '</div>' +
        '</div>' +
        '<div class="form-actions" style="margin-top:16px">' +
          '<button class="btn btn-primary" id="btn-open-hr">Open HR Tool</button>' +
          '<button class="btn" id="btn-open-employer">Open Employer Dashboard</button>' +
          '<button class="btn" id="btn-copy-token">Copy Admin Token</button>' +
        '</div></div></div>' +

        '<div class="card" style="margin-bottom:20px"><div class="card-header"><div class="card-title">Next Steps</div></div><div class="card-body">' +
        '<ol style="padding-left:20px;line-height:2">' +
          '<li>Click <strong>Open HR Tool</strong> above and enter the admin token</li>' +
          '<li>Create a group for your first cohort of employees</li>' +
          '<li>Import your employee roster via CSV (PII stays on your machine)</li>' +
          '<li>Download enrollment codes (portal) and PINs (SMS) as CSV files</li>' +
          '<li>Distribute codes and PINs to employees via separate channels</li>' +
          '<li>Employees enroll on their own devices at the member portal</li>' +
        '</ol></div></div>' +

        '<div class="card"><div class="card-header"><div class="card-title">Authorized Plans</div></div><div class="card-body">' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px">' +
        config.authorizedPlanIds.map(function(pid) {
          return '<span class="badge badge-blue">' + esc(pid) + '</span>';
        }).join('') +
        '</div>' +
        '<div style="margin-top:12px;font-size:13px;color:var(--text-muted)">Enrollment cap: ' + esc(config.enrollmentCap) + ' members | Effective: ' + esc(config.effectiveDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) + '</div>' +
        '</div></div>';

      // Wire the URL buttons
      var openHrBtn = document.getElementById('btn-open-hr');
      if (openHrBtn) openHrBtn.onclick = function() { window.open(hrToolUrl, '_blank'); };
      var openEmpBtn = document.getElementById('btn-open-employer');
      if (openEmpBtn) openEmpBtn.onclick = function() { window.open(employerNodeUrl, '_blank'); };
      var copyTokenBtn = document.getElementById('btn-copy-token');
      if (copyTokenBtn) copyTokenBtn.onclick = function() {
        navigator.clipboard.writeText(adminToken).then(function() { toast('Admin token copied', 'success'); });
      };

    } catch (e) {
      document.getElementById('activate-content').innerHTML = '<div class="info-banner warning">Activation failed: ' + esc(e.message) + '</div>';
    }
  }

  // ─── DOCX Download Button ────────────────────────────────

  // Available from sign screen after signing
  async function downloadDocx() {
    if (!applicationId) return;
    window.open('/marketplace/api/docx/' + encodeURIComponent(applicationId), '_blank');
  }

  // ─── Init ─────────────────────────────────────────────────

  // On load: if we have a persisted applicationId, refresh status from server
  // then navigate to the right screen. Otherwise follow the hash.
  (async function init() {
    if (applicationId) {
      try {
        var status = await api('GET', '/marketplace/api/status/' + encodeURIComponent(applicationId));
        applicationStatus = status.status;
        persistState();
      } catch (_) {
        // Server unreachable or app not found — clear stale state
        applicationId = null;
        applicationStatus = null;
        persistState();
      }
    }

    var hash = location.hash.replace('#', '') || '';
    if (applicationId && !hash) {
      // Auto-navigate based on persisted status
      if (applicationStatus === 'active') navigate('activate');
      else if (applicationStatus === 'signed') navigate('activate');
      else navigate('sign');
    } else {
      navigate(hash || 'browse');
    }
  })();
})();
