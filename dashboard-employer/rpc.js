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
 * Adjuda-GATOR Employer Nautilus — REST API Client
 * Talks to the local Nautilus server at the same origin.
 */
const API = (() => {
  let baseUrl = location.origin;
  let adminToken = '';
  let sseConnection = null;
  let sseListeners = [];
  let sseReconnectDelay = 1000;
  let sseReconnectTimer = null;
  let lastOnEvent = null;

  function setBaseUrl(url) {
    baseUrl = url.replace(/\/+$/, '');
  }

  function setAdminToken(token) {
    adminToken = token || '';
    try { localStorage.setItem('zkt_employer_admin_token', adminToken); } catch {}
  }

  function getAdminToken() {
    return adminToken;
  }
  // Restore admin token from localStorage, fall back to bootstrap default
  try { adminToken = localStorage.getItem('zkt_employer_admin_token') || ''; } catch { adminToken = ''; }

  // Strip __bigint__:NNN prefixes from serialized BigInt values
  function stripBigints(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') {
      if (obj.startsWith('__bigint__:')) return obj.slice(11);
      return obj;
    }
    if (Array.isArray(obj)) return obj.map(stripBigints);
    if (typeof obj === 'object') {
      var out = {};
      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = stripBigints(obj[k]);
      }
      return out;
    }
    return obj;
  }

  // Normalize a value into a safe error message string (avoids "[object Object]")
  function errMsg(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.error === 'string') return e.error;
    if (e.error && typeof e.error.message === 'string') return e.error.message;
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

  function headers(admin = false) {
    const h = { 'Content-Type': 'application/json' };
    if (admin && adminToken) {
      h['Authorization'] = 'Bearer ' + adminToken;
    }
    return h;
  }

  async function request(method, path, body, admin = false) {
    const url = baseUrl + path;
    const opts = {
      method,
      headers: headers(admin),
    };
    if (body !== undefined && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && data.error != null ? errMsg(data.error) : '') || (data && typeof data.message === 'string' ? data.message : '') || (typeof text === 'string' ? text : '') || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    // Auto-unwrap NautilusAppServer response envelope {ok, timestamp, data}
    if (data && data.ok !== undefined && data.data !== undefined) {
      return stripBigints(data.data);
    }
    return stripBigints(data);
  }

  // ---- Onboarding ----
  function configure(employerId, insurerUrl) {
    return request('POST', '/onboarding/configure', { employerId, insurerUrl });
  }

  function getOnboardingStatus() {
    return request('GET', '/onboarding/status');
  }

  // ---- Health ----
  function getHealth() {
    return request('GET', '/health');
  }

  // ---- Groups ----
  function createGroup(groupId, planId, effectiveDate, enrollmentCap) {
    return request('POST', '/groups', { groupId, planId, effectiveDate, enrollmentCap }, true);
  }

  function listGroups() {
    return request('GET', '/groups', undefined, true);
  }

  function getGroup(groupId) {
    return request('GET', '/groups/' + encodeURIComponent(groupId), undefined, true);
  }

  function deleteGroup(groupId, terminationDate) {
    return request('DELETE', '/groups/' + encodeURIComponent(groupId), { terminationDate }, true);
  }

  // ---- Tokens ---- (Phase F2: removed from the dashboard API.
  // Token generation is exclusive to the HR Tool because it requires the
  // PII-safe hashing workflow. These endpoints still exist on the employer
  // node backend — the HR Tool calls them directly via its proxy.)

  // ---- Roster ----
  function listRoster(status) {
    const q = status ? '?status=' + encodeURIComponent(status) : '';
    return request('GET', '/roster' + q, undefined, true);
  }

  function getRosterEntry(employeeIdHash) {
    return request('GET', '/roster/' + encodeURIComponent(employeeIdHash), undefined, true);
  }

  function terminateRosterEntry(employeeIdHash) {
    return request('DELETE', '/roster/' + encodeURIComponent(employeeIdHash), {}, true);
  }

  // ---- Sequencer ----
  function getChainState() {
    return request('GET', '/sequencer/chain-state');
  }

  function getSequencerStatus() {
    return request('GET', '/sequencer/status');
  }

  // ---- Available Plans (from insurer) ----
  function getAvailablePlans() { return request('GET', '/plans/available'); }

  // ---- Attestation (Phase 3.3) ----
  function getAttestation() { return request('GET', '/attestation'); }
  function refreshAttestation() { return request('POST', '/attestation/refresh', {}, true); }

  // ---- Messaging ----
  function sendMessage(recipientWalletId, subject, body) {
    return request('POST', '/messaging/send', { recipientWalletId, subject, body }, true);
  }

  function getInbox() {
    return request('GET', '/messaging/inbox');
  }

  function getSent() {
    return request('GET', '/messaging/sent');
  }

  function getThread(threadIdHash) {
    return request('GET', '/messaging/thread/' + encodeURIComponent(threadIdHash));
  }

  // ---- SSE Events ----
  function connectSSE(onEvent) {
    disconnectSSE();
    lastOnEvent = onEvent;
    try {
      sseConnection = new EventSource(baseUrl + '/events');
      sseConnection.onopen = () => {
        sseReconnectDelay = 1000;
        sseListeners.forEach(fn => fn('connected'));
      };
      sseConnection.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (onEvent) onEvent(data);
        } catch {
          if (onEvent) onEvent({ raw: ev.data });
        }
      };
      sseConnection.onerror = () => {
        sseListeners.forEach(fn => fn('disconnected'));
        sseConnection.close();
        sseConnection = null;
        sseReconnectTimer = setTimeout(() => connectSSE(lastOnEvent), sseReconnectDelay);
        sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
      };
    } catch {
      sseReconnectTimer = setTimeout(() => connectSSE(lastOnEvent), sseReconnectDelay);
      sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
    }
  }

  function disconnectSSE() {
    if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
    if (sseConnection) {
      sseConnection.close();
      sseConnection = null;
    }
  }

  function onConnectionChange(fn) {
    sseListeners.push(fn);
  }

  // ---- Check connectivity ----
  async function checkConnection() {
    try {
      await getHealth();
      return true;
    } catch {
      return false;
    }
  }

  return {
    setBaseUrl,
    setAdminToken,
    getAdminToken,
    configure,
    getOnboardingStatus,
    getHealth,
    createGroup,
    listGroups,
    getGroup,
    deleteGroup,
    // generateToken/getToken/revokeToken/validateToken/submitToken removed (Phase F2)
    listRoster,
    getRosterEntry,
    terminateRosterEntry,
    getAvailablePlans,
    getAttestation,
    refreshAttestation,
    getChainState,
    getSequencerStatus,
    sendMessage,
    getInbox,
    getSent,
    getThread,
    connectSSE,
    disconnectSSE,
    onConnectionChange,
    checkConnection,
  };
})();
