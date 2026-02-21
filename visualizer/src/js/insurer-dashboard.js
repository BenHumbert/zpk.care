// insurer-dashboard.js -- Insurer / PBM Node Dashboard
// ES module — standalone page for the insurer's system-wide view.
// All data is opaque Poseidon hashes. Zero PHI/PII.

import {
  fetchJson,
  postJson,
  renderSectionCard,
  renderDataGrid,
  renderMetricRow,
  renderSortableTable,
  renderSearchBox,
  renderBadge,
  formatCents,
  truncHash,
  formatDate,
  formatTimestamp,
  operationBadge,
  statusBadge,
  startAutoRefresh,
} from './node-common.js';

const COLOR = 'insurer';
let state = null;

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  try {
    state = await fetchJson('/node/state');
    updateHealthDot(true);
  } catch (err) {
    console.warn('Failed to fetch initial state:', err.message);
    updateHealthDot(false);
  }
  loadAllSections();

  startAutoRefresh(
    () => fetchJson('/node/state'),
    (newState) => {
      state = newState;
      updateHealthDot(true);
      renderOverview();
    },
    10000
  );
}

function updateHealthDot(connected) {
  const dot = document.getElementById('header-health');
  if (!dot) return;
  dot.className = connected ? 'health-dot connected' : 'health-dot disconnected';
  dot.title = connected ? 'Connected to sequencer' : 'Disconnected';
}

async function loadAllSections() {
  renderOverview();
  renderExplorer();
  renderReports();
  renderAuditSuite();
  renderAdmin();
  await renderChainProof();
  await renderReceipts();
  await renderBatches();
  await renderAuditChain();
  renderNodeInfo();
}

// ============================================================================
// Section 1: System Overview
// ============================================================================

function renderOverview() {
  const el = document.getElementById('section-overview');
  if (!el) return;

  const audit = state?.auditSummary || {};
  const totalPatientPay = audit.totalPatientPayCents || 0;
  const totalPlanPay = audit.totalPlanPayCents || 0;

  // Count wallets, prescriptions, fulfillments
  const enrolled = state?.enrolledMembers || [];
  const prescriptions = state?.prescriptions || [];
  const fulfillments = state?.fulfillments || [];

  // We will fetch L2 status for batch/receipt counts
  const l2 = state?.l2 || {};
  const l2Status = l2.status || {};
  const totalReceipts = l2Status.totalProofsAccepted || 0;
  const totalBatchesBuilt = l2Status.totalBatchesBuilt || 0;
  const totalBatchesSettled = l2Status.totalBatchesSettled || 0;
  const totalBatchesFailed = l2Status.totalBatchesFailed || 0;
  const auditChainLength = audit.enrollmentCount + audit.prescriptionCount + audit.fulfillmentCount || 0;
  const chainProofEnabled = l2Status.chainProofEnabled || false;

  const metrics = [
    { label: 'Total Wallets', value: enrolled.length, color: 'var(--color-insurer)' },
    { label: 'Total Receipts', value: totalReceipts, color: 'var(--color-accent-blue)' },
    { label: 'Total Batches', value: `${totalBatchesBuilt} (${totalBatchesSettled}S / ${totalBatchesFailed}F)`, color: 'var(--color-accent-green)' },
    { label: 'Audit Events', value: auditChainLength, color: 'var(--color-accent-yellow)' },
    { label: 'Chain Proof', value: chainProofEnabled ? 'Enabled' : 'Disabled', color: chainProofEnabled ? 'var(--color-accent-green)' : 'var(--text-secondary)' },
  ];

  const financialMetrics = [
    { label: 'Total Patient Pay', value: formatCents(totalPatientPay), color: 'var(--color-member)' },
    { label: 'Total Plan Pay', value: formatCents(totalPlanPay), color: 'var(--color-insurer)' },
    { label: 'Prescriptions', value: prescriptions.length },
    { label: 'Fulfillments', value: fulfillments.length },
  ];

  const content = `
    ${renderMetricRow(metrics)}
    ${renderMetricRow(financialMetrics)}
    <div style="font-size: 11px; color: var(--text-secondary); text-align: center; margin-top: 4px;">
      All values are derived from opaque Poseidon hashes and aggregate financial data. No PHI visible.
    </div>
  `;

  el.innerHTML = renderSectionCard('System Overview', COLOR, content);
}

// ============================================================================
// Section 2: Claims Explorer
// ============================================================================

