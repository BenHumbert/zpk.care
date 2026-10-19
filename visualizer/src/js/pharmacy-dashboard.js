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

// pharmacy-dashboard.js -- Adjuda-GATOR Pharmacy Node Dashboard
// ES module: renders pharmacy identity, DUR panel, dispensing history, and breakdowns

import {
  fetchJson,
  postJson,
  renderSectionCard,
  renderSearchBox,
  renderBadge,
  renderSortableTable,
  renderDataGrid,
  renderMetricRow,
  renderEntitySelector,
  formatCents,
  truncHash,
  formatDate,
  formatTimestamp,
  computeSummary,
  computeBreakdown,
  computeMedBreakdown,
  getActiveMedications,
  operationBadge,
  startAutoRefresh,
} from './node-common.js';

import {
  checkInteractions,
  getDurStatus,
  renderDurBadge,
  renderInteractionAlerts,
} from './drug-interactions.js';

// NADAC per unit as the engine computes it (src/fulfillment/nadac-pricing.ts): the console's copy, which
// tests/console-nadac-preview.test.ts holds to the engine's results for every drug in the catalog.
import { nadacPerUnitLabel, nadacUnitPriceE5 } from './interactive/nadac-price.js';

// ============================================================================
// State
// ============================================================================

let state = null;           // Full /node/state response
let selectedIndex = 0;      // Currently selected pharmacy index
let pharmacies = [];        // state.pharmacies array
let prescriptions = [];     // state.prescriptions (all)
let medications = [];       // state.medications
let enrolledMembers = [];   // state.enrolledMembers
let prescribers = [];       // state.prescribers (if available)

// Rx Queue state
let queueFilter = 'ALL';               // Current status filter
let selectedRxId = null;               // Currently selected prescription ID
let scannedMemberWalletId = null;       // Member whose NFC/credential was scanned
let scannedCredentialJson = null;       // The raw credential JSON (optional, for patient lookup)

// ============================================================================
// Bootstrap
// ============================================================================

async function init() {
  try {
    state = await fetchJson('/node/state');
  } catch (err) {
    document.querySelector('.dashboard-grid').innerHTML =
      `<div style="color: var(--color-accent-red); text-align: center; padding: 48px;">
        Failed to connect to sequencer: ${err.message}
      </div>`;
    return;
  }

  pharmacies = state.pharmacies || [];
  prescriptions = state.prescriptions || [];
  medications = state.medications || [];
  enrolledMembers = state.enrolledMembers || [];
  prescribers = state.prescribers || [];

  if (pharmacies.length === 0) {
    document.querySelector('.dashboard-grid').innerHTML =
      `<div style="color: var(--text-secondary); text-align: center; padding: 48px;">
        No pharmacies enrolled yet. Run a scenario first.
      </div>`;
    return;
  }

  // Build selector in header
  renderHeaderSelector();

  // Initial render
  renderAll();

  // Health check
  checkHealth();

  // Auto-refresh every 10 seconds
  startAutoRefresh(
    () => fetchJson('/node/state'),
    (newState) => {
      state = newState;
      pharmacies = state.pharmacies || [];
      prescriptions = state.prescriptions || [];
      medications = state.medications || [];
      enrolledMembers = state.enrolledMembers || [];
      prescribers = state.prescribers || [];
      renderAll();
    },
    10000,
  );

  // Health poll
  setInterval(checkHealth, 15000);
}

// ============================================================================
// Header
// ============================================================================

function renderHeaderSelector() {
  const container = document.getElementById('header-selector');
  const entities = pharmacies.map((p, i) => ({
    walletId: String(i),
    displayName: p.storeName || `Pharmacy ${i}`,
  }));
  container.innerHTML = renderEntitySelector(entities, String(selectedIndex), 'Pharmacy:');

  const select = container.querySelector('#entity-select');
  if (select) {
    select.addEventListener('change', (e) => {
      selectedIndex = Number(e.target.value);
      renderAll();
    });
  }
}

function updateHeader() {
  const pharm = pharmacies[selectedIndex];
  if (!pharm) return;

  const walletEl = document.getElementById('header-wallet-id');
  walletEl.textContent = pharm.walletId ? truncHash(pharm.walletId, 8) : pharm.ncpdpId || '--';

  const lcPill = document.getElementById('header-lifecycle');
  lcPill.textContent = 'ACTIVE';
  lcPill.className = 'lifecycle-pill lifecycle-active';
}

async function checkHealth() {
  const dot = document.getElementById('header-health');
  try {
    await fetchJson('/health');
    dot.className = 'health-dot connected';
    dot.title = 'Sequencer connected';
  } catch {
    dot.className = 'health-dot disconnected';
    dot.title = 'Sequencer disconnected';
  }
}

// ============================================================================
// Main Render
// ============================================================================

function renderAll() {
  updateHeader();
  renderRxQueue();
  renderIdentity();
  renderDurSection();
  renderDispensingHistory();
  renderActivitySummary();
  renderPatientBreakdown();
  renderPrescriberBreakdown();
  renderMedicationBreakdown();
  renderFormulary();
  renderReceipts();
  renderNodeInfo();
}

// ============================================================================
// Helper: get prescriptions for the currently selected pharmacy
// ============================================================================

function getMyPrescriptions() {
  return prescriptions.filter(
    (rx) => rx.pharmacyIndex === selectedIndex || rx.pharmacyIndex === String(selectedIndex),
  );
}

