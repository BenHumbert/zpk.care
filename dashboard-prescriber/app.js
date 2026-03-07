/**
 * zkTrident Prescriber Dashboard — SPA with hash-based routing.
 */
(() => {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let currentTab = 'overview';
  let onboardingPhase = 'awaiting_token';
  let walletId = null;
  let sseEvents = [];
  let refreshTimer = null;
  const MAX_EVENTS = 100;

  // ── Helpers ──────────────────────────────────────────────────

  function $(sel) { return document.querySelector(sel); }
  function $id(id) { return document.getElementById(id); }
  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  function truncHash(h, n) {
    if (!h) return '--';
    const s = String(h);
    if (s.length <= (n || 16)) return s;
    return s.slice(0, 8) + '...' + s.slice(-6);
  }
  function fmtTime(ts) {
    if (!ts) return '--';
    const d = new Date(typeof ts === 'number' ? ts : ts);
    return d.toLocaleTimeString();
  }
  function fmtDate(ts) {
    if (!ts) return '--';
    const d = new Date(typeof ts === 'number' ? ts : ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }
  function fmtYMD(s) {
    if (!s || s.length !== 8) return s || '--';
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }

  function toast(msg, type) {
    const container = $id('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => { el.remove(); }, 4000);
  }

  // ── Router ───────────────────────────────────────────────────

  function getHash() {
    const h = location.hash.replace(/^#\/?/, '') || 'overview';
    return h.split('/')[0];
  }

  function navigate() {
    const tab = getHash();
    currentTab = tab;
    // Update nav
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.tab === tab);
    });
    renderPage(tab);
  }

  window.addEventListener('hashchange', navigate);

  // ── Page Rendering ───────────────────────────────────────────

  function renderPage(tab) {
    const main = $id('mainContent');
    switch (tab) {
      case 'overview': renderOverview(main); break;
      case 'onboarding': renderOnboarding(main); break;
      case 'prescriptions': renderPrescriptions(main); break;
      case 'formulary': renderFormulary(main); break;
      case 'messaging': renderMessaging(main); break;
      case 'proofs': renderProofs(main); break;
      default: renderOverview(main); break;
    }
  }

  // ── Overview ─────────────────────────────────────────────────

  async function renderOverview(el) {
    el.innerHTML = `
      <div class="stats-grid" id="overviewStats">
        <div class="stat-card stat-accent">
          <div class="stat-label">Phase</div>
          <div class="stat-value small" id="ovPhase">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Wallet ID</div>
          <div class="stat-value small" id="ovWallet">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Prescriptions</div>
          <div class="stat-value" id="ovTotalRx">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unique Patients</div>
          <div class="stat-value" id="ovPatients">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unique Pharmacies</div>
          <div class="stat-value" id="ovPharmacies">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">PCP Patients</div>
          <div class="stat-value" id="ovPcpCount">--</div>
        </div>
      </div>

      <div class="panels-row">
        <div class="panel">
          <div class="panel-header">
            <h2>Activity Summary</h2>
          </div>
          <div class="panel-body" id="ovSummary">
            <div class="loading">Loading...</div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>Medication Breakdown</h2>
          </div>
          <div class="panel-body" id="ovMedBreakdown">
            <div class="loading">Loading...</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Live Events</h2>
          <span class="badge badge-live" id="ovSseBadge">SSE</span>
        </div>
        <div class="panel-body event-log" id="ovEventLog">
          <div class="event-placeholder">Waiting for events...</div>
        </div>
      </div>
    `;

    loadOverviewData();
  }

  async function loadOverviewData() {
    // Phase + wallet
    try {
      const status = await API.getOnboardingStatus();
      onboardingPhase = status.phase || 'awaiting_token';
      walletId = status.walletId || null;
      updateHeaderWallet();

      const phaseEl = $id('ovPhase');
      if (phaseEl) phaseEl.textContent = onboardingPhase;
      const walletEl = $id('ovWallet');
      if (walletEl) walletEl.textContent = truncHash(walletId, 20);
    } catch { /* node may not be ready */ }

    // Stats (only when node is initialized)
    try {
      const summary = await API.getPrescriptionSummary();
      if ($id('ovTotalRx')) $id('ovTotalRx').textContent = summary.totalPrescriptions ?? summary.total ?? '0';

      // Summary panel
      const ovSummary = $id('ovSummary');
      if (ovSummary && summary) {
        const keys = Object.keys(summary);
        if (keys.length > 0) {
          ovSummary.innerHTML = '<div class="detail-grid">' +
            keys.map(k => `<div class="detail-key">${esc(k)}</div><div class="detail-val">${esc(summary[k])}</div>`).join('') +
            '</div>';
        } else {
          ovSummary.innerHTML = '<div class="no-data">No activity yet</div>';
        }
      }
    } catch {
      const ovSummary = $id('ovSummary');
      if (ovSummary) ovSummary.innerHTML = '<div class="no-data">Node not initialized -- complete onboarding first</div>';
    }

    try {
      const pc = await API.getPatientCount();
      if ($id('ovPatients')) $id('ovPatients').textContent = pc.count ?? '0';
    } catch {
      if ($id('ovPatients')) $id('ovPatients').textContent = '0';
    }

    try {
      const phc = await API.getPharmacyCount();
      if ($id('ovPharmacies')) $id('ovPharmacies').textContent = phc.count ?? '0';
    } catch {
      if ($id('ovPharmacies')) $id('ovPharmacies').textContent = '0';
    }

    try {
      const pcp = await API.getPcpPatients();
      if ($id('ovPcpCount')) $id('ovPcpCount').textContent = pcp.count ?? '0';
    } catch {
      if ($id('ovPcpCount')) $id('ovPcpCount').textContent = '0';
    }

    // Medication breakdown
    try {
      const breakdown = await API.getMedicationBreakdown();
      const mbEl = $id('ovMedBreakdown');
      if (mbEl) {
        if (Array.isArray(breakdown) && breakdown.length > 0) {
          mbEl.innerHTML = '<table class="data-table"><thead><tr><th>NDC Hash</th><th>Count</th></tr></thead><tbody>' +
            breakdown.map(b => `<tr><td><span class="hash">${esc(b.ndcHash || b.ndc)}</span></td><td>${esc(b.count)}</td></tr>`).join('') +
            '</tbody></table>';
        } else if (typeof breakdown === 'object' && !Array.isArray(breakdown)) {
          const entries = Object.entries(breakdown);
          if (entries.length > 0) {
            mbEl.innerHTML = '<table class="data-table"><thead><tr><th>NDC Hash</th><th>Count</th></tr></thead><tbody>' +
              entries.map(([k, v]) => `<tr><td><span class="hash">${esc(k)}</span></td><td>${esc(v)}</td></tr>`).join('') +
              '</tbody></table>';
          } else {
            mbEl.innerHTML = '<div class="no-data">No medications prescribed yet</div>';
          }
        } else {
          mbEl.innerHTML = '<div class="no-data">No medications prescribed yet</div>';
        }
      }
    } catch {
      const mbEl = $id('ovMedBreakdown');
      if (mbEl) mbEl.innerHTML = '<div class="no-data">Node not initialized</div>';
    }

    // Render SSE event log
    renderEventLog();
  }

  function renderEventLog() {
    const el = $id('ovEventLog');
    if (!el) return;
    if (sseEvents.length === 0) {
      el.innerHTML = '<div class="event-placeholder">Waiting for events...</div>';
      return;
    }
    el.innerHTML = sseEvents.map(ev => `
      <div class="event-item">
        <span class="event-time">${fmtTime(ev.timestamp || ev.ts)}</span>
        <span class="event-type">${esc(ev.type || ev.event || 'event')}</span>
        <span class="event-data">${esc(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data || ev))}</span>
      </div>
    `).join('');
    el.scrollTop = el.scrollHeight;
  }

  // ── Onboarding ───────────────────────────────────────────────

  const ONBOARDING_STEPS = [
    { id: 'accept-token', label: 'Accept Token', phase: 'awaiting_token' },
    { id: 'generate-key', label: 'Generate Key', phase: 'token_received' },
    { id: 'derive-wallet', label: 'Derive Wallet', phase: 'key_generated' },
    { id: 'enroll', label: 'Enroll', phase: 'wallet_derived' },
    { id: 'compile', label: 'Compile', phase: 'enrolled' },
    { id: 'ready', label: 'Ready', phase: 'ready' },
  ];

  const PHASE_ORDER = ['awaiting_token', 'token_received', 'key_generated', 'wallet_derived', 'enrolled', 'compiling', 'ready'];

  function phaseIndex(phase) {
    const idx = PHASE_ORDER.indexOf(phase);
    return idx >= 0 ? idx : 0;
  }

  function activeStepIndex() {
    const pi = phaseIndex(onboardingPhase);
    // Map phase to step index
    if (pi <= 0) return 0;
    if (pi === 1) return 1;
    if (pi === 2) return 2;
    if (pi === 3) return 3;
    if (pi === 4 || pi === 5) return 4;
    return 5;
  }

  async function renderOnboarding(el) {
    // Fetch current status first
    try {
      const status = await API.getOnboardingStatus();
      onboardingPhase = status.phase || 'awaiting_token';
      walletId = status.walletId || null;
      updateHeaderWallet();
    } catch { /* keep current */ }

    const asi = activeStepIndex();

    el.innerHTML = `
      <h1 class="page-title">Onboarding Wizard</h1>
      <div class="wizard">
        <div class="wizard-progress">
          ${ONBOARDING_STEPS.map((step, i) => {
            let cls = '';
            if (i < asi) cls = 'completed';
            else if (i === asi && onboardingPhase !== 'ready') cls = 'active';
            else if (onboardingPhase === 'ready') cls = 'completed';
            return `<div class="wizard-step-indicator ${cls}">
              <span class="step-number">${i + 1}</span>
              <span class="step-label">${step.label}</span>
            </div>`;
          }).join('')}
        </div>
        <div id="wizardContent"></div>
      </div>
    `;

    renderWizardStep(asi);
  }

  function renderWizardStep(stepIdx) {
    const content = $id('wizardContent');
    if (!content) return;

    switch (stepIdx) {
      case 0: renderStepAcceptToken(content); break;
      case 1: renderStepGenerateKey(content); break;
      case 2: renderStepDeriveWallet(content); break;
      case 3: renderStepEnroll(content); break;
      case 4: renderStepCompile(content); break;
      case 5: renderStepReady(content); break;
    }
  }

  function renderStepAcceptToken(el) {
    const disabled = phaseIndex(onboardingPhase) > 0;
    el.innerHTML = `
      <div class="wizard-card">
        <h3>Step 1: Accept Enrollment Token</h3>
        <p class="step-desc">Enter the enrollment token provided by your employer or group administrator.</p>
        <div class="form-group">
          <label class="form-label">Token ID (required)</label>
          <input type="text" class="form-input" id="wizTokenId" placeholder="e.g. TOKEN-RX-001" ${disabled ? 'disabled' : ''}>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Group ID</label>
            <input type="text" class="form-input" id="wizGroupId" placeholder="Optional" ${disabled ? 'disabled' : ''}>
          </div>
          <div class="form-group">
            <label class="form-label">Plan ID</label>
            <input type="text" class="form-input" id="wizPlanId" placeholder="Optional" ${disabled ? 'disabled' : ''}>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Valid Until</label>
          <input type="text" class="form-input" id="wizValidUntil" placeholder="Optional (e.g. 2026-12-31)" ${disabled ? 'disabled' : ''}>
        </div>
        <div class="wizard-actions">
          <button class="btn btn-primary" id="wizAcceptBtn" ${disabled ? 'disabled' : ''}>Accept Token</button>
        </div>
        <div id="wizAcceptResult"></div>
      </div>
    `;
    if (!disabled) {
      $id('wizAcceptBtn').addEventListener('click', async () => {
        const tokenId = $id('wizTokenId').value.trim();
        if (!tokenId) { toast('Token ID is required', 'error'); return; }
        const groupId = $id('wizGroupId').value.trim();
        const planId = $id('wizPlanId').value.trim();
        const validUntil = $id('wizValidUntil').value.trim();
        $id('wizAcceptBtn').disabled = true;
        $id('wizAcceptBtn').textContent = 'Accepting...';
        try {
          const res = await API.acceptToken(tokenId, groupId, planId, validUntil);
          onboardingPhase = res.phase;
          $id('wizAcceptResult').innerHTML = `<div class="wizard-result success">Token accepted. Phase: ${esc(res.phase)}</div>`;
          toast('Token accepted', 'success');
          setTimeout(() => renderOnboarding($id('mainContent')), 800);
        } catch (err) {
          $id('wizAcceptResult').innerHTML = `<div class="wizard-result error">${esc(err.message)}</div>`;
          $id('wizAcceptBtn').disabled = false;
          $id('wizAcceptBtn').textContent = 'Accept Token';
        }
      });
    }
  }

  function renderStepGenerateKey(el) {
    const disabled = phaseIndex(onboardingPhase) > 1;
    const notReady = phaseIndex(onboardingPhase) < 1;
    el.innerHTML = `
      <div class="wizard-card">
        <h3>Step 2: Generate Enrollment Key</h3>
        <p class="step-desc">Generate a cryptographic enrollment key. This key is created on your device and never transmitted. It is mixed into your wallet derivation for 2FA security.</p>
        ${notReady ? '<div class="wizard-result">Complete Step 1 first.</div>' : ''}
        <div class="wizard-actions">
          <button class="btn btn-primary" id="wizGenKeyBtn" ${disabled || notReady ? 'disabled' : ''}>Generate Key</button>
        </div>
        <div id="wizGenKeyResult"></div>
      </div>
    `;
    if (!disabled && !notReady) {
      $id('wizGenKeyBtn').addEventListener('click', async () => {
        $id('wizGenKeyBtn').disabled = true;
        $id('wizGenKeyBtn').textContent = 'Generating...';
        try {
          const res = await API.generateKey();
          onboardingPhase = res.phase;
          $id('wizGenKeyResult').innerHTML = `<div class="wizard-result success">Enrollment key generated securely on device. Phase: ${esc(res.phase)}</div>`;
          toast('Enrollment key generated', 'success');
          setTimeout(() => renderOnboarding($id('mainContent')), 800);
        } catch (err) {
          $id('wizGenKeyResult').innerHTML = `<div class="wizard-result error">${esc(err.message)}</div>`;
          $id('wizGenKeyBtn').disabled = false;
          $id('wizGenKeyBtn').textContent = 'Generate Key';
        }
      });
    }
  }

  function renderStepDeriveWallet(el) {
    const disabled = phaseIndex(onboardingPhase) > 2;
    const notReady = phaseIndex(onboardingPhase) < 2;
    el.innerHTML = `
      <div class="wizard-card">
        <h3>Step 3: Derive Wallet (NPI Credentials)</h3>
        <p class="step-desc">Enter your prescriber credentials. The wallet ID is derived using Poseidon hash of your NPI data combined with the enrollment key. No private keys are involved -- access is proof-gated only.</p>
        ${notReady ? '<div class="wizard-result">Complete Step 2 first.</div>' : ''}
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Prescriber ID Qualifier</label>
            <input type="number" class="form-input" id="wizQualifier" placeholder="e.g. 1" value="1" min="0" ${disabled || notReady ? 'disabled' : ''}>
            <span class="form-hint">Qualifier type (1 = NPI, 2 = DEA, etc.)</span>
          </div>
          <div class="form-group">
            <label class="form-label">Prescriber ID (NPI Number)</label>
            <input type="text" class="form-input" id="wizPrescriberId" placeholder="e.g. 1234567890" ${disabled || notReady ? 'disabled' : ''}>
            <span class="form-hint">Your NPI or prescriber identifier</span>
          </div>
        </div>
        <div class="wizard-actions">
          <button class="btn btn-primary" id="wizDeriveBtn" ${disabled || notReady ? 'disabled' : ''}>Derive Wallet</button>
        </div>
        <div id="wizDeriveResult"></div>
      </div>
    `;
    if (!disabled && !notReady) {
      $id('wizDeriveBtn').addEventListener('click', async () => {
        const qualifier = $id('wizQualifier').value.trim();
        const prescriberId = $id('wizPrescriberId').value.trim();
        if (!prescriberId) { toast('Prescriber ID is required', 'error'); return; }
        $id('wizDeriveBtn').disabled = true;
        $id('wizDeriveBtn').textContent = 'Deriving...';
        try {
          const res = await API.deriveWallet(qualifier, prescriberId);
          onboardingPhase = res.phase;
          walletId = res.walletId;
          updateHeaderWallet();
          $id('wizDeriveResult').innerHTML = `<div class="wizard-result success">Wallet derived via Poseidon hash.<br>Wallet ID: ${esc(res.walletId)}</div>`;
          toast('Wallet derived successfully', 'success');
          setTimeout(() => renderOnboarding($id('mainContent')), 800);
        } catch (err) {
          $id('wizDeriveResult').innerHTML = `<div class="wizard-result error">${esc(err.message)}</div>`;
          $id('wizDeriveBtn').disabled = false;
          $id('wizDeriveBtn').textContent = 'Derive Wallet';
        }
      });
    }
  }

  function renderStepEnroll(el) {
    const disabled = phaseIndex(onboardingPhase) > 3;
    const notReady = phaseIndex(onboardingPhase) < 3;
    el.innerHTML = `
      <div class="wizard-card">
        <h3>Step 4: Enroll</h3>
        <p class="step-desc">Register your wallet with the sequencer and optionally notify the insurer. The insurer sees only your opaque wallet ID -- no credentials or private data are transmitted.</p>
        ${notReady ? '<div class="wizard-result">Complete Step 3 first.</div>' : ''}
        <div class="form-group">
          <label class="form-label">Insurer URL (optional)</label>
          <input type="text" class="form-input" id="wizInsurerUrl" placeholder="e.g. http://localhost:4010" ${disabled || notReady ? 'disabled' : ''}>
          <span class="form-hint">If provided, the insurer will be notified of enrollment</span>
        </div>
        <div class="wizard-actions">
          <button class="btn btn-primary" id="wizEnrollBtn" ${disabled || notReady ? 'disabled' : ''}>Enroll</button>
        </div>
        <div id="wizEnrollResult"></div>
      </div>
    `;
    if (!disabled && !notReady) {
      $id('wizEnrollBtn').addEventListener('click', async () => {
        const insurerUrl = $id('wizInsurerUrl').value.trim();
        $id('wizEnrollBtn').disabled = true;
        $id('wizEnrollBtn').textContent = 'Enrolling...';
        try {
          const res = await API.enroll(insurerUrl || undefined);
          onboardingPhase = res.phase;
          $id('wizEnrollResult').innerHTML = `<div class="wizard-result success">Enrolled. Wallet: ${esc(res.walletId)}${res.insurerNotified ? ' | Insurer notified' : ''}</div>`;
          toast('Enrolled successfully', 'success');
          setTimeout(() => renderOnboarding($id('mainContent')), 800);
        } catch (err) {
          $id('wizEnrollResult').innerHTML = `<div class="wizard-result error">${esc(err.message)}</div>`;
          $id('wizEnrollBtn').disabled = false;
          $id('wizEnrollBtn').textContent = 'Enroll';
        }
      });
    }
  }

  function renderStepCompile(el) {
    const isCompiling = onboardingPhase === 'compiling';
    const disabled = phaseIndex(onboardingPhase) > 5;
    const notReady = phaseIndex(onboardingPhase) < 4;
    el.innerHTML = `
      <div class="wizard-card">
        <h3>Step 5: Compile ZK Programs</h3>
        <p class="step-desc">Compile the zero-knowledge circuits. This step generates verification keys and prepares the prover. It typically takes 3-5 minutes.</p>
        ${notReady ? '<div class="wizard-result">Complete Step 4 first.</div>' : ''}
        ${isCompiling ? '<div class="wizard-result"><span class="badge badge-compiling">COMPILING</span> Compilation in progress... This may take several minutes.</div>' : ''}
        <div class="wizard-actions">
          <button class="btn btn-primary" id="wizCompileBtn" ${disabled || notReady || isCompiling ? 'disabled' : ''}>${isCompiling ? 'Compiling...' : 'Compile Programs'}</button>
        </div>
        <div id="wizCompileResult"></div>
      </div>
    `;
    if (!disabled && !notReady && !isCompiling) {
      $id('wizCompileBtn').addEventListener('click', async () => {
        $id('wizCompileBtn').disabled = true;
        $id('wizCompileBtn').textContent = 'Compiling... (3-5 min)';
        onboardingPhase = 'compiling';
        try {
          const res = await API.compile();
          onboardingPhase = res.phase;
          let statusText = 'Compilation complete.';
          if (res.compilationStatus) {
            const entries = Object.entries(res.compilationStatus);
            statusText += '\n' + entries.map(([k, v]) => `${k}: ${v}`).join('\n');
          }
          $id('wizCompileResult').innerHTML = `<div class="wizard-result success">${esc(statusText).replace(/\n/g, '<br>')}</div>`;
          toast('Compilation complete', 'success');
          setTimeout(() => renderOnboarding($id('mainContent')), 800);
        } catch (err) {
          onboardingPhase = 'enrolled'; // reset
          $id('wizCompileResult').innerHTML = `<div class="wizard-result error">${esc(err.message)}</div>`;
          $id('wizCompileBtn').disabled = false;
          $id('wizCompileBtn').textContent = 'Compile Programs';
        }
      });
    }
  }

  function renderStepReady(el) {
    el.innerHTML = `
      <div class="wizard-card">
        <h3>Step 6: Ready</h3>
        <p class="step-desc">Onboarding complete. Your prescriber node is fully operational.</p>
        <div class="detail-grid">
          <div class="detail-key">Status</div>
          <div class="detail-val"><span class="badge badge-ready">READY</span></div>
          <div class="detail-key">Wallet ID</div>
          <div class="detail-val">${esc(walletId || '--')}</div>
          <div class="detail-key">Phase</div>
          <div class="detail-val">${esc(onboardingPhase)}</div>
        </div>
        <div class="wizard-actions" style="margin-top: 20px;">
          <button class="btn" id="wizBackupBtn">Backup Key</button>
        </div>
        <div id="wizReadyResult"></div>
      </div>
    `;
    $id('wizBackupBtn').addEventListener('click', () => {
      const pin = prompt('Enter a PIN to encrypt your backup:');
      if (!pin) return;
      API.backupKey(pin).then(res => {
        $id('wizReadyResult').innerHTML = `<div class="wizard-result success">Backup created. Store safely:\n${JSON.stringify(res.backup, null, 2)}</div>`;
        toast('Backup created', 'success');
      }).catch(err => {
        $id('wizReadyResult').innerHTML = `<div class="wizard-result error">${esc(err.message)}</div>`;
      });
    });
  }

  // ── Prescriptions ────────────────────────────────────────────

  async function renderPrescriptions(el) {
    el.innerHTML = `
      <h1 class="page-title">Prescriptions</h1>

      <div class="stats-grid" id="rxStats">
        <div class="stat-card">
          <div class="stat-label">Total Prescriptions</div>
          <div class="stat-value" id="rxTotal">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unique Patients</div>
          <div class="stat-value" id="rxPatients">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unique Pharmacies</div>
          <div class="stat-value" id="rxPharmacies">--</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Filter</h2>
        </div>
        <div class="panel-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Filter By</label>
              <select class="form-input" id="rxFilterType" style="font-family: var(--font-sans);">
                <option value="all">All Prescriptions</option>
                <option value="patient">By Patient Wallet ID</option>
                <option value="medication">By NDC Hash</option>
                <option value="pharmacy">By Pharmacy Wallet ID</option>
                <option value="daterange">By Date Range</option>
              </select>
            </div>
            <div class="form-group" id="rxFilterValueGroup">
              <label class="form-label" id="rxFilterValueLabel">Value</label>
              <input type="text" class="form-input" id="rxFilterValue" placeholder="Enter filter value...">
            </div>
          </div>
          <div class="form-row hidden" id="rxDateRangeRow">
            <div class="form-group">
              <label class="form-label">Start (YYYYMMDD)</label>
              <input type="text" class="form-input" id="rxStartDate" placeholder="20260101">
            </div>
            <div class="form-group">
              <label class="form-label">End (YYYYMMDD)</label>
              <input type="text" class="form-input" id="rxEndDate" placeholder="20261231">
            </div>
          </div>
          <div class="wizard-actions">
            <button class="btn btn-primary" id="rxFilterBtn">Apply Filter</button>
            <button class="btn" id="rxClearBtn">Show All</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Prescribing History</h2>
          <span class="badge badge-info" id="rxCount">--</span>
        </div>
        <div class="panel-body">
          <div id="rxTableContainer">
            <div class="loading">Loading...</div>
          </div>
        </div>
      </div>
    `;

    // Filter type change
    $id('rxFilterType').addEventListener('change', () => {
      const type = $id('rxFilterType').value;
      const valGroup = $id('rxFilterValueGroup');
      const dateRow = $id('rxDateRangeRow');
      if (type === 'daterange') {
        valGroup.classList.add('hidden');
        dateRow.classList.remove('hidden');
      } else if (type === 'all') {
        valGroup.classList.add('hidden');
        dateRow.classList.add('hidden');
      } else {
        valGroup.classList.remove('hidden');
        dateRow.classList.add('hidden');
        const labels = { patient: 'Patient Wallet ID', medication: 'NDC Hash', pharmacy: 'Pharmacy Wallet ID' };
        $id('rxFilterValueLabel').textContent = labels[type] || 'Value';
      }
    });
    // trigger initial state
    $id('rxFilterType').dispatchEvent(new Event('change'));

    $id('rxFilterBtn').addEventListener('click', () => loadPrescriptions());
    $id('rxClearBtn').addEventListener('click', () => {
      $id('rxFilterType').value = 'all';
      $id('rxFilterType').dispatchEvent(new Event('change'));
      loadPrescriptions();
    });

    loadPrescriptionStats();
    loadPrescriptions();
  }

  async function loadPrescriptionStats() {
    try {
      const [pc, phc] = await Promise.all([
        API.getPatientCount(),
        API.getPharmacyCount(),
      ]);
      if ($id('rxPatients')) $id('rxPatients').textContent = pc.count ?? '0';
      if ($id('rxPharmacies')) $id('rxPharmacies').textContent = phc.count ?? '0';
    } catch { /* ignore */ }
  }

  async function loadPrescriptions() {
    const container = $id('rxTableContainer');
    if (!container) return;
    container.innerHTML = '<div class="loading">Loading...</div>';

    const filterType = $id('rxFilterType')?.value || 'all';
    const filterValue = $id('rxFilterValue')?.value.trim();

    try {
      let data;
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
        case 'daterange': {
          const start = $id('rxStartDate')?.value.trim();
          const end = $id('rxEndDate')?.value.trim();
          if (!start || !end) { toast('Enter start and end dates', 'error'); return; }
          data = await API.getPrescriptionsByRange(start, end);
          break;
        }
        default:
          data = await API.getPrescriptions();
      }

      const rows = Array.isArray(data) ? data : (data?.claims || data?.prescriptions || []);
      if ($id('rxTotal')) $id('rxTotal').textContent = rows.length;
      if ($id('rxCount')) $id('rxCount').textContent = rows.length + ' records';

      if (rows.length === 0) {
        container.innerHTML = '<div class="no-data">No prescriptions found</div>';
        return;
      }

      container.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Patient</th>
              <th>Medication</th>
              <th>Pharmacy</th>
              <th>Patient Pay</th>
              <th>Plan Pay</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(rx => `
              <tr>
                <td>${esc(fmtYMD(rx.dateOfService) || fmtDate(rx.timestamp))}</td>
                <td><span class="hash" title="${esc(rx.memberWalletId || rx.patientWalletId)}">${truncHash(rx.memberWalletId || rx.patientWalletId)}</span></td>
                <td><span class="hash" title="${esc(rx.ndcHash)}">${truncHash(rx.ndcHash)}</span></td>
                <td><span class="hash" title="${esc(rx.pharmacyWalletId)}">${truncHash(rx.pharmacyWalletId)}</span></td>
                <td>${rx.patientPayCents != null ? '$' + (Number(rx.patientPayCents) / 100).toFixed(2) : '--'}</td>
                <td>${rx.planPayCents != null ? '$' + (Number(rx.planPayCents) / 100).toFixed(2) : '--'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<div class="no-data">${esc(err.message)}</div>`;
    }
  }

  // ── Formulary ────────────────────────────────────────────────

  async function renderFormulary(el) {
    el.innerHTML = `
      <h1 class="page-title">Formulary Lookup</h1>

      <div class="panel">
        <div class="panel-header">
          <h2>Look Up Plan Formulary</h2>
        </div>
        <div class="panel-body">
          <div class="search-row">
            <input type="text" class="form-input" id="formPlanId" placeholder="Enter Plan ID Hash...">
            <button class="btn btn-primary" id="formLookupBtn">Load Formulary</button>
          </div>
          <div id="formResult"></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Check Drug Coverage</h2>
        </div>
        <div class="panel-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Plan ID Hash</label>
              <input type="text" class="form-input" id="formCheckPlanId" placeholder="Plan ID Hash">
            </div>
            <div class="form-group">
              <label class="form-label">NDC Hash</label>
              <input type="text" class="form-input" id="formCheckNdc" placeholder="NDC Hash">
            </div>
          </div>
          <div class="wizard-actions">
            <button class="btn btn-primary" id="formCheckBtn">Check Coverage</button>
          </div>
          <div id="formCheckResult"></div>
        </div>
      </div>
    `;

    $id('formLookupBtn').addEventListener('click', async () => {
      const planId = $id('formPlanId').value.trim();
      if (!planId) { toast('Enter a plan ID hash', 'error'); return; }
      const result = $id('formResult');
      result.innerHTML = '<div class="loading">Loading...</div>';
      try {
        const data = await API.getFormulary(planId);
        if (data.entriesJson) {
          try {
            const entries = JSON.parse(data.entriesJson);
            if (Array.isArray(entries) && entries.length > 0) {
              result.innerHTML = `
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>NDC Hash</th>
                      <th>Tier</th>
                      <th>Copay</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${entries.map(e => `
                      <tr>
                        <td><span class="hash" title="${esc(e.ndcHash)}">${truncHash(e.ndcHash)}</span></td>
                        <td>${esc(e.tierLevel ?? '--')}</td>
                        <td>${e.copay != null ? '$' + Number(e.copay).toFixed(2) : '--'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              `;
            } else {
              result.innerHTML = '<div class="no-data">Formulary is empty</div>';
            }
          } catch {
            result.innerHTML = `<div class="detail-grid">
              <div class="detail-key">Raw Data</div>
              <div class="detail-val">${esc(data.entriesJson)}</div>
            </div>`;
          }
        } else {
          // Display whatever we got
          const keys = Object.keys(data);
          result.innerHTML = '<div class="detail-grid">' +
            keys.map(k => `<div class="detail-key">${esc(k)}</div><div class="detail-val">${esc(typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k])}</div>`).join('') +
            '</div>';
        }
      } catch (err) {
        result.innerHTML = `<div class="no-data">${esc(err.message)}</div>`;
      }
    });

    $id('formCheckBtn').addEventListener('click', async () => {
      const planId = $id('formCheckPlanId').value.trim();
      const ndc = $id('formCheckNdc').value.trim();
      if (!planId || !ndc) { toast('Enter both plan ID hash and NDC hash', 'error'); return; }
      const result = $id('formCheckResult');
      result.innerHTML = '<div class="loading">Checking...</div>';
      try {
        const data = await API.checkDrugCoverage(planId, ndc);
        const covered = data.onFormulary;
        result.innerHTML = `
          <div class="wizard-result ${covered ? 'success' : 'error'}" style="margin-top: 16px;">
            <strong>${covered ? 'COVERED' : 'NOT ON FORMULARY'}</strong><br>
            NDC: ${esc(data.ndcHash)}<br>
            ${data.tierLevel != null ? 'Tier: ' + data.tierLevel + '<br>' : ''}
            ${data.copay != null ? 'Copay: $' + Number(data.copay).toFixed(2) : ''}
          </div>
        `;
      } catch (err) {
        result.innerHTML = `<div class="wizard-result error" style="margin-top: 16px;">${esc(err.message)}</div>`;
      }
    });
  }

  // ── Messaging ────────────────────────────────────────────────

  let msgView = 'inbox';

  async function renderMessaging(el) {
    el.innerHTML = `
      <h1 class="page-title">Messaging</h1>

      <div class="msg-tabs">
        <button class="msg-tab active" data-view="inbox">Inbox</button>
        <button class="msg-tab" data-view="sent">Sent</button>
        <button class="msg-tab" data-view="compose">Compose</button>
      </div>

      <div id="msgContent">
        <div class="loading">Loading...</div>
      </div>
    `;

    document.querySelectorAll('.msg-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.msg-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        msgView = tab.dataset.view;
        loadMsgView();
      });
    });

    msgView = 'inbox';
    loadMsgView();
  }

  async function loadMsgView() {
    const content = $id('msgContent');
    if (!content) return;

    switch (msgView) {
      case 'inbox': await loadInbox(content); break;
      case 'sent': await loadSent(content); break;
      case 'compose': renderCompose(content); break;
      default: await loadInbox(content);
    }
  }

  async function loadInbox(el) {
    el.innerHTML = '<div class="loading">Loading inbox...</div>';
    try {
      const data = await API.getInbox();
      const messages = Array.isArray(data) ? data : (data?.messages || []);
      if (messages.length === 0) {
        el.innerHTML = '<div class="panel"><div class="panel-body"><div class="no-data">Inbox is empty</div></div></div>';
        return;
      }
      el.innerHTML = '<div class="panel"><div class="panel-body" style="padding: 0;">' +
        messages.map((msg, i) => `
          <div class="msg-item" data-idx="${i}" data-thread="${esc(msg.threadIdHash || '')}">
            <span class="msg-time">${fmtDate(msg.timestamp)}</span>
            <div class="msg-from">From: <span class="hash">${truncHash(msg.senderWalletId || msg.from)}</span></div>
            <div class="msg-preview">${esc(msg.subject || msg.preview || '(encrypted message)')}</div>
          </div>
        `).join('') +
        '</div></div>';

      el.querySelectorAll('.msg-item').forEach(item => {
        item.addEventListener('click', () => {
          const threadId = item.dataset.thread;
          if (threadId) loadThread(threadId);
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="panel"><div class="panel-body"><div class="no-data">${esc(err.message)}</div></div></div>`;
    }
  }

  async function loadSent(el) {
    el.innerHTML = '<div class="loading">Loading sent messages...</div>';
    try {
      const data = await API.getSent();
      const messages = Array.isArray(data) ? data : (data?.messages || []);
      if (messages.length === 0) {
        el.innerHTML = '<div class="panel"><div class="panel-body"><div class="no-data">No sent messages</div></div></div>';
        return;
      }
      el.innerHTML = '<div class="panel"><div class="panel-body" style="padding: 0;">' +
        messages.map((msg, i) => `
          <div class="msg-item" data-idx="${i}" data-thread="${esc(msg.threadIdHash || '')}">
            <span class="msg-time">${fmtDate(msg.timestamp)}</span>
            <div class="msg-from">To: <span class="hash">${truncHash(msg.recipientWalletId || msg.to)}</span></div>
            <div class="msg-preview">${esc(msg.subject || msg.preview || '(encrypted message)')}</div>
          </div>
        `).join('') +
        '</div></div>';

      el.querySelectorAll('.msg-item').forEach(item => {
        item.addEventListener('click', () => {
          const threadId = item.dataset.thread;
          if (threadId) loadThread(threadId);
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="panel"><div class="panel-body"><div class="no-data">${esc(err.message)}</div></div></div>`;
    }
  }

  async function loadThread(threadIdHash) {
    const content = $id('msgContent');
    if (!content) return;
    content.innerHTML = '<div class="loading">Loading thread...</div>';
    try {
      const data = await API.getThread(threadIdHash);
      const messages = Array.isArray(data) ? data : (data?.messages || []);
      content.innerHTML = `
        <div class="panel">
          <div class="panel-header">
            <h2>Thread: <span class="hash">${truncHash(threadIdHash)}</span></h2>
            <button class="btn btn-sm" id="msgBackBtn">Back</button>
          </div>
          <div class="panel-body" style="padding: 0;">
            ${messages.length === 0 ? '<div class="no-data">No messages in thread</div>' :
              messages.map(msg => `
                <div class="thread-msg">
                  <div class="thread-sender">${truncHash(msg.senderWalletId || msg.from)}</div>
                  <div class="thread-body">${esc(msg.body || msg.content || '(encrypted)')}</div>
                  <div class="thread-time">${fmtDate(msg.timestamp)}</div>
                </div>
              `).join('')}
          </div>
        </div>
      `;
      $id('msgBackBtn').addEventListener('click', () => loadMsgView());
    } catch (err) {
      content.innerHTML = `<div class="panel"><div class="panel-body"><div class="no-data">${esc(err.message)}</div></div></div>`;
    }
  }

  function renderCompose(el) {
    el.innerHTML = `
      <div class="panel">
        <div class="panel-header">
          <h2>Compose Message</h2>
        </div>
        <div class="panel-body">
          <div class="form-group">
            <label class="form-label">Recipient Wallet ID</label>
            <input type="text" class="form-input" id="msgRecipient" placeholder="Recipient wallet ID (member or pharmacy)">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Subject</label>
              <input type="text" class="form-input" id="msgSubject" placeholder="Message subject">
            </div>
            <div class="form-group">
              <label class="form-label">Thread ID (optional)</label>
              <input type="text" class="form-input" id="msgThreadId" placeholder="Thread ID hash for replies">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Message Body</label>
            <textarea class="form-input" id="msgBody" placeholder="Type your message..."></textarea>
          </div>
          <div class="wizard-actions">
            <button class="btn btn-primary" id="msgSendBtn">Send Message</button>
          </div>
          <div id="msgSendResult"></div>
        </div>
      </div>
    `;

    $id('msgSendBtn').addEventListener('click', async () => {
      const recipient = $id('msgRecipient').value.trim();
      const subject = $id('msgSubject').value.trim();
      const threadId = $id('msgThreadId').value.trim();
      const body = $id('msgBody').value.trim();

      if (!recipient) { toast('Recipient wallet ID is required', 'error'); return; }
      if (!body) { toast('Message body is required', 'error'); return; }

      $id('msgSendBtn').disabled = true;
      $id('msgSendBtn').textContent = 'Sending...';

      try {
        const message = {
          recipientWalletId: recipient,
          senderWalletId: walletId || '',
          subject: subject || '',
          threadIdHash: threadId || '',
        };
        const payload = {
          body: body,
          timestamp: Date.now(),
        };
        const res = await API.sendMessage(message, payload);
        $id('msgSendResult').innerHTML = '<div class="wizard-result success">Message sent successfully.</div>';
        toast('Message sent', 'success');
        // Clear form
        $id('msgRecipient').value = '';
        $id('msgSubject').value = '';
        $id('msgThreadId').value = '';
        $id('msgBody').value = '';
      } catch (err) {
        $id('msgSendResult').innerHTML = `<div class="wizard-result error">${esc(err.message)}</div>`;
      }
      $id('msgSendBtn').disabled = false;
      $id('msgSendBtn').textContent = 'Send Message';
    });
  }

  // ── Proofs ───────────────────────────────────────────────────

  async function renderProofs(el) {
    el.innerHTML = `
      <h1 class="page-title">Proofs</h1>

      <div class="panel">
        <div class="panel-header">
          <h2>Generate Registration Proof</h2>
        </div>
        <div class="panel-body">
          <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;">
            Generate a zero-knowledge proof that proves your wallet registration without revealing any private data.
            The proof is submitted to the sequencer and included in the next batch.
          </p>
          <div class="wizard-actions">
            <button class="btn btn-primary" id="proofGenBtn" ${onboardingPhase !== 'ready' ? 'disabled' : ''}>Generate Registration Proof</button>
          </div>
          ${onboardingPhase !== 'ready' ? '<div class="form-hint" style="margin-top: 8px;">Complete onboarding to enable proof generation.</div>' : ''}
          <div id="proofGenResult"></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Proof Timings</h2>
          <button class="btn btn-sm" id="proofRefreshBtn">Refresh</button>
        </div>
        <div class="panel-body">
          <div id="proofTimings">
            <div class="loading">Loading...</div>
          </div>
        </div>
      </div>
    `;

    if (onboardingPhase === 'ready') {
      $id('proofGenBtn').addEventListener('click', async () => {
        $id('proofGenBtn').disabled = true;
        $id('proofGenBtn').textContent = 'Generating proof...';
        try {
          const res = await API.generateRegistrationProof();
          $id('proofGenResult').innerHTML = `
            <div class="wizard-result success" style="margin-top: 16px;">
              Proof generated and submitted.<br>
              Receipt ID: ${esc(res.receiptId)}<br>
              Wallet ID: ${esc(res.walletId)}
            </div>
          `;
          toast('Registration proof generated', 'success');
          loadProofTimings();
        } catch (err) {
          $id('proofGenResult').innerHTML = `<div class="wizard-result error" style="margin-top: 16px;">${esc(err.message)}</div>`;
        }
        $id('proofGenBtn').disabled = false;
        $id('proofGenBtn').textContent = 'Generate Registration Proof';
      });
    }

    $id('proofRefreshBtn').addEventListener('click', loadProofTimings);
    loadProofTimings();
  }

  async function loadProofTimings() {
    const container = $id('proofTimings');
    if (!container) return;
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
      const data = await API.getProofTimings();
      const timings = Array.isArray(data) ? data : (data?.timings || []);
      if (timings.length === 0) {
        container.innerHTML = '<div class="no-data">No proof timings recorded yet</div>';
        return;
      }
      container.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Program</th>
              <th>Method</th>
              <th>Duration (ms)</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${timings.map(t => `
              <tr>
                <td>${esc(t.program || t.name || '--')}</td>
                <td>${esc(t.method || t.type || '--')}</td>
                <td>${esc(t.durationMs ?? t.duration ?? '--')}</td>
                <td>${fmtDate(t.timestamp)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<div class="no-data">${esc(err.message)}</div>`;
    }
  }

  // ── Header Wallet Display ────────────────────────────────────

  function updateHeaderWallet() {
    const el = $id('headerWallet');
    if (el) {
      el.textContent = walletId ? truncHash(walletId, 20) : '--';
      el.title = walletId || '';
    }
  }

  // ── SSE + Connection ────────────────────────────────────────

  function connectSSE() {
    API.connectSSE(
      (event) => {
        sseEvents.unshift(event);
        if (sseEvents.length > MAX_EVENTS) sseEvents.length = MAX_EVENTS;
        if (currentTab === 'overview') renderEventLog();
      },
      () => {
        // SSE error
        $id('statusDot').className = 'status-dot error';
        $id('statusText').textContent = 'Disconnected';
        // Reconnect after 5s
        setTimeout(connectSSE, 5000);
      },
      () => {
        // SSE open
        $id('statusDot').className = 'status-dot connected';
        $id('statusText').textContent = 'Connected';
      }
    );
  }

  async function checkHealth() {
    try {
      const data = await API.health();
      if (data) {
        $id('statusDot').className = 'status-dot connected';
        $id('statusText').textContent = 'Connected';
      } else {
        $id('statusDot').className = 'status-dot error';
        $id('statusText').textContent = 'Offline';
      }
    } catch {
      $id('statusDot').className = 'status-dot error';
      $id('statusText').textContent = 'Offline';
    }
  }

  // ── Auto-Refresh ─────────────────────────────────────────────

  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentTab === 'overview') {
        loadOverviewData();
      }
    }, 30000);
  }

  // ── Init ─────────────────────────────────────────────────────

  async function init() {
    // Initial health check
    await checkHealth();

    // Load onboarding status
    try {
      const status = await API.getOnboardingStatus();
      onboardingPhase = status.phase || 'awaiting_token';
      walletId = status.walletId || null;
      updateHeaderWallet();
    } catch { /* not ready */ }

    // Connect SSE
    connectSSE();

    // Start auto-refresh
    startAutoRefresh();

    // Route to initial page
    navigate();
  }

  // Boot
  init();
})();
