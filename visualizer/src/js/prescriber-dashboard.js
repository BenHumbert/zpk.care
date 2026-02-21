// prescriber-dashboard.js -- Prescriber Node Dashboard for zkpCare
// ES module importing shared utilities from node-common.js

import {
  fetchJson,
  postJson,
  renderSectionCard,
  renderDataGrid,
  renderMetricRow,
  renderSortableTable,
  renderEntitySelector,
  renderBadge,
  formatCents,
  truncHash,
  formatDate,
  formatTimestamp,
  startAutoRefresh,
} from './node-common.js';

const COLOR = 'prescriber';
let state = null;
let selectedPrescriberIndex = null;
let healthOk = false;

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  try {
    state = await fetchJson('/node/state');
    healthOk = true;
    updateHealthDot(true);
  } catch (err) {
    console.warn('Failed to fetch initial state:', err.message);
    updateHealthDot(false);
    return;
  }

  renderPrescriberSelector();

  if (state.prescribers && state.prescribers.length > 0) {
    selectedPrescriberIndex = 0;
    loadPrescriberData();
  } else {
    document.querySelector('.dashboard-grid').innerHTML =
      '<div style="text-align: center; color: var(--text-secondary); padding: 40px;">No prescribers available in demo data.</div>';
  }

  // Auto-refresh every 8 seconds
  startAutoRefresh(
    () => fetchJson('/node/state'),
    (newState) => {
      state = newState;
      healthOk = true;
      updateHealthDot(true);
      if (selectedPrescriberIndex !== null) {
        loadPrescriberData();
      }
    },
    8000,
  );
}

// ============================================================================
// Prescriber Selector
// ============================================================================

function renderPrescriberSelector() {
  const container = document.getElementById('header-selector');
  if (!state.prescribers || state.prescribers.length === 0) {
    container.innerHTML = '<select class="entity-selector" disabled><option>No prescribers</option></select>';
    return;
  }

  const options = state.prescribers.map((p, i) => {
    const sel = i === selectedPrescriberIndex ? ' selected' : '';
    return `<option value="${i}"${sel}>${p.firstName} ${p.lastName}, ${p.credential} - ${p.specialty}</option>`;
  }).join('');

  container.innerHTML = `
    <label style="font-size: 12px; color: var(--text-secondary); margin-right: 8px;">Prescriber:</label>
    <select class="entity-selector" id="prescriber-select">${options}</select>
  `;

  document.getElementById('prescriber-select').addEventListener('change', (e) => {
    selectedPrescriberIndex = parseInt(e.target.value, 10);
    loadPrescriberData();
  });
}

// ============================================================================
// Data Access Helpers
// ============================================================================

function getSelectedPrescriber() {
  if (state.prescribers && selectedPrescriberIndex !== null) {
    return state.prescribers[selectedPrescriberIndex];
  }
  return null;
}

function getPrescriberPrescriptions() {
  return (state.prescriptions || []).filter(
    (rx) => rx.prescriberIndex === selectedPrescriberIndex,
  );
}

function getPrescriberPriorAuths() {
  return (state.priorAuths || []).filter(
    (pa) => pa.prescriberIndex === selectedPrescriberIndex,
  );
}

function getMemberDisplayName(walletId) {
  const member = (state.enrolledMembers || []).find(
    (m) => m.walletId === walletId || m.walletIdDisplay === walletId,
  );
  return member ? member.displayName : truncHash(walletId, 6);
}

function getPharmacyName(pharmacyIndex) {
  if (state.pharmacies && state.pharmacies[pharmacyIndex]) {
    return state.pharmacies[pharmacyIndex].storeName;
  }
  return `Pharmacy #${pharmacyIndex}`;
}

function getMedicationInfo(medicationIndex) {
  if (state.medications && state.medications[medicationIndex]) {
    return state.medications[medicationIndex];
  }
  return null;
}

function rxStatusBadge(status) {
  const badgeTypes = {
    ACTIVE: 'fill',
    FILLED: 'settled',
    PARTIALLY_FILLED: 'pending',
    CANCELLED: 'reversal',
    REJECTED: 'reversal',
    REVERSED: 'reversal',
  };
  return renderBadge(status, badgeTypes[status] || 'pending');
}