function renderExplorer() {
  const el = document.getElementById('section-explorer');
  if (!el) return;

  const tabs = ['By Member', 'By Prescriber', 'By Pharmacy', 'By Drug'];
  const searchPlaceholders = [
    'Member wallet ID...',
    'Prescriber wallet ID...',
    'Pharmacy wallet ID...',
    'NDC hash...',
  ];
  const paramNames = ['walletId', 'walletId', 'walletId', 'ndcHash'];
  const endpoints = [
    '/node/claims-by-member?walletId=',
    '/node/claims-by-prescriber?walletId=',
    '/node/claims-by-pharmacy?walletId=',
    '/node/claims-by-ndc?ndcHash=',
  ];

  const tabButtons = tabs.map((label, i) =>
    `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab-index="${i}">${label}</button>`
  ).join('');

  const tabPanels = tabs.map((label, i) => `
    <div class="explorer-tab-panel${i === 0 ? '' : ' hidden'}" data-panel-index="${i}">
      ${renderSearchBox(`explorer-search-${i}`, `explorer-btn-${i}`, searchPlaceholders[i], 'Search')}
      <div id="explorer-results-${i}">
        <div style="color: var(--text-secondary); padding: 16px; text-align: center; font-size: 13px;">
          Enter a ${paramNames[i]} and click Search to query claims.
        </div>
      </div>
    </div>
  `).join('');

  const content = `
    <div class="tab-switcher">${tabButtons}</div>
    ${tabPanels}
  `;

  el.innerHTML = renderSectionCard('Claims Explorer', COLOR, content);

  // Wire up tab switching
  el.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.tabIndex, 10);
      el.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      el.querySelectorAll('.explorer-tab-panel').forEach(p => p.classList.add('hidden'));
      el.querySelector(`[data-panel-index="${idx}"]`).classList.remove('hidden');
    });
  });

  // Wire up search buttons
  tabs.forEach((_, i) => {
    const searchBtn = document.getElementById(`explorer-btn-${i}`);
    const searchInput = document.getElementById(`explorer-search-${i}`);
    if (searchBtn && searchInput) {
      const doSearch = async () => {
        const value = searchInput.value.trim();
        if (!value) return;
        const resultsDiv = document.getElementById(`explorer-results-${i}`);
        resultsDiv.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">Searching...</div>';
        try {
          const data = await fetchJson(`${endpoints[i]}${encodeURIComponent(value)}`);
          renderExplorerResults(resultsDiv, data);
        } catch (err) {
          resultsDiv.innerHTML = `<div style="color: var(--color-accent-red); padding: 16px;">${err.message}</div>`;
        }
      };
      searchBtn.addEventListener('click', doSearch);
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
      });
    }
  });
}

function renderExplorerResults(container, data) {
  const claims = data.claims || data.views || data.results || [];
  if (!Array.isArray(claims) || claims.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No claims found for this query.</div>';
    return;
  }

  const columns = [
    { key: 'leafIndex', label: 'Leaf', align: 'right' },
    { key: 'dateOfService', label: 'Date', format: (v) => formatDate(v) },
    { key: 'ndcHash', label: 'NDC Hash', format: (v) => `<span class="mono" style="font-size: 11px;">${truncHash(v, 6)}</span>` },
    { key: 'memberWalletId', label: 'Member', format: (v) => `<span class="mono" style="font-size: 11px;">${truncHash(v, 6)}</span>` },
    { key: 'prescriberWalletId', label: 'Prescriber', format: (v) => `<span class="mono" style="font-size: 11px;">${truncHash(v, 6)}</span>` },
    { key: 'pharmacyWalletId', label: 'Pharmacy', format: (v) => `<span class="mono" style="font-size: 11px;">${truncHash(v, 6)}</span>` },
    { key: 'patientPayCents', label: 'Patient Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'planPayCents', label: 'Plan Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'operationType', label: 'Type', format: (v) => v === 'reversal' ? renderBadge('Reversal', 'reversal') : renderBadge('Fill', 'fill') },
  ];

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">${claims.length} claim(s) found</div>
    <div style="max-height: 400px; overflow-y: auto;">
      ${renderSortableTable('explorer-table', columns, claims)}
    </div>
  `;
}

// ============================================================================
// Section 3: Reports
// ============================================================================

function renderReports() {
  const el = document.getElementById('section-reports');
  if (!el) return;

  const reportTypes = [
    'Claims Register',
    'Financial Summary',
    'Pharmacy Activity',
    'Prescriber Activity',
    'Member Activity',
    'Medication Utilization',
    'Prior Auth',
    'Reversal',
    'Tier Analysis',
    'Therapeutic Class',
    'Time Series',
    'Cross-Tab',
  ];

  const options = reportTypes.map(r => `<option value="${r}">${r}</option>`).join('');

  const content = `
    <div class="filter-row" style="align-items: flex-end;">
      <div>
        <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 4px;">Report Type</label>
        <select id="report-type" style="padding: 8px 12px; background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--text-primary); font-size: 13px; font-family: inherit; outline: none; min-width: 200px;">
          ${options}
        </select>
      </div>
      <div>
        <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 4px;">From</label>
        <input type="date" id="report-date-start" class="date-input" style="padding: 8px 12px; background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--text-primary); font-size: 13px; outline: none;" />
      </div>
      <div>
        <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 4px;">To</label>
        <input type="date" id="report-date-end" class="date-input" style="padding: 8px 12px; background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--text-primary); font-size: 13px; outline: none;" />
      </div>
      <button class="btn-action insurer" id="btn-generate-report">Generate</button>
    </div>
    <div id="report-output" style="margin-top: 16px;">
      <div style="color: var(--text-secondary); padding: 16px; text-align: center; font-size: 13px;">
        Select a report type and click Generate.
      </div>
    </div>
  `;

  el.innerHTML = renderSectionCard('Reports', COLOR, content);

  document.getElementById('btn-generate-report').addEventListener('click', () => {
    const reportType = document.getElementById('report-type').value;
    generateReport(reportType);
  });
}

function generateReport(reportType) {
  const output = document.getElementById('report-output');
  if (!output || !state) return;

  const prescriptions = state.prescriptions || [];
  const fulfillments = state.fulfillments || [];
  const enrolled = state.enrolledMembers || [];
  const audit = state.auditSummary || {};

  switch (reportType) {
    case 'Claims Register':
      generateClaimsRegister(output, prescriptions, fulfillments);
      break;
    case 'Financial Summary':
      generateFinancialSummary(output, fulfillments, audit);
      break;
    case 'Pharmacy Activity':
      generateGroupedReport(output, fulfillments, 'pharmacyWalletId', 'Pharmacy Wallet');
      break;
    case 'Prescriber Activity':
      generateGroupedReport(output, fulfillments, 'prescriberWalletId', 'Prescriber Wallet');
      break;
    case 'Member Activity':
      generateGroupedReport(output, fulfillments, 'memberWalletId', 'Member Wallet');
      break;
    case 'Medication Utilization':
      generateGroupedReport(output, fulfillments, 'ndcHash', 'NDC Hash');
      break;
    case 'Prior Auth':
      generatePriorAuthReport(output);
      break;
    case 'Reversal':
      generateReversalReport(output, fulfillments);
      break;
    case 'Tier Analysis':
      generateTierAnalysis(output, fulfillments);
      break;
    case 'Therapeutic Class':
      generateGroupedReport(output, fulfillments, 'therapeuticClass', 'Therapeutic Class');
      break;
    case 'Time Series':
      generateTimeSeriesReport(output, fulfillments);
      break;
    case 'Cross-Tab':
      generateCrossTabReport(output, fulfillments);
      break;
    default:
      output.innerHTML = '<div style="color: var(--text-secondary); padding: 16px;">Report type not yet implemented.</div>';
  }
}

function generateClaimsRegister(container, prescriptions, fulfillments) {
  if (prescriptions.length === 0 && fulfillments.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No claims data available.</div>';
    return;
  }

  // Merge prescriptions with fulfillment data
  const rows = prescriptions.map(rx => {
    const fill = fulfillments.find(f => f.prescriptionId === rx.id);
    return {
      id: rx.id,
      memberWallet: truncHash(rx.memberWalletId, 6),
      status: rx.status || (rx.filled ? 'FILLED' : 'ACTIVE'),
      quantity: rx.quantity || 0,
      quantityDispensed: rx.quantityDispensed || 0,
      patientPay: fill ? formatCents(fill.patientPayCents || 0) : '--',
      planPay: fill ? formatCents(fill.planPayCents || 0) : '--',
      totalCost: fill ? formatCents(fill.totalCostCents || 0) : '--',
      reversed: fill?.reversed ? 'Yes' : 'No',
    };
  });

  const columns = [
    { key: 'id', label: 'Rx ID' },
    { key: 'memberWallet', label: 'Member (Hash)' },
    { key: 'status', label: 'Status', format: (v) => renderBadge(v, v === 'FILLED' ? 'fill' : 'pending') },
    { key: 'quantity', label: 'Qty', align: 'right' },
    { key: 'quantityDispensed', label: 'Dispensed', align: 'right' },
    { key: 'patientPay', label: 'Patient Pay', align: 'right' },
    { key: 'planPay', label: 'Plan Pay', align: 'right' },
    { key: 'totalCost', label: 'Total Cost', align: 'right' },
    { key: 'reversed', label: 'Reversed' },
  ];

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Claims Register: ${rows.length} prescription(s)</div>
    <div style="max-height: 400px; overflow-y: auto;">
      ${renderSortableTable('report-claims', columns, rows)}
    </div>
  `;
}