// Build flat claim views from prescriptions
function buildClaimViews(rxList) {
  return rxList.map((rx) => ({
    prescriptionId: rx.prescriptionId || rx.id || '--',
    dateOfService: rx.dateOfService || rx.date || '',
    patientPayCents: rx.patientPayCents || rx.patientPay || 0,
    planPayCents: rx.planPayCents || rx.planPay || 0,
    operationType: String(rx.operationType) === '2' ? 'reversal' : 'fulfillment',
    ndcHash: rx.ndcHash || rx.medicationIndex || '',
    brandName: rx.brandName || rx.medicationName || lookupMedName(rx.medicationIndex),
    therapeuticClass: rx.therapeuticClass || lookupTherapeuticClass(rx.medicationIndex),
    tierLevel: rx.tierLevel != null ? rx.tierLevel : lookupTier(rx.medicationIndex),
    memberWalletId: rx.memberWalletId || rx.patientWalletId || '',
    prescriberIndex: rx.prescriberIndex,
    prescriberName: rx.prescriberName || lookupPrescriberName(rx.prescriberIndex),
    pharmacyWalletId: rx.pharmacyWalletId || '',
    quantity: rx.quantity || rx.qty || '',
    status: rx.status || 'filled',
    daysSupply: rx.daysSupply || '',
    fillNumber: rx.fillNumber || '',
  }));
}

// ============================================================================
// Lookup Helpers
// ============================================================================

function lookupMedName(index) {
  if (index == null || !medications.length) return '--';
  const med = medications[Number(index)];
  return med ? (med.brandName || med.name || `Med #${index}`) : `Med #${index}`;
}

function lookupTherapeuticClass(index) {
  if (index == null || !medications.length) return '';
  const med = medications[Number(index)];
  return med ? (med.therapeuticClass || '') : '';
}

function lookupTier(index) {
  if (index == null || !medications.length) return null;
  const med = medications[Number(index)];
  return med ? (med.tierLevel != null ? med.tierLevel : null) : null;
}

function lookupPrescriberName(index) {
  if (index == null) return '--';
  if (prescribers.length) {
    const p = prescribers[Number(index)];
    if (p) return `${p.firstName || ''} ${p.lastName || ''}`.trim() || `Prescriber #${index}`;
  }
  return `Prescriber #${index}`;
}

function tierBadge(tier) {
  if (tier == null) return '--';
  const t = Number(tier);
  const labels = { 1: 'Tier 1 (Generic)', 2: 'Tier 2 (Preferred)', 3: 'Tier 3 (Non-Preferred)', 4: 'Tier 4 (Specialty)' };
  return `<span class="badge badge-tier-${t}">${labels[t] || `Tier ${t}`}</span>`;
}

function pharmacyTypeBadge(typeCode) {
  const types = {
    '01': { label: 'Retail', cls: 'fill' },
    '02': { label: 'Compounding', cls: 'pending' },
    '03': { label: 'LTC', cls: 'pcp' },
    '04': { label: 'Mail Order', cls: 'pcp' },
    '05': { label: 'Institutional', cls: 'settled' },
    '06': { label: 'Managed Care', cls: 'settled' },
    '07': { label: 'Specialty', cls: 'reversal' },
  };
  const info = types[typeCode] || { label: typeCode || '--', cls: 'pending' };
  return renderBadge(info.label, info.cls);
}

// ============================================================================
// 0. Prescription Queue
// ============================================================================