function tierBadge(tier) {
  return `<span class="badge badge-tier-${tier}">Tier ${tier}</span>`;
}

// ============================================================================
// Header Updates
// ============================================================================

function updateHeaderIdentity() {
  const prescriber = getSelectedPrescriber();
  if (!prescriber) return;

  const walletDisplay = document.getElementById('header-wallet-id');
  walletDisplay.textContent = `NPI: ${prescriber.npi}`;

  const lifecyclePill = document.getElementById('header-lifecycle');
  lifecyclePill.className = 'lifecycle-pill lifecycle-active';
  lifecyclePill.textContent = 'ACTIVE';
}

function updateHealthDot(connected) {
  const dot = document.getElementById('header-health');
  dot.className = connected ? 'health-dot connected' : 'health-dot disconnected';
  dot.title = connected ? 'Connected to sequencer' : 'Disconnected from sequencer';
}

// ============================================================================
// Load All Sections
// ============================================================================

function loadPrescriberData() {
  updateHeaderIdentity();
  renderIdentity();
  renderPrescriptionForm();
  renderPcpPatients();
  renderHistory();
  renderActivity();
  renderPatientBreakdown();
  renderMedicationBreakdown();
  renderPharmacyBreakdown();
  renderFormulary();
  renderReceipts();
  renderNodeInfo();
}

// ============================================================================
// Section 1: Identity & Status
// ============================================================================

function renderIdentity() {
  const container = document.getElementById('section-identity');
  const prescriber = getSelectedPrescriber();
  if (!prescriber) {
    container.innerHTML = '';
    return;
  }

  const rxCount = getPrescriberPrescriptions().length;
  const paCount = getPrescriberPriorAuths().length;

  const grid = renderDataGrid([
    { label: 'Name', value: `${prescriber.firstName} ${prescriber.lastName}, ${prescriber.credential}` },
    { label: 'NPI', value: prescriber.npi },
    { label: 'Specialty', value: prescriber.specialty },
    { label: 'Credential', value: prescriber.credential },
    { label: 'State', value: prescriber.state },
    { label: 'Prescriptions', value: String(rxCount), mono: false },
    { label: 'Prior Auths', value: String(paCount), mono: false },
  ]);

  container.innerHTML = renderSectionCard('Identity & Status', COLOR, grid);
}

// ============================================================================
// Section: Write Prescription
// ============================================================================

let prescribeInFlight = false;

function renderPrescriptionForm() {
  const container = document.getElementById('section-prescribe');
  const enrolled = state.enrolledMembers || [];
  const medications = state.medications || [];
  const pharmacies = state.pharmacies || [];

  if (enrolled.length === 0) {
    container.innerHTML = renderSectionCard('Write Prescription', COLOR,
      '<div style="color: var(--text-secondary); text-align: center; padding: 16px;">No enrolled members — enroll patients from the landing page first</div>');
    return;
  }

  // Build patient options
  const patientOptions = enrolled.map((m) =>
    `<option value="${m.walletId}">${m.displayName} (${m.groupId || 'N/A'})</option>`
  ).join('');

  // Build medication options grouped by tier
  const tiers = [
    { tier: 1, label: 'Tier 1 — Generic ($10)' },
    { tier: 2, label: 'Tier 2 — Preferred ($30)' },
    { tier: 3, label: 'Tier 3 — Non-Preferred ($60)' },
    { tier: 4, label: 'Tier 4 — Specialty ($150)' },
  ];
  let medOptions = '';
  for (const t of tiers) {
    const meds = medications.filter((m) => m.tier === t.tier);
    if (meds.length > 0) {
      medOptions += `<optgroup label="${t.label}">`;
      for (const m of meds) {
        medOptions += `<option value="${m.index}">${m.brandName} (${m.genericName}) ${m.strength}</option>`;
      }
      medOptions += '</optgroup>';
    }
  }

  // Build pharmacy options
  const pharmacyOptions = pharmacies.map((p) =>
    `<option value="${p.index}">${p.storeName} — ${p.pharmacyType} (${p.city}, ${p.state})</option>`
  ).join('');

  const content = `
    <div class="rx-form">
      <div class="rx-form-row">
        <div class="rx-form-field">
          <label for="rx-patient">Patient</label>
          <select id="rx-patient" class="rx-select">${patientOptions}</select>
        </div>
        <div class="rx-form-field">
          <label for="rx-medication">Medication</label>
          <select id="rx-medication" class="rx-select">${medOptions}</select>
        </div>
      </div>
      <div class="rx-form-row">
        <div class="rx-form-field">
          <label for="rx-pharmacy">Send to Pharmacy</label>
          <select id="rx-pharmacy" class="rx-select">${pharmacyOptions}</select>
        </div>
        <div class="rx-form-field rx-form-field-short">
          <label for="rx-quantity">Qty</label>
          <input type="number" id="rx-quantity" class="rx-input" value="30" min="1" max="999" />
        </div>
        <div class="rx-form-field rx-form-field-short">
          <label for="rx-refills">Refills</label>
          <input type="number" id="rx-refills" class="rx-input" value="3" min="0" max="12" />
        </div>
      </div>
      <div class="rx-form-actions">
        <button id="rx-submit" class="btn-prescribe">Write Prescription</button>
        <span id="rx-status" class="rx-status-msg"></span>
      </div>
      <div id="rx-result"></div>
    </div>
  `;

  container.innerHTML = renderSectionCard('Write Prescription', COLOR, content);

  // Wire up the button (only once — check if already wired)
  const btn = document.getElementById('rx-submit');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = 'true';
    btn.addEventListener('click', handlePrescribe);
  }
}

