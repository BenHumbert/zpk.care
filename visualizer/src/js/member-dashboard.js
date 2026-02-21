// member-dashboard.js -- zkpCare Member Node Dashboard
// ES module that renders all member dashboard sections.

import {
  fetchJson,
  postJson,
  renderSectionCard,
  renderDataGrid,
  renderMetricRow,
  renderProgressBar,
  renderSortableTable,
  renderEntitySelector,
  renderSearchBox,
  renderDateFilter,
  renderBadge,
  formatCents,
  truncHash,
  formatDate,
  formatTimestamp,
  operationBadge,
  statusBadge,
  lifecycleText,
  lifecyclePillClass,
  computeSummary,
  startAutoRefresh,
} from './node-common.js';

// ============================================================================
// Constants
// ============================================================================

const COLOR = 'member';
const DEDUCTIBLE_LIMIT = 50000;   // $500 in cents
const OOPM_LIMIT = 800000;        // $8,000 in cents
const ANNUAL_MAX_LIMIT = 5000000; // $50,000 in cents

// ============================================================================
// State
// ============================================================================

let state = null;       // full /node/state response
let selectedMember = null;
let claims = [];        // claims for currently selected member
let receipts = [];      // receipts for currently selected member
let healthOk = false;

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  try {
    state = await fetchJson('/node/state');
    healthOk = true;
  } catch (err) {
    console.warn('Failed to fetch node state:', err.message);
    healthOk = false;
    updateHealthDot();
    return;
  }

  updateHealthDot();

  const members = state.enrolledMembers || [];
  renderHeaderSelector(members);

  if (members.length > 0) {
    selectedMember = members[0];
    updateHeaderIdentity(selectedMember);
    await loadMemberData(selectedMember.walletId);
  } else {
    renderEmptyState();
  }

  // Auto-refresh every 10 seconds
  startAutoRefresh(
    () => fetchJson('/node/state'),
    (newState) => {
      state = newState;
      healthOk = true;
      updateHealthDot();
      // Re-select the current member if still present
      if (selectedMember) {
        const updated = (state.enrolledMembers || []).find(
          (m) => m.walletId === selectedMember.walletId
        );
        if (updated) {
          selectedMember = updated;
          updateHeaderIdentity(selectedMember);
          renderIdentitySection(selectedMember);
          renderPcpSection(selectedMember);
          renderAccumulatorSection(selectedMember);
        }
      }
    },
    10000
  );
}

// ============================================================================
// Header
// ============================================================================

function renderHeaderSelector(members) {
  const container = document.getElementById('header-selector');
  if (!container) return;

  const entities = members.map((m) => ({
    walletId: m.walletId,
    displayName: m.displayName || truncHash(m.walletId, 8),
  }));

  container.innerHTML = renderEntitySelector(
    entities,
    selectedMember ? selectedMember.walletId : null,
    'Member:'
  );

  const select = container.querySelector('#entity-select');
  if (select) {
    select.addEventListener('change', async (e) => {
      const walletId = e.target.value;
      const member = (state.enrolledMembers || []).find(
        (m) => m.walletId === walletId
      );
      if (member) {
        selectedMember = member;
        updateHeaderIdentity(selectedMember);
        await loadMemberData(selectedMember.walletId);
      }
    });
  }
}

function updateHeaderIdentity(member) {
  const walletEl = document.getElementById('header-wallet-id');
  const lifecycleEl = document.getElementById('header-lifecycle');

  if (walletEl) {
    walletEl.textContent = member.displayName || member.walletIdDisplay || truncHash(member.walletId, 8);
  }
  if (lifecycleEl) {
    lifecycleEl.textContent = lifecycleText(member.lifecycle);
    lifecycleEl.className = 'lifecycle-pill lifecycle-' + lifecyclePillClass(member.lifecycle);
  }
}

function updateHealthDot() {
  const dot = document.getElementById('header-health');
  if (!dot) return;
  dot.className = 'health-dot ' + (healthOk ? 'connected' : 'disconnected');
  dot.title = healthOk ? 'Connected to sequencer' : 'Disconnected from sequencer';
}

// ============================================================================
// Data Loading
// ============================================================================

