// node-common.js — Shared utilities for zkpCare visualizer dashboard pages
// ES module syntax (export/import)

export const API_BASE = 'http://127.0.0.1:3030';

// ============================================================================
// RPC + REST Helpers
// ============================================================================

// AbortController-based timeout wrapper
function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// JSON-RPC 2.0 call to /rpc endpoint
export async function rpcCall(method, params = {}, timeoutMs = 180000) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  } finally {
    clear();
  }
}

// GET helper for /node/* routes
export async function fetchJson(path, timeoutMs = 60000) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  } finally {
    clear();
  }
}

// POST helper for /node/* routes
export async function postJson(path, body = {}, timeoutMs = 180000) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  } finally {
    clear();
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

// Format cents as "$12.34"
export function formatCents(cents) {
  const n = typeof cents === 'bigint' ? Number(cents) : Number(cents || 0);
  return '$' + (n / 100).toFixed(2);
}

// Truncate a hash string: "12345678901234" → "1234...1234"
export function truncHash(hash, len = 4) {
  if (!hash) return '—';
  const s = String(hash);
  if (s.length <= len * 2 + 3) return s;
  return s.slice(0, len) + '...' + s.slice(-len);
}

// Format CCYYMMDD to "2026-01-15"
export function formatDate(ccyymmdd) {
  if (!ccyymmdd || ccyymmdd.length < 8) return ccyymmdd || '—';
  return `${ccyymmdd.slice(0, 4)}-${ccyymmdd.slice(4, 6)}-${ccyymmdd.slice(6, 8)}`;
}

// Format unix timestamp to locale string
export function formatTimestamp(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

// ============================================================================
// Rendering Helpers (all return HTML strings)
// ============================================================================

// Section card with colored header
export function renderSectionCard(title, colorClass, content, options = {}) {
  const { id, collapsed } = options;
  const idAttr = id ? ` id="${id}"` : '';
  const collapsedClass = collapsed ? ' collapsed' : '';
  return `
    <div class="section-card${collapsedClass}"${idAttr}>
      <div class="card-header ${colorClass} collapsible" onclick="this.parentElement.classList.toggle('collapsed')">
        <span>${title}</span>
        <span class="collapse-arrow">&#9660;</span>
      </div>
      <div class="card-body collapsible-body">
        ${content}
      </div>
    </div>
  `;
}

// 2-column data grid (array of {label, value} objects)
export function renderDataGrid(entries) {
  return `<div class="data-grid">${
    entries.map(e => `<div class="label">${e.label}</div><div class="value${e.mono !== false ? ' mono' : ''}">${e.value}</div>`).join('')
  }</div>`;
}

// Row of metric boxes (array of {label, value} objects)
export function renderMetricRow(metrics) {
  return `<div class="metric-row">${
    metrics.map(m => `
      <div class="metric-box">
        <div class="metric-label">${m.label}</div>
        <div class="metric-value" style="${m.color ? `color: ${m.color};` : ''}">${m.value}</div>
      </div>
    `).join('')
  }</div>`;
}

// Progress bar with label and value text
export function renderProgressBar(label, used, limit, color) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const met = used >= limit && limit > 0;
  return `
    <div class="progress-bar-container">
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span style="font-size: 12px; color: var(--text-secondary);">${label}</span>
        <span style="font-size: 12px; color: ${met ? 'var(--accent-green)' : 'var(--text-primary)'};">${formatCents(used)} / ${formatCents(limit)}${met ? ' (MET)' : ''}</span>
      </div>
      <div class="progress-bar">
        <div class="fill" style="width: ${pct}%; background: ${color};"></div>
      </div>
    </div>
  `;
}

// Badge/pill
export function renderBadge(text, type) {
  return `<span class="badge badge-${type}">${text}</span>`;
}

// Sortable table. columns = [{key, label, format?, align?}], rows = objects
export function renderSortableTable(tableId, columns, rows, defaultSortKey) {
  if (rows.length === 0) {
    return `<div style="color: var(--text-secondary); padding: 16px; text-align: center;">No data available</div>`;
  }
  const headerCells = columns.map(c =>
    `<th data-sort-key="${c.key}" style="${c.align === 'right' ? 'text-align: right;' : ''}">${c.label}</th>`
  ).join('');
  const bodyRows = rows.map(row => {
    const cells = columns.map(c => {
      const val = c.format ? c.format(row[c.key], row) : (row[c.key] ?? '—');
      return `<td style="${c.align === 'right' ? 'text-align: right;' : ''}">${val}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `
    <table class="sortable-table" id="${tableId}">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

// Entity selector dropdown
export function renderEntitySelector(entities, selectedId, label) {
  if (!entities || entities.length === 0) {
    return `<select class="entity-selector" disabled><option>No entities enrolled</option></select>`;
  }
  const options = entities.map(e => {
    const sel = e.walletId === selectedId ? ' selected' : '';
    const display = e.displayName || truncHash(e.walletId, 8);
    return `<option value="${e.walletId}"${sel}>${display}</option>`;
  }).join('');
  return `
    <label style="font-size: 12px; color: var(--text-secondary); margin-right: 8px;">${label || 'Select entity:'}</label>
    <select class="entity-selector" id="entity-select">${options}</select>
  `;
}

// Search box (input + button)
export function renderSearchBox(inputId, btnId, placeholder, btnText) {
  return `
    <div class="search-box">
      <input type="text" id="${inputId}" class="mono" placeholder="${placeholder}" />
      <button id="${btnId}" class="btn-action">${btnText || 'Search'}</button>
    </div>
  `;
}

// Filter row with date range inputs
export function renderDateFilter(startId, endId) {
  return `
    <div class="filter-row">
      <label style="font-size: 12px; color: var(--text-secondary);">From:</label>
      <input type="date" id="${startId}" class="date-input" />
      <label style="font-size: 12px; color: var(--text-secondary); margin-left: 12px;">To:</label>
      <input type="date" id="${endId}" class="date-input" />
    </div>
  `;
}

// ============================================================================
// Auto-Refresh
// ============================================================================

// Poll a function every intervalMs, calling renderFn with results
export function startAutoRefresh(fetchFn, renderFn, intervalMs = 5000) {
  let timer = null;
  const tick = async () => {
    try {
      const data = await fetchFn();
      renderFn(data);
    } catch (err) {
      console.warn('Auto-refresh error:', err.message);
    }
  };
  tick(); // initial fetch
  timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer); // returns stop function
}

// ============================================================================
// Lifecycle + Status Helpers
// ============================================================================

export function lifecycleText(state) {
  const states = { 0: 'EMPTY', 1: 'REGISTERED', 2: 'ELIGIBLE', 3: 'ACTIVE', 4: 'REVOKED' };
  return states[state] || `UNKNOWN(${state})`;
}

export function lifecyclePillClass(state) {
  const classes = { 1: 'registered', 2: 'eligible', 3: 'active', 4: 'revoked' };
  return classes[state] || 'registered';
}

export function operationBadge(opType) {
  if (opType === 'reversal') return renderBadge('Reversal', 'reversal');
  return renderBadge('Fill', 'fill');
}

export function statusBadge(status) {
  if (status === 'settled') return renderBadge('Settled', 'settled');
  if (status === 'failed') return renderBadge('Failed', 'reversal');
  return renderBadge('Pending', 'pending');
}

// ============================================================================
// Claim View Helpers
// ============================================================================

// Compute activity summary from EntityClaimView[]
export function computeSummary(views) {
  let totalClaims = 0, totalReversals = 0;
  let totalPatientPay = 0n, totalPlanPay = 0n;
  const ndcSet = new Set();
  let earliest = null, latest = null;
  for (const v of views) {
    if (v.operationType === 'reversal') {
      totalReversals++;
      totalPatientPay -= BigInt(v.patientPayCents || 0);
      totalPlanPay -= BigInt(v.planPayCents || 0);
    } else {
      totalClaims++;
      totalPatientPay += BigInt(v.patientPayCents || 0);
      totalPlanPay += BigInt(v.planPayCents || 0);
    }
    ndcSet.add(v.ndcHash);
    if (!earliest || v.dateOfService < earliest) earliest = v.dateOfService;
    if (!latest || v.dateOfService > latest) latest = v.dateOfService;
  }
  return {
    totalClaims, totalReversals, activeClaims: totalClaims - totalReversals,
    totalPatientPay, totalPlanPay, uniqueMedications: ndcSet.size,
    dateRange: earliest && latest ? { earliest, latest } : null,
  };
}

// Compute medication breakdown from EntityClaimView[]
export function computeMedBreakdown(views) {
  const map = new Map();
  for (const v of views) {
    const e = map.get(v.ndcHash);
    const sign = v.operationType === 'reversal' ? -1n : 1n;
    if (e) {
      e.claimCount++;
      e.totalPatientPay += BigInt(v.patientPayCents || 0) * sign;
      e.totalPlanPay += BigInt(v.planPayCents || 0) * sign;
    } else {
      map.set(v.ndcHash, {
        ndcHash: v.ndcHash, brandName: v.brandName, tierLevel: v.tierLevel,
        therapeuticClass: v.therapeuticClass,
        claimCount: 1,
        totalPatientPay: BigInt(v.patientPayCents || 0) * sign,
        totalPlanPay: BigInt(v.planPayCents || 0) * sign,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.claimCount - a.claimCount);
}

// Compute unique entities from views (by a key field)
export function computeBreakdown(views, keyField, extraFields = []) {
  const map = new Map();
  for (const v of views) {
    const key = v[keyField];
    const e = map.get(key);
    const sign = v.operationType === 'reversal' ? -1n : 1n;
    if (e) {
      e.claimCount++;
      e.ndcSet.add(v.ndcHash);
      e.totalPatientPay += BigInt(v.patientPayCents || 0) * sign;
      e.totalPlanPay += BigInt(v.planPayCents || 0) * sign;
    } else {
      const entry = {
        [keyField]: key,
        claimCount: 1,
        ndcSet: new Set([v.ndcHash]),
        totalPatientPay: BigInt(v.patientPayCents || 0) * sign,
        totalPlanPay: BigInt(v.planPayCents || 0) * sign,
      };
      for (const f of extraFields) entry[f] = v[f];
      map.set(key, entry);
    }
  }
  return [...map.values()]
    .map(e => ({ ...e, uniqueMeds: e.ndcSet.size }))
    .sort((a, b) => b.claimCount - a.claimCount);
}

// Get active medications (non-reversed) from views
export function getActiveMedications(views) {
  const ndcCounts = new Map();
  for (const v of views) {
    const e = ndcCounts.get(v.ndcHash) || { fills: 0, reversals: 0, latestFill: null };
    if (v.operationType === 'fulfillment') {
      e.fills++;
      if (!e.latestFill || v.dateOfService > e.latestFill.dateOfService) e.latestFill = v;
    } else {
      e.reversals++;
    }
    ndcCounts.set(v.ndcHash, e);
  }
  const active = [];
  for (const [, counts] of ndcCounts) {
    if (counts.fills > counts.reversals && counts.latestFill) active.push(counts.latestFill);
  }
  return active;
}