async function handlePrescribe() {
  if (prescribeInFlight) return;

  const patientSelect = document.getElementById('rx-patient');
  const medSelect = document.getElementById('rx-medication');
  const pharmSelect = document.getElementById('rx-pharmacy');
  const qtyInput = document.getElementById('rx-quantity');
  const refillsInput = document.getElementById('rx-refills');
  const statusEl = document.getElementById('rx-status');
  const resultEl = document.getElementById('rx-result');
  const btn = document.getElementById('rx-submit');

  if (!patientSelect || !medSelect || !pharmSelect) return;

  const memberWalletId = patientSelect.value;
  const medicationIndex = parseInt(medSelect.value, 10);
  const pharmacyIndex = parseInt(pharmSelect.value, 10);
  const quantity = parseInt(qtyInput.value, 10) || 30;
  const refills = parseInt(refillsInput.value, 10) || 3;

  // Get display names for feedback
  const patientName = patientSelect.options[patientSelect.selectedIndex].text;
  const medName = medSelect.options[medSelect.selectedIndex].text;
  const pharmName = pharmSelect.options[pharmSelect.selectedIndex].text;

  prescribeInFlight = true;
  btn.disabled = true;
  btn.textContent = 'Generating ZK proof...';
  statusEl.textContent = `Prescribing ${medName} for ${patientName}...`;
  statusEl.className = 'rx-status-msg pending';
  resultEl.innerHTML = '';

  try {
    const result = await postJson('/interactive/prescribe', {
      prescriberIndex: selectedPrescriberIndex,
      memberWalletId,
      medicationIndex,
      pharmacyIndex,
      quantity,
      refills,
    });

    statusEl.textContent = 'Prescription created successfully';
    statusEl.className = 'rx-status-msg success';

    // Show result card
    const rx = result.prescription || result;
    resultEl.innerHTML = `
      <div class="rx-result-card">
        <div class="rx-result-header">Rx Created</div>
        <div class="rx-result-grid">
          <span class="rx-result-label">Rx ID</span><span class="mono">${rx.id || '--'}</span>
          <span class="rx-result-label">Patient</span><span>${patientName}</span>
          <span class="rx-result-label">Medication</span><span>${rx.medication || medName}</span>
          <span class="rx-result-label">Pharmacy</span><span>${pharmName}</span>
          <span class="rx-result-label">Qty / Refills</span><span>${quantity} / ${refills}</span>
          <span class="rx-result-label">Status</span><span>${rxStatusBadge(rx.status || 'ACTIVE')}</span>
          ${rx.receiptId ? `<span class="rx-result-label">L2 Receipt</span><span class="mono">${truncHash(rx.receiptId, 8)}</span>` : ''}
        </div>
      </div>
    `;

    // Refresh state to pick up new prescription
    state = await fetchJson('/node/state');
    loadPrescriberData();
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    statusEl.className = 'rx-status-msg error';
  } finally {
    prescribeInFlight = false;
    const btnRef = document.getElementById('rx-submit');
    if (btnRef) {
      btnRef.disabled = false;
      btnRef.textContent = 'Write Prescription';
    }
  }
}