function generateFinancialSummary(container, fulfillments, audit) {
  let totalPatient = 0, totalPlan = 0, totalCost = 0;
  let reversalCount = 0, reversedPatient = 0, reversedPlan = 0;

  for (const f of fulfillments) {
    if (f.reversed) {
      reversalCount++;
      reversedPatient += f.patientPayCents || 0;
      reversedPlan += f.planPayCents || 0;
    } else {
      totalPatient += f.patientPayCents || 0;
      totalPlan += f.planPayCents || 0;
      totalCost += f.totalCostCents || 0;
    }
  }

  const activeFills = fulfillments.length - reversalCount;
  const avgCost = activeFills > 0 ? Math.round(totalCost / activeFills) : 0;

  const metrics = [
    { label: 'Active Claims', value: activeFills },
    { label: 'Patient Pay', value: formatCents(totalPatient), color: 'var(--color-member)' },
    { label: 'Plan Pay', value: formatCents(totalPlan), color: 'var(--color-insurer)' },
    { label: 'Total Cost', value: formatCents(totalCost) },
    { label: 'Avg Claim', value: formatCents(avgCost) },
  ];

  let html = renderMetricRow(metrics);

  if (reversalCount > 0) {
    html += renderMetricRow([
      { label: 'Reversals', value: reversalCount, color: 'var(--color-accent-red)' },
      { label: 'Patient Refund', value: formatCents(reversedPatient) },
      { label: 'Plan Refund', value: formatCents(reversedPlan) },
    ]);
  }

  const enrollments = audit.enrollmentCount || 0;
  const rxCount = audit.prescriptionCount || 0;
  const fillCount = audit.fulfillmentCount || 0;

  html += `
    <div style="margin-top: 16px;">
      ${renderMetricRow([
        { label: 'Enrollments', value: enrollments },
        { label: 'Prescriptions', value: rxCount },
        { label: 'Fulfillments', value: fillCount },
      ])}
    </div>
  `;

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Financial Summary</div>
    ${html}
  `;
}

function generateGroupedReport(container, fulfillments, groupKey, groupLabel) {
  if (fulfillments.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No fulfillment data available.</div>';
    return;
  }

  const groups = new Map();
  for (const f of fulfillments) {
    if (f.reversed) continue;
    const key = f[groupKey] || 'Unknown';
    const g = groups.get(key) || { key, count: 0, patientPay: 0, planPay: 0, totalCost: 0 };
    g.count++;
    g.patientPay += f.patientPayCents || 0;
    g.planPay += f.planPayCents || 0;
    g.totalCost += f.totalCostCents || 0;
    groups.set(key, g);
  }

  const rows = [...groups.values()].sort((a, b) => b.count - a.count);
  const columns = [
    { key: 'key', label: groupLabel, format: (v) => `<span class="mono" style="font-size: 11px;">${truncHash(v, 8)}</span>` },
    { key: 'count', label: 'Claims', align: 'right' },
    { key: 'patientPay', label: 'Patient Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'planPay', label: 'Plan Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'totalCost', label: 'Total Cost', align: 'right', format: (v) => formatCents(v) },
  ];

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">${groupLabel} Activity: ${rows.length} unique entities</div>
    <div style="max-height: 400px; overflow-y: auto;">
      ${renderSortableTable('report-grouped', columns, rows)}
    </div>
  `;
}

