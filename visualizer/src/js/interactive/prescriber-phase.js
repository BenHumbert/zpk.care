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
 * Prescriber Phase — Prescriber dashboard UI.
 *
 * Sections:
 *   1. Select Prescriber (grid of 10 prescriber cards)
 *   PCP View (consent-verified, shown when prescriber is assigned PCP)
 *   Non-PCP notice (shown when prescriber is not PCP)
 *   2. Select Patient (dropdown of enrolled members)
 *   Patient Drug History (privacy-preserving, Poseidon hash proofs per Rx)
 *   3. Select Pharmacy (grid of 8 pharmacy cards)
 *   4. Formulary Browser (searchable table of 22 medications)
 *   5. Selected Medication (detail card)
 *   6. Write Prescription (form + button)
 *   + ZK Detail sections (Prescription Credential, Forest, Data, Status)
 *
 * Every value from the engine's state or an engine reply (a display name, a wallet ID, a family or thread ID, a
 * reason, an error) is escaped with escapeHtml (message-thread.js) before it is placed in the page: a member's name is
 * whatever its device registered, and this page holds the operator token (A-61).
 */

import {
  API_BASE, formatCents,
  updateChainState, renderCredentialCard, renderForestCard, renderZkDataSection,
} from '../interactive-app.js';
import {
  renderSectionCard, renderMetricRow, renderSortableTable,
  truncHash,
} from '../node-common.js';
import { loadInteractiveState } from './state-client.js';
import { nadacPerUnitLabel, parseQuantity } from './nadac-price.js';
import { escapeHtml, renderMessageBubbles } from './message-thread.js';

