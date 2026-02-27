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

      // Credential generation
      sections += `
        <div class="modal-section">
          <h4>Portable Credential</h4>
          <button class="btn-action btn-prescribe" id="btn-gen-credential" data-wallet-id="${enrolled.walletId}">Generate Credential</button>
          <div id="credential-status" class="action-status"></div>
          <div id="credential-result" style="display:none;margin-top:8px;">
            <textarea class="credential-textarea" id="credential-json" rows="6" readonly></textarea>
            <button class="btn-copy" id="btn-copy-credential">Copy to Clipboard</button>
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

      // Write prescription form (only if has PCP patients)
      const medications = state?.demoData?.medications || [];
      const pharmacies = state?.demoData?.pharmacies || [];

      sections += `
        <div class="modal-form">
          <h4>Write Prescription</h4>
          <div class="form-group">
            <label>Patient</label>
            <select id="rx-patient">
              <option value="">— Select Patient —</option>
              ${assignedPatients.map(m => `<option value="${m.walletId}">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Medication</label>
              <select id="rx-medication">
                <option value="">— Select —</option>
                ${medications.map((m, i) => `<option value="${i}">${escapeHtml(m.brandName)} ${m.strength}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Pharmacy</label>
              <select id="rx-pharmacy">
                <option value="">— Select —</option>
                ${pharmacies.map((p, i) => `<option value="${i}">${escapeHtml(p.storeName || p.chain)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Quantity</label>
              <input type="number" id="rx-quantity" value="30" min="1" max="360">
            </div>
            <div class="form-group">
              <label>Refills</label>
              <input type="number" id="rx-refills" value="3" min="0" max="12">
            </div>
          </div>
          <button class="btn-action btn-prescribe" id="btn-prescribe" data-prescriber-index="${idx}">Write Prescription</button>
          <div id="prescribe-status" class="action-status"></div>
        </div>
      `;

      // Request prior auth form
      sections += `
        <div class="modal-form">
          <h4>Request Prior Authorization</h4>
          <div class="form-row">
            <div class="form-group">
              <label>Patient</label>
              <select id="pa-patient">
                <option value="">— Select —</option>
                ${assignedPatients.map(m => `<option value="${m.walletId}">${escapeHtml(priv ? PrivacyMode.memberLabel(m.displayName, m.memberIndex, m.walletId) : m.displayName)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Medication</label>
              <select id="pa-medication">
                <option value="">— Select —</option>
                ${medications.map((m, i) => `<option value="${i}">${escapeHtml(m.brandName)} ${m.strength}</option>`).join('')}
              </select>
            </div>
          </div>
          <button class="btn-action btn-prescribe" id="btn-request-pa" data-prescriber-index="${idx}">Request Prior Auth</button>
          <div id="pa-status" class="action-status"></div>
        </div>
      `;
    }

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

    // Active scripts to fill
    const rxs = (state?.prescriptions || []).filter(rx => rx.pharmacyIndex === idx);
    const fillable = rxs.filter(rx => rx.status === 'ACTIVE' || rx.status === 'PARTIALLY_FILLED');
    const filled = rxs.filter(rx => rx.status === 'FILLED' || rx.status === 'COMPLETED' || rx.status === 'DISPENSED');

    if (fillable.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>Active Scripts (${fillable.length})</h4>
          ${fillable.map(rx => `
            <div class="rx-action-row">
              <div class="rx-info">
                <div class="rx-drug">${escapeHtml(rx.medication)} ${rx.medicationStrength || ''}</div>
                <div class="rx-meta">${escapeHtml(priv ? truncHash(rx.memberWalletId) : (rx.memberName || ''))} &middot; Qty: ${rx.quantity || 30}</div>
              </div>
              <button class="btn-action btn-fill" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.fillRx('${rx.id}')">Fill</button>
              <button class="btn-action btn-reject" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.rejectRx('${rx.id}', ${idx})">Reject</button>
            </div>
          `).join('')}
          <div id="fill-status" class="action-status"></div>
        </div>
      `;
    }

    // Filled scripts (with reverse option)
    if (filled.length > 0) {
      sections += `
        <div class="modal-section">
          <h4>Filled Scripts (${filled.length})</h4>
          ${filled.map(rx => `
            <div class="rx-action-row">
              <div class="rx-info">
                <div class="rx-drug">${escapeHtml(rx.medication)} ${rx.medicationStrength || ''}</div>
                <div class="rx-meta">${escapeHtml(priv ? truncHash(rx.memberWalletId) : (rx.memberName || ''))} &middot; Pt: ${formatCents(rx.patientPayCents)} / Plan: ${formatCents(rx.planPayCents)}</div>
              </div>
              ${rx.status !== 'REVERSED' ? `<button class="btn-action btn-terminate" style="padding:3px 8px;font-size:9px;" onclick="window._entityModal.reverseRx('${rx.id}')">Reverse</button>` : '<span class="badge badge-danger">REVERSED</span>'}
            </div>
          `).join('')}
        </div>
      `;
    }

    // Credential verification
    sections += `
      <div class="modal-form">
        <h4>Verify Credential</h4>
        <div class="form-group">
          <label>Paste Credential JSON</label>
          <textarea class="credential-textarea" id="verify-credential-json" rows="4" placeholder="Paste member credential JSON here..."></textarea>
        </div>
        <button class="btn-action btn-fill" id="btn-verify-credential">Verify Credential</button>
        <div id="verify-status" class="action-status"></div>
      </div>
    `;

    // Dispensing summary
    if (rxs.length > 0) {
      const filledCount = filled.length;
      const pendingCount = fillable.length;
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

    // Reporting tabs
    sections += `
      <div class="modal-section">
        <h4>Reporting</h4>
        <div class="report-tabs">
          <button class="report-tab active" data-tab="by-member" onclick="window._entityModal.switchReportTab('by-member')">By Member</button>
          <button class="report-tab" data-tab="by-pharmacy" onclick="window._entityModal.switchReportTab('by-pharmacy')">By Pharmacy</button>
          <button class="report-tab" data-tab="by-prescriber" onclick="window._entityModal.switchReportTab('by-prescriber')">By Prescriber</button>
        </div>
        <div id="report-content" class="report-content">
          <div class="report-loading"><span class="action-spinner"></span> Loading...</div>
        </div>
      </div>
    `;

    // Force batch
    sections += `
      <div class="modal-section">
        <h4>Chain Actions</h4>
        <button class="btn-action btn-report" id="btn-force-batch-insurer">Force Batch Settlement</button>
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

    // Terminate
    const termBtn = document.getElementById('btn-terminate-member');
    if (termBtn && enrolled) {
      termBtn.addEventListener('click', () => this.terminateMember(enrolled.walletId));
    }
  }

  bindPrescriberActions(d, state) {
    const idx = d.prescriberIndex;

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
    // Verify credential
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
  }

  bindInsurerActions(d, state) {
    // Force batch
    const batchBtn = document.getElementById('btn-force-batch-insurer');
    if (batchBtn) {
      batchBtn.addEventListener('click', () => this.forceBatch('batch-status-insurer'));
    }

    // Load initial report
    this.switchReportTab('by-member');
  }

  bindEmployerActions(d, state) {
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
    this.showStatus('credential-status', 'Generating ZK proof...', 'info');

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

      // Poll for completion
      this.pollCredential(walletId, 'holding', btn);
    } catch (err) {
      this.showStatus('credential-status', err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Generate Credential'; }
    }
  }

  async pollCredential(walletId, proofType, btn) {
    const poll = async () => {
      try {
        const res = await fetch(`/interactive/credential-status?walletId=${encodeURIComponent(walletId)}&proofType=${proofType}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === 'complete') {
          this.showStatus('credential-status', 'Credential generated successfully', 'success');
          if (btn) { btn.disabled = false; btn.textContent = 'Generate Credential'; }

          // Show credential JSON
          const resultDiv = document.getElementById('credential-result');
          const textarea = document.getElementById('credential-json');
          if (resultDiv && textarea) {
            textarea.value = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
            resultDiv.style.display = 'block';
          }
          return;
        }
        if (data.status === 'error') {
          this.showStatus('credential-status', data.error || 'Generation failed', 'error');
          if (btn) { btn.disabled = false; btn.textContent = 'Generate Credential'; }
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