async function loadMemberData(walletId) {
  // Fetch claims and receipts in parallel
  const [claimsRes, receiptsRes] = await Promise.all([
    fetchJson(`/node/claims-by-member?walletId=${encodeURIComponent(walletId)}`).catch(() => ({ claims: [] })),
    fetchJson(`/node/receipts-by-wallet?walletId=${encodeURIComponent(walletId)}`).catch(() => ({ receipts: [] })),
  ]);

  claims = claimsRes.claims || [];
  receipts = receiptsRes.receipts || [];

  renderAllSections();
}

function renderEmptyState() {
  const sections = [
    'section-identity', 'section-pcp', 'section-accumulators',
    'section-history', 'section-activity', 'section-formulary',
    'section-receipts', 'section-verification', 'section-info',
  ];
  for (const id of sections) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
  const identity = document.getElementById('section-identity');
  if (identity) {
    identity.innerHTML = renderSectionCard('Identity & Status', COLOR,
      '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No enrolled members found. Enroll a member to see their dashboard.</div>'
    );
  }
}

function renderAllSections() {
  renderIdentitySection(selectedMember);
  renderPcpSection(selectedMember);
  renderAccumulatorSection(selectedMember);
  renderActivitySection();
  renderHistorySection();
  renderFormularySection();
  renderCredentialSection();
  renderReceiptsSection();
  renderVerificationSection();
  renderInfoSection();
}

// ============================================================================
// Section 1: Identity & Status
// ============================================================================

function renderIdentitySection(member) {
  const el = document.getElementById('section-identity');
  if (!el || !member) return;

  const entries = [
    { label: 'Wallet ID', value: member.walletIdDisplay || truncHash(member.walletId, 10) },
    { label: 'Display Name', value: member.displayName || '--' },
    { label: 'Plan ID', value: member.planId || '--' },
    { label: 'Group ID', value: member.groupId || '--' },
    { label: 'Family ID', value: member.familyId || '--' },
    { label: 'Relationship', value: member.relationship || '--' },
    { label: 'Employee ID', value: member.employeeId || '--' },
    {
      label: 'Lifecycle',
      value: `<span class="lifecycle-pill lifecycle-${lifecyclePillClass(member.lifecycle)}">${lifecycleText(member.lifecycle)}</span>`,
      mono: false,
    },
    { label: 'Nonce (Keys)', value: String(member.nonce != null ? member.nonce : '--') },
  ];

  if (member.terminationDate) {
    entries.push({ label: 'Termination', value: formatDate(member.terminationDate) });
  }

  el.innerHTML = renderSectionCard('Identity & Status', COLOR, renderDataGrid(entries));
}

// ============================================================================
// Section 2: PCP (Primary Care Provider)
// ============================================================================

function renderPcpSection(member) {
  const el = document.getElementById('section-pcp');
  if (!el || !member) return;

  const pcp = member.pcpAssignment;
  const inNetworkIndices = member.inNetworkPrescribers || [];
  const allPrescribers = (state && state.prescribers) || [];

  // Filter prescribers to in-network only
  const inNetworkPrescribers = allPrescribers.filter((p) =>
    inNetworkIndices.includes(p.index)
  );

  let content = '';

  // Current PCP display
  if (pcp && pcp.prescriberName) {
    content += renderDataGrid([
      { label: 'PCP Name', value: pcp.prescriberName },
      { label: 'Specialty', value: pcp.specialty || '--' },
      { label: 'Prescriber Index', value: String(pcp.prescriberIndex) },
    ]);
  } else {
    content += '<div style="color: var(--text-secondary); padding: 8px 0 16px 0;">No PCP assigned -- select one below.</div>';
  }

  // PCP assignment form
  content += '<div style="margin-top: 16px; border-top: 1px solid var(--border-subtle); padding-top: 16px;">';
  content += '<div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">Assign or Change PCP</div>';
  content += '<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">';

  if (inNetworkPrescribers.length > 0) {
    content += '<select id="pcp-select" class="entity-selector" style="flex: 1; min-width: 200px;">';
    for (const p of inNetworkPrescribers) {
      const label = `${p.firstName || ''} ${p.lastName || ''} ${p.credential || ''} -- ${p.specialty || ''} (NPI: ${p.npi || ''})`.trim();
      const selected = pcp && pcp.prescriberIndex === p.index ? ' selected' : '';
      content += `<option value="${p.index}"${selected}>${label}</option>`;
    }
    content += '</select>';
    content += '<button id="btn-assign-pcp" class="btn-action member">Assign PCP</button>';
  } else {
    content += '<span style="color: var(--text-secondary);">No in-network prescribers available.</span>';
  }

  content += '</div></div>';

  // Status message area
  content += '<div id="pcp-status" style="margin-top: 8px; font-size: 13px;"></div>';

  el.innerHTML = renderSectionCard('Primary Care Provider (PCP)', COLOR, content);

  // Attach event listener
  const btn = document.getElementById('btn-assign-pcp');
  if (btn) {
    btn.addEventListener('click', handleAssignPcp);
  }
}