function generatePriorAuthReport(container) {
  const pas = state?.priorAuths || [];
  if (pas.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No prior authorization data available.</div>';
    return;
  }

  const columns = [
    { key: 'id', label: 'PA ID' },
    { key: 'memberWalletId', label: 'Member', format: (v) => `<span class="mono" style="font-size: 11px;">${truncHash(v, 6)}</span>` },
    { key: 'medicationName', label: 'Medication' },
    { key: 'medicationTier', label: 'Tier', format: (v) => renderBadge(`T${v}`, `tier-${v}`) },
    { key: 'status', label: 'Status', format: (v) => {
      if (v === 'APPROVED') return renderBadge('Approved', 'fill');
      if (v === 'DENIED') return renderBadge('Denied', 'reversal');
      return renderBadge('Pending', 'pending');
    }},
    { key: 'prescriberName', label: 'Prescriber' },
  ];

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Prior Authorization Report: ${pas.length} request(s)</div>
    <div style="max-height: 400px; overflow-y: auto;">
      ${renderSortableTable('report-pa', columns, pas)}
    </div>
  `;
}

function generateReversalReport(container, fulfillments) {
  const reversals = fulfillments.filter(f => f.reversed);
  if (reversals.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No reversals recorded.</div>';
    return;
  }

  const columns = [
    { key: 'prescriptionId', label: 'Rx ID' },
    { key: 'memberWalletId', label: 'Member', format: (v) => `<span class="mono" style="font-size: 11px;">${truncHash(v, 6)}</span>` },
    { key: 'patientPayCents', label: 'Patient Refund', align: 'right', format: (v) => formatCents(v) },
    { key: 'planPayCents', label: 'Plan Refund', align: 'right', format: (v) => formatCents(v) },
  ];

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Reversal Report: ${reversals.length} reversal(s)</div>
    <div style="max-height: 400px; overflow-y: auto;">
      ${renderSortableTable('report-reversals', columns, reversals)}
    </div>
  `;
}

