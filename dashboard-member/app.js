/**
 * zkp.Care Member Portal — Application Logic
 * Landing → Onboarding (6-step) → Restore → Main App (8 tabs)
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
    PCP:          'zkt_pcp',
    SYSTEM_LOG:   'zkt_systemLog',
    GRANTED:      'zkt_granted',
    PLAN_ID_HASH: 'zkt_planIdHash',
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
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  // ── System Log ───────────────────────────────────────
  function loadSystemLog() {
    systemLog = lsJson(LS.SYSTEM_LOG) || [];
  }

  function logSystem(type, summary, detail) {
    systemLog.unshift({ type: type, summary: summary, detail: detail || '', timestamp: Date.now() });
    if (systemLog.length > 100) systemLog.length = 100;
    lsSet(LS.SYSTEM_LOG, JSON.stringify(systemLog));
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

    loadSystemLog();

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
  //  ONBOARDING (7-step enrollment ceremony)
  // ══════════════════════════════════════════════════════
  var ONBOARD_TOTAL_STEPS = 7;
  var onboardStep = 0;
  var onboardState = {
    pin: '', tokenId: '', cardholderId: '', firstName: '', lastName: '', dob: '',
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

      case 1: // Token
        body.innerHTML =
          '<div class="onboard-title">Enrollment Token</div>' +
          '<div class="onboard-desc">Enter the enrollment token provided by your employer.</div>' +
          '<div class="form-group"><label>Token ID</label>' +
          '<input class="form-input mono" id="ob-token" placeholder="e.g. TOK-ABC-123" value="' + esc(onboardState.tokenId) + '"></div>' +
          '<div class="form-actions">' +
          '<button class="btn" id="ob-back">Back</button>' +
          '<button class="btn btn-primary" id="ob-next">Next</button></div>';
        $('ob-back').addEventListener('click', function () { onboardStep = 0; renderOnboardStep(); });
        $('ob-next').addEventListener('click', async function () {
          var v = $('ob-token').value.trim();
          if (!v) { toast('Token ID required', 'error'); return; }
          onboardState.tokenId = v;
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
          '<div class="onboard-desc">Your wallet has been registered on the zkp.Care network.</div>' +
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
      var deriveRes = await fetch(location.origin + '/onboarding/derive-wallet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardholderId: onboardState.cardholderId,
          dateOfBirth: onboardState.dob,
          firstName: onboardState.firstName,
          lastName: onboardState.lastName,
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
        body: JSON.stringify({}),
      }).then(function (r) { return r.json(); });
      if (!enrollRes.ok) throw new Error(enrollRes.error || 'Enrollment failed');

      // Step 2: Delegate proof generation (optional — may not be available)
      onboardState.statusMessage = 'Generating zero-knowledge proof...';
      if ($('ob-enroll-msg')) $('ob-enroll-msg').textContent = onboardState.statusMessage;
      try {
        var proofResult = await RPC.delegateProof('proveRegistration', {
          walletId: onboardState.walletId,
        });
        if (proofResult && proofResult.proofJson) {
          await RPC.submitProof(proofResult.proofJson, { walletId: onboardState.walletId, isRegistration: true });
        }
      } catch (e) {
        console.warn('Proof delegation skipped:', e.message);
      }

      // Step 3: Compile programs (transitions to ready)
      onboardState.statusMessage = 'Finalizing enrollment...';
      if ($('ob-enroll-msg')) $('ob-enroll-msg').textContent = onboardState.statusMessage;
      try {
        await fetch(location.origin + '/onboarding/compile', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).then(function (r) { return r.json(); });
      } catch (e) {
        console.warn('Compile skipped:', e.message);
      }

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
          throw new Error('Invalid recovery card format');
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
    // PCP nudge
    var pcp = lsJson(LS.PCP);
    var nudge = $('pcp-nudge');
    if (pcp && pcp.walletId) {
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
      var dedPaid = Number(acc.deductibleCreditCents || acc.totalDeductibleCredit || 0);
      var oopPaid = Number(acc.patientPayCents || acc.totalPatientPay || 0);
      var planPaid = Number(acc.planPayCents || acc.totalPlanPay || 0);
      var dedMax = 150000; // $1500
      var oopMax = 500000; // $5000
      var dedPct = Math.min(100, (dedPaid / dedMax * 100));
      var oopPct = Math.min(100, (oopPaid / oopMax * 100));

      container.innerHTML =
        '<div class="spend-row">' +
        '<div class="spend-item">' +
          '<div class="spend-label">Deductible</div>' +
          '<div class="spend-amounts"><span class="spend-current">' + fmtCents(dedPaid) + '</span>' +
          '<span class="spend-max">of ' + fmtCents(dedMax) + '</span></div>' +
          '<div class="progress-bar"><div class="progress-fill ' + progressClass(dedPct) + '" style="width:' + dedPct + '%"></div></div>' +
        '</div>' +
        '<div class="spend-item">' +
          '<div class="spend-label">Out-of-Pocket</div>' +
          '<div class="spend-amounts"><span class="spend-current">' + fmtCents(oopPaid) + '</span>' +
          '<span class="spend-max">of ' + fmtCents(oopMax) + '</span></div>' +
          '<div class="progress-bar"><div class="progress-fill ' + progressClass(oopPct) + '" style="width:' + oopPct + '%"></div></div>' +
        '</div>' +
        '<div class="spend-item">' +
          '<div class="spend-label">Plan Benefit Used</div>' +
          '<div class="spend-amounts"><span class="spend-current">' + fmtCents(planPaid) + '</span></div>' +
        '</div>' +
        '</div>';
    } catch {
      container.innerHTML = '<div class="spend-hero-loading">Spend data unavailable</div>';
    }
  }

  async function loadDashStats() {
    try {
      var claims = await RPC.getClaimsByMember(walletId);
      if (!Array.isArray(claims)) claims = [];
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
        var claims = await RPC.getClaimsByMember(walletId);
        if (!Array.isArray(claims)) claims = [];
        claimsCache = claims;
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

      html += '<div class="claim-card">' +
        '<div class="claim-icon' + (isReversal ? ' reversal' : '') + '">' + (isReversal ? 'REV' : 'Rx') + '</div>' +
        '<div class="claim-info">' +
          '<div class="claim-drug">' + esc(drug) + '</div>' +
          '<div class="claim-meta">' + esc(pharmacy) + ' &middot; ' + esc(date) +
          (details.length ? ' &middot; ' + esc(details.join(', ')) : '') + '</div>' +
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
  async function loadClaims() {
    var container = $('claims-list');
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var claims = await RPC.getClaimsByMember(walletId);
      if (!Array.isArray(claims)) claims = [];
      claimsCache = claims;

      // Stats
      var fills = 0, reversals = 0, controlled = 0, totalPat = 0;
      claims.forEach(function (c) {
        var leaf = c.leaf || c.claimLeaf || c;
        var meta = c.metadata || {};
        if (String(leaf.operationType) === '2') reversals++;
        else fills++;
        if (meta.deaSchedule && meta.deaSchedule !== '0') controlled++;
        totalPat += Number(leaf.patientPayCents || 0);
      });
      $('claims-stats').innerHTML =
        statCard('Fills', fills) +
        statCard('Reversals', reversals) +
        statCard('Controlled', controlled) +
        statCard('You Paid', fmtCents(totalPat));

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
  async function loadFormulary() {
    var container = $('formulary-table');
    container.innerHTML = '<div class="loading">Loading formulary...</div>';
    try {
      var planIdHash = lsGet(LS.PLAN_ID_HASH) || '';
      var result = await RPC.getFormulary(planIdHash);
      var entries = [];
      if (result && result.entriesJson) {
        try { entries = JSON.parse(result.entriesJson); } catch { entries = []; }
      } else if (Array.isArray(result)) {
        entries = result;
      } else if (result && result.entries) {
        entries = result.entries;
      }
      formularyCache = entries;

      $('formulary-stats').innerHTML =
        statCard('Medications', entries.length) +
        statCard('Generic Available', entries.filter(function (e) { return e.genericName; }).length) +
        statCard('Prior Auth Required', entries.filter(function (e) { return e.requiresPriorAuth; }).length) +
        statCard('Controlled', entries.filter(function (e) { return e.deaSchedule && e.deaSchedule !== '0'; }).length);

      renderFormularyTable(entries);
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Formulary unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function renderFormularyTable(entries) {
    if (!entries.length) {
      $('formulary-table').innerHTML = '<div class="empty-state">No formulary entries</div>';
      return;
    }
    var html = '<table class="data-table"><thead><tr>' +
      '<th>Drug</th><th>Generic</th><th>Tier</th><th>Copay</th><th>Form</th><th>Supply</th><th>PA</th><th>DEA</th></tr></thead><tbody>';
    entries.forEach(function (e) {
      html += '<tr>' +
        '<td><strong>' + esc(e.brandName || '--') + '</strong></td>' +
        '<td>' + esc(e.genericName || '--') + '</td>' +
        '<td>' + tierBadge(e.tierLevel) + '</td>' +
        '<td class="mono">' + fmtCents(e.copayAmountCents) + '</td>' +
        '<td>' + esc(e.dosageForm || '--') + '</td>' +
        '<td class="mono">' + (e.maxDaySupply || '--') + 'd</td>' +
        '<td>' + (e.requiresPriorAuth ? '<span class="badge badge-warning">PA</span>' : '--') + '</td>' +
        '<td>' + (e.deaSchedule && e.deaSchedule !== '0' ? '<span class="badge badge-error">C-' + e.deaSchedule + '</span>' : '--') + '</td></tr>';
    });
    html += '</tbody></table>';
    $('formulary-table').innerHTML = html;
  }

  function filterFormulary() {
    var q = ($('formulary-search').value || '').toLowerCase().trim();
    if (!q) { renderFormularyTable(formularyCache); return; }
    var filtered = formularyCache.filter(function (e) {
      return (e.brandName || '').toLowerCase().indexOf(q) >= 0 ||
             (e.genericName || '').toLowerCase().indexOf(q) >= 0 ||
             (e.ndc || '').indexOf(q) >= 0 ||
             (e.therapeuticClass || '').toLowerCase().indexOf(q) >= 0;
    });
    renderFormularyTable(filtered);
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
      var dedPaid = Number(acc.deductibleCreditCents || acc.totalDeductibleCredit || 0);
      var oopPaid = Number(acc.patientPayCents || acc.totalPatientPay || 0);
      var planPaid = Number(acc.planPayCents || acc.totalPlanPay || 0);
      var claimCount = acc.claimCount || acc.totalClaims || 0;

      accEl.innerHTML =
        '<div class="stats-grid">' +
        statCard('Deductible Used', fmtCents(dedPaid)) +
        statCard('Out-of-Pocket', fmtCents(oopPaid)) +
        statCard('Plan Benefit', fmtCents(planPaid)) +
        statCard('Total Claims', claimCount) +
        '</div>';
    } catch {
      accEl.innerHTML = '<div class="empty-state">Accumulator data unavailable</div>';
    }

    // Tiers from formulary
    var tierEl = $('plan-tiers');
    tierEl.innerHTML = '<div class="loading">Loading...</div>';
    try {
      if (!formularyCache.length) {
        var planIdHash = lsGet(LS.PLAN_ID_HASH) || '';
        var result = await RPC.getFormulary(planIdHash);
        if (result && result.entriesJson) {
          try { formularyCache = JSON.parse(result.entriesJson); } catch {}
        } else if (Array.isArray(result)) {
          formularyCache = result;
        } else if (result && result.entries) {
          formularyCache = result.entries;
        }
      }
      if (formularyCache.length) {
        var tiers = {};
        formularyCache.forEach(function (e) {
          var t = Number(e.tierLevel) || 0;
          if (!tiers[t]) tiers[t] = { count: 0, totalPrice: 0, drugs: [] };
          tiers[t].count++;
          tiers[t].totalPrice += Number(e.pricePerUnit || 0);
          if (tiers[t].drugs.length < 3) tiers[t].drugs.push(e.brandName || e.genericName || 'Unknown');
        });
        var html = '';
        [1, 2, 3, 4].forEach(function (t) {
          var d = tiers[t];
          if (!d) return;
          var avg = d.count ? fmtCents(d.totalPrice / d.count) : '--';
          html += '<div style="margin-bottom:14px">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
            tierBadge(t) + '<strong>' + d.count + ' medications</strong></div>' +
            '<div style="font-size:11px;color:var(--text-secondary)">Avg price/unit: ' + avg + '</div>' +
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

      // PCP display
      var pcp = lsJson(LS.PCP);
      renderPcp(pcp);
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Providers unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function renderPcp(pcp) {
    var body = $('pcp-body');
    if (!pcp || !pcp.walletId) {
      body.innerHTML = '<div class="empty-state">No PCP assigned. Select a prescriber below to assign as PCP.</div>';
      return;
    }
    // Find provider name
    var name = shortHash(pcp.walletId);
    providersCache.forEach(function (p) {
      if (p.walletId === pcp.walletId) name = p.displayName || name;
    });
    body.innerHTML = '<div class="provider-card">' +
      '<div class="provider-avatar">' + name.slice(0, 2).toUpperCase() + '</div>' +
      '<div class="provider-info">' +
        '<div class="provider-name">' + esc(name) + '</div>' +
        '<div class="provider-sub">Assigned ' + fmtDate(pcp.effectiveDate || pcp.timestamp) + '</div>' +
      '</div>' +
      '<button class="btn btn-sm btn-danger" onclick="window._removePcp()">Remove</button></div>';
  }

  window._removePcp = function () {
    lsRemove(LS.PCP);
    logSystem('pcp_remove', 'PCP removed', '');
    toast('PCP removed', 'info');
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

  window._assignPcp = function (wid) {
    var pcp = { walletId: wid, effectiveDate: new Date().toISOString(), timestamp: Date.now() };
    lsSet(LS.PCP, JSON.stringify(pcp));
    // Persist to backend
    RPC.assignPcp(wid).catch(function(e) { console.warn('PCP backend persist failed:', e.message); });
    logSystem('pcp_assign', 'PCP assigned', shortHash(wid));
    toast('PCP assigned', 'success');
    renderPcp(pcp);
    var nudge = $('pcp-nudge');
    if (nudge) nudge.classList.add('hidden');
  };

  window._msgProvider = function (wid) {
    navigate('messages');
    setTimeout(function () {
      $('compose-overlay').classList.remove('hidden');
      $('compose-recipient').value = wid;
    }, 100);
  };

  // ══════════════════════════════════════════════════════
  //  MESSAGES
  // ══════════════════════════════════════════════════════
  async function loadMessages() {
    var container = $('msg-content');
    container.innerHTML = '<div class="loading">Loading messages...</div>';
    try {
      var msgs = await RPC.getMessagesByWallet(walletId);
      if (!Array.isArray(msgs)) msgs = [];
      messagesCache = msgs;
      renderMessageTab(currentMsgTab);
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Messages unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function renderMessageTab(tab) {
    currentMsgTab = tab;
    qsa('.msg-tab').forEach(function (t) { t.classList.remove('active'); });
    var activeTab = qs('.msg-tab[data-msgtab="' + tab + '"]');
    if (activeTab) activeTab.classList.add('active');

    var container = $('msg-content');
    switch (tab) {
      case 'inbox': renderInbox(); break;
      case 'sent': renderSent(); break;
      case 'system': renderSystemLog(); break;
    }
  }

  function renderInbox() {
    var container = $('msg-content');
    var inbox = messagesCache.filter(function (m) {
      var msg = m.message || m;
      return msg.recipientWalletId === walletId;
    });
    if (!inbox.length) {
      container.innerHTML = '<div class="empty-state">No messages received</div>';
      return;
    }
    // Group by thread
    var threads = {};
    inbox.forEach(function (m) {
      var msg = m.message || m;
      var tid = msg.threadIdHash || 'unknown';
      if (!threads[tid]) threads[tid] = [];
      threads[tid].push(m);
    });
    var html = '';
    Object.keys(threads).forEach(function (tid) {
      var msgs = threads[tid];
      var last = msgs[msgs.length - 1];
      var msg = last.message || last;
      var payload = last.payload || {};
      var peer = msg.senderWalletId || '--';
      // Find provider name
      var peerName = shortHash(peer);
      providersCache.forEach(function (p) {
        if (p.walletId === peer) peerName = p.displayName || peerName;
      });
      html += '<div class="msg-item" onclick="window._showThread(\'' + esc(tid) + '\')">' +
        '<div class="msg-item-header">' +
          '<span class="msg-item-peer">' + esc(peerName) + '</span>' +
          '<span class="msg-item-time">' + fmtTime(payload.timestamp || last.timestamp) + '</span>' +
        '</div>' +
        '<div class="msg-item-preview">' + msgs.length + ' message' + (msgs.length > 1 ? 's' : '') + ' &middot; [Encrypted]</div></div>';
    });
    container.innerHTML = html;
  }

  function renderSent() {
    var container = $('msg-content');
    var sent = messagesCache.filter(function (m) {
      var msg = m.message || m;
      return msg.senderWalletId === walletId;
    });
    if (!sent.length) {
      container.innerHTML = '<div class="empty-state">No messages sent</div>';
      return;
    }
    var html = '';
    sent.forEach(function (m) {
      var msg = m.message || m;
      var payload = m.payload || {};
      var peer = msg.recipientWalletId || '--';
      var peerName = shortHash(peer);
      providersCache.forEach(function (p) {
        if (p.walletId === peer) peerName = p.displayName || peerName;
      });
      html += '<div class="msg-item">' +
        '<div class="msg-item-header">' +
          '<span class="msg-item-peer">To: ' + esc(peerName) + '</span>' +
          '<span class="msg-item-time">' + fmtTime(payload.timestamp || m.timestamp) + '</span>' +
        '</div>' +
        '<div class="msg-item-preview">[Encrypted message]</div></div>';
    });
    container.innerHTML = html;
  }

  function renderSystemLog() {
    var container = $('msg-content');
    loadSystemLog();
    if (!systemLog.length) {
      container.innerHTML = '<div class="empty-state">No system activity</div>';
      return;
    }
    var html = '';
    systemLog.slice(0, 50).forEach(function (ev) {
      var typeColors = {
        enrollment: 'var(--green)', pcp_assign: 'var(--blue)', pcp_remove: 'var(--yellow)',
        access_grant: 'var(--teal)', message_sent: 'var(--accent)', nfc_backup: 'var(--orange)',
        restore: 'var(--green)', attestation: 'var(--teal)',
      };
      var color = typeColors[ev.type] || 'var(--text-muted)';
      html += '<div class="msg-bubble system">' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0"></span>' +
          '<strong style="font-size:11px;text-transform:uppercase">' + esc(ev.type || 'event') + '</strong>' +
        '</div>' +
        '<div style="margin-top:4px">' + esc(ev.summary) + '</div>' +
        (ev.detail ? '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">' + esc(ev.detail) + '</div>' : '') +
        '<div class="msg-bubble-time">' + fmtDate(ev.timestamp) + '</div></div>';
    });
    container.innerHTML = html;
  }

  window._showThread = async function (threadHash) {
    var container = $('msg-content');
    container.innerHTML = '<div class="loading">Loading thread...</div>';
    try {
      var msgs = await RPC.getMessagesByThread(threadHash);
      if (!Array.isArray(msgs)) msgs = [];
      if (!msgs.length) { container.innerHTML = '<div class="empty-state">Thread empty</div>'; return; }

      var html = '<div style="margin-bottom:12px"><button class="btn btn-sm" onclick="window._backToInbox()">Back to Inbox</button></div>';
      msgs.forEach(function (m) {
        var msg = m.message || m;
        var payload = m.payload || {};
        var isSent = msg.senderWalletId === walletId;
        var peerName = shortHash(isSent ? msg.recipientWalletId : msg.senderWalletId);
        providersCache.forEach(function (p) {
          if (p.walletId === (isSent ? msg.recipientWalletId : msg.senderWalletId)) peerName = p.displayName || peerName;
        });

        html += '<div class="msg-bubble ' + (isSent ? 'sent' : 'received') + '">' +
          '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">' +
          (isSent ? 'You' : esc(peerName)) + '</div>' +
          '<div>[Encrypted message]</div>' +
          '<div class="msg-bubble-time">' + fmtTime(payload.timestamp || m.timestamp) + '</div></div>';
      });
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  };

  window._backToInbox = function () { renderMessageTab('inbox'); };

  // ── Compose ────────────────────────────────────────
  async function sendMessage() {
    var recipient = $('compose-recipient').value.trim();
    var body = $('compose-body').value.trim();
    if (!recipient || !body) { toast('Recipient and message required', 'error'); return; }

    try {
      // Client-side AES-256-GCM encryption
      var aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var plaintext = new TextEncoder().encode(body);
      var encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, aesKey, plaintext);
      var encBytes = new Uint8Array(encrypted);
      // Last 16 bytes = auth tag
      var ciphertext = bytesToHex(encBytes.slice(0, encBytes.length - 16));
      var tag = bytesToHex(encBytes.slice(encBytes.length - 16));
      var ivHex = bytesToHex(iv);
      var timestamp = Date.now();

      // Compute thread ID hash (sorted wallet pair — simplified hash for web)
      var sorted = [walletId, recipient].sort();
      var threadSeed = sorted.join(':');
      var threadBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(threadSeed));
      var threadIdHash = BigInt('0x' + bytesToHex(new Uint8Array(threadBuf)).slice(0, 62)).toString();

      // Compute message commitment
      var commitSeed = walletId + ':' + recipient + ':' + timestamp;
      var commitBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(commitSeed));
      var messageCommitment = BigInt('0x' + bytesToHex(new Uint8Array(commitBuf)).slice(0, 62)).toString();

      var message = {
        messageCommitment: messageCommitment,
        senderWalletId: walletId,
        recipientWalletId: recipient,
        messageType: '1', // Clinical
        threadIdHash: threadIdHash,
      };
      var payload = {
        ciphertext: ciphertext,
        iv: ivHex,
        tag: tag,
        timestamp: timestamp,
      };

      await RPC.storeMessage(message, payload);

      // Close compose, log, refresh
      $('compose-overlay').classList.add('hidden');
      $('compose-recipient').value = '';
      $('compose-body').value = '';
      logSystem('message_sent', 'Message sent', 'To ' + shortHash(recipient));
      toast('Message sent (encrypted)', 'success');
      loadMessages();
    } catch (e) {
      toast('Send failed: ' + e.message, 'error');
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
          a.download = 'zktrident-recovery-' + shortHash(walletId) + '.json';
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
          // Enable NFC write and download buttons
          $('nfc-write-btn').disabled = false;
          $('credential-download-btn').disabled = false;
          logSystem('attestation', 'NFC attestation received', 'Expires ' + fmtDate(att.expiry || att.expiresAt));
        } else {
          result.innerHTML = '<div class="empty-state">No attestation returned</div>';
        }
      } catch (e) {
        result.innerHTML = '<div style="color:var(--red);font-size:12px">Attestation failed: ' + esc(e.message) + '</div>';
      }
    });

    // Write credential to NFC tag (via interactive demo server if available)
    $('nfc-write-btn').addEventListener('click', async function () {
      if (!lastAttestation) return;
      var result = $('attestation-result');
      result.innerHTML = '<div class="loading">Queuing NFC write...</div>';
      try {
        // Try the interactive demo server's NFC write endpoint
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
          '<span style="font-size:12px">' + (lsJson(LS.PCP) ? shortHash(lsJson(LS.PCP).walletId) : 'Not assigned') + '</span></div>' +
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
      if (!confirm('This will clear all local state including your wallet and enrollment key. This cannot be undone unless you have a backup. Continue?')) return;
      Object.values(LS).forEach(function (k) { lsRemove(k); });
      walletId = '';
      enrollmentKey = '';
      if (pollTimer) clearInterval(pollTimer);
      RPC.disconnectSSE();
      showScreen('landing-screen');
      toast('Local state cleared', 'info');
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
      if (data && (data.walletId === walletId || !data.walletId)) {
        if (currentTab === 'dashboard') {
          loadDashboard();
        } else if (currentTab === 'claims') {
          loadClaims();
        }
      }
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      RPC.checkConnection().then(function (ok) {
        setConnDot(ok ? 'connected' : 'disconnected');
      });
    }, 30000);
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

    // Message tabs
    qsa('.msg-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        renderMessageTab(this.getAttribute('data-msgtab'));
      });
    });

    // Compose
    $('msg-compose-btn').addEventListener('click', function () {
      $('compose-overlay').classList.remove('hidden');
    });
    $('compose-close').addEventListener('click', function () {
      $('compose-overlay').classList.add('hidden');
    });
    $('compose-send').addEventListener('click', sendMessage);

    // Boot
    boot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
