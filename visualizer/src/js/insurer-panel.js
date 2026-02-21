/**
 * InsurerPanel — Shows ONLY what the insurer can see: opaque wallet IDs,
 * financial summaries, message metadata. No names, DOB, or addresses.
 */

import { toOpaqueId, formatTime } from './utils.js';

export class InsurerPanel {
  constructor() {
    this.init();
  }

  init() {
    this.claims = [];
    this.messages = [];
    this.totalPatientPay = 0;
    this.totalPlanPay = 0;
    this.totalIngredientCost = 0;
    this.claimCount = 0;
    this.reversalCount = 0;

    // Clear tables
    const claimsTbody = document.querySelector('#insurer-claims-table tbody');
    if (claimsTbody) claimsTbody.innerHTML = '';
    const msgTbody = document.querySelector('#insurer-messages-table tbody');
    if (msgTbody) msgTbody.innerHTML = '';
    const finEl = document.getElementById('insurer-financial');
    if (finEl) finEl.innerHTML = '';
  }

  /** Handle a viz event — extract insurer-visible data only */
  handleEvent(event) {
    if (!event.type?.startsWith('viz:')) return;

    switch (event.type) {
      case 'viz:fulfillment:settled':
        this.addClaim(event);
        break;
      case 'viz:reversal:processed':
        this.addReversal(event);
        break;
      case 'viz:message:sent':
        this.addMessage(event);
        break;
    }
  }

  addClaim(event) {
    this.claimCount++;
    const patientCents = event.data?.patientPayCents || 0;
    const planCents = event.data?.planPayCents || 0;
    this.totalPatientPay += patientCents;
    this.totalPlanPay += planCents;

    // Insurer sees: opaque wallet ID, drug hash (NDC hash), amounts, status
    this.claims.push({
      walletId: toOpaqueId(event.target || event.actor),
      drugHash: toOpaqueId(event.data?.drug || 'unknown'),
      patientPay: patientCents,
      planPay: planCents,
      status: 'SETTLED',
      timestamp: event.timestamp,
    });

    this.renderClaimsTable();
    this.renderFinancialSummary();
  }

  addReversal(event) {
    this.reversalCount++;

    this.claims.push({
      walletId: toOpaqueId(event.target || event.actor),
      drugHash: toOpaqueId(event.data?.drug || 'unknown'),
      patientPay: 0,
      planPay: 0,
      status: 'REVERSED',
      timestamp: event.timestamp,
    });

    this.renderClaimsTable();
    this.renderFinancialSummary();
  }

  addMessage(event) {
    this.messages.push({
      timestamp: event.timestamp,
      senderWallet: toOpaqueId(event.actor),
      recipientWallet: toOpaqueId(event.target || ''),
      messageType: event.data?.messageType || 'GENERAL',
      contentHash: toOpaqueId(`${event.id}-content`),
    });

    this.renderMessagesTable();
  }

  renderClaimsTable() {
    const tbody = document.querySelector('#insurer-claims-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    for (const claim of this.claims) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="wallet-id-cell hash-value">${claim.walletId}</td>
        <td class="hash-value">${claim.drugHash}</td>
        <td>$${(claim.patientPay / 100).toFixed(2)}</td>
        <td>$${(claim.planPay / 100).toFixed(2)}</td>
        <td><span class="msg-type-badge">${claim.status}</span></td>
      `;
      tbody.appendChild(tr);
    }
  }

  renderFinancialSummary() {
    const container = document.getElementById('insurer-financial');
    if (!container) return;

    container.innerHTML = `
      <div class="financial-row">
        <span class="financial-label">Total Claims</span>
        <span class="financial-value total">${this.claimCount}</span>
      </div>
      <div class="financial-row">
        <span class="financial-label">Total Reversals</span>
        <span class="financial-value" style="color: #ef5350">${this.reversalCount}</span>
      </div>
      <div class="financial-row">
        <span class="financial-label">Total Patient Responsibility</span>
        <span class="financial-value patient">$${(this.totalPatientPay / 100).toFixed(2)}</span>
      </div>
      <div class="financial-row">
        <span class="financial-label">Total Plan Liability</span>
        <span class="financial-value plan">$${(this.totalPlanPay / 100).toFixed(2)}</span>
      </div>
      <div class="financial-row">
        <span class="financial-label">Total Settled</span>
        <span class="financial-value total">$${((this.totalPatientPay + this.totalPlanPay) / 100).toFixed(2)}</span>
      </div>
    `;
  }

  renderMessagesTable() {
    const tbody = document.querySelector('#insurer-messages-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    for (const msg of this.messages) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatTime(msg.timestamp)}</td>
        <td class="wallet-id-cell hash-value">${msg.senderWallet}</td>
        <td class="wallet-id-cell hash-value">${msg.recipientWallet}</td>
        <td><span class="msg-type-badge">${msg.messageType}</span></td>
        <td class="hash-value">${msg.contentHash}</td>
      `;
      tbody.appendChild(tr);
    }
  }
}