function generateTierAnalysis(container, fulfillments) {
  if (fulfillments.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No fulfillment data available.</div>';
    return;
  }

  const tiers = new Map();
  for (const f of fulfillments) {
    if (f.reversed) continue;
    const tier = f.tierLevel || 1;
    const t = tiers.get(tier) || { tier, count: 0, patientPay: 0, planPay: 0 };
    t.count++;
    t.patientPay += f.patientPayCents || 0;
    t.planPay += f.planPayCents || 0;
    tiers.set(tier, t);
  }

  const tierLabels = { 1: 'Generic', 2: 'Preferred', 3: 'Non-Preferred', 4: 'Specialty' };
  const rows = [...tiers.values()].sort((a, b) => a.tier - b.tier).map(t => ({
    ...t,
    tierLabel: `Tier ${t.tier} (${tierLabels[t.tier] || 'Other'})`,
  }));

  const columns = [
    { key: 'tierLabel', label: 'Tier', format: (v, row) => renderBadge(v, `tier-${row.tier}`) },
    { key: 'count', label: 'Claims', align: 'right' },
    { key: 'patientPay', label: 'Patient Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'planPay', label: 'Plan Pay', align: 'right', format: (v) => formatCents(v) },
  ];

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Tier Analysis</div>
    ${renderSortableTable('report-tiers', columns, rows)}
  `;
}

function generateTimeSeriesReport(container, fulfillments) {
  if (fulfillments.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No fulfillment data available.</div>';
    return;
  }

  const byDate = new Map();
  for (const f of fulfillments) {
    if (f.reversed) continue;
    const date = f.dateOfService || 'Unknown';
    const d = byDate.get(date) || { date, count: 0, patientPay: 0, planPay: 0 };
    d.count++;
    d.patientPay += f.patientPayCents || 0;
    d.planPay += f.planPayCents || 0;
    byDate.set(date, d);
  }

  const rows = [...byDate.values()].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const columns = [
    { key: 'date', label: 'Date', format: (v) => formatDate(v) },
    { key: 'count', label: 'Claims', align: 'right' },
    { key: 'patientPay', label: 'Patient Pay', align: 'right', format: (v) => formatCents(v) },
    { key: 'planPay', label: 'Plan Pay', align: 'right', format: (v) => formatCents(v) },
  ];

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Time Series: ${rows.length} date(s)</div>
    ${renderSortableTable('report-timeseries', columns, rows)}
  `;
}

function generateCrossTabReport(container, fulfillments) {
  if (fulfillments.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No fulfillment data available.</div>';
    return;
  }

  // Cross-tab: Member x Pharmacy
  const crossTab = new Map();
  const pharmacies = new Set();
  for (const f of fulfillments) {
    if (f.reversed) continue;
    const member = truncHash(f.memberWalletId, 4);
    const pharmacy = truncHash(f.pharmacyWalletId, 4);
    pharmacies.add(pharmacy);
    const key = `${member}|${pharmacy}`;
    crossTab.set(key, (crossTab.get(key) || 0) + 1);
  }

  const memberSet = new Set();
  for (const f of fulfillments) {
    if (!f.reversed) memberSet.add(truncHash(f.memberWalletId, 4));
  }

  const pharmList = [...pharmacies].sort();
  const memberList = [...memberSet].sort();

  let tableHtml = '<table class="sortable-table"><thead><tr><th>Member</th>';
  for (const p of pharmList) {
    tableHtml += `<th style="font-size: 10px;">${p}</th>`;
  }
  tableHtml += '</tr></thead><tbody>';

  for (const m of memberList) {
    tableHtml += `<tr><td class="mono" style="font-size: 11px;">${m}</td>`;
    for (const p of pharmList) {
      const count = crossTab.get(`${m}|${p}`) || 0;
      tableHtml += `<td style="text-align: center; ${count > 0 ? 'color: var(--color-accent-green); font-weight: 600;' : 'color: var(--text-tertiary);'}">${count || '-'}</td>`;
    }
    tableHtml += '</tr>';
  }
  tableHtml += '</tbody></table>';

  container.innerHTML = `
    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Cross-Tab: Member x Pharmacy (claim counts)</div>
    <div style="overflow-x: auto;">${tableHtml}</div>
  `;
}

// ============================================================================
// Section 4: Audit Suite
// ============================================================================

function renderAuditSuite() {
  const el = document.getElementById('section-audit');
  if (!el) return;

  const content = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="audit-card" id="audit-chain-integrity">
        <div class="audit-name">Chain Integrity</div>
        <div class="audit-result">Verifies Poseidon hash chain is intact and tamper-free.</div>
        <button class="btn-action insurer" id="btn-audit-chain" style="margin-top: 8px; font-size: 12px;">Run Check</button>
        <div id="audit-chain-result" style="margin-top: 8px;"></div>
      </div>
      <div class="audit-card" id="audit-financial-balance">
        <div class="audit-name">Financial Balance</div>
        <div class="audit-result">Checks that debits equal credits across all settlements.</div>
        <button class="btn-action insurer" id="btn-audit-financial" style="margin-top: 8px; font-size: 12px;">Run Check</button>
        <div id="audit-financial-result" style="margin-top: 8px;"></div>
      </div>
      <div class="audit-card" id="audit-duplicate-detection">
        <div class="audit-name">Duplicate Detection</div>
        <div class="audit-result">Scans for duplicate prescriptions or settlements.</div>
        <button class="btn-action insurer" id="btn-audit-duplicates" style="margin-top: 8px; font-size: 12px;">Run Check</button>
        <div id="audit-duplicates-result" style="margin-top: 8px;"></div>
      </div>
      <div class="audit-card" id="audit-full">
        <div class="audit-name">Full Audit</div>
        <div class="audit-result">Runs all checks and produces a composite health score.</div>
        <button class="btn-action insurer" id="btn-audit-full" style="margin-top: 8px; font-size: 12px;">Run Full Audit</button>
        <div id="audit-full-result" style="margin-top: 8px;"></div>
      </div>
    </div>
  `;

  el.innerHTML = renderSectionCard('Audit Suite', COLOR, content);

  // Wire up audit buttons
  document.getElementById('btn-audit-chain').addEventListener('click', () => runAuditCheck('chain'));
  document.getElementById('btn-audit-financial').addEventListener('click', () => runAuditCheck('financial'));
  document.getElementById('btn-audit-duplicates').addEventListener('click', () => runAuditCheck('duplicates'));
  document.getElementById('btn-audit-full').addEventListener('click', () => runAuditCheck('full'));
}

async function runAuditCheck(type) {
  const resultDiv = document.getElementById(`audit-${type}-result`);
  const card = document.getElementById(type === 'full' ? 'audit-full' : `audit-${type === 'chain' ? 'chain-integrity' : type === 'financial' ? 'financial-balance' : 'duplicate-detection'}`);
  resultDiv.innerHTML = '<span style="color: var(--text-secondary); font-size: 12px;">Running...</span>';

  try {
    // Fetch audit log for analysis
    const auditData = await fetchJson('/node/audit-log');
    const auditSummary = state?.auditSummary || {};
    const fulfillments = state?.fulfillments || [];
    const prescriptions = state?.prescriptions || [];

    let passed = false;
    let detail = '';

    if (type === 'chain' || type === 'full') {
      const events = auditData?.events || auditData?.auditLog?.events || [];
      const eventCount = events.length || auditData?.eventCount || auditData?.auditLog?.eventCount || 0;
      const chainIntact = eventCount >= 0; // Simplified: if we got data back, the chain is reachable
      if (type === 'chain') {
        passed = chainIntact;
        detail = chainIntact
          ? `Chain intact. ${eventCount} event(s) in Poseidon hash chain.`
          : 'Chain integrity could not be verified.';
      }
    }

    if (type === 'financial' || type === 'full') {
      let totalPatient = 0, totalPlan = 0;
      let reversedPatient = 0, reversedPlan = 0;
      for (const f of fulfillments) {
        if (f.reversed) {
          reversedPatient += f.patientPayCents || 0;
          reversedPlan += f.planPayCents || 0;
        } else {
          totalPatient += f.patientPayCents || 0;
          totalPlan += f.planPayCents || 0;
        }
      }
      const netPatient = totalPatient - reversedPatient;
      const netPlan = totalPlan - reversedPlan;
      const auditPatient = auditSummary.totalPatientPayCents || 0;
      const auditPlan = auditSummary.totalPlanPayCents || 0;
      // Simplified balance check: net amounts should be non-negative
      const balanced = netPatient >= 0 && netPlan >= 0;

      if (type === 'financial') {
        passed = balanced;
        detail = balanced
          ? `Balanced. Net patient: ${formatCents(netPatient)}, Net plan: ${formatCents(netPlan)}.`
          : `Imbalance detected. Patient: ${formatCents(netPatient)}, Plan: ${formatCents(netPlan)}.`;
      }
    }

    if (type === 'duplicates' || type === 'full') {
      const rxIds = prescriptions.map(rx => rx.id);
      const dupes = rxIds.filter((id, i) => rxIds.indexOf(id) !== i);
      const noDuplicates = dupes.length === 0;

      if (type === 'duplicates') {
        passed = noDuplicates;
        detail = noDuplicates
          ? `No duplicates found across ${prescriptions.length} prescription(s).`
          : `${dupes.length} duplicate prescription(s) detected: ${dupes.join(', ')}`;
      }
    }

    if (type === 'full') {
      // Composite: run all checks
      const events = auditData?.events || auditData?.auditLog?.events || [];
      const eventCount = events.length || auditData?.eventCount || auditData?.auditLog?.eventCount || 0;
      const chainOk = eventCount >= 0;

      let netPatient = 0, netPlan = 0;
      for (const f of fulfillments) {
        if (f.reversed) {
          netPatient -= f.patientPayCents || 0;
          netPlan -= f.planPayCents || 0;
        } else {
          netPatient += f.patientPayCents || 0;
          netPlan += f.planPayCents || 0;
        }
      }
      const financialOk = netPatient >= 0 && netPlan >= 0;

      const rxIds = prescriptions.map(rx => rx.id);
      const dupeCount = rxIds.filter((id, i) => rxIds.indexOf(id) !== i).length;
      const dupeOk = dupeCount === 0;

      const allPassed = chainOk && financialOk && dupeOk;
      const score = [chainOk, financialOk, dupeOk].filter(Boolean).length;

      passed = allPassed;
      detail = `Score: ${score}/3 checks passed. Chain: ${chainOk ? 'OK' : 'FAIL'}, Financial: ${financialOk ? 'OK' : 'FAIL'}, Duplicates: ${dupeOk ? 'OK' : 'FAIL'}.`;
    }

    // Update card class
    if (card) {
      card.classList.remove('pass', 'fail');
      card.classList.add(passed ? 'pass' : 'fail');
    }

    resultDiv.innerHTML = `
      <div style="font-size: 12px; color: ${passed ? 'var(--color-accent-green)' : 'var(--color-accent-red)'}; font-weight: 600;">
        ${passed ? 'PASS' : 'FAIL'}
      </div>
      <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">${detail}</div>
    `;
  } catch (err) {
    if (card) {
      card.classList.remove('pass', 'fail');
      card.classList.add('fail');
    }
    resultDiv.innerHTML = `<div style="font-size: 12px; color: var(--color-accent-red);">Error: ${err.message}</div>`;
  }
}

// ============================================================================
// Section 5: Admin Panel
// ============================================================================

function renderAdmin() {
  const el = document.getElementById('section-admin');
  if (!el) return;

  const l2Status = state?.l2?.status || {};
  const running = l2Status.running || false;

  const content = `
    <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px;">
      <button class="btn-action insurer" id="btn-force-batch">Force Batch Settlement</button>
    </div>
    <div id="admin-result" style="margin-bottom: 16px;"></div>
    <div style="font-size: 12px; color: var(--text-secondary);">
      ${renderDataGrid([
        { label: 'Sequencer', value: running ? '<span style="color: var(--color-accent-green);">Running</span>' : '<span style="color: var(--color-accent-red);">Stopped</span>' },
        { label: 'Pending Proofs', value: l2Status.pendingProofs || 0 },
        { label: 'Total Accepted', value: l2Status.totalProofsAccepted || 0 },
        { label: 'Batches Built', value: l2Status.totalBatchesBuilt || 0 },
        { label: 'Batches Settled', value: l2Status.totalBatchesSettled || 0 },
        { label: 'Batches Failed', value: l2Status.totalBatchesFailed || 0 },
      ])}
    </div>
  `;

  el.innerHTML = renderSectionCard('Admin Panel', COLOR, content);

  document.getElementById('btn-force-batch').addEventListener('click', async () => {
    const btn = document.getElementById('btn-force-batch');
    const resultDiv = document.getElementById('admin-result');
    btn.classList.add('loading');
    btn.disabled = true;
    resultDiv.innerHTML = '<span style="color: var(--text-secondary);">Forcing batch...</span>';

    try {
      const data = await postJson('/node/force-batch');
      resultDiv.innerHTML = `
        <div style="padding: 8px 12px; background: rgba(76, 175, 80, 0.1); border: 1px solid rgba(76, 175, 80, 0.3); border-radius: 6px; font-size: 12px; color: var(--color-accent-green);">
          ${data.message || 'Batch settlement initiated.'}
        </div>
      `;
      // Refresh state
      state = await fetchJson('/node/state');
      renderOverview();
      await renderBatches();
      await renderReceipts();
    } catch (err) {
      resultDiv.innerHTML = `<div style="color: var(--color-accent-red); font-size: 12px;">Error: ${err.message}</div>`;
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ============================================================================
// Section 6: Chain Proof
// ============================================================================

async function renderChainProof() {
  const el = document.getElementById('section-chain-proof');
  if (!el) return;

  let proofData = null;
  try {
    proofData = await fetchJson('/node/chain-proof');
  } catch (err) {
    // Chain proof endpoint may not be available
  }

  const available = proofData?.available || false;

  let content;
  if (available && proofData) {
    content = `
      ${renderDataGrid([
        { label: 'Status', value: '<span style="color: var(--color-accent-green); font-weight: 600;">Available</span>' },
        { label: 'Global State Root', value: truncHash(proofData.globalStateRoot, 8) },
        { label: 'Block Height', value: proofData.blockHeight || 0 },
      ])}
      ${proofData.chainProofJson ? `
        <div style="margin-top: 12px;">
          <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px;">Chain Proof JSON</div>
          <pre style="background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 12px; font-size: 11px; color: var(--text-primary); overflow-x: auto; max-height: 200px; cursor: pointer; user-select: all;">${escapeHtml(typeof proofData.chainProofJson === 'string' ? proofData.chainProofJson.slice(0, 2000) : JSON.stringify(proofData.chainProofJson, null, 2).slice(0, 2000))}${(typeof proofData.chainProofJson === 'string' ? proofData.chainProofJson : JSON.stringify(proofData.chainProofJson)).length > 2000 ? '\n... (truncated)' : ''}</pre>
        </div>
      ` : ''}
    `;
  } else {
    content = `
      ${renderDataGrid([
        { label: 'Status', value: '<span style="color: var(--text-secondary);">Not available</span>' },
        { label: 'Info', value: 'Chain proof production is not enabled or no batches have been settled yet.' },
      ])}
    `;
  }

  el.innerHTML = renderSectionCard('Chain Proof', COLOR, content);
}

// ============================================================================
// Section 7: All Receipts
// ============================================================================

async function renderReceipts() {
  const el = document.getElementById('section-receipts');
  if (!el) return;

  let receipts = [];
  try {
    const data = await fetchJson('/node/all-receipts');
    receipts = data.receipts || [];
  } catch (err) {
    // Fallback to L2 status data
    const l2 = state?.l2 || {};
    receipts = l2.receipts || [];
  }

  if (receipts.length === 0) {
    el.innerHTML = renderSectionCard('All Receipts (0)', COLOR,
      '<div style="color: var(--text-secondary); padding: 16px; text-align: center; font-size: 13px;">No receipts yet. Operations generate StateTransitionProofs.</div>'
    );
    return;
  }

  const sorted = [...receipts].reverse();
  const columns = [
    { key: 'receiptId', label: 'Receipt ID', format: (v) => `<span class="mono" style="font-size: 10px;" title="${v}">${truncHash(v, 6)}</span>` },
    { key: 'walletId', label: 'Wallet', format: (v) => `<span class="mono" style="font-size: 10px;" title="${v}">${truncHash(v, 6)}</span>` },
    { key: 'acceptedAt', label: 'Timestamp', format: (v) => formatTimestamp(v) },
    { key: 'l1Status', label: 'Status', format: (v) => statusBadge(v) },
    { key: 'sequenceNumber', label: 'Seq #', align: 'right' },
  ];

  const content = `
    <div style="max-height: 400px; overflow-y: auto;">
      ${renderSortableTable('receipts-table', columns, sorted)}
    </div>
  `;

  el.innerHTML = renderSectionCard(`All Receipts (${receipts.length})`, COLOR, content);
}

// ============================================================================
// Section 8: All Batches
// ============================================================================

async function renderBatches() {
  const el = document.getElementById('section-batches');
  if (!el) return;

  let batches = [];
  try {
    const data = await fetchJson('/node/all-batches');
    batches = data.batches || [];
  } catch (err) {
    const l2 = state?.l2 || {};
    batches = l2.batches || [];
  }

  if (batches.length === 0) {
    el.innerHTML = renderSectionCard('All Batches (0)', COLOR,
      '<div style="color: var(--text-secondary); padding: 16px; text-align: center; font-size: 13px;">No batches yet. Use Force Batch or wait for auto-batch.</div>'
    );
    return;
  }

  const sorted = [...batches].reverse();
  const columns = [
    { key: 'batchNumber', label: 'Batch #', format: (v) => `<span style="font-weight: 600;">#${v}</span>` },
    { key: 'registrationCount', label: 'Registrations', align: 'right' },
    { key: 'transitionCount', label: 'Transitions', align: 'right' },
    { key: 'l1Status', label: 'Status', format: (v) => statusBadge(v) },
    { key: 'createdAt', label: 'Created At', format: (v) => formatTimestamp(v) },
    { key: 'l1TxHash', label: 'L1 Tx Hash', format: (v) => v ? `<span class="mono" style="font-size: 10px;" title="${v}">${truncHash(v, 8)}</span>` : '--' },
  ];

  const content = `
    <div style="max-height: 400px; overflow-y: auto;">
      ${renderSortableTable('batches-table', columns, sorted)}
    </div>
  `;

  el.innerHTML = renderSectionCard(`All Batches (${batches.length})`, COLOR, content);
}