async function handleAssignPcp() {
  const select = document.getElementById('pcp-select');
  const statusEl = document.getElementById('pcp-status');
  const btn = document.getElementById('btn-assign-pcp');
  if (!select || !selectedMember) return;

  const prescriberIndex = parseInt(select.value, 10);
  if (isNaN(prescriberIndex)) return;

  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Assigning...';
  }
  if (statusEl) {
    statusEl.textContent = 'Assigning PCP...';
    statusEl.style.color = 'var(--text-secondary)';
  }

  try {
    const result = await postJson('/interactive/assign-pcp', {
      memberWalletId: selectedMember.walletId,
      prescriberIndex: prescriberIndex,
    });

    if (statusEl) {
      statusEl.textContent = 'PCP assigned successfully.';
      statusEl.style.color = 'var(--color-accent-green)';
    }

    // Refresh state to pick up the new assignment
    try {
      state = await fetchJson('/node/state');
      const updated = (state.enrolledMembers || []).find(
        (m) => m.walletId === selectedMember.walletId
      );
      if (updated) {
        selectedMember = updated;
        updateHeaderIdentity(selectedMember);
        renderPcpSection(selectedMember);
      }
    } catch (_) {
      // Best-effort refresh
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.style.color = 'var(--color-accent-red)';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = 'Assign PCP';
    }
  }
}

// ============================================================================
// Section 3: Accumulator Progress
// ============================================================================

function renderAccumulatorSection(member) {
  const el = document.getElementById('section-accumulators');
  if (!el || !member) return;

  const acc = member.accumulator || {};
  const deductible = Number(acc.deductiblePaidCents || 0);
  const oop = Number(acc.oopPaidCents || 0);
  const benefit = Number(acc.benefitUsedCents || 0);

  const content =
    renderProgressBar('Deductible', deductible, DEDUCTIBLE_LIMIT, 'var(--color-accent-blue)') +
    renderProgressBar('Out-of-Pocket Maximum', oop, OOPM_LIMIT, 'var(--color-accent-amber)') +
    renderProgressBar('Annual Benefit Maximum', benefit, ANNUAL_MAX_LIMIT, 'var(--color-accent-green)');

  el.innerHTML = renderSectionCard('Accumulator Progress', COLOR, content);
}

// ============================================================================
// Section 4: Drug History
// ============================================================================

function renderHistorySection() {
  const el = document.getElementById('section-history');
  if (!el) return;

  // Date filter + table
  let content = renderDateFilter('history-date-start', 'history-date-end');
  content += '<div id="history-table-container">';
  content += buildHistoryTable(claims);
  content += '</div>';

  el.innerHTML = renderSectionCard('Drug History', COLOR, content);

  // Attach date filter listeners
  const startInput = document.getElementById('history-date-start');
  const endInput = document.getElementById('history-date-end');
  if (startInput) startInput.addEventListener('change', applyHistoryFilter);
  if (endInput) endInput.addEventListener('change', applyHistoryFilter);
}

function applyHistoryFilter() {
  const startInput = document.getElementById('history-date-start');
  const endInput = document.getElementById('history-date-end');
  const container = document.getElementById('history-table-container');
  if (!container) return;

  const startVal = startInput ? startInput.value : '';
  const endVal = endInput ? endInput.value : '';

  let filtered = claims;

  if (startVal || endVal) {
    // Convert CCYYMMDD dates from claims to comparable format
    const startNum = startVal ? startVal.replace(/-/g, '') : '00000000';
    const endNum = endVal ? endVal.replace(/-/g, '') : '99999999';

    filtered = claims.filter((c) => {
      const dos = c.leaf ? String(c.leaf.dateOfService || '') : '';
      if (!dos) return true;
      return dos >= startNum && dos <= endNum;
    });
  }

  container.innerHTML = buildHistoryTable(filtered);
}

