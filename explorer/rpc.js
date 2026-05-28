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
 * Adjuda-GATOR Leviathan Explorer — JSON-RPC 2.0 Client
 * Public read-only interface to any Leviathan / L2 node.
 */
const RPC = (() => {
  let baseUrl = location.origin;
  let adminToken = '';
  let sseConn = null;
  let vizConn = null;
  let sseListeners = [];
  let rpcId = 0;

  function setBaseUrl(url) { baseUrl = url.replace(/\/+$/, ''); }
  function setAdminToken(t) { adminToken = t || ''; }
  function getAdminToken() { return adminToken; }

  function headers(admin) {
    const h = { 'Content-Type': 'application/json' };
    if (admin && adminToken) h['Authorization'] = 'Bearer ' + adminToken;
    return h;
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

  async function call(method, params, admin) {
    rpcId++;
    const res = await fetch(baseUrl + '/rpc', {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params: params || {} }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (data && data.error) {
      const err = new Error(data.error.message || JSON.stringify(data.error));
      err.code = data.error.code;
      throw err;
    }
    return stripBigints(data.result !== undefined ? data.result : data);
  }

  // ── REST ──────────────────────────────────────────
  async function getHealth() {
    const res = await fetch(baseUrl + '/health', { headers: headers() });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  // ── Chain state ───────────────────────────────────
  function getStatus()         { return call('l2_getStatus'); }
  function getChainState()     { return call('l2_getChainState'); }
  function getChainProof()     { return call('l2_getChainProof'); }
  function getStateDigest()    { return call('l2_getStateDigest'); }

  // ── Batches & blocks ─────────────────────────────
  function getBatch(n)         { return call('l2_getBatch', { batchNumber: n }); }
  function getBlock(n)         { return call('l2_getBlock', { blockNumber: n }); }
  function getAllBatches(limit, offset) {
    return call('l2_getAllBatches', { limit: limit || 100, offset: offset || 0 });
  }

  // ── Receipts ─────────────────────────────────────
  function getReceipt(id)      { return call('l2_getReceipt', { receiptId: id }); }
  function getReceiptsByWallet(w) { return call('l2_getReceiptsByWallet', { walletId: w }); }
  function getAllReceipts(limit, offset) {
    return call('l2_getAllReceipts', { limit: limit || 100, offset: offset || 0 });
  }

  // ── Audit ────────────────────────────────────────
  function getAuditLog(limit, offset) {
    return call('l2_getAuditLog', { limit: limit || 200, offset: offset || 0 });
  }
  function verifyChainIntegrity()   { return call('l2_verifyChainIntegrity'); }
  function verifyFinancialBalance() { return call('l2_verifyFinancialBalance'); }
  function detectDuplicateClaims()  { return call('l2_detectDuplicateClaims'); }

  // ── Claims ───────────────────────────────────────
  function getClaimsByMember(w)     { return call('l2_getClaimsByMember', { walletId: w }); }
  function getClaimsByPharmacy(w)   { return call('l2_getClaimsByPharmacy', { walletId: w }); }
  function getClaimsByPrescriber(w) { return call('l2_getClaimsByPrescriber', { walletId: w }); }
  function getClaimsByNdc(n)        { return call('l2_getClaimsByNdc', { ndcHash: n }); }
  function getClaimWithProof(idx)   { return call('l2_getClaimWithProof', { leafIndex: idx }); }
  function getClaimAccumulatorRoot(){ return call('l2_getClaimAccumulatorRoot'); }

  // ── Messages ─────────────────────────────────────
  function getMessagesByWallet(w)    { return call('l2_getMessagesByWallet', { walletId: w }); }
  function getMessagesBySender(w)    { return call('l2_getMessagesBySender', { walletId: w }); }
  function getMessagesByRecipient(w) { return call('l2_getMessagesByRecipient', { walletId: w }); }
  function getMessagesByThread(h)    { return call('l2_getMessagesByThread', { threadIdHash: h }); }
  function getMessageStoreRoot()     { return call('l2_getMessageStoreRoot'); }

  // ── Wallets ──────────────────────────────────────
  function reconstructAccumulator(w) { return call('l2_reconstructAccumulator', { walletId: w }); }

  // ── Formulary ────────────────────────────────────
  function getFormulary(planIdHash)  { return call('l2_getFormulary', { planIdHash }); }

  // ── Peers ────────────────────────────────────────
  function getPeerInfo()  { return call('l2_getPeerInfo'); }
  function getPeerList()  { return call('l2_getPeerList'); }

  // ── Leviathan (if target is leviathan) ───────────
  function getLeviathanStatus()   { return call('l2_getLeviathanStatus'); }
  function getPartitionLeaders()  { return call('l2_getPartitionLeaders'); }
  function getQuorumStatus()      { return call('l2_getQuorumStatus'); }
  function getStateCertificate(i) { return call('l2_getStateCertificate', { partitionIndex: i }); }

  // ── Entities (viz) ───────────────────────────────
  async function getVizEntities() {
    const res = await fetch(baseUrl + '/viz/entities', { headers: headers() });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return []; }
  }

  // ── Admin ────────────────────────────────────────
  function forceBatch(partIdx) {
    const params = {};
    if (partIdx !== undefined) params.partitionIndex = partIdx;
    return call('l2_forceBatch', params, true);
  }

  // ── SSE ──────────────────────────────────────────
  function connectSSE(onEvent) {
    disconnectSSE();
    try {
      sseConn = new EventSource(baseUrl + '/events');
      sseConn.onopen = () => sseListeners.forEach(fn => fn('connected'));
      sseConn.onmessage = ev => {
        try { if (onEvent) onEvent(JSON.parse(ev.data)); }
        catch { if (onEvent) onEvent({ raw: ev.data }); }
      };
      sseConn.onerror = () => sseListeners.forEach(fn => fn('disconnected'));
    } catch {}
  }
  function disconnectSSE() { if (sseConn) { sseConn.close(); sseConn = null; } }

  function connectVizSSE(onEvent) {
    disconnectVizSSE();
    try {
      vizConn = new EventSource(baseUrl + '/viz/events');
      vizConn.onmessage = ev => {
        try { if (onEvent) onEvent(JSON.parse(ev.data)); }
        catch { if (onEvent) onEvent({ raw: ev.data }); }
      };
    } catch {}
  }
  function disconnectVizSSE() { if (vizConn) { vizConn.close(); vizConn = null; } }

  function onConnectionChange(fn) { sseListeners.push(fn); }
  async function checkConnection() {
    try { await getHealth(); return true; } catch { return false; }
  }

  return {
    setBaseUrl, setAdminToken, getAdminToken,
    call, getHealth,
    getStatus, getChainState, getChainProof, getStateDigest,
    getBatch, getBlock, getAllBatches,
    getReceipt, getReceiptsByWallet, getAllReceipts,
    getAuditLog, verifyChainIntegrity, verifyFinancialBalance, detectDuplicateClaims,
    getClaimsByMember, getClaimsByPharmacy, getClaimsByPrescriber, getClaimsByNdc,
    getClaimWithProof, getClaimAccumulatorRoot,
    getMessagesByWallet, getMessagesBySender, getMessagesByRecipient, getMessagesByThread, getMessageStoreRoot,
    reconstructAccumulator, getFormulary,
    getPeerInfo, getPeerList,
    getLeviathanStatus, getPartitionLeaders, getQuorumStatus, getStateCertificate,
    getVizEntities,
    forceBatch,
    connectSSE, disconnectSSE, connectVizSSE, disconnectVizSSE,
    onConnectionChange, checkConnection,
  };
})();
