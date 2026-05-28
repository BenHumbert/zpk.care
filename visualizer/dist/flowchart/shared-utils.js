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
 * shared-utils.js — Utility functions for the dashboard.
 */

/** Truncate a hash/wallet ID for display: first 6 + last 4. */
function truncHash(hash, prefixLen = 6, suffixLen = 4) {
  if (!hash) return '—';
  const s = String(hash);
  if (s.length <= prefixLen + suffixLen + 2) return s;
  return s.slice(0, prefixLen) + '…' + s.slice(-suffixLen);
}

/** Format cents to dollars: 1050 → "$10.50" */
function formatCents(cents) {
  if (cents == null || cents === 0) return '$0.00';
  return '$' + (cents / 100).toFixed(2);
}

/** Format milliseconds to M:SS string. */
function formatTime(ms) {
  if (!ms || ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Format a unix timestamp to HH:MM:SS. */
function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/** Escape HTML entities. */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Create a status badge span. */
function statusBadge(status, text) {
  const cls = {
    running: 'badge-success',
    stopped: 'badge-danger',
    complete: 'badge-success',
    compiling: 'badge-warning',
    pending: 'badge-muted',
    error: 'badge-danger',
    idle: 'badge-muted',
  }[status] || 'badge-muted';
  return `<span class="badge ${cls}">${escapeHtml(text || status)}</span>`;
}

/** Short member name: "Alice J." from "Alice Johnson". */
function shortMember(name) {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1][0] + '.';
}