function buildHistoryTable(claimsList) {
  // Flatten claims for table display
  const rows = claimsList.map((c) => {
    const leaf = c.leaf || {};
    const meta = c.metadata || {};
    return {
      dateOfService: leaf.dateOfService ? formatDate(String(leaf.dateOfService)) : '--',
      dateOfServiceRaw: String(leaf.dateOfService || ''),
      brandName: meta.brandName || '--',
      prescriberWalletId: leaf.prescriberWalletId ? truncHash(String(leaf.prescriberWalletId), 4) : '--',
      pharmacyWalletId: leaf.pharmacyWalletId ? truncHash(String(leaf.pharmacyWalletId), 4) : '--',
      patientPayCents: Number(leaf.patientPayCents || 0),
      planPayCents: Number(leaf.planPayCents || 0),
      operationType: meta.operationType || leaf.operationType || 'fill',
      daysSupply: meta.daysSupply != null ? meta.daysSupply : '--',
      fillNumber: meta.fillNumber != null ? meta.fillNumber : '--',
    };
  });

  const columns = [
    { key: 'dateOfService', label: 'Date' },
    { key: 'brandName', label: 'Medication' },
    { key: 'prescriberWalletId', label: 'Prescriber' },
    { key: 'pharmacyWalletId', label: 'Pharmacy' },
    {
      key: 'patientPayCents',
      label: 'Patient Pay',
      align: 'right',
      format: (v) => formatCents(v),
    },
    {
      key: 'planPayCents',
      label: 'Plan Pay',
      align: 'right',
      format: (v) => formatCents(v),
    },
    {
      key: 'operationType',
      label: 'Type',
      format: (v) => {
        if (v === 'reversal') return renderBadge('Reversal', 'reversal');
        return renderBadge('Fill', 'fill');
      },
    },
    { key: 'daysSupply', label: 'Days', align: 'right' },
    { key: 'fillNumber', label: 'Fill #', align: 'right' },
  ];

  return renderSortableTable('history-table', columns, rows, 'dateOfService');
}

// ============================================================================
// Section 5: Activity Summary
// ============================================================================

function renderActivitySection() {
  const el = document.getElementById('section-activity');
  if (!el) return;

  // Build claim views for computeSummary
  const views = claims.map((c) => {
    const leaf = c.leaf || {};
    const meta = c.metadata || {};
    return {
      operationType: (meta.operationType || leaf.operationType || 'fulfillment'),
      patientPayCents: leaf.patientPayCents || 0,
      planPayCents: leaf.planPayCents || 0,
      ndcHash: meta.ndc || leaf.ndcHash || '',
      dateOfService: String(leaf.dateOfService || ''),
    };
  });

  const summary = computeSummary(views);

  const metrics = [
    { label: 'Total Claims', value: String(summary.totalClaims), color: 'var(--color-accent-blue)' },
    { label: 'Active Claims', value: String(summary.activeClaims), color: 'var(--color-accent-green)' },
    { label: 'Reversals', value: String(summary.totalReversals), color: 'var(--color-accent-red)' },
    { label: 'Total Patient Pay', value: formatCents(summary.totalPatientPay), color: 'var(--color-accent-amber)' },
    { label: 'Total Plan Pay', value: formatCents(summary.totalPlanPay), color: 'var(--color-accent-blue)' },
    { label: 'Unique Medications', value: String(summary.uniqueMedications), color: 'var(--color-member)' },
  ];

  el.innerHTML = renderSectionCard('Activity Summary', COLOR, renderMetricRow(metrics));
}

// ============================================================================
// Section 6: Formulary Lookup
// ============================================================================