// ============================================================================
// Section 1b: My PCP Patients
// ============================================================================

function renderPcpPatients() {
  const container = document.getElementById('section-pcp-patients');
  const enrolled = state.enrolledMembers || [];

  // Find members who have this prescriber as their PCP
  const pcpPatients = enrolled.filter(
    (m) => m.pcpAssignment && m.pcpAssignment.prescriberIndex === selectedPrescriberIndex,
  );

  if (pcpPatients.length === 0) {
    container.innerHTML = renderSectionCard('My PCP Patients', COLOR,
      '<div style="color: var(--text-secondary); text-align: center; padding: 16px;">No patients have assigned this prescriber as their PCP</div>');
    return;
  }

  const columns = [
    { key: 'displayName', label: 'Patient Name' },
    { key: 'walletId', label: 'Wallet ID', format: (v) => `<span class="mono">${truncHash(v, 8)}</span>` },
    { key: 'groupId', label: 'Group' },
    { key: 'familyId', label: 'Family' },
    { key: 'relationship', label: 'Relationship' },
    { key: 'lifecycle', label: 'Status', format: (v) => {
      const labels = { 1: 'REGISTERED', 2: 'ELIGIBLE', 3: 'ACTIVE', 4: 'REVOKED' };
      const classes = { 1: 'pending', 2: 'pending', 3: 'fill', 4: 'reversal' };
      return renderBadge(labels[v] || 'UNKNOWN', classes[v] || 'pending');
    }},
    { key: 'deductible', label: 'Deductible Used', align: 'right', format: (v) => formatCents(v) },
  ];

  const rows = pcpPatients.map((m) => ({
    displayName: m.displayName,
    walletId: m.walletId,
    groupId: m.groupId || '--',
    familyId: m.familyId || '--',
    relationship: m.relationship || '--',
    lifecycle: m.lifecycle,
    deductible: m.accumulator ? m.accumulator.deductiblePaidCents : 0,
  }));

  const table = renderSortableTable('pcp-patients-table', columns, rows, 'displayName');
  container.innerHTML = renderSectionCard(
    `My PCP Patients (${pcpPatients.length})`,
    COLOR,
    table,
  );
}

// ============================================================================
// Section 2: Prescribing History
// ============================================================================

function renderHistory() {
  const container = document.getElementById('section-history');
  const prescriptions = getPrescriberPrescriptions();

  const columns = [
    { key: 'id', label: 'Rx ID', format: (v) => `<span class="mono">${v}</span>` },
    { key: 'medication', label: 'Medication' },
    { key: 'medicationStrength', label: 'Strength' },
    { key: 'patient', label: 'Patient' },
    { key: 'pharmacy', label: 'Pharmacy' },
    { key: 'quantity', label: 'Qty', align: 'right' },
    { key: 'refillInfo', label: 'Refills' },
    { key: 'status', label: 'Status', format: (v) => rxStatusBadge(v) },
    { key: 'patientPayCents', label: 'Patient Pay', align: 'right', format: (v) => v ? formatCents(v) : '--' },
    { key: 'planPayCents', label: 'Plan Pay', align: 'right', format: (v) => v ? formatCents(v) : '--' },
  ];

  const rows = prescriptions.map((rx) => ({
    id: rx.id,
    medication: rx.medication,
    medicationStrength: rx.medicationStrength || '--',
    patient: getMemberDisplayName(rx.memberWalletId),
    pharmacy: getPharmacyName(rx.pharmacyIndex),
    quantity: rx.quantity,
    refillInfo: `${rx.refillsUsed || 0}/${rx.refills}`,
    status: rx.status,
    patientPayCents: rx.patientPayCents,
    planPayCents: rx.planPayCents,
  }));

  const table = renderSortableTable('history-table', columns, rows, 'id');
  container.innerHTML = renderSectionCard(
    `Prescribing History (${prescriptions.length})`,
    COLOR,
    table,
  );
}

