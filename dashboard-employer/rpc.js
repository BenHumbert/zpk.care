/**
 * zkTrident Employer Nautilus — REST API Client
 * Talks to the local Nautilus server at the same origin.
 */
const API = (() => {
  let baseUrl = location.origin;
  let adminToken = '';
  let sseConnection = null;
  let sseListeners = [];

  function setBaseUrl(url) {
    baseUrl = url.replace(/\/+$/, '');
  }

  function setAdminToken(token) {
    adminToken = token || '';
  }

  function getAdminToken() {
    return adminToken;
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
      const msg = (data && data.error) || (data && data.message) || text || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
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
    return request('GET', '/groups');
  }

  function getGroup(groupId) {
    return request('GET', '/groups/' + encodeURIComponent(groupId));
  }

  function deleteGroup(groupId, terminationDate) {
    return request('DELETE', '/groups/' + encodeURIComponent(groupId), { terminationDate }, true);
  }

  // ---- Tokens ----
  function generateToken(params) {
    return request('POST', '/tokens/generate', params, true);
  }

  function getToken(tokenId) {
    return request('GET', '/tokens/' + encodeURIComponent(tokenId), undefined, true);
  }

  function revokeToken(tokenId) {
    return request('POST', '/tokens/' + encodeURIComponent(tokenId) + '/revoke', {}, true);
  }

  function validateToken(tokenId, currentDate) {
    const body = currentDate ? { currentDate } : {};
    return request('POST', '/tokens/' + encodeURIComponent(tokenId) + '/validate', body);
  }

  function submitToken(tokenId, walletId) {
    return request('POST', '/tokens/' + encodeURIComponent(tokenId) + '/submit', { walletId }, true);
  }

  // ---- Roster ----
  function listRoster(status) {
    const q = status ? '?status=' + encodeURIComponent(status) : '';
    return request('GET', '/roster' + q);
  }

  function getRosterEntry(employeeIdHash) {
    return request('GET', '/roster/' + encodeURIComponent(employeeIdHash));
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
    try {
      sseConnection = new EventSource(baseUrl + '/events');
      sseConnection.onopen = () => {
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
      };
    } catch {
      // SSE not available
    }
  }

  function disconnectSSE() {
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
    generateToken,
    getToken,
    revokeToken,
    validateToken,
    submitToken,
    listRoster,
    getRosterEntry,
    terminateRosterEntry,
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
