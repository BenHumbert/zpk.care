/**
 * zkTrident Insurer Nautilus — REST API Client
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

  function setBaseUrl(url) { baseUrl = url.replace(/\/+$/, ''); }
  function setAdminToken(token) { adminToken = token || ''; }
  function getAdminToken() { return adminToken; }

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

  function headers(admin) {
    const h = { 'Content-Type': 'application/json' };
    if (admin && adminToken) h['Authorization'] = 'Bearer ' + adminToken;
    return h;
  }

  async function request(method, path, body, admin) {
    const url = baseUrl + path;
    const opts = { method, headers: headers(admin) };
    if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.error) || (data && data.message) || text || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    // Unwrap NautilusAppServer { ok, data, timestamp } envelope
    if (data && data.ok !== undefined && data.data !== undefined) return stripBigints(data.data);
    return stripBigints(data);
  }

  // ---- Onboarding ----
  function getOnboardingStatus() { return request('GET', '/onboarding/status'); }

  // ---- Health ----
  function getHealth() { return request('GET', '/health'); }

  // ---- Enrollment ----
  function processEnrollment(walletId, tokenId, role) {
    return request('POST', '/enrollment/process', { walletId, tokenId, role }, true);
  }

  // ---- Receipts ----
  function getReceipts(limit, offset) {
    const q = '?limit=' + (limit || 100) + '&offset=' + (offset || 0);
    return request('GET', '/receipts/all' + q);
  }

  // ---- Batches ----
  function getBatches(limit, offset) {
    const q = '?limit=' + (limit || 100) + '&offset=' + (offset || 0);
    return request('GET', '/batches/all' + q);
  }

  // ---- Audit ----
  function getAuditLog(limit, offset) {
    const q = '?limit=' + (limit || 200) + '&offset=' + (offset || 0);
    return request('GET', '/audit/log' + q);
  }

  function getChainProof() { return request('GET', '/chain-proof'); }

  function verifyChainIntegrity() { return request('GET', '/audit/chain-integrity'); }
  function verifyFinancialBalance() { return request('GET', '/audit/financial-balance'); }
  function detectDuplicateClaims() { return request('GET', '/audit/duplicate-claims'); }

  // ---- Entity-filtered claims ----
  function getMemberClaims(walletId) { return request('GET', '/claims/member/' + encodeURIComponent(walletId)); }
  function getPrescriberClaims(walletId) { return request('GET', '/claims/prescriber/' + encodeURIComponent(walletId)); }
  function getPharmacyClaims(walletId) { return request('GET', '/claims/pharmacy/' + encodeURIComponent(walletId)); }
  function getDrugClaims(ndcHash) { return request('GET', '/claims/drug/' + encodeURIComponent(ndcHash)); }

  // ---- Admin ----
  function forceBatch() { return request('POST', '/admin/batch/force', {}, true); }

  // ---- Roster (live from sequencer) ----
  function getRoster(groupId, role) {
    var q = [];
    if (groupId) q.push('groupId=' + encodeURIComponent(groupId));
    if (role) q.push('role=' + encodeURIComponent(role));
    var qs = q.length ? '?' + q.join('&') : '';
    return request('GET', '/roster' + qs);
  }

  function registerRoster(walletId, role, groupId, employerId) {
    return request('POST', '/roster/register', { walletId, role, groupId, employerId }, true);
  }

  // ---- Credentialing ----
  function getCredentialingApplications(status) {
    var q = status ? '?status=' + encodeURIComponent(status) : '';
    return request('GET', '/credentialing/applications' + q);
  }

  function submitCredentialingApplication(data) {
    return request('POST', '/credentialing/apply', data);
  }

  function verifyApplication(appId) {
    return request('POST', '/credentialing/verify/' + encodeURIComponent(appId), {}, true);
  }

  function approveApplication(appId, walletId) {
    return request('POST', '/credentialing/approve/' + encodeURIComponent(appId), { walletId }, true);
  }

  function denyApplication(appId, reason) {
    return request('POST', '/credentialing/deny/' + encodeURIComponent(appId), { reason }, true);
  }

  function getCredentialingStatus(walletId) {
    return request('GET', '/credentialing/status/' + encodeURIComponent(walletId));
  }

  function suspendProvider(walletId) {
    return request('POST', '/credentialing/suspend/' + encodeURIComponent(walletId), {}, true);
  }

  function terminateProvider(walletId) {
    return request('POST', '/credentialing/terminate/' + encodeURIComponent(walletId), {}, true);
  }

  function getProviderRegistry(role) {
    var q = role ? '?role=' + encodeURIComponent(role) : '';
    return request('GET', '/credentialing/registry' + q);
  }

  // ---- Formulary Publish (to sequencer) ----
  function publishFormulary(planIdHash, formularyRoot, entriesJson) {
    return request('POST', '/admin/formulary/publish', { planIdHash, formularyRoot, entriesJson }, true);
  }

  // ---- Messaging ----
  function getMessagesByWallet(walletId) { return request('GET', '/messaging/wallet/' + encodeURIComponent(walletId)); }
  function getMessagesByThread(threadIdHash) { return request('GET', '/messaging/thread/' + encodeURIComponent(threadIdHash)); }
  function getMessageStoreStatus() { return request('GET', '/messaging/status'); }

  // ---- SSE ----
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
    if (sseConnection) { sseConnection.close(); sseConnection = null; }
  }
  function onConnectionChange(fn) { sseListeners.push(fn); }

  async function checkConnection() {
    try { await getHealth(); return true; } catch { return false; }
  }

  return {
    setBaseUrl, setAdminToken, getAdminToken,
    getOnboardingStatus, getHealth,
    processEnrollment,
    getReceipts, getBatches,
    getAuditLog, getChainProof,
    verifyChainIntegrity, verifyFinancialBalance, detectDuplicateClaims,
    getMemberClaims, getPrescriberClaims, getPharmacyClaims, getDrugClaims,
    forceBatch,
    getRoster, registerRoster,
    getCredentialingApplications, submitCredentialingApplication,
    verifyApplication, approveApplication, denyApplication,
    getCredentialingStatus, suspendProvider, terminateProvider,
    getProviderRegistry,
    publishFormulary,
    getMessagesByWallet, getMessagesByThread, getMessageStoreStatus,
    connectSSE, disconnectSSE, onConnectionChange, checkConnection,
  };
})();
