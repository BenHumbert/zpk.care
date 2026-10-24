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
 * Reports Tab — 8 production-grade reports powered by L10 ReportingService.
 *
 * All data comes from state.reports (built server-side via ReportingService).
 * Wallet IDs resolved via state.walletDirectory. NDC hashes resolved via
 * state.reports.ndcDirectory (since frontend can't compute Poseidon hashes).
 *
 * Names, wallet IDs and drug names are escaped with escapeHtml (message-thread.js) before they are placed in the page:
 * a name is whatever its node registered, and this page holds the operator token (A-61).
 */

import { formatCents } from '../interactive-app.js';
import { escapeHtml } from './message-thread.js';

export class ReportsTab {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('tab-reports');
  }

  render(state) {
    if (!state) {
      this.container.innerHTML = '<div class="waiting-message">Loading...</div>';
      return;
    }

    const reports = state.reports;
    if (!reports) {
      this.container.innerHTML = `
        <div class="section-card">
          <div class="card-header reports">Reports</div>
          <div class="card-body">
            <div style="text-align:center; padding:40px; color:var(--text-muted);">
              No claims data yet. Fill a prescription to generate reports.
            </div>
          </div>
        </div>
      `;
      return;
    }

    const dir = state.walletDirectory || {};
    const ndcDir = reports.ndcDirectory || {};

    this.container.innerHTML = `
      ${this.renderFinancialSummary(reports.financialSummary)}
      ${this.renderClaimsRegister(reports.claimsRegister, dir, ndcDir)}
      ${this.renderPharmacyActivity(reports.pharmacyActivity, dir)}
      ${this.renderPrescriberActivity(reports.prescriberActivity, dir)}
      ${this.renderMemberActivity(reports.memberActivity)}
      ${this.renderMedicationUtilization(reports.medicationUtilization, ndcDir)}
      ${this.renderPriorAuthReport(reports.priorAuthReport, dir, ndcDir)}
      ${this.renderReversalReport(reports.reversalReport, dir, ndcDir)}
    `;
  }

  // ─── 1. Financial Summary ──────────────────────────────

  renderFinancialSummary(report) {
    if (!report) return '';
    const cb = report.costBreakdown;
    const total = cb.totalPatientPayCents + cb.totalPlanPayCents;
    const patientPct = total > 0 ? Math.round((cb.totalPatientPayCents / total) * 100) : 0;
    const planPct = 100 - patientPct;

    return `
      <div class="section-card">
        <div class="card-header reports">Financial Summary</div>
        <div class="card-body">
          <div class="report-metric-row">
            <div class="report-metric-box">
              <div class="report-metric-value">${report.totalClaimCount}</div>
              <div class="report-metric-label">Claims</div>
            </div>
            <div class="report-metric-box">
              <div class="report-metric-value">${report.totalReversalCount}</div>
              <div class="report-metric-label">Reversals</div>
            </div>
            <div class="report-metric-box">
              <div class="report-metric-value">${formatCents(cb.totalGrossCostCents)}</div>
              <div class="report-metric-label">Gross Cost</div>
            </div>
            <div class="report-metric-box">
              <div class="report-metric-value">${formatCents(cb.netCostCents)}</div>
              <div class="report-metric-label">Net Cost</div>
            </div>
            <div class="report-metric-box">
              <div class="report-metric-value">${formatCents(Math.round(report.averageClaimCost))}</div>
              <div class="report-metric-label">Avg Claim</div>
            </div>
          </div>

          <div class="report-metric-row">
            <div class="report-metric-box">
              <div class="report-metric-value">${formatCents(cb.totalIngredientCostCents)}</div>
              <div class="report-metric-label">Ingredient Cost</div>
            </div>
            <div class="report-metric-box">
              <div class="report-metric-value">${formatCents(cb.totalDispensingFeeCents)}</div>
              <div class="report-metric-label">Dispensing Fees</div>
            </div>
            <div class="report-metric-box">
              <div class="report-metric-value">${formatCents(cb.totalPatientPayCents)}</div>
              <div class="report-metric-label">Patient Pay</div>
            </div>
            <div class="report-metric-box">
              <div class="report-metric-value">${formatCents(cb.totalPlanPayCents)}</div>
              <div class="report-metric-label">Plan Pay</div>
            </div>
          </div>

          ${total > 0 ? `
            <div style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;">Patient vs Plan Split</div>
            <div class="report-split-bar">
              <div class="split-patient" style="width:${patientPct}%">${patientPct > 10 ? `Patient ${patientPct}%` : ''}</div>
              <div class="split-plan" style="width:${planPct}%">${planPct > 10 ? `Plan ${planPct}%` : ''}</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ─── 2. Claims Register ────────────────────────────────

  renderClaimsRegister(report, dir, ndcDir) {
    if (!report || !report.claims.length) return '';

    const rows = report.claims.map((c, i) => {
      const isRev = c.operationType === 'reversal';
      const med = ndcDir[c.ndcHash];
      const drugName = med ? escapeHtml(med.brandName) : this.truncHash(c.ndcHash);
      const pharmacy = this.resolveName(c.pharmacyWalletId, dir);
      const prescriber = this.resolveName(c.prescriberWalletId, dir);
      const member = this.truncHash(c.memberWalletId);
      const qty = (parseInt(c.quantityDispensed) / 1000);

      return `
        <tr${isRev ? ' style="opacity:0.7"' : ''}>
          <td>${i + 1}</td>
          <td><span class="report-op-badge ${escapeHtml(c.operationType)}">${escapeHtml(c.operationType)}</span></td>
          <td title="${escapeHtml(c.memberWalletId)}">${member}</td>
          <td>${pharmacy}</td>
          <td>${prescriber}</td>
          <td>${drugName}</td>
          <td>${qty}</td>
          <td>${formatCents(c.patientPayCents)}</td>
          <td>${formatCents(c.planPayCents)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header reports">Claims Register (${report.totalClaimCount} claims, ${report.totalReversalCount} reversals)</div>
        <div class="card-body">
          <table class="report-table">
            <thead>
              <tr>
                <th>#</th><th>Type</th><th>Member</th><th>Pharmacy</th>
                <th>Prescriber</th><th>Drug</th><th>Qty</th>
                <th>Patient Pay</th><th>Plan Pay</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── 3. Pharmacy Activity ──────────────────────────────

  renderPharmacyActivity(report, dir) {
    if (!report || !report.pharmacies.length) return '';

    const rows = report.pharmacies.map(p => {
      const name = this.resolveName(p.pharmacyWalletId, dir);
      const cb = p.costBreakdown;
      return `
        <tr>
          <td>${name}</td>
          <td>${p.claimCount}</td>
          <td>${p.reversalCount}</td>
          <td>${p.uniqueMedications}</td>
          <td>${p.uniqueMembers}</td>
          <td>${formatCents(cb.totalPatientPayCents)}</td>
          <td>${formatCents(cb.totalPlanPayCents)}</td>
          <td>${formatCents(cb.totalGrossCostCents)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header reports">Pharmacy Activity (${report.pharmacies.length} pharmacies)</div>
        <div class="card-body">
          <table class="report-table">
            <thead>
              <tr>
                <th>Pharmacy</th><th>Claims</th><th>Reversals</th>
                <th>Unique Meds</th><th>Unique Members</th>
                <th>Patient Pay</th><th>Plan Pay</th><th>Gross Cost</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── 4. Prescriber Activity ────────────────────────────

  renderPrescriberActivity(report, dir) {
    if (!report || !report.prescribers.length) return '';

    const rows = report.prescribers.map(p => {
      const name = this.resolveName(p.prescriberWalletId, dir);
      const cb = p.costBreakdown;
      return `
        <tr>
          <td>${name}</td>
          <td>${p.prescriptionCount}</td>
          <td>${p.claimCount}</td>
          <td>${p.uniqueMedications}</td>
          <td>${p.uniqueMembers}</td>
          <td>${formatCents(cb.totalPatientPayCents)}</td>
          <td>${formatCents(cb.totalPlanPayCents)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header reports">Prescriber Activity (${report.prescribers.length} prescribers)</div>
        <div class="card-body">
          <table class="report-table">
            <thead>
              <tr>
                <th>Prescriber</th><th>Rx Count</th><th>Claims</th>
                <th>Unique Meds</th><th>Unique Members</th>
                <th>Patient Pay</th><th>Plan Pay</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── 5. Member Activity (opaque) ──────────────────────

  renderMemberActivity(report) {
    if (!report || !report.members.length) return '';

    const rows = report.members.map(m => {
      const cb = m.costBreakdown;
      const medCount = m.currentMedications ? m.currentMedications.length : 0;
      return `
        <tr>
          <td title="${escapeHtml(m.memberWalletId)}" class="mono" style="font-size:10px;">${this.truncHash(m.memberWalletId)}</td>
          <td>${m.claimCount}</td>
          <td>${m.reversalCount}</td>
          <td>${medCount}</td>
          <td>${formatCents(cb.totalPatientPayCents)}</td>
          <td>${formatCents(cb.totalPlanPayCents)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header reports">Member Activity (${report.members.length} members) &mdash; opaque wallet IDs only</div>
        <div class="card-body">
          <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px; padding:6px 10px; background:rgba(171,71,188,0.06); border-radius:4px;">
            Insurer sees only opaque wallet hashes. No member names or PHI visible.
          </div>
          <table class="report-table">
            <thead>
              <tr>
                <th>Wallet ID</th><th>Claims</th><th>Reversals</th>
                <th>Current Meds</th><th>Patient Pay</th><th>Plan Pay</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── 6. Medication Utilization ─────────────────────────

  renderMedicationUtilization(report, ndcDir) {
    if (!report || !report.medications.length) return '';

    const rows = report.medications.map(m => {
      const med = ndcDir[m.ndcHash];
      const drugName = med ? escapeHtml(med.brandName) : this.truncHash(m.ndcHash);
      const ndc = med ? escapeHtml(med.ndc) : '-';
      const tier = med ? `<span class="tier-badge tier-${med.tier}">Tier ${med.tier}</span>` : '-';
      const qty = (parseInt(m.totalQuantity) / 1000);

      return `
        <tr>
          <td>${drugName}</td>
          <td>${ndc}</td>
          <td>${tier}</td>
          <td>${m.totalClaimCount}</td>
          <td>${m.totalReversalCount}</td>
          <td>${qty}</td>
          <td>${m.uniquePharmacies}</td>
          <td>${m.uniquePrescribers}</td>
          <td>${m.uniqueMembers}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header reports">Medication Utilization (${report.medications.length} medications)</div>
        <div class="card-body">
          <table class="report-table">
            <thead>
              <tr>
                <th>Drug</th><th>NDC</th><th>Tier</th><th>Claims</th>
                <th>Reversals</th><th>Total Qty</th>
                <th>Pharmacies</th><th>Prescribers</th><th>Members</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── 7. Prior Auth Report ──────────────────────────────

  renderPriorAuthReport(report, dir, ndcDir) {
    if (!report || !report.priorAuths.length) return '';

    const rows = report.priorAuths.map(pa => {
      const med = ndcDir[pa.ndcHash];
      const drugName = med ? escapeHtml(med.brandName) : this.truncHash(pa.ndcHash);
      const prescriber = this.resolveName(pa.prescriberWalletId, dir);
      const member = this.truncHash(pa.memberWalletId);
      const approvedQty = parseInt(pa.approvedQuantity) / 1000;
      const utilizedQty = parseInt(pa.utilizedQuantity) / 1000;
      const pct = Math.round(pa.utilizationRate * 100);
      const barWidth = Math.min(pct, 100);

      return `
        <tr>
          <td>${drugName}</td>
          <td title="${escapeHtml(pa.memberWalletId)}">${member}</td>
          <td>${prescriber}</td>
          <td>${approvedQty}</td>
          <td>${utilizedQty}</td>
          <td>
            <span class="utilization-bar"><span class="utilization-fill" style="width:${barWidth}%"></span></span>
            ${pct}%
          </td>
          <td>${pa.hasClaimActivity ? 'Yes' : 'No'}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header reports">Prior Authorization Report (${report.priorAuths.length} PAs)</div>
        <div class="card-body">
          <table class="report-table">
            <thead>
              <tr>
                <th>Drug</th><th>Member</th><th>Prescriber</th>
                <th>Approved Qty</th><th>Utilized Qty</th>
                <th>Utilization</th><th>Active Claims</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── 8. Reversal Report ────────────────────────────────

  renderReversalReport(report, dir, ndcDir) {
    if (!report || !report.reversals.length) return '';

    const rows = report.reversals.map(r => {
      const med = ndcDir[r.ndcHash];
      const drugName = med ? escapeHtml(med.brandName) : this.truncHash(r.ndcHash);
      const pharmacy = this.resolveName(r.pharmacyWalletId, dir);
      const member = this.truncHash(r.memberWalletId);
      const qty = (parseInt(r.quantityDispensed) / 1000);

      return `
        <tr>
          <td title="${escapeHtml(r.memberWalletId)}">${member}</td>
          <td>${pharmacy}</td>
          <td>${drugName}</td>
          <td>${qty}</td>
          <td>${formatCents(r.patientPayCents)}</td>
          <td>${formatCents(r.planPayCents)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header reports">Reversal Report (${report.reversals.length} reversals)</div>
        <div class="card-body">
          <table class="report-table">
            <thead>
              <tr>
                <th>Member</th><th>Pharmacy</th><th>Drug</th>
                <th>Qty</th><th>Patient Refund</th><th>Plan Refund</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr class="totals-row">
                <td colspan="4">Totals</td>
                <td>${formatCents(report.totalPatientRefundCents)}</td>
                <td>${formatCents(report.totalPlanRefundCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── Helpers ───────────────────────────────────────────

  /** The registered name for a wallet, or its shortened ID, escaped: the name is whatever its node registered (A-61). */
  resolveName(walletId, dir) {
    const entry = dir[walletId];
    return entry ? escapeHtml(entry.displayName) : this.truncHash(walletId);
  }

  /** A hash or wallet ID shortened for a cell, escaped: every caller places it in the page as HTML. */
  truncHash(hash) {
    if (!hash) return '-';
    const s = hash.toString();
    return escapeHtml(s.length <= 12 ? s : s.slice(0, 6) + '...' + s.slice(-4));
  }
}
