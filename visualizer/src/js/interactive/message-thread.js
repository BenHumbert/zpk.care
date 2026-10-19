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
 * A decrypted message thread as the console shows it, in the member, prescriber, pharmacy and insurer tabs.
 *
 * Every value in a bubble came over the network. The subject and the body are text whoever sent the message wrote (a
 * prescriber's reason for a prior authorization reaches the insurer in one, an insurer's reason for a denial reaches
 * the prescriber in another), and the sender's name is what its node registered. This page holds the network's
 * operator token, so each value is escaped before it is placed in the page: markup in a message shows as text and never
 * runs.
 */

/** Text made safe to place in HTML, in an element or a quoted attribute: & < > " and ' as entities. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The message types the engine sends, as the console labels them. */
export const MESSAGE_TYPE_LABELS = { 1: 'Rx', 2: 'PA Req', 3: 'PA Resp', 4: 'Notice', 5: 'General', 6: 'Support', 7: 'Summary' };

/**
 * The bubbles of a decrypted thread: `messages` as /interactive/decrypt-thread returns them (empty entries skipped),
 * `selfWalletId` the wallet whose messages show as sent, `directory` the state's wallet directory for names. Every
 * value from a message is escaped.
 */
export function renderMessageBubbles(messages, selfWalletId, directory) {
  const dir = directory || {};
  return (messages || []).filter(Boolean).map((m) => {
    const sender = String(m.senderWalletId ?? '');
    const isSent = sender === selfWalletId;
    const senderName = dir[sender]?.displayName || sender.slice(0, 8) + '\u2026';
    const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
    const type = Number.isInteger(Number(m.messageType)) ? Number(m.messageType) : 0;
    const typeLabel = MESSAGE_TYPE_LABELS[type] || 'Msg';
    return `
          <div class="msg-bubble ${isSent ? 'msg-sent' : 'msg-received'}">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="font-size: 11px; font-weight: 600;">${escapeHtml(senderName)}</span>
              <span style="font-size: 10px; color: var(--text-muted);">${escapeHtml(timeStr)} <span class="msg-type-badge msg-type-${type}" style="font-size: 9px;">${typeLabel}</span></span>
            </div>
            ${m.subject ? `<div style="font-weight: 600; font-size: 12px; margin-bottom: 2px;">${escapeHtml(m.subject)}</div>` : ''}
            <div style="font-size: 12px; white-space: pre-wrap;">${escapeHtml(m.body)}</div>
          </div>`;
  }).join('');
}