function renderFormularySection() {
  const el = document.getElementById('section-formulary');
  if (!el) return;

  const medications = (state && state.medications) || [];

  const rows = medications.map((m) => ({
    brandName: m.brandName || m.name || '--',
    ndc: m.ndc || '--',
    tierLevel: m.tierLevel != null ? m.tierLevel : '--',
  }));

  const columns = [
    { key: 'brandName', label: 'Brand Name' },
    { key: 'ndc', label: 'NDC' },
    {
      key: 'tierLevel',
      label: 'Tier',
      format: (v) => {
        const tier = Number(v);
        if (tier >= 1 && tier <= 4) return renderBadge('Tier ' + tier, 'tier-' + tier);
        return String(v);
      },
    },
  ];

  const table = renderSortableTable('formulary-table', columns, rows, 'brandName');
  el.innerHTML = renderSectionCard('Formulary Lookup', COLOR, table, { collapsed: true });
}

// ============================================================================
// Section: Portable Credential (NFC / Offline Verification)
// ============================================================================

let credentialInFlight = false;
let lastCredentialJson = null;

function renderCredentialSection() {
  const el = document.getElementById('section-credential');
  if (!el || !selectedMember) return;

  let content = '';

  // Explanation
  content += `
    <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.5;">
      Generate a portable ZK credential for this member. Present it at any pharmacy for
      offline identity verification (NFC tap, QR scan, or direct transfer). The credential
      contains a cryptographic proof that this wallet holds a valid eligibility credential —
      no PHI is revealed.
    </div>
  `;

  // Generate button + status
  content += `
    <div class="rx-form-actions">
      <button id="btn-generate-credential" class="btn-credential">Generate Credential</button>
      <span id="credential-status" class="rx-status-msg"></span>
    </div>
  `;

  // Result area
  content += '<div id="credential-result"></div>';

  // If we already have a credential from this session, show it
  if (lastCredentialJson) {
    content += buildCredentialDisplay(lastCredentialJson);
  }

  el.innerHTML = renderSectionCard('Portable Credential (NFC / Offline)', COLOR, content);

  // Wire button
  const btn = document.getElementById('btn-generate-credential');
  if (btn) {
    btn.addEventListener('click', handleGenerateCredential);
  }

  // Wire copy button if credential already exists
  wireCopyButton();
}

function buildCredentialDisplay(credResult) {
  const credJson = credResult.credentialJson || '';
  const truncatedJson = credJson.length > 200
    ? credJson.slice(0, 200) + '...'
    : credJson;

  return `
    <div class="credential-card">
      <div class="credential-header">
        <span class="credential-valid-badge">VALID CREDENTIAL</span>
        <span style="font-size: 12px; color: var(--text-secondary);">
          Generated in ${((credResult.totalTimeMs || 0) / 1000).toFixed(1)}s
        </span>
      </div>
      <div class="credential-grid">
        <span class="credential-label">Member</span>
        <span>${credResult.memberDisplayName || '--'}</span>
        <span class="credential-label">Wallet ID</span>
        <span class="mono" style="font-size: 12px;">${credResult.walletIdDisplay || truncHash(selectedMember.walletId, 10)}</span>
        <span class="credential-label">Proof Type</span>
        <span>${credResult.credential ? credResult.credential.proofType : 'credential-holding'}</span>
        <span class="credential-label">ProofGate Time</span>
        <span>${((credResult.proofGateTimeMs || 0) / 1000).toFixed(1)}s</span>
        <span class="credential-label">CredentialProgram Time</span>
        <span>${((credResult.nftProgramTimeMs || 0) / 1000).toFixed(1)}s</span>
      </div>
      <div style="margin-top: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">Credential JSON (for pharmacy verification)</span>
          <button id="btn-copy-credential" class="btn-copy">Copy to Clipboard</button>
        </div>
        <pre class="credential-json">${escapeHtml(truncatedJson)}</pre>
      </div>
    </div>
  `;
}

