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
 * entity-modal.js — Unified modal for member, prescriber, pharmacy, insurer, and employer nodes.
 *
 * Full action capabilities:
 *   Member:     enroll, select PCP, generate credential, view drug history, terminate
 *   Prescriber: write Rx, request prior auth, cancel Rx, view PCP patients
 *   Pharmacy:   fill Rx (with credential JSON), reject Rx, reverse fill, verify credential
 *   Insurer:    reporting (by member/pharmacy/prescriber), approve/deny prior auth, force batch
 *   Employer:   terminate group
 */

class EntityModal {
  constructor(modalEl) {
    this.modalEl = modalEl;
    this.currentNode = null;
    this.currentState = null;
    this.reportCache = {};

    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.close();
    });
  }

  show(d, stateData) {
    this.currentNode = d;
    this.currentState = stateData;
    this.reportCache = {};
    const type = d.entityType;
    let html = '';

    switch (type) {
      case 'member':     html = this.renderMember(d, stateData); break;
      case 'prescriber': html = this.renderPrescriber(d, stateData); break;
      case 'pharmacy':   html = this.renderPharmacy(d, stateData); break;
      case 'insurer':    html = this.renderInsurer(d, stateData); break;
      case 'employer':   html = this.renderEmployer(d, stateData); break;
      default:           html = this.renderGeneric(d); break;
    }

    this.modalEl.innerHTML = `
      <div class="modal-content">
        <button class="modal-close" onclick="document.getElementById('entity-modal').classList.add('hidden')">&times;</button>
        ${html}
      </div>
    `;

    this.modalEl.classList.remove('hidden');
    this.bindActions(type, d, stateData);
  }

  close() {
    this.modalEl.classList.add('hidden');
    this.currentNode = null;
    // Clean up NFC SSE if open
    if (this._nfcEventSource) {
      this._nfcEventSource.close();
      this._nfcEventSource = null;
    }
  }

  refresh() {
    const state = window._lastStateData ? window._lastStateData() : this.currentState;
    if (this.currentNode) this.show(this.currentNode, state);
  }

  async refreshAfterAction() {
    if (window._dashboardPollStatus) await window._dashboardPollStatus();
    setTimeout(() => this.refresh(), 500);
  }

  // ─── Member Modal ──────────────────────────────────────
  renderMember(d, state) {
    const idx = d.memberIndex;
    const enrolled = state?.enrolledMembers?.find(m => m.memberIndex === idx);
    const demoMember = state?.demoData?.members?.find(m => m.index === idx);
    const priv = PrivacyMode.isActive();

    const stateLabel = d.enrollmentState === 'enrolled' ? 'Enrolled'
      : d.enrollmentState === 'enrolling' ? 'Enrolling...'
      : 'Not Enrolled';
    const stateBadge = d.enrollmentState === 'enrolled' ? 'badge-success'
      : d.enrollmentState === 'enrolling' ? 'badge-info'
      : 'badge-muted';

    const displayLabel = priv
      ? PrivacyMode.memberLabel(d.label, idx, enrolled?.walletId || null)
      : d.label;

    let sections = `
      ${this.titleRow(displayLabel, 'member', '#4fc3f7', 'M')}
      <div class="modal-section">
        <h4>Identity</h4>
        ${this.row('Status', `<span class="badge ${stateBadge}">${stateLabel}</span>`)}
        ${!priv && demoMember ? this.row('Cardholder ID', demoMember.cardholderId) : ''}
        ${!priv && demoMember ? this.row('DOB', demoMember.dateOfBirth) : ''}
        ${!priv && demoMember ? this.row('Relationship', demoMember.relationship) : ''}
        ${!priv && demoMember ? this.row('Family ID', demoMember.familyId) : ''}
        ${priv ? this.row('Visibility', '<span class="badge badge-info">Opaque — identity unknown to network</span>') : ''}
      </div>
    `;

    // Not enrolled — show Enroll button
    if (!enrolled && d.enrollmentState !== 'enrolling') {
      sections += `
        <div class="modal-section">
          <h4>Actions</h4>
          <button class="btn-action btn-enroll" id="btn-member-enroll" data-member-index="${idx}">Enroll Member</button>
          <div id="enroll-status" class="action-status"></div>
        </div>
      `;
    }

    if (enrolled) {
      // Partition assignment
      const partitionCount = 3;
      const partition = Number(BigInt(enrolled.walletId) % BigInt(partitionCount));
      const levNames = ['Alpha', 'Beta', 'Gamma'];

      sections += `
        <div class="modal-section">
          <h4>Enrollment</h4>
          ${this.row('Wallet ID', `<span style="font-family:monospace;font-size:10px;">${enrolled.walletIdDisplay || truncHash(enrolled.walletId)}</span>`)}
          ${this.row('Partition', `P${partition} (${levNames[partition] || 'Unknown'})`)}
          ${this.row('Plan', enrolled.planId || '—')}
          ${this.row('Group', enrolled.groupId || '—')}
          ${this.row('Lifecycle', enrolled.lifecycle || '—')}
          ${this.row('Nonce', enrolled.nonce ?? '—')}
        </div>
      `;

      if (enrolled.accumulator) {
        const acc = enrolled.accumulator;
        sections += `
          <div class="modal-section">
            <h4>Accumulators</h4>
            ${this.row('Deductible Paid', formatCents(acc.deductiblePaidCents))}
            ${this.row('OOP Paid', formatCents(acc.oopPaidCents))}
            ${this.row('Benefit Used', formatCents(acc.benefitUsedCents))}
          </div>
        `;
      }

      // PCP Assignment or PCP selection
      if (enrolled.pcpAssignment) {
        sections += `
          <div class="modal-section">
            <h4>PCP Assignment</h4>
            ${this.row('Provider', enrolled.pcpAssignment.prescriberName)}
            ${this.row('Specialty', enrolled.pcpAssignment.specialty)}
          </div>
        `;
      } else {
        const prescribers = state?.demoData?.prescribers || [];
        sections += `
          <div class="modal-section">
            <h4>Assign PCP</h4>
            <div class="form-group">
              <label>Select Primary Care Provider</label>
              <select id="select-pcp">
                <option value="">— Choose PCP —</option>
                ${prescribers.map((p, i) => `<option value="${i}">${escapeHtml(p.firstName + ' ' + p.lastName)} (${escapeHtml(p.specialty)})</option>`).join('')}
              </select>
            </div>
            <button class="btn-action btn-enroll" id="btn-assign-pcp" data-wallet-id="${enrolled.walletId}">Assign PCP</button>
            <div id="pcp-status" class="action-status"></div>
          </div>
        `;
      }

      // Credential generation — pre-populate if member already has one
      const hasExistingCred = enrolled.credentialJson;
      sections += `
        <div class="modal-section">
          <h4>Portable Credential</h4>
          <button class="btn-action btn-prescribe" id="btn-gen-credential" data-wallet-id="${enrolled.walletId}">${hasExistingCred ? 'Regenerate Credential' : 'Generate Credential'}</button>
          <div id="credential-status" class="action-status">${hasExistingCred ? '<div class="status-success">Credential available</div>' : ''}</div>
          <div id="credential-result" style="display:${hasExistingCred ? 'block' : 'none'};margin-top:8px;">
            <textarea class="credential-textarea" id="credential-json" rows="6" readonly>${hasExistingCred ? escapeHtml(enrolled.credentialJson) : ''}</textarea>
            <div style="display:flex;gap:6px;margin-top:4px;">
              <button class="btn-copy" id="btn-copy-credential">Copy to Clipboard</button>
              <button class="btn-action btn-fill" id="btn-write-nfc" data-wallet-id="${enrolled.walletId}" style="padding:4px 10px;font-size:10px;">Write to NFC Tag</button>
            </div>
            <div id="nfc-write-status" class="action-status"></div>
          </div>
        </div>
      `;

      // Drug history
      const rxs = (state?.prescriptions || []).filter(rx => rx.memberWalletId === enrolled.walletId);
      sections += `
        <div class="modal-section">
          <h4>Drug History (${rxs.length})</h4>
          ${rxs.length > 0 ? `
            <table class="drug-history-table">
              <thead><tr><th>Drug</th><th>Status</th><th>Patient</th><th>Plan</th></tr></thead>
              <tbody>
                ${rxs.map(rx => `
                  <tr>
                    <td>${escapeHtml(rx.medication)} ${rx.medicationStrength || ''}</td>
                    <td><span class="badge ${this.rxStatusBadge(rx.status)}">${rx.status}</span></td>
                    <td class="amount">${rx.patientPayCents ? formatCents(rx.patientPayCents) : '—'}</td>
                    <td class="amount">${rx.planPayCents ? formatCents(rx.planPayCents) : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div style="font-size:11px;color:var(--text-muted);">No prescriptions yet</div>'}
        </div>
      `;

      // Messaging — only if PCP is assigned
      if (enrolled.pcpAssignment) {
        sections += `
          <div class="modal-form">
            <h4>Message PCP</h4>
            <div class="form-group">
              <label>To: ${escapeHtml(priv ? 'PCP' : enrolled.pcpAssignment.prescriberName)}</label>
            </div>
            <div class="form-group">
              <label>Subject</label>
              <input type="text" id="member-msg-subject" value="Treatment Update" placeholder="Subject">
            </div>
            <div class="form-group">
              <label>Message</label>
              <textarea id="member-msg-body" rows="2" placeholder="Write your message..."></textarea>
            </div>
            <button class="btn-action btn-prescribe" id="btn-member-send-msg" data-wallet-id="${enrolled.walletId}" data-prescriber-index="${enrolled.pcpAssignment.prescriberIndex}">Send Message</button>
            <div id="member-msg-status" class="action-status"></div>
          </div>
        `;

        // Conversation threads
        sections += `
          <div class="modal-section">
            <h4>Conversations</h4>
            <div id="member-threads" style="font-size:11px;color:var(--text-muted);">
              <button class="btn-action btn-report" id="btn-load-threads" data-wallet-id="${enrolled.walletId}" style="padding:3px 8px;font-size:10px;">Load Threads</button>
            </div>
            <div id="member-thread-messages" style="display:none;margin-top:8px;max-height:200px;overflow-y:auto;"></div>
          </div>
        `;
      }

      // Delegation / AOR
      const otherEnrolled = (state?.enrolledMembers || []).filter(m => m.walletId !== enrolled.walletId);
      if (otherEnrolled.length > 0) {
        sections += `
          <div class="modal-form">
            <h4>Delegation (AOR)</h4>
            <div class="form-group">
              <label>Delegate To</label>
              <select id="delegation-delegate">
                <option value="">— Select Member —</option>
                ${otherEnrolled.map(m => `<option value="${m.walletId}">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Scope</label>
              <div class="delegation-scope">
                <label><input type="checkbox" value="1" checked> View Records</label>
                <label><input type="checkbox" value="2"> Manage Rx</label>
                <label><input type="checkbox" value="4"> Financial</label>
              </div>
            </div>
            <div class="form-group">
              <label>Relationship</label>
              <select id="delegation-relationship">
                <option value="1">Spouse</option>
                <option value="2">Parent</option>
                <option value="3">Child (Adult)</option>
                <option value="4">Legal Guardian</option>
                <option value="5">Caregiver</option>
              </select>
            </div>
            <button class="btn-action btn-prescribe" id="btn-create-delegation" data-wallet-id="${enrolled.walletId}">Create Delegation</button>
            <div id="delegation-status" class="action-status"></div>
          </div>
        `;
      }

      // Claim History (on-demand)
      sections += `
        <div class="modal-section">
          <h4>Claim History</h4>
          <div id="member-claims" style="font-size:11px;color:var(--text-muted);">
            <button class="btn-action btn-report" id="btn-load-claims" data-wallet-id="${enrolled.walletId}" style="padding:3px 8px;font-size:10px;">Load Claims from Accumulator</button>
          </div>
        </div>
      `;

      // Terminate
      sections += `
        <div class="modal-section">
          <h4>Administration</h4>
          <button class="btn-action btn-terminate" id="btn-terminate-member" data-wallet-id="${enrolled.walletId}">Terminate Member</button>
          <div id="terminate-status" class="action-status"></div>
        </div>
      `;
    }

    sections += `
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('entity-modal').classList.add('hidden')">Close</button>
      </div>
    `;

    return sections;
  }

  // ─── Prescriber Modal ──────────────────────────────────
  renderPrescriber(d, state) {
    const idx = d.prescriberIndex;
    const demoPrescriber = state?.demoData?.prescribers?.find(p => p.index === idx);

    let sections = `
      ${this.titleRow(d.label, 'prescriber', '#66bb6a', 'Rx')}
      <div class="modal-section">
        <h4>Provider Information</h4>
        ${demoPrescriber ? this.row('Full Name', `${demoPrescriber.firstName} ${demoPrescriber.lastName}, ${demoPrescriber.credential}`) : this.row('Name', d.label)}
        ${this.row('Specialty', d.sublabel || demoPrescriber?.specialty || '—')}
        ${demoPrescriber ? this.row('NPI', demoPrescriber.npi) : ''}
        ${demoPrescriber ? this.row('State', demoPrescriber.state) : ''}
        ${demoPrescriber ? this.row('DEA Number', demoPrescriber.deaNumber) : ''}
      </div>
    `;

    // PCP patients
    const priv = PrivacyMode.isActive();
    const assignedPatients = (state?.enrolledMembers || []).filter(m =>
      m.pcpAssignment && m.pcpAssignment.prescriberIndex === idx
    );
    // PCP patients section
    if (assignedPatients.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>PCP Patients (${assignedPatients.length})</h4>
          ${assignedPatients.map(m => `
            <div class="modal-row">
              <span class="label">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</span>
              <span class="value"><span class="badge badge-success">${m.lifecycle || 'ACTIVE'}</span></span>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      sections += `
        <div class="modal-section">
          <h4>PCP Patients</h4>
          <div style="font-size:11px;color:var(--text-muted);padding:4px 0;">No patients assigned yet. Enroll a member and assign this provider as their PCP.</div>
        </div>
      `;
    }

    // Write prescription form
    const medications = state?.demoData?.medications || [];
    const pharmacies = state?.demoData?.pharmacies || [];
    const hasPatients = assignedPatients.length > 0;

    sections += `
      <div class="modal-form${hasPatients ? '' : ' form-disabled'}">
        <h4>Write Prescription</h4>
        ${!hasPatients ? '<div style="font-size:10px;color:var(--accent-orange);margin-bottom:6px;">Requires PCP patients — assign this provider as a member\'s PCP first</div>' : ''}
        <div class="form-group">
          <label>Patient</label>
          <select id="rx-patient" ${!hasPatients ? 'disabled' : ''}>
            <option value="">${hasPatients ? '— Select Patient —' : '— No patients assigned —'}</option>
            ${assignedPatients.map(m => `<option value="${m.walletId}">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Medication</label>
            <select id="rx-medication" ${!hasPatients ? 'disabled' : ''}>
              <option value="">— Select —</option>
              ${medications.map((m, i) => `<option value="${i}">${escapeHtml(m.brandName)} ${m.strength}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Pharmacy</label>
            <select id="rx-pharmacy" ${!hasPatients ? 'disabled' : ''}>
              <option value="">— Select —</option>
              ${pharmacies.map((p, i) => `<option value="${i}">${escapeHtml(p.storeName || p.chain)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Quantity</label>
            <input type="number" id="rx-quantity" value="30" min="1" max="360" ${!hasPatients ? 'disabled' : ''}>
          </div>
          <div class="form-group">
            <label>Refills</label>
            <input type="number" id="rx-refills" value="3" min="0" max="12" ${!hasPatients ? 'disabled' : ''}>
          </div>
        </div>
        <button class="btn-action btn-prescribe" id="btn-prescribe" data-prescriber-index="${idx}" ${!hasPatients ? 'disabled' : ''}>Write Prescription</button>
        <div id="prescribe-status" class="action-status"></div>
      </div>
    `;

    // Request prior auth form
    sections += `
      <div class="modal-form${hasPatients ? '' : ' form-disabled'}">
        <h4>Request Prior Authorization</h4>
        ${!hasPatients ? '<div style="font-size:10px;color:var(--accent-orange);margin-bottom:6px;">Requires PCP patients</div>' : ''}
        <div class="form-row">
          <div class="form-group">
            <label>Patient</label>
            <select id="pa-patient" ${!hasPatients ? 'disabled' : ''}>
              <option value="">${hasPatients ? '— Select —' : '— No patients —'}</option>
              ${assignedPatients.map(m => `<option value="${m.walletId}">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Medication</label>
            <select id="pa-medication" ${!hasPatients ? 'disabled' : ''}>
              <option value="">— Select —</option>
              ${medications.map((m, i) => `<option value="${i}">${escapeHtml(m.brandName)} ${m.strength}</option>`).join('')}
            </select>
          </div>
        </div>
        <button class="btn-action btn-prescribe" id="btn-request-pa" data-prescriber-index="${idx}" ${!hasPatients ? 'disabled' : ''}>Request Prior Auth</button>
        <div id="pa-status" class="action-status"></div>
      </div>
    `;

    // Send message to patient
    sections += `
      <div class="modal-form${hasPatients ? '' : ' form-disabled'}">
        <h4>Send Message to Patient</h4>
        ${!hasPatients ? '<div style="font-size:10px;color:var(--accent-orange);margin-bottom:6px;">Requires PCP patients</div>' : ''}
        <div class="form-group">
          <label>Patient</label>
          <select id="prescriber-msg-patient" ${!hasPatients ? 'disabled' : ''}>
            <option value="">${hasPatients ? '— Select Patient —' : '— No patients —'}</option>
            ${assignedPatients.map(m => `<option value="${m.walletId}">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Subject</label>
          <input type="text" id="prescriber-msg-subject" value="Treatment Update" placeholder="Subject" ${!hasPatients ? 'disabled' : ''}>
        </div>
        <div class="form-group">
          <label>Message</label>
          <textarea id="prescriber-msg-body" rows="2" placeholder="Write your message..." ${!hasPatients ? 'disabled' : ''}></textarea>
        </div>
        <button class="btn-action btn-prescribe" id="btn-prescriber-send-msg" data-prescriber-index="${idx}" ${!hasPatients ? 'disabled' : ''}>Send Message</button>
        <div id="prescriber-msg-status" class="action-status"></div>
      </div>
    `;

    // Active prescriptions (with cancel button)
    const rxs = (state?.prescriptions || []).filter(rx => rx.prescriberIndex === idx);
    const activeRxs = rxs.filter(rx => rx.status === 'ACTIVE' || rx.status === 'PENDING');
    if (activeRxs.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>Active Prescriptions (${activeRxs.length})</h4>
          ${activeRxs.map(rx => `
            <div class="rx-action-row">
              <div class="rx-info">
                <div class="rx-drug">${escapeHtml(rx.medication)} ${rx.medicationStrength || ''}</div>
                <div class="rx-meta">${escapeHtml(priv ? truncHash(rx.memberWalletId) : (rx.memberName || ''))} &middot; ${rx.status}</div>
              </div>
              <button class="btn-action btn-terminate" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.cancelRx('${rx.id}', ${idx})">Cancel</button>
            </div>
          `).join('')}
        </div>
      `;
    }

    // All prescriptions summary
    if (rxs.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>All Prescriptions (${rxs.length})</h4>
          ${rxs.slice(0, 8).map(rx => `
            <div class="modal-row">
              <span class="label">${escapeHtml(rx.medication)}</span>
              <span class="value"><span class="badge ${this.rxStatusBadge(rx.status)}">${rx.status}</span></span>
            </div>
          `).join('')}
          ${rxs.length > 8 ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">+${rxs.length - 8} more</div>` : ''}
        </div>
      `;
    }

    sections += `
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('entity-modal').classList.add('hidden')">Close</button>
      </div>
    `;

    return sections;
  }

  // ─── Pharmacy Modal ────────────────────────────────────
  renderPharmacy(d, state) {
    const idx = d.pharmacyIndex;
    const demoPharmacy = state?.demoData?.pharmacies?.find(p => p.index === idx);
    const priv = PrivacyMode.isActive();

    let sections = `
      ${this.titleRow(d.label, 'pharmacy', '#ffa726', 'Ph')}
      <div class="modal-section">
        <h4>Pharmacy Information</h4>
        ${demoPharmacy ? this.row('Store', demoPharmacy.storeName) : this.row('Name', d.label)}
        ${demoPharmacy ? this.row('Chain', demoPharmacy.chain) : ''}
        ${demoPharmacy ? this.row('Type', demoPharmacy.pharmacyType) : ''}
        ${demoPharmacy ? this.row('NPI', demoPharmacy.npi) : ''}
        ${demoPharmacy ? this.row('NCPDP', demoPharmacy.ncpdpId) : ''}
        ${demoPharmacy ? this.row('Phone', demoPharmacy.phone) : ''}
      </div>
    `;

    if (demoPharmacy && demoPharmacy.address) {
      sections += `
        <div class="modal-section">
          <h4>Location</h4>
          ${this.row('Address', demoPharmacy.address)}
          ${this.row('City/State', `${demoPharmacy.city}, ${demoPharmacy.state}`)}
        </div>
      `;
    }

    // NCPDP prescription lifecycle:
    //   ACTIVE → Dispense (pharmacy prepares medication) or Fill (direct adjudication) or Reject
    //   DISPENSED → Fill (member presents credential, picks up — completes the claim)
    //   FILLED → Reverse only
    //   REVERSED, CANCELLED, REJECTED → terminal
    const rxs = (state?.prescriptions || []).filter(rx => rx.pharmacyIndex === idx);
    const active = rxs.filter(rx => rx.status === 'ACTIVE' || rx.status === 'PARTIALLY_FILLED');
    const dispensed = rxs.filter(rx => rx.status === 'DISPENSED');
    const terminal = rxs.filter(rx => rx.status === 'FILLED' || rx.status === 'COMPLETED' || rx.status === 'REVERSED' || rx.status === 'CANCELLED' || rx.status === 'REJECTED');

    // Capabilities summary — always visible
    sections += `
      <div class="modal-section">
        <h4>Prescription Queue (${rxs.length})</h4>
        ${rxs.length === 0 ? `
          <div style="font-size:11px;color:var(--text-muted);padding:4px 0;">No prescriptions routed to this pharmacy yet. A prescriber must write an Rx and select this pharmacy.</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:6px;">
            <div style="margin-bottom:3px;">Available actions when scripts arrive:</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <span class="badge badge-info" style="font-size:8px;">Dispense</span>
              <span class="badge badge-success" style="font-size:8px;">Fill</span>
              <span class="badge badge-danger" style="font-size:8px;">Reject</span>
              <span class="badge badge-warning" style="font-size:8px;">Reverse</span>
            </div>
          </div>
        ` : `
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:4px;">
            Active: ${active.length} &middot; Dispensed: ${dispensed.length} &middot; Completed: ${terminal.length}
          </div>
        `}
      </div>
    `;

    if (active.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>Active Scripts (${active.length})</h4>
          ${active.map(rx => `
            <div class="rx-action-row rx-card" data-wallet-id="${rx.memberWalletId}">
              <div class="rx-info">
                <div class="rx-drug">${escapeHtml(rx.medication)} ${rx.medicationStrength || ''}</div>
                <div class="rx-meta">${escapeHtml(priv ? truncHash(rx.memberWalletId) : (rx.memberName || ''))} &middot; Qty: ${rx.quantity || 30}</div>
              </div>
              <button class="btn-action btn-fill" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.dispenseRx('${rx.id}', ${idx})">Dispense</button>
              <button class="btn-action btn-fill" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.fillRx('${rx.id}')">Fill</button>
              <button class="btn-action btn-reject" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.rejectRx('${rx.id}', ${idx})">Reject</button>
            </div>
          `).join('')}
          <div id="fill-status" class="action-status"></div>
          <div id="dispense-status" class="action-status"></div>
        </div>
      `;
    }

    // Dispensed — awaiting member pickup with credential
    if (dispensed.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>Awaiting Pickup (${dispensed.length})</h4>
          ${dispensed.map(rx => `
            <div class="rx-action-row rx-card" data-wallet-id="${rx.memberWalletId}">
              <div class="rx-info">
                <div class="rx-drug">${escapeHtml(rx.medication)} ${rx.medicationStrength || ''}</div>
                <div class="rx-meta">${escapeHtml(priv ? truncHash(rx.memberWalletId) : (rx.memberName || ''))} &middot; Qty: ${rx.quantity || 30}</div>
              </div>
              <span class="badge badge-warning" style="font-size:8px;margin-right:4px;">DISPENSED</span>
              <button class="btn-action btn-fill" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.fillRx('${rx.id}')">Fill (Pickup)</button>
              <button class="btn-action btn-reject" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.rejectRx('${rx.id}', ${idx})">Reject</button>
            </div>
          `).join('')}
          <div id="fill-status" class="action-status"></div>
        </div>
      `;
    }

    // Filled / terminal scripts
    if (terminal.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>Completed Scripts (${terminal.length})</h4>
          ${terminal.map(rx => `
            <div class="rx-action-row">
              <div class="rx-info">
                <div class="rx-drug">${escapeHtml(rx.medication)} ${rx.medicationStrength || ''}</div>
                <div class="rx-meta">${escapeHtml(priv ? truncHash(rx.memberWalletId) : (rx.memberName || ''))} &middot; Pt: ${formatCents(rx.patientPayCents)} / Plan: ${formatCents(rx.planPayCents)}</div>
              </div>
              <span class="badge ${this.rxStatusBadge(rx.status)}" style="font-size:8px;margin-right:4px;">${rx.status}</span>
              ${rx.status === 'FILLED' ? `<button class="btn-action btn-terminate" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.reverseRx('${rx.id}')">Reverse</button>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }

    // Credential verification — NFC auto-read + manual paste fallback
    sections += `
      <div class="modal-form">
        <h4>Verify Member</h4>
        <div id="nfc-verify-section">
          <div id="nfc-reader-status" class="nfc-status">
            <span class="nfc-icon">&#x1F4E1;</span>
            <span id="nfc-status-text">Checking NFC reader...</span>
          </div>
          <div id="nfc-verify-result" style="display:none;margin-top:8px;"></div>
        </div>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;font-size:11px;color:#888;">Manual credential paste</summary>
          <div class="form-group" style="margin-top:6px;">
            <textarea class="credential-textarea" id="verify-credential-json" rows="3" placeholder="Paste member credential JSON here..."></textarea>
          </div>
          <button class="btn-action btn-fill" id="btn-verify-credential">Verify Credential</button>
        </details>
        <div id="verify-status" class="action-status"></div>
      </div>
    `;

    // Drug Utilization Review (DUR) — on-demand per patient
    sections += `
      <div class="modal-section">
        <h4>Drug Utilization Review (DUR)</h4>
        <div class="form-group">
          <label>Patient Wallet ID</label>
          <input type="text" id="dur-wallet-id" placeholder="Paste wallet ID or scan NFC" style="font-family:monospace;font-size:10px;">
        </div>
        <button class="btn-action btn-report" id="btn-run-dur" style="padding:3px 8px;font-size:10px;">Run DUR Check</button>
        <div id="dur-results" style="margin-top:6px;"></div>
      </div>
    `;

    // Messaging — pharmacy can message members with prescriptions here
    const pharmMembers = [];
    const seenWallets = new Set();
    for (const rx of rxs) {
      if (rx.memberWalletId && !seenWallets.has(rx.memberWalletId)) {
        seenWallets.add(rx.memberWalletId);
        const enrolled = (state?.enrolledMembers || []).find(m => m.walletId === rx.memberWalletId);
        if (enrolled) pharmMembers.push(enrolled);
      }
    }

    sections += `
      <div class="modal-form${pharmMembers.length > 0 ? '' : ' form-disabled'}">
        <h4>Message Patient</h4>
        ${pharmMembers.length === 0 ? '<div style="font-size:10px;color:var(--accent-orange);margin-bottom:6px;">No patients with prescriptions at this pharmacy yet</div>' : ''}
        <div class="form-group">
          <label>Patient</label>
          <select id="pharmacy-msg-patient" ${pharmMembers.length === 0 ? 'disabled' : ''}>
            <option value="">${pharmMembers.length > 0 ? '— Select Patient —' : '— No patients —'}</option>
            ${pharmMembers.map(m => `<option value="${m.walletId}">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Subject</label>
          <input type="text" id="pharmacy-msg-subject" value="Prescription Update" placeholder="Subject" ${pharmMembers.length === 0 ? 'disabled' : ''}>
        </div>
        <div class="form-group">
          <label>Message</label>
          <textarea id="pharmacy-msg-body" rows="2" placeholder="Write your message..." ${pharmMembers.length === 0 ? 'disabled' : ''}></textarea>
        </div>
        <button class="btn-action btn-prescribe" id="btn-pharmacy-send-msg" data-pharmacy-index="${idx}" ${pharmMembers.length === 0 ? 'disabled' : ''}>Send Message</button>
        <div id="pharmacy-msg-status" class="action-status"></div>
      </div>
    `;

    // Dispensing summary
    if (rxs.length > 0) {
      const filledCount = rxs.filter(rx => rx.status === 'FILLED' || rx.status === 'COMPLETED').length;
      const pendingCount = active.length + dispensed.length;
      let totalPatient = 0, totalPlan = 0;
      for (const rx of rxs) {
        if (rx.patientPayCents) totalPatient += rx.patientPayCents;
        if (rx.planPayCents) totalPlan += rx.planPayCents;
      }

      sections += `
        <div class="modal-section">
          <h4>Dispensing Summary</h4>
          ${this.row('Total Prescriptions', rxs.length)}
          ${this.row('Filled', filledCount)}
          ${this.row('Pending', pendingCount)}
          ${totalPatient > 0 || totalPlan > 0 ? this.row('Patient Total', formatCents(totalPatient)) : ''}
          ${totalPatient > 0 || totalPlan > 0 ? this.row('Plan Total', formatCents(totalPlan)) : ''}
        </div>
      `;
    }

    sections += `
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('entity-modal').classList.add('hidden')">Close</button>
      </div>
    `;

    return sections;
  }

  // ─── Insurer Modal ─────────────────────────────────────
  renderInsurer(d, state) {
    const audit = state?.auditSummary || {};
    const plan = state?.demoData?.plan || {};
    const enrolledCount = state?.enrolledMembers?.length || 0;

    let sections = `
      ${this.titleRow('Insurer', 'insurer', '#ab47bc', 'I')}
      <div class="modal-section">
        <h4>Role</h4>
        ${this.row('Function', 'Attestation Authority')}
        ${this.row('Visibility', 'Opaque wallet IDs only')}
        ${this.row('Secrets Held', 'None')}
      </div>

      <div class="modal-section">
        <h4>Enrollment</h4>
        ${this.row('Enrolled Members', enrolledCount)}
        ${this.row('Enrollments Processed', audit.enrollmentCount ?? '—')}
        ${this.row('Terminations', audit.terminationCount ?? 0)}
      </div>
    `;

    if (plan.planId) {
      sections += `
        <div class="modal-section">
          <h4>Active Plan</h4>
          ${this.row('Plan ID', plan.planId)}
          ${this.row('Deductible', formatCents(plan.deductibleAmountCents))}
          ${this.row('OOP Max', formatCents(plan.oopMaxCents))}
          ${this.row('Benefit Max', formatCents(plan.annualBenefitMaxCents))}
          ${this.row('Formulary Size', plan.formularyCount ?? '—')}
        </div>
      `;
    }

    if (audit.totalPatientPayCents != null || audit.totalPlanPayCents != null) {
      sections += `
        <div class="modal-section">
          <h4>Claims Summary</h4>
          ${this.row('Prescriptions', audit.prescriptionCount ?? 0)}
          ${this.row('Fulfillments', audit.fulfillmentCount ?? 0)}
          ${this.row('Reversals', audit.reversalCount ?? 0)}
          ${this.row('Patient Paid', formatCents(audit.totalPatientPayCents))}
          ${this.row('Plan Paid', formatCents(audit.totalPlanPayCents))}
        </div>
      `;
    }

    // Prior auth queue
    const pendingPAs = (state?.priorAuths || []).filter(pa => pa.status === 'PENDING');
    if (pendingPAs.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>Pending Prior Authorizations (${pendingPAs.length})</h4>
          ${pendingPAs.map(pa => `
            <div class="rx-action-row">
              <div class="rx-info">
                <div class="rx-drug">${escapeHtml(pa.medicationName || 'Medication')}</div>
                <div class="rx-meta">Member: ${truncHash(pa.memberWalletId)} &middot; Prescriber: ${pa.prescriberName || ''}</div>
              </div>
              <button class="btn-action btn-approve" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.approvePa('${pa.id}')">Approve</button>
              <button class="btn-action btn-reject" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.denyPa('${pa.id}')">Deny</button>
            </div>
          `).join('')}
          <div id="pa-action-status" class="action-status"></div>
        </div>
      `;
    }

    // Formulary Management
    const medications = state?.demoData?.medications || [];
    sections += `
      <div class="modal-form">
        <h4>Formulary Management</h4>
        <div class="form-row">
          <div class="form-group">
            <label>Medication</label>
            <select id="formulary-medication">
              <option value="">— Select —</option>
              ${medications.map((m, i) => `<option value="${i}">${escapeHtml(m.brandName)} ${m.strength} (Tier ${m.tier})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Action</label>
            <select id="formulary-action">
              <option value="MODIFY">Modify</option>
              <option value="REMOVE">Remove</option>
              <option value="ADD">Add</option>
            </select>
          </div>
        </div>
        <div class="form-row" id="formulary-modify-fields">
          <div class="form-group">
            <label>New Tier</label>
            <select id="formulary-tier">
              <option value="1">Tier 1 (Generic)</option>
              <option value="2">Tier 2 (Preferred Brand)</option>
              <option value="3">Tier 3 (Non-Preferred)</option>
              <option value="4">Tier 4 (Specialty)</option>
            </select>
          </div>
          <div class="form-group">
            <label>PA Required</label>
            <select id="formulary-pa">
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </div>
        </div>
        <button class="btn-action btn-prescribe" id="btn-update-formulary">Update Formulary</button>
        <div id="formulary-status" class="action-status"></div>
      </div>
    `;

    // Plan Year Rollover
    sections += `
      <div class="modal-form">
        <h4>Plan Year Rollover</h4>
        <div style="font-size:10px;color:var(--accent-orange);margin-bottom:6px;">Warning: This resets all member accumulators to zero</div>
        <div class="form-group">
          <label>New Plan Year</label>
          <input type="text" id="rollover-year" value="${new Date().getFullYear() + 1}" placeholder="e.g., 2027" style="width:80px;">
        </div>
        <button class="btn-action btn-terminate" id="btn-plan-rollover">Execute Rollover</button>
        <div id="rollover-status" class="action-status"></div>
      </div>
    `;

    // Reporting tabs (with audit tab added)
    sections += `
      <div class="modal-section">
        <h4>Reporting</h4>
        <div class="report-tabs">
          <button class="report-tab active" data-tab="by-member" onclick="window._entityModal.switchReportTab('by-member')">By Member</button>
          <button class="report-tab" data-tab="by-pharmacy" onclick="window._entityModal.switchReportTab('by-pharmacy')">By Pharmacy</button>
          <button class="report-tab" data-tab="by-prescriber" onclick="window._entityModal.switchReportTab('by-prescriber')">By Prescriber</button>
          <button class="report-tab" data-tab="audit" onclick="window._entityModal.switchReportTab('audit')">Audit Log</button>
          <button class="report-tab" data-tab="chain-state" onclick="window._entityModal.switchReportTab('chain-state')">Chain State</button>
        </div>
        <div id="report-content" class="report-content">
          <div class="report-loading"><span class="action-spinner"></span> Loading...</div>
        </div>
      </div>
    `;

    // Chain Actions — expanded
    sections += `
      <div class="modal-section">
        <h4>Chain Actions</h4>
        <div class="operation-group">
          <div class="operation-group-label">Batch Management</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn-action btn-report" id="btn-force-batch-insurer">Force Batch</button>
            <button class="btn-action btn-prescribe" id="btn-retry-batch-insurer">Retry Failed Batch</button>
            <button class="btn-action btn-terminate" id="btn-simulate-failure-insurer">Simulate Failure</button>
          </div>
        </div>
        <div class="operation-group">
          <div class="operation-group-label">Persistence</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn-action btn-checkpoint" id="btn-save-checkpoint-insurer">Save Checkpoint</button>
          </div>
        </div>
        <div id="batch-status-insurer" class="action-status"></div>
      </div>
    `;

    sections += `
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('entity-modal').classList.add('hidden')">Close</button>
      </div>
    `;

    return sections;
  }

  // ─── Employer Modal ────────────────────────────────────
  renderEmployer(d, state) {
    const token = state?.demoData?.token || {};
    const enrolledCount = state?.enrolledMembers?.length || 0;
    const members = state?.demoData?.members || [];
    const priv = PrivacyMode.isActive();

    const families = new Map();
    for (const m of members) {
      if (!families.has(m.familyId)) families.set(m.familyId, []);
      families.get(m.familyId).push(m);
    }

    let sections = `
      ${this.titleRow('Employer', 'employer', '#ffee58', 'E')}
      <div class="modal-section">
        <h4>Role</h4>
        ${this.row('Function', 'Token Authority')}
        ${this.row('Responsibility', 'Group enrollment tokens')}
      </div>

      <div class="modal-section">
        <h4>Group Enrollment</h4>
        ${this.row('Group ID', token.groupId || '—')}
        ${this.row('Plan ID', token.planId || '—')}
        ${this.row('Valid Until', token.validUntil || '—')}
        ${this.row('Total Roster', members.length)}
        ${this.row('Enrolled', enrolledCount)}
        ${this.row('Families', families.size)}
      </div>
    `;

    if (families.size > 0) {
      let famIdx = 0;
      sections += `
        <div class="modal-section">
          <h4>Roster by Family</h4>
          ${Array.from(families.entries()).map(([famId, fam]) => {
            const enrolledFam = fam.filter(m =>
              state?.enrolledMembers?.some(em => em.memberIndex === m.index)
            );
            const displayFamId = priv ? `Family F-${famIdx++}` : escapeHtml(famId);
            return `
              <div class="modal-row">
                <span class="label">${displayFamId}</span>
                <span class="value">${enrolledFam.length}/${fam.length} enrolled</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Family enrollment — find subscribers (relationship=subscriber) that aren't enrolled yet
    if (families.size > 0) {
      const subscribers = members.filter(m =>
        (m.relationship === 'subscriber' || m.relationship === 'Subscriber') &&
        !state?.enrolledMembers?.some(em => em.memberIndex === m.index)
      );

      if (subscribers.length > 0) {
        sections += `
          <div class="modal-form">
            <h4>Family Enrollment</h4>
            <div style="font-size:10px;color:var(--text-secondary);margin-bottom:6px;">Enroll a subscriber and all their dependents in one ceremony</div>
            <div class="form-group">
              <label>Subscriber</label>
              <select id="family-subscriber">
                <option value="">— Select Subscriber —</option>
                ${subscribers.map(m => {
                  const family = families.get(m.familyId) || [];
                  const depCount = family.length - 1;
                  const label = priv ? `Member #${m.index}` : escapeHtml(m.firstName + ' ' + m.lastName);
                  return `<option value="${m.index}">${label} (${depCount} dependent${depCount !== 1 ? 's' : ''})</option>`;
                }).join('')}
              </select>
            </div>
            <button class="btn-action btn-enroll" id="btn-enroll-family">Enroll Family</button>
            <div id="family-enroll-status" class="action-status"></div>
          </div>
        `;
      }
    }

    // Terminate group
    if (token.groupId && enrolledCount > 0) {
      sections += `
        <div class="modal-section">
          <h4>Administration</h4>
          <button class="btn-action btn-terminate" id="btn-terminate-group" data-group-id="${token.groupId}">Terminate Group</button>
          <div id="terminate-group-status" class="action-status"></div>
        </div>
      `;
    }

    sections += `
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('entity-modal').classList.add('hidden')">Close</button>
      </div>
    `;

    return sections;
  }

  // ─── Generic ───────────────────────────────────────────
  renderGeneric(d) {
    return `
      ${this.titleRow(d.label || d.id, d.entityType || 'unknown', '#6b7280', '?')}
      <div class="modal-section">
        <h4>Details</h4>
        ${this.row('ID', d.id)}
        ${this.row('Type', d.entityType || 'Unknown')}
        ${d.sublabel ? this.row('Info', d.sublabel) : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('entity-modal').classList.add('hidden')">Close</button>
      </div>
    `;
  }

  // ─── Action Bindings ───────────────────────────────────
  bindActions(type, d, state) {
    // Expose modal instance globally for onclick handlers
    window._entityModal = this;

    if (type === 'member') {
      this.bindMemberActions(d, state);
    } else if (type === 'prescriber') {
      this.bindPrescriberActions(d, state);
    } else if (type === 'pharmacy') {
      this.bindPharmacyActions(d, state);
    } else if (type === 'insurer') {
      this.bindInsurerActions(d, state);
    } else if (type === 'employer') {
      this.bindEmployerActions(d, state);
    }
  }

  bindMemberActions(d, state) {
    const idx = d.memberIndex;
    const enrolled = state?.enrolledMembers?.find(m => m.memberIndex === idx);

    // Enroll
    const enrollBtn = document.getElementById('btn-member-enroll');
    if (enrollBtn) {
      enrollBtn.addEventListener('click', () => this.enrollMember(idx));
    }

    // Assign PCP
    const pcpBtn = document.getElementById('btn-assign-pcp');
    if (pcpBtn && enrolled) {
      pcpBtn.addEventListener('click', () => {
        const select = document.getElementById('select-pcp');
        const prescriberIndex = parseInt(select?.value, 10);
        if (isNaN(prescriberIndex)) {
          this.showStatus('pcp-status', 'Please select a provider', 'error');
          return;
        }
        this.assignPcp(enrolled.walletId, prescriberIndex);
      });
    }

    // Generate credential
    const credBtn = document.getElementById('btn-gen-credential');
    if (credBtn && enrolled) {
      credBtn.addEventListener('click', () => this.generateCredential(enrolled.walletId));

      // If a credential generation is in-flight for this member, show pending status
      if (this._pendingCredentialWalletId === enrolled.walletId) {
        credBtn.disabled = true;
        credBtn.innerHTML = '<span class="action-spinner"></span> Generating...';
        this.showStatus('credential-status', 'Generating ZK proof — this takes ~30s. You can close this modal.', 'info');
      }
    }

    // Copy credential
    const copyBtn = document.getElementById('btn-copy-credential');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const textarea = document.getElementById('credential-json');
        navigator.clipboard.writeText(textarea.value).then(() => {
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; copyBtn.classList.remove('copied'); }, 2000);
        });
      });
    }

    // Write to NFC Tag
    const nfcBtn = document.getElementById('btn-write-nfc');
    if (nfcBtn && enrolled) {
      nfcBtn.addEventListener('click', () => {
        const walletId = nfcBtn.dataset.walletId;
        nfcBtn.disabled = true;
        nfcBtn.textContent = 'Queuing...';
        this.showStatus('nfc-write-status', 'Sending write request...', 'info');

        fetch('/interactive/nfc/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletId }),
        }).then(res => {
          if (!res.ok) return res.json().then(e => { throw new Error(e.error || 'NFC write failed'); });
          return res.json();
        }).then((result) => {
          const isAttestation = result.format === 'attestation';
          nfcBtn.textContent = 'Place tag on reader...';
          this.showStatus('nfc-write-status',
            isAttestation
              ? 'Place NFC tag on reader — writing Ed25519-signed credential attestation.'
              : 'Place NFC tag on reader to write wallet identity.',
            'info');

          // Listen for write confirmation via NFC SSE
          const nfcEs = new EventSource('/interactive/nfc/events');
          const cleanup = () => { nfcEs.close(); };

          nfcEs.addEventListener('nfc:tag_written', (e) => {
            const data = JSON.parse(e.data);
            if (data.walletId === walletId) {
              nfcBtn.textContent = 'Written!';
              nfcBtn.classList.add('copied');
              this.showStatus('nfc-write-status',
                isAttestation
                  ? 'Credential attestation written (Ed25519 signed, 24h expiry).'
                  : 'Wallet identity written to NFC tag.',
                'success');
              cleanup();
              setTimeout(() => {
                nfcBtn.textContent = 'Write to NFC Tag';
                nfcBtn.disabled = false;
                nfcBtn.classList.remove('copied');
              }, 4000);
            }
          });

          nfcEs.addEventListener('nfc:error', (e) => {
            const data = JSON.parse(e.data);
            nfcBtn.textContent = 'Write to NFC Tag';
            nfcBtn.disabled = false;
            this.showStatus('nfc-write-status', `NFC error: ${data.error || 'Unknown error'}`, 'error');
            cleanup();
          });

          // Timeout after 60s
          setTimeout(() => {
            if (nfcBtn.disabled) {
              nfcBtn.textContent = 'Write to NFC Tag';
              nfcBtn.disabled = false;
              this.showStatus('nfc-write-status', 'Timed out waiting for tag. Try again.', 'error');
              cleanup();
              fetch('/interactive/nfc/cancel', { method: 'POST' }).catch(() => {});
            }
          }, 60000);
        }).catch(err => {
          nfcBtn.textContent = 'Write to NFC Tag';
          nfcBtn.disabled = false;
          this.showStatus('nfc-write-status', err.message, 'error');
        });
      });
    }

    // Send message to PCP
    const msgBtn = document.getElementById('btn-member-send-msg');
    if (msgBtn && enrolled) {
      msgBtn.addEventListener('click', () => {
        const subject = document.getElementById('member-msg-subject')?.value?.trim();
        const body = document.getElementById('member-msg-body')?.value?.trim();
        const prescriberIndex = parseInt(msgBtn.dataset.prescriberIndex, 10);

        if (!subject || !body) {
          this.showStatus('member-msg-status', 'Please enter subject and message', 'error');
          return;
        }
        this.sendMemberMessage(enrolled.walletId, prescriberIndex, subject, body);
      });
    }

    // Load threads
    const threadsBtn = document.getElementById('btn-load-threads');
    if (threadsBtn && enrolled) {
      threadsBtn.addEventListener('click', () => this.loadMemberThreads(enrolled.walletId));
    }

    // Create delegation
    const delegBtn = document.getElementById('btn-create-delegation');
    if (delegBtn && enrolled) {
      delegBtn.addEventListener('click', () => {
        const delegateWalletId = document.getElementById('delegation-delegate')?.value;
        const scopeCheckboxes = document.querySelectorAll('.delegation-scope input:checked');
        const scopeFlags = Array.from(scopeCheckboxes).reduce((sum, cb) => sum + parseInt(cb.value, 10), 0);
        const relationshipCode = parseInt(document.getElementById('delegation-relationship')?.value, 10);

        if (!delegateWalletId) {
          this.showStatus('delegation-status', 'Please select a delegate', 'error');
          return;
        }
        this.createDelegation(enrolled.walletId, delegateWalletId, scopeFlags || 1, relationshipCode || 1);
      });
    }

    // Load claims
    const claimsBtn = document.getElementById('btn-load-claims');
    if (claimsBtn && enrolled) {
      claimsBtn.addEventListener('click', () => this.loadMemberClaims(enrolled.walletId));
    }

    // Terminate
    const termBtn = document.getElementById('btn-terminate-member');
    if (termBtn && enrolled) {
      termBtn.addEventListener('click', () => this.terminateMember(enrolled.walletId));
    }
  }

  bindPrescriberActions(d, state) {
    const idx = d.prescriberIndex;

    // Send message to patient
    const msgBtn = document.getElementById('btn-prescriber-send-msg');
    if (msgBtn) {
      msgBtn.addEventListener('click', () => {
        const patientWalletId = document.getElementById('prescriber-msg-patient')?.value;
        const subject = document.getElementById('prescriber-msg-subject')?.value?.trim();
        const body = document.getElementById('prescriber-msg-body')?.value?.trim();

        if (!patientWalletId || !subject || !body) {
          this.showStatus('prescriber-msg-status', 'Please fill all fields', 'error');
          return;
        }
        this.sendPrescriberMessage(idx, patientWalletId, subject, body);
      });
    }

    // Write prescription
    const rxBtn = document.getElementById('btn-prescribe');
    if (rxBtn) {
      rxBtn.addEventListener('click', () => {
        const patient = document.getElementById('rx-patient')?.value;
        const med = parseInt(document.getElementById('rx-medication')?.value, 10);
        const pharm = parseInt(document.getElementById('rx-pharmacy')?.value, 10);
        const qty = parseInt(document.getElementById('rx-quantity')?.value, 10) || 30;
        const refills = parseInt(document.getElementById('rx-refills')?.value, 10) || 3;

        if (!patient || isNaN(med) || isNaN(pharm)) {
          this.showStatus('prescribe-status', 'Please fill all required fields', 'error');
          return;
        }
        this.writePrescription(idx, patient, med, pharm, qty, refills);
      });
    }

    // Request prior auth
    const paBtn = document.getElementById('btn-request-pa');
    if (paBtn) {
      paBtn.addEventListener('click', () => {
        const patient = document.getElementById('pa-patient')?.value;
        const med = parseInt(document.getElementById('pa-medication')?.value, 10);
        if (!patient || isNaN(med)) {
          this.showStatus('pa-status', 'Please select patient and medication', 'error');
          return;
        }
        this.requestPriorAuth(patient, idx, med);
      });
    }
  }

  bindPharmacyActions(d, state) {
    // Verify credential (manual paste fallback)
    const verifyBtn = document.getElementById('btn-verify-credential');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', () => {
        const json = document.getElementById('verify-credential-json')?.value;
        if (!json || !json.trim()) {
          this.showStatus('verify-status', 'Please paste credential JSON', 'error');
          return;
        }
        this.verifyCredential(json);
      });
    }

    // DUR check
    const durBtn = document.getElementById('btn-run-dur');
    if (durBtn) {
      durBtn.addEventListener('click', () => {
        const walletId = document.getElementById('dur-wallet-id')?.value?.trim();
        if (!walletId) {
          document.getElementById('dur-results').innerHTML = '<div style="color:var(--accent-red);font-size:11px;">Please enter a wallet ID</div>';
          return;
        }
        this.runDurCheck(walletId);
      });
    }

    // Send message to patient
    const pharmMsgBtn = document.getElementById('btn-pharmacy-send-msg');
    if (pharmMsgBtn) {
      pharmMsgBtn.addEventListener('click', () => {
        const patientWalletId = document.getElementById('pharmacy-msg-patient')?.value;
        const subject = document.getElementById('pharmacy-msg-subject')?.value?.trim();
        const body = document.getElementById('pharmacy-msg-body')?.value?.trim();
        const pharmacyIndex = parseInt(pharmMsgBtn.dataset.pharmacyIndex, 10);

        if (!patientWalletId) {
          this.showStatus('pharmacy-msg-status', 'Please select a patient', 'error');
          return;
        }
        if (!subject || !body) {
          this.showStatus('pharmacy-msg-status', 'Please enter subject and message', 'error');
          return;
        }
        this.sendPharmacyMessage(pharmacyIndex, patientWalletId, subject, body);
      });
    }

    // NFC auto-read — connect SSE and listen for tag events
    const nfcSection = document.getElementById('nfc-verify-section');
    if (nfcSection) {
      this._connectPharmacyNfc(d, state);
    }
  }

  /** Connect NFC SSE for pharmacy modal — auto-verify on tag read */
  _connectPharmacyNfc(d, state) {
    const statusEl = document.getElementById('nfc-reader-status');
    const statusText = document.getElementById('nfc-status-text');
    const resultEl = document.getElementById('nfc-verify-result');

    // Check NFC reader availability first
    fetch('/interactive/nfc/status').then(r => r.json()).then(status => {
      if (status.state === 'disconnected' || status.error) {
        statusText.textContent = 'NFC reader not detected — use manual paste below';
        statusEl.classList.add('nfc-unavailable');
        return;
      }
      statusText.textContent = 'Tap member NFC tag to verify...';
      statusEl.classList.add('nfc-scanning');
      this._startNfcSse(d, state, statusEl, statusText, resultEl);
    }).catch(() => {
      statusText.textContent = 'NFC reader not available — use manual paste below';
      statusEl.classList.add('nfc-unavailable');
    });
  }

  /** Start NFC SSE event stream for pharmacy verification */
  _startNfcSse(d, state, statusEl, statusText, resultEl) {
    const nfcEs = new EventSource('/interactive/nfc/events');

    // Store reference for cleanup on modal close
    this._nfcEventSource = nfcEs;

    nfcEs.addEventListener('nfc:tag_detected', () => {
      statusText.textContent = 'Tag detected — reading...';
      statusEl.className = 'nfc-status nfc-reading';
    });

    nfcEs.addEventListener('nfc:tag_read', (e) => {
      const data = JSON.parse(e.data);
      if (data.verified) {
        const att = data.attestationDetails;
        const memberName = this._escapeHtml(data.memberName || 'Member');
        const walletShort = data.walletId ? ('W-' + data.walletId.slice(0, 8) + '...' + data.walletId.slice(-4)) : '';

        statusText.textContent = `Verified — ${data.memberName || data.walletId}`;
        statusEl.className = 'nfc-status nfc-verified';
        resultEl.style.display = 'block';

        if (att) {
          // Attestation-verified (Ed25519 signature — instant)
          const expiryDate = new Date(att.expiresAt * 1000);
          const expiryStr = expiryDate.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          resultEl.innerHTML = `
            <div class="nfc-verified-badge">
              <span class="nfc-check">&#x2713;</span>
              <div>
                <div style="font-weight:600;font-size:12px;">${memberName}</div>
                <div style="font-size:10px;color:#aaa;font-family:monospace;">${walletShort}</div>
                <div class="nfc-attestation-details">
                  <span class="nfc-att-tag">Ed25519 &#x2713;</span>
                  <span class="nfc-att-tag">ACTIVE</span>
                  <span class="nfc-att-tag">Exp: ${expiryStr}</span>
                </div>
              </div>
            </div>
          `;
        } else {
          // Legacy ZK proof verification
          resultEl.innerHTML = `
            <div class="nfc-verified-badge">
              <span class="nfc-check">&#x2713;</span>
              <div>
                <div style="font-weight:600;font-size:12px;">${memberName}</div>
                <div style="font-size:10px;color:#aaa;font-family:monospace;">${walletShort}</div>
                <div class="nfc-attestation-details">
                  <span class="nfc-att-tag">ZK Proof &#x2713;</span>
                </div>
              </div>
            </div>
          `;
        }
        // Highlight this member's scripts in the pharmacy modal
        this._highlightMemberScripts(data.walletId);
      } else {
        const att = data.attestationDetails;
        let reason = data.error || 'Credential verification failed';
        if (att) {
          if (att.revoked) reason = 'Attestation revoked — member has been terminated';
          else if (att.expired) reason = 'Attestation expired — member needs to re-generate credential';
          else if (!att.signatureValid) reason = 'Invalid Ed25519 signature — tag may be tampered';
        }
        statusText.textContent = 'Tag read — verification failed';
        statusEl.className = 'nfc-status nfc-error';
        resultEl.style.display = 'block';
        resultEl.innerHTML = `<div class="nfc-error-msg">${this._escapeHtml(reason)}</div>`;
      }
    });

    nfcEs.addEventListener('nfc:tag_removed', () => {
      statusText.textContent = 'Tap member NFC tag to verify...';
      statusEl.className = 'nfc-status nfc-scanning';
      resultEl.style.display = 'none';
      resultEl.innerHTML = '';
      // Remove script highlights
      this._unhighlightMemberScripts();
    });

    nfcEs.addEventListener('nfc:error', (e) => {
      const data = JSON.parse(e.data);
      statusText.textContent = `NFC error: ${data.error || 'Unknown'}`;
      statusEl.className = 'nfc-status nfc-error';
    });

    nfcEs.addEventListener('nfc:status', (e) => {
      const data = JSON.parse(e.data);
      if (data.state === 'disconnected') {
        statusText.textContent = 'NFC reader disconnected';
        statusEl.className = 'nfc-status nfc-unavailable';
      }
    });

    nfcEs.onerror = () => {
      // SSE connection lost — will auto-reconnect
      statusText.textContent = 'NFC connection interrupted — reconnecting...';
    };
  }

  /** Highlight scripts belonging to a verified NFC member */
  _highlightMemberScripts(walletId) {
    document.querySelectorAll('.rx-card').forEach(card => {
      const cardWallet = card.dataset?.walletId;
      if (cardWallet === walletId) {
        card.classList.add('nfc-member-highlight');
      }
    });
  }

  /** Remove NFC member script highlights */
  _unhighlightMemberScripts() {
    document.querySelectorAll('.nfc-member-highlight').forEach(el => {
      el.classList.remove('nfc-member-highlight');
    });
  }

  /** HTML escape utility */
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  bindInsurerActions(d, state) {
    // Force batch
    const batchBtn = document.getElementById('btn-force-batch-insurer');
    if (batchBtn) {
      batchBtn.addEventListener('click', () => this.forceBatch('batch-status-insurer'));
    }

    // Retry failed batch
    const retryBtn = document.getElementById('btn-retry-batch-insurer');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.retryFailedBatch('batch-status-insurer'));
    }

    // Simulate batch failure
    const simBtn = document.getElementById('btn-simulate-failure-insurer');
    if (simBtn) {
      simBtn.addEventListener('click', () => this.simulateBatchFailure('batch-status-insurer'));
    }

    // Save checkpoint
    const checkpointBtn = document.getElementById('btn-save-checkpoint-insurer');
    if (checkpointBtn) {
      checkpointBtn.addEventListener('click', () => this.saveCheckpoint('batch-status-insurer'));
    }

    // Update formulary
    const formularyBtn = document.getElementById('btn-update-formulary');
    if (formularyBtn) {
      formularyBtn.addEventListener('click', () => this.updateFormulary());
    }

    // Plan year rollover
    const rolloverBtn = document.getElementById('btn-plan-rollover');
    if (rolloverBtn) {
      rolloverBtn.addEventListener('click', () => this.planYearRollover());
    }

    // Show/hide modify fields based on action
    const actionSelect = document.getElementById('formulary-action');
    if (actionSelect) {
      actionSelect.addEventListener('change', () => {
        const modifyFields = document.getElementById('formulary-modify-fields');
        if (modifyFields) modifyFields.style.display = actionSelect.value === 'MODIFY' ? '' : 'none';
      });
    }

    // Load initial report
    this.switchReportTab('by-member');
  }

  bindEmployerActions(d, state) {
    // Family enrollment
    const familyBtn = document.getElementById('btn-enroll-family');
    if (familyBtn) {
      familyBtn.addEventListener('click', () => {
        const subscriberIndex = parseInt(document.getElementById('family-subscriber')?.value, 10);
        if (isNaN(subscriberIndex)) {
          this.showStatus('family-enroll-status', 'Please select a subscriber', 'error');
          return;
        }
        this.enrollFamily(subscriberIndex);
      });
    }

    const termBtn = document.getElementById('btn-terminate-group');
    if (termBtn) {
      termBtn.addEventListener('click', () => {
        const groupId = termBtn.dataset.groupId;
        this.terminateGroup(groupId);
      });
    }
  }

  // ─── API Action Methods ────────────────────────────────

  async enrollMember(memberIndex) {
    const btn = document.getElementById('btn-member-enroll');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Enrolling...'; }
    this.showStatus('enroll-status', 'Generating enrollment proof...', 'info');

    try {
      const res = await fetch('/interactive/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIndex }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Enrollment failed');
      }

      // Poll for completion
      this.pollAsync(
        `/interactive/enroll-status?memberIndex=${memberIndex}`,
        'enroll-status',
        btn,
        'Enroll Member',
      );
    } catch (err) {
      this.showStatus('enroll-status', err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Enroll Member'; }
    }
  }

  async assignPcp(walletId, prescriberIndex) {
    const btn = document.getElementById('btn-assign-pcp');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Assigning...'; }

    try {
      const res = await fetch('/interactive/assign-pcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberWalletId: walletId, prescriberIndex }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'PCP assignment failed');
      }

      this.showStatus('pcp-status', 'PCP assigned successfully', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('pcp-status', err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Assign PCP'; }
    }
  }

  async generateCredential(walletId) {
    const btn = document.getElementById('btn-gen-credential');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Generating...'; }
    this.showStatus('credential-status', 'Generating ZK proof — this takes ~30s. You can close this modal.', 'info');

    // Track which wallet has a pending credential generation
    this._pendingCredentialWalletId = walletId;

    try {
      const res = await fetch('/interactive/generate-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletId, proofType: 'holding' }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Credential generation failed');
      }

      // Poll for completion (continues even if modal is closed)
      this.pollCredential(walletId, 'holding');
    } catch (err) {
      this.showStatus('credential-status', err.message, 'error');
      this._pendingCredentialWalletId = null;
      if (btn) { btn.disabled = false; btn.textContent = 'Generate Credential'; }
    }
  }

  async pollCredential(walletId, proofType) {
    const poll = async () => {
      try {
        const res = await fetch(`/interactive/credential-status?walletId=${encodeURIComponent(walletId)}&proofType=${proofType}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === 'complete') {
          this._pendingCredentialWalletId = null;

          // Update DOM if modal is still/again open
          this.showStatus('credential-status', 'Credential generated successfully', 'success');
          const btn = document.getElementById('btn-gen-credential');
          if (btn) { btn.disabled = false; btn.textContent = 'Regenerate Credential'; }

          // Show credential JSON (proof-only — no PHI/PII)
          const credJson = data.result?.credentialJson || data.result?.credential;
          const resultDiv = document.getElementById('credential-result');
          const textarea = document.getElementById('credential-json');
          if (resultDiv && textarea && credJson) {
            textarea.value = typeof credJson === 'string' ? credJson : JSON.stringify(credJson, null, 2);
            resultDiv.style.display = 'block';
          }

          // Refresh state so the credential persists on next modal open
          await this.refreshAfterAction();
          return;
        }
        if (data.status === 'error') {
          this._pendingCredentialWalletId = null;
          this.showStatus('credential-status', data.error || 'Generation failed', 'error');
          const btn = document.getElementById('btn-gen-credential');
          if (btn) { btn.disabled = false; btn.textContent = 'Generate Credential'; }
          return;
        }

        // Still pending — update status if modal is open
        this.showStatus('credential-status', 'Generating ZK proof — this takes ~30s. You can close this modal.', 'info');
        setTimeout(poll, 3000);
      } catch {
        setTimeout(poll, 5000);
      }
    };
    setTimeout(poll, 3000);
  }

  async terminateMember(walletId) {
    const btn = document.getElementById('btn-terminate-member');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Terminating...'; }

    try {
      const res = await fetch('/interactive/terminate-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberWalletId: walletId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Termination failed');
      }

      this.showStatus('terminate-status', 'Member terminated', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('terminate-status', err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Terminate Member'; }
    }
  }

  async writePrescription(prescriberIndex, memberWalletId, medicationIndex, pharmacyIndex, quantity, refills) {
    const btn = document.getElementById('btn-prescribe');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Writing Rx...'; }

    try {
      const res = await fetch('/interactive/prescribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriberIndex, memberWalletId, medicationIndex, pharmacyIndex, quantity, refills }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Prescription failed');
      }

      this.showStatus('prescribe-status', 'Prescription written successfully', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('prescribe-status', err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Write Prescription'; }
    }
  }

  async requestPriorAuth(memberWalletId, prescriberIndex, medicationIndex) {
    const btn = document.getElementById('btn-request-pa');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Requesting...'; }

    try {
      const res = await fetch('/interactive/request-prior-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberWalletId, prescriberIndex, medicationIndex }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Prior auth request failed');
      }

      this.showStatus('pa-status', 'Prior auth requested', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('pa-status', err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Request Prior Auth'; }
    }
  }

  async cancelRx(prescriptionId, prescriberIndex) {
    try {
      const res = await fetch('/interactive/update-rx-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriptionId, newStatus: 'CANCELLED', role: 'prescriber', actorIndex: prescriberIndex }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Cancel failed');
      }
      await this.refreshAfterAction();
    } catch (err) {
      alert('Cancel failed: ' + err.message);
    }
  }

  async fillRx(prescriptionId) {
    this.showStatus('fill-status', 'Starting fill...', 'info');

    try {
      const res = await fetch('/interactive/fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriptionId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Fill failed');
      }

      this.showStatus('fill-status', 'Generating fulfillment proof...', 'info');

      // Poll for completion
      this.pollAsync(
        `/interactive/fill-status?prescriptionId=${encodeURIComponent(prescriptionId)}`,
        'fill-status',
        null,
        null,
      );
    } catch (err) {
      this.showStatus('fill-status', err.message, 'error');
    }
  }

  async rejectRx(prescriptionId, pharmacyIndex) {
    try {
      const res = await fetch('/interactive/update-rx-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriptionId, newStatus: 'REJECTED', role: 'pharmacy', actorIndex: pharmacyIndex }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Reject failed');
      }
      await this.refreshAfterAction();
    } catch (err) {
      alert('Reject failed: ' + err.message);
    }
  }

  async dispenseRx(prescriptionId, pharmacyIndex) {
    this.showStatus('dispense-status', 'Dispensing...', 'info');
    try {
      const res = await fetch('/interactive/update-rx-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriptionId, newStatus: 'DISPENSED', role: 'pharmacy', actorIndex: pharmacyIndex }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Dispense failed');
      }
      this.showStatus('dispense-status', 'Dispensed successfully', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('dispense-status', err.message, 'error');
    }
  }

  async reverseRx(prescriptionId) {
    try {
      const res = await fetch('/interactive/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriptionId, reason: 'Manual reversal from dashboard' }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Reversal failed');
      }
      await this.refreshAfterAction();
    } catch (err) {
      alert('Reversal failed: ' + err.message);
    }
  }

  async verifyCredential(jsonStr) {
    const btn = document.getElementById('btn-verify-credential');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Verifying...'; }

    try {
      const res = await fetch('/interactive/verify-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialJson: jsonStr }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      const valid = data.valid !== false;
      this.showStatus('verify-status', valid ? 'Credential VALID' : 'Credential INVALID', valid ? 'success' : 'error');
    } catch (err) {
      this.showStatus('verify-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Verify Credential'; }
    }
  }

  async approvePa(priorAuthId) {
    this.showStatus('pa-action-status', 'Approving (generating proof)...', 'info');
    try {
      const res = await fetch('/interactive/approve-prior-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priorAuthId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Approval failed');
      }
      this.showStatus('pa-action-status', 'Prior auth approved', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('pa-action-status', err.message, 'error');
    }
  }

  async denyPa(priorAuthId) {
    try {
      const res = await fetch('/interactive/deny-prior-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priorAuthId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Denial failed');
      }
      await this.refreshAfterAction();
    } catch (err) {
      alert('Denial failed: ' + err.message);
    }
  }

  async forceBatch(statusId) {
    const statusEl = statusId || 'batch-status-insurer';
    this.showStatus(statusEl, 'Forcing batch...', 'info');

    try {
      const res = await fetch('/interactive/force-batch', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(statusEl, data.message, 'success');
        await this.refreshAfterAction();
      } else {
        this.showStatus(statusEl, data.error || 'Failed', 'error');
      }
    } catch (err) {
      this.showStatus(statusEl, err.message, 'error');
    }
  }

  async retryFailedBatch(statusId) {
    const statusEl = statusId || 'batch-status-insurer';
    this.showStatus(statusEl, 'Retrying failed batch...', 'info');

    try {
      const res = await fetch('/interactive/retry-batch', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(statusEl, data.message, 'success');
        await this.refreshAfterAction();
      } else {
        this.showStatus(statusEl, data.error || 'No failed batches to retry', 'error');
      }
    } catch (err) {
      this.showStatus(statusEl, err.message, 'error');
    }
  }

  async simulateBatchFailure(statusId) {
    const statusEl = statusId || 'batch-status-insurer';
    this.showStatus(statusEl, 'Simulating batch failure...', 'info');

    try {
      const res = await fetch('/interactive/simulate-batch-failure', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(statusEl, data.message, 'success');
        await this.refreshAfterAction();
      } else {
        this.showStatus(statusEl, data.error || 'No settled batches', 'error');
      }
    } catch (err) {
      this.showStatus(statusEl, err.message, 'error');
    }
  }

  async saveCheckpoint(statusId) {
    const statusEl = statusId || 'batch-status-insurer';
    this.showStatus(statusEl, 'Saving checkpoint...', 'info');

    try {
      const res = await fetch('/interactive/save-checkpoint', { method: 'POST' });
      const data = await res.json();

      if (data.ok) {
        this.showStatus(statusEl, data.message, 'success');
      } else {
        this.showStatus(statusEl, data.error || 'Failed', 'error');
      }
    } catch (err) {
      this.showStatus(statusEl, err.message, 'error');
    }
  }

  async updateFormulary() {
    const medIdx = parseInt(document.getElementById('formulary-medication')?.value, 10);
    const action = document.getElementById('formulary-action')?.value;

    if (isNaN(medIdx) || !action) {
      this.showStatus('formulary-status', 'Please select medication and action', 'error');
      return;
    }

    const btn = document.getElementById('btn-update-formulary');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Updating...'; }

    const payload = { medicationIndex: medIdx, action };
    if (action === 'MODIFY') {
      payload.newTier = parseInt(document.getElementById('formulary-tier')?.value, 10);
      payload.priorAuthRequired = document.getElementById('formulary-pa')?.value === 'true';
    }

    try {
      const res = await fetch('/interactive/update-formulary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Formulary update failed');
      }

      this.showStatus('formulary-status', `Formulary ${action.toLowerCase()} successful`, 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('formulary-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Update Formulary'; }
    }
  }

  async planYearRollover() {
    const year = document.getElementById('rollover-year')?.value?.trim();
    if (!year) {
      this.showStatus('rollover-status', 'Please enter plan year', 'error');
      return;
    }

    const btn = document.getElementById('btn-plan-rollover');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Rolling over...'; }

    try {
      const res = await fetch('/interactive/plan-year-rollover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPlanYear: year }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Rollover failed');
      }

      this.showStatus('rollover-status', `Plan year rolled over to ${year}`, 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('rollover-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Execute Rollover'; }
    }
  }

  async sendPrescriberMessage(prescriberIndex, memberWalletId, subject, body) {
    const btn = document.getElementById('btn-prescriber-send-msg');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Sending...'; }

    try {
      const res = await fetch('/interactive/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderType: 'prescriber',
          senderIndex: prescriberIndex,
          recipientType: 'member',
          recipientWalletId: memberWalletId,
          subject,
          body,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Send failed');
      }

      this.showStatus('prescriber-msg-status', 'Message sent', 'success');
      document.getElementById('prescriber-msg-body').value = '';
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('prescriber-msg-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Message'; }
    }
  }

  async sendPharmacyMessage(pharmacyIndex, memberWalletId, subject, body) {
    const btn = document.getElementById('btn-pharmacy-send-msg');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Sending...'; }

    try {
      const res = await fetch('/interactive/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderType: 'pharmacy',
          senderIndex: pharmacyIndex,
          recipientType: 'member',
          recipientWalletId: memberWalletId,
          subject,
          body,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Send failed');
      }

      this.showStatus('pharmacy-msg-status', 'Message sent', 'success');
      document.getElementById('pharmacy-msg-body').value = '';
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('pharmacy-msg-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Message'; }
    }
  }

  async sendMemberMessage(memberWalletId, prescriberIndex, subject, body) {
    const btn = document.getElementById('btn-member-send-msg');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Sending...'; }

    try {
      const res = await fetch('/interactive/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderType: 'member',
          senderWalletId: memberWalletId,
          recipientType: 'prescriber',
          recipientIndex: prescriberIndex,
          subject,
          body,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Send failed');
      }

      this.showStatus('member-msg-status', 'Message sent', 'success');
      document.getElementById('member-msg-body').value = '';
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('member-msg-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Message'; }
    }
  }

  async loadMemberThreads(walletId) {
    const container = document.getElementById('member-threads');
    if (!container) return;

    container.innerHTML = '<span class="action-spinner"></span> Loading threads...';

    try {
      const res = await fetch(`/interactive/threads?walletId=${encodeURIComponent(walletId)}`);
      if (!res.ok) throw new Error('Failed to load threads');
      const data = await res.json();

      const threads = data.threads || data || [];
      if (Array.isArray(threads) && threads.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);">No conversation threads yet</div>';
        return;
      }

      container.innerHTML = (Array.isArray(threads) ? threads : []).map(t => `
        <div class="message-thread" data-thread-id="${escapeHtml(t.threadId || t.id || '')}" data-wallet-id="${escapeHtml(walletId)}" onclick="window._entityModal.loadThreadMessages('${escapeHtml(walletId)}', ${JSON.stringify(t.messageIndices || [])})">
          <div class="message-thread-subject">${escapeHtml(t.subject || t.threadId || 'Thread')}</div>
          <div class="message-thread-meta">${t.messageCount || (t.messageIndices || []).length || 0} messages &middot; ${t.participants ? t.participants.join(', ') : ''}</div>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<div style="color:var(--accent-red);font-size:11px;">${escapeHtml(err.message)}</div>`;
    }
  }

  async loadThreadMessages(walletId, messageIndices) {
    const msgContainer = document.getElementById('member-thread-messages');
    if (!msgContainer) return;

    msgContainer.style.display = 'block';
    msgContainer.innerHTML = '<span class="action-spinner"></span> Decrypting...';

    try {
      const res = await fetch('/interactive/decrypt-thread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIndices, walletId }),
      });

      if (!res.ok) throw new Error('Decryption failed');
      const data = await res.json();

      const messages = data.messages || data || [];
      if (Array.isArray(messages) && messages.length === 0) {
        msgContainer.innerHTML = '<div style="color:var(--text-muted);font-size:11px;">No messages in thread</div>';
        return;
      }

      msgContainer.innerHTML = (Array.isArray(messages) ? messages : []).map(m => {
        const isSent = m.senderWalletId === walletId || m.senderType === 'member';
        const cls = isSent ? 'message-bubble message-bubble-sent' : 'message-bubble message-bubble-received';
        const sender = m.senderName || m.senderType || 'Unknown';
        const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        return `
          <div class="${cls}">
            <div class="message-bubble-sender">${escapeHtml(sender)}</div>
            ${escapeHtml(m.body || m.plaintext || '')}
            ${time ? `<div class="message-bubble-time">${time}</div>` : ''}
          </div>
        `;
      }).join('');
    } catch (err) {
      msgContainer.innerHTML = `<div style="color:var(--accent-red);font-size:11px;">${escapeHtml(err.message)}</div>`;
    }
  }

  async createDelegation(delegatorWalletId, delegateWalletId, scopeFlags, relationshipCode) {
    const btn = document.getElementById('btn-create-delegation');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Creating...'; }

    try {
      const res = await fetch('/interactive/create-delegation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegatorWalletId, delegateWalletId, scopeFlags, relationshipCode }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Delegation failed');
      }

      this.showStatus('delegation-status', 'Delegation created', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('delegation-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Create Delegation'; }
    }
  }

  async loadMemberClaims(walletId) {
    const container = document.getElementById('member-claims');
    if (!container) return;

    container.innerHTML = '<span class="action-spinner"></span> Loading claims...';

    try {
      const res = await fetch(`/node/claims-by-member?walletId=${encodeURIComponent(walletId)}`);
      if (!res.ok) throw new Error('Failed to load claims');
      const data = await res.json();

      const claims = data.claims || [];
      if (claims.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);">No claims in accumulator</div>';
        return;
      }

      let html = `<table class="report-table">
        <thead><tr><th>NDC Hash</th><th>Pharmacy</th><th>Patient</th><th>Plan</th></tr></thead>
        <tbody>`;

      for (const c of claims.slice(-20).reverse()) {
        const ndc = c.ndcHash ? truncHash(String(c.ndcHash)) : '—';
        const pharmacy = c.pharmacyWalletId ? truncHash(String(c.pharmacyWalletId)) : '—';
        html += `<tr>
          <td style="font-family:monospace;font-size:9px;">${ndc}</td>
          <td style="font-family:monospace;font-size:9px;">${pharmacy}</td>
          <td class="amount">${c.patientPayCents != null ? formatCents(c.patientPayCents) : '—'}</td>
          <td class="amount">${c.planPayCents != null ? formatCents(c.planPayCents) : '—'}</td>
        </tr>`;
      }

      html += '</tbody></table>';
      if (claims.length > 20) {
        html += `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Showing last 20 of ${claims.length} claims</div>`;
      }
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--accent-red);font-size:11px;">${escapeHtml(err.message)}</div>`;
    }
  }

  async runDurCheck(memberWalletId) {
    const container = document.getElementById('dur-results');
    if (!container) return;

    container.innerHTML = '<span class="action-spinner"></span> Running DUR check...';

    try {
      const res = await fetch(`/node/dur?memberWalletId=${encodeURIComponent(memberWalletId)}`);
      if (!res.ok) throw new Error('DUR check failed');
      const data = await res.json();

      const claims = data.claims || [];
      if (claims.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:11px;">No claims found for this member — no DUR flags</div>';
        return;
      }

      // Check for potential DUR flags: same drug from different prescribers
      const drugPrescribers = new Map();
      for (const c of claims) {
        const ndc = String(c.ndcHash || '');
        if (!drugPrescribers.has(ndc)) drugPrescribers.set(ndc, new Set());
        drugPrescribers.get(ndc).add(String(c.prescriberWalletId || ''));
      }

      const duplicateDrugs = Array.from(drugPrescribers.entries()).filter(([_, prescribers]) => prescribers.size > 1);

      let html = `<div style="font-size:10px;margin-bottom:4px;">${claims.length} claim${claims.length !== 1 ? 's' : ''} across all pharmacies</div>`;

      if (duplicateDrugs.length > 0) {
        html += duplicateDrugs.map(([ndc]) =>
          `<div class="dur-alert">DUR Flag: Same drug (${truncHash(ndc)}) prescribed by ${drugPrescribers.get(ndc).size} different prescribers</div>`
        ).join('');
      }

      html += `<table class="report-table" style="margin-top:6px;">
        <thead><tr><th>NDC</th><th>Prescriber</th><th>Patient</th><th>Plan</th></tr></thead>
        <tbody>`;

      for (const c of claims.slice(-10).reverse()) {
        html += `<tr>
          <td style="font-family:monospace;font-size:9px;">${truncHash(String(c.ndcHash || ''))}</td>
          <td style="font-family:monospace;font-size:9px;">${truncHash(String(c.prescriberWalletId || ''))}</td>
          <td class="amount">${c.patientPayCents != null ? formatCents(c.patientPayCents) : '—'}</td>
          <td class="amount">${c.planPayCents != null ? formatCents(c.planPayCents) : '—'}</td>
        </tr>`;
      }

      html += '</tbody></table>';
      if (claims.length > 10) {
        html += `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Showing last 10 of ${claims.length} claims</div>`;
      }
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--accent-red);font-size:11px;">${escapeHtml(err.message)}</div>`;
    }
  }

  async enrollFamily(subscriberIndex) {
    const btn = document.getElementById('btn-enroll-family');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Enrolling family...'; }
    this.showStatus('family-enroll-status', 'Enrolling subscriber + dependents — this may take a few minutes...', 'info');

    try {
      const res = await fetch('/interactive/enroll-family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberIndex }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Family enrollment failed');
      }

      this.showStatus('family-enroll-status', 'Family enrolled successfully', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('family-enroll-status', err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enroll Family'; }
    }
  }

  async terminateGroup(groupId) {
    const btn = document.getElementById('btn-terminate-group');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="action-spinner"></span> Terminating...'; }

    try {
      const res = await fetch('/interactive/terminate-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Group termination failed');
      }

      this.showStatus('terminate-group-status', 'Group terminated', 'success');
      await this.refreshAfterAction();
    } catch (err) {
      this.showStatus('terminate-group-status', err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Terminate Group'; }
    }
  }

  // ─── Reporting ─────────────────────────────────────────

  async switchReportTab(tab) {
    // Update active tab
    const tabs = this.modalEl.querySelectorAll('.report-tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

    const content = document.getElementById('report-content');
    if (!content) return;

    // Check cache
    if (this.reportCache[tab]) {
      content.innerHTML = this.reportCache[tab];
      return;
    }

    content.innerHTML = '<div class="report-loading"><span class="action-spinner"></span> Loading...</div>';

    const state = window._lastStateData ? window._lastStateData() : this.currentState;

    try {
      if (tab === 'by-member') {
        await this.loadMemberReport(content, state);
      } else if (tab === 'by-pharmacy') {
        await this.loadPharmacyReport(content, state);
      } else if (tab === 'by-prescriber') {
        await this.loadPrescriberReport(content, state);
      } else if (tab === 'audit') {
        await this.loadAuditLog(content);
      } else if (tab === 'chain-state') {
        await this.loadChainState(content);
      }
      this.reportCache[tab] = content.innerHTML;
    } catch (err) {
      content.innerHTML = `<div style="color:var(--accent-red);font-size:11px;padding:8px;">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  async loadMemberReport(container, state) {
    const members = state?.enrolledMembers || [];
    const priv = PrivacyMode.isActive();
    if (members.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px;">No enrolled members</div>';
      return;
    }

    // Aggregate from prescriptions in state
    const rxs = state?.prescriptions || [];
    let html = `<table class="report-table">
      <thead><tr><th>${priv ? 'Wallet' : 'Member'}</th><th>Rxs</th><th>Filled</th><th>Patient</th><th>Plan</th></tr></thead>
      <tbody>`;

    for (const m of members) {
      const memberRxs = rxs.filter(rx => rx.memberWalletId === m.walletId);
      const filledRxs = memberRxs.filter(rx => rx.status === 'FILLED' || rx.status === 'COMPLETED' || rx.status === 'DISPENSED');
      let ptTotal = 0, planTotal = 0;
      for (const rx of memberRxs) {
        if (rx.patientPayCents) ptTotal += rx.patientPayCents;
        if (rx.planPayCents) planTotal += rx.planPayCents;
      }

      html += `<tr>
        <td>${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</td>
        <td>${memberRxs.length}</td>
        <td>${filledRxs.length}</td>
        <td class="amount">${formatCents(ptTotal)}</td>
        <td class="amount">${formatCents(planTotal)}</td>
      </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  async loadPharmacyReport(container, state) {
    const pharmacies = state?.demoData?.pharmacies || [];
    const rxs = state?.prescriptions || [];

    let html = `<table class="report-table">
      <thead><tr><th>Pharmacy</th><th>Fills</th><th>Patient</th><th>Plan</th></tr></thead>
      <tbody>`;

    for (const p of pharmacies) {
      const pharmRxs = rxs.filter(rx => rx.pharmacyIndex === p.index);
      const filledRxs = pharmRxs.filter(rx => rx.status === 'FILLED' || rx.status === 'COMPLETED' || rx.status === 'DISPENSED');
      let ptTotal = 0, planTotal = 0;
      for (const rx of pharmRxs) {
        if (rx.patientPayCents) ptTotal += rx.patientPayCents;
        if (rx.planPayCents) planTotal += rx.planPayCents;
      }

      if (pharmRxs.length > 0) {
        html += `<tr>
          <td>${escapeHtml(p.storeName || p.chain)}</td>
          <td>${filledRxs.length}</td>
          <td class="amount">${formatCents(ptTotal)}</td>
          <td class="amount">${formatCents(planTotal)}</td>
        </tr>`;
      }
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  async loadPrescriberReport(container, state) {
    const prescribers = state?.demoData?.prescribers || [];
    const rxs = state?.prescriptions || [];

    let html = `<table class="report-table">
      <thead><tr><th>Prescriber</th><th>Rxs</th><th>Filled</th><th>Patient</th><th>Plan</th></tr></thead>
      <tbody>`;

    for (const p of prescribers) {
      const presRxs = rxs.filter(rx => rx.prescriberIndex === p.index);
      if (presRxs.length === 0) continue;
      const filledRxs = presRxs.filter(rx => rx.status === 'FILLED' || rx.status === 'COMPLETED' || rx.status === 'DISPENSED');
      let ptTotal = 0, planTotal = 0;
      for (const rx of presRxs) {
        if (rx.patientPayCents) ptTotal += rx.patientPayCents;
        if (rx.planPayCents) planTotal += rx.planPayCents;
      }

      html += `<tr>
        <td>${escapeHtml(p.firstName + ' ' + p.lastName)}</td>
        <td>${presRxs.length}</td>
        <td>${filledRxs.length}</td>
        <td class="amount">${formatCents(ptTotal)}</td>
        <td class="amount">${formatCents(planTotal)}</td>
      </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  async loadAuditLog(container) {
    try {
      const res = await fetch('/node/audit-log');
      if (!res.ok) throw new Error('Failed to fetch audit log');
      const data = await res.json();

      const events = data.events || [];
      if (events.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px;">No audit events yet</div>';
        return;
      }

      const chainIntegrity = data.chainIntegrity !== false ? 'VALID' : 'BROKEN';
      const integrityBadge = chainIntegrity === 'VALID' ? 'badge-success' : 'badge-danger';

      let html = `<div style="margin-bottom:6px;font-size:10px;">Chain Integrity: <span class="badge ${integrityBadge}">${chainIntegrity}</span> &middot; ${events.length} events</div>`;
      html += `<table class="report-table">
        <thead><tr><th>Seq</th><th>Type</th><th>Wallet</th><th>Block</th><th>Batch</th></tr></thead>
        <tbody>`;

      // Show most recent 20 events
      const recent = events.slice(-20).reverse();
      for (const e of recent) {
        const wallet = e.walletId ? truncHash(String(e.walletId)) : '—';
        const type = e.operationType || e.type || '—';
        html += `<tr>
          <td>${e.sequenceNumber ?? '—'}</td>
          <td style="font-size:9px;">${escapeHtml(String(type))}</td>
          <td style="font-family:monospace;font-size:9px;">${wallet}</td>
          <td>${e.l2BlockNumber ?? '—'}</td>
          <td>${e.l1BatchNumber ?? '—'}</td>
        </tr>`;
      }

      html += '</tbody></table>';
      if (events.length > 20) {
        html += `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Showing last 20 of ${events.length} events</div>`;
      }
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--accent-red);font-size:11px;padding:8px;">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  async loadChainState(container) {
    try {
      const res = await fetch('/node/chain-state');
      if (!res.ok) throw new Error('Failed to fetch chain state');
      const cs = await res.json();

      container.innerHTML = `
        <div class="chain-state-grid">
          <div class="chain-state-item">
            <div class="chain-state-label">Block Height</div>
            <div class="chain-state-value">${cs.blockHeight ?? '—'}</div>
          </div>
          <div class="chain-state-item">
            <div class="chain-state-label">Wallet Count</div>
            <div class="chain-state-value">${cs.currentWalletCount ?? '—'}</div>
          </div>
          <div class="chain-state-item">
            <div class="chain-state-label">Latest Batch</div>
            <div class="chain-state-value">${cs.latestBatchNumber ?? 'None'}</div>
          </div>
          <div class="chain-state-item">
            <div class="chain-state-label">Sequence #</div>
            <div class="chain-state-value">${cs.latestSequenceNumber ?? 0}</div>
          </div>
          <div class="chain-state-item">
            <div class="chain-state-label">Claim Leaf Count</div>
            <div class="chain-state-value">${cs.claimLeafCount ?? 0}</div>
          </div>
          <div class="chain-state-item">
            <div class="chain-state-label">Chain Proof</div>
            <div class="chain-state-value">${cs.chainProofEnabled ? 'Enabled' : 'Disabled'}</div>
          </div>
          <div class="chain-state-item" style="grid-column:span 2;">
            <div class="chain-state-label">Registry Root</div>
            <div class="chain-state-value" style="font-size:9px;">${cs.currentRegistryRoot ? truncHash(cs.currentRegistryRoot) : '—'}</div>
          </div>
          <div class="chain-state-item" style="grid-column:span 2;">
            <div class="chain-state-label">Lifecycle Root</div>
            <div class="chain-state-value" style="font-size:9px;">${cs.currentLifecycleRoot ? truncHash(cs.currentLifecycleRoot) : '—'}</div>
          </div>
          <div class="chain-state-item" style="grid-column:span 2;">
            <div class="chain-state-label">Global State Root</div>
            <div class="chain-state-value" style="font-size:9px;">${cs.globalStateRoot ? truncHash(cs.globalStateRoot) : '—'}</div>
          </div>
          <div class="chain-state-item" style="grid-column:span 2;">
            <div class="chain-state-label">Claim Accumulator Root</div>
            <div class="chain-state-value" style="font-size:9px;">${cs.claimAccumulatorRoot ? truncHash(String(cs.claimAccumulatorRoot)) : '—'}</div>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--accent-red);font-size:11px;padding:8px;">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ─── Async Polling Helper ──────────────────────────────

  pollAsync(url, statusId, btn, btnLabel) {
    const poll = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === 'complete') {
          this.showStatus(statusId, 'Complete!', 'success');
          if (btn && btnLabel) { btn.disabled = false; btn.textContent = btnLabel; }
          await this.refreshAfterAction();
          return;
        }
        if (data.status === 'error') {
          this.showStatus(statusId, data.error || 'Failed', 'error');
          if (btn && btnLabel) { btn.disabled = false; btn.textContent = btnLabel; }
          return;
        }

        // Still pending
        setTimeout(poll, 3000);
      } catch {
        setTimeout(poll, 5000);
      }
    };
    setTimeout(poll, 3000);
  }

  // ─── Helpers ───────────────────────────────────────────

  showStatus(id, message, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `action-status visible status-${type}`;
    el.textContent = message;
  }

  rxStatusBadge(status) {
    if (status === 'FILLED' || status === 'COMPLETED' || status === 'DISPENSED') return 'badge-success';
    if (status === 'ACTIVE' || status === 'PENDING') return 'badge-warning';
    if (status === 'CANCELLED' || status === 'REJECTED' || status === 'REVERSED') return 'badge-danger';
    return 'badge-info';
  }

  titleRow(name, type, color, letter) {
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    return `
      <div class="modal-title-row">
        <div class="modal-header-accent" style="background:${color};">${letter}</div>
        <div>
          <h2>${escapeHtml(name)}</h2>
          <div class="modal-type-label">${typeLabel}</div>
        </div>
      </div>
    `;
  }

  row(label, value) {
    return `
      <div class="modal-row">
        <span class="label">${escapeHtml(String(label))}</span>
        <span class="value">${value}</span>
      </div>
    `;
  }
}