const RX_STATUS_ORDER = ['ACTIVE', 'DISPENSED', 'PARTIALLY_FILLED', 'FILLED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'REVERSED'];

// Which transitions a pharmacy can perform via Change Status
const PHARMACY_TRANSITIONS = {
  'ACTIVE': ['DISPENSED', 'REJECTED'],
  'DISPENSED': ['REJECTED'],
  'PARTIALLY_FILLED': ['REJECTED'],
  'FILLED': ['COMPLETED'],
};

function rxStatusBadge(status) {
  const map = {
    'ACTIVE': 'pending',
    'DISPENSED': 'dispensed',
    'PARTIALLY_FILLED': 'pcp',
    'FILLED': 'fill',
    'COMPLETED': 'settled',
    'CANCELLED': 'reversal',
    'REJECTED': 'reversal',
    'REVERSED': 'reversal',
  };
  return renderBadge(status, map[status] || 'pending');
}

function getQueuePrescriptions() {
  const myRx = prescriptions.filter(
    (rx) => rx.pharmacyIndex === selectedIndex || rx.pharmacyIndex === String(selectedIndex),
  );

  // Apply status filter
  let filtered = myRx;
  if (queueFilter !== 'ALL') {
    filtered = myRx.filter((rx) => rx.status === queueFilter);
  }

  // Apply credential scan filter (auto-select member's scripts)
  if (scannedMemberWalletId) {
    filtered = filtered.filter((rx) => rx.memberWalletId === scannedMemberWalletId);
  }

  return filtered;
}

function renderRxQueue() {
  const myRx = prescriptions.filter(
    (rx) => rx.pharmacyIndex === selectedIndex || rx.pharmacyIndex === String(selectedIndex),
  );

  // Status counts for filter chips
  const counts = { ALL: myRx.length };
  for (const s of RX_STATUS_ORDER) {
    counts[s] = myRx.filter((rx) => rx.status === s).length;
  }

  // Filter chips
  const filterChips = ['ALL', ...RX_STATUS_ORDER].map((s) => {
    const active = queueFilter === s ? ' active' : '';
    const count = counts[s] || 0;
    if (s !== 'ALL' && count === 0) return ''; // hide empty statuses
    return `<button class="rx-filter-chip${active}" data-filter="${s}">${s.replace('_', ' ')} <span class="chip-count">${count}</span></button>`;
  }).filter(Boolean).join('');

  // NFC / Patient Lookup area (optional filter — NOT required for dispensing)
  const scanArea = `
    <div class="rx-scan-area" style="margin-bottom: 12px;">
      <div style="display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 200px;">
          <label style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 4px;">NFC Card Data / Wallet ID</label>
          <input type="text" id="rx-nfc-input" class="mono" placeholder="Tap NFC card or paste wallet ID..." style="width: 100%; padding: 8px; font-size: 12px; background: var(--bg-primary); border: 1px solid var(--border-primary); border-radius: 4px; color: var(--text-primary);" />
        </div>
        <div style="flex: 1; min-width: 200px;">
          <label style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 4px;">Credential JSON (optional)</label>
          <input type="text" id="rx-credential-input" class="mono" placeholder="Paste credential JSON..." style="width: 100%; padding: 8px; font-size: 12px; background: var(--bg-primary); border: 1px solid var(--border-primary); border-radius: 4px; color: var(--text-primary);" />
        </div>
        <button id="rx-scan-btn" class="btn-action pharmacy" style="white-space: nowrap;">Scan / Lookup</button>
        ${scannedMemberWalletId ? `<button id="rx-clear-scan-btn" class="btn-action" style="background: var(--bg-tertiary); color: var(--text-secondary); white-space: nowrap;">Clear Filter</button>` : ''}
      </div>
      ${scannedMemberWalletId ? `
        <div class="rx-scan-result" style="margin-top: 8px;">
          <span class="rx-scan-verified">Verified</span>
          Patient: <span class="mono">${truncHash(scannedMemberWalletId, 8)}</span>
          — showing ${getQueuePrescriptions().length} script(s)
          <span style="margin-left: 12px; font-size: 11px; color: var(--text-secondary);">(filter only — not required for dispensing)</span>
        </div>
      ` : `
        <div style="margin-top: 6px; font-size: 11px; color: var(--text-secondary);">
          Optional: scan NFC card or enter wallet ID to filter prescriptions by patient
        </div>
      `}
    </div>
  `;

  // Queue table
  const filtered = getQueuePrescriptions();
  let tableHtml;
  if (filtered.length === 0) {
    tableHtml = `<div style="color: var(--text-secondary); padding: 24px; text-align: center;">
      ${myRx.length === 0 ? 'No prescriptions for this pharmacy yet' : 'No prescriptions match the current filter'}
    </div>`;
  } else {
    const rows = filtered.map((rx) => {
      const med = medications[Number(rx.medicationIndex)] || {};
      const tier = med.tier != null ? med.tier : (med.tierLevel != null ? med.tierLevel : null);
      const maxDaySupply = med.maxDaySupply || '--';
      const refillsRemaining = (rx.refills || 0) - (rx.refillsUsed || 0);
      const transitions = PHARMACY_TRANSITIONS[rx.status] || [];

      // Action button(s) — no credential required (fills are reversible)
      let actionHtml = '';
      if (rx.status === 'DISPENSED') {
        actionHtml += `<button class="btn-action pharmacy btn-sm rx-fill-btn" data-rx-id="${rx.id}">Fill</button> `;
      }
      if (rx.status === 'FILLED') {
        actionHtml += `<button class="btn-action btn-sm rx-complete-btn" data-rx-id="${rx.id}" style="background: var(--color-accent-green);">Complete (PoS)</button> `;
      }
      if (transitions.length > 0) {
        const opts = transitions.map((t) => `<option value="${t}">${t}</option>`).join('');
        actionHtml += `
          <select class="rx-status-select btn-sm" data-rx-id="${rx.id}">
            <option value="">Change...</option>
            ${opts}
          </select>`;
      }
      if (!actionHtml) {
        actionHtml = '<span style="color: var(--text-secondary); font-size: 11px;">—</span>';
      }

      const isSelected = selectedRxId === rx.id;
      return `
        <tr class="rx-row${isSelected ? ' rx-row-selected' : ''}" data-rx-id="${rx.id}" style="cursor: pointer;${isSelected ? ' background: var(--bg-tertiary); outline: 2px solid var(--color-pharmacy);' : ''}">
          <td class="mono" style="font-size: 11px;">${truncHash(rx.id, 6)}</td>
          <td>${med.brandName || rx.medication || '--'}${med.strength ? ` <span style="color:var(--text-secondary);font-size:11px;">${med.strength}</span>` : ''}</td>
          <td style="text-align:right;">${rx.quantity || '--'}</td>
          <td style="text-align:right;">${maxDaySupply}</td>
          <td>${tierBadge(tier)}</td>
          <td style="text-align:right;">${refillsRemaining}/${rx.refills || 0}</td>
          <td class="mono" style="font-size: 11px;">${truncHash(rx.memberWalletId, 4)}</td>
          <td>${rxStatusBadge(rx.status)}</td>
          <td class="rx-action-cell">${actionHtml}</td>
        </tr>
      `;
    }).join('');

    tableHtml = `
      <table class="sortable-table rx-queue-table">
        <thead>
          <tr>
            <th>Rx ID</th>
            <th>Drug</th>
            <th style="text-align:right;">Qty</th>
            <th style="text-align:right;">Days</th>
            <th>Tier</th>
            <th style="text-align:right;">Refills</th>
            <th>Patient</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Detail panel for selected prescription
  const detailPanel = selectedRxId ? renderRxDetailPanel(filtered) : '';

  const content = `
    <div class="rx-queue-container">
      <div class="rx-filter-row">${filterChips}</div>
      ${scanArea}
      ${tableHtml}
      ${detailPanel}
    </div>
  `;

  document.getElementById('section-rx-queue').innerHTML =
    renderSectionCard(`Prescription Queue (${filtered.length}/${myRx.length})`, 'pharmacy', content);

  // Attach event listeners
  attachQueueListeners();
}

function attachQueueListeners() {
  // Filter chips
  document.querySelectorAll('.rx-filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      queueFilter = btn.dataset.filter;
      renderRxQueue();
    });
  });

  // Credential / NFC scan
  const scanBtn = document.getElementById('rx-scan-btn');
  if (scanBtn) {
    scanBtn.addEventListener('click', handleCredentialScan);
  }

  // Clear scan filter
  const clearBtn = document.getElementById('rx-clear-scan-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      scannedMemberWalletId = null;
      scannedCredentialJson = null;
      renderRxQueue();
    });
  }

  // Row click → select prescription
  document.querySelectorAll('.rx-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      // Don't select when clicking buttons/selects inside the row
      if (e.target.closest('button') || e.target.closest('select')) return;
      const rxId = row.dataset.rxId;
      selectedRxId = selectedRxId === rxId ? null : rxId; // Toggle
      renderRxQueue();
    });
  });

  // Fill buttons
  document.querySelectorAll('.rx-fill-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleFill(btn.dataset.rxId));
  });

  // Complete (PoS) buttons
  document.querySelectorAll('.rx-complete-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleComplete(btn.dataset.rxId));
  });

  // Status change dropdowns
  document.querySelectorAll('.rx-status-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (sel.value) {
        handleStatusChange(sel.dataset.rxId, sel.value);
      }
    });
  });

  // Detail panel buttons
  const detailFillBtn = document.getElementById('detail-fill-btn');
  if (detailFillBtn) {
    detailFillBtn.addEventListener('click', () => handleFill(detailFillBtn.dataset.rxId));
  }
  const detailCompleteBtn = document.getElementById('detail-complete-btn');
  if (detailCompleteBtn) {
    detailCompleteBtn.addEventListener('click', () => handleComplete(detailCompleteBtn.dataset.rxId));
  }
  const detailReverseBtn = document.getElementById('detail-reverse-btn');
  if (detailReverseBtn) {
    detailReverseBtn.addEventListener('click', () => handleStatusChange(detailReverseBtn.dataset.rxId, 'REVERSED'));
  }
  const detailStatusSelect = document.getElementById('detail-status-select');
  if (detailStatusSelect) {
    detailStatusSelect.addEventListener('change', () => {
      if (detailStatusSelect.value) {
        handleStatusChange(detailStatusSelect.dataset.rxId, detailStatusSelect.value);
      }
    });
  }
}

function renderRxDetailPanel(rxList) {
  const rx = rxList.find((r) => r.id === selectedRxId);
  if (!rx) {
    selectedRxId = null;
    return '';
  }

  const med = medications[Number(rx.medicationIndex)] || {};
  const member = enrolledMembers.find((m) => m.walletId === rx.memberWalletId);
  const prescriber = lookupPrescriberName(rx.prescriberIndex);
  const tier = med.tier != null ? med.tier : (med.tierLevel != null ? med.tierLevel : null);
  const refillsRemaining = (rx.refills || 0) - (rx.refillsUsed || 0);
  const transitions = PHARMACY_TRANSITIONS[rx.status] || [];

  // Build action buttons for this prescription
  let actionsHtml = '';
  if (rx.status === 'DISPENSED') {
    actionsHtml += `<button id="detail-fill-btn" class="btn-action pharmacy" data-rx-id="${rx.id}">Fill Prescription</button> `;
  }
  if (rx.status === 'FILLED') {
    actionsHtml += `<button id="detail-complete-btn" class="btn-action" data-rx-id="${rx.id}" style="background: var(--color-accent-green);">Complete (PoS)</button> `;
  }
  if (rx.status === 'FILLED' || rx.status === 'COMPLETED') {
    actionsHtml += `<button id="detail-reverse-btn" class="btn-action" data-rx-id="${rx.id}" style="background: var(--color-accent-red);">Reverse Fill</button> `;
  }
  if (transitions.length > 0) {
    const opts = transitions.map((t) => `<option value="${t}">${t}</option>`).join('');
    actionsHtml += `
      <select id="detail-status-select" class="rx-status-select" data-rx-id="${rx.id}" style="padding: 6px 12px;">
        <option value="">Change Status...</option>
        ${opts}
      </select>`;
  }

  return `
    <div class="rx-detail-panel" style="margin-top: 12px; padding: 16px; background: var(--bg-secondary); border: 1px solid var(--color-pharmacy); border-radius: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h4 style="margin: 0; color: var(--text-primary);">Prescription Details</h4>
        <div>${rxStatusBadge(rx.status)}</div>
      </div>
      <div class="data-grid" style="grid-template-columns: 140px 1fr 140px 1fr; gap: 6px 12px;">
        <div class="label">Rx ID</div>
        <div class="value mono" style="font-size: 11px;" title="${rx.id}">${rx.id}</div>
        <div class="label">Status</div>
        <div class="value">${rx.status}</div>

        <div class="label">Medication</div>
        <div class="value">${med.brandName || rx.medication || '--'}${med.strength ? ` ${med.strength}` : ''}${med.dosageForm ? ` (${med.dosageForm})` : ''}</div>
        <div class="label">Generic</div>
        <div class="value">${med.genericName || '--'}</div>

        <div class="label">NDC</div>
        <div class="value mono">${med.ndc || '--'}</div>
        <div class="label">Tier</div>
        <div class="value">${tierBadge(tier)}</div>

        <div class="label">Quantity</div>
        <div class="value">${rx.quantity || '--'}</div>
        <div class="label">Days Supply</div>
        <div class="value">${med.maxDaySupply || '--'}</div>

        <div class="label">Refills</div>
        <div class="value">${refillsRemaining}/${rx.refills || 0} remaining</div>
        <div class="label">Therapeutic Class</div>
        <div class="value">${med.therapeuticClass || '--'}</div>

        <div class="label">Patient</div>
        <div class="value mono" style="font-size: 11px;">${rx.memberWalletId || '--'}</div>
        <div class="label">Prescriber</div>
        <div class="value">${prescriber}</div>
      </div>
      ${actionsHtml ? `
        <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-primary); display: flex; gap: 8px; flex-wrap: wrap;">
          ${actionsHtml}
        </div>
      ` : ''}
    </div>
  `;
}

async function handleCredentialScan() {
  const nfcInput = document.getElementById('rx-nfc-input');
  const credInput = document.getElementById('rx-credential-input');
  const nfcValue = nfcInput?.value?.trim();
  const credJson = credInput?.value?.trim();

  try {
    let walletId = null;

    // Priority 1: NFC card data / wallet ID
    if (nfcValue) {
      // Could be a raw wallet ID, or NFC NDEF payload
      if (/^\d+$/.test(nfcValue)) {
        // Raw numeric wallet ID
        walletId = nfcValue;
      } else {
        // Try parsing as JSON (NFC NDEF payload)
        try {
          const payload = JSON.parse(nfcValue);
          walletId = payload.walletId || payload.memberWalletId || payload.publicOutput?.walletId;
        } catch {
          // Not JSON — try as base64 or hex
          walletId = nfcValue; // Treat as wallet ID string
        }
      }
    }

    // Priority 2: Credential JSON
    if (!walletId && credJson) {
      const cred = JSON.parse(credJson);
      walletId = cred.publicOutput?.walletId || cred.walletId || cred.memberWalletId;
      scannedCredentialJson = credJson;
    }

    if (!walletId) {
      alert('Enter a wallet ID, NFC card data, or credential JSON');
      return;
    }

    scannedMemberWalletId = walletId;
    renderRxQueue();
  } catch (err) {
    alert(`Invalid input: ${err.message}`);
  }
}

async function handleFill(rxId) {
  const btn = document.querySelector(`.rx-fill-btn[data-rx-id="${rxId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

  try {
    // Kick off async fill — no credential required (fills are reversible)
    await postJson('/interactive/fill', {
      prescriptionId: rxId,
    });

    // Poll every 15s for up to 3 minutes
    if (btn) btn.textContent = 'Proving...';
    const POLL_INTERVAL = 15_000;
    const POLL_TIMEOUT = 180_000;
    const startTime = Date.now();

    while (Date.now() - startTime < POLL_TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (btn) btn.textContent = `Proving... (${elapsed}s)`;

      const job = await fetchJson(`/interactive/fill-status?prescriptionId=${encodeURIComponent(rxId)}`);
      if (job.status === 'complete') {
        // Refresh state
        const newState = await fetchJson('/node/state');
        state = newState;
        prescriptions = state.prescriptions || [];
        renderRxQueue();
        renderDispensingHistory();
        renderActivitySummary();
        return;
      }
      if (job.status === 'error') {
        throw new Error(job.error || 'Fill failed');
      }
    }
    throw new Error('Fill timed out after 3 minutes');
  } catch (err) {
    alert(`Fill failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Fill'; }
  }
}

async function handleComplete(rxId) {
  const btn = document.querySelector(`.rx-complete-btn[data-rx-id="${rxId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Completing...'; }

  try {
    await postJson('/interactive/update-rx-status', {
      prescriptionId: rxId,
      newStatus: 'COMPLETED',
      role: 'pharmacy',
      actorIndex: selectedIndex,
      note: 'Member verified credential — PoS pickup complete',
    });

    // Refresh state
    const newState = await fetchJson('/node/state');
    state = newState;
    prescriptions = state.prescriptions || [];
    renderRxQueue();
  } catch (err) {
    alert(`Complete failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Complete (PoS)'; }
  }
}

async function handleStatusChange(rxId, newStatus) {
  try {
    await postJson('/interactive/update-rx-status', {
      prescriptionId: rxId,
      newStatus,
      role: 'pharmacy',
      actorIndex: selectedIndex,
    });

    // Refresh state
    const newState = await fetchJson('/node/state');
    state = newState;
    prescriptions = state.prescriptions || [];
    renderRxQueue();
  } catch (err) {
    alert(`Status change failed: ${err.message}`);
  }
}

// ============================================================================
// 1. Identity & Status
// ============================================================================

function renderIdentity() {
  const pharm = pharmacies[selectedIndex];
  if (!pharm) return;

  const entries = [
    { label: 'Store Name', value: pharm.storeName || '--' },
    { label: 'NCPDP ID', value: pharm.ncpdpId || '--' },
    { label: 'NPI', value: pharm.npi || '--' },
    { label: 'Type', value: pharmacyTypeBadge(pharm.pharmacyType), mono: false },
    { label: 'Chain', value: pharm.chain || '--' },
    { label: 'Location', value: `${pharm.city || '--'}, ${pharm.state || '--'}` },
  ];

  document.getElementById('section-identity').innerHTML =
    renderSectionCard('Identity & Status', 'pharmacy', renderDataGrid(entries));
}

// ============================================================================
// 2. Drug Utilization Review (DUR)
// ============================================================================

function renderDurSection() {
  // Build patient dropdown options from enrolled members
  let memberOptions = '';
  if (enrolledMembers && enrolledMembers.length > 0) {
    memberOptions = enrolledMembers.map((m) => {
      return `<option value="${m.walletId}">${truncHash(m.walletId, 8)}</option>`;
    }).join('');
  }

  const searchHtml = `
    <div style="margin-bottom: 16px;">
      <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 6px;">
        Search patient for Drug Utilization Review
      </label>
      <div class="search-box">
        <select id="dur-member-select" class="entity-selector" style="flex: 1; min-width: 0;">
          <option value="">-- Select a patient --</option>
          ${memberOptions}
        </select>
        <input type="text" id="dur-wallet-input" class="mono" placeholder="or paste wallet ID" style="flex: 1;" />
        <button id="dur-search-btn" class="btn-action pharmacy">Run DUR</button>
      </div>
    </div>
    <div id="dur-results">
      <div style="color: var(--text-secondary); text-align: center; padding: 24px;">
        Select a patient above to perform Drug Utilization Review
      </div>
    </div>
  `;

  document.getElementById('section-dur').innerHTML =
    renderSectionCard('Drug Utilization Review (DUR)', 'pharmacy', searchHtml);

  // Attach event listeners
  const searchBtn = document.getElementById('dur-search-btn');
  const memberSelect = document.getElementById('dur-member-select');
  const walletInput = document.getElementById('dur-wallet-input');

  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      const walletId = walletInput.value.trim() || memberSelect.value;
      if (walletId) performDur(walletId);
    });
  }

  // Sync dropdown and input
  if (memberSelect) {
    memberSelect.addEventListener('change', () => {
      if (memberSelect.value) {
        walletInput.value = '';
      }
    });
  }
  if (walletInput) {
    walletInput.addEventListener('input', () => {
      if (walletInput.value.trim()) {
        memberSelect.value = '';
      }
    });
    walletInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const walletId = walletInput.value.trim() || memberSelect.value;
        if (walletId) performDur(walletId);
      }
    });
  }
}

async function performDur(memberWalletId) {
  const resultsEl = document.getElementById('dur-results');
  resultsEl.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 24px;">Loading DUR data...</div>`;

  let durData;
  try {
    durData = await fetchJson(`/node/dur?memberWalletId=${encodeURIComponent(memberWalletId)}`);
  } catch (err) {
    // Fallback: try claims-by-member
    try {
      durData = await fetchJson(`/node/claims-by-member?walletId=${encodeURIComponent(memberWalletId)}`);
    } catch (err2) {
      resultsEl.innerHTML = `<div style="color: var(--color-accent-red); padding: 16px;">DUR lookup failed: ${err2.message}</div>`;
      return;
    }
  }

  const claims = durData.claims || [];
  if (claims.length === 0) {
    resultsEl.innerHTML = `
      <div class="dur-panel">
        <div style="margin-bottom: 16px;">
          <h3 style="margin: 0 0 8px 0; color: var(--text-primary);">DUR Status</h3>
          ${renderDurBadge('green')}
        </div>
        <div style="color: var(--text-secondary); padding: 16px; text-align: center;">
          No claim history found for patient ${truncHash(memberWalletId, 6)}
        </div>
      </div>
    `;
    return;
  }

  // Transform claims to flat view
  const views = claims.map((c) => {
    const leaf = c.leaf || c;
    const metadata = c.metadata || {};
    return {
      dateOfService: leaf.dateOfService || '',
      patientPayCents: leaf.patientPayCents || leaf.patientPay || 0,
      planPayCents: leaf.planPayCents || leaf.planPay || 0,
      operationType: String(leaf.operationType) === '2' ? 'reversal' : 'fulfillment',
      ndcHash: leaf.ndcHash || leaf.medicationIndex || '',
      brandName: metadata.brandName || leaf.brandName || lookupMedName(leaf.medicationIndex),
      therapeuticClass: metadata.therapeuticClass || leaf.therapeuticClass || lookupTherapeuticClass(leaf.medicationIndex),
      tierLevel: metadata.tierLevel != null ? metadata.tierLevel : (leaf.tierLevel != null ? leaf.tierLevel : lookupTier(leaf.medicationIndex)),
      pharmacyWalletId: leaf.pharmacyWalletId || '',
      prescriberWalletId: leaf.prescriberWalletId || '',
      daysSupply: metadata.daysSupply || leaf.daysSupply || '',
      fillNumber: metadata.fillNumber || leaf.fillNumber || '',
    };
  });

  // Get active meds (non-reversed)
  const activeMeds = getActiveMedications(views);

  // Check interactions
  const alerts = checkInteractions(activeMeds);
  const status = getDurStatus(alerts);

  // Render DUR panel
  renderDurPanel(status, activeMeds, alerts, views, memberWalletId);
}

function renderDurPanel(status, activeMeds, alerts, allViews, memberWalletId) {
  const container = document.getElementById('dur-results');

  // Active medications table
  const activeMedsTable = renderActiveMedsTable(activeMeds);

  // Cross-pharmacy claim history table
  const claimTable = renderCrossPharmacyClaimTable(allViews);

  container.innerHTML = `
    <div class="dur-panel">
      <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 16px;">
        <h3 style="margin: 0; color: var(--text-primary);">DUR Status for ${truncHash(memberWalletId, 6)}</h3>
        ${renderDurBadge(status)}
      </div>

      <h4 style="margin: 16px 0 8px 0; color: var(--text-primary);">Active Medications (${activeMeds.length})</h4>
      ${activeMedsTable}

      <h4 style="margin: 16px 0 8px 0; color: var(--text-primary);">Drug Interaction Alerts</h4>
      ${renderInteractionAlerts(alerts)}

      <h4 style="margin: 16px 0 8px 0; color: var(--text-primary);">Complete Claim History (${allViews.length} records)</h4>
      ${claimTable}
    </div>
  `;
}

function renderActiveMedsTable(activeMeds) {
  if (activeMeds.length === 0) {
    return `<div style="color: var(--text-secondary); padding: 12px; text-align: center;">No active medications</div>`;
  }

  const columns = [
    { key: 'brandName', label: 'Medication' },
    { key: 'therapeuticClass', label: 'Therapeutic Class' },
    { key: 'tierLevel', label: 'Tier', format: (v) => tierBadge(v) },
    { key: 'dateOfService', label: 'Last Fill', format: (v) => formatDate(String(v)) },
    { key: 'daysSupply', label: 'Days Supply' },
  ];

  return renderSortableTable('dur-active-meds', columns, activeMeds);
}

function renderCrossPharmacyClaimTable(views) {
  if (views.length === 0) {
    return `<div style="color: var(--text-secondary); padding: 12px; text-align: center;">No claims</div>`;
  }

  const columns = [
    { key: 'dateOfService', label: 'Date', format: (v) => formatDate(String(v)) },
    { key: 'brandName', label: 'Medication' },
    { key: 'operationType', label: 'Type', format: (v) => v === 'reversal' ? renderBadge('Reversal', 'reversal') : renderBadge('Fill', 'fill') },
    { key: 'pharmacyWalletId', label: 'Pharmacy', format: (v) => truncHash(v, 4) },
    { key: 'patientPayCents', label: 'Patient Pay', format: (v) => formatCents(v), align: 'right' },
    { key: 'planPayCents', label: 'Plan Pay', format: (v) => formatCents(v), align: 'right' },
    { key: 'daysSupply', label: 'Days' },
  ];

  return renderSortableTable('dur-claim-history', columns, views);
}

// ============================================================================
// 3. Dispensing History
// ============================================================================

function renderDispensingHistory() {
  const myRx = getMyPrescriptions();
  const views = buildClaimViews(myRx);

  const columns = [
    { key: 'prescriptionId', label: 'Rx ID', format: (v) => truncHash(v, 6) },
    { key: 'brandName', label: 'Medication' },
    { key: 'memberWalletId', label: 'Patient', format: (v) => truncHash(v, 4) },
    { key: 'prescriberName', label: 'Prescriber' },
    { key: 'quantity', label: 'Qty' },
    { key: 'operationType', label: 'Status', format: (v) => operationBadge(v) },
    { key: 'patientPayCents', label: 'Patient Pay', format: (v) => formatCents(v), align: 'right' },
    { key: 'planPayCents', label: 'Plan Pay', format: (v) => formatCents(v), align: 'right' },
  ];

  const table = renderSortableTable('dispensing-history', columns, views);
  document.getElementById('section-history').innerHTML =
    renderSectionCard(`Dispensing History (${views.length})`, 'pharmacy', table);
}

// ============================================================================
// 4. Activity Summary
// ============================================================================

function renderActivitySummary() {
  const myRx = getMyPrescriptions();
  const views = buildClaimViews(myRx);
  const summary = computeSummary(views);

  // Unique patients
  const patientSet = new Set(views.map((v) => v.memberWalletId).filter(Boolean));

  const metrics = [
    { label: 'Total Fills', value: summary.totalClaims, color: 'var(--color-pharmacy)' },
    { label: 'Active', value: summary.activeClaims, color: 'var(--color-accent-green)' },
    { label: 'Unique Patients', value: patientSet.size, color: 'var(--color-member)' },
    { label: 'Unique Medications', value: summary.uniqueMedications, color: 'var(--color-accent-blue)' },
  ];

  document.getElementById('section-activity').innerHTML =
    renderSectionCard('Activity Summary', 'pharmacy', renderMetricRow(metrics));
}

// ============================================================================
// 5. Patient Breakdown
// ============================================================================

function renderPatientBreakdown() {
  const myRx = getMyPrescriptions();
  const views = buildClaimViews(myRx);
  const breakdown = computeBreakdown(views, 'memberWalletId');

  const columns = [
    { key: 'memberWalletId', label: 'Patient', format: (v) => truncHash(v, 6) },
    { key: 'claimCount', label: 'Scripts', align: 'right' },
    { key: 'uniqueMeds', label: 'Unique Meds', align: 'right' },
  ];

  const table = renderSortableTable('patient-breakdown', columns, breakdown);
  document.getElementById('section-patients').innerHTML =
    renderSectionCard(`Patient Breakdown (${breakdown.length})`, 'pharmacy', table);
}

// ============================================================================
// 6. Prescriber Breakdown
// ============================================================================

function renderPrescriberBreakdown() {
  const myRx = getMyPrescriptions();
  const views = buildClaimViews(myRx);
  const breakdown = computeBreakdown(views, 'prescriberIndex', ['prescriberName']);

  const rows = breakdown.map((b) => ({
    prescriberName: b.prescriberName || lookupPrescriberName(b.prescriberIndex),
    claimCount: b.claimCount,
  }));

  const columns = [
    { key: 'prescriberName', label: 'Prescriber' },
    { key: 'claimCount', label: 'Scripts', align: 'right' },
  ];

  const table = renderSortableTable('prescriber-breakdown', columns, rows);
  document.getElementById('section-prescribers').innerHTML =
    renderSectionCard(`Prescriber Breakdown (${rows.length})`, 'pharmacy', table);
}

// ============================================================================
// 7. Medication Breakdown
// ============================================================================

function renderMedicationBreakdown() {
  const myRx = getMyPrescriptions();
  const views = buildClaimViews(myRx);
  const breakdown = computeMedBreakdown(views);

  const columns = [
    { key: 'brandName', label: 'Drug Name' },
    { key: 'tierLevel', label: 'Tier', format: (v) => tierBadge(v) },
    { key: 'claimCount', label: 'Scripts', align: 'right' },
  ];

  const table = renderSortableTable('medication-breakdown', columns, breakdown);
  document.getElementById('section-medications').innerHTML =
    renderSectionCard(`Medication Breakdown (${breakdown.length})`, 'pharmacy', table);
}

// ============================================================================
// 8. Formulary Lookup
// ============================================================================

function renderFormulary() {
  if (!medications || medications.length === 0) {
    document.getElementById('section-formulary').innerHTML =
      renderSectionCard('Formulary', 'pharmacy',
        '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No formulary data available</div>');
    return;
  }

  // A fill is priced at NADAC per pricing unit (EA, ML or GM) times the quantity, plus the plan's dispensing fee, so the
  // list shows the NADAC price with its unit, as whole $0.00001 the way the engine reads it; AWP prices nothing here.
  const columns = [
    { key: 'brandName', label: 'Brand Name' },
    { key: 'genericName', label: 'Generic Name', format: (v) => v || '--' },
    { key: 'therapeuticClass', label: 'Class' },
    { key: 'tierLevel', label: 'Tier', format: (v) => tierBadge(v) },
    { key: 'nadacE5', label: 'NADAC/Unit', format: (_v, row) => row.nadacLabel, align: 'right' },
  ];

  const rows = medications.map((m, i) => ({
    brandName: m.brandName || m.name || `Med #${i}`,
    genericName: m.genericName || '',
    therapeuticClass: m.therapeuticClass || '',
    // the engine's /node/state names the tier `tier`
    tierLevel: m.tierLevel ?? m.tier,
    nadacE5: nadacUnitPriceE5(m.nadacPerUnit),
    nadacLabel: nadacPerUnitLabel(m),
  }));

  const table = renderSortableTable('formulary-table', columns, rows);
  document.getElementById('section-formulary').innerHTML =
    renderSectionCard(`Formulary (${rows.length} medications)`, 'pharmacy', table, { collapsed: true });
}

// ============================================================================
// 9. Receipts
// ============================================================================

function renderReceipts() {
  // Receipts are L2 sequencer receipts; pharmacy nodes do not have per-pharmacy receipts directly.
  // Show a note directing users to the L2 Chain tab for receipt details.
  document.getElementById('section-receipts').innerHTML =
    renderSectionCard('L2 Receipts', 'pharmacy',
      `<div style="color: var(--text-secondary); padding: 16px; text-align: center;">
        Pharmacy receipt data is tracked at the L2 sequencer level.
        See the L2 Chain tab in the interactive dashboard for receipt details.
      </div>`,
      { collapsed: true });
}

// ============================================================================
// 10. Node Info
// ============================================================================

function renderNodeInfo() {
  let chainInfo = '';

  fetchJson('/node/chain-state').then((chainState) => {
    const entries = [
      { label: 'Sequencer URL', value: 'http://127.0.0.1:3030' },
      { label: 'Registry Root', value: truncHash(chainState.registryRoot, 8) },
      { label: 'Lifecycle Root', value: truncHash(chainState.lifecycleRoot, 8) },
      { label: 'Wallet Count', value: chainState.walletCount != null ? String(chainState.walletCount) : '--' },
      { label: 'Pharmacies', value: String(pharmacies.length) },
      { label: 'Total Prescriptions', value: String(prescriptions.length) },
    ];
    document.getElementById('section-info').innerHTML =
      renderSectionCard('Node Info', 'pharmacy', renderDataGrid(entries), { collapsed: true });
  }).catch(() => {
    const entries = [
      { label: 'Sequencer URL', value: 'http://127.0.0.1:3030' },
      { label: 'Status', value: renderBadge('Unavailable', 'reversal'), mono: false },
      { label: 'Pharmacies', value: String(pharmacies.length) },
      { label: 'Total Prescriptions', value: String(prescriptions.length) },
    ];
    document.getElementById('section-info').innerHTML =
      renderSectionCard('Node Info', 'pharmacy', renderDataGrid(entries), { collapsed: true });
  });
}

// ============================================================================
// Init
// ============================================================================

init();