async function handleGenerateCredential() {
  if (credentialInFlight || !selectedMember) return;

  const btn = document.getElementById('btn-generate-credential');
  const statusEl = document.getElementById('credential-status');
  const resultEl = document.getElementById('credential-result');

  credentialInFlight = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating ZK proofs\u2026';
  }
  if (statusEl) {
    statusEl.textContent = `Generating credential for ${selectedMember.displayName}\u2026 (2 ZK proofs, polling every 15s)`;
    statusEl.className = 'rx-status-msg pending';
  }
  if (resultEl) resultEl.innerHTML = '';

  const walletId = selectedMember.walletId;
  const proofType = 'holding';
  const API_BASE = 'http://127.0.0.1:3030';

  try {
    // Fire-and-forget: kick off credential generation
    const kickoff = await fetch(`${API_BASE}/interactive/generate-credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletId, proofType }),
    });
    const kickoffData = await kickoff.json();

    // If server already had a completed result, handle immediately
    if (kickoffData.status === 'complete') {
      onCredentialComplete(kickoffData.result, btn, statusEl, resultEl);
      return;
    }
    if (kickoffData.status === 'error') {
      throw new Error(kickoffData.error || 'Credential generation failed');
    }

    // Poll every 15s, up to 10 minutes
    let pollCount = 0;
    const maxPolls = 40;

    const poll = async () => {
      pollCount++;
      try {
        const res = await fetch(`${API_BASE}/interactive/credential-status?walletId=${encodeURIComponent(walletId)}&proofType=${encodeURIComponent(proofType)}`);
        const data = await res.json();

        if (data.status === 'complete') {
          onCredentialComplete(data.result, btn, statusEl, resultEl);
          return;
        }
        if (data.status === 'error') {
          throw new Error(data.error || 'Credential generation failed');
        }
        if (pollCount >= maxPolls) {
          throw new Error('Credential generation timed out after 10 minutes');
        }

        const elapsed = pollCount * 15;
        if (btn) btn.textContent = `Generating\u2026 ${elapsed}s`;
        if (statusEl) {
          statusEl.textContent = `Generating ZK proofs\u2026 (${elapsed}s elapsed, checking every 15s)`;
        }
        setTimeout(poll, 15_000);
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = `Failed: ${err.message}`;
          statusEl.className = 'rx-status-msg error';
        }
        credentialInFlight = false;
        const btnRef = document.getElementById('btn-generate-credential');
        if (btnRef) { btnRef.disabled = false; btnRef.textContent = 'Generate Credential'; }
      }
    };

    setTimeout(poll, 15_000);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Failed: ${err.message}`;
      statusEl.className = 'rx-status-msg error';
    }
    credentialInFlight = false;
    const btnRef = document.getElementById('btn-generate-credential');
    if (btnRef) { btnRef.disabled = false; btnRef.textContent = 'Generate Credential'; }
  }
}

function onCredentialComplete(result, btn, statusEl, resultEl) {
  lastCredentialJson = result;
  if (statusEl) {
    statusEl.textContent = 'Credential generated successfully';
    statusEl.className = 'rx-status-msg success';
  }
  if (resultEl) {
    resultEl.innerHTML = buildCredentialDisplay(result);
    wireCopyButton();
  }
  credentialInFlight = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Generate Credential';
  }
}

function wireCopyButton() {
  const copyBtn = document.getElementById('btn-copy-credential');
  if (copyBtn && lastCredentialJson) {
    copyBtn.addEventListener('click', () => {
      const json = lastCredentialJson.credentialJson || '';
      navigator.clipboard.writeText(json).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
      }).catch(() => {
        copyBtn.textContent = 'Copy failed';
      });
    });
  }
}

// ============================================================================
// Section 7: My Receipts
// ============================================================================

function renderReceiptsSection() {
  const el = document.getElementById('section-receipts');
  if (!el) return;

  const rows = receipts.map((r) => ({
    receiptId: truncHash(r.receiptId || r.id || '', 6),
    receiptIdFull: r.receiptId || r.id || '',
    timestamp: formatTimestamp(r.acceptedAt || r.timestamp),
    status: r.status || 'pending',
  }));

  const columns = [
    {
      key: 'receiptId',
      label: 'Receipt ID',
      format: (v, row) => `<span class="mono" title="${row.receiptIdFull}">${v}</span>`,
    },
    { key: 'timestamp', label: 'Timestamp' },
    {
      key: 'status',
      label: 'Status',
      format: (v) => statusBadge(v),
    },
  ];

  const table = renderSortableTable('receipts-table', columns, rows, 'timestamp');
  el.innerHTML = renderSectionCard('My Receipts', COLOR, table);
}

// ============================================================================
// Section 8: Claim Verification
// ============================================================================