export class PrescriberPhase {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('tab-prescriber');
    this.selectedPrescriber = null;
    this.selectedPharmacy = null;
    this.selectedMedication = null;
    this.prescriptionResult = null;
    this.currentState = null;
  }

  render(state) {
    this.currentState = state;
    const enrolled = state.enrolledMembers;
    if (!enrolled || enrolled.length === 0) {
      this.container.innerHTML = `
        <div class="waiting-message">
          <p>No enrolled members yet. Use the <strong>Member</strong> tab to enroll a patient first.</p>
        </div>
      `;
      return;
    }

    const activeMembers = enrolled.filter(m => m.lifecycle !== 'REVOKED');
    if (activeMembers.length === 0) {
      this.container.innerHTML = `
        <div class="waiting-message">
          <p>All enrolled members have been terminated. Use the <strong>Member</strong> tab to enroll a new patient.</p>
        </div>
      `;
      return;
    }

    const allPrescribers = state.demoData.prescribers;
    const allPharmacies = state.demoData.pharmacies;
    const medications = state.demoData.medications;

    // Determine PCP info and in-network providers from enrolled members
    this.pcpPrescriberIndex = null;
    this.pcpMemberWalletId = null;
    let inNetworkPrescriberSet = new Set();
    let inNetworkPharmacySet = new Set();
    for (const m of enrolled) {
      if (m.pcpAssignment) {
        this.pcpPrescriberIndex = m.pcpAssignment.prescriberIndex;
        this.pcpMemberWalletId = m.walletId;
      }
      if (m.inNetworkPrescribers) {
        m.inNetworkPrescribers.forEach(i => inNetworkPrescriberSet.add(i));
      }
      if (m.inNetworkPharmacies) {
        m.inNetworkPharmacies.forEach(i => inNetworkPharmacySet.add(i));
      }
    }

    // Filter to in-network only (fall back to all if no network data)
    const hasPrescriberNetwork = inNetworkPrescriberSet.size > 0;
    const hasPharmacyNetwork = inNetworkPharmacySet.size > 0;
    const prescribers = hasPrescriberNetwork
      ? allPrescribers.filter(p => inNetworkPrescriberSet.has(p.index))
      : allPrescribers;
    const pharmacies = hasPharmacyNetwork
      ? allPharmacies.filter(p => inNetworkPharmacySet.has(p.index))
      : allPharmacies;

    this.container.innerHTML = `
      <!-- Section 1: Select Prescriber -->
      <div class="section-card">
        <div class="card-header prescriber">Select Prescriber ${hasPrescriberNetwork ? `<span style="font-weight: 400; font-size: 12px; opacity: 0.7;">(${prescribers.length} in-network)</span>` : ''}</div>
        <div class="card-body">
          <div class="entity-grid" id="prescriber-grid">
            ${prescribers.map(p => {
              const isPcp = p.index === this.pcpPrescriberIndex;
              return `
                <div class="entity-card ${isPcp ? 'pcp-assigned' : ''}" data-index="${p.index}">
                  ${isPcp ? '<span class="pcp-verified-badge">PCP</span>' : ''}
                  ${hasPrescriberNetwork ? '<span class="network-badge">In-Network</span>' : ''}
                  <div class="entity-name" style="color: var(--color-prescriber);">Dr. ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}, ${escapeHtml(p.credential)}</div>
                  <div class="entity-detail">${escapeHtml(p.specialty)}</div>
                  <div class="entity-detail">NPI: ${escapeHtml(p.npi)} | ${escapeHtml(p.state)}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>

      <!-- PCP View (shown when selected prescriber is assigned PCP) -->
      <div id="pcp-view-section" class="section-card hidden">
        <div class="card-header pcp">PCP View — Member Data (Consent-Verified)</div>
        <div class="card-body" id="pcp-view-body">
          <div style="text-align: center; color: var(--text-muted); padding: 20px;">Loading member data...</div>
        </div>
      </div>

      <!-- Non-PCP notice -->
      <div id="non-pcp-notice" class="section-card hidden">
        <div class="card-body" style="text-align: center; color: var(--text-muted); padding: 16px; font-size: 13px;">
          This prescriber is not the patient's assigned PCP. Limited access — no medical history view.
        </div>
      </div>

      <!-- Section 2: Select Patient -->
      <div class="section-card">
        <div class="card-header member">Select Patient</div>
        <div class="card-body">
          <div class="form-group">
            <select id="patient-select">
              <option value="">— Choose enrolled member —</option>
              ${this.buildPatientOptions(enrolled)}
            </select>
          </div>
        </div>
      </div>

      <!-- Patient Drug History (privacy-preserving, no PHI/PII) -->
      <div id="drug-history-section" class="section-card hidden">
        <div class="card-header member">Patient Drug History <span style="font-weight: 400; font-size: 12px; opacity: 0.7;">(Zero-Knowledge Verified)</span></div>
        <div class="card-body" id="drug-history-body">
          <div style="text-align: center; color: var(--text-muted); padding: 20px;">Loading drug history...</div>
        </div>
      </div>

      <!-- Family Drug History (shown when patient has family members) -->
      <div id="family-history-section" class="section-card hidden">
        <div class="card-header member">Family Drug History <span style="font-weight: 400; font-size: 12px; opacity: 0.7;">(All Family Members)</span></div>
        <div class="card-body" id="family-history-body">
          <div style="text-align: center; color: var(--text-muted); padding: 20px;">Loading family history...</div>
        </div>
      </div>

      <!-- Section 3: Select Pharmacy -->
      <div class="section-card">
        <div class="card-header pharmacy">Select Pharmacy ${hasPharmacyNetwork ? `<span style="font-weight: 400; font-size: 12px; opacity: 0.7;">(${pharmacies.length} in-network)</span>` : ''}</div>
        <div class="card-body">
          <div class="entity-grid" id="pharmacy-grid">
            ${pharmacies.map(p => `
              <div class="entity-card" data-index="${p.index}">
                ${hasPharmacyNetwork ? '<span class="network-badge">In-Network</span>' : ''}
                <div class="entity-name" style="color: var(--color-pharmacy);">${escapeHtml(p.storeName)}</div>
                <div class="entity-detail">${escapeHtml(p.pharmacyType)}</div>
                <div class="entity-detail">${escapeHtml(p.city)}, ${escapeHtml(p.state)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Section 4: Formulary Browser -->
      <div class="section-card">
        <div class="card-header insurer">Formulary Browser</div>
        <div class="card-body">
          <div class="form-group" style="margin-bottom: 12px;">
            <input type="text" id="med-search" placeholder="Search medications..." />
          </div>
          <div style="max-height: 400px; overflow-y: auto;">
            <table class="med-table">
              <thead>
                <tr>
                  <th>Drug Name</th>
                  <th>Strength</th>
                  <th>Tier</th>
                  <th>Copay</th>
                  <th>PA?</th>
                  <th>Max Qty</th>
                </tr>
              </thead>
              <tbody id="med-table-body">
                ${medications.map((m, i) => {
                  const tier = m.currentTierLevel ?? m.tier;
                  const copay = m.currentCopayAmountCents ?? m.copayAmountCents;
                  const pa = m.currentRequiresPriorAuth ?? m.requiresPriorAuth;
                  const step = m.currentStepTherapyRequired ?? m.stepTherapyRequired;
                  const active = m.active !== false;
                  const paClass = pa ? ' pa-required-row' : '';
                  const removedClass = !active ? ' formulary-removed' : '';
                  const paBadge = pa
                    ? '<span class="pa-badge pa-required">PA</span>'
                    : '<span style="color: var(--text-muted);">No</span>';
                  const badges = [];
                  if (!active) badges.push('<span class="removed-badge">Removed</span>');
                  if (step) badges.push('<span class="step-therapy-badge">Step</span>');
                  if (m.deaSchedule > 0) badges.push(`<span class="dea-badge dea-schedule-${m.deaSchedule}">C${m.deaSchedule}</span>`);
                  return `
                  <tr data-index="${i}" class="${paClass}${removedClass}">
                    <td>${escapeHtml(m.brandName)}${badges.length ? ' ' + badges.join(' ') : ''}</td>
                    <td>${escapeHtml(m.strength)}</td>
                    <td><span class="tier-badge tier-${tier}">Tier ${tier}</span></td>
                    <td>${formatCents(copay)}</td>
                    <td>${paBadge}</td>
                    <td>${m.maxQuantityPerFill}</td>
                  </tr>
                `;}).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Section 5: Selected Medication Detail -->
      <div id="med-detail" class="section-card hidden">
        <div class="card-header insurer">Selected Medication</div>
        <div class="card-body" id="med-detail-body"></div>
      </div>

      <!-- Section 6: Write Prescription -->
      <div id="section-write-rx" class="section-card hidden">
        <div class="card-header prescriber">Write Prescription</div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label>Quantity <span id="rx-quantity-unit">(pricing unit)</span></label>
              <input type="number" id="rx-quantity" value="30" min="0.001" step="0.001" />
            </div>
            <div class="form-group">
              <label>Refills Authorized</label>
              <input type="number" id="rx-refills" value="3" min="0" max="99" />
            </div>
          </div>
          <button id="btn-write-rx" class="btn-action prescriber" disabled>
            <span class="spinner"></span>
            Write eScript
          </button>
          <div id="rx-result" class="hidden"></div>
        </div>
      </div>

      <!-- Section 7: Messages -->
      ${this.renderPrescriberMessages(state)}

      <!-- Section 8: Prescribing History -->
      ${this.renderPrescribingHistory(state)}

      <!-- Section 9: Activity Summary -->
      ${this.renderPrescriberActivity(state)}

      <!-- Section 10: PCP Patients -->
      ${this.renderPcpPatients(state)}

      <!-- Section 11-13: Breakdowns -->
      ${this.renderPatientBreakdown(state)}
      ${this.renderMedicationBreakdown(state)}
      ${this.renderPharmacyBreakdown(state)}

      <!-- Section 14: Prior Auth Requests -->
      ${this.renderPriorAuthRequests(state)}

      <!-- Section 15: Node Info -->
      ${this.renderPrescriberNodeInfo()}
    `;

    this.bindEvents(state);
    this.loadPrescriberNodeInfo();
  }

  bindEvents(state) {
    const medications = state.demoData.medications;

    // Prescriber grid
    document.getElementById('prescriber-grid').addEventListener('click', (e) => {
      const card = e.target.closest('.entity-card');
      if (!card) return;
      document.querySelectorAll('#prescriber-grid .entity-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      this.selectedPrescriber = parseInt(card.dataset.index, 10);
      this.updateWriteButton();
      this.updatePcpView();
    });

    // Pharmacy grid
    document.getElementById('pharmacy-grid').addEventListener('click', (e) => {
      const card = e.target.closest('.entity-card');
      if (!card) return;
      document.querySelectorAll('#pharmacy-grid .entity-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      this.selectedPharmacy = parseInt(card.dataset.index, 10);
      this.updateWriteButton();
    });

    // Medication table
    document.getElementById('med-table-body').addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      if (!row) return;
      document.querySelectorAll('#med-table-body tr').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      this.selectedMedication = parseInt(row.dataset.index, 10);
      this.showMedDetail(medications[this.selectedMedication]);
      this.updateWriteButton();
    });

    // Med search
    document.getElementById('med-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('#med-table-body tr').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
      });
    });

    // Patient select — refresh PA status when patient changes
    document.getElementById('patient-select').addEventListener('change', () => {
      this.updateWriteButton();
      this.loadDrugHistory();
      // Refresh med detail to show PA status for new patient
      if (this.selectedMedication !== null && medications[this.selectedMedication]) {
        this.showMedDetail(medications[this.selectedMedication]);
      }
    });

    // Write button
    document.getElementById('btn-write-rx').addEventListener('click', () => this.doWriteRx());

    // Messaging
    const msgRecipient = document.getElementById('prescriber-msg-recipient');
    const msgSubject = document.getElementById('prescriber-msg-subject');
    const btnSendMsg = document.getElementById('btn-prescriber-send-msg');
    if (msgRecipient && btnSendMsg) {
      const enableSend = () => {
        btnSendMsg.disabled = !msgRecipient.value || !msgSubject?.value?.trim();
      };
      msgRecipient.addEventListener('change', enableSend);
      if (msgSubject) msgSubject.addEventListener('input', enableSend);
      btnSendMsg.addEventListener('click', () => this.doSendPrescriberMessage());
    }
    // Cancel reply
    const btnCancelReply = document.getElementById('prescriber-cancel-reply');
    if (btnCancelReply) {
      btnCancelReply.addEventListener('click', () => {
        document.getElementById('prescriber-msg-thread-id').value = '';
        document.getElementById('prescriber-reply-banner').classList.add('hidden');
        if (msgSubject) msgSubject.value = '';
        if (msgRecipient) { msgRecipient.value = ''; msgRecipient.disabled = false; }
      });
    }
    // Thread click handlers
    document.querySelectorAll('.prescriber-thread-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.msg-reply-btn')) return;
        this.doExpandPrescriberThread(el);
      });
    });
  }

  buildPatientOptions(enrolled) {
    // Group by familyId, filtering out terminated members
    const families = new Map();
    for (const m of enrolled) {
      if (m.lifecycle === 'REVOKED') continue;
      const fam = m.familyId || 'INDIVIDUAL';
      if (!families.has(fam)) families.set(fam, []);
      families.get(fam).push(m);
    }

    if (families.size === 0) {
      return '<option value="" disabled>No active members available</option>';
    }

    let html = '';
    for (const [familyId, members] of families) {
      if (members.length > 1) {
        // Family group header
        html += `<optgroup label="${escapeHtml(familyId)} (${members.length} members)">`;
        for (const m of members) {
          const badge = m.relationship || '';
          html += `<option value="${escapeHtml(m.walletId)}">${escapeHtml(m.displayName)} [${escapeHtml(badge)}] (${escapeHtml(m.walletIdDisplay || m.walletId)})</option>`;
        }
        html += `</optgroup>`;
      } else {
        const m = members[0];
        html += `<option value="${escapeHtml(m.walletId)}">${escapeHtml(m.displayName)} (${escapeHtml(m.walletIdDisplay || m.walletId)})</option>`;
      }
    }
    return html;
  }

  showMedDetail(med) {
    const detail = document.getElementById('med-detail');
    detail.classList.remove('hidden');

    // Dynamic values (may differ from base if formulary was updated)
    const tier = med.currentTierLevel ?? med.tier;
    const copay = med.currentCopayAmountCents ?? med.copayAmountCents;
    const requiresPa = med.currentRequiresPriorAuth ?? med.requiresPriorAuth;
    const stepReq = med.currentStepTherapyRequired ?? med.stepTherapyRequired;
    const isActive = med.active !== false;

    // Determine PA status for the selected patient + medication
    const patientWalletId = document.getElementById('patient-select').value;
    const paStatus = this.getPaStatus(med.index, patientWalletId);

    let paDisplay;
    if (!requiresPa) {
      paDisplay = '<span style="color: var(--accent-green);">Not Required</span>';
    } else if (paStatus === 'APPROVED') {
      paDisplay = '<span class="pa-badge pa-approved">PA Approved</span>';
    } else if (paStatus === 'PENDING') {
      paDisplay = '<span class="pa-badge pa-pending">PA Pending</span>';
    } else if (paStatus === 'DENIED') {
      paDisplay = '<span class="pa-badge pa-denied">PA Denied</span>';
    } else {
      paDisplay = '<span class="pa-badge pa-required">PA Required</span>';
    }

    // Step therapy display
    const stepDisplay = stepReq
      ? '<span class="step-therapy-badge">Step Therapy Required</span>'
      : '<span style="color: var(--accent-green);">Not Required</span>';

    // DEA display
    const deaDisplay = med.deaSchedule === 0
      ? 'Non-controlled'
      : `<span class="dea-badge dea-schedule-${med.deaSchedule}">Schedule ${med.deaSchedule}</span>`;

    // Removed medication notice
    const removedNotice = !isActive ? `
      <div class="dea-warning-box" style="border-color: rgba(244, 67, 54, 0.3); margin-bottom: 12px;">
        This medication has been removed from the formulary and cannot be prescribed.
      </div>` : '';

    // PA action section
    let paAction = '';
    if (requiresPa && patientWalletId) {
      if (paStatus === 'APPROVED') {
        paAction = `
          <div class="pa-status-box pa-status-approved">
            Prior authorization approved. You may write a prescription for this medication.
          </div>`;
      } else if (paStatus === 'PENDING') {
        paAction = `
          <div class="pa-status-box pa-status-pending">
            Prior authorization pending — awaiting insurer review on the <strong>Insurer</strong> tab.
          </div>`;
      } else if (paStatus === 'DENIED') {
        paAction = `
          <div class="pa-status-box pa-status-denied">
            Prior authorization was denied. Contact the insurer or select a different medication.
          </div>`;
      } else {
        paAction = `
          <div class="pa-status-box pa-status-required">
            <div>This medication requires prior authorization before it can be prescribed.</div>
            <button id="btn-request-pa" class="btn-action insurer" style="margin-top: 8px; font-size: 12px; padding: 6px 16px;">
              <span class="spinner"></span>
              Request Prior Authorization
            </button>
          </div>`;
      }
    } else if (requiresPa && !patientWalletId) {
      paAction = `
        <div class="pa-status-box pa-status-required">
          Select a patient above to check PA status or request prior authorization.
        </div>`;
    }

    // Step therapy status section
    let stepTherapySection = '';
    if (stepReq && patientWalletId) {
      stepTherapySection = `<div id="step-therapy-status">
        <div style="color: var(--text-muted); font-size: 12px;">Checking step therapy prerequisites...</div>
      </div>`;
    } else if (stepReq && !patientWalletId) {
      stepTherapySection = `<div class="step-therapy-box step-therapy-not-met">
        Select a patient above to check step therapy prerequisites.
      </div>`;
    }

    // DEA warning section
    let deaWarningSection = '';
    if (med.deaSchedule >= 2) {
      deaWarningSection = `<div class="dea-warning-box">
        <strong>Schedule ${med.deaSchedule} controlled substance</strong> — DEA number required for prescribing.
        ${med.deaSchedule === 2 ? '<br>No refills permitted per federal law.' : ''}
      </div>`;
    }

    document.getElementById('med-detail-body').innerHTML = `
      ${removedNotice}
      <div class="data-grid">
        <div class="label">Brand Name</div><div class="value">${escapeHtml(med.brandName)}</div>
        <div class="label">Generic Name</div><div class="value">${escapeHtml(med.genericName)}</div>
        <div class="label">Strength</div><div class="value">${escapeHtml(med.strength)}</div>
        <div class="label">Dosage Form</div><div class="value">${escapeHtml(med.dosageForm)}</div>
        <div class="label">Route</div><div class="value">${escapeHtml(med.route)}</div>
        <div class="label">NDC</div><div class="value mono">${escapeHtml(med.ndc)}</div>
        <div class="label">Tier</div><div class="value"><span class="tier-badge tier-${tier}">Tier ${tier}</span></div>
        <div class="label">Copay</div><div class="value">${formatCents(copay)}</div>
        <div class="label">Prior Auth</div><div class="value">${paDisplay}</div>
        <div class="label">Step Therapy</div><div class="value">${stepDisplay}</div>
        <div class="label">Max Qty/Fill</div><div class="value">${med.maxQuantityPerFill}</div>
        <div class="label">Max Day Supply</div><div class="value">${med.maxDaySupply}</div>
        <div class="label">NADAC Unit Price</div><div class="value">${nadacPerUnitLabel(med)}</div>
        <div class="label">Manufacturer</div><div class="value">${escapeHtml(med.manufacturer)}</div>
        <div class="label">Therapeutic Class</div><div class="value">${escapeHtml(med.therapeuticClass)}</div>
        <div class="label">DEA Schedule</div><div class="value">${deaDisplay}</div>
      </div>
      ${paAction}
      ${stepTherapySection}
      ${deaWarningSection}
    `;

    // Bind PA request button
    const paBtn = document.getElementById('btn-request-pa');
    if (paBtn) {
      paBtn.addEventListener('click', () => this.doRequestPa(med));
    }

    // Async step therapy check
    if (stepReq && patientWalletId) {
      this.checkStepTherapyStatus(med.index, patientWalletId);
    }

    // Update quantity default from medication, in its NADAC pricing unit (EA, ML or GM): a 0.4 ML pen is 0.4
    document.getElementById('rx-quantity').value = med.maxQuantityPerFill;
    const quantityUnit = document.getElementById('rx-quantity-unit');
    if (quantityUnit) quantityUnit.textContent = med.pricingUnit ? `(${med.pricingUnit})` : '(pricing unit)';

    // DEA Schedule II: force refills to 0
    if (med.deaSchedule === 2) {
      document.getElementById('rx-refills').value = 0;
      document.getElementById('rx-refills').disabled = true;
    } else {
      document.getElementById('rx-refills').disabled = false;
    }

    // Show write section
    document.getElementById('section-write-rx').classList.remove('hidden');
    this.updateWriteButton();
  }

  /**
   * Async step therapy check — fetches prerequisite status from server.
   */
  async checkStepTherapyStatus(medicationIndex, memberWalletId) {
    const container = document.getElementById('step-therapy-status');
    if (!container) return;

    try {
      const res = await fetch(
        `${API_BASE}/interactive/step-therapy-check?memberWalletId=${encodeURIComponent(memberWalletId)}&medicationIndex=${medicationIndex}`
      );
      if (!res.ok) throw new Error('Check failed');
      const result = await res.json();

      if (result.allowed) {
        container.innerHTML = `<div class="step-therapy-box step-therapy-met">
          Step therapy satisfied${result.message ? ' — ' + escapeHtml(result.message) : ''}.
        </div>`;
      } else {
        const prereqs = result.prerequisiteMeds?.length
          ? result.prerequisiteMeds.join(', ')
          : result.prerequisiteClass || 'prerequisite medication';
        container.innerHTML = `<div class="step-therapy-box step-therapy-not-met">
          <strong>Step therapy not met.</strong> ${escapeHtml(result.message || '')}<br>
          <span style="font-size: 12px;">Required prerequisite: ${escapeHtml(prereqs)}</span>
        </div>`;
      }
    } catch {
      container.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">Unable to check step therapy status.</div>`;
    }
  }

  /**
   * Get PA status for a medication+patient combination from current state.
   * Returns 'APPROVED', 'PENDING', 'DENIED', or null (no PA exists).
   */
  getPaStatus(medicationIndex, patientWalletId) {
    if (!this.currentState?.priorAuths || !patientWalletId) return null;
    // Find the most recent PA for this member+medication
    const matches = this.currentState.priorAuths.filter(
      pa => pa.memberWalletId === patientWalletId && pa.medicationIndex === medicationIndex
    );
    if (matches.length === 0) return null;
    // Prefer APPROVED > PENDING > DENIED
    const approved = matches.find(pa => pa.status === 'APPROVED');
    if (approved) return 'APPROVED';
    const pending = matches.find(pa => pa.status === 'PENDING');
    if (pending) return 'PENDING';
    return matches[matches.length - 1].status;
  }

  /**
   * Request prior authorization for the selected medication.
   */
  async doRequestPa(med) {
    const patientWalletId = document.getElementById('patient-select').value;
    if (!patientWalletId || this.selectedPrescriber === null) return;

    const btn = document.getElementById('btn-request-pa');
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }

    try {
      const res = await fetch(`${API_BASE}/interactive/request-prior-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberWalletId: patientWalletId,
          prescriberIndex: this.selectedPrescriber,
          medicationIndex: med.index,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'PA request failed');
      }

      // Refresh state and re-render the med detail
      const fresh = await loadInteractiveState(API_BASE);
      if (fresh) {
        this.currentState = fresh;
      }
      this.showMedDetail(med);
      this.updateWriteButton();

    } catch (err) {
      const paBox = document.querySelector('.pa-status-box');
      if (paBox) {
        paBox.innerHTML = `<div style="color: var(--accent-red);">Error: ${escapeHtml(err.message)}</div>`;
      }
      if (btn) btn.disabled = false;
    } finally {
      if (btn) btn.classList.remove('loading');
    }
  }

  updateWriteButton() {
    const btn = document.getElementById('btn-write-rx');
    if (!btn) return;
    const patient = document.getElementById('patient-select').value;
    const allSelected = this.selectedPrescriber !== null &&
      this.selectedPharmacy !== null &&
      this.selectedMedication !== null &&
      patient;

    if (!allSelected) {
      btn.disabled = true;
      btn.title = '';
      return;
    }

    const med = this.currentState?.demoData?.medications?.[this.selectedMedication];

    // Check if medication is removed from formulary
    if (med?.active === false) {
      btn.disabled = true;
      btn.title = 'This medication has been removed from the formulary';
      return;
    }

    // Check PA requirement (use dynamic value)
    const requiresPa = med?.currentRequiresPriorAuth ?? med?.requiresPriorAuth;
    if (requiresPa) {
      const paStatus = this.getPaStatus(this.selectedMedication, patient);
      if (paStatus !== 'APPROVED') {
        btn.disabled = true;
        btn.title = 'Prior authorization required — request PA below the medication detail';
        return;
      }
    }

    btn.disabled = false;
    btn.title = '';
  }

  async updatePcpView() {
    const pcpSection = document.getElementById('pcp-view-section');
    const nonPcpNotice = document.getElementById('non-pcp-notice');

    if (this.selectedPrescriber === this.pcpPrescriberIndex && this.pcpMemberWalletId) {
      // This IS the PCP — show member history
      pcpSection.classList.remove('hidden');
      nonPcpNotice.classList.add('hidden');

      try {
        const res = await fetch(`${API_BASE}/interactive/member-history?walletId=${encodeURIComponent(this.pcpMemberWalletId)}`);
        if (!res.ok) throw new Error('Failed to fetch history');
        const history = await res.json();

        const body = document.getElementById('pcp-view-body');
        const deductPct = history.accumulator.deductibleAmountCents > 0
          ? (history.accumulator.deductiblePaidCents / history.accumulator.deductibleAmountCents * 100).toFixed(1)
          : '0';
        const oopPct = history.accumulator.oopMaxCents > 0
          ? (history.accumulator.oopPaidCents / history.accumulator.oopMaxCents * 100).toFixed(1)
          : '0';

        let rxRows = '';
        if (history.prescriptionHistory.length === 0) {
          rxRows = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No prescriptions yet</td></tr>';
        } else {
          rxRows = history.prescriptionHistory.map(rx => `
            <tr>
              <td>${escapeHtml(rx.medication)}</td>
              <td>${escapeHtml(rx.strength)}</td>
              <td>${escapeHtml(rx.prescriber)}</td>
              <td>${escapeHtml(rx.pharmacy)}</td>
              <td><span class="tier-badge tier-${rx.tier}">Tier ${rx.tier}</span></td>
              <td style="color: ${rx.status === 'FILLED' ? 'var(--accent-green)' : 'var(--accent-blue)'};">${escapeHtml(rx.status)}</td>
            </tr>
          `).join('');
        }

        body.innerHTML = `
          <div style="font-size: 11px; color: var(--accent-green); margin-bottom: 12px;">
            Data access authorized by PCP assignment ZK proof (consent scope: Rx History + Eligibility + Accumulators)
          </div>

          <!-- Eligibility -->
          <div style="margin-bottom: 16px;">
            <div style="font-weight: 600; font-size: 13px; color: var(--color-member); margin-bottom: 8px;">Eligibility</div>
            <div class="data-grid">
              <div class="label">Plan</div><div class="value">${escapeHtml(history.eligibility.planId)}</div>
              <div class="label">Status</div><div class="value" style="color: var(--accent-green);">${escapeHtml(history.eligibility.coverageStatus)}</div>
              <div class="label">Formulary</div><div class="value">${history.eligibility.formularyCount} medications</div>
            </div>
          </div>

          <!-- Accumulators -->
          <div style="margin-bottom: 16px;">
            <div style="font-weight: 600; font-size: 13px; color: var(--color-member); margin-bottom: 8px;">Accumulators</div>
            <div class="progress-container">
              <div class="progress-label">
                <span>Deductible</span>
                <span>${formatCents(history.accumulator.deductiblePaidCents)} / ${formatCents(history.accumulator.deductibleAmountCents)} (${deductPct}%)</span>
              </div>
              <div class="progress-bar"><div class="fill deductible" style="width: ${deductPct}%"></div></div>
            </div>
            <div class="progress-container">
              <div class="progress-label">
                <span>Out-of-Pocket Maximum</span>
                <span>${formatCents(history.accumulator.oopPaidCents)} / ${formatCents(history.accumulator.oopMaxCents)} (${oopPct}%)</span>
              </div>
              <div class="progress-bar"><div class="fill oop" style="width: ${oopPct}%"></div></div>
            </div>
          </div>

          <!-- Prescription History -->
          <div>
            <div style="font-weight: 600; font-size: 13px; color: var(--color-member); margin-bottom: 8px;">Prescription History</div>
            <table class="history-table">
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Strength</th>
                  <th>Prescriber</th>
                  <th>Pharmacy</th>
                  <th>Tier</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>${rxRows}</tbody>
            </table>
          </div>
        `;
      } catch (err) {
        document.getElementById('pcp-view-body').innerHTML = `
          <div style="color: var(--accent-red); padding: 8px;">Failed to load member data: ${escapeHtml(err.message)}</div>
        `;
      }
    } else if (this.pcpPrescriberIndex !== null) {
      // A PCP is assigned but this isn't them
      pcpSection.classList.add('hidden');
      nonPcpNotice.classList.remove('hidden');
    } else {
      // No PCP assigned at all
      pcpSection.classList.add('hidden');
      nonPcpNotice.classList.add('hidden');
    }
  }

  async loadDrugHistory() {
    const section = document.getElementById('drug-history-section');
    const body = document.getElementById('drug-history-body');
    const familySection = document.getElementById('family-history-section');
    const familyBody = document.getElementById('family-history-body');
    const walletId = document.getElementById('patient-select').value;

    if (!walletId) {
      section.classList.add('hidden');
      if (familySection) familySection.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    body.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">Loading drug history...</div>';

    // Also load family history
    this.loadFamilyHistory(walletId, familySection, familyBody);

    try {
      const res = await fetch(`${API_BASE}/interactive/member-history?walletId=${encodeURIComponent(walletId)}`);
      if (!res.ok) throw new Error('Failed to fetch history');
      const history = await res.json();

      if (history.prescriptionHistory.length === 0) {
        body.innerHTML = `
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
            No PHI or PII is revealed. Only Poseidon hash commitments and medication identifiers are shown.
          </div>
          <div style="text-align: center; color: var(--text-muted); padding: 24px; font-size: 13px;">
            No prescription history for this patient.
          </div>
        `;
        return;
      }

      const rows = history.prescriptionHistory.map(rx => `
        <tr class="drug-history-row">
          <td>
            <div style="font-weight: 600;">${escapeHtml(rx.medication)}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(rx.strength)}</div>
          </td>
          <td><span class="tier-badge tier-${rx.tier}">Tier ${rx.tier}</span></td>
          <td style="font-size: 12px;">Qty ${rx.quantity} / ${rx.refills} refills</td>
          <td><span class="rx-status-badge rx-status-${escapeHtml(rx.status.toLowerCase().replace('_', '-'))}">${escapeHtml(rx.status.replace('_', ' '))}</span></td>
          <td class="hash-proof-cell">
            <div class="hash-proof" title="PrescriptionData commitment — Poseidon.hash(7 fields)">
              <span class="hash-label">Rx</span>
              <span class="hash-value">${truncHash(rx.rxCommitment)}</span>
            </div>
            <div class="hash-proof" title="PrescriptionStatusData commitment — Poseidon.hash(7 fields)">
              <span class="hash-label">Status</span>
              <span class="hash-value">${truncHash(rx.statusCommitment)}</span>
            </div>
            ${rx.settlementCommitment ? `
              <div class="hash-proof" title="Settlement commitment — Poseidon.hash(fulfillment, patientPay, planPay)">
                <span class="hash-label">Settle</span>
                <span class="hash-value">${truncHash(rx.settlementCommitment)}</span>
              </div>
            ` : ''}
          </td>
        </tr>
        <tr class="drug-history-detail">
          <td colspan="5">
            <div class="hash-detail-row">
              <span class="hash-detail-label">NDC Hash</span>
              <span class="hash-detail-value">${truncHash(rx.ndcHash)}</span>
              <span class="hash-detail-label" style="margin-left: 16px;">Prescriber</span>
              <span class="hash-detail-value">${escapeHtml(rx.prescriberWalletId)}</span>
              <span class="hash-detail-label" style="margin-left: 16px;">Pharmacy</span>
              <span class="hash-detail-value">${escapeHtml(rx.pharmacyWalletId)}</span>
            </div>
          </td>
        </tr>
      `).join('');

      body.innerHTML = `
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          No PHI or PII is revealed. Only Poseidon hash commitments and medication identifiers are shown.
          Each hash is a cryptographic proof binding the prescription to its on-chain state.
        </div>
        <table class="drug-history-table">
          <thead>
            <tr>
              <th>Medication</th>
              <th>Tier</th>
              <th>Quantity</th>
              <th>Status</th>
              <th>Poseidon Hash Proofs</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top: 12px; padding: 10px 12px; background: rgba(79, 195, 247, 0.06); border-radius: 6px; border: 1px solid rgba(79, 195, 247, 0.15);">
          <div style="font-size: 11px; color: var(--text-secondary);">
            <strong style="color: var(--accent-blue);">How to verify:</strong>
            Each hash is Poseidon.hash(private fields). The ZK circuit proves the preimage exists
            without revealing it. Patient identity, prescriber identity, and pharmacy identity
            are represented only as opaque wallet IDs (Poseidon hashes of credentials + enrollment key).
          </div>
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Failed to load drug history: ${escapeHtml(err.message)}</div>`;
    }
  }

  async loadFamilyHistory(walletId, section, body) {
    if (!section || !body) return;

    try {
      const res = await fetch(`${API_BASE}/interactive/family-history?walletId=${encodeURIComponent(walletId)}`);
      if (!res.ok) {
        section.classList.add('hidden');
        return;
      }
      const fam = await res.json();

      if (!fam.members || fam.members.length <= 1) {
        section.classList.add('hidden');
        return;
      }

      section.classList.remove('hidden');

      // Family accumulator summary
      const famAccum = fam.familyAccumulator;
      const famDeductPct = famAccum.limits.familyDeductibleAmountCents > 0
        ? (famAccum.totalDeductiblePaidCents / famAccum.limits.familyDeductibleAmountCents * 100).toFixed(1) : '0';
      const famOopPct = famAccum.limits.familyOopMaxCents > 0
        ? (famAccum.totalOopPaidCents / famAccum.limits.familyOopMaxCents * 100).toFixed(1) : '0';

      // All family members' Rx rows
      let allRxRows = '';
      for (const member of fam.members) {
        for (const rx of member.prescriptionHistory) {
          allRxRows += `
            <tr>
              <td><span class="family-badge ${escapeHtml((member.relationship || 'self').toLowerCase())}">${escapeHtml(member.relationship || 'SELF')}</span> ${escapeHtml(member.name)}</td>
              <td>${escapeHtml(rx.medication)} ${escapeHtml(rx.strength)}</td>
              <td><span class="tier-badge tier-${rx.tier}">Tier ${rx.tier}</span></td>
              <td style="color: ${rx.status === 'FILLED' ? 'var(--accent-green)' : 'var(--accent-blue)'};">${escapeHtml(rx.status)}</td>
              <td>${rx.fill ? formatCents(rx.fill.patientPayCents) : '—'}</td>
            </tr>
          `;
        }
      }

      if (!allRxRows) {
        allRxRows = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No prescriptions yet for any family member</td></tr>';
      }

      body.innerHTML = `
        <div style="margin-bottom: 12px;">
          <div class="family-group-header">${escapeHtml(fam.familyId)} — ${fam.members.length} Members</div>
          <div class="family-member-cards" style="margin-top: 8px;">
            ${fam.members.map(m => `
              <div class="family-member-card">
                <div class="family-member-name">${escapeHtml(m.name)}</div>
                <div class="family-member-detail">
                  <span class="family-badge ${escapeHtml((m.relationship || 'self').toLowerCase())}">${escapeHtml(m.relationship || 'SELF')}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="family-accumulator-bar">
          <div class="progress-container">
            <div class="progress-label">
              <span>Family Deductible</span>
              <span>${formatCents(famAccum.totalDeductiblePaidCents)} / ${formatCents(famAccum.limits.familyDeductibleAmountCents)} (${famDeductPct}%)</span>
            </div>
            <div class="progress-bar"><div class="fill deductible" style="width: ${famDeductPct}%"></div></div>
          </div>
          <div class="progress-container">
            <div class="progress-label">
              <span>Family Out-of-Pocket Max</span>
              <span>${formatCents(famAccum.totalOopPaidCents)} / ${formatCents(famAccum.limits.familyOopMaxCents)} (${famOopPct}%)</span>
            </div>
            <div class="progress-bar"><div class="fill oop" style="width: ${famOopPct}%"></div></div>
          </div>
        </div>

        <table class="drug-history-table" style="margin-top: 12px;">
          <thead>
            <tr>
              <th>Member</th>
              <th>Medication</th>
              <th>Tier</th>
              <th>Status</th>
              <th>Patient Pay</th>
            </tr>
          </thead>
          <tbody>${allRxRows}</tbody>
        </table>
      `;
    } catch {
      if (section) section.classList.add('hidden');
    }
  }

  async doWriteRx() {
    const btn = document.getElementById('btn-write-rx');
    const patientWalletId = document.getElementById('patient-select').value;
    // thousandths of the pricing unit, as the engine takes them; never rounded to a whole unit
    const quantity = parseQuantity(document.getElementById('rx-quantity').value);
    const refills = parseInt(document.getElementById('rx-refills').value, 10);
    if (Number.isNaN(quantity)) {
      alert('Quantity must be greater than 0, in the drug\'s pricing unit, with at most three decimals.');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Generating proofs...');

    try {
      const res = await fetch(`${API_BASE}/interactive/prescribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prescriberIndex: this.selectedPrescriber,
          memberWalletId: patientWalletId,
          medicationIndex: this.selectedMedication,
          pharmacyIndex: this.selectedPharmacy,
          quantity,
          refills,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Prescription failed');
      }

      const result = await res.json();
      this.prescriptionResult = result;

      const resultDiv = document.getElementById('rx-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-card">
          <div class="result-title">eScript Written Successfully</div>
          <div class="data-grid">
            <div class="label">Prescription ID</div><div class="value highlight">${escapeHtml(result.prescriptionId)}</div>
            <div class="label">Medication</div><div class="value">${escapeHtml(result.medication.brandName)} ${escapeHtml(result.medication.strength)}</div>
            <div class="label">Prescriber</div><div class="value">${escapeHtml(result.prescriber.name)}, ${escapeHtml(result.prescriber.credential)}</div>
            <div class="label">Pharmacy</div><div class="value">${escapeHtml(result.pharmacy.name)}</div>
            <div class="label">Patient</div><div class="value">${escapeHtml(result.member.name)}</div>
            <div class="label">Quantity</div><div class="value">${escapeHtml(result.quantity)}</div>
            <div class="label">Refills</div><div class="value">${escapeHtml(result.refills)}</div>
            <div class="label">Status</div><div class="value" style="color: var(--accent-green);">${escapeHtml(result.status)}</div>
            <div class="label">Rx Hash</div><div class="value mono">${escapeHtml(result.rxHash)}</div>
          </div>
          ${result.priorAuthId ? `
            <div class="label">Prior Auth</div><div class="value" style="color: var(--accent-green);">${escapeHtml(result.priorAuthId)} (Approved)</div>
          ` : ''}
          ${result.stepTherapy ? `
            <div class="step-therapy-box step-therapy-met" style="margin-top: 8px;">
              <strong>Step Therapy:</strong> ${escapeHtml(result.stepTherapy.message || 'Satisfied')}
            </div>
          ` : ''}
          ${result.deaWarnings?.length ? `
            <div class="dea-warning-box" style="margin-top: 8px;">
              ${result.deaWarnings.map(w => `<div>${escapeHtml(w)}</div>`).join('')}
            </div>
          ` : ''}
          <div class="mt-4" style="font-size: 12px; color: var(--text-secondary);">
            <strong>Proof Generation Times:</strong><br>
            ProofGate: ${(result.proofTimesMs.proofGate / 1000).toFixed(2)}s |
            Eligibility: ${(result.proofTimesMs.eligibility / 1000).toFixed(2)}s |
            AccessControl: ${(result.proofTimesMs.accessControl / 1000).toFixed(2)}s |
            ${result.proofTimesMs.priorAuth ? `PriorAuth: ${(result.proofTimesMs.priorAuth / 1000).toFixed(2)}s |` : ''}
            Messaging: ${(result.proofTimesMs.messaging / 1000).toFixed(2)}s |
            <strong>Total: ${(result.proofTimesMs.total / 1000).toFixed(2)}s</strong>
          </div>

          <!-- ZK Detail Sections -->
          ${renderCredentialCard('Prescription Credential (Issued)', result.prescriptionNft, 'prescriber')}
          ${renderForestCard('Prescription Forest (6 Domain Trees)', result.prescriptionForest, 'prescriber')}
          ${renderZkDataSection('PrescriptionData (7 Fields)', result.prescriptionData, 'prescriber', '7 fields', result.prescriptionData ? result.prescriptionData.commitment : '')}
          ${renderZkDataSection('PrescriptionStatusData (ACTIVE)', result.statusData, 'prescriber', '7 fields', result.statusData ? result.statusData.commitment : '')}
        </div>
      `;

      // Update chain state panel
      if (result.chainState) {
        updateChainState(result.chainState);
      }

      this.app.setStatus('ready', 'Ready');

    } catch (err) {
      const resultDiv = document.getElementById('rx-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${escapeHtml(err.message)}</div>`;
      this.app.setStatus('ready', 'Error');
      btn.disabled = false;
    } finally {
      btn.classList.remove('loading');
    }
  }
  // ─── PCP Patients ─────────────────────────────────────────────────

  renderPcpPatients(state) {
    if (this.selectedPrescriber === null) return '';

    const enrolled = state.enrolledMembers || [];
    const pcpPatients = enrolled.filter(
      m => m.pcpAssignment && m.pcpAssignment.prescriberIndex === this.selectedPrescriber
    );

    if (pcpPatients.length === 0) return '';

    const lifecycleLabel = (lc) => {
      const labels = { REGISTERED: 'REGISTERED', ELIGIBLE: 'ELIGIBLE', ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' };
      return labels[lc] || lc || 'UNKNOWN';
    };
    const lifecycleColor = (lc) => {
      if (lc === 'ACTIVE') return 'var(--accent-green)';
      if (lc === 'REVOKED') return 'var(--accent-red)';
      return 'var(--accent-blue)';
    };

    const rows = pcpPatients.map(m => ({
      name: m.displayName,
      walletId: truncHash(m.walletId, 8),
      group: m.groupId || '--',
      family: m.familyId || '--',
      relationship: m.relationship || '--',
      lifecycle: m.lifecycle,
      deductible: m.accumulator ? m.accumulator.deductiblePaidCents : 0,
    }));

    const columns = [
      { key: 'name', label: 'Patient Name', format: v => escapeHtml(v) },
      { key: 'walletId', label: 'Wallet ID', format: v => `<span class="mono" style="font-size: 11px;">${escapeHtml(v)}</span>` },
      { key: 'group', label: 'Group', format: v => escapeHtml(v) },
      { key: 'family', label: 'Family', format: v => escapeHtml(v) },
      { key: 'relationship', label: 'Relationship', format: v => escapeHtml(v) },
      { key: 'lifecycle', label: 'Status', format: v => `<span style="color: ${lifecycleColor(v)}; font-weight: 600; font-size: 12px;">${escapeHtml(lifecycleLabel(v))}</span>` },
      { key: 'deductible', label: 'Deductible Used', align: 'right', format: v => formatCents(v) },
    ];

    return renderSectionCard(
      `My PCP Patients (${pcpPatients.length})`, 'prescriber',
      renderSortableTable('pcp-patients-table', columns, rows, 'name')
    );
  }

  // ─── Prior Auth Requests ────────────────────────────────────────────

  renderPriorAuthRequests(state) {
    if (this.selectedPrescriber === null) return '';

    const priorAuths = (state.priorAuths || []).filter(
      pa => pa.prescriberIndex === this.selectedPrescriber
    );
    if (priorAuths.length === 0) return '';

    const enrolled = state.enrolledMembers || [];
    const medications = state.demoData?.medications || [];

    const paStatusColor = (s) => {
      if (s === 'APPROVED') return 'var(--accent-green)';
      if (s === 'DENIED') return 'var(--accent-red)';
      return 'var(--accent-orange)';
    };

    const rows = priorAuths.map(pa => {
      const member = enrolled.find(m => m.walletId === pa.memberWalletId);
      const med = medications[pa.medicationIndex];
      return {
        id: pa.id || '--',
        patient: member ? member.displayName : truncHash(pa.memberWalletId, 8),
        medication: med ? med.brandName : `Med #${pa.medicationIndex}`,
        strength: med ? med.strength : '--',
        tier: med ? med.tier : null,
        status: pa.status,
        requestedAt: pa.requestedAt || pa.timestamp,
        resolvedAt: pa.resolvedAt,
      };
    });

    const columns = [
      { key: 'id', label: 'PA ID', format: v => `<span class="mono" style="font-size: 11px;">${escapeHtml(v)}</span>` },
      { key: 'patient', label: 'Patient', format: v => escapeHtml(v) },
      { key: 'medication', label: 'Medication', format: v => escapeHtml(v) },
      { key: 'strength', label: 'Strength', format: v => escapeHtml(v) },
      { key: 'tier', label: 'Tier', format: v => v != null ? `<span class="tier-badge tier-${v}">Tier ${v}</span>` : '--' },
      { key: 'status', label: 'Status', format: v => `<span style="color: ${paStatusColor(v)}; font-weight: 600; font-size: 12px;">${escapeHtml(v)}</span>` },
      { key: 'requestedAt', label: 'Requested', format: v => v ? new Date(v).toLocaleTimeString() : '--' },
      { key: 'resolvedAt', label: 'Resolved', format: v => v ? new Date(v).toLocaleTimeString() : '--' },
    ];

    return renderSectionCard(
      `Prior Authorization Requests (${priorAuths.length})`, 'prescriber',
      renderSortableTable('prescriber-pa-table', columns, rows, 'id')
    );
  }

  // ─── Prescribing History (all scripts by this prescriber) ──────────

  renderPrescribingHistory(state) {
    if (this.selectedPrescriber === null) return '';

    const prescriptions = (state.prescriptions || []).filter(
      rx => rx.prescriberIndex === this.selectedPrescriber
    );
    if (prescriptions.length === 0) return '';

    const enrolled = state.enrolledMembers || [];
    const pharmacies = state.demoData?.pharmacies || [];

    const getMemberName = (walletId) => {
      const m = enrolled.find(e => e.walletId === walletId);
      return m ? m.displayName : (walletId ? truncHash(walletId, 8) : '--');
    };
    const getPharmName = (idx) => {
      const p = pharmacies[idx];
      return p ? p.storeName : `Pharmacy #${idx}`;
    };
    const statusColor = (s) => {
      if (s === 'FILLED') return 'var(--accent-green)';
      if (s === 'ACTIVE' || s === 'PENDING' || s === 'DISPENSED') return 'var(--accent-blue)';
      if (s === 'CANCELLED' || s === 'REJECTED' || s === 'REVERSED') return 'var(--accent-red)';
      return 'var(--text-secondary)';
    };

    const rows = prescriptions.map(rx => ({
      id: rx.id,
      medication: rx.medication || '--',
      strength: rx.medicationStrength || '--',
      patient: getMemberName(rx.memberWalletId),
      pharmacy: getPharmName(rx.pharmacyIndex),
      quantity: rx.quantity,
      refills: `${rx.refillsUsed || 0}/${rx.refills}`,
      status: rx.status,
      patientPay: rx.patientPayCents || 0,
      planPay: rx.planPayCents || 0,
    }));

    const columns = [
      { key: 'id', label: 'Rx ID', format: v => `<span class="mono" style="font-size: 11px;">${escapeHtml(v)}</span>` },
      { key: 'medication', label: 'Medication', format: v => escapeHtml(v) },
      { key: 'strength', label: 'Strength', format: v => escapeHtml(v) },
      { key: 'patient', label: 'Patient', format: v => escapeHtml(v) },
      { key: 'pharmacy', label: 'Pharmacy', format: v => escapeHtml(v) },
      { key: 'quantity', label: 'Qty', align: 'right' },
      { key: 'refills', label: 'Refills', format: v => escapeHtml(v) },
      { key: 'status', label: 'Status', format: v => `<span style="color: ${statusColor(v)}; font-weight: 600; font-size: 12px;">${escapeHtml(v)}</span>` },
      { key: 'patientPay', label: 'Patient Pay', align: 'right', format: v => v ? formatCents(v) : '--' },
      { key: 'planPay', label: 'Plan Pay', align: 'right', format: v => v ? formatCents(v) : '--' },
    ];

    return renderSectionCard(
      `Prescribing History (${prescriptions.length})`, 'prescriber',
      `<div style="max-height: 400px; overflow-y: auto;">${renderSortableTable('prescriber-history-table', columns, rows, 'id')}</div>`
    );
  }

  // ─── Activity Summary ──────────────────────────────────────────────

  renderPrescriberActivity(state) {
    if (this.selectedPrescriber === null) return '';

    const prescriptions = (state.prescriptions || []).filter(
      rx => rx.prescriberIndex === this.selectedPrescriber
    );
    if (prescriptions.length === 0) return '';

    const priorAuths = (state.priorAuths || []).filter(
      pa => pa.prescriberIndex === this.selectedPrescriber
    );

    const total = prescriptions.length;
    const active = prescriptions.filter(rx => rx.status !== 'CANCELLED' && rx.status !== 'REJECTED').length;
    const filled = prescriptions.filter(rx => rx.status === 'FILLED' || rx.status === 'PARTIALLY_FILLED').length;
    const cancelled = prescriptions.filter(rx => rx.status === 'CANCELLED' || rx.status === 'REJECTED').length;
    const paPending = priorAuths.filter(pa => pa.status === 'PENDING').length;
    const paApproved = priorAuths.filter(pa => pa.status === 'APPROVED').length;
    const paDenied = priorAuths.filter(pa => pa.status === 'DENIED').length;
    let totalPatientPay = 0, totalPlanPay = 0;
    for (const rx of prescriptions) {
      totalPatientPay += rx.patientPayCents || 0;
      totalPlanPay += rx.planPayCents || 0;
    }

    // Status breakdown
    const statusCounts = {};
    for (const rx of prescriptions) {
      statusCounts[rx.status] = (statusCounts[rx.status] || 0) + 1;
    }
    const statusRows = Object.entries(statusCounts).map(([s, c]) =>
      `<div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border-subtle);"><span style="font-size: 12px;">${escapeHtml(s)}</span><span style="font-weight: 600;">${c}</span></div>`
    ).join('');

    const content = `
      ${renderMetricRow([
        { label: 'Total Scripts', value: total, color: 'var(--color-prescriber, #AB47BC)' },
        { label: 'Active', value: active, color: 'var(--accent-green, #66BB6A)' },
        { label: 'Filled', value: filled, color: 'var(--accent-blue, #4FC3F7)' },
        { label: 'Cancelled', value: cancelled, color: 'var(--accent-red, #EF5350)' },
      ])}
      ${renderMetricRow([
        { label: 'PA Pending', value: paPending, color: 'var(--accent-orange, #FFB74D)' },
        { label: 'PA Approved', value: paApproved, color: 'var(--accent-green, #66BB6A)' },
        { label: 'PA Denied', value: paDenied, color: 'var(--accent-red, #EF5350)' },
      ])}
      ${renderMetricRow([
        { label: 'Total Patient Pay', value: formatCents(totalPatientPay), color: 'var(--color-member, #4FC3F7)' },
        { label: 'Total Plan Pay', value: formatCents(totalPlanPay), color: 'var(--color-insurer, #78909C)' },
      ])}
      ${statusRows ? `<div style="margin-top: 8px;"><div style="font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Status Breakdown</div>${statusRows}</div>` : ''}
    `;

    return renderSectionCard('Activity Summary', 'prescriber', content);
  }

  // ─── Patient Breakdown ──────────────────────────────────────────────

  renderPatientBreakdown(state) {
    if (this.selectedPrescriber === null) return '';

    const prescriptions = (state.prescriptions || []).filter(
      rx => rx.prescriberIndex === this.selectedPrescriber
    );
    if (prescriptions.length === 0) return '';

    const enrolled = state.enrolledMembers || [];
    const getMemberName = (walletId) => {
      const m = enrolled.find(e => e.walletId === walletId);
      return m ? m.displayName : (walletId ? truncHash(walletId, 8) : '--');
    };

    const patientMap = new Map();
    for (const rx of prescriptions) {
      const e = patientMap.get(rx.memberWalletId) || {
        name: getMemberName(rx.memberWalletId),
        walletId: rx.memberWalletId,
        scripts: 0, meds: new Set(), patientPay: 0, planPay: 0,
      };
      e.scripts++;
      e.meds.add(rx.medicationIndex);
      e.patientPay += rx.patientPayCents || 0;
      e.planPay += rx.planPayCents || 0;
      patientMap.set(rx.memberWalletId, e);
    }

    const patients = Array.from(patientMap.values()).sort((a, b) => b.scripts - a.scripts);
    const rows = patients.map(p => ({
      name: p.name,
      walletId: p.walletId ? truncHash(p.walletId, 8) : '--',
      scripts: p.scripts,
      uniqueMeds: p.meds.size,
      patientPay: p.patientPay,
      planPay: p.planPay,
    }));

    const columns = [
      { key: 'name', label: 'Patient', format: v => escapeHtml(v) },
      { key: 'walletId', label: 'Wallet ID', format: v => `<span class="mono" style="font-size: 11px;">${escapeHtml(v)}</span>` },
      { key: 'scripts', label: 'Scripts', align: 'right' },
      { key: 'uniqueMeds', label: 'Unique Meds', align: 'right' },
      { key: 'patientPay', label: 'Patient Pay', align: 'right', format: v => formatCents(v) },
      { key: 'planPay', label: 'Plan Pay', align: 'right', format: v => formatCents(v) },
    ];

    return renderSectionCard(
      `Patient Breakdown (${patients.length})`, 'prescriber',
      renderSortableTable('prescriber-patient-table', columns, rows, 'scripts')
    );
  }

  // ─── Medication Breakdown ──────────────────────────────────────────

  renderMedicationBreakdown(state) {
    if (this.selectedPrescriber === null) return '';

    const prescriptions = (state.prescriptions || []).filter(
      rx => rx.prescriberIndex === this.selectedPrescriber
    );
    if (prescriptions.length === 0) return '';

    const medications = state.demoData?.medications || [];

    const medMap = new Map();
    for (const rx of prescriptions) {
      const e = medMap.get(rx.medicationIndex) || {
        name: rx.medication || '--',
        tier: null, scripts: 0, patients: new Set(), patientPay: 0, planPay: 0,
      };
      const med = medications[rx.medicationIndex];
      if (med) e.tier = med.tier;
      e.scripts++;
      e.patients.add(rx.memberWalletId);
      e.patientPay += rx.patientPayCents || 0;
      e.planPay += rx.planPayCents || 0;
      medMap.set(rx.medicationIndex, e);
    }

    const meds = Array.from(medMap.values()).sort((a, b) => b.scripts - a.scripts);
    const rows = meds.map(m => ({
      name: m.name,
      tier: m.tier,
      scripts: m.scripts,
      patients: m.patients.size,
      patientPay: m.patientPay,
      planPay: m.planPay,
    }));

    const columns = [
      { key: 'name', label: 'Medication', format: v => escapeHtml(v) },
      { key: 'tier', label: 'Tier', format: v => v !== null ? `<span class="tier-badge tier-${v}">Tier ${v}</span>` : '--' },
      { key: 'scripts', label: 'Scripts', align: 'right' },
      { key: 'patients', label: 'Patients', align: 'right' },
      { key: 'patientPay', label: 'Patient Pay', align: 'right', format: v => formatCents(v) },
      { key: 'planPay', label: 'Plan Pay', align: 'right', format: v => formatCents(v) },
    ];

    return renderSectionCard(
      `Medication Breakdown (${meds.length})`, 'prescriber',
      renderSortableTable('prescriber-med-table', columns, rows, 'scripts')
    );
  }

  // ─── Pharmacy Breakdown ──────────────────────────────────────────

  renderPharmacyBreakdown(state) {
    if (this.selectedPrescriber === null) return '';

    const prescriptions = (state.prescriptions || []).filter(
      rx => rx.prescriberIndex === this.selectedPrescriber
    );
    if (prescriptions.length === 0) return '';

    const pharmacies = state.demoData?.pharmacies || [];

    const pharmMap = new Map();
    for (const rx of prescriptions) {
      const e = pharmMap.get(rx.pharmacyIndex) || {
        name: pharmacies[rx.pharmacyIndex]?.storeName || `Pharmacy #${rx.pharmacyIndex}`,
        scripts: 0, patients: new Set(), meds: new Set(),
      };
      e.scripts++;
      e.patients.add(rx.memberWalletId);
      e.meds.add(rx.medicationIndex);
      pharmMap.set(rx.pharmacyIndex, e);
    }

    const pharms = Array.from(pharmMap.values()).sort((a, b) => b.scripts - a.scripts);
    const rows = pharms.map(p => ({
      name: p.name,
      scripts: p.scripts,
      patients: p.patients.size,
      uniqueMeds: p.meds.size,
    }));

    const columns = [
      { key: 'name', label: 'Pharmacy', format: v => escapeHtml(v) },
      { key: 'scripts', label: 'Scripts', align: 'right' },
      { key: 'patients', label: 'Patients', align: 'right' },
      { key: 'uniqueMeds', label: 'Unique Meds', align: 'right' },
    ];

    return renderSectionCard(
      `Pharmacy Breakdown (${pharms.length})`, 'prescriber',
      renderSortableTable('prescriber-pharm-table', columns, rows, 'scripts')
    );
  }

  // ─── Messages ────────────────────────────────────────────────────

  renderPrescriberMessages(state) {
    if (this.selectedPrescriber === null) {
      return `
        <div class="section-card">
          <div class="card-header prescriber">Messages</div>
          <div class="card-body">
            <div style="color: var(--text-muted); font-size: 13px;">Select a prescriber above to view and send messages.</div>
          </div>
        </div>
      `;
    }

    const dir = state.walletDirectory || {};
    const MSG_LABELS = { 1:'Rx', 2:'PA Req', 3:'PA Resp', 4:'Notice', 5:'General', 6:'Support', 7:'Summary' };

    let prescriberWalletId = null;
    for (const [wid, info] of Object.entries(dir)) {
      if (info.type === 'prescriber' && info.index === this.selectedPrescriber) {
        prescriberWalletId = wid;
        break;
      }
    }

    const messages = prescriberWalletId
      ? (state.messaging?.messages || []).filter(m =>
          m.senderWalletId === prescriberWalletId || m.recipientWalletId === prescriberWalletId)
      : [];

    // Group messages by threadId
    const threadMap = new Map();
    messages.forEach(m => {
      const tid = m.threadId || `msg-${m.messageIndex}`;
      if (!threadMap.has(tid)) threadMap.set(tid, []);
      threadMap.get(tid).push(m);
    });
    const threads = Array.from(threadMap.entries())
      .map(([tid, msgs]) => ({ threadId: tid, messages: msgs, latest: Math.max(...msgs.map(m => m.timestamp || 0)) }))
      .sort((a, b) => b.latest - a.latest);

    // Build recipient options
    const recipientOptions = [];
    const patientWalletId = document.getElementById('patient-select')?.value;
    if (patientWalletId) {
      const patientName = dir[patientWalletId]?.displayName || 'Patient';
      recipientOptions.push(`<option value="member:${escapeHtml(patientWalletId)}">${escapeHtml(patientName)} (Patient)</option>`);
    }
    (state.enrolledMembers || []).filter(m => m.lifecycle !== 'REVOKED' && m.walletId !== patientWalletId).forEach(m => {
      recipientOptions.push(`<option value="member:${escapeHtml(m.walletId)}">${escapeHtml(m.displayName)}</option>`);
    });
    (state.demoData?.pharmacies || []).forEach(p => {
      recipientOptions.push(`<option value="pharmacy:${p.index}">${escapeHtml(p.storeName)}</option>`);
    });
    recipientOptions.push(`<option value="insurer:0">Insurer</option>`);

    return `
      <div class="section-card">
        <div class="card-header prescriber">Messages (${messages.length})</div>
        <div class="card-body">
          <div id="prescriber-reply-banner" class="hidden" style="background: var(--bg-tertiary); border: 1px solid var(--accent-green); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <span id="prescriber-reply-label" style="font-size: 12px; color: var(--accent-green);"></span>
            <button id="prescriber-cancel-reply" style="background: none; border: none; color: var(--accent-red); cursor: pointer; font-size: 12px;">Cancel</button>
          </div>
          <div class="msg-compose">
            <div style="font-size: 12px; font-weight: 600; color: var(--accent-green); margin-bottom: 8px;">Send Message</div>
            <label>To</label>
            <select id="prescriber-msg-recipient">
              <option value="">\u2014 Select recipient \u2014</option>
              ${recipientOptions.join('')}
            </select>
            <label>Subject</label>
            <input type="text" id="prescriber-msg-subject" placeholder="Subject">
            <label>Message</label>
            <textarea id="prescriber-msg-body" rows="2" placeholder="Type your message..."></textarea>
            <input type="hidden" id="prescriber-msg-thread-id" value="">
            <button id="btn-prescriber-send-msg" class="btn-action prescriber" disabled>
              <span class="spinner"></span> Send Message
            </button>
            <div class="msg-privacy-note">End-to-end encrypted (X25519-ECDH + AES-256-GCM). ZK proof generated on send.</div>
          </div>
          <div id="prescriber-send-result" class="hidden"></div>
          ${threads.length > 0 ? `
          <div class="msg-thread-list">
            ${threads.map(t => {
              const lastMsg = t.messages[t.messages.length - 1];
              const isSent = lastMsg.senderWalletId === prescriberWalletId;
              const otherWid = isSent ? lastMsg.recipientWalletId : lastMsg.senderWalletId;
              const otherName = dir[otherWid]?.displayName || otherWid.slice(0,8) + '\u2026';
              const typeLabel = MSG_LABELS[lastMsg.messageType] || 'Msg';
              const timeStr = lastMsg.timestamp ? new Date(lastMsg.timestamp).toLocaleTimeString() : '';
              return `
              <div class="prescriber-thread-item msg-thread-item" data-thread-id="${escapeHtml(t.threadId)}" data-wallet-id="${escapeHtml(prescriberWalletId)}" data-indices="${escapeHtml(t.messages.map(m => m.messageIndex).join(','))}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <div>
                    <span class="msg-type-badge msg-type-${escapeHtml(lastMsg.messageType)}">${typeLabel}</span>
                    <strong style="font-size: 12px; margin-left: 4px;">${escapeHtml(otherName)}</strong>
                    <span style="font-size: 11px; color: var(--text-muted); margin-left: 4px;">(${t.messages.length} message${t.messages.length > 1 ? 's' : ''})</span>
                  </div>
                  <span style="font-size: 11px; color: var(--text-muted);">${timeStr}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-muted);">${lastMsg.hasEncryptedPayload ? 'Click to decrypt and view' : 'No content'}</div>
                <div class="msg-thread-expanded hidden" data-thread-body="${escapeHtml(t.threadId)}"></div>
              </div>`;
            }).join('')}
          </div>
          ` : '<div style="color: var(--text-muted); font-size: 13px; margin-top: 8px;">No messages yet.</div>'}
        </div>
      </div>
    `;
  }

  async doExpandPrescriberThread(el) {
    const threadId = el.dataset.threadId;
    const walletId = el.dataset.walletId;
    const indices = el.dataset.indices.split(',').map(Number);
    const bodyDiv = el.querySelector(`[data-thread-body="${threadId}"]`);
    if (!bodyDiv) return;

    if (!bodyDiv.classList.contains('hidden')) {
      bodyDiv.classList.add('hidden');
      return;
    }

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
      const dir = this.currentState?.walletDirectory || {};

      // every value in a message came over the network and is escaped (message-thread.js)
      bodyDiv.innerHTML = renderMessageBubbles(decrypted, walletId, dir) + `
        <button class="msg-reply-btn" data-thread-id="${escapeHtml(threadId)}" style="margin-top: 8px; font-size: 11px; background: var(--accent-green); color: white; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer;">Reply</button>
      `;

      bodyDiv.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const lastDecrypted = decrypted.filter(Boolean).slice(-1)[0];
        const otherWid = lastDecrypted.senderWalletId === walletId ? lastDecrypted.recipientWalletId : lastDecrypted.senderWalletId;
        const otherInfo = dir[otherWid];

        document.getElementById('prescriber-msg-thread-id').value = threadId;
        const banner = document.getElementById('prescriber-reply-banner');
        banner.classList.remove('hidden');
        document.getElementById('prescriber-reply-label').textContent = `Replying to: ${lastDecrypted.subject || 'conversation'}`;

        const recipientSelect = document.getElementById('prescriber-msg-recipient');
        if (recipientSelect && otherInfo) {
          for (const opt of recipientSelect.options) {
            if (opt.textContent.includes(otherInfo.displayName)) {
              recipientSelect.value = opt.value;
              break;
            }
          }
          recipientSelect.disabled = true;
        }

        const subjectInput = document.getElementById('prescriber-msg-subject');
        if (subjectInput && lastDecrypted.subject) {
          subjectInput.value = lastDecrypted.subject.startsWith('Re: ') ? lastDecrypted.subject : `Re: ${lastDecrypted.subject}`;
        }

        const btnSendMsg = document.getElementById('btn-prescriber-send-msg');
        if (btnSendMsg) btnSendMsg.disabled = false;
        document.getElementById('prescriber-msg-body')?.focus();
      });
    } catch (err) {
      bodyDiv.innerHTML = `<div style="padding: 8px; color: var(--accent-red); font-size: 12px;">Decrypt failed: ${escapeHtml(err.message)}</div>`;
    }
  }

  async doSendPrescriberMessage() {
    const btn = document.getElementById('btn-prescriber-send-msg');
    const recipientSelect = document.getElementById('prescriber-msg-recipient');
    const subjectInput = document.getElementById('prescriber-msg-subject');
    const bodyInput = document.getElementById('prescriber-msg-body');
    const threadIdInput = document.getElementById('prescriber-msg-thread-id');
    if (!recipientSelect.value || !subjectInput.value.trim()) return;

    const [recipientType, recipientVal] = recipientSelect.value.split(':');
    const params = {
      senderType: 'prescriber',
      senderIndex: this.selectedPrescriber,
      recipientType,
      subject: subjectInput.value.trim(),
      body: bodyInput.value.trim() || subjectInput.value.trim(),
    };
    if (recipientType === 'member') {
      params.recipientWalletId = recipientVal;
    } else if (recipientType === 'pharmacy') {
      params.recipientIndex = parseInt(recipientVal, 10);
    }
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

      const resultDiv = document.getElementById('prescriber-send-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-card" style="margin-bottom: 12px;">
          <div class="result-title">Message Sent (Encrypted)</div>
          <div class="data-grid">
            <div class="label">To</div><div class="value">${escapeHtml(result.to)}</div>
            <div class="label">Subject</div><div class="value">${escapeHtml(result.subject)}</div>
            <div class="label">Encrypted</div><div class="value">${result.ciphertextLength} bytes (AES-256-GCM)</div>
            <div class="label">Proof Time</div><div class="value">${(result.proofTimeMs / 1000).toFixed(2)}s</div>
            <div class="label">Thread</div><div class="value mono" style="font-size: 11px;">${escapeHtml(result.threadId || 'new')}</div>
            <div class="label">Audit Hash</div><div class="value mono" style="font-size: 11px;">${result.auditChainHash ? result.auditChainHash.slice(0, 20) + '\u2026' : '\u2014'}</div>
          </div>
        </div>
      `;

      // Clear reply state
      if (threadIdInput) threadIdInput.value = '';
      const banner = document.getElementById('prescriber-reply-banner');
      if (banner) banner.classList.add('hidden');
      if (recipientSelect) recipientSelect.disabled = false;

      if (result.chainState) updateChainState(result.chainState);
      this.app.setStatus('ready', 'Message sent');
      setTimeout(async () => {
        const fresh = await loadInteractiveState(API_BASE);
        if (fresh) { this.currentState = fresh; this.render(this.currentState); }
      }, 1500);
    } catch (err) {
      const resultDiv = document.getElementById('prescriber-send-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${escapeHtml(err.message)}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  // ─── Node Info ──────────────────────────────────────────

  renderPrescriberNodeInfo() {
    return `
      <div class="section-card collapsed">
        <div class="card-header prescriber collapsible" onclick="this.parentElement.classList.toggle('collapsed')">
          <span>Node Info</span>
          <span class="collapse-arrow">&#9660;</span>
        </div>
        <div class="card-body collapsible-body">
          <div id="prescriber-node-info">
            <div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 12px;">Loading chain state...</div>
          </div>
        </div>
      </div>
    `;
  }

  async loadPrescriberNodeInfo() {
    const container = document.getElementById('prescriber-node-info');
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
      <div style="color: var(--accent-red); font-size: 12px; margin-top: 8px;">${escapeHtml(err.message)}</div>`;
    }
  }
}