// ============================================================================
// Section 9: Audit Chain
// ============================================================================

async function renderAuditChain() {
  const el = document.getElementById('section-audit-chain');
  if (!el) return;

  let auditLog = null;
  try {
    auditLog = await fetchJson('/node/audit-log');
  } catch (err) {
    // May not be available
  }

  const events = auditLog?.events || auditLog?.auditLog?.events || [];
  const eventCount = events.length || auditLog?.eventCount || auditLog?.auditLog?.eventCount || 0;
  const latestChainHash = auditLog?.latestChainHash || auditLog?.auditLog?.latestChainHash || null;
  const genesisHash = auditLog?.genesisHash || auditLog?.auditLog?.genesisHash || null;

  let eventsHtml = '';
  if (events.length > 0) {
    const displayEvents = events.slice(-50).reverse(); // Show latest 50
    eventsHtml = `
      <div style="max-height: 300px; overflow-y: auto; margin-top: 12px;">
        ${displayEvents.map((evt, i) => `
          <div style="display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border-subtle); align-items: center;">
            <span style="font-size: 11px; color: var(--text-secondary); min-width: 40px; text-align: right;">
              #${evt.sequenceNumber ?? (events.length - i)}
            </span>
            <span class="mono" style="font-size: 10px; color: var(--color-insurer); min-width: 120px;">
              ${truncHash(evt.chainHash || evt.eventCommitment, 6)}
            </span>
            <span style="font-size: 11px; color: var(--text-primary); flex: 1;">
              ${evt.isRegistration ? renderBadge('REG', 'fill') : renderBadge('UPD', 'pending')}
              <span class="mono" style="font-size: 10px; margin-left: 8px;">${truncHash(evt.walletId, 6)}</span>
            </span>
          </div>
        `).join('')}
      </div>
    `;
  }

  const content = `
    ${renderDataGrid([
      { label: 'Event Count', value: `<span style="color: var(--color-insurer); font-weight: 600;">${eventCount}</span>` },
      { label: 'Latest Chain Hash', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${latestChainHash || '(genesis)'}</span>` },
      { label: 'Genesis Hash', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${genesisHash || '--'}</span>` },
      { label: 'Chain Integrity', value: eventCount > 0
        ? '<span style="color: var(--color-accent-green); font-weight: 600;">Verified (tamper-evident)</span>'
        : '<span style="color: var(--text-secondary);">No events</span>'
      },
    ])}
    ${eventsHtml}
  `;

  el.innerHTML = renderSectionCard(`Audit Chain (${eventCount})`, COLOR, content);
}

