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
 * Member Tab — Enrollment + PCP Assignment + Member Dashboard.
 *
 * Two modes:
 *   A) No enrollment yet → enrollment flow (token, plan, identity, key, ceremony)
 *   B) After enrollment → member dashboard (accumulators, PCP, prescriptions, family)
 */

import {
  API_BASE, formatCents,
  updateChainState, renderCredentialCard, renderForestCard, renderZkDataSection,
} from '../interactive-app.js';
import {
  renderSectionCard, renderMetricRow, renderSortableTable,
  truncHash,
} from '../node-common.js';

const PCP_ELIGIBLE_SPECIALTIES = [
  'Internal Medicine',
  'Family Medicine',
  'Nurse Practitioner - Family',
];

export class MemberPhase {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('tab-member');
    this.selectedMemberIndex = null;
    this.enrollmentResult = null;
    this.pcpSelectedPrescriber = null;
    this.pcpResult = null;
  }

  render(state) {
    const enrolled = state.enrolledMembers || [];

    if (enrolled.length > 0) {
      this.renderDashboard(state, enrolled);
    } else {
      this.renderEnrollmentFlow(state);
    }
  }

  // ─── Mode A: Enrollment Flow ──────────────────────────

  renderEnrollmentFlow(state) {
    const members = state.demoData.members;
    const plan = state.demoData.plan;
    const token = state.demoData.token;

    this.container.innerHTML = `
      <!-- Section 1: From Your Employer -->
      <div class="section-card">
        <div class="card-header employer">From Your Employer</div>
        <div class="card-body">
          <div class="data-grid">
            <div class="label">Group ID</div><div class="value">${token.groupId}</div>
            <div class="label">Plan ID</div><div class="value">${token.planId}</div>
            <div class="label">Token ID</div><div class="value">TOKEN-001</div>
            <div class="label">Valid Until</div><div class="value">${token.validUntil}</div>
          </div>
          <p style="margin-top: 12px; font-size: 12px; color: var(--text-muted);">
            Your employer has provided this enrollment token. It is one-time use and contains no personal data.
          </p>
        </div>
      </div>

      <!-- Section 2: Your Benefit Plan -->
      <div class="section-card">
        <div class="card-header insurer">Your Benefit Plan \u2014 ${plan.planId}</div>
        <div class="card-body">
          <div class="data-grid">
            <div class="label">Copay</div><div class="value">${formatCents(plan.copayAmountCents)}</div>
            <div class="label">Deductible</div><div class="value">${formatCents(plan.deductibleAmountCents)} individual / ${formatCents(plan.familyDeductibleAmountCents || 0)} family</div>
            <div class="label">Out-of-Pocket Max</div><div class="value">${formatCents(plan.oopMaxCents)} individual / ${formatCents(plan.familyOopMaxCents || 0)} family</div>
            <div class="label">Annual Max</div><div class="value">${plan.annualBenefitMaxCents === 0 ? 'Unlimited' : formatCents(plan.annualBenefitMaxCents)}</div>
            <div class="label">Formulary</div><div class="value">${plan.formularyCount} medications across 4 tiers</div>
          </div>
        </div>
      </div>

      <!-- Section 3: Your Identity -->
      <div class="section-card">
        <div class="card-header member">Your Identity</div>
        <div class="card-body">
          <div class="form-group">
            <label>Select Member</label>
            <select id="member-select">
              <option value="">\u2014 Choose a member \u2014</option>
              ${members.map((m, i) => `
                <option value="${i}">${m.firstName} ${m.lastName} (${m.cardholderId}) \u2014 ${m.relationship}</option>
              `).join('')}
            </select>
          </div>
          <div id="member-details" class="hidden">
            <div class="data-grid" id="member-details-grid"></div>
          </div>
        </div>
      </div>

      <!-- Section 4: Enrollment Key -->
      <div id="section-enrollment-key" class="section-card hidden">
        <div class="card-header member">Enrollment Key</div>
        <div class="card-body">
          <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">
            This is your secret enrollment key. It is generated on YOUR device and <strong>NEVER</strong> transmitted to the insurer.
            It prevents wallet impersonation even if PHI is breached.
          </p>
          <div class="data-grid">
            <div class="label">Enrollment Key</div>
            <div class="value mono" id="enrollment-key-display" style="color: var(--accent-yellow); font-size: 11px; word-break: break-all;">\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022</div>
          </div>
          <p style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">
            256-bit cryptographically random secret (base64url). Generated via crypto.randomBytes(32) on device.
          </p>
        </div>
      </div>

      <!-- Section 5: Enrollment -->
      <div id="section-enroll" class="section-card hidden">
        <div class="card-header member">Enrollment Ceremony</div>
        <div class="card-body">
          <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;">
            <strong>Three-Party Enrollment:</strong> Employer (token) \u2192 Member (wallet ID on device) \u2192 Insurer (register + issue credential).<br>
            No single party sees everything. The enrollment key NEVER leaves your device.
          </p>
          <button id="btn-enroll" class="btn-action member" disabled>
            <span class="spinner"></span>
            <span class="btn-text">Begin Enrollment</span>
          </button>
          <div id="enroll-result" class="hidden"></div>
        </div>
      </div>
    `;

    this.bindEnrollmentEvents(members);
  }

  bindEnrollmentEvents(members) {
    const select = document.getElementById('member-select');
    const details = document.getElementById('member-details');
    const detailsGrid = document.getElementById('member-details-grid');
    const keySection = document.getElementById('section-enrollment-key');
    const enrollSection = document.getElementById('section-enroll');
    const keyDisplay = document.getElementById('enrollment-key-display');
    const btnEnroll = document.getElementById('btn-enroll');

    select.addEventListener('change', () => {
      const idx = parseInt(select.value, 10);
      if (isNaN(idx)) {
        details.classList.add('hidden');
        keySection.classList.add('hidden');
        enrollSection.classList.add('hidden');
        this.selectedMemberIndex = null;
        return;
      }

      this.selectedMemberIndex = idx;
      const m = members[idx];

      detailsGrid.innerHTML = `
        <div class="label">First Name</div><div class="value">${m.firstName}</div>
        <div class="label">Last Name</div><div class="value">${m.lastName}</div>
        <div class="label">Cardholder ID</div><div class="value highlight">${m.cardholderId}</div>
        <div class="label">Date of Birth</div><div class="value">${formatDate(m.dateOfBirth)}</div>
        <div class="label">Gender</div><div class="value">${m.genderCode === 1 ? 'Male' : m.genderCode === 2 ? 'Female' : 'Not Specified'}</div>
        <div class="label">Relationship</div><div class="value"><span class="family-badge ${m.relationship.toLowerCase()}">${m.relationship}</span></div>
        <div class="label">Employee ID</div><div class="value">${m.employeeId}</div>
        <div class="label">Family ID</div><div class="value">${m.familyId}</div>
        <div class="label">Address</div><div class="value">${m.address}, ${m.city}, ${m.state} ${m.zip}</div>
      `;

      details.classList.remove('hidden');
      keySection.classList.remove('hidden');
      enrollSection.classList.remove('hidden');
      keyDisplay.textContent = '(device-only — never transmitted)';

      if (this.app.isCompiled()) {
        btnEnroll.disabled = false;
        btnEnroll.innerHTML = '<span class="spinner"></span> <span class="btn-text">Begin Enrollment</span>';
      } else {
        btnEnroll.disabled = true;
        btnEnroll.dataset.waitingCompile = 'true';
        btnEnroll.innerHTML = '<span class="spinner"></span> <span class="btn-text">Compiling ZkPrograms\u2026</span>';
      }
    });

    btnEnroll.addEventListener('click', () => this.doEnroll(btnEnroll));
  }

  async doEnroll(btn) {
    if (this.selectedMemberIndex === null) return;

    if (!this.app.isCompiled()) {
      this.app.setStatus('compiling', 'Still compiling ZkPrograms\u2026');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Enrolling\u2026';
    this.app.setStatus('working', 'Generating proof\u2026');

    try {
      // Fire-and-forget: kick off enrollment on the server
      const kickoff = await fetch(`${API_BASE}/interactive/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIndex: this.selectedMemberIndex }),
      });

      if (!kickoff.ok) {
        const err = await kickoff.json();
        throw new Error(err.error || 'Enrollment failed to start');
      }

      const kickoffData = await kickoff.json();

      // If the server already had a completed result (re-submit), handle immediately
      if (kickoffData.status === 'complete') {
        this._handleEnrollComplete(btn, kickoffData.result);
        return;
      }
      if (kickoffData.status === 'error') {
        throw new Error(kickoffData.error || 'Enrollment failed');
      }

      // Poll every 15 seconds for enrollment status
      this._pollEnrollStatus(btn, this.selectedMemberIndex);

    } catch (err) {
      const resultDiv = document.getElementById('enroll-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
      btn.classList.remove('loading');
      btn.querySelector('.btn-text').textContent = 'Begin Enrollment';
      btn.disabled = false;
    }
  }

  _pollEnrollStatus(btn, memberIndex) {
    const resultDiv = document.getElementById('enroll-result');
    let pollCount = 0;

    const poll = async () => {
      pollCount++;
      try {
        const res = await fetch(`${API_BASE}/interactive/enroll-status?memberIndex=${memberIndex}`);
        const data = await res.json();

        if (data.status === 'complete') {
          this._handleEnrollComplete(btn, data.result);
          return; // stop polling
        }

        if (data.status === 'error') {
          throw new Error(data.error || 'Enrollment failed');
        }

        // Still pending — update UI with elapsed time and poll again
        const elapsed = pollCount * 15;
        btn.querySelector('.btn-text').textContent = `Enrolling\u2026 ${elapsed}s`;
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-blue); padding: 12px;">Generating ZK proofs\u2026 (${elapsed}s elapsed, checking every 15s)</div>`;

        setTimeout(poll, 15_000);
      } catch (err) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
        this.app.setStatus('ready', 'Error');
        btn.classList.remove('loading');
        btn.querySelector('.btn-text').textContent = 'Begin Enrollment';
        btn.disabled = false;
      }
    };

    // First poll after 15 seconds
    setTimeout(poll, 15_000);
  }

  _handleEnrollComplete(btn, result) {
    this.enrollmentResult = result;
    this.app.enrollmentResult = result;

    // Show result inline
    const resultDiv = document.getElementById('enroll-result');
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = `
      <div class="result-card">
        <div class="result-title">Enrollment Complete</div>
        <div class="data-grid">
          <div class="label">Wallet ID</div><div class="value highlight mono">${result.walletIdDisplay || result.walletId}</div>
          <div class="label">Plan</div><div class="value">${result.planId}</div>
          <div class="label">Group</div><div class="value">${result.groupId}</div>
          <div class="label">Lifecycle</div><div class="value" style="color: var(--accent-green);">${result.lifecycle}</div>
          <div class="label">Credential Forest Root</div><div class="value mono">${result.nftForestRoot}</div>
          <div class="label">Proof Time</div><div class="value">${(result.proofTimeMs / 1000).toFixed(2)}s</div>
          <div class="label">Enrollment Time</div><div class="value">${(result.enrollTimeMs / 1000).toFixed(2)}s</div>
        </div>

        <!-- ZK Detail Sections -->
        ${renderCredentialCard('Eligibility Credential (Issued)', result.nft, 'insurer')}
        ${renderForestCard('Merkle Forest (6 Domain Trees)', result.forest, 'member')}
        ${renderZkDataSection('Wallet State', result.walletState, 'member', '3 fields', result.walletState ? result.walletState.walletId : '')}
        ${renderZkDataSection('Enrollment Token', result.token, 'employer')}
        ${renderZkDataSection('Lifecycle Leaf', { lifecycleLeafCommitment: result.lifecycleLeaf, formula: 'Poseidon.hash([walletId, LIFECYCLE_ELIGIBLE])' }, 'member')}
        ${result.l2Receipts ? this.renderL2Receipts(result.l2Receipts) : ''}
      </div>
    `;

    // Update button to "Enrolled"
    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Enrolled';
    btn.disabled = true;
    btn.style.opacity = '0.7';

    if (result.chainState) {
      updateChainState(result.chainState);
    }

    this.app.setStatus('ready', 'Ready');

    // Re-render as dashboard after a brief delay so the user sees the success
    setTimeout(() => {
      this.app.fetchState().then(() => {
        this.render(this.app.state);
      });
    }, 1500);
  }

  // ─── Mode B: Member Dashboard ─────────────────────────

  renderDashboard(state, enrolled) {
    const plan = state.demoData.plan;
    const prescriptions = state.prescriptions || [];

    // Show most recently enrolled member (or first one)
    const member = enrolled[enrolled.length - 1];
    const memberRxs = prescriptions.filter(rx => rx.memberWalletId === member.walletId);

    this.container.innerHTML = `
      <!-- Member Summary -->
      <div class="section-card"${member.lifecycle === 'REVOKED' ? ' style="border-color: rgba(239, 83, 80, 0.3);"' : ''}>
        <div class="card-header member">
          Member Dashboard \u2014 ${member.displayName}
          ${member.lifecycle === 'REVOKED' ? '<span class="rx-status-badge rx-status-cancelled" style="margin-left: 8px; font-size: 11px;">TERMINATED</span>' : ''}
        </div>
        <div class="card-body">
          ${member.lifecycle === 'REVOKED' ? `
          <div style="padding: 10px 14px; margin-bottom: 12px; background: rgba(239, 83, 80, 0.08); border: 1px solid rgba(239, 83, 80, 0.25); border-radius: 6px;">
            <div style="font-size: 13px; color: var(--accent-red); font-weight: 600;">Coverage Terminated</div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
              This member's enrollment was terminated${member.terminationDate ? ` on ${member.terminationDate}` : ''}. Credential revoked, lifecycle set to REVOKED.
              Active prescriptions have been auto-cancelled.
            </div>
          </div>
          ` : ''}
          <div class="data-grid">
            <div class="label">Wallet ID</div><div class="value mono" style="font-size: 11px;">${member.walletIdDisplay || member.walletId}</div>
            <div class="label">Plan</div><div class="value">${member.planId}</div>
            <div class="label">Group</div><div class="value">${member.groupId}</div>
            <div class="label">Family ID</div><div class="value">${member.familyId || '\u2014'}</div>
            <div class="label">Relationship</div><div class="value"><span class="family-badge ${(member.relationship || 'SELF').toLowerCase()}">${member.relationship || 'SELF'}</span></div>
            <div class="label">Status</div><div class="value"><span class="rx-status-badge ${member.lifecycle === 'REVOKED' ? 'rx-status-cancelled' : 'rx-status-active'}">${member.lifecycle === 'REVOKED' ? 'REVOKED' : (member.lifecycle || 'ELIGIBLE')}</span></div>
          </div>

          <!-- Accumulators -->
          <div class="mt-4">
            <div class="progress-container">
              <div class="progress-label">
                <span>Deductible</span>
                <span>${formatCents(member.accumulator.deductiblePaidCents)} / ${formatCents(plan.deductibleAmountCents)}</span>
              </div>
              <div class="progress-bar"><div class="fill deductible" style="width: ${pct(member.accumulator.deductiblePaidCents, plan.deductibleAmountCents)}%"></div></div>
            </div>
            <div class="progress-container">
              <div class="progress-label">
                <span>Out-of-Pocket Max</span>
                <span>${formatCents(member.accumulator.oopPaidCents)} / ${formatCents(plan.oopMaxCents)}</span>
              </div>
              <div class="progress-bar"><div class="fill oop" style="width: ${pct(member.accumulator.oopPaidCents, plan.oopMaxCents)}%"></div></div>
            </div>
          </div>

          <!-- PCP Status -->
          <div style="margin-top: 16px;">
            ${member.pcpAssignment
              ? `<div class="data-grid">
                  <div class="label">Primary Care</div>
                  <div class="value" style="color: var(--accent-green);">
                    ${member.pcpAssignment.prescriberName}, ${member.pcpAssignment.specialty}
                  </div>
                </div>`
              : `<div style="font-size: 12px; color: var(--text-muted);">No PCP assigned yet. Select one below.</div>`
            }
          </div>
        </div>
      </div>

      <!-- Credentials -->
      ${this.renderCredentialSection(member)}

      <!-- Prescriptions -->
      ${memberRxs.length > 0 ? `
      <div class="section-card">
        <div class="card-header member">Your Prescriptions</div>
        <div class="card-body">
          <table class="insurer-table">
            <thead><tr><th>Rx ID</th><th>Medication</th><th>Qty</th><th>Dispensed</th><th>Status</th><th>Payment</th></tr></thead>
            <tbody>
              ${memberRxs.map(rx => {
                const statusClass = `rx-status-${(rx.status || 'ACTIVE').toLowerCase().replace('_', '-')}`;
                const statusLabel = (rx.status || 'ACTIVE').replace('_', ' ');
                const payment = rx.patientPayCents != null ? formatCents(rx.patientPayCents) : '\u2014';
                return `
                <tr>
                  <td class="mono" style="font-size: 11px;">${rx.id}</td>
                  <td>${rx.medication}${rx.medicationStrength ? ' ' + rx.medicationStrength : ''}</td>
                  <td>${rx.quantity}</td>
                  <td>${rx.quantityDispensed || 0}</td>
                  <td><span class="rx-status-badge ${statusClass}">${statusLabel}</span></td>
                  <td>${payment}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ` : ''}

      <!-- Claims & Fill History -->
      ${this.renderClaimsSection(state, member, memberRxs)}

      <!-- Activity Summary -->
      ${this.renderActivitySection(state, member, memberRxs)}

      <!-- Messaging -->
      ${this.renderMessagingSection(state, member, enrolled)}

      <!-- Data Sharing — Delegations -->
      ${this.renderDelegationSection(state, member, enrolled)}

      <!-- PCP Assignment (not shown for terminated members) -->
      ${!member.pcpAssignment && member.lifecycle !== 'REVOKED' ? this.renderPcpSection(state, member) : ''}

      <!-- Formulary Lookup -->
      ${this.renderFormularySection(state)}

      <!-- Claim Verification -->
      ${this.renderClaimVerificationSection(member)}

      <!-- L2 Receipts -->
      ${this.renderReceiptsSection(member)}

      <!-- Family Dashboard -->
      ${this.renderFamilySection(state, enrolled, member)}

      <!-- Node Info -->
      ${this.renderNodeInfoSection()}

      <!-- Enroll Another Member -->
      <div class="section-card">
        <div class="card-header member">Enroll Another Member</div>
        <div class="card-body">
          <div class="form-group">
            <label>Select Member</label>
            <select id="member-select-dashboard">
              <option value="">\u2014 Choose a member \u2014</option>
              ${state.demoData.members.map((m, i) => {
                const alreadyEnrolled = enrolled.some(e => e.memberIndex === i);
                return `<option value="${i}" ${alreadyEnrolled ? 'disabled' : ''}>${m.firstName} ${m.lastName} (${m.cardholderId}) ${alreadyEnrolled ? '(enrolled)' : ''}</option>`;
              }).join('')}
            </select>
          </div>
          <button id="btn-enroll-another" class="btn-action member" disabled>
            <span class="spinner"></span>
            <span class="btn-text">Enroll Member</span>
          </button>
          <div id="enroll-another-result" class="hidden"></div>
        </div>
      </div>
    `;

    this.bindDashboardEvents(state, enrolled, member);
  }

  renderClaimsSection(state, member, memberRxs) {
    const fulfillments = state.fulfillments || [];
    const memberRxIds = new Set(memberRxs.map(rx => rx.id));

    // Join fulfillments to this member's prescriptions
    const memberClaims = fulfillments
      .filter(f => memberRxIds.has(f.prescriptionId))
      .sort((a, b) => (a.prescriptionId + a.fillIndex).localeCompare(b.prescriptionId + b.fillIndex));

    if (memberClaims.length === 0) return '';

    const rows = memberClaims.map(f => {
      const rx = memberRxs.find(r => r.id === f.prescriptionId);
      const drug = rx ? `${rx.medication}${rx.medicationStrength ? ' ' + rx.medicationStrength : ''}` : f.prescriptionId;
      const pharmacy = rx ? (state.demoData.pharmacies[rx.pharmacyIndex]?.storeName || '\u2014') : '\u2014';

      // Service date from fulfillment data (YYYYMMDD as bigint string)
      let fillDate = '\u2014';
      if (f.serviceDateStr && f.serviceDateStr.length === 8) {
        const s = f.serviceDateStr;
        fillDate = `${s.slice(4,6)}/${s.slice(6,8)}/${s.slice(0,4)}`;
      } else if (f.serviceDateStr) {
        fillDate = f.serviceDateStr;
      }

      const reversedBadge = f.reversed
        ? '<span class="rx-status-badge rx-status-cancelled" style="font-size: 10px; margin-left: 4px;">REVERSED</span>'
        : '';
      const settlement = f.settlementCommitment
        ? f.settlementCommitment.slice(0, 8) + '\u2026' + f.settlementCommitment.slice(-8)
        : '\u2014';

      return `
        <tr class="claims-row" data-dos="${f.serviceDateStr || ''}"${f.reversed ? ' style="opacity: 0.5;"' : ''}>
          <td>${drug}</td>
          <td>${pharmacy}</td>
          <td>${fillDate}</td>
          <td>${f.quantityDispensed}${reversedBadge}</td>
          <td style="color: var(--accent-orange); font-weight: 600;">${formatCents(f.patientPayCents)}</td>
          <td style="color: var(--accent-green);">${formatCents(f.planPayCents)}</td>
          <td>${formatCents(f.totalCostCents)}</td>
          <td class="mono" style="font-size: 10px;" title="${f.settlementCommitment || ''}">${settlement}</td>
        </tr>`;
    }).join('');

    const totalPatient = memberClaims.filter(f => !f.reversed).reduce((s, f) => s + f.patientPayCents, 0);
    const totalPlan = memberClaims.filter(f => !f.reversed).reduce((s, f) => s + f.planPayCents, 0);
    const totalCost = memberClaims.filter(f => !f.reversed).reduce((s, f) => s + f.totalCostCents, 0);

    return `
      <div class="section-card">
        <div class="card-header member">Claims & Fill History (${memberClaims.length})</div>
        <div class="card-body">
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
            Each row is a ZK-adjudicated claim. Patient/plan pay was computed <strong>in-circuit</strong> by AccumulatorFulfillmentProgram.
            Settlement commitments are Poseidon hashes stored in the prescription credential's TRANSACTION tree.
          </div>
          <div class="filter-row" style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap;">
            <label style="font-size: 12px; color: var(--text-secondary);">From:</label>
            <input type="date" id="claims-date-start" class="date-input" style="font-size: 12px; padding: 4px 8px;" />
            <label style="font-size: 12px; color: var(--text-secondary); margin-left: 8px;">To:</label>
            <input type="date" id="claims-date-end" class="date-input" style="font-size: 12px; padding: 4px 8px;" />
          </div>
          <table class="insurer-table" id="claims-history-table">
            <thead><tr><th>Drug</th><th>Pharmacy</th><th>Date</th><th>Qty</th><th>Patient Pay</th><th>Plan Pay</th><th>Total</th><th>Settlement</th></tr></thead>
            <tbody>
              ${rows}
              <tr style="border-top: 2px solid var(--border-subtle); font-weight: 700;">
                <td colspan="4" style="text-align: right;">Totals (active)</td>
                <td style="color: var(--accent-orange);">${formatCents(totalPatient)}</td>
                <td style="color: var(--accent-green);">${formatCents(totalPlan)}</td>
                <td>${formatCents(totalCost)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>

          ${memberClaims.some(f => f.newEligForestRoot) ? `
          <div style="margin-top: 12px; padding: 10px 14px; background: rgba(79, 195, 247, 0.06); border: 1px solid rgba(79, 195, 247, 0.2); border-radius: 6px; font-size: 12px;">
            <strong style="color: var(--accent-blue);">Eligibility Credential Updated</strong>
            <span style="color: var(--text-secondary); margin-left: 8px;">
              Forest root: <span class="mono" style="font-size: 10px;">${memberClaims[memberClaims.length - 1].newEligForestRoot}</span>
            </span>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderPcpSection(state, member) {
    const allPrescribers = state.demoData.prescribers;
    const hasNetwork = member.inNetworkPrescribers && member.inNetworkPrescribers.length > 0;
    const inNetworkSet = new Set(member.inNetworkPrescribers || []);
    const prescribers = hasNetwork
      ? allPrescribers.filter(p => inNetworkSet.has(p.index))
      : allPrescribers;

    return `
      <div class="section-card">
        <div class="card-header pcp">Assign Primary Care Physician</div>
        <div class="card-body">
          <p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
            ${hasNetwork ? `Showing ${prescribers.length} in-network prescribers for ${member.planId}.` : 'All prescribers shown.'} Recommended PCP specialties are highlighted.
          </p>
          <div class="entity-grid" id="pcp-prescriber-grid">
            ${prescribers.map(p => {
              const isPcpEligible = PCP_ELIGIBLE_SPECIALTIES.includes(p.specialty);
              return `
                <div class="entity-card ${isPcpEligible ? 'pcp-eligible' : ''}" data-index="${p.index}">
                  ${isPcpEligible ? '<span class="pcp-badge">Recommended PCP</span>' : ''}
                  ${hasNetwork ? '<span class="network-badge">In-Network</span>' : ''}
                  <div class="entity-name" style="color: var(--color-prescriber);">Dr. ${p.firstName} ${p.lastName}, ${p.credential}</div>
                  <div class="entity-detail">${p.specialty}</div>
                  <div class="entity-detail">NPI: ${p.npi} | ${p.state}</div>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Consent Declaration (hidden until prescriber selected) -->
          <div id="pcp-consent-section" class="hidden" style="margin-top: 16px;">
            <div class="consent-card">
              <p><strong>By assigning a Primary Care Physician, you consent to sharing:</strong></p>
              <ul style="margin: 8px 0; padding-left: 20px; font-size: 13px; color: var(--text-secondary);">
                <li>Prescription history (all Rx written for you)</li>
                <li>Eligibility and benefit plan data</li>
                <li>Accumulator state (deductible, out-of-pocket maximum)</li>
              </ul>
              <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">
                The ZK proof generated below serves as cryptographic consent verification.
                No separate consent form is needed \u2014 the proof IS the consent.
              </p>
            </div>
            <button id="btn-assign-pcp" class="btn-action pcp" disabled>
              <span class="spinner"></span>
              Assign as My PCP
            </button>
            <div id="pcp-result" class="hidden"></div>
          </div>
        </div>
      </div>
    `;
  }

  renderFamilySection(state, enrolled, member) {
    const familyId = member.familyId;
    if (!familyId) return '';

    const familyMembers = state.demoData.members.filter(m => m.familyId === familyId);
    if (familyMembers.length <= 1) return '';

    const allFamilyEnrolled = familyMembers.every(fm =>
      enrolled.some(e => e.memberIndex === fm.index)
    );

    return `
      <div class="section-card">
        <div class="card-header member">Your Family \u2014 ${familyId}</div>
        <div class="card-body">
          <div class="family-member-cards">
            ${familyMembers.map(fm => {
              const enrolledMember = enrolled.find(e => e.memberIndex === fm.index);
              const isRevoked = enrolledMember && enrolledMember.lifecycle === 'REVOKED';
              return `
                <div class="family-member-card"${isRevoked ? ' style="opacity: 0.5;"' : ''}>
                  <div class="family-member-name">${fm.firstName} ${fm.lastName}</div>
                  <div class="family-member-detail">
                    <span class="family-badge ${fm.relationship.toLowerCase()}">${fm.relationship}</span>
                    ${isRevoked
                      ? `<span style="color: var(--accent-red); font-size: 10px; margin-left: 8px;">TERMINATED</span>`
                      : enrolledMember
                        ? `<span style="color: var(--accent-green); font-size: 10px; margin-left: 8px;">ENROLLED</span>`
                        : `<span style="color: var(--text-muted); font-size: 10px; margin-left: 8px;">Not enrolled</span>`
                    }
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Family Accumulators -->
          ${this.renderFamilyAccumulators(state, enrolled, familyId)}

          ${!allFamilyEnrolled ? `
            <button id="btn-enroll-family" class="btn-enroll-family">
              <span class="spinner"></span>
              Enroll All Family Members
            </button>
            <div id="family-enroll-result"></div>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderFamilyAccumulators(state, enrolled, familyId) {
    const plan = state.demoData.plan;
    const familyEnrolled = enrolled.filter(e => e.familyId === familyId);
    if (familyEnrolled.length <= 1) return '';

    let totalDeductible = 0, totalOop = 0;
    for (const e of familyEnrolled) {
      totalDeductible += e.accumulator.deductiblePaidCents;
      totalOop += e.accumulator.oopPaidCents;
    }

    const famDeductible = plan.familyDeductibleAmountCents || plan.deductibleAmountCents * 2;
    const famOop = plan.familyOopMaxCents || plan.oopMaxCents * 2;

    return `
      <div style="margin-top: 12px;">
        <div style="font-size: 12px; font-weight: 600; color: var(--accent-blue); margin-bottom: 8px;">Family Accumulators (${familyEnrolled.length} members)</div>
        <div class="progress-container">
          <div class="progress-label">
            <span>Family Deductible</span>
            <span>${formatCents(totalDeductible)} / ${formatCents(famDeductible)}</span>
          </div>
          <div class="progress-bar"><div class="fill deductible" style="width: ${pct(totalDeductible, famDeductible)}%"></div></div>
        </div>
        <div class="progress-container">
          <div class="progress-label">
            <span>Family Out-of-Pocket Max</span>
            <span>${formatCents(totalOop)} / ${formatCents(famOop)}</span>
          </div>
          <div class="progress-bar"><div class="fill oop" style="width: ${pct(totalOop, famOop)}%"></div></div>
        </div>
      </div>
    `;
  }

  renderMessagingSection(state, member, enrolled) {
    if (member.lifecycle === 'REVOKED') return '';
    const messages = (state.messaging?.messages || []).filter(m =>
      m.senderWalletId === member.walletId || m.recipientWalletId === member.walletId
    );
    const dir = state.walletDirectory || {};
    const MSG_LABELS = { 1:'Rx', 2:'PA Req', 3:'PA Resp', 4:'Notice', 5:'General', 6:'Support', 7:'Summary' };

    // Group messages by threadId
    const threadMap = new Map();
    messages.forEach(m => {
      const tid = m.threadId || `msg-${m.messageIndex}`;
      if (!threadMap.has(tid)) threadMap.set(tid, []);
      threadMap.get(tid).push(m);
    });
    // Sort threads by latest timestamp descending
    const threads = Array.from(threadMap.entries())
      .map(([tid, msgs]) => ({ threadId: tid, messages: msgs, latest: Math.max(...msgs.map(m => m.timestamp || 0)) }))
      .sort((a, b) => b.latest - a.latest);

    // Build recipient options — members can only contact PCP and family members
    const recipientOptions = [];

    // 1. Assigned PCP (if any)
    if (member.pcpAssignment) {
      const p = state.demoData.prescribers[member.pcpAssignment.prescriberIndex];
      recipientOptions.push(`<option value="prescriber:${member.pcpAssignment.prescriberIndex}">Dr. ${p.firstName} ${p.lastName} (My PCP)</option>`);
    }

    // 2. Family members (same familyId, enrolled, not self, not revoked)
    if (member.familyId) {
      (enrolled || [])
        .filter(e => e.familyId === member.familyId && e.walletId !== member.walletId && e.lifecycle !== 'REVOKED')
        .forEach(fm => {
          recipientOptions.push(`<option value="member:${fm.walletId}">${fm.displayName} (Family)</option>`);
        });
    }

    return `
      <div class="section-card">
        <div class="card-header member">Secure Messages (${messages.length})</div>
        <div class="card-body">
          <div id="msg-reply-banner" class="hidden" style="background: var(--bg-tertiary); border: 1px solid var(--accent-blue); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <span id="msg-reply-label" style="font-size: 12px; color: var(--accent-blue);"></span>
            <button id="btn-cancel-reply" style="background: none; border: none; color: var(--accent-red); cursor: pointer; font-size: 12px;">Cancel</button>
          </div>
          <div class="msg-compose">
            <div style="font-size: 12px; font-weight: 600; color: var(--accent-blue); margin-bottom: 8px;">Send Encrypted Message</div>
            <label>To</label>
            <select id="msg-recipient">
              <option value="">\u2014 Select recipient \u2014</option>
              ${recipientOptions.join('')}
            </select>
            <label>Subject</label>
            <input type="text" id="msg-subject" placeholder="Subject">
            <label>Message</label>
            <textarea id="msg-body" rows="2" placeholder="Type your message..."></textarea>
            <input type="hidden" id="msg-thread-id" value="">
            <button id="btn-send-message" class="btn-action member" disabled>
              <span class="spinner"></span> Send Encrypted Message
            </button>
            <div class="msg-privacy-note">End-to-end encrypted (X25519-ECDH + AES-256-GCM). ZK proof generated on send.</div>
          </div>
          <div id="send-message-result" class="hidden"></div>
          ${threads.length > 0 ? `
          <div class="msg-thread-list">
            ${threads.map(t => {
              const lastMsg = t.messages[t.messages.length - 1];
              const isSent = lastMsg.senderWalletId === member.walletId;
              const otherWid = isSent ? lastMsg.recipientWalletId : lastMsg.senderWalletId;
              const otherName = dir[otherWid]?.displayName || otherWid.slice(0,8) + '\u2026';
              const typeLabel = MSG_LABELS[lastMsg.messageType] || 'Msg';
              const timeStr = lastMsg.timestamp ? new Date(lastMsg.timestamp).toLocaleTimeString() : '';
              return `
              <div class="msg-thread-item" data-thread-id="${t.threadId}" data-wallet-id="${member.walletId}" data-indices="${t.messages.map(m => m.messageIndex).join(',')}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <div>
                    <span class="msg-type-badge msg-type-${lastMsg.messageType}">${typeLabel}</span>
                    <strong style="font-size: 12px; margin-left: 4px;">${otherName}</strong>
                    <span style="font-size: 11px; color: var(--text-muted); margin-left: 4px;">(${t.messages.length} message${t.messages.length > 1 ? 's' : ''})</span>
                  </div>
                  <span style="font-size: 11px; color: var(--text-muted);">${timeStr}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-muted);">${lastMsg.hasEncryptedPayload ? 'Click to decrypt and view' : 'No content'}</div>
                <div class="msg-thread-expanded hidden" data-thread-body="${t.threadId}"></div>
              </div>`;
            }).join('')}
          </div>
          ` : '<div style="color: var(--text-muted); font-size: 13px;">No messages yet. Send a message to your PCP, pharmacy, or insurer.</div>'}
        </div>
      </div>
    `;
  }

  renderDelegationSection(state, member, enrolled) {
    if (member.lifecycle === 'REVOKED') return '';
    const delegations = (state.messaging?.delegations || []).filter(d =>
      d.delegatorWalletId === member.walletId || d.delegateWalletId === member.walletId
    );
    const otherMembers = enrolled.filter(e => e.walletId !== member.walletId && e.lifecycle !== 'REVOKED');
    if (otherMembers.length === 0 && delegations.length === 0) return '';

    const REL_LABELS = { 1:'Parent', 2:'Spouse', 3:'Power of Attorney', 4:'Guardian', 5:'Migration', 6:'Appointed Rep' };
    const dir = state.walletDirectory || {};

    return `
      <div class="section-card">
        <div class="card-header member">Data Sharing \u2014 Delegations (${delegations.length})</div>
        <div class="card-body">
          ${otherMembers.length > 0 ? `
          <div class="msg-compose">
            <div style="font-size: 12px; font-weight: 600; color: var(--accent-blue); margin-bottom: 8px;">Create Delegation</div>
            <label>Delegate To</label>
            <select id="delegate-select">
              <option value="">\u2014 Select member \u2014</option>
              ${otherMembers.map(m => `<option value="${m.walletId}">${m.displayName} (${m.relationship})</option>`).join('')}
            </select>
            <div style="display: flex; gap: 12px; margin: 8px 0;">
              <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"><input type="checkbox" id="scope-read" checked> Read</label>
              <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"><input type="checkbox" id="scope-write"> Write</label>
              <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"><input type="checkbox" id="scope-pickup"> Pickup</label>
            </div>
            <label>Relationship</label>
            <select id="relationship-select">
              <option value="1">Parent</option>
              <option value="2">Spouse</option>
              <option value="3">Power of Attorney</option>
              <option value="4">Guardian</option>
            </select>
            <button id="btn-create-delegation" class="btn-action member">
              <span class="spinner"></span> Create Delegation (ZK Proof)
            </button>
          </div>
          ` : ''}
          <div id="delegation-result" class="hidden"></div>
          ${delegations.length > 0 ? `
          <table class="insurer-table">
            <thead><tr><th>Direction</th><th>Party</th><th>Scope</th><th>Relationship</th></tr></thead>
            <tbody>
              ${delegations.map(d => {
                const isGranted = d.delegatorWalletId === member.walletId;
                const otherWid = isGranted ? d.delegateWalletId : d.delegatorWalletId;
                const otherName = dir[otherWid]?.displayName || enrolled.find(e => e.walletId === otherWid)?.displayName || otherWid.slice(0,8) + '\u2026';
                const scopeLabels = [];
                if (d.scopeFlags & 1) scopeLabels.push('READ');
                if (d.scopeFlags & 2) scopeLabels.push('WRITE');
                if (d.scopeFlags & 4) scopeLabels.push('PICKUP');
                return `<tr>
                  <td>${isGranted ? 'Granted \u2192' : '\u2190 Received'}</td>
                  <td>${otherName}</td>
                  <td>${scopeLabels.join(', ')}</td>
                  <td>${REL_LABELS[d.relationshipCode] || d.relationshipCode}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderActivitySection(state, member, memberRxs) {
    const fulfillments = state.fulfillments || [];
    const memberRxIds = new Set(memberRxs.map(rx => rx.id));
    const memberClaims = fulfillments.filter(f => memberRxIds.has(f.prescriptionId));
    if (memberClaims.length === 0) return '';

    const activeClaims = memberClaims.filter(f => !f.reversed);
    const reversals = memberClaims.filter(f => f.reversed);
    const totalPatientPay = activeClaims.reduce((s, f) => s + (f.patientPayCents || 0), 0);
    const totalPlanPay = activeClaims.reduce((s, f) => s + (f.planPayCents || 0), 0);
    const uniqueMeds = new Set(memberRxs.filter(rx => memberClaims.some(f => f.prescriptionId === rx.id)).map(rx => rx.medicationIndex));

    const content = `
      ${renderMetricRow([
        { label: 'Total Claims', value: memberClaims.length, color: 'var(--accent-blue)' },
        { label: 'Active Claims', value: activeClaims.length, color: 'var(--accent-green)' },
        { label: 'Reversals', value: reversals.length, color: 'var(--accent-red)' },
      ])}
      ${renderMetricRow([
        { label: 'Patient Pay', value: formatCents(totalPatientPay), color: 'var(--accent-orange)' },
        { label: 'Plan Pay', value: formatCents(totalPlanPay), color: 'var(--accent-green)' },
        { label: 'Unique Medications', value: uniqueMeds.size, color: 'var(--accent-blue)' },
      ])}
    `;

    return renderSectionCard('Activity Summary', 'member', content);
  }

  renderFormularySection(state) {
    const medications = state.demoData.medications;
    if (!medications || medications.length === 0) return '';

    const rows = medications.map((m, i) => {
      const tier = m.currentTierLevel ?? m.tier;
      const copay = m.currentCopayAmountCents ?? m.copayAmountCents;
      const pa = m.currentRequiresPriorAuth ?? m.requiresPriorAuth;
      const active = m.active !== false;
      const paBadge = pa
        ? '<span class="pa-badge pa-required">PA</span>'
        : '<span style="color: var(--text-muted);">No</span>';
      const removedClass = !active ? ' formulary-removed' : '';
      return `
        <tr data-med-index="${i}" class="${removedClass}" style="cursor: pointer;">
          <td>${m.brandName}${!active ? ' <span class="removed-badge">Removed</span>' : ''}</td>
          <td>${m.genericName}</td>
          <td>${m.ndc}</td>
          <td><span class="tier-badge tier-${tier}">Tier ${tier}</span></td>
          <td>${formatCents(copay)}</td>
          <td>${paBadge}</td>
          <td>${m.maxQuantityPerFill}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header member">Formulary Lookup (${medications.length})</div>
        <div class="card-body">
          <div class="form-group" style="margin-bottom: 12px;">
            <input type="text" id="member-formulary-search" placeholder="Search medications by name, NDC, or class..." />
          </div>
          <div style="max-height: 400px; overflow-y: auto;">
            <table class="med-table">
              <thead>
                <tr><th>Brand Name</th><th>Generic</th><th>NDC</th><th>Tier</th><th>Copay</th><th>PA?</th><th>Max Qty</th></tr>
              </thead>
              <tbody id="member-formulary-body">${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div id="member-formulary-detail" class="section-card hidden">
        <div class="card-header member">Medication Details</div>
        <div class="card-body" id="member-formulary-detail-body"></div>
      </div>
    `;
  }

  showMemberMedDetail(med) {
    const detail = document.getElementById('member-formulary-detail');
    if (!detail) return;
    detail.classList.remove('hidden');

    const tier = med.currentTierLevel ?? med.tier;
    const copay = med.currentCopayAmountCents ?? med.copayAmountCents;
    const pa = med.currentRequiresPriorAuth ?? med.requiresPriorAuth;
    const step = med.currentStepTherapyRequired ?? med.stepTherapyRequired;
    const active = med.active !== false;
    const deaDisplay = med.deaSchedule === 0
      ? 'Non-controlled'
      : `<span class="dea-badge dea-schedule-${med.deaSchedule}">Schedule ${med.deaSchedule}</span>`;

    document.getElementById('member-formulary-detail-body').innerHTML = `
      ${!active ? '<div style="padding: 8px 12px; background: rgba(244, 67, 54, 0.08); border: 1px solid rgba(244, 67, 54, 0.3); border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: var(--accent-red);">This medication has been removed from the formulary.</div>' : ''}
      <div class="data-grid">
        <div class="label">Brand Name</div><div class="value">${med.brandName}</div>
        <div class="label">Generic Name</div><div class="value">${med.genericName}</div>
        <div class="label">Strength</div><div class="value">${med.strength}</div>
        <div class="label">Dosage Form</div><div class="value">${med.dosageForm}</div>
        <div class="label">Route</div><div class="value">${med.route}</div>
        <div class="label">NDC</div><div class="value mono">${med.ndc}</div>
        <div class="label">Tier</div><div class="value"><span class="tier-badge tier-${tier}">Tier ${tier}</span></div>
        <div class="label">Copay</div><div class="value">${formatCents(copay)}</div>
        <div class="label">Prior Auth</div><div class="value">${pa ? '<span class="pa-badge pa-required">PA Required</span>' : '<span style="color: var(--accent-green);">Not Required</span>'}</div>
        <div class="label">Step Therapy</div><div class="value">${step ? '<span class="step-therapy-badge">Required</span>' : '<span style="color: var(--accent-green);">Not Required</span>'}</div>
        <div class="label">Max Qty/Fill</div><div class="value">${med.maxQuantityPerFill}</div>
        <div class="label">Max Day Supply</div><div class="value">${med.maxDaySupply}</div>
        <div class="label">AWP Unit Price</div><div class="value">${formatCents(med.awpUnitPriceCents)}</div>
        <div class="label">Manufacturer</div><div class="value">${med.manufacturer}</div>
        <div class="label">Therapeutic Class</div><div class="value">${med.therapeuticClass}</div>
        <div class="label">DEA Schedule</div><div class="value">${deaDisplay}</div>
      </div>
    `;
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  renderClaimVerificationSection(member) {
    if (!member || member.lifecycle === 'REVOKED') return '';

    return `
      <div class="section-card">
        <div class="card-header member">Claim Verification</div>
        <div class="card-body">
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
            Enter a claim accumulator leaf index to retrieve Merkle proof data for verification.
          </div>
          <div style="display: flex; gap: 8px; align-items: flex-end;">
            <div style="flex: 1;">
              <input type="text" id="member-verify-leaf" placeholder="Enter leaf index..." style="width: 100%;" />
            </div>
            <button id="btn-verify-claim" class="btn-action member" style="white-space: nowrap;">Verify</button>
          </div>
          <div id="member-verify-result" style="margin-top: 12px;"></div>
        </div>
      </div>
    `;
  }

  renderReceiptsSection(member) {
    if (!member || member.lifecycle === 'REVOKED') return '';

    return `
      <div class="section-card">
        <div class="card-header member">My L2 Receipts</div>
        <div class="card-body">
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
            Receipts issued by the sequencer for this wallet's state transitions.
          </div>
          <div id="member-receipts-container">
            <div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 12px;">Loading receipts...</div>
          </div>
        </div>
      </div>
    `;
  }

  async loadReceipts(member) {
    const container = document.getElementById('member-receipts-container');
    if (!container || !member) return;

    try {
      const res = await fetch(`${API_BASE}/node/receipts-by-wallet?walletId=${encodeURIComponent(member.walletId)}`);
      if (!res.ok) throw new Error('Failed to fetch receipts');
      const data = await res.json();
      const receipts = data.receipts || [];

      if (receipts.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 12px;">No receipts yet.</div>';
        return;
      }

      const rows = receipts.map(r => {
        const id = r.receiptId || r.id || '';
        const truncId = id.length > 16 ? id.slice(0, 8) + '\u2026' + id.slice(-6) : id;
        const ts = r.acceptedAt || r.timestamp;
        const timeStr = ts ? new Date(ts).toLocaleString() : '\u2014';
        const type = r.type || 'transition';
        const seq = r.sequenceNumber ?? '\u2014';
        const statusColor = r.status === 'settled' ? 'var(--accent-green)' : 'var(--accent-yellow)';
        return `
          <tr>
            <td class="mono" style="font-size: 11px;" title="${id}">${truncId}</td>
            <td>${type}</td>
            <td>${seq}</td>
            <td>${timeStr}</td>
            <td><span style="color: ${statusColor}; font-weight: 600; font-size: 11px;">${r.status || 'pending'}</span></td>
          </tr>`;
      }).join('');

      container.innerHTML = `
        <table class="insurer-table">
          <thead><tr><th>Receipt ID</th><th>Type</th><th>Seq #</th><th>Timestamp</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color: var(--accent-red); font-size: 12px; padding: 12px;">${err.message}</div>`;
    }
  }

  renderNodeInfoSection() {
    return `
      <div class="section-card">
        <div class="card-header member collapsible" onclick="this.parentElement.classList.toggle('collapsed')">
          <span>Node Info</span>
          <span class="collapse-arrow">&#9660;</span>
        </div>
        <div class="card-body collapsible-body">
          <div id="member-node-info">
            <div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 12px;">Loading chain state...</div>
          </div>
        </div>
      </div>
    `;
  }

  async loadNodeInfo() {
    const container = document.getElementById('member-node-info');
    if (!container) return;

    try {
      const res = await fetch(`${API_BASE}/node/chain-state`);
      if (!res.ok) throw new Error('Failed to fetch chain state');
      const cs = await res.json();

      const truncate = (s) => s && String(s).length > 16 ? String(s).slice(0, 8) + '\u2026' + String(s).slice(-6) : String(s || '\u2014');

      const entries = [];
      entries.push(`<div class="label">Sequencer URL</div><div class="value mono">http://127.0.0.1:3030</div>`);
      entries.push(`<div class="label">Health</div><div class="value"><span style="color: var(--accent-green);">Connected</span></div>`);
      if (cs.registryRoot) entries.push(`<div class="label">Registry Root</div><div class="value mono" style="font-size: 11px;">${truncate(cs.registryRoot)}</div>`);
      if (cs.lifecycleRoot) entries.push(`<div class="label">Lifecycle Root</div><div class="value mono" style="font-size: 11px;">${truncate(cs.lifecycleRoot)}</div>`);
      if (cs.walletCount != null) entries.push(`<div class="label">Wallet Count</div><div class="value">${cs.walletCount}</div>`);
      if (cs.benefitPlanRoot) entries.push(`<div class="label">Benefit Plan Root</div><div class="value mono" style="font-size: 11px;">${truncate(cs.benefitPlanRoot)}</div>`);
      if (cs.nftRegistryRoot) entries.push(`<div class="label">Credential Registry Root</div><div class="value mono" style="font-size: 11px;">${truncate(cs.nftRegistryRoot)}</div>`);
      if (cs.blockHeight != null) entries.push(`<div class="label">Block Height</div><div class="value">${cs.blockHeight}</div>`);
      if (cs.globalStateRoot) entries.push(`<div class="label">Global State Root</div><div class="value mono" style="font-size: 11px;">${truncate(cs.globalStateRoot)}</div>`);

      container.innerHTML = `<div class="data-grid">${entries.join('')}</div>`;
    } catch (err) {
      container.innerHTML = `<div class="data-grid">
        <div class="label">Sequencer URL</div><div class="value mono">http://127.0.0.1:3030</div>
        <div class="label">Health</div><div class="value"><span style="color: var(--accent-red);">Disconnected</span></div>
      </div>
      <div style="color: var(--accent-red); font-size: 12px; margin-top: 8px;">${err.message}</div>`;
    }
  }

  renderCredentialSection(member) {
    const inv = member.nftInventory;
    if (!inv) return '';

    const cred = inv.nfts && inv.nfts[0];
    const isRevoked = member.lifecycle === 'REVOKED';
    const credTypeLabel = cred?.nftType === '1' ? 'ELIGIBILITY' : cred?.nftType === '2' ? 'PRESCRIPTION' : cred?.nftType;
    const truncate = (s) => s && s.length > 16 ? s.slice(0, 8) + '\u2026' + s.slice(-6) : s;

    return `
      <div class="section-card">
        <div class="card-header member">Credentials</div>
        <div class="card-body">
          <div class="credential-inventory-info">
            <span class="credential-count">${inv.count}</span> credential${inv.count !== 1 ? 's' : ''} in inventory
            <span style="margin-left: 8px; color: var(--text-muted);">root: ${truncate(inv.inventoryRoot)}</span>
          </div>

          ${cred ? `
          <div class="data-grid" style="margin-bottom: 12px;">
            <div class="label">Credential Type</div><div class="value">${credTypeLabel} (${cred.nftType})</div>
            <div class="label">Forest Root</div><div class="value mono" style="font-size: 11px;">${truncate(cred.forestRoot)}</div>
            <div class="label">Issuer</div><div class="value mono" style="font-size: 11px;">${truncate(cred.issuerWalletId)}</div>
            <div class="label">Subject</div><div class="value mono" style="font-size: 11px;">${truncate(cred.subjectWalletId)} (you)</div>
            <div class="label">Status</div><div class="value">${cred.revoked === '0' ? '<span style="color: var(--accent-green);">Active</span>' : '<span style="color: var(--accent-red);">Revoked</span>'}</div>
            <div class="label">Commitment</div><div class="value mono" style="font-size: 11px;">${truncate(cred.commitment)}</div>
          </div>

          ${!isRevoked ? `
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px;">
            <label style="font-size: 12px; color: var(--text-secondary);">Proof Type:</label>
            <select id="credential-proof-type" style="font-size: 12px; padding: 4px 8px;">
              <option value="holding">Prove Holding</option>
              <option value="holding-by-type">Prove Holding by Type (ELIGIBILITY)</option>
            </select>
          </div>
          <button id="btn-generate-credential" class="btn-action member" ${!this.app.isCompiled() ? 'disabled' : ''}>
            <span class="spinner"></span> <span class="btn-text">Generate Portable Credential</span>
          </button>
          ` : `
          <div style="font-size: 12px; color: var(--accent-red); margin-top: 8px;">
            Credential revoked \u2014 cannot generate credentials for terminated members.
          </div>
          `}

          <div id="credential-result" class="hidden"></div>
          ` : `
          <div style="font-size: 12px; color: var(--text-muted);">No credentials in inventory.</div>
          `}
        </div>
      </div>
    `;
  }

  async doGenerateCredential(member) {
    const btn = document.getElementById('btn-generate-credential');
    const proofTypeSelect = document.getElementById('credential-proof-type');
    const proofType = proofTypeSelect?.value || 'holding';

    btn.classList.add('loading');
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Generating\u2026';
    this.app.setStatus('working', 'Generating credential proof\u2026');

    try {
      const kickoff = await fetch(`${API_BASE}/interactive/generate-credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletId: member.walletId, proofType }),
      });

      const kickoffData = await kickoff.json();
      if (!kickoff.ok && kickoff.status !== 202) {
        throw new Error(kickoffData.error || 'Failed to start credential generation');
      }

      // If the server already had a completed result (re-submit), handle immediately
      if (kickoffData.status === 'complete') {
        this._handleCredentialComplete(btn, kickoffData.result);
        return;
      }
      if (kickoffData.status === 'error') {
        throw new Error(kickoffData.error || 'Credential generation failed');
      }

      // Poll every 15s, up to 10 minutes (40 polls)
      this._pollCredentialStatus(btn, member.walletId, proofType);

    } catch (err) {
      const resultDiv = document.getElementById('credential-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div class="verify-result invalid"><div class="verify-badge invalid">Error: ${err.message}</div></div>`;
      this.app.setStatus('ready', 'Credential generation failed');
      btn.classList.remove('loading');
      btn.querySelector('.btn-text').textContent = 'Generate Portable Credential';
      btn.disabled = false;
    }
  }

  _pollCredentialStatus(btn, walletId, proofType) {
    const resultDiv = document.getElementById('credential-result');
    let pollCount = 0;
    const maxPolls = 40; // 40 * 15s = 10 minutes

    const poll = async () => {
      pollCount++;
      try {
        const res = await fetch(`${API_BASE}/interactive/credential-status?walletId=${encodeURIComponent(walletId)}&proofType=${encodeURIComponent(proofType)}`);
        const data = await res.json();

        if (data.status === 'complete') {
          this._handleCredentialComplete(btn, data.result);
          return;
        }

        if (data.status === 'error') {
          throw new Error(data.error || 'Credential generation failed');
        }

        if (pollCount >= maxPolls) {
          throw new Error('Credential generation timed out after 10 minutes');
        }

        // Still pending — show elapsed time
        const elapsed = pollCount * 15;
        btn.querySelector('.btn-text').textContent = `Generating\u2026 ${elapsed}s`;
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-blue); padding: 12px;">Generating ZK credential proof\u2026 (${elapsed}s elapsed, checking every 15s)</div>`;

        setTimeout(poll, 15_000);
      } catch (err) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div class="verify-result invalid"><div class="verify-badge invalid">Error: ${err.message}</div></div>`;
        this.app.setStatus('ready', 'Credential generation failed');
        btn.classList.remove('loading');
        btn.querySelector('.btn-text').textContent = 'Generate Portable Credential';
        btn.disabled = false;
      }
    };

    // First poll after 15 seconds
    setTimeout(poll, 15_000);
  }

  _handleCredentialComplete(btn, data) {
    const resultDiv = document.getElementById('credential-result');
    resultDiv.classList.remove('hidden');

    // Store for re-generation
    this._lastCredentialJson = data.credentialJson;

    const truncate = (s) => s && s.length > 16 ? s.slice(0, 8) + '\u2026' + s.slice(-6) : s;
    const cred = data.credential;
    const credJson = data.credentialJson || '';

    resultDiv.innerHTML = `
      <div class="credential-summary">
        <div style="font-weight: 600; margin-bottom: 8px; color: var(--accent-green);">
          Portable Credential Generated
        </div>
        <div class="credential-field">
          <div class="cf-label">Proof Type</div><div class="cf-value">${cred.proofType}</div>
          <div class="cf-label">Wallet ID</div><div class="cf-value">${truncate(cred.publicOutput.walletId)}</div>
          <div class="cf-label">Credential Commitment</div><div class="cf-value">${truncate(cred.publicOutput.nftCommitment)}</div>
          <div class="cf-label">Inventory Root</div><div class="cf-value">${truncate(cred.publicOutput.oldInventoryRoot)}</div>
          <div class="cf-label">VK Hash</div><div class="cf-value">${truncate(cred.verificationKeyHash)}</div>
          <div class="cf-label">Expires</div><div class="cf-value">${cred.expiresAt === 0 ? 'Never' : new Date(cred.expiresAt).toLocaleString()}</div>
        </div>
        <div class="credential-timing">
          <span>ProofGate: ${(data.proofGateTimeMs / 1000).toFixed(1)}s</span>
          <span>CredentialProgram: ${(data.nftProgramTimeMs / 1000).toFixed(1)}s</span>
          <span>Total: ${(data.totalTimeMs / 1000).toFixed(1)}s</span>
        </div>

        <!-- Portable Credential JSON — always visible -->
        <div style="margin-top: 12px; padding: 12px; background: rgba(102, 187, 106, 0.06); border: 2px solid var(--accent-green); border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 13px; font-weight: 600; color: var(--accent-green);">
              Portable Credential JSON
            </span>
            <button id="btn-copy-credential" style="padding: 6px 16px; font-size: 13px; font-weight: 600; background: var(--accent-green); color: #0d1117; border: none; border-radius: 4px; cursor: pointer;">
              Copy to Clipboard
            </button>
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
            Copy this JSON and paste it into the pharmacy's <strong>"Credential JSON"</strong> field for offline identity verification.
          </div>
          <textarea id="credential-json-output" readonly
            style="width: 100%; height: 120px; padding: 8px; font-size: 11px; font-family: monospace; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 4px; color: var(--text-primary); resize: vertical; cursor: text;"
            onclick="this.select()">${credJson}</textarea>
          <div style="margin-top: 6px; font-size: 11px; color: var(--text-muted);">
            ${credJson.length.toLocaleString()} characters &bull; Click textarea to select all &bull; Contains ZK proof (no PHI revealed)
          </div>
        </div>
      </div>
    `;

    // Copy button with fallback
    document.getElementById('btn-copy-credential').addEventListener('click', () => {
      const copyBtn = document.getElementById('btn-copy-credential');
      navigator.clipboard.writeText(credJson).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.style.background = '#66bb6a';
        setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; copyBtn.style.background = ''; }, 2000);
      }).catch(() => {
        // Fallback: select textarea and execCommand
        const textarea = document.getElementById('credential-json-output');
        if (textarea) {
          textarea.select();
          document.execCommand('copy');
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
        }
      });
    });

    // Update button to show completion but allow re-generation
    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Regenerate Credential';
    btn.disabled = false;

    this.app.setStatus('ready', 'Credential generated');
  }

  bindDashboardEvents(state, enrolled, member) {
    // Credential generation
    const btnCredential = document.getElementById('btn-generate-credential');
    if (btnCredential) {
      btnCredential.addEventListener('click', () => this.doGenerateCredential(member));
    }

    // PCP prescriber grid
    const pcpGrid = document.getElementById('pcp-prescriber-grid');
    if (pcpGrid) {
      pcpGrid.addEventListener('click', (e) => {
        const card = e.target.closest('.entity-card');
        if (!card) return;
        pcpGrid.querySelectorAll('.entity-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.pcpSelectedPrescriber = parseInt(card.dataset.index, 10);

        document.getElementById('pcp-consent-section').classList.remove('hidden');
        document.getElementById('btn-assign-pcp').disabled = false;
      });

      const btnPcp = document.getElementById('btn-assign-pcp');
      if (btnPcp) {
        btnPcp.addEventListener('click', () => this.doAssignPcp(member));
      }
    }

    // Family enrollment button
    const familyBtn = document.getElementById('btn-enroll-family');
    if (familyBtn) {
      const subscriberMember = state.demoData.members.find(
        m => m.familyId === member.familyId && m.relationship === 'SELF'
      );
      const subscriberEnrolled = subscriberMember
        ? enrolled.find(e => e.memberIndex === subscriberMember.index)
        : null;
      const subscriberIndex = subscriberEnrolled
        ? subscriberEnrolled.memberIndex
        : member.memberIndex;

      familyBtn.addEventListener('click', () => this.doEnrollFamily(familyBtn, subscriberIndex));
    }

    // Messaging
    const msgRecipient = document.getElementById('msg-recipient');
    const msgSubject = document.getElementById('msg-subject');
    const btnSendMsg = document.getElementById('btn-send-message');
    if (msgRecipient && btnSendMsg) {
      const enableSend = () => {
        btnSendMsg.disabled = !msgRecipient.value || !msgSubject?.value?.trim();
      };
      msgRecipient.addEventListener('change', enableSend);
      if (msgSubject) msgSubject.addEventListener('input', enableSend);
      btnSendMsg.addEventListener('click', () => this.doSendMessage(member));
    }
    // Cancel reply
    const btnCancelReply = document.getElementById('btn-cancel-reply');
    if (btnCancelReply) {
      btnCancelReply.addEventListener('click', () => {
        document.getElementById('msg-thread-id').value = '';
        document.getElementById('msg-reply-banner').classList.add('hidden');
        if (msgSubject) msgSubject.value = '';
        if (msgRecipient) { msgRecipient.value = ''; msgRecipient.disabled = false; }
      });
    }
    // Thread click handlers
    document.querySelectorAll('.msg-thread-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.msg-reply-btn')) return; // handled separately
        this.doExpandThread(el, member, state);
      });
    });

    // Delegation
    const btnDelegation = document.getElementById('btn-create-delegation');
    if (btnDelegation) {
      btnDelegation.addEventListener('click', () => this.doCreateDelegation(member));
    }

    // Enroll another member
    const selectAnother = document.getElementById('member-select-dashboard');
    const btnAnother = document.getElementById('btn-enroll-another');
    if (selectAnother && btnAnother) {
      selectAnother.addEventListener('change', () => {
        const idx = parseInt(selectAnother.value, 10);
        btnAnother.disabled = isNaN(idx);
        this.selectedMemberIndex = isNaN(idx) ? null : idx;
      });
      btnAnother.addEventListener('click', () => this.doEnrollAnother(btnAnother));
    }

    // Formulary search filter
    const formSearch = document.getElementById('member-formulary-search');
    const formBody = document.getElementById('member-formulary-body');
    if (formSearch && formBody) {
      formSearch.addEventListener('input', () => {
        const q = formSearch.value.toLowerCase();
        formBody.querySelectorAll('tr').forEach(row => {
          row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    }

    // Formulary row click → show detail
    if (formBody) {
      formBody.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (!row) return;
        const idx = parseInt(row.dataset.medIndex, 10);
        const med = state.demoData.medications[idx];
        if (med) this.showMemberMedDetail(med);
      });
    }

    // Claim verification
    const btnVerify = document.getElementById('btn-verify-claim');
    const leafInput = document.getElementById('member-verify-leaf');
    if (btnVerify && leafInput) {
      const doVerify = async () => {
        const leafIndex = leafInput.value.trim();
        if (!leafIndex) return;
        const resultDiv = document.getElementById('member-verify-result');
        resultDiv.innerHTML = '<div style="color: var(--accent-blue);">Verifying...</div>';
        try {
          const res = await fetch(`${API_BASE}/interactive/claim-proof?leafIndex=${encodeURIComponent(leafIndex)}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Verification failed');
          resultDiv.innerHTML = `
            <div style="padding: 12px; background: rgba(102, 187, 106, 0.08); border: 1px solid rgba(102, 187, 106, 0.3); border-radius: 6px;">
              <div style="font-weight: 600; color: var(--accent-green); margin-bottom: 8px;">Claim Verified</div>
              <div class="data-grid">
                <div class="label">Leaf Index</div><div class="value mono">${data.leafIndex}</div>
                <div class="label">Leaf Hash</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${data.leafHash || 'N/A'}</div>
                <div class="label">Root</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${data.root || 'N/A'}</div>
                <div class="label">Proof Valid</div><div class="value">${data.valid !== false ? '<span style="color: var(--accent-green);">Yes</span>' : '<span style="color: var(--accent-red);">No</span>'}</div>
              </div>
            </div>
          `;
        } catch (err) {
          resultDiv.innerHTML = `<div style="padding: 12px; background: rgba(239, 83, 80, 0.08); border: 1px solid rgba(239, 83, 80, 0.3); border-radius: 6px; color: var(--accent-red);">${err.message}</div>`;
        }
      };
      btnVerify.addEventListener('click', doVerify);
      leafInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
    }

    // Claims date filter
    const claimsStart = document.getElementById('claims-date-start');
    const claimsEnd = document.getElementById('claims-date-end');
    if (claimsStart && claimsEnd) {
      const filterClaims = () => {
        const startVal = claimsStart.value ? claimsStart.value.replace(/-/g, '') : '00000000';
        const endVal = claimsEnd.value ? claimsEnd.value.replace(/-/g, '') : '99999999';
        document.querySelectorAll('#claims-history-table .claims-row').forEach(row => {
          const dos = row.dataset.dos || '';
          if (!dos) { row.style.display = ''; return; }
          row.style.display = (dos >= startVal && dos <= endVal) ? '' : 'none';
        });
      };
      claimsStart.addEventListener('change', filterClaims);
      claimsEnd.addEventListener('change', filterClaims);
    }

    // Async data loading: receipts + node info
    this.loadReceipts(member);
    this.loadNodeInfo();
  }

  async doAssignPcp(member) {
    const btn = document.getElementById('btn-assign-pcp');
    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Generating PCP proofs...');

    try {
      const res = await fetch(`${API_BASE}/interactive/assign-pcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberWalletId: member.walletId,
          prescriberIndex: this.pcpSelectedPrescriber,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'PCP assignment failed');
      }

      const result = await res.json();
      this.pcpResult = result;

      const resultDiv = document.getElementById('pcp-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-card">
          <div class="result-title">PCP Assigned Successfully</div>
          <div class="data-grid">
            <div class="label">PCP</div><div class="value highlight">${result.prescriber.name}, ${result.prescriber.credential}</div>
            <div class="label">Specialty</div><div class="value">${result.prescriber.specialty}</div>
            <div class="label">NPI</div><div class="value mono">${result.prescriber.npi}</div>
            <div class="label">PCP Wallet ID</div><div class="value mono">${result.prescriber.walletId}</div>
            <div class="label">Consent Scope</div><div class="value">Rx History + Eligibility + Accumulators (7)</div>
          </div>
          <div style="margin: 12px 0; padding: 8px 12px; background: rgba(79, 195, 247, 0.08); border-radius: 6px; border: 1px solid rgba(79, 195, 247, 0.2);">
            <div style="font-size: 12px; color: var(--text-secondary);">
              <strong style="color: var(--accent-blue);">MEMBER Tree Root Changed</strong> \u2014 first data written to this domain tree
            </div>
            <div style="font-size: 11px; font-family: monospace; color: var(--text-muted); margin-top: 4px;">
              Forest root BEFORE: ${result.forestRootBefore}<br>
              Forest root AFTER: ${result.forestRootAfter}
            </div>
          </div>
          <div class="mt-4" style="font-size: 12px; color: var(--text-secondary);">
            <strong>Proof Generation Times:</strong><br>
            ProofGate: ${(result.proofTimesMs.proofGate / 1000).toFixed(2)}s |
            PcpVerification: ${(result.proofTimesMs.pcpVerification / 1000).toFixed(2)}s |
            <strong>Total: ${(result.proofTimesMs.total / 1000).toFixed(2)}s</strong>
          </div>

          ${renderZkDataSection('PcpAssignmentData (7 Fields)', result.pcpAssignmentData, 'member', '7 fields', result.pcpAssignmentData ? result.pcpAssignmentData.commitment : '')}
          ${renderCredentialCard('Updated Eligibility Credential', result.nft, 'member')}
          ${renderForestCard('Updated Forest (6 Domain Trees)', result.forest, 'member')}
        </div>
      `;

      if (result.chainState) {
        updateChainState(result.chainState);
      }

      this.app.setStatus('ready', 'Ready');

      // Re-render dashboard to show PCP in summary
      setTimeout(() => {
        this.app.fetchState().then(() => {
          this.render(this.app.state);
        });
      }, 1500);

    } catch (err) {
      const resultDiv = document.getElementById('pcp-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  async doEnrollFamily(btn, subscriberIndex) {
    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Enrolling family members...');

    try {
      const res = await fetch(`${API_BASE}/interactive/enroll-family`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberIndex }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Family enrollment failed');
      }

      const result = await res.json();
      const resultDiv = document.getElementById('family-enroll-result');
      resultDiv.innerHTML = `
        <div style="margin-top: 12px; padding: 12px; background: rgba(102, 187, 106, 0.08); border: 1px solid rgba(102, 187, 106, 0.2); border-radius: 8px;">
          <div style="font-size: 13px; font-weight: 600; color: var(--accent-green); margin-bottom: 8px;">
            Family Enrolled: ${result.memberCount} members
          </div>
          ${result.members.map(m => `
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">
              ${m.displayName || 'Member'} \u2014 ${m.status === 'already_enrolled' ? 'Already enrolled' : `Wallet: ${m.walletIdDisplay || m.walletId}`}
            </div>
          `).join('')}
        </div>
      `;
      btn.style.display = 'none';
      this.app.setStatus('ready', 'Ready');

      // Refresh dashboard
      setTimeout(() => {
        this.app.fetchState().then(() => {
          this.render(this.app.state);
        });
      }, 1000);

    } catch (err) {
      const resultDiv = document.getElementById('family-enroll-result');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px; margin-top: 8px;">${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  async doExpandThread(el, member, state) {
    const threadId = el.dataset.threadId;
    const walletId = el.dataset.walletId;
    const indices = el.dataset.indices.split(',').map(Number);
    const bodyDiv = el.querySelector(`[data-thread-body="${threadId}"]`);
    if (!bodyDiv) return;

    // Toggle collapse
    if (!bodyDiv.classList.contains('hidden')) {
      bodyDiv.classList.add('hidden');
      return;
    }

    // Decrypt
    bodyDiv.innerHTML = '<div style="padding: 8px; color: var(--text-muted); font-size: 12px;">Decrypting...</div>';
    bodyDiv.classList.remove('hidden');

    try {
      const res = await fetch(`${API_BASE}/interactive/decrypt-thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIndices: indices, walletId }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      const decrypted = await res.json();
      const dir = state.walletDirectory || {};
      const MSG_LABELS = { 1:'Rx', 2:'PA Req', 3:'PA Resp', 4:'Notice', 5:'General', 6:'Support', 7:'Summary' };

      bodyDiv.innerHTML = decrypted.filter(Boolean).map(m => {
        const isSent = m.senderWalletId === member.walletId;
        const senderName = dir[m.senderWalletId]?.displayName || m.senderWalletId.slice(0,8) + '\u2026';
        const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
        const typeLabel = MSG_LABELS[m.messageType] || 'Msg';
        return `
          <div class="msg-bubble ${isSent ? 'msg-sent' : 'msg-received'}">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="font-size: 11px; font-weight: 600;">${senderName}</span>
              <span style="font-size: 10px; color: var(--text-muted);">${timeStr} <span class="msg-type-badge msg-type-${m.messageType}" style="font-size: 9px;">${typeLabel}</span></span>
            </div>
            ${m.subject ? `<div style="font-weight: 600; font-size: 12px; margin-bottom: 2px;">${m.subject}</div>` : ''}
            <div style="font-size: 12px; white-space: pre-wrap;">${m.body}</div>
          </div>`;
      }).join('') + `
        <button class="msg-reply-btn" data-thread-id="${threadId}" style="margin-top: 8px; font-size: 11px; background: var(--accent-blue); color: white; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer;">Reply</button>
      `;

      // Bind reply button
      bodyDiv.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const lastDecrypted = decrypted.filter(Boolean).slice(-1)[0];
        const otherWid = lastDecrypted.senderWalletId === member.walletId ? lastDecrypted.recipientWalletId : lastDecrypted.senderWalletId;
        const otherInfo = dir[otherWid];

        // Set reply state
        document.getElementById('msg-thread-id').value = threadId;
        const banner = document.getElementById('msg-reply-banner');
        banner.classList.remove('hidden');
        document.getElementById('msg-reply-label').textContent = `Replying to: ${lastDecrypted.subject || 'conversation'}`;

        // Auto-set recipient
        const recipientSelect = document.getElementById('msg-recipient');
        if (recipientSelect && otherInfo) {
          // Find matching option
          for (const opt of recipientSelect.options) {
            if (opt.value && dir[otherWid]) {
              const [type, idx] = opt.value.split(':');
              const optName = opt.textContent;
              if (optName.includes(otherInfo.displayName) || opt.value.includes(otherWid)) {
                recipientSelect.value = opt.value;
                break;
              }
            }
          }
          recipientSelect.disabled = true;
        }

        // Auto-set subject
        const subjectInput = document.getElementById('msg-subject');
        if (subjectInput && lastDecrypted.subject) {
          subjectInput.value = lastDecrypted.subject.startsWith('Re: ') ? lastDecrypted.subject : `Re: ${lastDecrypted.subject}`;
        }

        // Enable send button
        const btnSendMsg = document.getElementById('btn-send-message');
        if (btnSendMsg) btnSendMsg.disabled = false;

        // Focus body
        document.getElementById('msg-body')?.focus();
      });
    } catch (err) {
      bodyDiv.innerHTML = `<div style="padding: 8px; color: var(--accent-red); font-size: 12px;">Decrypt failed: ${err.message}</div>`;
    }
  }

  async doSendMessage(member) {
    const btn = document.getElementById('btn-send-message');
    const recipientSelect = document.getElementById('msg-recipient');
    const subjectInput = document.getElementById('msg-subject');
    const bodyInput = document.getElementById('msg-body');
    const threadIdInput = document.getElementById('msg-thread-id');
    if (!recipientSelect.value || !subjectInput.value.trim()) return;

    const [recipientType, recipientVal] = recipientSelect.value.split(':');
    const params = {
      senderType: 'member',
      senderWalletId: member.walletId,
      recipientType,
      subject: subjectInput.value.trim(),
      body: bodyInput.value.trim() || subjectInput.value.trim(),
    };
    if (recipientType === 'prescriber' || recipientType === 'pharmacy') {
      params.recipientIndex = parseInt(recipientVal, 10);
    }
    // Include threadId if replying
    if (threadIdInput && threadIdInput.value) {
      params.threadId = threadIdInput.value;
    }

    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Encrypting + generating proof...');

    try {
      const res = await fetch(`${API_BASE}/interactive/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      const result = await res.json();

      const resultDiv = document.getElementById('send-message-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-card" style="margin-bottom: 12px;">
          <div class="result-title">Message Sent (Encrypted)</div>
          <div class="data-grid">
            <div class="label">To</div><div class="value">${result.to}</div>
            <div class="label">Subject</div><div class="value">${result.subject}</div>
            <div class="label">Encrypted</div><div class="value">${result.ciphertextLength} bytes (AES-256-GCM)</div>
            <div class="label">Content Hash</div><div class="value mono" style="font-size: 11px;">${result.contentHash}</div>
            <div class="label">Proof Time</div><div class="value">${(result.proofTimeMs / 1000).toFixed(2)}s</div>
            <div class="label">Thread</div><div class="value mono" style="font-size: 11px;">${result.threadId || 'new'}</div>
            <div class="label">Audit Hash</div><div class="value mono" style="font-size: 11px;">${result.auditChainHash ? result.auditChainHash.slice(0, 20) + '\u2026' : '\u2014'}</div>
          </div>
        </div>
      `;

      // Clear reply state
      if (threadIdInput) threadIdInput.value = '';
      const banner = document.getElementById('msg-reply-banner');
      if (banner) banner.classList.add('hidden');
      if (recipientSelect) recipientSelect.disabled = false;

      if (result.chainState) updateChainState(result.chainState);
      this.app.setStatus('ready', 'Message sent');
      setTimeout(() => { this.app.fetchState().then(() => this.render(this.app.state)); }, 1500);
    } catch (err) {
      const resultDiv = document.getElementById('send-message-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  async doCreateDelegation(member) {
    const btn = document.getElementById('btn-create-delegation');
    const delegateSelect = document.getElementById('delegate-select');
    if (!delegateSelect?.value) return;

    const scopeFlags = (document.getElementById('scope-read')?.checked ? 1 : 0) |
                       (document.getElementById('scope-write')?.checked ? 2 : 0) |
                       (document.getElementById('scope-pickup')?.checked ? 4 : 0);
    const relationshipCode = parseInt(document.getElementById('relationship-select')?.value || '1', 10);

    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Generating delegation proof...');

    try {
      const res = await fetch(`${API_BASE}/interactive/create-delegation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delegatorWalletId: member.walletId,
          delegateWalletId: delegateSelect.value,
          scopeFlags,
          relationshipCode,
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      const result = await res.json();

      const resultDiv = document.getElementById('delegation-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-card" style="margin-bottom: 12px;">
          <div class="result-title">Delegation Created</div>
          <div class="data-grid">
            <div class="label">Delegate</div><div class="value">${result.delegate}</div>
            <div class="label">Scope</div><div class="value">${result.scopeLabels.join(', ')}</div>
            <div class="label">Relationship</div><div class="value">${result.relationshipLabel}</div>
            <div class="label">Proof Time</div><div class="value">${(result.proofTimeMs / 1000).toFixed(2)}s</div>
          </div>
        </div>
      `;
      if (result.chainState) updateChainState(result.chainState);
      this.app.setStatus('ready', 'Delegation created');
      setTimeout(() => { this.app.fetchState().then(() => this.render(this.app.state)); }, 1500);
    } catch (err) {
      const resultDiv = document.getElementById('delegation-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  async doEnrollAnother(btn) {
    if (this.selectedMemberIndex === null) return;

    btn.classList.add('loading');
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Enrolling\u2026';
    this.app.setStatus('working', 'Generating proof\u2026');

    try {
      const kickoff = await fetch(`${API_BASE}/interactive/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIndex: this.selectedMemberIndex }),
      });

      if (!kickoff.ok) {
        const err = await kickoff.json();
        throw new Error(err.error || 'Enrollment failed to start');
      }

      const kickoffData = await kickoff.json();

      if (kickoffData.status === 'complete') {
        this._handleEnrollAnotherComplete(btn, kickoffData.result);
        return;
      }
      if (kickoffData.status === 'error') {
        throw new Error(kickoffData.error || 'Enrollment failed');
      }

      // Poll every 15 seconds
      this._pollEnrollAnotherStatus(btn, this.selectedMemberIndex);

    } catch (err) {
      const resultDiv = document.getElementById('enroll-another-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
      btn.classList.remove('loading');
      btn.querySelector('.btn-text').textContent = 'Enroll Member';
      btn.disabled = false;
    }
  }

  _pollEnrollAnotherStatus(btn, memberIndex) {
    const resultDiv = document.getElementById('enroll-another-result');
    let pollCount = 0;

    const poll = async () => {
      pollCount++;
      try {
        const res = await fetch(`${API_BASE}/interactive/enroll-status?memberIndex=${memberIndex}`);
        const data = await res.json();

        if (data.status === 'complete') {
          this._handleEnrollAnotherComplete(btn, data.result);
          return;
        }

        if (data.status === 'error') {
          throw new Error(data.error || 'Enrollment failed');
        }

        const elapsed = pollCount * 15;
        btn.querySelector('.btn-text').textContent = `Enrolling\u2026 ${elapsed}s`;
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-blue); padding: 12px;">Generating ZK proofs\u2026 (${elapsed}s elapsed, checking every 15s)</div>`;

        setTimeout(poll, 15_000);
      } catch (err) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
        this.app.setStatus('ready', 'Error');
        btn.classList.remove('loading');
        btn.querySelector('.btn-text').textContent = 'Enroll Member';
        btn.disabled = false;
      }
    };

    setTimeout(poll, 15_000);
  }

  _handleEnrollAnotherComplete(btn, result) {
    const resultDiv = document.getElementById('enroll-another-result');
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = `
      <div class="result-card" style="margin-top: 12px;">
        <div class="result-title">Enrollment Complete \u2014 ${result.displayName}</div>
        <div class="data-grid">
          <div class="label">Wallet ID</div><div class="value mono" style="font-size: 11px;">${result.walletIdDisplay || result.walletId}</div>
          <div class="label">Plan</div><div class="value">${result.planId}</div>
        </div>
      </div>
    `;

    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Enrolled';
    btn.disabled = true;
    btn.style.opacity = '0.7';

    if (result.chainState) updateChainState(result.chainState);
    this.app.setStatus('ready', 'Ready');

    // Refresh dashboard
    setTimeout(() => {
      this.app.fetchState().then(() => {
        this.render(this.app.state);
      });
    }, 1500);
  }

  renderL2Receipts(receipts) {
    if (!receipts || receipts.length === 0) return '';
    const rows = receipts.map(r => `
      <div class="rl">${r.type || 'transition'}</div>
      <div class="rv">${r.receiptId.slice(0, 20)}... (seq #${r.sequenceNumber})</div>
    `).join('');
    return `
      <div class="l2-receipt-card">
        <div class="receipt-title">L2 Receipts (${receipts.length})</div>
        <div class="receipt-grid">
          ${rows}
          <div class="rl">Status</div><div class="rv"><span class="l2-status-badge pending">pending</span></div>
        </div>
      </div>
    `;
  }
}

function formatDate(ccyymmdd) {
  if (!ccyymmdd || ccyymmdd.length !== 8) return ccyymmdd;
  return `${ccyymmdd.slice(4, 6)}/${ccyymmdd.slice(6, 8)}/${ccyymmdd.slice(0, 4)}`;
}

function pct(current, max) {
  if (max === 0) return 0;
  return Math.min(100, (current / max * 100)).toFixed(1);
}
