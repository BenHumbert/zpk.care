/**
 * Adjuda-GATOR Member Portal — Application Logic
 * Landing → Onboarding (7-step) → Restore → Main App (8 tabs)
 */
(function () {
  'use strict';

  // ── Local State Keys ─────────────────────────────────
  var LS = {
    WALLET_ID:    'zkt_walletId',
    ENROLL_KEY:   'zkt_enrollmentKey',
    SEQ_URL:      'zkt_seqUrl',
    INSURER_URL:  'zkt_insurerUrl',
    PROVER_URL:   'zkt_proverUrl',
    GRANTED:      'zkt_granted',
  };

  // ── App State ────────────────────────────────────────
  var walletId = '';
  var enrollmentKey = '';
  var currentTab = 'dashboard';
  var currentMsgTab = 'inbox';
  var claimsCache = [];
  var formularyCache = [];
  var providersCache = [];
  var messagesCache = [];
  var planSpendCache = null;
  var systemLog = [];
  var pcpData = null;          // fetched from server, not localStorage
  var planIdHash = '';          // fetched from server, not localStorage
  var pollTimer = null;

  // ── Helpers ──────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return document.querySelectorAll(sel); }

  function shortHash(h) {
    if (!h) return '--';
    var s = String(h);
    return s.length > 16 ? s.slice(0, 8) + '\u2026' + s.slice(-6) : s;
  }

  function fmtTime(t) {
    if (!t) return '--';
    return new Date(t).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDate(t) {
    if (!t) return '--';
    var d = new Date(t);
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function fmtCents(c) {
    if (c === undefined || c === null) return '$0.00';
    return '$' + (Number(c) / 100).toFixed(2);
  }

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // VULNERABILITY: Messages use base64 (prescriber) or AES-GCM with ephemeral keys
  // (member compose). No shared key exchange exists — true E2E decryption is NOT
  // implemented. This helper decodes what it can. See project memory for tracking.
  function decodePayload(ciphertext, iv) {
    if (!ciphertext) return '(no content)';
    // Prescriber sends btoa(plaintext) with iv='0'
    if (iv === '0' || iv === '') {
      try { return atob(ciphertext); } catch (_) { return '(decode error)'; }
    }
    // Hex-encoded AES-GCM — no shared key available yet
    if (/^[0-9a-f]+$/i.test(ciphertext)) {
      return '(encrypted \u2014 ' + Math.floor(ciphertext.length / 2) + ' bytes)';
    }
    try { return atob(ciphertext); } catch (_) { return '(encrypted)'; }
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    $('toast-container').appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  function lsRemove(k) { try { localStorage.removeItem(k); } catch {} }
  function lsJson(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }

  function statCard(label, value, detail) {
    return '<div class="stat-card">' +
      '<span class="stat-label">' + esc(label) + '</span>' +
      '<span class="stat-value">' + esc(String(value)) + '</span>' +
      (detail ? '<span class="stat-detail">' + esc(detail) + '</span>' : '') + '</div>';
  }

  function tierBadge(t) {
    var n = Number(t) || 0;
    var cls = n <= 1 ? 'badge-t1' : n === 2 ? 'badge-t2' : n === 3 ? 'badge-t3' : 'badge-t4';
    return '<span class="badge ' + cls + '">T' + n + '</span>';
  }

  function progressClass(pct) {
    return pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
  }

  function setConnDot(state) {
    var dot = $('conn-dot');
    if (dot) dot.className = 'conn-dot ' + state;
  }

  // ── System Log (in-memory only, not persisted) ──────
  function logSystem(type, summary, detail) {
    systemLog.unshift({ type: type, summary: summary, detail: detail || '', timestamp: Date.now() });
    if (systemLog.length > 100) systemLog.length = 100;
  }

  // ══════════════════════════════════════════════════════
  //  SCREEN MANAGEMENT
  // ══════════════════════════════════════════════════════
  function showScreen(id) {
    ['landing-screen', 'onboarding-screen', 'restore-screen', 'app-screen'].forEach(function (s) {
      $(s).classList.add('hidden');
    });
    $(id).classList.remove('hidden');
  }

  function isEnrolled() {
    return !!lsGet(LS.WALLET_ID);
  }

  function boot() {
    // Load URLs
    var seqUrl = lsGet(LS.SEQ_URL);
    if (seqUrl) RPC.setBaseUrl(seqUrl);
    var insUrl = lsGet(LS.INSURER_URL);
    if (insUrl) RPC.setInsurerUrl(insUrl);
    var prUrl = lsGet(LS.PROVER_URL);
    if (prUrl) RPC.setProverUrl(prUrl);

    if (isEnrolled()) {
      walletId = lsGet(LS.WALLET_ID);
      enrollmentKey = lsGet(LS.ENROLL_KEY);
      enterApp();
    } else {
      showScreen('landing-screen');
    }
  }

  function enterApp() {
    showScreen('app-screen');
    $('header-wallet').textContent = shortHash(walletId);
    $('header-wallet').title = walletId;

    // Fetch PCP and plan info from server (not localStorage)
    RPC.getCurrentPcp().then(function (pcp) { pcpData = pcp; }).catch(function () {});
    // Fetch onboarding status to get planIdHash
    fetch(location.origin + '/onboarding/status', { headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var data = j.data || j;
        if (data && data.onboarding && data.onboarding.tokenData && data.onboarding.tokenData.planId) {
          planIdHash = data.onboarding.tokenData.planId;
        }
      }).catch(function () {});

    // Router
    var hash = location.hash.replace('#', '') || 'dashboard';
    navigate(hash);

    // SSE
    RPC.connectSSE(function (ev) { handleSSE(ev); });
    RPC.onConnectionChange(function (state) { setConnDot(state); });

    // Polling
    startPolling();

    // Check connection
    RPC.checkConnection().then(function (ok) {
      setConnDot(ok ? 'connected' : 'disconnected');
    });
  }

  // ── Router ─────────────────────────────────────────
  function navigate(tab) {
    currentTab = tab;
    qsa('#main .page').forEach(function (p) { p.classList.add('hidden'); });
    qsa('#nav .nav-link').forEach(function (l) { l.classList.remove('active'); });
    var page = $('page-' + tab);
    if (page) page.classList.remove('hidden');
    var link = qs('#nav .nav-link[data-tab="' + tab + '"]');
    if (link) link.classList.add('active');
    loadTab(tab);
  }

  function loadTab(tab) {
    switch (tab) {
      case 'dashboard': loadDashboard(); break;
      case 'claims': loadClaims(); break;
      case 'formulary': loadFormulary(); break;
      case 'plan': loadPlan(); break;
      case 'providers': loadProviders(); break;
      case 'messages': loadMessages(); break;
      case 'backup': break;
      case 'settings': loadSettings(); break;
    }
  }

  // ══════════════════════════════════════════════════════
  //  LANDING
  // ══════════════════════════════════════════════════════
  function setupLanding() {
    $('landing-enroll-btn').addEventListener('click', function () {
      // Save sequencer URL if provided
      var url = $('landing-seq-url').value.trim();
      if (url) { lsSet(LS.SEQ_URL, url); RPC.setBaseUrl(url); }
      showScreen('onboarding-screen');
      onboardStep = 0;
      renderOnboardStep();
    });

    $('landing-restore-btn').addEventListener('click', function () {
      var url = $('landing-seq-url').value.trim();
      if (url) { lsSet(LS.SEQ_URL, url); RPC.setBaseUrl(url); }
      showScreen('restore-screen');
    });
  }

  // ══════════════════════════════════════════════════════
  //  EJECT — full local state reset
  // ══════════════════════════════════════════════════════
  async function ejectMember() {
    if (!confirm(
      'This will permanently erase all enrollment data on this device — ' +
      'including your wallet, enrollment key, and any saved credentials.\n\n' +
      'You will need a NEW enrollment token from your employer to start over.\n\n' +
      'This cannot be undone unless you have an NFC backup card.\n\nContinue?'
    )) return;

    try {
      var resp = await fetch(location.origin + '/onboarding/eject', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      var data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Eject failed');
    } catch (e) {
      // If the server eject fails (e.g. state already locked), still clear frontend state
      console.warn('[eject] Server eject failed:', e.message, '— clearing frontend anyway');
    }

    // Clear all browser state regardless of server result
    Object.values(LS).forEach(function (k) { lsRemove(k); });
    walletId = '';
    enrollmentKey = '';
    if (pollTimer) clearInterval(pollTimer);
    RPC.disconnectSSE();
    onboardStep = 0;
    onboardState = {
      pin: '', tokenId: '', enrollPIN: '', cardholderId: '', firstName: '', lastName: '', dob: '',
      enrollmentKey: '', walletId: '', preimageFields: null,
      statusMessage: '', error: '',
    };
    toast('All enrollment data erased. Starting fresh.', 'info');
    showScreen('landing-screen');
  }

  /** Render a "Start Over" link for the bottom of onboarding steps */
  function ejectLink() {
    return '<div style="text-align:center;margin-top:24px;padding-top:12px;border-top:1px solid var(--border)">' +
      '<a href="#" id="ob-eject" style="font-size:12px;color:var(--red);text-decoration:none;opacity:0.7">' +
      'Having trouble? Start over from the beginning</a></div>';
  }

  function wireEjectLink() {
    var el = $('ob-eject');
    if (el) el.addEventListener('click', function(e) { e.preventDefault(); ejectMember(); });
  }

  // ══════════════════════════════════════════════════════
  //  ONBOARDING (7-step enrollment ceremony)
  // ══════════════════════════════════════════════════════
  var ONBOARD_TOTAL_STEPS = 7;
  var onboardStep = 0;
  var onboardState = {
    pin: '', tokenId: '', enrollPIN: '', cardholderId: '', firstName: '', lastName: '', dob: '',
    enrollmentKey: '', walletId: '', preimageFields: null,
    statusMessage: '', error: '',
  };

  function renderOnboardStep() {
    var pct = ((onboardStep + 1) / ONBOARD_TOTAL_STEPS * 100).toFixed(1);
    $('onboard-progress').style.width = pct + '%';
    $('onboard-step-label').textContent = 'Step ' + (onboardStep + 1) + ' of ' + ONBOARD_TOTAL_STEPS;

    var body = $('onboard-body');
    switch (onboardStep) {
      case 0: // PIN
        body.innerHTML =
          '<div class="onboard-title">Create Device PIN</div>' +
          '<div class="onboard-desc">Choose a PIN to protect your local encrypted state. This PIN stays on your device and is never transmitted.</div>' +
          '<div class="form-group"><label>PIN (4+ digits)</label>' +
          '<input class="form-input mono" id="ob-pin" type="password" placeholder="Enter PIN" value="' + esc(onboardState.pin) + '"></div>' +
          '<div class="form-group"><label>Confirm PIN</label>' +
          '<input class="form-input mono" id="ob-pin-confirm" type="password" placeholder="Confirm PIN"></div>' +
          '<div class="form-actions"><button class="btn btn-primary" id="ob-next">Unlock</button></div>';
        $('ob-next').addEventListener('click', async function () {
          var pin = $('ob-pin').value;
          var confirm = $('ob-pin-confirm').value;
          if (!pin || pin.length < 4) { toast('PIN must be at least 4 characters', 'error'); return; }
          if (pin !== confirm) { toast('PINs do not match', 'error'); return; }
          onboardState.pin = pin;
          try {
            await fetch(location.origin + '/onboarding/unlock', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pin: pin }),
            }).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'Unlock failed'); });
          } catch (e) { toast('Unlock error: ' + e.message, 'error'); return; }
          onboardStep = 1;
          renderOnboardStep();
        });
        break;

      case 1: // Token + Enrollment PIN
        body.innerHTML =
          '<div class="onboard-title">Enrollment Credentials</div>' +
          '<div class="onboard-desc">Enter the enrollment code from your employer portal and the 8-digit PIN sent to your phone via SMS. These were provided through separate channels for security.</div>' +
          '<div class="form-group"><label>Enrollment Code</label>' +
          '<input class="form-input mono" id="ob-token" placeholder="e.g. TOKEN-1776172084733-0" value="' + esc(onboardState.tokenId) + '"></div>' +
          '<div class="form-group"><label>8-Digit PIN (from SMS)</label>' +
          '<input class="form-input mono" id="ob-enroll-pin" type="text" inputmode="numeric" maxlength="8" placeholder="e.g. 12345678" value="' + esc(onboardState.enrollPIN || '') + '"></div>' +
          '<div class="form-actions">' +
          '<button class="btn" id="ob-back">Back</button>' +
          '<button class="btn btn-primary" id="ob-next">Next</button></div>';
        $('ob-back').addEventListener('click', function () { onboardStep = 0; renderOnboardStep(); });
        $('ob-next').addEventListener('click', async function () {
          var v = $('ob-token').value.trim();
          var pin = $('ob-enroll-pin').value.trim();
          if (!v) { toast('Enrollment code is required', 'error'); return; }
          if (!pin || pin.length < 4) { toast('Enter the 8-digit PIN from your SMS', 'error'); return; }
          onboardState.tokenId = v;
          onboardState.enrollPIN = pin;
          try {
            await fetch(location.origin + '/onboarding/accept-token', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tokenId: v }),
            }).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'Failed'); });
          } catch (e) { toast('Token error: ' + e.message, 'error'); return; }
          onboardStep = 2;
          renderOnboardStep();
        });
        break;

      case 2: // PHI part 1
        body.innerHTML =
          '<div class="onboard-title">Personal Information</div>' +
          '<div class="onboard-desc">This information is used to derive your wallet ID. It is never sent to the network — only a cryptographic hash is used.</div>' +
          '<div class="form-group"><label>Cardholder ID</label>' +
          '<input class="form-input" id="ob-cid" placeholder="From your benefits card" value="' + esc(onboardState.cardholderId) + '"></div>' +
          '<div class="form-group"><label>First Name</label>' +
          '<input class="form-input" id="ob-fn" value="' + esc(onboardState.firstName) + '"></div>' +
          '<div class="form-actions">' +
          '<button class="btn" id="ob-back">Back</button>' +
          '<button class="btn btn-primary" id="ob-next">Next</button></div>';
        $('ob-back').addEventListener('click', function () { onboardStep = 1; renderOnboardStep(); });
        $('ob-next').addEventListener('click', function () {
          var cid = $('ob-cid').value.trim();
          var fn = $('ob-fn').value.trim();
          if (!cid || !fn) { toast('All fields required', 'error'); return; }
          onboardState.cardholderId = cid;
          onboardState.firstName = fn;
          onboardStep = 3;
          renderOnboardStep();
        });
        break;

      case 3: // PHI part 2
        body.innerHTML =
          '<div class="onboard-title">Personal Information (continued)</div>' +
          '<div class="onboard-desc">Your data stays on this device. Only Poseidon hashes are transmitted.</div>' +
          '<div class="form-group"><label>Last Name</label>' +
          '<input class="form-input" id="ob-ln" value="' + esc(onboardState.lastName) + '"></div>' +
          '<div class="form-group"><label>Date of Birth (CCYYMMDD)</label>' +
          '<input class="form-input" id="ob-dob" placeholder="19900115" value="' + esc(onboardState.dob) + '"></div>' +
          '<div class="form-actions">' +
          '<button class="btn" id="ob-back">Back</button>' +
          '<button class="btn btn-primary" id="ob-next">Next</button></div>';
        $('ob-back').addEventListener('click', function () { onboardStep = 2; renderOnboardStep(); });
        $('ob-next').addEventListener('click', function () {
          var ln = $('ob-ln').value.trim();
          var dob = $('ob-dob').value.trim();
          if (!ln || !dob) { toast('All fields required', 'error'); return; }
          if (!/^\d{8}$/.test(dob)) { toast('DOB must be 8 digits (CCYYMMDD)', 'error'); return; }
          onboardState.lastName = ln;
          onboardState.dob = dob;
          onboardStep = 4;
          renderOnboardStep();
        });
        break;

      case 4: // Key generation
        body.innerHTML =
          '<div class="onboard-title">Generating Enrollment Key</div>' +
          '<div class="onboard-desc">Creating a secure enrollment key and deriving your wallet ID...</div>' +
          '<div class="onboard-status"><div class="spinner-lg"></div><div id="ob-keygen-msg">Generating cryptographic key...</div></div>';
        setTimeout(function () { generateKeyAndWallet(); }, 400);
        break;

      case 5: // Enrolling
        body.innerHTML =
          '<div class="onboard-title">Enrolling with Insurer</div>' +
          '<div class="onboard-desc">Registering your wallet with the insurer and generating a zero-knowledge proof...</div>' +
          '<div class="onboard-status"><div class="spinner-lg"></div><div id="ob-enroll-msg">' + esc(onboardState.statusMessage || 'Starting enrollment...') + '</div></div>' +
          (onboardState.error ? '<div style="color:var(--red);margin-top:12px;font-size:12px">' + esc(onboardState.error) + '</div>' +
            '<div class="form-actions" style="margin-top:12px"><button class="btn" id="ob-retry">Retry</button></div>' : '');
        if (onboardState.error) {
          $('ob-retry').addEventListener('click', function () {
            onboardState.error = '';
            onboardState.statusMessage = '';
            renderOnboardStep();
            completeEnrollment();
          });
        } else {
          completeEnrollment();
        }
        break;

      case 6: // Complete
        body.innerHTML =
          '<div class="onboard-title">Enrollment Complete!</div>' +
          '<div class="onboard-desc">Your wallet has been registered on the Adjuda-GATOR network.</div>' +
          '<div style="margin:16px 0;padding:12px;background:var(--accent-dim);border-radius:var(--radius-sm);font-size:12px">' +
          '<div style="color:var(--text-secondary);margin-bottom:4px">Your Wallet ID</div>' +
          '<div class="mono" style="word-break:break-all;color:var(--accent)">' + esc(onboardState.walletId) + '</div></div>' +
          '<div style="color:var(--yellow);font-size:11px;margin-bottom:16px">Please create a backup immediately in the Backup tab.</div>' +
          '<div class="form-actions"><button class="btn btn-primary btn-lg" id="ob-enter">Enter App</button></div>';
        $('ob-enter').addEventListener('click', function () {
          walletId = onboardState.walletId;
          enrollmentKey = onboardState.enrollmentKey;
          lsSet(LS.WALLET_ID, walletId);
          lsSet(LS.ENROLL_KEY, 'server-managed');
          logSystem('enrollment', 'Wallet enrolled', 'Wallet ' + shortHash(walletId) + ' registered');
          enterApp();
        });
        break;
    }

    // Append "Start Over" eject link to every step except the completion screen.
    // On the completion screen, eject doesn't make sense — the wallet is already on-chain.
    if (onboardStep < 6) {
      var body = $('onboard-body');
      if (body) body.insertAdjacentHTML('beforeend', ejectLink());
      wireEjectLink();
    }
  }

  async function generateKeyAndWallet() {
    try {
      // Step 1: Generate enrollment key on the server (Nautilus local state)
      if ($('ob-keygen-msg')) $('ob-keygen-msg').textContent = 'Generating enrollment key on device...';
      var keyRes = await fetch(location.origin + '/onboarding/generate-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(function (r) { return r.json(); });
      if (!keyRes.ok) throw new Error(keyRes.error || 'Key generation failed');

      // Step 2: Derive wallet via server-side Poseidon hashing (PHI sent to local device only)
      if ($('ob-keygen-msg')) $('ob-keygen-msg').textContent = 'Deriving wallet ID (Poseidon hash)...';
      var today = new Date().toISOString().split('T')[0];
      var deriveRes = await fetch(location.origin + '/onboarding/derive-wallet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardholderId: onboardState.cardholderId,
          dateOfBirth: onboardState.dob,
          firstName: onboardState.firstName,
          lastName: onboardState.lastName,
          consentRecord: {
            phiDescription: 'Health insurance claim adjudication data including drug identity, cost amounts, and accumulator balances',
            disclosingParty: 'Member',
            receivingParty: 'Adjuda-GATOR Network (zkTrident sequencer)',
            purpose: 'Zero-knowledge proof generation for pharmacy benefit claim adjudication and drug utilization verification',
            expiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            signatureDate: today,
          },
        }),
      }).then(function (r) { return r.json(); });
      if (!deriveRes.ok) throw new Error(deriveRes.error || 'Wallet derivation failed');

      onboardState.walletId = deriveRes.data.walletId;

      // Wipe PHI from client state
      onboardState.cardholderId = '';
      onboardState.firstName = '';
      onboardState.lastName = '';
      onboardState.dob = '';

      if ($('ob-keygen-msg')) $('ob-keygen-msg').textContent = 'Wallet derived: ' + shortHash(onboardState.walletId);
      setTimeout(function () { onboardStep = 5; renderOnboardStep(); }, 800);
    } catch (e) {
      if ($('ob-keygen-msg')) $('ob-keygen-msg').textContent = 'Error: ' + e.message;
      toast('Key/wallet derivation failed: ' + e.message, 'error');
    }
  }

  async function completeEnrollment() {
    try {
      // Step 1: Enroll via server ceremony (server calls insurer + creates MemberNode)
      onboardState.statusMessage = 'Enrolling with insurer...';
      if ($('ob-enroll-msg')) $('ob-enroll-msg').textContent = onboardState.statusMessage;
      var enrollRes = await fetch(location.origin + '/onboarding/enroll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenPIN: onboardState.enrollPIN || undefined }),
      }).then(function (r) { return r.json(); });
      if (!enrollRes.ok) throw new Error(enrollRes.error || 'Enrollment failed');

      // Step 2: Compile programs (transitions phase: enrolled → ready)
      // Must happen before proof generation since /proof/registration requires phase=ready
      onboardState.statusMessage = 'Compiling ZK programs...';
      if ($('ob-enroll-msg')) $('ob-enroll-msg').textContent = onboardState.statusMessage;
      var compileRes = await fetch(location.origin + '/onboarding/compile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(function (r) { return r.json(); });
      if (!compileRes.ok) {
        console.error('Compile failed:', compileRes.error);
        throw new Error('Program compilation failed: ' + (compileRes.error || 'unknown error'));
      }

      // Step 3: Generate + submit registration proof via member node
      // The /proof/registration endpoint fetches witnesses from sequencer,
      // generates a real ZK proof, and submits it — all server-side.
      onboardState.statusMessage = 'Generating zero-knowledge registration proof (this may take 30-120s)...';
      if ($('ob-enroll-msg')) $('ob-enroll-msg').textContent = onboardState.statusMessage;
      var proofRes = await fetch(location.origin + '/proof/registration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(function (r) { return r.json(); });
      if (!proofRes.ok) {
        // Proof generation is critical — if it fails, enrollment is incomplete
        console.error('Registration proof failed:', proofRes.error);
        throw new Error('Registration proof failed: ' + (proofRes.error || 'unknown error'));
      }
      console.log('Registration proof submitted, receipt:', proofRes.data?.receiptId);
      onProofSubmitted('Registration proof');

      // Success
      onboardStep = 6;
      renderOnboardStep();

    } catch (e) {
      onboardState.error = e.message;
      onboardState.statusMessage = 'Enrollment failed';
      renderOnboardStep();
    }
  }

  // ══════════════════════════════════════════════════════
  //  RESTORE
  // ══════════════════════════════════════════════════════
  function setupRestore() {
    $('restore-back-btn').addEventListener('click', function () {
      showScreen('landing-screen');
    });

    $('restore-submit-btn').addEventListener('click', async function () {
      var jsonText = $('restore-json').value.trim();
      var pin = $('restore-pin').value;
      if (!jsonText) { toast('Paste recovery card JSON', 'error'); return; }
      if (!pin || pin.length < 6) { toast('PIN must be 6+ digits', 'error'); return; }

      var result = $('restore-result');
      result.innerHTML = '<div class="loading">Decrypting...</div>';

      try {
        var card = JSON.parse(jsonText);
        if (!card.walletId || !card.encryptedKey || !card.salt || !card.iv) {
          throw new Error('Invalid recovery card format — missing required fields');
        }
        if (card.version && card.version > 2) {
          throw new Error('Recovery card version ' + card.version + ' is not supported by this app. Please update.');
        }

        // Derive key from PIN using PBKDF2
        var pinKey = await crypto.subtle.importKey(
          'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']
        );
        var salt = hexToBytes(card.salt);
        var aesKey = await crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
          pinKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
        );

        // Decrypt enrollment key
        var iv = hexToBytes(card.iv);
        var ciphertext = hexToBytes(card.encryptedKey);
        var decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv }, aesKey, ciphertext
        );
        var restoredKey = new TextDecoder().decode(decrypted);

        // Restore state
        walletId = card.walletId;
        enrollmentKey = restoredKey;
        lsSet(LS.WALLET_ID, walletId);
        lsSet(LS.ENROLL_KEY, enrollmentKey);
        logSystem('restore', 'Wallet restored from backup', 'Wallet ' + shortHash(walletId));

        toast('Wallet restored!', 'success');
        enterApp();
      } catch (e) {
        result.innerHTML = '<div style="color:var(--red);margin-top:12px;font-size:12px">Decryption failed: ' + esc(e.message) + '. Check PIN and JSON.</div>';
      }
    });
  }

  function hexToBytes(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // ══════════════════════════════════════════════════════
  //  DASHBOARD
  // ══════════════════════════════════════════════════════
  async function loadDashboard() {
    // Fetch PCP from server
    try { pcpData = await RPC.getCurrentPcp(); } catch (_) { /* server unavailable */ }
    var nudge = $('pcp-nudge');
    if (pcpData && (pcpData.pcpWalletId || pcpData.walletId)) {
      nudge.classList.add('hidden');
    } else {
      nudge.classList.remove('hidden');
    }

    // Load spend
    loadSpendHero($('spend-hero'));

    // Stats
    loadDashStats();

    // Recent claims
    loadRecentClaims();
  }

  async function loadSpendHero(container) {
    try {
      var acc = await RPC.reconstructAccumulator(walletId);
      if (!acc) { container.innerHTML = '<div class="empty-state">No claims data yet</div>'; return; }
      planSpendCache = acc;
      var dedPaid = Number(acc.deductiblePaidCents || acc.deductibleCreditCents || acc.totalDeductibleCredit || 0);
      var oopPaid = Number(acc.oopPaidCents || acc.patientPayCents || acc.totalPatientPay || 0);
      var planPaid = Number(acc.benefitUsedCents || acc.planPayCents || acc.totalPlanPay || 0);

      // Fetch real plan limits from sequencer (falls back to defaults if unavailable)
      var dedMax = 150000; // default $1500
      var oopMax = 500000; // default $5000
      var benefitMax = 0;  // default unlimited
      if (planIdHash) {
        try {
          var limits = await RPC.getPlanLimits(planIdHash);
          if (limits) {
            dedMax = limits.deductibleAmountCents != null ? Number(limits.deductibleAmountCents) : dedMax;
            oopMax = limits.oopMaxCents != null ? Number(limits.oopMaxCents) : oopMax;
            benefitMax = limits.annualBenefitMaxCents != null ? Number(limits.annualBenefitMaxCents) : 0;
          }
        } catch { /* plan limits unavailable — use defaults */ }
      }

      var dedPct = dedMax > 0 ? Math.min(100, (dedPaid / dedMax * 100)) : 0;
      var oopPct = oopMax > 0 ? Math.min(100, (oopPaid / oopMax * 100)) : 0;

      container.innerHTML =
        '<div class="spend-row">' +
        '<div class="spend-item">' +
          '<div class="spend-label">Deductible</div>' +
          '<div class="spend-amounts"><span class="spend-current">' + fmtCents(dedPaid) + '</span>' +
          (dedMax > 0 ? '<span class="spend-max">of ' + fmtCents(dedMax) + '</span>' : '') + '</div>' +
          (dedMax > 0 ? '<div class="progress-bar"><div class="progress-fill ' + progressClass(dedPct) + '" style="width:' + dedPct + '%"></div></div>' : '') +
        '</div>' +
        '<div class="spend-item">' +
          '<div class="spend-label">Out-of-Pocket</div>' +
          '<div class="spend-amounts"><span class="spend-current">' + fmtCents(oopPaid) + '</span>' +
          (oopMax > 0 ? '<span class="spend-max">of ' + fmtCents(oopMax) + '</span>' : '') + '</div>' +
          (oopMax > 0 ? '<div class="progress-bar"><div class="progress-fill ' + progressClass(oopPct) + '" style="width:' + oopPct + '%"></div></div>' : '') +
        '</div>' +
        '<div class="spend-item">' +
          '<div class="spend-label">Plan Benefit Used</div>' +
          '<div class="spend-amounts"><span class="spend-current">' + fmtCents(planPaid) + '</span>' +
          (benefitMax > 0 ? '<span class="spend-max">of ' + fmtCents(benefitMax) + '</span>' : '') + '</div>' +
        '</div>' +
        '</div>';
    } catch {
      container.innerHTML = '<div class="spend-hero-loading">Spend data unavailable</div>';
    }
  }

  async function loadDashStats() {
    try {
      var rawClaims = await RPC.getClaimsByMember(walletId);
      if (!Array.isArray(rawClaims)) rawClaims = [];
      var claims = deduplicateClaims(rawClaims);
      claimsCache = claims;

      var fills = 0, reversals = 0, totalPat = 0;
      claims.forEach(function (c) {
        var leaf = c.leaf || c.claimLeaf || c;
        if (String(leaf.operationType) === '2') reversals++;
        else fills++;
        totalPat += Number(leaf.patientPayCents || 0);
      });

      $('dash-stats').innerHTML =
        statCard('Total Fills', fills) +
        statCard('Reversals', reversals) +
        statCard('You Paid', fmtCents(totalPat)) +
        statCard('Claims', claims.length);
    } catch {
      $('dash-stats').innerHTML = statCard('Claims', '--');
    }
  }

  async function loadRecentClaims() {
    var container = $('dash-recent-claims');
    try {
      if (!claimsCache.length) {
        var rawClaims = await RPC.getClaimsByMember(walletId);
        if (!Array.isArray(rawClaims)) rawClaims = [];
        claimsCache = deduplicateClaims(rawClaims);
      }
      var recent = claimsCache.slice(0, 5);
      container.innerHTML = recent.length ? renderClaimCards(recent) : '<div class="empty-state">No claims yet</div>';
    } catch {
      container.innerHTML = '<div class="empty-state">Unable to load claims</div>';
    }
  }

  function renderClaimCards(claims) {
    var html = '';
    claims.forEach(function (c) {
      var leaf = c.leaf || c.claimLeaf || c;
      var meta = c.metadata || {};
      var isReversal = String(leaf.operationType) === '2';
      var drug = meta.brandName || ('NDC ' + shortHash(leaf.ndcHash));
      var pharmacy = meta.pharmacyName || shortHash(leaf.pharmacyWalletId);
      var date = meta.timestamp ? fmtDate(meta.timestamp) : (leaf.dateOfService || '--');
      var details = [];
      if (meta.therapeuticClass) details.push(meta.therapeuticClass);
      if (meta.tierLevel) details.push('Tier ' + meta.tierLevel);
      if (meta.deaSchedule && meta.deaSchedule !== '0') details.push('C-' + meta.deaSchedule);

      // NADAC transparent pricing breakdown
      var hasNadac = meta.ingredientCostCents != null || meta.totalDrugCostCents != null;
      var nadacHtml = '';
      if (hasNadac) {
        var totalDrug = meta.totalDrugCostCents || (
          (meta.ingredientCostCents || 0) + (meta.dispensingFeeCents || 0)
        );
        nadacHtml =
          '<div class="claim-nadac">' +
            '<span class="nadac-label">Drug Cost:</span> ' + fmtCents(totalDrug) +
            ' <span class="nadac-detail">(NADAC ' + fmtCents(meta.ingredientCostCents) +
            ' + Fee ' + fmtCents(meta.dispensingFeeCents) + ')</span>' +
          '</div>';
      }

      html += '<div class="claim-card">' +
        '<div class="claim-icon' + (isReversal ? ' reversal' : '') + '">' + (isReversal ? 'REV' : 'Rx') + '</div>' +
        '<div class="claim-info">' +
          '<div class="claim-drug">' + esc(drug) + '</div>' +
          '<div class="claim-meta">' + esc(pharmacy) + ' &middot; ' + esc(date) +
          (details.length ? ' &middot; ' + esc(details.join(', ')) : '') + '</div>' +
          nadacHtml +
        '</div>' +
        '<div class="claim-amounts">' +
          '<div class="claim-patient-pay">' + fmtCents(leaf.patientPayCents) + '</div>' +
          '<div class="claim-plan-pay">Plan: ' + fmtCents(leaf.planPayCents) + '</div>' +
        '</div></div>';
    });
    return html;
  }

  // ══════════════════════════════════════════════════════
  //  DRUG HISTORY
  // ══════════════════════════════════════════════════════
  // Deduplicate claims: same leafIndex = same accumulator entry (true duplicate from RPC).
  // Different leafIndex = different fills, even if same drug/pharmacy/date (legitimate refills).
  // Reversals (opType '2') are never deduped.
  function deduplicateClaims(claims) {
    var seen = {};
    return claims.filter(function (c) {
      var leaf = c.leaf || c.claimLeaf || c;
      if (String(leaf.operationType) === '2') return true; // never dedup reversals
      // Use leafIndex as the canonical dedup key — each accumulator entry is unique
      var leafIdx = c.leafIndex ?? leaf.leafIndex;
      if (leafIdx != null) {
        var key = String(leafIdx);
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      }
      // Fallback for claims without leafIndex: use composite key
      var compositeKey = (leaf.memberWalletId || '') + ':' + (leaf.ndcHash || '') + ':' +
                (leaf.pharmacyWalletId || '') + ':' + (leaf.dateOfService || '');
      if (seen[compositeKey]) return false;
      seen[compositeKey] = true;
      return true;
    });
  }

  async function loadClaims() {
    var container = $('claims-list');
    container.innerHTML = '<div class="loading">Loading...</div>';
    if (!walletId) {
      container.innerHTML = '<div class="empty-state">Complete onboarding to view your drug history</div>';
      return;
    }
    try {
      var rawClaims = await RPC.getClaimsByMember(walletId);
      if (!Array.isArray(rawClaims)) rawClaims = [];
      var claims = deduplicateClaims(rawClaims);
      claimsCache = claims;

      // Stats
      var fills = 0, reversals = 0, controlled = 0, totalPat = 0, totalPlan = 0, totalDrug = 0;
      claims.forEach(function (c) {
        var leaf = c.leaf || c.claimLeaf || c;
        var meta = c.metadata || {};
        if (String(leaf.operationType) === '2') reversals++;
        else fills++;
        if (meta.deaSchedule && meta.deaSchedule !== '0') controlled++;
        totalPat += Number(leaf.patientPayCents || 0);
        totalPlan += Number(leaf.planPayCents || 0);
        if (meta.totalDrugCostCents) totalDrug += Number(meta.totalDrugCostCents);
        else if (meta.ingredientCostCents != null) totalDrug += Number(meta.ingredientCostCents || 0) + Number(meta.dispensingFeeCents || 0);
      });
      $('claims-stats').innerHTML =
        statCard('Fills', fills) +
        statCard('Reversals', reversals) +
        statCard('You Paid', fmtCents(totalPat)) +
        statCard('Plan Saved You', fmtCents(totalPlan));

      container.innerHTML = claims.length ? renderClaimCards(claims) : '<div class="empty-state">No claims found</div>';
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  }

  function filterClaims() {
    var q = ($('claims-search').value || '').toLowerCase().trim();
    if (!q) { $('claims-list').innerHTML = renderClaimCards(claimsCache); return; }
    var filtered = claimsCache.filter(function (c) {
      var meta = c.metadata || {};
      var leaf = c.leaf || c.claimLeaf || c;
      return (meta.brandName || '').toLowerCase().indexOf(q) >= 0 ||
             (meta.therapeuticClass || '').toLowerCase().indexOf(q) >= 0 ||
             (leaf.ndcHash || '').indexOf(q) >= 0 ||
             (leaf.pharmacyWalletId || '').indexOf(q) >= 0 ||
             (leaf.dateOfService || '').indexOf(q) >= 0;
    });
    $('claims-list').innerHTML = filtered.length ? renderClaimCards(filtered) : '<div class="empty-state">No matches</div>';
  }

  // ══════════════════════════════════════════════════════
  //  FORMULARY
  // ══════════════════════════════════════════════════════
  var formularyOffset = 0;
  var formularyPageSize = 100;
  var formularyFilter = {};

  async function loadFormulary() {
    var container = $('formulary-table');
    container.innerHTML = '<div class="loading">Loading formulary...</div>';
    try {
      // Get drug count
      var countData = await RPC.getFormularyDrugCount();
      var totalCount = countData && countData.count ? countData.count : 0;

      $('formulary-stats').innerHTML =
        statCard('Total Medications', totalCount.toLocaleString()) +
        statCard('Source', 'CMS NADAC') +
        statCard('Query', 'Paginated (100/page)');

      formularyOffset = 0;
      formularyFilter = {};
      await loadFormularyPage();
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Formulary unavailable: ' + esc(e.message) + '</div>';
    }
  }

  async function loadFormularyPage() {
    var container = $('formulary-table');
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var page = await RPC.getFormularyPage(formularyFilter, formularyOffset, formularyPageSize);
      if (!page || !page.drugs || !page.drugs.length) {
        container.innerHTML = '<div class="empty-state">No matching medications</div>';
        return;
      }
      formularyCache = page.drugs;
      renderFormularyTable(page.drugs, page.total, page.offset, page.hasMore);
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  }

  function renderFormularyTable(drugs, total, offset, hasMore) {
    if (!drugs.length) {
      $('formulary-table').innerHTML = '<div class="empty-state">No formulary entries</div>';
      return;
    }
    var from = (offset || 0) + 1;
    var to = (offset || 0) + drugs.length;
    var paginationHtml = '<div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;font-size:12px;color:var(--text-muted)">' +
      '<span>Showing ' + from + '–' + to + ' of ' + (total || '?').toLocaleString() + '</span>' +
      '<span>' +
      (offset > 0 ? '<button onclick="window._formPrev()" style="margin-right:8px;cursor:pointer">&laquo; Prev</button>' : '') +
      (hasMore ? '<button onclick="window._formNext()" style="cursor:pointer">Next &raquo;</button>' : '') +
      '</span></div>';

    var supply = 30; // default supply for cost display
    var html = paginationHtml +
      '<table class="data-table"><thead><tr>' +
      '<th>Drug</th><th>Strength</th><th>Tier</th><th>NADAC (' + supply + '-day)</th><th>You Pay</th><th>Employer Pays</th><th>Form</th><th>Supply</th><th>PA</th></tr></thead><tbody>';
    drugs.forEach(function (d) {
      var nadacCost = d.nadacPerUnit != null ? (d.nadacPerUnit * supply).toFixed(2) : '--';
      var youPay = d.copayAmount != null ? (d.copayAmount / 100).toFixed(2) : '--';
      var totalCents = d.nadacPerUnit != null ? Math.round(d.nadacPerUnit * supply * 100) : 0;
      var employerPay = totalCents > 0 && d.copayAmount != null
        ? (Math.max(0, totalCents - d.copayAmount) / 100).toFixed(2)
        : '--';
      html += '<tr>' +
        '<td><strong>' + esc(d.brandName || d.genericName || '--') + '</strong></td>' +
        '<td>' + esc(d.strength || '--') + '</td>' +
        '<td>' + tierBadge(d.tierLevel) + '</td>' +
        '<td class="mono">$' + nadacCost + '</td>' +
        '<td class="mono" style="color:var(--accent-blue,#58a6ff)">$' + youPay + '</td>' +
        '<td class="mono" style="color:var(--green,#3fb950)">$' + employerPay + '</td>' +
        '<td>' + esc(d.dosageForm || '--') + '</td>' +
        '<td class="mono">' + (d.maxDaySupply || '--') + 'd</td>' +
        '<td>' + (d.requiresPriorAuth ? '<span class="badge badge-warning">PA</span>' : '--') + '</td></tr>';
    });
    html += '</tbody></table>' + paginationHtml;
    $('formulary-table').innerHTML = html;
  }

  window._formNext = function () {
    formularyOffset += formularyPageSize;
    loadFormularyPage();
  };
  window._formPrev = function () {
    formularyOffset = Math.max(0, formularyOffset - formularyPageSize);
    loadFormularyPage();
  };

  function filterFormulary() {
    var q = ($('formulary-search').value || '').trim();
    formularyFilter.namePrefix = q;
    formularyOffset = 0;
    loadFormularyPage();
  }

  // ══════════════════════════════════════════════════════
  //  MY PLAN
  // ══════════════════════════════════════════════════════
  async function loadPlan() {
    loadSpendHero($('plan-spend-hero'));

    // Accumulators
    var accEl = $('plan-accumulators');
    accEl.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var acc = await RPC.reconstructAccumulator(walletId);
      if (!acc) { accEl.innerHTML = '<div class="empty-state">No claims data yet</div>'; return; }
      planSpendCache = acc;
      var dedPaid = Number(acc.deductiblePaidCents || acc.deductibleCreditCents || acc.totalDeductibleCredit || 0);
      var oopPaid = Number(acc.oopPaidCents || acc.patientPayCents || acc.totalPatientPay || 0);
      var planPaid = Number(acc.benefitUsedCents || acc.planPayCents || acc.totalPlanPay || 0);
      var claimCount = acc.claimCount || acc.totalClaims || 0;

      // Fetch plan limits for context
      var dedLabel = fmtCents(dedPaid);
      var oopLabel = fmtCents(oopPaid);
      var benefitLabel = fmtCents(planPaid);
      if (planIdHash) {
        try {
          var limits = await RPC.getPlanLimits(planIdHash);
          if (limits) {
            if (limits.deductibleAmountCents) dedLabel += ' of ' + fmtCents(limits.deductibleAmountCents);
            if (limits.oopMaxCents) oopLabel += ' of ' + fmtCents(limits.oopMaxCents);
            if (limits.annualBenefitMaxCents) benefitLabel += ' of ' + fmtCents(limits.annualBenefitMaxCents);
          }
        } catch { /* plan limits unavailable */ }
      }

      accEl.innerHTML =
        '<div class="stats-grid">' +
        statCard('Deductible Used', dedLabel) +
        statCard('Out-of-Pocket', oopLabel) +
        statCard('Plan Benefit', benefitLabel) +
        statCard('Total Claims', claimCount) +
        '</div>';
    } catch {
      accEl.innerHTML = '<div class="empty-state">Accumulator data unavailable</div>';
    }

    // Tiers from formulary (Option C — use paginated data if cached, else load a sample page)
    var tierEl = $('plan-tiers');
    tierEl.innerHTML = '<div class="loading">Loading...</div>';
    try {
      if (!formularyCache.length) {
        var page = await RPC.getFormularyPage({}, 0, 200);
        if (page && page.drugs) formularyCache = page.drugs;
      }
      if (formularyCache.length) {
        var tiers = {};
        formularyCache.forEach(function (d) {
          var t = Number(d.tierLevel) || 0;
          if (!tiers[t]) tiers[t] = { count: 0, totalPrice: 0, drugs: [] };
          tiers[t].count++;
          tiers[t].totalPrice += Number(d.nadacPerUnit || d.pricePerUnit || 0);
          if (tiers[t].drugs.length < 3) tiers[t].drugs.push(d.brandName || d.genericName || 'Unknown');
        });
        var html = '';
        [1, 2, 3, 4].forEach(function (t) {
          var d = tiers[t];
          if (!d) return;
          var avg = d.count ? '$' + (d.totalPrice / d.count).toFixed(4) : '--';
          html += '<div style="margin-bottom:14px">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
            tierBadge(t) + '<strong>' + d.count + ' medications</strong> (sample)</div>' +
            '<div style="font-size:11px;color:var(--text-secondary)">Avg NADAC/unit: ' + avg + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' + d.drugs.map(esc).join(', ') + '</div></div>';
        });
        tierEl.innerHTML = html || '<div class="empty-state">No tier data</div>';
      } else {
        tierEl.innerHTML = '<div class="empty-state">Formulary not loaded</div>';
      }
    } catch {
      tierEl.innerHTML = '<div class="empty-state">Tier data unavailable</div>';
    }
  }

  // ══════════════════════════════════════════════════════
  //  PROVIDERS
  // ══════════════════════════════════════════════════════
  async function loadProviders() {
    var container = $('provider-list');
    container.innerHTML = '<div class="loading">Loading providers...</div>';
    try {
      var providers = await RPC.getNetworkProviders();
      if (!Array.isArray(providers)) providers = [];
      providersCache = providers;
      renderProviders(providers);

      // PCP display — fetch from server
      try { pcpData = await RPC.getCurrentPcp(); } catch (_) {}
      renderPcp(pcpData);
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Providers unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function renderPcp(pcp) {
    var body = $('pcp-body');
    var pcpWid = pcp ? (pcp.pcpWalletId || pcp.walletId) : null;
    if (!pcpWid) {
      body.innerHTML = '<div class="empty-state">No PCP assigned. Select a prescriber below to assign as PCP.</div>';
      return;
    }
    // Find provider name
    var name = shortHash(pcpWid);
    providersCache.forEach(function (p) {
      if (p.walletId === pcpWid) name = p.displayName || name;
    });
    body.innerHTML = '<div class="provider-card">' +
      '<div class="provider-avatar">' + name.slice(0, 2).toUpperCase() + '</div>' +
      '<div class="provider-info">' +
        '<div class="provider-name">' + esc(name) + '</div>' +
        '<div class="provider-sub">Assigned ' + fmtDate(pcp.effectiveDate || pcp.timestamp) + '</div>' +
      '</div>' +
      '<button class="btn btn-sm btn-danger" onclick="window._removePcp()">Remove</button></div>';
  }

  window._removePcp = async function () {
    try {
      await fetch(location.origin + '/pcp/current', { method: 'DELETE' });
      pcpData = null;
      logSystem('pcp_remove', 'PCP removed', '');
      toast('PCP removed', 'info');
    } catch (e) {
      console.warn('PCP removal failed:', e.message);
      toast('PCP removal failed: ' + (e.message || 'server error'), 'error');
    }
    loadProviders();
  };

  function renderProviders(providers) {
    var roleFilter = $('provider-role-filter').value;
    var searchQ = ($('provider-search').value || '').toLowerCase().trim();
    var filtered = providers.filter(function (p) {
      if (roleFilter && p.role !== roleFilter) return false;
      if (searchQ && (p.displayName || '').toLowerCase().indexOf(searchQ) < 0) return false;
      return true;
    });

    if (!filtered.length) {
      $('provider-list').innerHTML = '<div class="empty-state">No providers found</div>';
      return;
    }

    var html = '';
    filtered.forEach(function (p) {
      var isPharmacy = p.role === 'pharmacy';
      var initials = (p.displayName || 'XX').slice(0, 2).toUpperCase();
      var sub = p.specialty || p.pharmacyType || p.role || '';
      html += '<div class="provider-card">' +
        '<div class="provider-avatar' + (isPharmacy ? ' pharmacy' : '') + '">' + initials + '</div>' +
        '<div class="provider-info">' +
          '<div class="provider-name">' + esc(p.displayName || shortHash(p.walletId)) + '</div>' +
          '<div class="provider-sub">' + esc(sub) + ' &middot; <span class="hash">' + shortHash(p.walletId) + '</span></div>' +
        '</div>' +
        '<div class="provider-actions">' +
          (!isPharmacy ? '<button class="btn btn-sm" onclick="window._assignPcp(\'' + esc(p.walletId) + '\')">Set PCP</button>' : '') +
          '<button class="btn btn-sm" onclick="window._msgProvider(\'' + esc(p.walletId) + '\')">Message</button>' +
        '</div></div>';
    });
    $('provider-list').innerHTML = html;
  }

  window._assignPcp = async function (wid) {
    var pcp = { walletId: wid, effectiveDate: new Date().toISOString(), timestamp: Date.now() };
    // Step 1: Persist PCP assignment to backend (saves locally + registers on sequencer)
    try {
      await RPC.assignPcp(wid);
      pcpData = pcp;
      logSystem('pcp_assign', 'PCP assigned', shortHash(wid));
      toast('PCP assigned — generating ZK proof...', 'success');
    } catch (e) {
      console.warn('PCP backend persist failed:', e.message);
      toast('PCP assignment failed: ' + (e.message || 'server error'), 'error');
      return;
    }
    renderPcp(pcp);
    var nudge = $('pcp-nudge');
    if (nudge) nudge.classList.add('hidden');

    // Step 2: Generate wallet update proof (commits PCP to MEMBER tree on-chain)
    try {
      var proofRes = await fetch(location.origin + '/proof/pcp-assignment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(function (r) { return r.json(); });
      if (proofRes.ok) {
        toast('PCP proof submitted to sequencer', 'success');
        logSystem('pcp_assign', 'PCP proof submitted, receipt: ' + (proofRes.data?.receiptId || 'ok'), shortHash(wid));
        console.log('[PCP] Wallet update proof submitted:', proofRes.data);
      } else {
        toast('PCP saved but proof failed: ' + (proofRes.error || 'unknown'), 'error');
        console.error('[PCP] Proof failed:', proofRes.error);
      }
    } catch (proofErr) {
      toast('PCP saved but proof failed: ' + proofErr.message, 'error');
      console.error('[PCP] Proof generation error:', proofErr);
    }
  };

  window._msgProvider = function (wid) {
    navigate('messages');
    setTimeout(function () {
      $('compose-overlay').classList.remove('hidden');
      $('compose-recipient').value = wid;
    }, 100);
  };

  // ══════════════════════════════════════════════════════
  //  MESSAGES (contact-list + thread + inline reply)
  // ══════════════════════════════════════════════════════
  var msgContacts = [];
  var msgActiveThread = null;
  var _sendingMsg = false;

  async function loadMessages() {
    var listEl = $('msg-contacts-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var msgs = await RPC.getMessagesByWallet(walletId);
      if (!Array.isArray(msgs)) msgs = [];
      messagesCache = msgs;

      // Build contacts from unique threads/wallets (merge sent + received)
      var contactMap = {};
      msgs.forEach(function (entry) {
        var m = entry.message || entry;
        var p = entry.payload || {};
        var peer = m.senderWalletId === walletId ? m.recipientWalletId : m.senderWalletId;
        var key = m.threadIdHash || peer || 'unknown';
        if (!contactMap[key]) {
          var peerName = shortHash(peer);
          providersCache.forEach(function (prov) { if (prov.walletId === peer) peerName = prov.displayName || peerName; });
          contactMap[key] = { wallet: peer, threadId: m.threadIdHash, messages: [], lastTime: 0, name: peerName };
        }
        contactMap[key].messages.push(entry);
        var t = p.timestamp || entry.timestamp || 0;
        if (t > contactMap[key].lastTime) contactMap[key].lastTime = t;
      });

      msgContacts = Object.values(contactMap).sort(function (a, b) { return b.lastTime - a.lastTime; });

      if (msgContacts.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:24px">No conversations yet</div>';
        return;
      }

      listEl.innerHTML = msgContacts.map(function (c, i) {
        var preview = '';
        if (c.messages.length > 0) {
          var lastEntry = c.messages[c.messages.length - 1];
          var lp = lastEntry.payload || {};
          preview = decodePayload(lp.ciphertext, lp.iv);
        }
        return '<div class="msg-contact-item" data-idx="' + i + '" style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border,#333);display:flex;gap:10px;align-items:center">' +
          '<div style="width:36px;height:36px;border-radius:50%;background:var(--accent-blue,#58a6ff);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0">' + esc(c.name.slice(0, 2).toUpperCase()) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
              '<span style="font-weight:600;font-size:13px">' + esc(c.name) + '</span>' +
              '<span style="font-size:10px;color:var(--text-muted)">' + (c.lastTime ? fmtTime(c.lastTime) : '') + '</span>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + c.messages.length + ' msg &middot; ' + esc(preview.slice(0, 40)) + '</div>' +
          '</div></div>';
      }).join('');

      listEl.querySelectorAll('.msg-contact-item').forEach(function (item) {
        item.addEventListener('click', function () { openMsgThread(parseInt(item.dataset.idx)); });
      });
    } catch (e) {
      listEl.innerHTML = '<div class="empty-state">Messages unavailable: ' + esc(e.message) + '</div>';
    }
  }

  async function openMsgThread(idx) {
    var contact = msgContacts[idx];
    if (!contact) return;
    msgActiveThread = contact;

    // Highlight
    qsa('.msg-contact-item').forEach(function (item, i) {
      item.style.background = (i === idx) ? 'var(--bg-surface,#222)' : '';
    });

    $('msg-conv-header').textContent = contact.name;
    $('msg-conv-input').style.display = '';

    var messagesEl = $('msg-conv-messages');
    messagesEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      var messages;
      if (contact.threadId) {
        messages = await RPC.getMessagesByThread(contact.threadId);
        if (!Array.isArray(messages)) messages = [];
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
        var isSent = m.senderWalletId === walletId;
        var body = decodePayload(p.ciphertext, p.iv);
        return '<div class="msg-bubble ' + (isSent ? 'sent' : 'received') + '" style="max-width:75%;margin:6px 0;padding:10px 14px;border-radius:16px;' +
          (isSent ? 'margin-left:auto;background:var(--accent-blue,#58a6ff);color:#fff' : 'margin-right:auto;background:var(--bg-surface,#222)') + '">' +
          '<div style="font-size:10px;opacity:0.7;margin-bottom:4px">' + (isSent ? 'You' : esc(contact.name)) + '</div>' +
          '<div>' + esc(body) + '</div>' +
          '<div style="font-size:9px;opacity:0.5;margin-top:4px;text-align:right">' + fmtTime(p.timestamp || entry.timestamp) + '</div></div>';
      }).join('');

      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (e) {
      messagesEl.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  }

  async function sendMsgInThread() {
    if (!msgActiveThread) return;
    if (_sendingMsg) return;
    var input = $('msg-input-text');
    var body = input.value.trim();
    if (!body) return;
    _sendingMsg = true;

    try {
      var sorted = [walletId, msgActiveThread.wallet].sort();
      var threadSeed = sorted.join(':');
      var threadBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(threadSeed));
      var threadIdHash = msgActiveThread.threadId || BigInt('0x' + bytesToHex(new Uint8Array(threadBuf)).slice(0, 62)).toString();

      // Send via server-side encryption endpoint (enrollment key on server, not in browser)
      await RPC.sendEncryptedMessage(msgActiveThread.wallet, body);
      input.value = '';
      toast('Message sent', 'success');
      var idx = msgContacts.indexOf(msgActiveThread);
      if (idx >= 0) openMsgThread(idx);
    } catch (e) {
      toast('Send failed: ' + e.message, 'error');
    } finally {
      _sendingMsg = false;
    }
  }

  // ── Compose ────────────────────────────────────────
  async function sendMessage() {
    var recipient = $('compose-recipient').value.trim();
    var body = $('compose-body').value.trim();
    if (!recipient || !body) { toast('Recipient and message required', 'error'); return; }
    if (_sendingMsg) return;
    _sendingMsg = true;

    try {
      // Send via server-side encryption endpoint (enrollment key on server, not in browser)
      await RPC.sendEncryptedMessage(recipient, body);

      // Close compose, log, refresh
      $('compose-overlay').classList.add('hidden');
      $('compose-recipient').value = '';
      $('compose-body').value = '';
      logSystem('message_sent', 'Message sent', 'To ' + shortHash(recipient));
      toast('Message sent (encrypted)', 'success');
      loadMessages();
    } catch (e) {
      toast('Send failed: ' + e.message, 'error');
    } finally {
      _sendingMsg = false;
    }
  }

  // ══════════════════════════════════════════════════════
  //  BACKUP
  // ══════════════════════════════════════════════════════
  function setupBackup() {
    $('backup-create-btn').addEventListener('click', async function () {
      var pin = $('backup-pin').value;
      var confirm = $('backup-pin-confirm').value;
      if (!pin || pin.length < 6) { toast('PIN must be 6+ digits', 'error'); return; }
      if (pin !== confirm) { toast('PINs do not match', 'error'); return; }

      var result = $('backup-result');
      result.innerHTML = '<div class="loading">Generating backup...</div>';

      try {
        // Derive AES key from PIN via PBKDF2
        var salt = crypto.getRandomValues(new Uint8Array(16));
        var iv = crypto.getRandomValues(new Uint8Array(12));
        var pinKey = await crypto.subtle.importKey(
          'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']
        );
        var aesKey = await crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
          pinKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
        );

        // Encrypt enrollment key
        var plaintext = new TextEncoder().encode(enrollmentKey);
        var encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: iv }, aesKey, plaintext
        );

        var card = {
          version: 2,
          walletId: walletId,
          salt: bytesToHex(salt),
          iv: bytesToHex(iv),
          encryptedKey: bytesToHex(new Uint8Array(encrypted)),
          createdAt: new Date().toISOString(),
        };

        var json = JSON.stringify(card, null, 2);
        result.innerHTML =
          '<div style="padding:12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-sm);margin-top:12px">' +
            '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">Recovery Card JSON — save this securely!</div>' +
            '<textarea class="form-input mono" rows="8" readonly style="font-size:11px">' + esc(json) + '</textarea>' +
            '<div class="form-actions" style="margin-top:8px">' +
              '<button class="btn btn-sm" id="backup-copy-btn">Copy to Clipboard</button>' +
              '<button class="btn btn-sm" id="backup-download-btn">Download</button>' +
            '</div>' +
          '</div>';

        $('backup-copy-btn').addEventListener('click', function () {
          navigator.clipboard.writeText(json).then(function () { toast('Copied!', 'success'); });
        });
        $('backup-download-btn').addEventListener('click', function () {
          var blob = new Blob([json], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'adjudagator-recovery-' + shortHash(walletId) + '.json';
          a.click();
          URL.revokeObjectURL(a.href);
        });

        logSystem('nfc_backup', 'Recovery card created', 'Encrypted backup generated');
        toast('Backup created!', 'success');
        $('backup-pin').value = '';
        $('backup-pin-confirm').value = '';
      } catch (e) {
        result.innerHTML = '<div style="color:var(--red);font-size:12px">Backup failed: ' + esc(e.message) + '</div>';
      }
    });

    // NFC Attestation
    var lastAttestation = null;

    $('attestation-btn').addEventListener('click', async function () {
      var result = $('attestation-result');
      result.innerHTML = '<div class="loading">Requesting attestation...</div>';
      $('nfc-write-btn').disabled = true;
      $('credential-download-btn').disabled = true;
      $('credential-copy-btn').disabled = true;
      try {
        var att = await RPC.requestAttestation(walletId, 86400);
        if (att) {
          lastAttestation = att;
          result.innerHTML =
            '<div style="padding:12px;background:var(--accent-dim);border:1px solid rgba(139,92,246,0.2);border-radius:var(--radius-sm)">' +
              '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">Attestation received</div>' +
              '<div style="font-size:12px">Expires: ' + fmtDate(att.expiry || att.expiresAt) + '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Signature: ' + shortHash(att.signature) + '</div>' +
              '<div style="font-size:11px;color:var(--text-muted)">Nonce: ' + (att.nonce || '--') + '</div>' +
            '</div>';
          // Enable NFC write, copy, and download buttons
          $('nfc-write-btn').disabled = false;
          $('credential-download-btn').disabled = false;
          $('credential-copy-btn').disabled = false;
          logSystem('attestation', 'NFC attestation received', 'Expires ' + fmtDate(att.expiry || att.expiresAt));
        } else {
          result.innerHTML = '<div class="empty-state">No attestation returned</div>';
        }
      } catch (e) {
        result.innerHTML = '<div style="color:var(--red);font-size:12px">Attestation failed: ' + esc(e.message) + '</div>';
      }
    });

    // Write credential to NFC tag (via adjudication server if available)
    $('nfc-write-btn').addEventListener('click', async function () {
      if (!lastAttestation) return;
      var result = $('attestation-result');
      result.innerHTML = '<div class="loading">Queuing NFC write...</div>';
      try {
        // Try the adjudication server's NFC write endpoint
        var seqUrl = lsGet(LS.SEQ_URL) || location.origin;
        var writeUrl = seqUrl.replace(/:\d+$/, ':3030') + '/interactive/nfc/write';
        var resp = await fetch(writeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletId: walletId }),
        });
        var data = await resp.json();
        if (data.status === 'queued' || data.ok) {
          result.innerHTML =
            '<div style="padding:12px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:var(--radius-sm)">' +
              '<div style="font-size:12px;color:var(--green)">NFC write queued — tap your tag to the reader</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Format: ' + (data.format || 'attestation') + '</div>' +
            '</div>';
          logSystem('nfc_write', 'NFC write queued', 'Format: ' + (data.format || 'attestation'));
        } else {
          throw new Error(data.error || 'NFC write failed');
        }
      } catch (e) {
        result.innerHTML =
          '<div style="padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:var(--radius-sm)">' +
            '<div style="font-size:12px;color:var(--red)">NFC write unavailable: ' + esc(e.message) + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Use "Download Credential" instead and transfer manually.</div>' +
          '</div>';
      }
    });

    // Download credential as JSON file
    $('credential-download-btn').addEventListener('click', function () {
      if (!lastAttestation) return;
      var credential = {
        type: 'credential-attestation',
        version: 2,
        walletId: walletId,
        attestation: lastAttestation,
        exportedAt: Date.now(),
      };
      var blob = new Blob([JSON.stringify(credential, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'zkpcare-credential-' + shortHash(walletId) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Credential downloaded!', 'success');
      logSystem('credential_export', 'Credential exported', 'File downloaded');
    });

    // Copy attestation JSON to clipboard (for pasting into pharmacy dashboard)
    $('credential-copy-btn').addEventListener('click', function () {
      if (!lastAttestation) return;
      var credential = {
        type: 'credential-attestation',
        version: 2,
        walletId: walletId,
        attestation: lastAttestation,
        exportedAt: Date.now(),
      };
      var json = JSON.stringify(credential, null, 2);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(json).then(function () {
          toast('Attestation copied to clipboard!', 'success');
          logSystem('credential_export', 'Attestation copied to clipboard', 'Ready to paste in pharmacy');
        }).catch(function () {
          fallbackCopy(json);
        });
      } else {
        fallbackCopy(json);
      }
    });

    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Attestation copied!', 'success');
    }
  }

  // ══════════════════════════════════════════════════════
  //  SETTINGS
  // ══════════════════════════════════════════════════════
  function loadSettings() {
    $('settings-seq-url').value = lsGet(LS.SEQ_URL) || '';
    $('settings-insurer-url').value = lsGet(LS.INSURER_URL) || '';
    $('settings-prover-url').value = lsGet(LS.PROVER_URL) || '';

    // Wallet info
    var info = $('settings-wallet-info');
    info.innerHTML =
      '<div style="font-size:12px">' +
        '<div style="margin-bottom:8px"><span class="stat-label">Wallet ID</span><br>' +
          '<span class="mono" style="word-break:break-all;font-size:11px;color:var(--accent)">' + esc(walletId) + '</span></div>' +
        '<div style="margin-bottom:8px"><span class="stat-label">Enrollment Key</span><br>' +
          '<span class="mono" style="font-size:11px;color:var(--text-muted)">' + esc(enrollmentKey.slice(0, 16) + '...(hidden)') + '</span></div>' +
        '<div><span class="stat-label">PCP</span><br>' +
          '<span style="font-size:12px">' + (pcpData && (pcpData.pcpWalletId || pcpData.walletId) ? shortHash(pcpData.pcpWalletId || pcpData.walletId) : 'Not assigned') + '</span></div>' +
      '</div>';
  }

  function setupSettings() {
    $('settings-save-btn').addEventListener('click', function () {
      var seqUrl = $('settings-seq-url').value.trim();
      var insUrl = $('settings-insurer-url').value.trim();
      var prUrl = $('settings-prover-url').value.trim();
      if (seqUrl) { lsSet(LS.SEQ_URL, seqUrl); RPC.setBaseUrl(seqUrl); }
      if (insUrl) { lsSet(LS.INSURER_URL, insUrl); RPC.setInsurerUrl(insUrl); }
      if (prUrl) { lsSet(LS.PROVER_URL, prUrl); RPC.setProverUrl(prUrl); }
      toast('Settings saved', 'success');
    });

    $('settings-logout-btn').addEventListener('click', function () {
      // Use the same ejectMember() flow that the onboarding "Start Over" link uses —
      // it calls the server to destroy the encrypted state file AND clears the frontend.
      ejectMember();
    });
  }

  // ══════════════════════════════════════════════════════
  //  SSE + POLLING
  // ══════════════════════════════════════════════════════
  function handleSSE(ev) {
    var type = ev.type || ev.event || '';
    // Update connection indicator
    setConnDot('connected');

    // If a batch settles or proof accepted involving our wallet, refresh
    if (type.indexOf('proof:accepted') >= 0 || type.indexOf('batch:settled') >= 0) {
      var data = ev.data || ev;
      var isOurs = data && (data.walletId === walletId || !data.walletId);

      if (isOurs) {
        if (currentTab === 'dashboard') {
          loadDashboard();
        } else if (currentTab === 'claims') {
          loadClaims();
        }
      }

      // Update member-specific status bar
      if (type.indexOf('proof:accepted') >= 0 && isOurs) {
        showSeqStatus('Your proof was accepted — awaiting batch settlement', true);
        refreshMyStatus();
      }
      if (type.indexOf('batch:settled') >= 0) {
        refreshMyStatus();
        if (isOurs) {
          showSeqStatus('Batch settled — your proof is finalized', false);
          setTimeout(hideSeqStatus, 10000);
        }
      }
    }
  }

  // ── Sequencer Status Bar (member-specific) ──────────
  var myProofStatus = { submitted: 0, accepted: 0, settled: 0, lastEvent: '' };

  function showSeqStatus(msg, active) {
    var bar = $('seq-status-bar');
    var icon = $('seq-status-icon');
    var text = $('seq-status-text');
    if (!bar || !icon || !text) return;
    bar.classList.remove('hidden');
    bar.classList.toggle('active', !!active);
    icon.className = 'seq-status-icon ' + (active ? 'proving' : 'idle');
    icon.textContent = '\u25CF';
    text.textContent = msg;
  }

  function hideSeqStatus() {
    var bar = $('seq-status-bar');
    if (bar) bar.classList.add('hidden');
  }

  /** Called when member submits a proof (enrollment, claim, etc.) */
  function onProofSubmitted(label) {
    myProofStatus.submitted++;
    myProofStatus.lastEvent = label || 'Proof submitted';
    showSeqStatus(myProofStatus.lastEvent + ' — waiting for sequencer to accept...', true);
  }

  function refreshMyStatus() {
    // Check receipts for our wallet to see what's been accepted/settled
    RPC.getReceiptsByWallet(walletId).then(function (receipts) {
      if (!Array.isArray(receipts)) receipts = [];
      var accepted = 0;
      var settled = 0;
      receipts.forEach(function (r) {
        if (r.l1Status === 'settled' || r.status === 'settled') settled++;
        else accepted++;
      });

      if (myProofStatus.submitted > 0 && accepted + settled > myProofStatus.accepted + myProofStatus.settled) {
        // A new receipt appeared for us
        myProofStatus.accepted = accepted;
        myProofStatus.settled = settled;
        if (settled > 0) {
          showSeqStatus(settled + ' proof(s) settled  \u00b7  ' + accepted + ' pending batch', false);
        } else if (accepted > 0) {
          showSeqStatus(accepted + ' proof(s) accepted — awaiting batch settlement', true);
        }
        // Auto-hide after 15s if nothing pending
        if (accepted === 0) {
          setTimeout(function () {
            if (myProofStatus.accepted === 0 || myProofStatus.settled >= myProofStatus.submitted) {
              hideSeqStatus();
            }
          }, 15000);
        }
      } else if (myProofStatus.submitted === 0 && receipts.length > 0) {
        // Show existing receipt count briefly on load then hide
        myProofStatus.accepted = accepted;
        myProofStatus.settled = settled;
      }
    }).catch(function () { /* sequencer unavailable */ });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      RPC.checkConnection().then(function (ok) {
        setConnDot(ok ? 'connected' : 'disconnected');
      });
      // Poll for our proof status if we have pending submissions
      if (myProofStatus.submitted > 0) {
        refreshMyStatus();
      }
    }, 10000);
  }

  // ══════════════════════════════════════════════════════
  //  WIRE UP
  // ══════════════════════════════════════════════════════
  function init() {
    setupLanding();
    setupRestore();
    setupBackup();
    setupSettings();

    // Nav routing
    qsa('#nav .nav-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var tab = this.getAttribute('data-tab');
        navigate(tab);
        history.pushState(null, '', '#' + tab);
      });
    });

    window.addEventListener('hashchange', function () {
      if (!isEnrolled()) return;
      var h = location.hash.replace('#', '');
      if (h && h !== currentTab) navigate(h);
    });

    // Claims search
    $('claims-search-btn').addEventListener('click', filterClaims);
    $('claims-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') filterClaims(); });
    $('claims-refresh').addEventListener('click', loadClaims);

    // Formulary search
    $('formulary-search-btn').addEventListener('click', filterFormulary);
    $('formulary-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') filterFormulary(); });

    // Provider filter/search
    $('provider-role-filter').addEventListener('change', function () { renderProviders(providersCache); });
    $('provider-search').addEventListener('input', function () { renderProviders(providersCache); });
    $('provider-refresh').addEventListener('click', loadProviders);

    // Compose
    $('msg-compose-btn').addEventListener('click', function () {
      $('compose-overlay').classList.remove('hidden');
    });
    $('compose-close').addEventListener('click', function () {
      $('compose-overlay').classList.add('hidden');
    });
    $('compose-send').addEventListener('click', sendMessage);

    // Inline thread reply
    var msgSendBtn = $('msg-send-btn');
    if (msgSendBtn) msgSendBtn.addEventListener('click', sendMsgInThread);
    var msgInputText = $('msg-input-text');
    if (msgInputText) msgInputText.addEventListener('keypress', function (e) { if (e.key === 'Enter') sendMsgInThread(); });

    // Boot
    boot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
