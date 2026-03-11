/**
 * zkTrident Insurer Nautilus — REST API Client
 * Talks to the local Nautilus server at the same origin.
 */
const API = (() => {
  let baseUrl = location.origin;
  let adminToken = '';
  let sseConnection = null;
  let sseListeners = [];

  function setBaseUrl(url) { baseUrl = url.replace(/\/+$/, ''); }
  function setAdminToken(token) { adminToken = token || ''; }
  function getAdminToken() { return adminToken; }

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
    return data;
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

  // ---- Messaging ----
  function getMessagesByWallet(walletId) { return request('GET', '/messaging/wallet/' + encodeURIComponent(walletId)); }
  function getMessagesByThread(threadIdHash) { return request('GET', '/messaging/thread/' + encodeURIComponent(threadIdHash)); }
  function getMessageStoreStatus() { return request('GET', '/messaging/status'); }

  // ---- SSE ----
  function connectSSE(onEvent) {
    disconnectSSE();
    try {
      sseConnection = new EventSource(baseUrl + '/events');
      sseConnection.onopen = () => sseListeners.forEach(fn => fn('connected'));
      sseConnection.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (onEvent) onEvent(data);
        } catch {
          if (onEvent) onEvent({ raw: ev.data });
        }
      };
      sseConnection.onerror = () => sseListeners.forEach(fn => fn('disconnected'));
    } catch {}
  }
  function disconnectSSE() { if (sseConnection) { sseConnection.close(); sseConnection = null; } }
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
    getMessagesByWallet, getMessagesByThread, getMessageStoreStatus,
    connectSSE, disconnectSSE, onConnectionChange, checkConnection,
  };
})();