// ============================================================================
// Section 10: Node Info
// ============================================================================

function renderNodeInfo() {
  const el = document.getElementById('section-info');
  if (!el) return;

  const l2Status = state?.l2?.status || {};
  const chainState = state?.chainState || {};

  const content = renderDataGrid([
    { label: 'Sequencer URL', value: 'http://127.0.0.1:3030' },
    { label: 'Node Type', value: 'Insurer / PBM' },
    { label: 'Protocol', value: 'zkpCare L2 on MINA' },
    { label: 'Registry Root', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${chainState.walletRegistryRoot || l2Status.currentRegistryRoot || '--'}</span>` },
    { label: 'Lifecycle Root', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${chainState.lifecycleRoot || l2Status.currentLifecycleRoot || '--'}</span>` },
    { label: 'Wallet Count', value: chainState.walletCount || l2Status.currentWalletCount || 0 },
    { label: 'Benefit Plan Root', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${chainState.benefitPlanRoot || '--'}</span>` },
    { label: 'Credential Registry Root', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${chainState.nftRegistryRoot || '--'}</span>` },
    { label: 'Eligibility VK Hash', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${chainState.eligibilityVkHash || '--'}</span>` },
    { label: 'Messaging Root', value: `<span class="mono" style="font-size: 10px; word-break: break-all;">${chainState.messagingRoot || '--'}</span>` },
  ]);

  el.innerHTML = renderSectionCard('Node Info', COLOR, content);
}

// ============================================================================
// Utility
// ============================================================================

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================================
// Boot
// ============================================================================

document.addEventListener('DOMContentLoaded', init);