// ============================================================================
// Section 3: Activity Summary
// ============================================================================

function renderActivity() {
  const container = document.getElementById('section-activity');
  const prescriptions = getPrescriberPrescriptions();
  const priorAuths = getPrescriberPriorAuths();

  const totalScripts = prescriptions.length;
  const activeScripts = prescriptions.filter(
    (rx) => rx.status !== 'CANCELLED' && rx.status !== 'REJECTED',
  ).length;
  const filledScripts = prescriptions.filter(
    (rx) => rx.status === 'FILLED' || rx.status === 'PARTIALLY_FILLED',
  ).length;
  const cancelledScripts = prescriptions.filter(
    (rx) => rx.status === 'CANCELLED' || rx.status === 'REJECTED',
  ).length;

  const pendingPA = priorAuths.filter((pa) => pa.status === 'PENDING').length;
  const approvedPA = priorAuths.filter((pa) => pa.status === 'APPROVED').length;
  const deniedPA = priorAuths.filter((pa) => pa.status === 'DENIED').length;

  // Financial totals
  let totalPatientPay = 0;
  let totalPlanPay = 0;
  for (const rx of prescriptions) {
    totalPatientPay += rx.patientPayCents || 0;
    totalPlanPay += rx.planPayCents || 0;
  }

  const metrics = renderMetricRow([
    { label: 'Total Scripts', value: totalScripts, color: 'var(--color-prescriber)' },
    { label: 'Active', value: activeScripts, color: 'var(--color-accent-green)' },
    { label: 'Filled', value: filledScripts, color: 'var(--color-accent-blue)' },
    { label: 'Cancelled/Rejected', value: cancelledScripts, color: 'var(--color-accent-red)' },
  ]);

  const paMetrics = renderMetricRow([
    { label: 'Prior Auth Pending', value: pendingPA, color: 'var(--color-accent-yellow)' },
    { label: 'Prior Auth Approved', value: approvedPA, color: 'var(--color-accent-green)' },
    { label: 'Prior Auth Denied', value: deniedPA, color: 'var(--color-accent-red)' },
  ]);

  const financials = renderMetricRow([
    { label: 'Total Patient Pay', value: formatCents(totalPatientPay), color: 'var(--color-member)' },
    { label: 'Total Plan Pay', value: formatCents(totalPlanPay), color: 'var(--color-insurer)' },
  ]);

  // By-status breakdown
  const statusCounts = {};
  for (const rx of prescriptions) {
    statusCounts[rx.status] = (statusCounts[rx.status] || 0) + 1;
  }
  const statusBreakdown = Object.entries(statusCounts)
    .map(([status, count]) => `<div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border-subtle);"><span>${rxStatusBadge(status)}</span><span style="font-weight: 600;">${count}</span></div>`)
    .join('');

  const content = `
    ${metrics}
    ${paMetrics}
    ${financials}
    ${statusBreakdown ? `<div style="margin-top: 12px;"><div style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Status Breakdown</div>${statusBreakdown}</div>` : ''}
  `;

  container.innerHTML = renderSectionCard('Activity Summary', COLOR, content);
}

// ============================================================================
// Section 4: Patient Breakdown
// ============================================================================