function renderVerificationSection() {
  const el = document.getElementById('section-verification');
  if (!el) return;

  let content = renderSearchBox('verify-leaf-index', 'btn-verify-claim', 'Enter leaf index...', 'Verify');
  content += '<div id="verification-result" style="margin-top: 12px;"></div>';

  el.innerHTML = renderSectionCard('Claim Verification', COLOR, content);

  const btn = document.getElementById('btn-verify-claim');
  if (btn) {
    btn.addEventListener('click', handleVerifyClaim);
  }

  // Also allow Enter key
  const input = document.getElementById('verify-leaf-index');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleVerifyClaim();
    });
  }
}

async function handleVerifyClaim() {
  const input = document.getElementById('verify-leaf-index');
  const resultEl = document.getElementById('verification-result');
  const btn = document.getElementById('btn-verify-claim');
  if (!input || !resultEl) return;

  const leafIndex = input.value.trim();
  if (!leafIndex) {
    resultEl.innerHTML = '<div style="color: var(--color-accent-red);">Please enter a leaf index.</div>';
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
  }
  resultEl.innerHTML = '<div style="color: var(--text-secondary);">Fetching proof data...</div>';

  try {
    const proof = await fetchJson(`/node/claim-proof?leafIndex=${encodeURIComponent(leafIndex)}`);
    const json = JSON.stringify(proof, null, 2);
    resultEl.innerHTML = `<pre class="mono" style="background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; max-height: 400px; overflow-y: auto; color: var(--text-primary);">${escapeHtml(json)}</pre>`;
  } catch (err) {
    resultEl.innerHTML = `<div style="color: var(--color-accent-red);">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  }
}

// ============================================================================
// Section 9: Node Info
// ============================================================================

function renderInfoSection() {
  const el = document.getElementById('section-info');
  if (!el) return;

  const entries = [
    { label: 'Sequencer URL', value: 'http://127.0.0.1:3030' },
    { label: 'Health', value: healthOk
        ? '<span style="color: var(--color-accent-green);">Connected</span>'
        : '<span style="color: var(--color-accent-red);">Disconnected</span>',
      mono: false,
    },
  ];

  // Chain state placeholder -- will be populated async
  const content = renderDataGrid(entries) +
    '<div id="chain-state-info" style="margin-top: 16px; border-top: 1px solid var(--border-subtle); padding-top: 12px;">' +
    '<div style="color: var(--text-secondary); font-size: 13px;">Loading chain state...</div></div>';

  el.innerHTML = renderSectionCard('Node Info', COLOR, content);

  // Fetch chain state asynchronously
  loadChainState();
}

async function loadChainState() {
  const container = document.getElementById('chain-state-info');
  if (!container) return;

  try {
    const chainState = await fetchJson('/node/chain-state');

    const entries = [];

    if (chainState.registryRoot) {
      entries.push({ label: 'Registry Root', value: truncHash(String(chainState.registryRoot), 8) });
    }
    if (chainState.lifecycleRoot) {
      entries.push({ label: 'Lifecycle Root', value: truncHash(String(chainState.lifecycleRoot), 8) });
    }
    if (chainState.walletCount != null) {
      entries.push({ label: 'Wallet Count', value: String(chainState.walletCount) });
    }
    if (chainState.benefitPlanRoot) {
      entries.push({ label: 'Benefit Plan Root', value: truncHash(String(chainState.benefitPlanRoot), 8) });
    }
    if (chainState.nftRegistryRoot) {
      entries.push({ label: 'Credential Registry Root', value: truncHash(String(chainState.nftRegistryRoot), 8) });
    }
    if (chainState.blockHeight != null) {
      entries.push({ label: 'Block Height', value: String(chainState.blockHeight) });
    }
    if (chainState.globalStateRoot) {
      entries.push({ label: 'Global State Root', value: truncHash(String(chainState.globalStateRoot), 8) });
    }

    if (entries.length > 0) {
      container.innerHTML = '<div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">Chain State</div>' +
        renderDataGrid(entries);
    } else {
      container.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px;">Chain state: no data available.</div>';
    }
  } catch (err) {
    container.innerHTML = `<div style="color: var(--color-accent-red); font-size: 13px;">Failed to load chain state: ${escapeHtml(err.message)}</div>`;
  }
}

// ============================================================================
// Utility
// ============================================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// ============================================================================
// Boot
// ============================================================================

init();
