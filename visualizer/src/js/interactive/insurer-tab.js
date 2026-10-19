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
 * Insurer Tab — Opaque/hashed data view for the insurer role.
 *
 * Zero PHI/PII. Shows only:
 *   - CareContract on-chain state (8 Merkle roots / counts)
 *   - Enrollment metrics (aggregate counts)
 *   - Wallet registry (truncated Poseidon hashes only)
 *   - Benefit plan configuration (public insurer config)
 *   - Financial summary (aggregate totals)
 *   - Prescription/fulfillment registries (opaque IDs + amounts)
 *   - Audit summary
 */

import { API_BASE, formatCents, updateChainState } from '../interactive-app.js';
import { loadInteractiveState } from './state-client.js';
import { escapeHtml, renderMessageBubbles } from './message-thread.js';

export class InsurerTab {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('tab-insurer');
  }

  render(state) {
    if (!state) {
      this.container.innerHTML = `<div class="waiting-message"><p>Loading...</p></div>`;
      return;
    }

    this.currentState = state;

    this.container.innerHTML = `
      ${this.renderPrivacyNotice()}
      ${this.renderPriorAuthManagement(state)}
      ${this.renderInsurerCommunications(state)}
      ${this.renderOpaqueMessageRegistry(state)}
      ${this.renderOpaqueDelegationRegistry(state)}
      ${this.renderChainState(state)}
      ${this.renderEnrollmentMetrics(state)}
      ${this.renderWalletRegistry(state)}
      ${this.renderOpaqueRoster(state)}
      ${this.renderBenefitPlanAndFormulary(state)}
      ${this.renderProviderNetworkManagement(state)}
      ${this.renderFinancialSummary(state)}
      ${this.renderPrescriptionRegistry(state)}
      ${this.renderFulfillmentRegistry(state)}
      ${this.renderAuditSummary(state)}
    `;

    this.bindPaActions();
    this.bindTerminateActions();
    this.bindMessagingActions();
    this.bindFormularyActions();
    this.bindNetworkActions();
  }

  // ─── Section 1: Privacy Notice ──────────────────────────

  renderPrivacyNotice() {
    return `
      <div class="section-card" style="border-color: rgba(171, 71, 188, 0.3);">
        <div class="card-body" style="display: flex; align-items: center; gap: 12px; padding: 14px 16px;">
          <span style="font-size: 24px;">&#128274;</span>
          <div>
            <div style="font-weight: 700; color: var(--color-insurer); margin-bottom: 4px;">Insurer View — Zero PHI/PII</div>
            <div style="font-size: 12px; color: var(--text-secondary);">
              All data shown is opaque wallet IDs (Poseidon hashes), on-chain Merkle roots, and aggregate
              financial summaries. The insurer cannot identify any individual member, prescriber, or pharmacy.
              Drug names are not visible to the insurer — only opaque prescription IDs.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Messaging: Opaque Registry (all messages, hashes only) ──

  renderOpaqueMessageRegistry(state) {
    const messaging = state.messaging;
    if (!messaging || messaging.messageCount === 0) {
      return this.emptyCard('Messaging Registry \u2014 On-Chain (Opaque)', 'No messages in registry.');
    }

    const messages = messaging.messages || [];
    const rows = messages.map((m, i) => `
      <tr>
        <td style="font-size: 11px;">${i}</td>
        <td class="mono" style="font-size: 10px;">${truncHash(m.senderWalletId)}</td>
        <td class="mono" style="font-size: 10px;">${truncHash(m.recipientWalletId)}</td>
        <td class="mono" style="font-size: 10px;">${truncHash(m.contentHash)}</td>
        <td style="font-size: 11px;">${m.messageType}</td>
        <td style="font-size: 11px;">${m.nonce}</td>
      </tr>
    `).join('');

    return `
      <div class="section-card" style="border-color: rgba(171, 71, 188, 0.3);">
        <div class="card-header insurer">
          Messaging Registry \u2014 On-Chain (Opaque)
          <span style="font-weight: 400; font-size: 12px; opacity: 0.7;">${messaging.messageCount} messages</span>
        </div>
        <div class="card-body">
          <div style="padding: 8px 12px; background: rgba(171, 71, 188, 0.06); border: 1px solid rgba(171, 71, 188, 0.2); border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: var(--text-secondary);">
            <strong style="color: var(--color-insurer);">Privacy:</strong>
            The insurer CANNOT read messages between other parties. Only Poseidon hash commitments are stored on-chain.
            No plaintext, no display names \u2014 just opaque wallet IDs and content hashes.
          </div>
          <div class="insurer-metric-row" style="margin-bottom: 12px;">
            ${this.metricBox('Messages', messaging.messageCount)}
            ${this.metricBox('Delegations', messaging.delegationCount)}
            ${this.metricBox('Encryption Keys', messaging.keyCount)}
          </div>
          <div style="max-height: 300px; overflow-y: auto;">
            <table class="insurer-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Sender (Hash)</th>
                  <th>Recipient (Hash)</th>
                  <th>Content Hash</th>
                  <th>Type</th>
                  <th>Nonce</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Messaging: Insurer Communications (own inbox + compose) ──

  renderInsurerCommunications(state) {
    const dir = state.walletDirectory || {};
    const MSG_LABELS = { 1:'Rx', 2:'PA Req', 3:'PA Resp', 4:'Notice', 5:'General', 6:'Support', 7:'Summary' };

    let insurerWalletId = null;
    for (const [wid, info] of Object.entries(dir)) {
      if (info.type === 'insurer') { insurerWalletId = wid; break; }
    }

    const messages = insurerWalletId
      ? (state.messaging?.messages || []).filter(m =>
          m.senderWalletId === insurerWalletId || m.recipientWalletId === insurerWalletId)
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
    (state.enrolledMembers || []).filter(m => m.lifecycle !== 'REVOKED').forEach(m => {
      recipientOptions.push(`<option value="member:${m.walletId}">${m.displayName}</option>`);
    });
    (state.demoData?.prescribers || []).forEach(p => {
      recipientOptions.push(`<option value="prescriber:${p.index}">Dr. ${p.firstName} ${p.lastName}</option>`);
    });
    (state.demoData?.pharmacies || []).forEach(p => {
      recipientOptions.push(`<option value="pharmacy:${p.index}">${p.storeName}</option>`);
    });

    return `
      <div class="section-card">
        <div class="card-header insurer">Insurer Communications (${messages.length})</div>
        <div class="card-body">
          <div id="insurer-reply-banner" class="hidden" style="background: var(--bg-tertiary); border: 1px solid var(--color-insurer); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <span id="insurer-reply-label" style="font-size: 12px; color: var(--color-insurer);"></span>
            <button id="insurer-cancel-reply" style="background: none; border: none; color: var(--accent-red); cursor: pointer; font-size: 12px;">Cancel</button>
          </div>
          <div class="msg-compose">
            <div style="font-size: 12px; font-weight: 600; color: var(--color-insurer); margin-bottom: 8px;">Send Notification</div>
            <label>To</label>
            <select id="insurer-msg-recipient">
              <option value="">\u2014 Select recipient \u2014</option>
              ${recipientOptions.join('')}
            </select>
            <label>Subject</label>
            <input type="text" id="insurer-msg-subject" placeholder="Subject">
            <label>Message</label>
            <textarea id="insurer-msg-body" rows="2" placeholder="Type your message..."></textarea>
            <input type="hidden" id="insurer-msg-thread-id" value="">
            <button id="btn-insurer-send-msg" class="btn-action insurer" disabled>
              <span class="spinner"></span> Send Notification
            </button>
            <div class="msg-privacy-note">End-to-end encrypted (X25519-ECDH + AES-256-GCM). ZK proof generated on send.</div>
          </div>
          <div id="insurer-send-result" class="hidden"></div>
          ${threads.length > 0 ? `
          <div class="msg-thread-list">
            ${threads.map(t => {
              const lastMsg = t.messages[t.messages.length - 1];
              const isSent = lastMsg.senderWalletId === insurerWalletId;
              const otherWid = isSent ? lastMsg.recipientWalletId : lastMsg.senderWalletId;
              const otherName = dir[otherWid]?.displayName || otherWid.slice(0,8) + '\u2026';
              const typeLabel = MSG_LABELS[lastMsg.messageType] || 'Msg';
              const timeStr = lastMsg.timestamp ? new Date(lastMsg.timestamp).toLocaleTimeString() : '';
              return `
              <div class="insurer-thread-item msg-thread-item" data-thread-id="${t.threadId}" data-wallet-id="${insurerWalletId}" data-indices="${t.messages.map(m => m.messageIndex).join(',')}">
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
          ` : '<div style="color: var(--text-muted); font-size: 13px; margin-top: 8px;">No insurer messages yet. Auto-messages appear here after enrollment, PA actions, and terminations.</div>'}
        </div>
      </div>
    `;
  }

  // ─── Messaging: Opaque Delegation Registry ──────────────

  renderOpaqueDelegationRegistry(state) {
    const delegations = state.messaging?.delegations || [];
    if (delegations.length === 0) return '';

    const rows = delegations.map((d, i) => `
      <tr>
        <td style="font-size: 11px;">${i}</td>
        <td class="mono" style="font-size: 10px;">${truncHash(d.delegatorWalletId)}</td>
        <td class="mono" style="font-size: 10px;">${truncHash(d.delegateWalletId)}</td>
        <td style="font-size: 11px;">${d.scopeFlags}</td>
        <td style="font-size: 11px;">${d.relationshipCode}</td>
      </tr>
    `).join('');

    return `
      <div class="section-card">
        <div class="card-header insurer">Delegation Registry \u2014 Opaque</div>
        <div class="card-body">
          <table class="insurer-table">
            <thead>
              <tr><th>#</th><th>Delegator (Hash)</th><th>Delegate (Hash)</th><th>Scope</th><th>Relationship</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
            Only raw codes shown. The insurer cannot identify parties or interpret scope labels.
          </div>
        </div>
      </div>
    `;
  }

  // ─── Messaging Event Binding ──────────────────────────

  bindMessagingActions() {
    const msgRecipient = document.getElementById('insurer-msg-recipient');
    const msgSubject = document.getElementById('insurer-msg-subject');
    const btnSendMsg = document.getElementById('btn-insurer-send-msg');
    if (msgRecipient && btnSendMsg) {
      const enableSend = () => {
        btnSendMsg.disabled = !msgRecipient.value || !msgSubject?.value?.trim();
      };
      msgRecipient.addEventListener('change', enableSend);
      if (msgSubject) msgSubject.addEventListener('input', enableSend);
      btnSendMsg.addEventListener('click', () => this.doSendInsurerMessage());
    }
    // Cancel reply
    const btnCancelReply = document.getElementById('insurer-cancel-reply');
    if (btnCancelReply) {
      btnCancelReply.addEventListener('click', () => {
        document.getElementById('insurer-msg-thread-id').value = '';
        document.getElementById('insurer-reply-banner').classList.add('hidden');
        if (msgSubject) msgSubject.value = '';
        if (msgRecipient) { msgRecipient.value = ''; msgRecipient.disabled = false; }
      });
    }
    // Thread click handlers
    document.querySelectorAll('.insurer-thread-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.msg-reply-btn')) return;
        this.doExpandInsurerThread(el);
      });
    });
  }

  async doExpandInsurerThread(el) {
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
        <button class="msg-reply-btn" data-thread-id="${escapeHtml(threadId)}" style="margin-top: 8px; font-size: 11px; background: var(--color-insurer); color: white; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer;">Reply</button>
      `;

      bodyDiv.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const lastDecrypted = decrypted.filter(Boolean).slice(-1)[0];
        const otherWid = lastDecrypted.senderWalletId === walletId ? lastDecrypted.recipientWalletId : lastDecrypted.senderWalletId;
        const otherInfo = dir[otherWid];

        document.getElementById('insurer-msg-thread-id').value = threadId;
        const banner = document.getElementById('insurer-reply-banner');
        banner.classList.remove('hidden');
        document.getElementById('insurer-reply-label').textContent = `Replying to: ${lastDecrypted.subject || 'conversation'}`;

        const recipientSelect = document.getElementById('insurer-msg-recipient');
        if (recipientSelect && otherInfo) {
          for (const opt of recipientSelect.options) {
            if (opt.textContent.includes(otherInfo.displayName)) {
              recipientSelect.value = opt.value;
              break;
            }
          }
          recipientSelect.disabled = true;
        }

        const subjectInput = document.getElementById('insurer-msg-subject');
        if (subjectInput && lastDecrypted.subject) {
          subjectInput.value = lastDecrypted.subject.startsWith('Re: ') ? lastDecrypted.subject : `Re: ${lastDecrypted.subject}`;
        }

        const btnSendMsg = document.getElementById('btn-insurer-send-msg');
        if (btnSendMsg) btnSendMsg.disabled = false;
        document.getElementById('insurer-msg-body')?.focus();
      });
    } catch (err) {
      bodyDiv.innerHTML = `<div style="padding: 8px; color: var(--accent-red); font-size: 12px;">Decrypt failed: ${err.message}</div>`;
    }
  }

  async doSendInsurerMessage() {
    const btn = document.getElementById('btn-insurer-send-msg');
    const recipientSelect = document.getElementById('insurer-msg-recipient');
    const subjectInput = document.getElementById('insurer-msg-subject');
    const bodyInput = document.getElementById('insurer-msg-body');
    const threadIdInput = document.getElementById('insurer-msg-thread-id');
    if (!recipientSelect.value || !subjectInput.value.trim()) return;

    const [recipientType, recipientVal] = recipientSelect.value.split(':');
    const params = {
      senderType: 'insurer',
      recipientType,
      subject: subjectInput.value.trim(),
      body: bodyInput.value.trim() || subjectInput.value.trim(),
    };
    if (recipientType === 'member') {
      params.recipientWalletId = recipientVal;
    } else if (recipientType === 'prescriber' || recipientType === 'pharmacy') {
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

      const resultDiv = document.getElementById('insurer-send-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-card" style="margin-bottom: 12px;">
          <div class="result-title">Notification Sent (Encrypted)</div>
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
      const banner = document.getElementById('insurer-reply-banner');
      if (banner) banner.classList.add('hidden');
      if (recipientSelect) recipientSelect.disabled = false;

      if (result.chainState) updateChainState(result.chainState);
      this.app.setStatus('ready', 'Notification sent');
      setTimeout(async () => {
        const fresh = await loadInteractiveState(API_BASE);
        if (fresh) { this.render(fresh); }
      }, 1500);
    } catch (err) {
      const resultDiv = document.getElementById('insurer-send-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  // ─── Section 2: CareContract On-Chain State ─────────────

  renderChainState(state) {
    const cs = state.chainState;
    if (!cs) {
      return this.emptyCard('CareContract — On-Chain State', 'No chain state yet. Awaiting first enrollment.');
    }

    return `
      <div class="section-card">
        <div class="card-header insurer">CareContract — 8 On-Chain Slots</div>
        <div class="card-body">
          <div class="data-grid" style="grid-template-columns: 180px 1fr;">
            <div class="label">walletRegistryRoot</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${cs.walletRegistryRoot}</div>
            <div class="label">walletCount</div><div class="value">${cs.walletCount}</div>
            <div class="label">adminPublicKeyHash</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${cs.adminPublicKeyHash}</div>
            <div class="label">lifecycleRoot</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${cs.lifecycleRoot}</div>
            <div class="label">benefitPlanRoot</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${cs.benefitPlanRoot}</div>
            <div class="label">credentialRegistryRoot</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${cs.nftRegistryRoot}</div>
            <div class="label">eligibilityVkHash</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${cs.eligibilityVkHash}</div>
            <div class="label">messagingRoot</div><div class="value mono" style="font-size: 11px; word-break: break-all;">${cs.messagingRoot}</div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Section 3: Enrollment Metrics ──────────────────────

  renderEnrollmentMetrics(state) {
    const enrolled = state.enrolledMembers || [];
    if (enrolled.length === 0) {
      return this.emptyCard('Enrollment Metrics', 'No wallets registered yet.');
    }

    // Group counts
    const groups = new Map();
    const families = new Map();
    let subscribers = 0;
    let dependents = 0;

    let revoked = 0;
    for (const m of enrolled) {
      groups.set(m.groupId, (groups.get(m.groupId) || 0) + 1);
      if (m.familyId) families.set(m.familyId, (families.get(m.familyId) || 0) + 1);
      if (m.relationship === 'SELF') subscribers++;
      else dependents++;
      if (m.lifecycle === 'REVOKED') revoked++;
    }

    const groupRows = [...groups.entries()].map(([gid, count]) =>
      `<div class="label">${gid}</div><div class="value">${count} wallet${count > 1 ? 's' : ''}</div>`
    ).join('');

    return `
      <div class="section-card">
        <div class="card-header insurer">Enrollment Metrics</div>
        <div class="card-body">
          <div class="insurer-metric-row">
            ${this.metricBox('Total Wallets', enrolled.length)}
            ${this.metricBox('Active', enrolled.length - revoked)}
            ${revoked > 0 ? this.metricBox('Revoked', revoked) : this.metricBox('Groups', groups.size)}
            ${this.metricBox('Subscribers', subscribers)}
            ${this.metricBox('Dependents', dependents)}
          </div>
          <div style="margin-top: 16px;">
            <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">BY GROUP</div>
            <div class="data-grid">${groupRows}</div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Section 4: Wallet Registry ─────────────────────────

  renderWalletRegistry(state) {
    const enrolled = state.enrolledMembers || [];
    if (enrolled.length === 0) {
      return this.emptyCard('Wallet Registry', 'No wallets registered.');
    }

    const rows = enrolled.map(m => {
      const isRevoked = m.lifecycle === 'REVOKED';
      const lifecycleClass = isRevoked ? 'rx-status-cancelled' : 'rx-status-active';
      const lifecycleLabel = isRevoked ? 'REVOKED' : (m.lifecycle || 'ELIGIBLE');
      return `
      <tr${isRevoked ? ' style="opacity: 0.6;"' : ''}>
        <td class="mono" style="font-size: 11px;">${m.walletIdDisplay || truncHash(m.walletId)}</td>
        <td>${m.groupId}</td>
        <td>${m.planId}</td>
        <td><span class="family-badge ${(m.relationship || 'SELF').toLowerCase()}">${m.relationship || 'SELF'}</span></td>
        <td><span class="rx-status-badge ${lifecycleClass}">${lifecycleLabel}</span></td>
        <td>${isRevoked
          ? `<span style="font-size: 11px; color: var(--text-muted);">${m.terminationDate || ''}</span>`
          : `<button class="btn-terminate-member" data-wallet-id="${m.walletId}" style="font-size: 11px; padding: 3px 10px; background: var(--accent-red); color: #0d1117; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">Terminate</button>`
        }</td>
      </tr>
    `;
    }).join('');

    // Group termination buttons
    const activeGroups = new Map();
    for (const m of enrolled) {
      if (m.lifecycle !== 'REVOKED') {
        activeGroups.set(m.groupId, (activeGroups.get(m.groupId) || 0) + 1);
      }
    }
    const groupButtons = activeGroups.size > 0
      ? `<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
          ${[...activeGroups.entries()].map(([gid, count]) =>
            `<button class="btn-terminate-group" data-group-id="${gid}" style="font-size: 11px; padding: 5px 12px; background: var(--accent-red); color: #0d1117; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">Terminate Group: ${gid} (${count} active)</button>`
          ).join('')}
        </div>`
      : '';

    return `
      <div class="section-card">
        <div class="card-header insurer">Wallet Registry — Opaque IDs Only</div>
        <div class="card-body">
          <table class="insurer-table">
            <thead>
              <tr>
                <th>Wallet ID (Hash)</th>
                <th>Group</th>
                <th>Plan</th>
                <th>Relationship</th>
                <th>Lifecycle</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          ${groupButtons}
          <div id="termination-result" class="hidden" style="margin-top: 12px;"></div>
          <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
            Wallet IDs are Poseidon hashes. The insurer cannot reverse these to identify individuals.
          </div>
        </div>
      </div>
    `;
  }

  // ─── Section 5: Opaque Roster Summary ───────────────────

  renderOpaqueRoster(state) {
    const enrolled = state.enrolledMembers || [];
    if (enrolled.length === 0) {
      return this.emptyCard('Opaque Roster', 'No roster entries.');
    }

    const groups = new Map();
    for (const m of enrolled) {
      if (!groups.has(m.groupId)) {
        groups.set(m.groupId, { count: 0, active: 0, planId: m.planId });
      }
      const g = groups.get(m.groupId);
      g.count++;
      if (m.lifecycle !== 'REVOKED') g.active++;
    }

    const rows = [...groups.entries()].map(([gid, info]) => {
      const allTerminated = info.active === 0;
      return `
      <tr${allTerminated ? ' style="opacity: 0.6;"' : ''}>
        <td>${gid}</td>
        <td>${info.planId}</td>
        <td>${info.active} / ${info.count}</td>
        <td style="color: ${allTerminated ? 'var(--accent-red)' : 'var(--accent-green)'};">
          ${allTerminated ? 'TERMINATED' : 'OPEN'}
        </td>
      </tr>
    `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header insurer">Opaque Roster — Group Summary</div>
        <div class="card-body">
          <table class="insurer-table">
            <thead>
              <tr><th>Group ID</th><th>Plan</th><th>Active / Total</th><th>Status</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── Section 6: Benefit Plan & Formulary Management ─────

  renderBenefitPlanAndFormulary(state) {
    const plan = state.demoData?.plan;
    if (!plan) {
      return this.emptyCard('Benefit Plan & Formulary', 'No plan data available.');
    }

    const medications = state.demoData?.medications || [];
    const activeMedCount = medications.filter(m => m.active !== false).length;
    const history = state.formularyChangeHistory || [];

    const medRows = medications.map((m, i) => {
      const isActive = m.active !== false;
      const isOffFormulary = m.initiallyOnFormulary === false && !isActive;
      const wasRemoved = m.initiallyOnFormulary !== false && !isActive;
      const rowClass = isActive ? '' : 'formulary-removed';
      const tier = m.currentTierLevel || m.tier;
      const copay = m.currentCopayAmountCents ?? m.copayAmountCents;
      const pa = m.currentRequiresPriorAuth ?? m.requiresPriorAuth;
      const step = m.currentStepTherapyRequired ?? m.stepTherapyRequired;

      let statusHtml, actionsHtml;
      if (isActive) {
        statusHtml = '<span style="color: var(--accent-green);">Active</span>';
        actionsHtml = `<button class="btn-formulary-action btn-formulary-modify" data-med-index="${i}">Edit</button>
                       <button class="btn-formulary-action btn-formulary-remove" data-med-index="${i}">Remove</button>`;
      } else if (isOffFormulary) {
        statusHtml = '<span style="color: var(--accent-orange); font-weight: 600;">Off-Formulary</span>';
        actionsHtml = `<button class="btn-formulary-action btn-formulary-add" data-med-index="${i}">Add to Formulary</button>`;
      } else {
        statusHtml = '<span style="color: var(--accent-red);">Removed</span>';
        actionsHtml = `<button class="btn-formulary-action btn-formulary-add" data-med-index="${i}">Re-add</button>`;
      }

      return `
        <tr class="${rowClass}" data-med-index="${i}">
          <td>${i}</td>
          <td>${m.brandName}${m.deaSchedule > 0 ? ` <span class="dea-badge dea-schedule-${m.deaSchedule}">C-${m.deaSchedule}</span>` : ''}</td>
          <td><span class="tier-badge tier-${tier}">T${tier}</span></td>
          <td>${formatCents(copay)}</td>
          <td>${pa ? 'Yes' : 'No'}</td>
          <td>${step ? 'Yes' : 'No'}</td>
          <td>${statusHtml}</td>
          <td>${actionsHtml}</td>
        </tr>
      `;
    }).join('');

    const historyHtml = history.length > 0 ? `
      <div style="margin-top: 16px;">
        <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">Formulary Change History</div>
        <div style="max-height: 200px; overflow-y: auto;">
          ${history.map(h => `
            <div class="formulary-history-entry">
              <span class="formulary-history-type formulary-history-${h.changeType.toLowerCase()}">${h.changeType}</span>
              <span>${h.medicationName}</span>
              <span style="color: var(--text-muted); font-size: 11px;">${h.details}</span>
              <span style="color: var(--text-muted); font-size: 10px;">${h.affectedMembers.length} member(s)</span>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    return `
      <div class="section-card">
        <div class="card-header insurer">Benefit Plan & Formulary Management</div>
        <div class="card-body">
          <div class="data-grid" style="margin-bottom: 16px;">
            <div class="label">Plan ID</div><div class="value">${plan.planId}</div>
            <div class="label">Copay (Generic)</div><div class="value">${formatCents(plan.copayAmountCents)}</div>
            <div class="label">Deductible (Ind)</div><div class="value">${formatCents(plan.deductibleAmountCents)}</div>
            <div class="label">OOP Max (Ind)</div><div class="value">${formatCents(plan.oopMaxCents)}</div>
            <div class="label">Annual Max</div><div class="value">${plan.annualBenefitMaxCents === 0 ? 'Unlimited' : formatCents(plan.annualBenefitMaxCents)}</div>
            <div class="label">Formulary</div><div class="value">${activeMedCount} active / ${medications.length} total</div>
            <div class="label">Formulary Root</div><div class="value mono" style="font-size: 10px;">${plan.formularyRoot || 'N/A'}</div>
          </div>

          <div style="margin-bottom: 16px; padding: 12px; background: rgba(171, 71, 188, 0.06); border: 1px solid rgba(171, 71, 188, 0.2); border-radius: 6px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <div style="font-size: 12px; font-weight: 600; color: var(--color-insurer);">Plan Year Rollover</div>
                <div style="font-size: 11px; color: var(--text-secondary);">Reset all member accumulators (deductible, OOPM, benefit used) to $0.</div>
              </div>
              <button id="btn-plan-rollover" class="btn-action insurer" style="font-size: 12px; padding: 6px 16px;">
                <span class="spinner"></span> Rollover to 2027
              </button>
            </div>
            <div id="rollover-result" class="hidden" style="margin-top: 8px;"></div>
          </div>

          <div style="font-size: 12px; font-weight: 600; color: var(--color-insurer); margin-bottom: 8px;">
            Formulary Medications
            <span style="font-weight: 400; opacity: 0.7;">(click Edit to modify, Remove to exclude)</span>
          </div>
          <div style="max-height: 400px; overflow-y: auto;">
            <table class="insurer-table formulary-mgmt-table">
              <thead>
                <tr><th>#</th><th>Drug</th><th>Tier</th><th>Copay</th><th>PA</th><th>Step</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>${medRows}</tbody>
            </table>
          </div>

          <div id="formulary-edit-form" class="hidden" style="margin-top: 12px; padding: 12px; background: rgba(171, 71, 188, 0.06); border: 1px solid rgba(171, 71, 188, 0.2); border-radius: 6px;">
            <div style="font-size: 12px; font-weight: 600; color: var(--color-insurer); margin-bottom: 8px;">
              Modify: <span id="formulary-edit-drug-name"></span>
            </div>
            <div class="form-row" style="gap: 8px; display: flex; flex-wrap: wrap;">
              <div class="form-group" style="flex: 1; min-width: 100px;">
                <label style="font-size: 11px; display: block; margin-bottom: 4px;">Tier</label>
                <select id="formulary-edit-tier" style="width: 100%; padding: 4px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 4px;">
                  <option value="1">Tier 1 (Generic)</option>
                  <option value="2">Tier 2 (Preferred)</option>
                  <option value="3">Tier 3 (Non-Preferred)</option>
                  <option value="4">Tier 4 (Specialty)</option>
                </select>
              </div>
              <div class="form-group" style="flex: 1; min-width: 100px;">
                <label style="font-size: 11px; display: block; margin-bottom: 4px;">Copay ($)</label>
                <input type="number" id="formulary-edit-copay" min="0" step="5" style="width: 100%; padding: 4px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 4px;" />
              </div>
              <div class="form-group" style="flex: 1; min-width: 80px; display: flex; align-items: center; padding-top: 16px;">
                <label style="font-size: 11px;"><input type="checkbox" id="formulary-edit-pa" /> Require PA</label>
              </div>
              <div class="form-group" style="flex: 1; min-width: 80px; display: flex; align-items: center; padding-top: 16px;">
                <label style="font-size: 11px;"><input type="checkbox" id="formulary-edit-step" /> Step Therapy</label>
              </div>
            </div>
            <div style="margin-top: 8px;">
              <button id="btn-formulary-save" class="btn-action insurer" style="font-size: 12px; padding: 6px 16px;">
                <span class="spinner"></span> Apply Change (Cascade to All Members)
              </button>
              <button id="btn-formulary-cancel" style="font-size: 12px; padding: 6px 12px; background: none; border: 1px solid var(--border-subtle); color: var(--text-secondary); cursor: pointer; border-radius: 4px; margin-left: 8px;">Cancel</button>
            </div>
          </div>

          <div id="formulary-action-result" class="hidden" style="margin-top: 12px;"></div>
          ${historyHtml}
        </div>
      </div>
    `;
  }

  // ─── Section 6b: Provider Network Management ──────────────

  renderProviderNetworkManagement(state) {
    const networkData = state.demoData?.providerNetwork;
    const prescribers = state.demoData?.prescribers || [];
    const walletDir = state.walletDirectory || {};

    if (!networkData) {
      return this.emptyCard('Provider Network Management', 'No network data available.');
    }

    const activeMap = networkData.active || {};
    const inNetworkCount = Object.values(activeMap).filter(v => v === true).length;
    const totalCount = Object.keys(activeMap).length;
    const history = networkData.changeHistory || [];

    const prescriberRows = prescribers.map((p, i) => {
      // Find walletId for this prescriber
      let walletIdStr = '';
      for (const [wid, info] of Object.entries(walletDir)) {
        if (info.type === 'prescriber' && info.index === i) {
          walletIdStr = wid;
          break;
        }
      }

      const displayName = `Dr. ${p.firstName} ${p.lastName}`;
      const isInNetwork = walletIdStr ? activeMap[walletIdStr] === true : false;
      const rowClass = isInNetwork ? '' : 'formulary-removed';
      const truncWid = walletIdStr ? walletIdStr.slice(0, 12) + '...' : 'N/A';

      return `
        <tr class="${rowClass}" data-prescriber-wallet="${walletIdStr}">
          <td>${i}</td>
          <td>${displayName}</td>
          <td>${p.specialty || 'General'}</td>
          <td class="mono" style="font-size: 10px;">${truncWid}</td>
          <td>${isInNetwork
            ? '<span style="color: var(--accent-green);">In-Network</span>'
            : '<span style="color: var(--accent-red);">Out-of-Network</span>'}</td>
          <td>
            ${isInNetwork
              ? `<button class="btn-network-action btn-network-remove" data-prescriber-wallet="${walletIdStr}" data-prescriber-name="${displayName}">Remove</button>`
              : `<button class="btn-network-action btn-network-add" data-prescriber-wallet="${walletIdStr}" data-prescriber-name="${displayName}">Add</button>`}
          </td>
        </tr>
      `;
    }).join('');

    const historyHtml = history.length > 0 ? `
      <div style="margin-top: 16px;">
        <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">Network Change History</div>
        <div style="max-height: 200px; overflow-y: auto;">
          ${history.map(h => `
            <div class="formulary-history-entry">
              <span class="formulary-history-type formulary-history-${h.changeType.toLowerCase()}">${h.changeType}</span>
              <span>${h.prescriberName}</span>
              <span style="color: var(--text-muted); font-size: 11px;">${h.details}</span>
              <span style="color: var(--text-muted); font-size: 10px;">${h.affectedMemberCount} member(s)</span>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    return `
      <div class="section-card">
        <div class="card-header insurer">Provider Network Management</div>
        <div class="card-body">
          <div class="data-grid" style="margin-bottom: 16px;">
            <div class="label">In-Network</div><div class="value">${inNetworkCount} / ${totalCount} prescribers</div>
            <div class="label">Network Root</div><div class="value mono" style="font-size: 10px;">${networkData.root === '0' ? 'Field(0) — all accepted' : networkData.root}</div>
          </div>

          <div style="font-size: 12px; font-weight: 600; color: var(--color-insurer); margin-bottom: 8px;">
            Prescriber Network
            <span style="font-weight: 400; opacity: 0.7;">(click Add/Remove to change network status)</span>
          </div>
          <div style="max-height: 400px; overflow-y: auto;">
            <table class="insurer-table">
              <thead>
                <tr><th>#</th><th>Prescriber</th><th>Specialty</th><th>Wallet ID (hash)</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>${prescriberRows}</tbody>
            </table>
          </div>

          <div id="network-action-result" class="hidden" style="margin-top: 12px;"></div>
          ${historyHtml}
        </div>
      </div>
    `;
  }

  // ─── Section 7: Financial Summary ───────────────────────

  renderFinancialSummary(state) {
    const fulfillments = state.fulfillments || [];
    if (fulfillments.length === 0) {
      return this.emptyCard('Financial Summary', 'No claims adjudicated yet.');
    }

    let totalPatient = 0, totalPlan = 0, totalCost = 0;
    let reversedCount = 0, reversedPatient = 0, reversedPlan = 0;
    for (const f of fulfillments) {
      if (f.reversed) {
        reversedCount++;
        reversedPatient += f.patientPayCents || 0;
        reversedPlan += f.planPayCents || 0;
      } else {
        totalPatient += f.patientPayCents || 0;
        totalPlan += f.planPayCents || 0;
        totalCost += f.totalCostCents || 0;
      }
    }
    const activeFills = fulfillments.length - reversedCount;
    const avgCost = activeFills > 0 ? Math.round(totalCost / activeFills) : 0;

    return `
      <div class="section-card">
        <div class="card-header insurer">Financial Summary — Aggregate</div>
        <div class="card-body">
          <div class="insurer-metric-row">
            ${this.metricBox('Active Claims', activeFills)}
            ${this.metricBox('Patient Pay', formatCents(totalPatient))}
            ${this.metricBox('Plan Pay', formatCents(totalPlan))}
            ${this.metricBox('Total Cost', formatCents(totalCost))}
            ${this.metricBox('Avg Claim', formatCents(avgCost))}
          </div>
          ${reversedCount > 0 ? `
          <div class="insurer-metric-row" style="margin-top: 12px;">
            ${this.metricBox('Reversed', reversedCount)}
            ${this.metricBox('Patient Refund', formatCents(reversedPatient))}
            ${this.metricBox('Plan Refund', formatCents(reversedPlan))}
          </div>
          ` : ''}
          <div style="margin-top: 12px;">
            <div class="progress-container">
              <div class="progress-label">
                <span>Plan vs Patient Split</span>
                <span>${totalCost > 0 ? Math.round(totalPlan / totalCost * 100) : 0}% plan / ${totalCost > 0 ? Math.round(totalPatient / totalCost * 100) : 0}% patient</span>
              </div>
              <div class="progress-bar" style="height: 12px;">
                <div class="fill" style="width: ${totalCost > 0 ? (totalPlan / totalCost * 100).toFixed(1) : 0}%; background: var(--color-insurer);"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Section 8: Prescription Registry (Opaque) ─────────

  renderPrescriptionRegistry(state) {
    const rxs = state.prescriptions || [];
    if (rxs.length === 0) {
      return this.emptyCard('Prescription Registry', 'No prescriptions issued.');
    }

    const rows = rxs.map(rx => {
      const walletDisplay = truncHash(rx.memberWalletId);
      const status = rx.status || (rx.filled ? 'FILLED' : 'ACTIVE');
      const statusClass = `rx-status-${status.toLowerCase().replace('_', '-')}`;
      return `
        <tr>
          <td class="mono" style="font-size: 11px;">${rx.id}</td>
          <td class="mono" style="font-size: 11px;">${walletDisplay}</td>
          <td>${rx.quantityDispensed || 0} / ${rx.quantity}</td>
          <td><span class="rx-status-badge ${statusClass}">${status.replace('_', ' ')}</span></td>
        </tr>
      `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header insurer">Prescription Registry — Opaque</div>
        <div class="card-body">
          <table class="insurer-table">
            <thead>
              <tr><th>Prescription ID</th><th>Member Wallet (Hash)</th><th>Qty Dispensed</th><th>Status</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
            Medication names are not visible to the insurer. Only opaque prescription IDs and status.
          </div>
        </div>
      </div>
    `;
  }

  // ─── Section 9: Fulfillment/Settlement Registry ────────

  renderFulfillmentRegistry(state) {
    const fulfillments = state.fulfillments || [];
    if (fulfillments.length === 0) {
      return this.emptyCard('Settlement Registry', 'No settlements recorded.');
    }

    const rows = fulfillments.map(f => {
      const isReversed = f.reversed;
      const rowStyle = isReversed ? ' style="opacity: 0.5; text-decoration: line-through;"' : '';
      return `
      <tr${rowStyle}>
        <td class="mono" style="font-size: 11px;">${f.prescriptionId || '\u2014'}</td>
        <td>${formatCents(f.patientPayCents || 0)}</td>
        <td>${formatCents(f.planPayCents || 0)}</td>
        <td class="mono" style="font-size: 10px; word-break: break-all;">${truncHash(f.settlementCommitment || '')}</td>
        <td>${isReversed ? '<span class="rx-status-badge rx-status-reversed">REVERSED</span>' : '<span class="rx-status-badge rx-status-filled">ACTIVE</span>'}</td>
      </tr>
    `;
    }).join('');

    return `
      <div class="section-card">
        <div class="card-header insurer">Settlement Registry</div>
        <div class="card-body">
          <table class="insurer-table">
            <thead>
              <tr><th>Rx ID</th><th>Patient Pay</th><th>Plan Pay</th><th>Settlement Hash</th><th>Status</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ─── Section 10: Audit Summary ──────────────────────────

  renderAuditSummary(state) {
    const audit = state.auditSummary;
    if (!audit) {
      return this.emptyCard('Audit Summary', 'No audit data available.');
    }

    return `
      <div class="section-card">
        <div class="card-header insurer">Audit Summary — Hash Chain Integrity</div>
        <div class="card-body">
          <div class="insurer-metric-row">
            ${this.metricBox('Enrollments', audit.enrollmentCount)}
            ${this.metricBox('Prescriptions', audit.prescriptionCount)}
            ${this.metricBox('Fulfillments', audit.fulfillmentCount)}
            ${this.metricBox('Patient \u03A3', formatCents(audit.totalPatientPayCents))}
            ${this.metricBox('Plan \u03A3', formatCents(audit.totalPlanPayCents))}
          </div>
          ${audit.reversalCount > 0 ? `
          <div class="insurer-metric-row" style="margin-top: 12px;">
            ${this.metricBox('Reversals', audit.reversalCount)}
            ${this.metricBox('Patient Refunded', formatCents(audit.totalReversedPatientCents || 0))}
            ${this.metricBox('Plan Refunded', formatCents(audit.totalReversedPlanCents || 0))}
          </div>
          ` : ''}
          ${audit.terminationCount > 0 ? `
          <div class="insurer-metric-row" style="margin-top: 12px;">
            ${this.metricBox('Terminations', audit.terminationCount)}
          </div>
          ` : ''}
          <div style="margin-top: 12px; font-size: 12px; color: var(--text-secondary);">
            Every state transition produces a Poseidon hash chain event. The audit trail is tamper-evident —
            any modification to historical events would break the chain hash integrity.
          </div>
        </div>
      </div>
    `;
  }

  // ─── Prior Authorization Management ────────────────────

  renderPriorAuthManagement(state) {
    const pas = state.priorAuths || [];
    if (pas.length === 0) {
      return this.emptyCard(
        'Prior Authorization Queue',
        'No PA requests. Prescribers can request PA for Tier 3/4 medications that require it.'
      );
    }

    const pending = pas.filter(pa => pa.status === 'PENDING');
    const resolved = pas.filter(pa => pa.status !== 'PENDING');

    let pendingRows = '';
    if (pending.length > 0) {
      pendingRows = pending.map(pa => `
        <tr>
          <td class="mono" style="font-size: 11px;">${pa.id}</td>
          <td class="mono" style="font-size: 11px;">${truncHash(pa.memberWalletId)}</td>
          <td><span class="tier-badge tier-${pa.medicationTier}">Tier ${pa.medicationTier}</span> ${pa.medicationName}</td>
          <td>${pa.prescriberName}</td>
          <td><span class="pa-badge pa-pending">PENDING</span></td>
          <td>
            <button class="btn-pa-approve" data-pa-id="${pa.id}" style="font-size: 11px; padding: 3px 10px; background: var(--accent-green); color: #0d1117; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; margin-right: 4px;">
              Approve
            </button>
            <button class="btn-pa-deny" data-pa-id="${pa.id}" style="font-size: 11px; padding: 3px 10px; background: var(--accent-red); color: #0d1117; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">
              Deny
            </button>
          </td>
        </tr>
      `).join('');
    }

    let resolvedRows = '';
    if (resolved.length > 0) {
      resolvedRows = resolved.map(pa => {
        const statusBadge = pa.status === 'APPROVED'
          ? '<span class="pa-badge pa-approved">APPROVED</span>'
          : '<span class="pa-badge pa-denied">DENIED</span>';
        return `
          <tr style="opacity: 0.7;">
            <td class="mono" style="font-size: 11px;">${pa.id}</td>
            <td class="mono" style="font-size: 11px;">${truncHash(pa.memberWalletId)}</td>
            <td><span class="tier-badge tier-${pa.medicationTier}">Tier ${pa.medicationTier}</span> ${pa.medicationName}</td>
            <td>${pa.prescriberName}</td>
            <td>${statusBadge}</td>
            <td style="font-size: 11px; color: var(--text-muted);">${pa.resolvedAt ? new Date(pa.resolvedAt).toLocaleTimeString() : ''}</td>
          </tr>
        `;
      }).join('');
    }

    return `
      <div class="section-card" style="border-color: ${pending.length > 0 ? 'rgba(255, 183, 77, 0.4)' : 'rgba(171, 71, 188, 0.2)'};">
        <div class="card-header insurer">
          Prior Authorization Queue
          ${pending.length > 0 ? `<span class="pa-badge pa-pending" style="margin-left: 8px; font-size: 11px;">${pending.length} pending</span>` : ''}
        </div>
        <div class="card-body">
          ${pending.length > 0 ? `
            <div style="margin-bottom: 16px;">
              <div style="font-size: 12px; font-weight: 600; color: var(--accent-yellow); margin-bottom: 8px;">PENDING REQUESTS</div>
              <table class="insurer-table">
                <thead>
                  <tr>
                    <th>PA ID</th>
                    <th>Member Wallet</th>
                    <th>Medication</th>
                    <th>Prescriber</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>${pendingRows}</tbody>
              </table>
              <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
                Approving generates a real AccessControl.provePriorAuth ZK proof and inserts the PA into the member's forest.
              </div>
            </div>
          ` : ''}
          ${resolved.length > 0 ? `
            <div>
              <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">RESOLVED</div>
              <table class="insurer-table">
                <thead>
                  <tr>
                    <th>PA ID</th>
                    <th>Member Wallet</th>
                    <th>Medication</th>
                    <th>Prescriber</th>
                    <th>Status</th>
                    <th>Resolved At</th>
                  </tr>
                </thead>
                <tbody>${resolvedRows}</tbody>
              </table>
            </div>
          ` : ''}
          <div id="pa-action-result" class="hidden" style="margin-top: 12px;"></div>
        </div>
      </div>
    `;
  }

  bindPaActions() {
    // Approve buttons
    this.container.querySelectorAll('.btn-pa-approve').forEach(btn => {
      btn.addEventListener('click', () => this.doApprovePa(btn.dataset.paId, btn));
    });
    // Deny buttons
    this.container.querySelectorAll('.btn-pa-deny').forEach(btn => {
      btn.addEventListener('click', () => this.doDenyPa(btn.dataset.paId, btn));
    });
  }

  bindTerminateActions() {
    this.container.querySelectorAll('.btn-terminate-member').forEach(btn => {
      btn.addEventListener('click', () => this.doTerminateMember(btn.dataset.walletId, btn));
    });
    this.container.querySelectorAll('.btn-terminate-group').forEach(btn => {
      btn.addEventListener('click', () => this.doTerminateGroup(btn.dataset.groupId, btn));
    });
  }

  async doTerminateMember(walletId, btn) {
    btn.disabled = true;
    btn.textContent = 'Terminating...';
    this.app.setStatus('working', 'Terminating member...');

    const resultDiv = document.getElementById('termination-result');
    try {
      const res = await fetch(`${API_BASE}/interactive/terminate-member`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberWalletId: walletId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Termination failed');
      }

      const result = await res.json();

      if (result.chainState) {
        updateChainState(result.chainState);
      }

      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        const cancelledRxs = result.cancelledPrescriptions || [];
        resultDiv.innerHTML = `
          <div style="padding: 12px; background: rgba(239, 83, 80, 0.08); border: 1px solid rgba(239, 83, 80, 0.25); border-radius: 6px;">
            <div style="font-weight: 600; color: var(--accent-red); margin-bottom: 6px;">Member Terminated</div>
            <div style="font-size: 12px; color: var(--text-secondary);">
              Wallet ${truncHash(walletId)} \u2192 REVOKED. Credential revoked, lifecycle updated.
              ${cancelledRxs.length > 0
                ? `<br>${cancelledRxs.length} active prescription${cancelledRxs.length > 1 ? 's' : ''} auto-cancelled: ${cancelledRxs.join(', ')}`
                : ''}
            </div>
          </div>
        `;
      }

      this.app.setStatus('ready', 'Ready');
      const fresh = await loadInteractiveState(API_BASE);
      if (fresh) {
        this.render(fresh);
      }

    } catch (err) {
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      }
      btn.disabled = false;
      btn.textContent = 'Terminate';
      this.app.setStatus('ready', 'Error');
    }
  }

  async doTerminateGroup(groupId, btn) {
    btn.disabled = true;
    btn.textContent = 'Terminating...';
    this.app.setStatus('working', `Terminating group ${groupId}...`);

    const resultDiv = document.getElementById('termination-result');
    try {
      const res = await fetch(`${API_BASE}/interactive/terminate-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Group termination failed');
      }

      const result = await res.json();

      if (result.chainState) {
        updateChainState(result.chainState);
      }

      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        const members = result.members || [];
        resultDiv.innerHTML = `
          <div style="padding: 12px; background: rgba(239, 83, 80, 0.08); border: 1px solid rgba(239, 83, 80, 0.25); border-radius: 6px;">
            <div style="font-weight: 600; color: var(--accent-red); margin-bottom: 6px;">Group ${groupId} Terminated</div>
            <div style="font-size: 12px; color: var(--text-secondary);">
              ${members.length} member${members.length !== 1 ? 's' : ''} terminated.
              All credentials revoked, lifecycles set to REVOKED.
            </div>
          </div>
        `;
      }

      this.app.setStatus('ready', 'Ready');
      const fresh = await loadInteractiveState(API_BASE);
      if (fresh) {
        this.render(fresh);
      }

    } catch (err) {
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      }
      btn.disabled = false;
      btn.textContent = `Terminate Group: ${groupId}`;
      this.app.setStatus('ready', 'Error');
    }
  }

  async doApprovePa(paId, btn) {
    btn.disabled = true;
    btn.textContent = 'Approving...';
    this.app.setStatus('working', 'Generating PA proof...');

    const resultDiv = document.getElementById('pa-action-result');
    try {
      const res = await fetch(`${API_BASE}/interactive/approve-prior-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priorAuthId: paId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Approval failed');
      }

      const result = await res.json();

      // Update chain state
      if (result.chainState) {
        updateChainState(result.chainState);
      }

      // Show success and re-render
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
          <div style="padding: 12px; background: rgba(129, 199, 132, 0.1); border: 1px solid rgba(129, 199, 132, 0.3); border-radius: 6px;">
            <div style="font-weight: 600; color: var(--accent-green); margin-bottom: 4px;">${paId} Approved</div>
            <div style="font-size: 12px; color: var(--text-secondary);">
              ${result.medication?.brandName} authorized for wallet ${result.member?.walletId}.
              provePriorAuth proof generated in ${(result.proofTimeMs / 1000).toFixed(2)}s.
              Forest root updated: ${result.forestRoot}
            </div>
          </div>
          ${result.l2Receipt ? `
            <div class="l2-receipt-card" style="margin-top:12px;">
              <div class="receipt-title">L2 Receipt</div>
              <div class="receipt-grid">
                <div class="rl">Receipt ID</div><div class="rv">${result.l2Receipt.receiptId}</div>
                <div class="rl">Sequence #</div><div class="rv">${result.l2Receipt.sequenceNumber}</div>
                <div class="rl">Status</div><div class="rv"><span class="l2-status-badge pending">pending</span></div>
              </div>
            </div>
          ` : ''}
        `;
      }

      // Refresh state and re-render
      this.app.setStatus('ready', 'Ready');
      const fresh = await loadInteractiveState(API_BASE);
      if (fresh) {
        this.render(fresh);
      }

    } catch (err) {
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      }
      btn.disabled = false;
      btn.textContent = 'Approve';
      this.app.setStatus('ready', 'Error');
    }
  }

  async doDenyPa(paId, btn) {
    btn.disabled = true;
    btn.textContent = 'Denying...';

    const resultDiv = document.getElementById('pa-action-result');
    try {
      const res = await fetch(`${API_BASE}/interactive/deny-prior-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priorAuthId: paId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Denial failed');
      }

      // Refresh state and re-render
      const fresh = await loadInteractiveState(API_BASE);
      if (fresh) {
        this.render(fresh);
      }

    } catch (err) {
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px;">Error: ${err.message}</div>`;
      }
      btn.disabled = false;
      btn.textContent = 'Deny';
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  emptyCard(title, message) {
    return `
      <div class="section-card">
        <div class="card-header insurer">${title}</div>
        <div class="card-body">
          <div style="color: var(--text-muted); font-size: 13px; padding: 8px 0;">${message}</div>
        </div>
      </div>
    `;
  }

  metricBox(label, value) {
    return `
      <div class="insurer-metric-box">
        <div class="insurer-metric-value">${value}</div>
        <div class="insurer-metric-label">${label}</div>
      </div>
    `;
  }
  // ─── Formulary Management Actions ──────────────────────

  bindFormularyActions() {
    // Edit buttons
    this.container.querySelectorAll('.btn-formulary-modify').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showFormularyEditForm(parseInt(btn.dataset.medIndex, 10));
      });
    });

    // Remove buttons
    this.container.querySelectorAll('.btn-formulary-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.doFormularyAction(parseInt(btn.dataset.medIndex, 10), 'REMOVE');
      });
    });

    // Re-add buttons
    this.container.querySelectorAll('.btn-formulary-add').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.doFormularyAction(parseInt(btn.dataset.medIndex, 10), 'ADD');
      });
    });

    // Cancel edit
    const cancelBtn = document.getElementById('btn-formulary-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        document.getElementById('formulary-edit-form').classList.add('hidden');
        this.editingMedIndex = null;
      });
    }

    // Save edit
    const saveBtn = document.getElementById('btn-formulary-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.doFormularyModify());
    }

    // Plan year rollover
    const rolloverBtn = document.getElementById('btn-plan-rollover');
    if (rolloverBtn) {
      rolloverBtn.addEventListener('click', () => this.doPlanYearRollover());
    }
  }

  showFormularyEditForm(medIndex) {
    this.editingMedIndex = medIndex;
    const med = this.currentState.demoData.medications[medIndex];

    document.getElementById('formulary-edit-form').classList.remove('hidden');
    document.getElementById('formulary-edit-drug-name').textContent = `${med.brandName} (${med.genericName})`;
    document.getElementById('formulary-edit-tier').value = (med.currentTierLevel || med.tier).toString();
    document.getElementById('formulary-edit-copay').value = ((med.currentCopayAmountCents ?? med.copayAmountCents) / 100).toString();
    document.getElementById('formulary-edit-pa').checked = med.currentRequiresPriorAuth ?? med.requiresPriorAuth;
    document.getElementById('formulary-edit-step').checked = med.currentStepTherapyRequired ?? med.stepTherapyRequired;
  }

  async doFormularyAction(medIndex, action) {
    const verb = action === 'REMOVE' ? 'Removing' : 'Re-adding';
    this.app.setStatus('working', `${verb} medication...`);
    const resultDiv = document.getElementById('formulary-action-result');

    try {
      const res = await fetch(`${API_BASE}/interactive/update-formulary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ medicationIndex: medIndex, action }),
      });

      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      const result = await res.json();

      if (result.chainState) updateChainState(result.chainState);

      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div style="padding: 8px 12px; background: rgba(129, 199, 132, 0.1); border: 1px solid rgba(129, 199, 132, 0.3); border-radius: 6px; font-size: 12px;">
          <strong>${action === 'REMOVE' ? 'Removed' : 'Re-added'}</strong> ${result.medicationName}.
          ${result.affectedMemberCount} member credential(s) updated. Notifications sent.
          New formulary root: ${truncHash(result.newFormularyRoot)}
        </div>
      `;

      this.app.setStatus('ready', 'Formulary updated');

      setTimeout(async () => {
        await this.app.fetchState();
        this.render(this.app.state);
      }, 1000);

    } catch (err) {
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px; font-size: 12px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    }
  }

  async doFormularyModify() {
    if (this.editingMedIndex === null && this.editingMedIndex !== 0) return;

    const tier = parseInt(document.getElementById('formulary-edit-tier').value, 10);
    const copayDollars = parseFloat(document.getElementById('formulary-edit-copay').value);
    const pa = document.getElementById('formulary-edit-pa').checked;
    const step = document.getElementById('formulary-edit-step').checked;

    const btn = document.getElementById('btn-formulary-save');
    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Applying formulary change + cascading to members...');

    const resultDiv = document.getElementById('formulary-action-result');

    try {
      const res = await fetch(`${API_BASE}/interactive/update-formulary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          medicationIndex: this.editingMedIndex,
          action: 'MODIFY',
          newTierLevel: tier,
          newCopayAmountCents: Math.round(copayDollars * 100),
          newRequiresPriorAuth: pa,
          newStepTherapyRequired: step,
        }),
      });

      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      const result = await res.json();

      if (result.chainState) updateChainState(result.chainState);

      document.getElementById('formulary-edit-form').classList.add('hidden');
      this.editingMedIndex = null;

      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div style="padding: 8px 12px; background: rgba(129, 199, 132, 0.1); border: 1px solid rgba(129, 199, 132, 0.3); border-radius: 6px; font-size: 12px;">
          <strong>Modified</strong> ${result.medicationName}: ${result.details}.
          ${result.affectedMemberCount} member credential(s) cascaded. Notifications sent.
        </div>
      `;

      this.app.setStatus('ready', 'Formulary updated');
      setTimeout(async () => {
        await this.app.fetchState();
        this.render(this.app.state);
      }, 1000);

    } catch (err) {
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px; font-size: 12px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // ─── Network Actions ──────────────────────────────────

  bindNetworkActions() {
    // Remove buttons
    this.container.querySelectorAll('.btn-network-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.doNetworkAction(btn.dataset.prescriberWallet, 'REMOVE', btn.dataset.prescriberName);
      });
    });

    // Add buttons
    this.container.querySelectorAll('.btn-network-add').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.doNetworkAction(btn.dataset.prescriberWallet, 'ADD', btn.dataset.prescriberName);
      });
    });
  }

  async doNetworkAction(prescriberWalletId, action, prescriberName) {
    const verb = action === 'REMOVE' ? 'Removing' : 'Adding';
    this.app.setStatus('working', `${verb} ${prescriberName} ${action === 'REMOVE' ? 'from' : 'to'} network...`);
    const resultDiv = document.getElementById('network-action-result');

    try {
      const res = await fetch(`${API_BASE}/interactive/update-provider-network`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescriberWalletId, action }),
      });

      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      const result = await res.json();

      if (result.chainState) updateChainState(result.chainState);

      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div style="padding: 8px 12px; background: rgba(129, 199, 132, 0.1); border: 1px solid rgba(129, 199, 132, 0.3); border-radius: 6px; font-size: 12px;">
          <strong>${action === 'REMOVE' ? 'Removed' : 'Added'}</strong> ${result.prescriberName} ${action === 'REMOVE' ? 'from' : 'to'} network.
          ${result.affectedMemberCount} member credential(s) updated. Notifications sent.
          ${result.inNetworkCount} prescriber(s) now in-network.
          New network root: ${truncHash(result.newNetworkRoot)}
        </div>
      `;

      this.app.setStatus('ready', 'Network updated');

      setTimeout(async () => {
        await this.app.fetchState();
        this.render(this.app.state);
      }, 1000);

    } catch (err) {
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); padding: 8px; font-size: 12px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    }
  }

  async doPlanYearRollover() {
    const btn = document.getElementById('btn-plan-rollover');
    btn.classList.add('loading');
    btn.disabled = true;
    this.app.setStatus('working', 'Rolling over plan year...');

    const resultDiv = document.getElementById('rollover-result');
    try {
      const res = await fetch(`${API_BASE}/interactive/plan-year-rollover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPlanYear: '20270101' }),
      });

      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      const result = await res.json();

      if (result.chainState) updateChainState(result.chainState);

      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div style="color: var(--accent-green); font-size: 12px;">
          Plan year rolled over to 2027. ${result.affectedMemberCount} member accumulator(s) reset to $0. Notifications sent.
        </div>
      `;

      this.app.setStatus('ready', 'Rollover complete');
      setTimeout(async () => {
        await this.app.fetchState();
        this.render(this.app.state);
      }, 1500);

    } catch (err) {
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `<div style="color: var(--accent-red); font-size: 12px;">Error: ${err.message}</div>`;
      this.app.setStatus('ready', 'Error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }
}

function truncHash(s) {
  if (!s) return '\u2014';
  if (s.length <= 20) return s;
  return s.slice(0, 8) + '\u2026' + s.slice(-8);
}