function renderPatientBreakdown() {
  const container = document.getElementById('section-patients');
  const prescriptions = getPrescriberPrescriptions();

  // Group by member wallet ID
  const patientMap = new Map();
  for (const rx of prescriptions) {
    const entry = patientMap.get(rx.memberWalletId) || {
      walletId: rx.memberWalletId,
      displayName: getMemberDisplayName(rx.memberWalletId),
      scriptCount: 0,
      medications: new Set(),
      totalPatientPay: 0,
      totalPlanPay: 0,
    };
    entry.scriptCount++;
    entry.medications.add(rx.medicationIndex);
    entry.totalPatientPay += rx.patientPayCents || 0;
    entry.totalPlanPay += rx.planPayCents || 0;
    patientMap.set(rx.memberWalletId, entry);
  }

  const columns = [
    { key: 'displayName', label: 'Patient' },
    { key: 'walletId', label: 'Wallet ID', format: (v) => `<span class="mono">${truncHash(v, 6)}</span>` },
    { key: 'scriptCount', label: 'Scripts', align: 'right' },
    { key: 'uniqueMeds', label: 'Unique Meds', align: 'right' },
    { key: 'totalPatientPay', label: 'Patient Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'totalPlanPay', label: 'Plan Pay', align: 'right', format: (v) => formatCents(v) },
  ];

  const rows = Array.from(patientMap.values()).map((p) => ({
    ...p,
    uniqueMeds: p.medications.size,
  })).sort((a, b) => b.scriptCount - a.scriptCount);

  const table = renderSortableTable('patients-table', columns, rows, 'scriptCount');
  container.innerHTML = renderSectionCard(
    `Patient Breakdown (${rows.length})`,
    COLOR,
    table,
  );
}

// ============================================================================
// Section 5: Medication Breakdown
// ============================================================================

function renderMedicationBreakdown() {
  const container = document.getElementById('section-medications');
  const prescriptions = getPrescriberPrescriptions();

  // Group by medication index
  const medMap = new Map();
  for (const rx of prescriptions) {
    const entry = medMap.get(rx.medicationIndex) || {
      medicationIndex: rx.medicationIndex,
      name: rx.medication,
      tier: null,
      scriptCount: 0,
      patients: new Set(),
      totalPatientPay: 0,
      totalPlanPay: 0,
    };
    const medInfo = getMedicationInfo(rx.medicationIndex);
    if (medInfo) {
      entry.tier = medInfo.tier;
    }
    entry.scriptCount++;
    entry.patients.add(rx.memberWalletId);
    entry.totalPatientPay += rx.patientPayCents || 0;
    entry.totalPlanPay += rx.planPayCents || 0;
    medMap.set(rx.medicationIndex, entry);
  }

  const columns = [
    { key: 'name', label: 'Medication' },
    { key: 'tier', label: 'Tier', format: (v) => v !== null ? tierBadge(v) : '--' },
    { key: 'scriptCount', label: 'Scripts', align: 'right' },
    { key: 'uniquePatients', label: 'Patients', align: 'right' },
    { key: 'totalPatientPay', label: 'Patient Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'totalPlanPay', label: 'Plan Pay', align: 'right', format: (v) => formatCents(v) },
  ];

  const rows = Array.from(medMap.values()).map((m) => ({
    ...m,
    uniquePatients: m.patients.size,
  })).sort((a, b) => b.scriptCount - a.scriptCount);

  const table = renderSortableTable('medications-table', columns, rows, 'scriptCount');
  container.innerHTML = renderSectionCard(
    `Medication Breakdown (${rows.length})`,
    COLOR,
    table,
  );
}

// ============================================================================
// Section 6: Pharmacy Breakdown
// ============================================================================

function renderPharmacyBreakdown() {
  const container = document.getElementById('section-pharmacies');
  const prescriptions = getPrescriberPrescriptions();

  // Group by pharmacy index
  const pharmMap = new Map();
  for (const rx of prescriptions) {
    const entry = pharmMap.get(rx.pharmacyIndex) || {
      pharmacyIndex: rx.pharmacyIndex,
      name: getPharmacyName(rx.pharmacyIndex),
      scriptCount: 0,
      patients: new Set(),
      medications: new Set(),
    };
    entry.scriptCount++;
    entry.patients.add(rx.memberWalletId);
    entry.medications.add(rx.medicationIndex);
    pharmMap.set(rx.pharmacyIndex, entry);
  }

  const columns = [
    { key: 'name', label: 'Pharmacy' },
    { key: 'scriptCount', label: 'Scripts', align: 'right' },
    { key: 'uniquePatients', label: 'Patients', align: 'right' },
    { key: 'uniqueMeds', label: 'Unique Meds', align: 'right' },
  ];

  const rows = Array.from(pharmMap.values()).map((p) => ({
    ...p,
    uniquePatients: p.patients.size,
    uniqueMeds: p.medications.size,
  })).sort((a, b) => b.scriptCount - a.scriptCount);

  const table = renderSortableTable('pharmacies-table', columns, rows, 'scriptCount');
  container.innerHTML = renderSectionCard(
    `Pharmacy Breakdown (${rows.length})`,
    COLOR,
    table,
  );
}

// ============================================================================
// Section 7: Formulary Lookup
// ============================================================================

function renderFormulary() {
  const container = document.getElementById('section-formulary');
  const medications = state.medications || [];

  if (medications.length === 0) {
    container.innerHTML = renderSectionCard('Formulary', COLOR,
      '<div style="color: var(--text-secondary); text-align: center; padding: 16px;">No formulary data available</div>',
      { collapsed: true });
    return;
  }

  const columns = [
    { key: 'brandName', label: 'Brand Name' },
    { key: 'genericName', label: 'Generic Name' },
    { key: 'strength', label: 'Strength' },
    { key: 'ndc', label: 'NDC', format: (v) => `<span class="mono">${v}</span>` },
    { key: 'tier', label: 'Tier', format: (v) => tierBadge(v) },
  ];

  const rows = medications.map((m) => ({
    brandName: m.brandName,
    genericName: m.genericName,
    strength: m.strength,
    ndc: m.ndc,
    tier: m.tier,
  }));

  const table = renderSortableTable('formulary-table', columns, rows, 'brandName');
  container.innerHTML = renderSectionCard(
    `Formulary (${medications.length} medications)`,
    COLOR,
    table,
    { collapsed: true },
  );
}

// ============================================================================
// Section 8: Prior Auth Requests
// ============================================================================

function renderReceipts() {
  const container = document.getElementById('section-receipts');
  const priorAuths = getPrescriberPriorAuths();

  if (priorAuths.length === 0) {
    container.innerHTML = renderSectionCard('Prior Authorization Requests', COLOR,
      '<div style="color: var(--text-secondary); text-align: center; padding: 16px;">No prior authorization requests</div>');
    return;
  }

  function paStatusBadge(status) {
    const types = { PENDING: 'pending', APPROVED: 'settled', DENIED: 'reversal' };
    return renderBadge(status, types[status] || 'pending');
  }

  const columns = [
    { key: 'id', label: 'PA ID', format: (v) => `<span class="mono">${v}</span>` },
    { key: 'memberName', label: 'Patient' },
    { key: 'medicationName', label: 'Medication' },
    { key: 'medicationStrength', label: 'Strength' },
    { key: 'medicationTier', label: 'Tier', format: (v) => tierBadge(v) },
    { key: 'status', label: 'Status', format: (v) => paStatusBadge(v) },
    { key: 'requestedAt', label: 'Requested', format: (v) => formatTimestamp(v) },
    { key: 'resolvedAt', label: 'Resolved', format: (v) => v ? formatTimestamp(v) : '--' },
  ];

  const table = renderSortableTable('pa-table', columns, priorAuths, 'id');
  container.innerHTML = renderSectionCard(
    `Prior Authorization Requests (${priorAuths.length})`,
    COLOR,
    table,
  );
}

// ============================================================================
// Section 9: Node Info
// ============================================================================

function renderNodeInfo() {
  const container = document.getElementById('section-info');

  const chainState = state.chainState || {};
  const l2 = state.l2 || {};
  const l2Status = l2.status || {};

  const grid = renderDataGrid([
    { label: 'Sequencer URL', value: 'http://127.0.0.1:3030' },
    { label: 'Node State', value: l2Status.running ? 'Running' : 'Stopped', mono: false },
    { label: 'Registry Root', value: truncHash(chainState.registryRoot, 8) },
    { label: 'Lifecycle Root', value: truncHash(chainState.lifecycleRoot, 8) },
    { label: 'Wallet Count', value: String(chainState.walletCount ?? 0), mono: false },
    { label: 'Pending Proofs', value: String(l2Status.pendingProofs ?? 0), mono: false },
    { label: 'Total Batches', value: String(l2Status.totalBatches ?? 0), mono: false },
    { label: 'Total Settled', value: String(l2Status.totalSettled ?? 0), mono: false },
  ]);

  container.innerHTML = renderSectionCard('Node Info', COLOR, grid, { collapsed: true });
}

// ============================================================================
// Boot
// ============================================================================

document.addEventListener('DOMContentLoaded', init);
