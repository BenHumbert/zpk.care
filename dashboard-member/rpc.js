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
 * Adjuda-GATOR Member Portal — JSON-RPC 2.0 + REST Client
 * Talks to the Leviathan / Nautilus sequencer node.
 */
const RPC = (() => {
  let baseUrl = location.origin;
  let insurerUrl = '';
  let proverUrl = '';
  let sseConn = null;
  let sseListeners = [];
  let sseReconnectDelay = 1000;
  let sseReconnectTimer = null;
  let lastOnEvent = null;
  let rpcId = 0;

  function setBaseUrl(url) { baseUrl = url.replace(/\/+$/, ''); }
  function setInsurerUrl(url) { insurerUrl = url.replace(/\/+$/, ''); }
  function setProverUrl(url) { proverUrl = url.replace(/\/+$/, ''); }

  /*
   * A5: the device session, issued by /onboarding/unlock once it has verified the PIN.
   *
   * Held in memory only. sessionStorage would survive a tab reload, but it would also mean a
   * token sitting in browser storage for an hour, and re-entering the PIN after a reload is the
   * behaviour a locked device should have anyway.
   *
   * Sent to THIS origin only. deviceHeaders() is for the member node; anything addressed to the
   * sequencer, the insurer or the prover uses plain headers, because handing this node's session
   * to another party would be exactly the credential leak the item exists to stop.
   */
  let deviceSession = '';
  function setDeviceSession(token) { deviceSession = token || ''; }
  function hasDeviceSession() { return Boolean(deviceSession); }

  /*
   * A session lasts an hour. When one expires mid-use the node answers 401, and without this the
   * app would show an unexplained failure and keep showing it. The app registers a handler that
   * asks for the PIN again.
   */
  let onDeviceLocked = null;
  function setDeviceLockedHandler(fn) { onDeviceLocked = fn; }
  function noteDeviceLocked() {
    deviceSession = '';
    if (typeof onDeviceLocked === 'function') onDeviceLocked();
  }

  /** Headers for a request to the member node itself. */
  function deviceHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (deviceSession) h['X-Device-Session'] = deviceSession;
    return h;
  }

  /** Headers for a request to anyone else. Never carries the session. */
  function headers() { return { 'Content-Type': 'application/json' }; }

  // Normalize a value into a safe error message string (avoids "[object Object]")
  function errMsg(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.error === 'string') return e.error;
    if (e.error && typeof e.error.message === 'string') return e.error.message;
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

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

  // ── JSON-RPC 2.0 ────────────────────────────────────
  async function call(method, params) {
    rpcId++;
    const res = await fetch(baseUrl + '/rpc', {
      method: 'POST', headers: deviceHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params: params || {} }),
    });
    if (res.status === 401) {
      noteDeviceLocked();
      throw new Error('This device is locked. Enter your PIN to continue.');
    }
    if (!res.ok) {
      throw new Error('RPC request failed: HTTP ' + res.status);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON response from sequencer'); }
    if (data && data.error) {
      const err = new Error(data.error.message || JSON.stringify(data.error));
      err.code = data.error.code;
      throw err;
    }
    return stripBigints(data.result !== undefined ? data.result : data);
  }

  // ── REST (health / insurer / prover) ────────────────
  async function getHealth() {
    // baseUrl is this origin unless a sequencer URL was configured; the session is only
    // meaningful to this node and is ignored elsewhere.
    const res = await fetch(baseUrl + '/health', { headers: deviceHeaders() });
    return res.json();
  }

  // ── Chain ────────────────────────────────────────────
  function getStatus() { return call('l2_getStatus'); }
  function getChainState() { return call('l2_getChainState'); }

  // ── Receipts ─────────────────────────────────────────
  function getReceiptsByWallet(w) { return call('l2_getReceiptsByWallet', { walletId: w }); }
  function getReceipt(id) { return call('l2_getReceipt', { receiptId: id }); }

  // ── Claims ───────────────────────────────────────────
  function getClaimsByMember(w) { return call('l2_getClaimsByMember', { walletId: w }); }
  function getClaimsByPharmacy(w) { return call('l2_getClaimsByPharmacy', { walletId: w }); }
  function getClaimsByPrescriber(w) { return call('l2_getClaimsByPrescriber', { walletId: w }); }
  function getClaimsByNdc(n) { return call('l2_getClaimsByNdc', { ndcHash: n }); }
  function getClaimAccumulatorRoot() { return call('l2_getClaimAccumulatorRoot'); }

  // ── Accumulator ──────────────────────────────────────
  function reconstructAccumulator(w, planIdHash) {
    var p = { walletId: w };
    if (planIdHash) p.planIdHash = planIdHash;
    return call('l2_reconstructAccumulator', p);
  }

  // ── Plan Limits ─────────────────────────────────────
  function getPlanLimits(planId) { return call('l2_getPlanLimits', { planId: planId }); }

  // ── Cost Estimation ────────────────────────────────
  function estimateCost(params) { return call('l2_estimateCost', params); }

  // ── Formulary (legacy) ────────────────────────────────
  function getFormulary(planIdHash) { return call('l2_getFormulary', { planIdHash }); }

  // ── Formulary (Option C — paginated) ─────────────────
  function getFormularyPage(filter, offset, limit) {
    return call('l2_getFormularyPage', { filter: filter || {}, offset: offset || 0, limit: limit || 100 });
  }
  function getFormularyDrugCount() { return call('l2_getFormularyDrugCount', {}); }
  function getFormularyRoutes() { return call('l2_getFormularyRoutes', {}); }
  function getFormularyRoot() { return call('l2_getFormularyRoot', {}); }

  // ── Providers ────────────────────────────────────────
  function getNetworkProviders(role) {
    var params = {};
    if (role) params.role = role;
    return call('l2_getNetworkProviders', params);
  }

  // ── Messages ─────────────────────────────────────────
  function getMessagesByWallet(w) { return call('l2_getMessagesByWallet', { walletId: w }); }
  function getMessagesByThread(h) { return call('l2_getMessagesByThread', { threadIdHash: h }); }
  function getMessagesBySender(w) { return call('l2_getMessagesBySender', { walletId: w }); }
  function getMessagesByRecipient(w) { return call('l2_getMessagesByRecipient', { walletId: w }); }
  /** Send a message via the member node's server-side encryption (E2E) */
  async function sendEncryptedMessage(recipientWalletId, body) {
    var res = await fetch(baseUrl + '/messaging/send', {
      method: 'POST', headers: deviceHeaders(),
      body: JSON.stringify({ recipientWalletId: recipientWalletId, body: body }),
    });
    var data = await res.json();
    if (data.error) throw new Error(errMsg(data.error) || 'Unknown error');
    return stripBigints(data.data || data);
  }
  function getMessageStoreRoot() { return call('l2_getMessageStoreRoot'); }

  // ── NFC Attestation ──────────────────────────────────
  /** Ask the member node for the NFC attestation; the node signs the request as the wallet (A10b). */
  async function requestAttestation(_w, expiry) {
    var res = await fetch(baseUrl + '/attestation/request', {
      method: 'POST', headers: deviceHeaders(),
      body: JSON.stringify(expiry ? { expirySeconds: expiry } : {}),
    });
    var data = await res.json();
    if (data.error) throw new Error(errMsg(data.error) || 'Attestation request failed');
    return stripBigints(data.data || data);
  }
  function getAttestation(w) { return call('l2_getAttestation', { walletId: w }); }
  function getAttestationPublicKey() { return call('l2_getAttestationPublicKey'); }

  // ── Enrollment (via local Nautilus node) ─────────────
  async function enrollWithInsurer(walletId, tokenId) {
    // Route through local Nautilus node instead of directly to insurer
    const res = await fetch(location.origin + '/onboarding/enroll', {
      method: 'POST', headers: deviceHeaders(),
      body: JSON.stringify({ walletId, tokenId }),
    });
    const json = await res.json();
    if (json && !json.ok && json.error) throw new Error(errMsg(json.error) || 'Unknown error');
    return json.data || json;
  }

  // ── Proof Delegation (prover REST) ───────────────────
  async function getProverStatus() {
    if (!proverUrl) throw new Error('Prover URL not configured');
    const res = await fetch(proverUrl + '/status', { headers: headers() });
    return res.json();
  }

  async function delegateProof(method, params) {
    if (!proverUrl) throw new Error('Prover URL not configured');
    const res = await fetch(proverUrl + '/prove', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ method, params }),
    });
    return res.json();
  }

  // ── PCP (via local Nautilus node) ────────────────────
  function assignPcp(prescriberWalletId) {
    var today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return fetch(location.origin + '/pcp/assign', {
      method: 'POST', headers: deviceHeaders(),
      body: JSON.stringify({ pcpWalletId: prescriberWalletId, effectiveDate: today }),
    }).then(function(r) { return r.json(); }).then(function(j) { return j.data || j; });
  }

  function getCurrentPcp() {
    return fetch(location.origin + '/pcp/current', { headers: deviceHeaders() })
      .then(function(r) { return r.json(); }).then(function(j) { return j.data != null ? j.data : null; });
  }

  // ── Proof Submission ─────────────────────────────────
  function submitProof(proofJson, metadata) {
    var p = { proofJson };
    if (metadata) p.entityMetadata = metadata;
    return call('l2_submitProof', p);
  }

  function getRegistrationWitnesses() { return call('l2_getRegistrationWitnesses'); }

  // ── SSE ──────────────────────────────────────────────
  function connectSSE(onEvent) {
    disconnectSSE();
    lastOnEvent = onEvent;
    try {
      sseConn = new EventSource(baseUrl + '/events');
      sseConn.onopen = function () {
        sseReconnectDelay = 1000;
        sseListeners.forEach(function (fn) { fn('connected'); });
      };
      sseConn.onmessage = function (ev) {
        try { if (onEvent) onEvent(JSON.parse(ev.data)); }
        catch { if (onEvent) onEvent({ raw: ev.data }); }
      };
      sseConn.onerror = function () {
        sseListeners.forEach(function (fn) { fn('disconnected'); });
        sseConn.close();
        sseConn = null;
        sseReconnectTimer = setTimeout(function () { connectSSE(lastOnEvent); }, sseReconnectDelay);
        sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
      };
    } catch {
      sseReconnectTimer = setTimeout(function () { connectSSE(lastOnEvent); }, sseReconnectDelay);
      sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
    }
  }
  function disconnectSSE() {
    if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
    if (sseConn) { sseConn.close(); sseConn = null; }
  }
  function onConnectionChange(fn) { sseListeners.push(fn); }
  async function checkConnection() { try { await getHealth(); return true; } catch { return false; } }

  return {
    setDeviceSession, hasDeviceSession, deviceHeaders, setDeviceLockedHandler,
    setBaseUrl, setInsurerUrl, setProverUrl,
    call, getHealth, getStatus, getChainState,
    getReceiptsByWallet, getReceipt,
    getClaimsByMember, getClaimsByPharmacy, getClaimsByPrescriber, getClaimsByNdc, getClaimAccumulatorRoot,
    reconstructAccumulator, getPlanLimits, estimateCost, getFormulary, getFormularyPage, getFormularyDrugCount, getFormularyRoutes, getFormularyRoot,
    getNetworkProviders,
    getMessagesByWallet, getMessagesByThread, getMessagesBySender, getMessagesByRecipient,
    sendEncryptedMessage, getMessageStoreRoot,
    requestAttestation, getAttestation, getAttestationPublicKey,
    enrollWithInsurer, assignPcp, getCurrentPcp,
    getProverStatus, delegateProof, submitProof, getRegistrationWitnesses,
    connectSSE, disconnectSSE, onConnectionChange, checkConnection,
  };
})();
