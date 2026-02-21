/**
 * Pharmacy Phase — Pharmacy fill UI with credential verification gate.
 *
 * Two-phase flow (mirrors production):
 *   Phase 1: Credential Verification Gate — member must present a portable
 *            credential (ZK holding proof) before any medication can be dispensed.
 *   Phase 2: Verified Pharmacy View — after credential is verified, pharmacy
 *            sees the member's available prescriptions and can fill/dispense.
 *
 * The credential JSON is stored on the client only (no server state).
 * It is passed to the fill endpoint on every fill request, where the backend
 * re-verifies it inline — fully stateless.
 *
 * Wallet binding:
 *   - Member's wallet: proven by PortableCredential (proveHolding ZK proof)
 *   - Pharmacy's wallet: proven by ProofGate.verifyPharmacy (step 1 of fill)
 */

import {
  API_BASE, formatCents,
  updateChainState, renderCredentialCard, renderForestCard, renderZkDataSection,
} from '../interactive-app.js';

export class PharmacyPhase {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('tab-pharmacy');
    this.fillResult = null;
    this.selectedRxId = null;
    // Credential verification state (client-only, not stored on server)
    this.verifiedMember = null;       // { walletId, displayName, proofType, prescriptions }
    this.storedCredentialJson = null;  // raw JSON string — passed to fill endpoint
  }

  // ─── Main Render ─────────────────────────────────────────

  render(state) {
    this.currentState = state;

    const allPrescriptions = state.prescriptions || [];
    const activePrescriptions = allPrescriptions.filter(rx => rx.status === 'ACTIVE');
    const dispensedPrescriptions = allPrescriptions.filter(rx => rx.status === 'DISPENSED');
    const hasVerifiedCredential = this.verifiedMember && this.storedCredentialJson;

    this.container.innerHTML = `
      ${this.renderDispensingQueue(activePrescriptions, state)}
      ${dispensedPrescriptions.length > 0 || hasVerifiedCredential
        ? this.renderPickupSection(dispensedPrescriptions, state)
        : this.renderCredentialGateCompact(state)}
      ${hasVerifiedCredential ? this.renderFillableSection(state) : ''}
      ${this.renderPrescriptionHistory(allPrescriptions, state)}
    `;

    this.bindDispensingQueueEvents(state);
    // Bind pickup-fill buttons (DISPENSED Rx in Pickup section → select & scroll to fill form)
    this.container.querySelectorAll('.btn-pickup-fill').forEach(btn => {
      btn.addEventListener('click', () => {
        this.selectedRxId = btn.dataset.rxId;
        this.render(this.currentState);
        const fillBtn = document.getElementById('btn-fill');
        if (fillBtn) fillBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    if (hasVerifiedCredential) {
      const fillable = allPrescriptions.filter(rx =>
        rx.memberWalletId === this.verifiedMember.walletId &&
        (rx.status === 'DISPENSED' || rx.status === 'PARTIALLY_FILLED'));
      if (fillable.length > 0) {
        const currentRx = this.selectedRxId
          ? fillable.find(rx => rx.id === this.selectedRxId) || fillable[0]
          : fillable[0];
        this.selectedRxId = currentRx.id;
        const med = state.demoData.medications[currentRx.medicationIndex];
        this.bindEvents(currentRx, med, state);
      }
      this.bindSummaryEvents(state);
    } else {
      this.bindVerificationGateEvents();
    }
  }

  // ─── Dispensing Queue (no credential needed) ────────────

  renderDispensingQueue(activePrescriptions, state) {
    if (activePrescriptions.length === 0) {
      return `
        <div class="section-card" style="border-left: 3px solid var(--color-pharmacy);">
          <div class="card-header pharmacy">Dispensing Queue</div>
          <div class="card-body">
            <div class="waiting-message">
              <p>No active prescriptions awaiting dispensing.
              Use the <strong>Prescriber</strong> tab to write a prescription first.</p>
            </div>
          </div>
        </div>
      `;
    }

    const rows = activePrescriptions.map(rx => {
      const med = state.demoData.medications[rx.medicationIndex];
      const member = state.enrolledMembers.find(m => m.walletId === rx.memberWalletId);
      const prescriber = state.demoData.prescribers[rx.prescriberIndex];
      return `
        <tr>
          <td class="mono" style="font-size: 11px;">${rx.id}</td>
          <td>${med.brandName} ${med.strength}</td>
          <td><span class="tier-badge tier-${med.tier}">Tier ${med.tier}</span></td>
          <td>${rx.quantity}</td>
          <td>${member ? member.displayName : '\u2014'}</td>
          <td>Dr. ${prescriber.firstName} ${prescriber.lastName}</td>
          <td>
            <button class="btn-action pharmacy btn-sm btn-dispense" data-rx-id="${rx.id}">Dispense</button>
            <button class="btn-action btn-sm btn-reject-queue" data-rx-id="${rx.id}" style="background: var(--accent-red); color: #0d1117; margin-left: 4px;">Reject</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card" style="border-left: 3px solid var(--color-pharmacy);">
        <div class="card-header pharmacy">Dispensing Queue (${activePrescriptions.length} active)</div>
        <div class="card-body">
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
            Prepare medications for dispensing. <strong>No credential required</strong> \u2014 the pharmacy
            can begin working on prescriptions immediately. The member presents their credential at pickup.
          </div>
          <table class="med-table">
            <thead>
              <tr><th>Rx ID</th><th>Drug</th><th>Tier</th><th>Qty</th><th>Patient</th><th>Prescriber</th><th>Actions</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div id="dispense-result" class="hidden" style="margin-top: 12px;"></div>
        </div>
      </div>
    `;
  }

  bindDispensingQueueEvents(state) {
    this.container.querySelectorAll('.btn-dispense').forEach(btn => {
      btn.addEventListener('click', () => this.doDispense(btn.dataset.rxId, state));
    });
    this.container.querySelectorAll('.btn-reject-queue').forEach(btn => {
      btn.addEventListener('click', () => this.doRejectFromQueue(btn.dataset.rxId, state));
    });
  }

  async doDispense(rxId, state) {
    const btn = this.container.querySelector(`.btn-dispense[data-rx-id="${rxId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Dispensing...'; }

    const rx = (state.prescriptions || []).find(r => r.id === rxId);
    if (!rx) return;

    try {
      const res = await fetch(`${API_BASE}/interactive/update-rx-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prescriptionId: rxId,
          newStatus: 'DISPENSED',
          role: 'pharmacy',
          actorIndex: rx.pharmacyIndex,
          note: 'Pharmacy preparing medication for dispensing',
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Dispense failed');
      }

      const resultDiv = document.getElementById('dispense-result');
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        const med = state.demoData.medications[rx.medicationIndex];
        resultDiv.innerHTML = `
          <div style="padding: 8px 12px; background: rgba(255, 183, 77, 0.1); border: 1px solid rgba(255, 183, 77, 0.3); border-radius: 6px; font-size: 12px; color: var(--accent-yellow);">
            ${med.brandName} ${med.strength} marked as <strong>DISPENSED</strong>. Awaiting member pickup with credential.
          </div>
        `;
      }

      // Refresh state
      const stateRes = await fetch(`${API_BASE}/interactive/state`);
      if (stateRes.ok) {
        this.render(await stateRes.json());
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Dispense'; }
      alert(`Dispense failed: ${err.message}`);
    }
  }

  async doRejectFromQueue(rxId, state) {
    const btn = this.container.querySelector(`.btn-reject-queue[data-rx-id="${rxId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Rejecting...'; }

    const rx = (state.prescriptions || []).find(r => r.id === rxId);
    if (!rx) return;

    try {
      const res = await fetch(`${API_BASE}/interactive/update-rx-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prescriptionId: rxId,
          newStatus: 'REJECTED',
          role: 'pharmacy',
          actorIndex: rx.pharmacyIndex,
          note: 'Pharmacy rejected prescription',
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Rejection failed');
      }

      const stateRes = await fetch(`${API_BASE}/interactive/state`);
      if (stateRes.ok) {
        this.render(await stateRes.json());
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Reject'; }
      alert(`Reject failed: ${err.message}`);
    }
  }

  // ─── Pickup Section (DISPENSED prescriptions) ──────────

  renderPickupSection(dispensedPrescriptions, state) {
    const hasVerifiedCredential = this.verifiedMember && this.storedCredentialJson;

    const dispensedRows = dispensedPrescriptions.map(rx => {
      const med = state.demoData.medications[rx.medicationIndex];
      const member = state.enrolledMembers.find(m => m.walletId === rx.memberWalletId);
      const canFill = hasVerifiedCredential && rx.memberWalletId === this.verifiedMember.walletId;
      return `
        <tr>
          <td class="mono" style="font-size: 11px;">${rx.id}</td>
          <td>${med.brandName} ${med.strength}</td>
          <td>${rx.quantity}</td>
          <td>${member ? member.displayName : '\u2014'}</td>
          <td><span class="rx-status-badge rx-status-dispensed">DISPENSED</span></td>
          <td>
            ${canFill
              ? `<button class="btn-action pharmacy btn-sm btn-pickup-fill" data-rx-id="${rx.id}">Fill (Pickup)</button>`
              : `<span style="font-size: 11px; color: var(--text-muted);">Verify credential to fill</span>`}
            <button class="btn-action btn-sm btn-reject-queue" data-rx-id="${rx.id}" style="background: var(--accent-red); color: #0d1117; margin-left: 4px;">Reject</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card" style="border-left: 3px solid var(--accent-yellow); margin-top: 16px;">
        <div class="card-header pharmacy">Awaiting Pickup (${dispensedPrescriptions.length})</div>
        <div class="card-body">
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
            These prescriptions have been dispensed and are waiting for member pickup.
            The member must present their <strong>portable credential</strong> (NFC/QR) to complete the fill.
          </div>
          ${dispensedPrescriptions.length > 0 ? `
            <table class="med-table">
              <thead><tr><th>Rx ID</th><th>Drug</th><th>Qty</th><th>Patient</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>${dispensedRows}</tbody>
            </table>
          ` : `
            <div style="color: var(--text-muted); padding: 16px; text-align: center; font-size: 12px;">
              No prescriptions awaiting pickup.
            </div>
          `}
          ${this.renderCredentialGateCompact(state)}
        </div>
      </div>
    `;
  }

  // ─── Compact Credential Gate ───────────────────────────

  renderCredentialGateCompact(state) {
    const hasVerified = this.verifiedMember && this.storedCredentialJson;

    if (hasVerified) {
      return `
        <div style="margin-top: 12px; padding: 10px 14px; background: rgba(76, 175, 80, 0.08); border: 1px solid rgba(76, 175, 80, 0.3); border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="color: var(--accent-green); font-weight: 700;">\u2713 Credential Verified</span>
            <span style="color: var(--text-secondary); margin-left: 8px;">${this.verifiedMember.displayName}</span>
          </div>
          <button id="btn-verify-different" class="btn-action"
            style="background: var(--surface-secondary); color: var(--text-secondary); font-size: 11px; padding: 4px 10px;">
            Verify Different Member
          </button>
        </div>
      `;
    }

    return `
      <div style="margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 6px;">
        <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
          <strong style="color: var(--accent-orange);">Member Pickup:</strong> Paste the member's portable credential to complete a fill.
        </div>
        <div style="display: flex; gap: 8px; align-items: flex-start;">
          <textarea id="credential-verify-input" class="credential-textarea"
            placeholder="Paste credential JSON here..."
            style="min-height: 60px; flex: 1; font-size: 11px;"></textarea>
          <button id="btn-verify-credential" class="btn-action pharmacy" disabled style="white-space: nowrap;">
            <span class="spinner"></span> Verify
          </button>
        </div>
        <div id="verify-credential-result" class="hidden"></div>
      </div>
    `;
  }

  bindVerificationGateEvents() {
    const textarea = document.getElementById('credential-verify-input');
    const btn = document.getElementById('btn-verify-credential');
    if (!textarea || !btn) return;

    textarea.addEventListener('input', () => {
      btn.disabled = !textarea.value.trim();
    });

    btn.addEventListener('click', () => this.doVerifyAndUnlock());

    // Verify Different Member button
    const diffBtn = document.getElementById('btn-verify-different');
    if (diffBtn) {
      diffBtn.addEventListener('click', () => {
        this.verifiedMember = null;
        this.storedCredentialJson = null;
        this.selectedRxId = null;
        this.fillResult = null;
        this.render(this.currentState);
      });
    }
  }

  async doVerifyAndUnlock() {
    const btn = document.getElementById('btn-verify-credential');
    const textarea = document.getElementById('credential-verify-input');
    const credentialJson = textarea.value.trim();

    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Verifying credential...');

    try {
      const res = await fetch(`${API_BASE}/interactive/verify-credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialJson }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      if (data.valid && data.memberWalletId) {
        // Store credential and verification locally (no server state)
        this.verifiedMember = {
          walletId: data.memberWalletId,
          displayName: data.memberDisplayName || 'Unknown',
          proofType: data.proofType,
          prescriptions: data.memberPrescriptions || [],
          verificationTimeMs: data.verificationTimeMs,
        };
        this.storedCredentialJson = credentialJson;

        this.app.setStatus('ready', `Verified: ${data.memberDisplayName}`);

        // Re-render with the verified pharmacy view
        const stateRes = await fetch(`${API_BASE}/interactive/state`);
        if (stateRes.ok) {
          this.render(await stateRes.json());
        }
      } else if (data.valid && !data.memberWalletId) {
        // Valid proof but wallet not enrolled
        const resultDiv = document.getElementById('verify-credential-result');
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
          <div class="verify-result invalid">
            <div class="verify-badge invalid">
              Valid proof but wallet not enrolled in this plan.
            </div>
          </div>
        `;
        this.app.setStatus('ready', 'Wallet not enrolled');
      } else {
        // Invalid proof
        const resultDiv = document.getElementById('verify-credential-result');
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
          <div class="verify-result invalid">
            <div class="verify-badge invalid">\u2717 INVALID \u2014 Credential verification failed</div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
              The credential proof could not be verified.
              It may be expired, tampered with, or generated with a different verification key.
            </div>
          </div>
        `;
        this.app.setStatus('ready', 'Credential invalid');
      }
    } catch (err) {
      const resultDiv = document.getElementById('verify-credential-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="verify-result invalid">
          <div class="verify-badge invalid">Error: ${err.message}</div>
        </div>
      `;
      this.app.setStatus('ready', 'Verification error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  // ─── Fillable Section (after credential verification) ───

  renderFillableSection(state) {
    const vm = this.verifiedMember;
    if (!vm) return '';

    const allPrescriptions = state.prescriptions || [];

    // DISPENSED or PARTIALLY_FILLED for the verified member
    const fillable = allPrescriptions.filter(rx =>
      rx.memberWalletId === vm.walletId &&
      (rx.status === 'DISPENSED' || rx.status === 'PARTIALLY_FILLED'));

    if (fillable.length === 0) return '';

    return this.renderFillSection(fillable, state);
  }

  renderFillSection(fillable, state) {
    const currentRx = this.selectedRxId
      ? fillable.find(rx => rx.id === this.selectedRxId) || fillable[0]
      : fillable[0];
    this.selectedRxId = currentRx.id;

    const med = state.demoData.medications[currentRx.medicationIndex];
    const prescriber = state.demoData.prescribers[currentRx.prescriberIndex];
    const pharmacy = state.demoData.pharmacies[currentRx.pharmacyIndex];
    const member = state.enrolledMembers.find(m => m.walletId === currentRx.memberWalletId);
    const accumulator = member ? member.accumulator : { deductiblePaidCents: 0, oopPaidCents: 0 };
    const plan = state.demoData.plan;
    const remainingQty = currentRx.quantity - (currentRx.quantityDispensed || 0);
    const totalCostCents = med.awpUnitPriceCents * remainingQty + 200;
    const isPartial = currentRx.status === 'PARTIALLY_FILLED';
    const isDispensed = currentRx.status === 'DISPENSED';

    return `
      <!-- Prescription Selector -->
      <div class="section-card" style="margin-top: 16px;">
        <div class="card-header pharmacy">Member Pickup \u2014 Fill Prescription</div>
        <div class="card-body">
          ${fillable.length > 1 ? `
            <div class="form-group">
              <select id="rx-selector">
                ${fillable.map(rx => {
                  const rxMed = state.demoData.medications[rx.medicationIndex];
                  const statusTag = rx.status === 'PARTIALLY_FILLED' ? ' [PARTIAL]' : rx.status === 'DISPENSED' ? ' [DISPENSED]' : '';
                  return `<option value="${rx.id}" ${rx.id === currentRx.id ? 'selected' : ''}>${rx.id} \u2014 ${rxMed.brandName} ${rxMed.strength}${statusTag}</option>`;
                }).join('')}
              </select>
            </div>
          ` : `
            <div style="font-size: 13px; color: var(--text-secondary);">
              1 prescription ready: <strong>${currentRx.id}</strong>
              ${isPartial ? `<span class="rx-status-badge rx-status-partially-filled">PARTIALLY FILLED</span>` : ''}
            </div>
          `}
        </div>
      </div>

      <!-- Pharmacy -->
      <div class="section-card">
        <div class="card-header pharmacy">${pharmacy.storeName}</div>
        <div class="card-body">
          <div class="data-grid">
            <div class="label">Type</div><div class="value">${pharmacy.pharmacyType}</div>
            <div class="label">Address</div><div class="value">${pharmacy.address}, ${pharmacy.city}, ${pharmacy.state}</div>
          </div>
        </div>
      </div>

      <!-- Incoming Prescription -->
      <div class="section-card">
        <div class="card-header prescriber">Incoming Prescription \u2014 ${currentRx.id}</div>
        <div class="card-body">
          <div class="data-grid">
            <div class="label">Drug</div><div class="value">${med.brandName} ${med.strength}</div>
            <div class="label">NDC</div><div class="value mono">${med.ndc}</div>
            <div class="label">Tier</div><div class="value"><span class="tier-badge tier-${med.tier}">Tier ${med.tier}</span></div>
            <div class="label">Copay</div><div class="value">${formatCents(med.copayAmountCents)}</div>
            <div class="label">Qty Prescribed</div><div class="value">${currentRx.quantity}</div>
            ${isPartial ? `<div class="label">Qty Dispensed</div><div class="value">${currentRx.quantityDispensed}</div>` : ''}
            <div class="label">Qty Remaining</div><div class="value" ${isPartial ? 'style="color: var(--accent-yellow); font-weight: 600;"' : ''}>${remainingQty}</div>
            <div class="label">Refills</div><div class="value">${currentRx.refills || 0}</div>
            <div class="label">Prescriber</div><div class="value">Dr. ${prescriber.firstName} ${prescriber.lastName}, ${prescriber.credential}</div>
            <div class="label">Patient</div><div class="value">${member ? member.displayName : 'Unknown'}</div>
            <div class="label">Status</div><div class="value"><span class="rx-status-badge rx-status-${currentRx.status.toLowerCase().replace('_', '-')}">${currentRx.status.replace('_', ' ')}</span></div>
          </div>
          ${this.renderStatusHistory(currentRx)}
        </div>
      </div>

      <!-- Eligibility Verification -->
      <div class="section-card">
        <div class="card-header member">Eligibility Verification \u2014 Before Fill</div>
        <div class="card-body">
          <div class="data-grid">
            <div class="label">Member</div><div class="value">${member ? member.displayName : 'Unknown'}</div>
            <div class="label">Plan</div><div class="value">${member ? member.planId : plan.planId}</div>
            <div class="label">Coverage</div><div class="value" style="color: var(--accent-green);">ELIGIBLE</div>
            <div class="label">On Formulary</div><div class="value" style="color: var(--accent-green);">YES</div>
          </div>
          <div class="mt-4">
            <div class="progress-container">
              <div class="progress-label">
                <span>Deductible</span>
                <span>${formatCents(accumulator.deductiblePaidCents)} / ${formatCents(plan.deductibleAmountCents)}</span>
              </div>
              <div class="progress-bar"><div class="fill deductible" style="width: ${pct(accumulator.deductiblePaidCents, plan.deductibleAmountCents)}%"></div></div>
            </div>
            <div class="progress-container">
              <div class="progress-label">
                <span>Out-of-Pocket Max</span>
                <span>${formatCents(accumulator.oopPaidCents)} / ${formatCents(plan.oopMaxCents)}</span>
              </div>
              <div class="progress-bar"><div class="fill oop" style="width: ${pct(accumulator.oopPaidCents, plan.oopMaxCents)}%"></div></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Messages -->
      ${this.renderPharmacyMessages(state, currentRx)}

      <!-- Fill Details -->
      <div class="section-card">
        <div class="card-header pharmacy">Fill Details</div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label>Service Date</label>
              <input type="text" value="Set at dispensing" readonly
                style="color: var(--accent-green); font-weight: 600; font-size: 12px;" />
            </div>
            <div class="form-group">
              <label>Quantity to Dispense</label>
              <input type="number" id="fill-quantity" value="${remainingQty}" min="1" max="${remainingQty}" />
              ${remainingQty < currentRx.quantity ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Max: ${remainingQty} remaining</div>` : ''}
            </div>
            <div class="form-group">
              <label>Ingredient Cost</label>
              <input type="text" id="fill-ingredient" value="${formatCents(med.awpUnitPriceCents * remainingQty)}" readonly />
            </div>
            <div class="form-group">
              <label>Dispensing Fee</label>
              <input type="text" id="fill-dispensing" value="$2.00" readonly />
            </div>
            <div class="form-group">
              <label>Total Cost</label>
              <input type="text" id="fill-total" value="${formatCents(totalCostCents)}" readonly style="font-weight: 700;" />
            </div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button id="btn-fill" class="btn-action pharmacy">
              <span class="spinner"></span>
              ${isPartial ? 'Fill Remaining' : isDispensed ? 'Complete Fill (Pickup)' : 'Fill Prescription'}
            </button>
            <button id="btn-reject-rx" class="btn-action" style="background: var(--accent-red); color: #0d1117; font-size: 12px; padding: 8px 16px;">
              Reject
            </button>
          </div>
          <div id="fill-result" class="hidden"></div>
        </div>
      </div>
    `;
  }

  // ─── Shared Renderers ───────────────────────────────────

  renderPrescriptionHistory(allPrescriptions, state) {
    const completed = allPrescriptions.filter(rx => rx.status === 'FILLED');
    const reversed = allPrescriptions.filter(rx => rx.status === 'REVERSED');
    const terminal = allPrescriptions.filter(rx =>
      rx.status === 'CANCELLED' || rx.status === 'REJECTED');
    return this.renderPrescriptionSummary(completed, reversed, terminal, state);
  }

  renderPrescriptionSummary(completed, reversed, terminal, state) {
    if (completed.length === 0 && reversed.length === 0 && terminal.length === 0) return '';

    const renderRows = (rxList) => rxList.map(rx => {
      const med = state.demoData.medications[rx.medicationIndex];
      const member = state.enrolledMembers.find(m => m.walletId === rx.memberWalletId);
      const statusClass = `rx-status-${rx.status.toLowerCase().replace('_', '-')}`;
      const canReverse = rx.status === 'FILLED' || rx.status === 'PARTIALLY_FILLED';
      return `
        <tr>
          <td class="mono" style="font-size: 11px;">${rx.id}</td>
          <td>${med.brandName} ${med.strength}</td>
          <td>${member ? member.displayName : '\u2014'}</td>
          <td>${rx.quantityDispensed || 0} / ${rx.quantity}</td>
          <td>${rx.patientPayCents != null ? formatCents(rx.patientPayCents) : '\u2014'}</td>
          <td>${rx.planPayCents != null ? formatCents(rx.planPayCents) : '\u2014'}</td>
          <td><span class="rx-status-badge ${statusClass}">${rx.status.replace('_', ' ')}</span></td>
          <td>${canReverse ? `<button class="btn-reverse-rx" data-rx-id="${rx.id}" style="font-size: 11px; padding: 3px 10px; background: var(--accent-yellow); color: #0d1117; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">Reverse</button>` : ''}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card" style="margin-top: 16px;">
        <div class="card-header pharmacy">Prescription History</div>
        <div class="card-body">
          <table class="med-table">
            <thead>
              <tr>
                <th>Rx ID</th>
                <th>Medication</th>
                <th>Patient</th>
                <th>Qty Dispensed</th>
                <th>Patient Pay</th>
                <th>Plan Pay</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${renderRows(completed)}
              ${renderRows(reversed)}
              ${renderRows(terminal)}
            </tbody>
          </table>
          <div id="reversal-result" class="hidden" style="margin-top: 12px;"></div>
        </div>
      </div>
    `;
  }

  renderStatusHistory(rx) {
    const history = rx.statusHistory || [];
    if (history.length === 0) return '';

    return `
      <div style="margin-top: 12px; border-top: 1px solid var(--border-subtle); padding-top: 8px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); margin-bottom: 4px;">STATUS HISTORY</div>
        ${history.map(h => `
          <div style="font-size: 11px; color: var(--text-secondary); padding: 2px 0; display: flex; gap: 8px;">
            <span class="mono">${new Date(h.timestamp).toLocaleTimeString()}</span>
            <span><span class="rx-status-badge rx-status-${h.from.toLowerCase().replace('_', '-')}" style="font-size: 10px; padding: 1px 6px;">${h.from.replace('_', ' ')}</span>
            \u2192
            <span class="rx-status-badge rx-status-${h.to.toLowerCase().replace('_', '-')}" style="font-size: 10px; padding: 1px 6px;">${h.to.replace('_', ' ')}</span></span>
            <span>${h.updatedBy}</span>
            ${h.fillQuantity ? `<span>(qty: ${h.fillQuantity})</span>` : ''}
            ${h.note ? `<span style="color: var(--text-muted);">\u2014 ${h.note}</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // ─── Event Binding ──────────────────────────────────────

  bindEvents(currentRx, med, state) {
    const qtyInput = document.getElementById('fill-quantity');
    const ingredientInput = document.getElementById('fill-ingredient');
    const totalInput = document.getElementById('fill-total');
    const remainingQty = currentRx.quantity - (currentRx.quantityDispensed || 0);

    qtyInput.addEventListener('input', () => {
      let qty = parseInt(qtyInput.value, 10) || 0;
      // FWA guard: clamp to remaining quantity
      if (qty > remainingQty) {
        qty = remainingQty;
        qtyInput.value = qty;
      }
      if (qty < 1) qty = 0;
      const cost = med.awpUnitPriceCents * qty;
      ingredientInput.value = formatCents(cost);
      totalInput.value = formatCents(cost + 200);
    });

    // Rx selector (if multiple fillable)
    const rxSelector = document.getElementById('rx-selector');
    if (rxSelector) {
      rxSelector.addEventListener('change', () => {
        this.selectedRxId = rxSelector.value;
        this.render(state);
      });
    }

    document.getElementById('btn-fill').addEventListener('click', () => this.doFill(currentRx, med));

    // Reject button
    document.getElementById('btn-reject-rx').addEventListener('click', () => this.doRejectRx(currentRx, state));

    // Messaging
    const msgRecipient = document.getElementById('pharmacy-msg-recipient');
    const msgSubject = document.getElementById('pharmacy-msg-subject');
    const btnSendMsg = document.getElementById('btn-pharmacy-send-msg');
    if (msgRecipient && btnSendMsg) {
      const enableSend = () => {
        btnSendMsg.disabled = !msgRecipient.value || !msgSubject?.value?.trim();
      };
      msgRecipient.addEventListener('change', enableSend);
      if (msgSubject) msgSubject.addEventListener('input', enableSend);
      btnSendMsg.addEventListener('click', () => this.doSendPharmacyMessage(currentRx));
    }
    // Cancel reply
    const btnCancelReply = document.getElementById('pharmacy-cancel-reply');
    if (btnCancelReply) {
      btnCancelReply.addEventListener('click', () => {
        document.getElementById('pharmacy-msg-thread-id').value = '';
        document.getElementById('pharmacy-reply-banner').classList.add('hidden');
        if (msgSubject) msgSubject.value = '';
        if (msgRecipient) { msgRecipient.value = ''; msgRecipient.disabled = false; }
      });
    }
    // Thread click handlers
    document.querySelectorAll('.pharmacy-thread-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.msg-reply-btn')) return;
        this.doExpandPharmacyThread(el);
      });
    });
  }

  bindSummaryEvents(state) {
    this.container.querySelectorAll('.btn-reverse-rx').forEach(btn => {
      btn.addEventListener('click', () => this.doReverseRx(btn.dataset.rxId, btn, state));
    });
  }

  // ─── Fill (with credential) ─────────────────────────────

  async doFill(currentRx, med) {
    const btn = document.getElementById('btn-fill');
    const qty = parseInt(document.getElementById('fill-quantity').value, 10);

    // FWA guard: reject quantity exceeding prescription
    if (!qty || qty < 1) {
      alert('Quantity must be at least 1.');
      return;
    }
    const remainingQty = currentRx.quantity - (currentRx.quantityDispensed || 0);
    if (qty > remainingQty) {
      alert(`Quantity dispensed (${qty}) exceeds remaining qty (${remainingQty}). Fill rejected.`);
      return;
    }

    const ingredientCostCents = med.awpUnitPriceCents * qty;

    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Submitting fill request...');

    try {
      // 1. Kick off async fill (returns 202 immediately)
      const submitRes = await fetch(`${API_BASE}/interactive/fill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prescriptionId: currentRx.id,
          credentialJson: this.storedCredentialJson,
          quantityDispensed: qty,
          ingredientCostCents,
          dispensingFeeCents: 200,
        }),
      });

      const submitData = await submitRes.json();
      if (submitRes.ok && submitData.status === 'error') {
        throw new Error(submitData.error || 'Fill failed');
      }
      if (!submitRes.ok && submitRes.status !== 202) {
        throw new Error(submitData.error || 'Fill submission failed');
      }

      // 2. Poll every 15s for up to 3 minutes
      const POLL_INTERVAL = 15_000;
      const POLL_TIMEOUT = 180_000;
      const result = await this._pollFillStatus(currentRx.id, POLL_INTERVAL, POLL_TIMEOUT);

      this.fillResult = result;
      this._renderFillResult(result, currentRx);
      this.app.setStatus('ready', 'Complete');

    } catch (err) {
      const resultDiv = document.getElementById('fill-result');
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
      }
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  /**
   * Poll GET /interactive/fill-status every `intervalMs` until complete, error, or `timeoutMs`.
   */
  async _pollFillStatus(prescriptionId, intervalMs, timeoutMs) {
    const startTime = Date.now();
    let pollCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(r => setTimeout(r, intervalMs));
      pollCount++;

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.app.setStatus('working', `Generating ZK proofs... (${elapsed}s / ${pollCount} checks)`);

      const res = await fetch(`${API_BASE}/interactive/fill-status?prescriptionId=${encodeURIComponent(prescriptionId)}`);
      if (!res.ok) throw new Error('Failed to check fill status');

      const job = await res.json();

      if (job.status === 'complete') {
        return job.result;
      }
      if (job.status === 'error') {
        throw new Error(job.error || 'Fill failed');
      }
      // status === 'pending' or 'not_started' → keep polling
    }

    throw new Error(`Fill timed out after ${timeoutMs / 1000}s — the server is still working. Check the sequencer console.`);
  }

  /**
   * Render the fill result card (extracted from doFill for clarity).
   */
  _renderFillResult(result, currentRx) {
    const sd = result.serviceDateStr;
    const serviceDateDisplay = sd
      ? sd.slice(4,6) + '/' + sd.slice(6,8) + '/' + sd.slice(0,4)
      : new Date().toLocaleDateString();

    const resultDiv = document.getElementById('fill-result');
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = `
      <div class="result-card">
        <div class="result-title">Prescription ${result.rxStatus === 'PARTIALLY_FILLED' ? 'Partially Filled' : 'Filled'} \u2014 Claim Adjudicated</div>
        ${result.rxStatus === 'PARTIALLY_FILLED' ? `
          <div style="padding: 6px 10px; background: rgba(255, 183, 77, 0.1); border: 1px solid rgba(255, 183, 77, 0.3); border-radius: 4px; margin-bottom: 8px; font-size: 12px; color: var(--accent-yellow);">
            Partial fill: ${result.quantityDispensed} of ${result.quantityPrescribed} dispensed. Return to this tab to fill the remainder.
          </div>
        ` : ''}

        <h4 style="color: var(--accent-blue); margin: 16px 0 8px; font-size: 13px;">ADJUDICATION (ZK-enforced in-circuit)</h4>
        <div class="data-grid">
          <div class="label">Service Date</div><div class="value" style="color: var(--accent-green); font-weight: 600;">${serviceDateDisplay}</div>
          <div class="label">Phase</div><div class="value">${result.adjudication.phase}</div>
          <div class="label">Total Cost</div><div class="value">${formatCents(result.adjudication.totalCostCents)}</div>
          <div class="label">Patient Pay</div><div class="value" style="color: var(--accent-orange); font-weight: 700;">${formatCents(result.adjudication.patientPayCents)}</div>
          <div class="label">Plan Pay</div><div class="value" style="color: var(--accent-green); font-weight: 700;">${formatCents(result.adjudication.planPayCents)}</div>
        </div>
        ${result.adjudication.familyPoolingApplied ? `
          <div class="family-pooling-badge">Family Pooling Applied \u2014 ${result.adjudication.familyPoolingReason}</div>
        ` : ''}

        <h4 style="color: var(--accent-blue); margin: 16px 0 8px; font-size: 13px;">ACCUMULATOR (BEFORE \u2192 AFTER)</h4>
        <div class="progress-container">
          <div class="progress-label">
            <span>Deductible</span>
            <span>${formatCents(result.accumulator.before.deductiblePaidCents)} \u2192 ${formatCents(result.accumulator.after.deductiblePaidCents)} / ${formatCents(result.accumulator.limits.deductibleAmountCents)}</span>
          </div>
          <div class="progress-bar"><div class="fill deductible" style="width: ${pct(result.accumulator.after.deductiblePaidCents, result.accumulator.limits.deductibleAmountCents)}%"></div></div>
        </div>
        <div class="progress-container">
          <div class="progress-label">
            <span>Out-of-Pocket Max</span>
            <span>${formatCents(result.accumulator.before.oopPaidCents)} \u2192 ${formatCents(result.accumulator.after.oopPaidCents)} / ${formatCents(result.accumulator.limits.oopMaxCents)}</span>
          </div>
          <div class="progress-bar"><div class="fill oop" style="width: ${pct(result.accumulator.after.oopPaidCents, result.accumulator.limits.oopMaxCents)}%"></div></div>
        </div>

        ${result.accumulator.limits.familyOopMaxCents ? `
        <h4 style="color: var(--accent-blue); margin: 16px 0 8px; font-size: 13px;">FAMILY ACCUMULATOR</h4>
        <div class="family-accumulator-bar">
          <div class="progress-container">
            <div class="progress-label">
              <span>Family Deductible</span>
              <span>\u2014 / ${formatCents(result.accumulator.limits.familyDeductibleAmountCents)}</span>
            </div>
            <div class="progress-bar"><div class="fill deductible" style="width: 0%"></div></div>
          </div>
          <div class="progress-container">
            <div class="progress-label">
              <span>Family Out-of-Pocket Max</span>
              <span>\u2014 / ${formatCents(result.accumulator.limits.familyOopMaxCents)}</span>
            </div>
            <div class="progress-bar"><div class="fill oop" style="width: 0%"></div></div>
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
          Family totals require querying all enrolled family members. Individual + family limits are enforced at the service layer.
        </div>
        ` : ''}

        <h4 style="color: var(--accent-blue); margin: 16px 0 8px; font-size: 13px;">ELIGIBILITY CREDENTIAL</h4>
        <div class="data-grid">
          <div class="label">Forest Root BEFORE</div><div class="value mono">${result.eligibilityNft.oldForestRoot}</div>
          <div class="label">Forest Root AFTER</div><div class="value mono highlight">${result.eligibilityNft.newForestRoot}</div>
          <div class="label">Changed</div><div class="value" style="color: ${result.eligibilityNft.changed ? 'var(--accent-green)' : 'var(--accent-red)'};">${result.eligibilityNft.changed ? 'YES \u2014 accumulator updated in credential' : 'NO (unexpected)'}</div>
        </div>

        <div class="mt-4" style="font-size: 12px; color: var(--text-secondary);">
          <strong>Proof Generation Times:</strong><br>
          ProofGate: ${(result.proofTimesMs.proofGate / 1000).toFixed(2)}s |
          Prescription Status: ${(result.proofTimesMs.prescriptionStatus / 1000).toFixed(2)}s |
          AccumulatorFulfillment: ${(result.proofTimesMs.accumulatorFulfillment / 1000).toFixed(2)}s |
          <strong>Total: ${(result.proofTimesMs.total / 1000).toFixed(2)}s</strong>
        </div>

        <div class="mt-4" style="padding: 12px; background: rgba(79, 195, 247, 0.08); border-radius: 6px; font-size: 13px; color: var(--text-secondary);">
          <strong style="color: var(--accent-blue);">What Just Happened:</strong><br>
          1. The member's portable credential (holding proof) was verified inline \u2014 no server state<br>
          2. The pharmacy proved its identity without revealing credentials (ProofGate)<br>
          3. The ZK circuit enforced the prescription status transition ACTIVE \u2192 FILLED<br>
          4. The AccumulatorFulfillment circuit computed patient/plan pay split (15 private inputs)<br>
          5. The member's eligibility credential was updated with new accumulator values<br>
          6. <strong>Service date (${serviceDateDisplay}) was set at time of verified dispensing. No service date without a holding proof.</strong>
        </div>

        <!-- ZK Detail Sections -->
        ${renderZkDataSection('FulfillmentData (7 Fields)', result.fulfillmentDetail, 'pharmacy', '7 fields', result.fulfillmentDetail ? result.fulfillmentDetail.commitment : '')}
        ${renderZkDataSection('Filled PrescriptionStatusData', result.filledStatusData, 'pharmacy', '7 fields', result.filledStatusData ? result.filledStatusData.commitment : '')}
        ${this.renderSettlementSection(result)}
        ${renderCredentialCard('Updated Prescription Credential', result.updatedPrescriptionNft, 'prescriber')}
        ${renderForestCard('Updated Prescription Forest', result.updatedPrescriptionForest, 'prescriber')}
        ${renderCredentialCard('Eligibility Credential (Before Fill)', result.oldEligibilityNft, 'member')}
        ${renderForestCard('Eligibility Forest (Before Fill)', result.oldEligibilityForest, 'member')}
        ${renderCredentialCard('Updated Eligibility Credential (After Fill)', result.updatedEligibilityNft, 'member')}
        ${renderForestCard('Updated Eligibility Forest (After Fill)', result.updatedEligibilityForest, 'member')}
        ${result.l2Receipt ? this.renderL2Receipt(result.l2Receipt) : ''}
      </div>
    `;

    // Update chain state panel
    if (result.chainState) {
      updateChainState(result.chainState);
    }
  }

  // ─── Reject ─────────────────────────────────────────────

  async doRejectRx(currentRx, state) {
    const btn = document.getElementById('btn-reject-rx');
    btn.disabled = true;
    btn.textContent = 'Rejecting...';

    try {
      const res = await fetch(`${API_BASE}/interactive/update-rx-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prescriptionId: currentRx.id,
          newStatus: 'REJECTED',
          role: 'pharmacy',
          actorIndex: currentRx.pharmacyIndex,
          note: 'Pharmacy rejected prescription',
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Rejection failed');
      }

      // Refresh state and re-render
      const stateRes = await fetch(`${API_BASE}/interactive/state`);
      if (stateRes.ok) {
        this.render(await stateRes.json());
      }
    } catch (err) {
      const resultDiv = document.getElementById('fill-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
      btn.disabled = false;
      btn.textContent = 'Reject';
    }
  }

  // ─── Reverse ────────────────────────────────────────────

  async doReverseRx(rxId, btn, state) {
    btn.disabled = true;
    btn.textContent = 'Reversing...';
    this.app.setStatus('working', 'Generating reversal proof...');

    const resultDiv = document.getElementById('reversal-result');

    try {
      const res = await fetch(`${API_BASE}/interactive/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriptionId: rxId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Reversal failed');
      }

      const result = await res.json();
      const plan = state.demoData.plan;
      const credChanged = result.eligibilityNft.oldForestRoot !== result.eligibilityNft.newForestRoot;

      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
          <div class="result-card">
            <div class="result-title" style="color: var(--accent-yellow);">Claim Reversed \u2014 ${rxId}</div>
            <div class="data-grid">
              <div class="label">Patient Refund</div><div class="value" style="color: var(--accent-green); font-weight: 700;">${formatCents(result.refund.patientRefundCents)}</div>
              <div class="label">Plan Refund</div><div class="value" style="color: var(--accent-green); font-weight: 700;">${formatCents(result.refund.planRefundCents)}</div>
              <div class="label">Total Refund</div><div class="value" style="font-weight: 700;">${formatCents(result.refund.totalRefundCents)}</div>
              <div class="label">Fill Reversed</div><div class="value">#${result.fillIndex + 1}</div>
              <div class="label">Medication</div><div class="value">${result.medication.brandName} ${result.medication.strength}</div>
              <div class="label">New Status</div><div class="value"><span class="rx-status-badge rx-status-reversed">REVERSED</span></div>
            </div>

            <h4 style="color: var(--accent-blue); margin: 16px 0 8px; font-size: 13px;">ACCUMULATOR ROLLBACK (BEFORE \u2192 AFTER)</h4>
            <div class="progress-container">
              <div class="progress-label">
                <span>Deductible</span>
                <span>${formatCents(result.accumulator.before.deductiblePaidCents)} \u2192 ${formatCents(result.accumulator.after.deductiblePaidCents)} / ${formatCents(plan.deductibleAmountCents)}</span>
              </div>
              <div class="progress-bar"><div class="fill deductible" style="width: ${pct(result.accumulator.after.deductiblePaidCents, plan.deductibleAmountCents)}%"></div></div>
            </div>
            <div class="progress-container">
              <div class="progress-label">
                <span>Out-of-Pocket Max</span>
                <span>${formatCents(result.accumulator.before.oopPaidCents)} \u2192 ${formatCents(result.accumulator.after.oopPaidCents)} / ${formatCents(plan.oopMaxCents)}</span>
              </div>
              <div class="progress-bar"><div class="fill oop" style="width: ${pct(result.accumulator.after.oopPaidCents, plan.oopMaxCents)}%"></div></div>
            </div>

            <h4 style="color: var(--accent-blue); margin: 16px 0 8px; font-size: 13px;">ELIGIBILITY CREDENTIAL</h4>
            <div class="data-grid">
              <div class="label">Forest Root BEFORE</div><div class="value mono">${result.eligibilityNft.oldForestRoot}</div>
              <div class="label">Forest Root AFTER</div><div class="value mono highlight">${result.eligibilityNft.newForestRoot}</div>
              <div class="label">Changed</div><div class="value" style="color: ${credChanged ? 'var(--accent-green)' : 'var(--accent-red)'};">${credChanged ? 'YES \u2014 accumulator rolled back in credential' : 'NO (unexpected)'}</div>
            </div>

            <div class="mt-4" style="font-size: 12px; color: var(--text-secondary);">
              <strong>Proof Generation Times:</strong><br>
              AccumulatorReversal: ${(result.proofTimesMs.accumulatorReversal / 1000).toFixed(2)}s |
              <strong>Total: ${(result.proofTimesMs.total / 1000).toFixed(2)}s</strong>
            </div>

            <div class="mt-4" style="padding: 12px; background: rgba(255, 238, 88, 0.06); border-radius: 6px; font-size: 13px; color: var(--text-secondary);">
              <strong style="color: var(--accent-yellow);">What Just Happened:</strong><br>
              1. The pharmacy proved its identity without revealing credentials<br>
              2. The ZK circuit verified the original settlement commitment exists in the TRANSACTION tree<br>
              3. The AccumulatorReversal circuit subtracted the original pay amounts from accumulators<br>
              4. The member's eligibility credential was updated with rolled-back accumulator values<br>
              5. <strong>The original fill is cryptographically marked as reversed. The refund amounts are provably correct.</strong>
            </div>
          </div>
        `;
      }

      if (result.chainState) {
        updateChainState(result.chainState);
      }

      this.app.setStatus('ready', 'Complete');

      // Refresh state to update table
      setTimeout(async () => {
        const stateRes = await fetch(`${API_BASE}/interactive/state`);
        if (stateRes.ok) {
          this.render(await stateRes.json());
        }
      }, 1500);

    } catch (err) {
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 12px;">Error: ${err.message}</div>`;
      }
      btn.disabled = false;
      btn.textContent = 'Reverse';
      this.app.setStatus('ready', 'Error');
    }
  }

  // ─── Messages ───────────────────────────────────────────

  renderPharmacyMessages(state, currentRx) {
    const dir = state.walletDirectory || {};
    const MSG_LABELS = { 1:'Rx', 2:'PA Req', 3:'PA Resp', 4:'Notice', 5:'General', 6:'Support', 7:'Summary' };

    let pharmacyWalletId = null;
    for (const [wid, info] of Object.entries(dir)) {
      if (info.type === 'pharmacy' && info.index === currentRx.pharmacyIndex) {
        pharmacyWalletId = wid;
        break;
      }
    }

    const messages = pharmacyWalletId
      ? (state.messaging?.messages || []).filter(m =>
          m.senderWalletId === pharmacyWalletId || m.recipientWalletId === pharmacyWalletId)
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

    // Build recipient options from current Rx context
    const recipientOptions = [];
    const member = state.enrolledMembers?.find(m => m.walletId === currentRx.memberWalletId);
    if (member) {
      recipientOptions.push(`<option value="member:${member.walletId}">${member.displayName} (Patient)</option>`);
    }
    const prescriber = state.demoData?.prescribers?.[currentRx.prescriberIndex];
    if (prescriber) {
      recipientOptions.push(`<option value="prescriber:${currentRx.prescriberIndex}">Dr. ${prescriber.firstName} ${prescriber.lastName}</option>`);
    }
    recipientOptions.push(`<option value="insurer:0">Insurer</option>`);

    return `
      <div class="section-card">
        <div class="card-header pharmacy">Messages (${messages.length})</div>
        <div class="card-body">
          <div id="pharmacy-reply-banner" class="hidden" style="background: var(--bg-tertiary); border: 1px solid var(--accent-orange); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <span id="pharmacy-reply-label" style="font-size: 12px; color: var(--accent-orange);"></span>
            <button id="pharmacy-cancel-reply" style="background: none; border: none; color: var(--accent-red); cursor: pointer; font-size: 12px;">Cancel</button>
          </div>
          <div class="msg-compose">
            <div style="font-size: 12px; font-weight: 600; color: var(--accent-orange); margin-bottom: 8px;">Send Message</div>
            <label>To</label>
            <select id="pharmacy-msg-recipient">
              <option value="">\u2014 Select recipient \u2014</option>
              ${recipientOptions.join('')}
            </select>
            <label>Subject</label>
            <input type="text" id="pharmacy-msg-subject" placeholder="Subject">
            <label>Message</label>
            <textarea id="pharmacy-msg-body" rows="2" placeholder="Type your message..."></textarea>
            <input type="hidden" id="pharmacy-msg-thread-id" value="">
            <button id="btn-pharmacy-send-msg" class="btn-action pharmacy" disabled>
              <span class="spinner"></span> Send Message
            </button>
            <div class="msg-privacy-note">End-to-end encrypted (X25519-ECDH + AES-256-GCM). ZK proof generated on send.</div>
          </div>
          <div id="pharmacy-send-result" class="hidden"></div>
          ${threads.length > 0 ? `
          <div class="msg-thread-list">
            ${threads.map(t => {
              const lastMsg = t.messages[t.messages.length - 1];
              const isSent = lastMsg.senderWalletId === pharmacyWalletId;
              const otherWid = isSent ? lastMsg.recipientWalletId : lastMsg.senderWalletId;
              const otherName = dir[otherWid]?.displayName || otherWid.slice(0,8) + '\u2026';
              const typeLabel = MSG_LABELS[lastMsg.messageType] || 'Msg';
              const timeStr = lastMsg.timestamp ? new Date(lastMsg.timestamp).toLocaleTimeString() : '';
              return `
              <div class="pharmacy-thread-item msg-thread-item" data-thread-id="${t.threadId}" data-wallet-id="${pharmacyWalletId}" data-indices="${t.messages.map(m => m.messageIndex).join(',')}">
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
          ` : '<div style="color: var(--text-muted); font-size: 13px; margin-top: 8px;">No messages yet.</div>'}
        </div>
      </div>
    `;
  }

  async doExpandPharmacyThread(el) {
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
      const MSG_LABELS = { 1:'Rx', 2:'PA Req', 3:'PA Resp', 4:'Notice', 5:'General', 6:'Support', 7:'Summary' };

      bodyDiv.innerHTML = decrypted.filter(Boolean).map(m => {
        const isSent = m.senderWalletId === walletId;
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
        <button class="msg-reply-btn" data-thread-id="${threadId}" style="margin-top: 8px; font-size: 11px; background: var(--accent-orange); color: white; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer;">Reply</button>
      `;

      bodyDiv.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const lastDecrypted = decrypted.filter(Boolean).slice(-1)[0];
        const otherWid = lastDecrypted.senderWalletId === walletId ? lastDecrypted.recipientWalletId : lastDecrypted.senderWalletId;
        const otherInfo = dir[otherWid];

        document.getElementById('pharmacy-msg-thread-id').value = threadId;
        const banner = document.getElementById('pharmacy-reply-banner');
        banner.classList.remove('hidden');
        document.getElementById('pharmacy-reply-label').textContent = `Replying to: ${lastDecrypted.subject || 'conversation'}`;

        const recipientSelect = document.getElementById('pharmacy-msg-recipient');
        if (recipientSelect && otherInfo) {
          for (const opt of recipientSelect.options) {
            if (opt.textContent.includes(otherInfo.displayName)) {
              recipientSelect.value = opt.value;
              break;
            }
          }
          recipientSelect.disabled = true;
        }

        const subjectInput = document.getElementById('pharmacy-msg-subject');
        if (subjectInput && lastDecrypted.subject) {
          subjectInput.value = lastDecrypted.subject.startsWith('Re: ') ? lastDecrypted.subject : `Re: ${lastDecrypted.subject}`;
        }

        const btnSendMsg = document.getElementById('btn-pharmacy-send-msg');
        if (btnSendMsg) btnSendMsg.disabled = false;
        document.getElementById('pharmacy-msg-body')?.focus();
      });
    } catch (err) {
      bodyDiv.innerHTML = `<div style="padding: 8px; color: var(--accent-red); font-size: 12px;">Decrypt failed: ${err.message}</div>`;
    }
  }

  async doSendPharmacyMessage(currentRx) {
    const btn = document.getElementById('btn-pharmacy-send-msg');
    const recipientSelect = document.getElementById('pharmacy-msg-recipient');
    const subjectInput = document.getElementById('pharmacy-msg-subject');
    const bodyInput = document.getElementById('pharmacy-msg-body');
    const threadIdInput = document.getElementById('pharmacy-msg-thread-id');
    if (!recipientSelect.value || !subjectInput.value.trim()) return;

    const [recipientType, recipientVal] = recipientSelect.value.split(':');
    const params = {
      senderType: 'pharmacy',
      senderIndex: currentRx.pharmacyIndex,
      recipientType,
      subject: subjectInput.value.trim(),
      body: bodyInput.value.trim() || subjectInput.value.trim(),
    };
    if (recipientType === 'member') {
      params.recipientWalletId = recipientVal;
    } else if (recipientType === 'prescriber') {
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

      const resultDiv = document.getElementById('pharmacy-send-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-card" style="margin-bottom: 12px;">
          <div class="result-title">Message Sent (Encrypted)</div>
          <div class="data-grid">
            <div class="label">To</div><div class="value">${result.to}</div>
            <div class="label">Subject</div><div class="value">${result.subject}</div>
            <div class="label">Encrypted</div><div class="value">${result.ciphertextLength} bytes (AES-256-GCM)</div>
            <div class="label">Proof Time</div><div class="value">${(result.proofTimeMs / 1000).toFixed(2)}s</div>
            <div class="label">Thread</div><div class="value mono" style="font-size: 11px;">${result.threadId || 'new'}</div>
            <div class="label">Audit Hash</div><div class="value mono" style="font-size: 11px;">${result.auditChainHash ? result.auditChainHash.slice(0, 20) + '\u2026' : '\u2014'}</div>
          </div>
        </div>
      `;

      // Clear reply state
      if (threadIdInput) threadIdInput.value = '';
      const banner = document.getElementById('pharmacy-reply-banner');
      if (banner) banner.classList.add('hidden');
      if (recipientSelect) recipientSelect.disabled = false;

      if (result.chainState) updateChainState(result.chainState);
      this.app.setStatus('ready', 'Message sent');
      setTimeout(async () => {
        const stateRes = await fetch(`${API_BASE}/interactive/state`);
        if (stateRes.ok) { this.currentState = await stateRes.json(); this.render(this.currentState); }
      }, 1500);
    } catch (err) {
      const resultDiv = document.getElementById('pharmacy-send-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  // ─── Settlement & L2 Receipt ────────────────────────────

  renderSettlementSection(result) {
    if (!result.settlementCommitment || !result.fulfillmentDetail) return '';
    return `
      <div class="zk-section collapsed">
        <div class="zk-section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span style="color: var(--color-pharmacy);">Settlement Commitment</span>
          <span class="zk-arrow">&#9660;</span>
        </div>
        <div class="zk-section-body">
          <div class="hash-flow">
            <span class="hf-op">Poseidon.hash</span>
            <span class="hf-arrow">(</span>
            <span class="hf-input">fulfillmentData.commitment()</span>
            <span class="hf-arrow">,</span>
            <span class="hf-input">patientPayCents</span>
            <span class="hf-arrow">,</span>
            <span class="hf-input">planPayCents</span>
            <span class="hf-arrow">)</span>
          </div>
          <div class="hash-flow">
            <span class="hf-arrow">=</span>
            <span class="hf-output">${result.settlementCommitment}</span>
          </div>
          <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
            This commitment is stored in the TRANSACTION tree leaf 2 of the prescription forest.
            It binds the fulfillment to the exact patient/plan pay split computed by the ZK circuit.
          </div>
        </div>
      </div>
    `;
  }

  renderL2Receipt(receipt) {
    if (!receipt) return '';
    return `
      <div class="l2-receipt-card">
        <div class="receipt-title">L2 Receipt</div>
        <div class="receipt-grid">
          <div class="rl">Receipt ID</div><div class="rv">${receipt.receiptId}</div>
          <div class="rl">Sequence #</div><div class="rv">${receipt.sequenceNumber}</div>
          <div class="rl">Status</div><div class="rv"><span class="l2-status-badge pending">pending</span></div>
        </div>
      </div>
    `;
  }
}

function pct(current, max) {
  if (max === 0) return 0;
  return Math.min(100, (current / max * 100)).toFixed(1);
}
