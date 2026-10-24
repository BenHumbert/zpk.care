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
 * Adjuda-GATOR Leviathan Dashboard — JSON-RPC 2.0 Client
 * Talks to the L2RpcServer via POST /rpc and GET /health, /events, /viz/events.
 */
const RPC = (() => {
  let baseUrl = location.origin;
  let adminToken = '';
  let sseConnection = null;
  let vizSseConnection = null;
  let sseListeners = [];
  let sseReconnectDelay = 1000;
  let sseReconnectTimer = null;
  let vizReconnectDelay = 1000;
  let vizReconnectTimer = null;
  let lastOnEvent = null;
  let lastVizOnEvent = null;
  let rpcId = 0;

  function setBaseUrl(url) { baseUrl = url.replace(/\/+$/, ''); }
  function setAdminToken(token) { adminToken = token || ''; }
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

  // ── JSON-RPC 2.0 call ──────────────────────────────────
  async function call(method, params, admin) {
    rpcId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: method,
      params: params || {},
    });
    const res = await fetch(baseUrl + '/rpc', {
      method: 'POST',
      headers: headers(admin),
      body: body,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (data && data.error) {
      var msg = data.error.message || data.error.data || JSON.stringify(data.error);
      var err = new Error(msg);
      err.code = data.error.code;
      throw err;
    }
    return stripBigints(data.result !== undefined ? data.result : data);
  }

  // ── REST convenience ───────────────────────────────────
  async function getHealth() {
    var res = await fetch(baseUrl + '/health', { headers: headers() });
    var text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  // ── Leviathan-specific RPC methods ─────────────────────
  function getLeviathanStatus() {
    return call('l2_getLeviathanStatus').catch(function () {
      // Fallback for single L2Node (not L2Leviathan)
      return Promise.all([
        call('l2_getStatus').catch(function () { return {}; }),
        getHealth().catch(function () { return {}; }),
        call('l2_getPeerInfo').catch(function () { return null; }),
        call('l2_getPeerList').catch(function () { return []; }),
      ]).then(function (results) {
        var s = results[0];
        var h = results[1];
        var peerInfo = results[2];
        var peers = results[3];
        if (!Array.isArray(peers)) peers = [];

        var pool = h && h.provingPool ? h.provingPool : {};
        var workerList = h && h.workers ? h.workers : [];
        var nodeId = (peerInfo && peerInfo.peerId && peerInfo.peerId !== 'unknown')
          ? peerInfo.peerId : 'sequencer';

        return {
          nodeId: nodeId,
          running: s.running !== undefined ? s.running : true,
          partitionCount: 1,
          primaryPartition: 0,
          activeLeaderPartitions: [0],
          l2Only: s.l2Only !== undefined ? s.l2Only : true,
          uptimeMs: s.uptimeMs || 0,
          uptime: s.uptimeMs || 0,
          partitions: [{
            index: 0,
            leader: nodeId,
            role: 'sequencer',
            pending: s.pendingProofs || 0,
            totalProofs: s.totalProofsAccepted || 0,
            totalBatches: s.totalBatchesBuilt || 0,
            state: 'active',
          }],
          workers: workerList.map(function (w) {
            return {
              id: w.id,
              state: w.busy ? 'proving' : (w.status || 'idle'),
              partition: 0,
              jobsCompleted: w.jobsProcessed || w.jobsCompleted || 0,
              currentJob: w.currentJobId,
              pid: w.pid,
              restarts: w.restarts || 0,
            };
          }),
          provingPool: {
            poolSize: pool.poolSize || workerList.length,
            workersAlive: pool.workersAlive || workerList.length,
            workersIdle: pool.workersIdle || workerList.length,
            workersBusy: pool.workersBusy || 0,
            queueDepth: pool.queueDepth || 0,
            totalJobsCompleted: pool.totalJobsCompleted || 0,
            avgProveTimeMs: pool.avgProveTimeMs || 0,
          },
          peers: peers,
          replicas: peers.filter(function (p) { return p.role === 'replica'; }),
          globalTotals: {
            totalProofsAccepted: s.totalProofsAccepted || 0,
            totalBatchesBuilt: s.totalBatchesBuilt || 0,
            totalBatchesSettled: s.totalBatchesSettled || 0,
            totalBatchesFailed: s.totalBatchesFailed || 0,
            pendingProofs: s.pendingProofs || 0,
          },
          chain: {
            blockHeight: s.blockHeight || '0',
            globalStateRoot: s.globalStateRoot || '0',
            registryRoot: s.currentRegistryRoot,
            lifecycleRoot: s.currentLifecycleRoot,
            walletCount: s.currentWalletCount || '0',
          },
        };
      });
    });
  }
  function getPartitionLeaders() { return call('l2_getPartitionLeaders'); }
  function getPartitionStatus(idx) { return call('l2_getPartitionStatus', { partitionIndex: idx }); }
  function getStatus() { return call('l2_getStatus'); }
  function getHealthRpc() { return call('l2_getHealth'); }

  // ── Quorum ─────────────────────────────────────────────
  function getQuorumStatus() { return call('l2_getQuorumStatus'); }
  function getStateCertificate(idx) { return call('l2_getStateCertificate', { partitionIndex: idx }); }
  function verifyStateCertificate(cert) { return call('l2_verifyStateCertificate', { certificate: cert }); }

  // ── Data queries (aggregated across partitions) ────────
  // D1: the receipt list and the audit log answer the plan or the operator; the page sends the operator's token when it
  // holds one (set on the Admin tab)
  function getReceipts(limit, offset) {
    return call('l2_getAllReceipts', { limit: limit || 100, offset: offset || 0 }, true);
  }
  // The receipts the sequencer holds, newest first. It drops old receipts once they settle, so a receipt's place in the
  // list is not its sequence number: one page at the server's cap (1000) holds every receipt it keeps.
  async function getRecentReceipts() {
    var all = await getReceipts(1000);
    if (!Array.isArray(all)) return [];
    return all.sort(function (a, b) { return Number(b.sequenceNumber) - Number(a.sequenceNumber); });
  }
  function getBatches(limit, offset) {
    return call('l2_getAllBatches', { limit: limit || 100, offset: offset || 0 });
  }
  // The newest `limit` batches, newest first. l2_getAllBatches pages from the oldest; the sequencer
  // numbers its batches from 0 and keeps every one, so the newest start at latestBatchNumber + 1 - limit.
  async function getLatestBatches(limit) {
    var digest = await getStateDigest();
    if (!digest || digest.latestBatchNumber === null || digest.latestBatchNumber === undefined) return [];
    var page = await getBatches(limit, Math.max(0, Number(digest.latestBatchNumber) + 1 - limit));
    if (!Array.isArray(page)) return [];
    return page.sort(function (a, b) { return Number(b.batchNumber) - Number(a.batchNumber); });
  }
  // The sequencer takes a batch number as a decimal string, as it takes every chain number
  function getBatch(n) { return call('l2_getBatch', { batchNumber: String(n) }); }
  function getAuditLog(limit, offset) {
    return call('l2_getAuditLog', { limit: limit || 200, offset: offset || 0 }, true);
  }
  function getChainProof() { return call('l2_getChainProof'); }
  function verifyChainIntegrity() { return call('l2_verifyChainIntegrity'); }
  function verifyFinancialBalance() { return call('l2_verifyFinancialBalance'); }
  function detectDuplicateClaims() { return call('l2_detectDuplicateClaims'); }

  // ── Claims ─────────────────────────────────────────────
  function getClaimsByMember(w) { return call('l2_getClaimsByMember', { walletId: w }); }
  function getClaimsByPrescriber(w) { return call('l2_getClaimsByPrescriber', { walletId: w }); }
  function getClaimsByPharmacy(w) { return call('l2_getClaimsByPharmacy', { walletId: w }); }
  function getClaimsByNdc(n) { return call('l2_getClaimsByNdc', { ndcHash: n }); }

  // ── Peer network ───────────────────────────────────────
  function getPeerInfo() { return call('l2_getPeerInfo'); }
  function getPeerList() { return call('l2_getPeerList'); }
  function getStateDigest() { return call('l2_getStateDigest'); }

  // ── Admin ──────────────────────────────────────────────
  function forceBatch(partitionIndex) {
    var params = {};
    if (partitionIndex !== undefined) params.partitionIndex = partitionIndex;
    return call('l2_forceBatch', params, true);
  }

  // ── Viz state ──────────────────────────────────────────
  async function getVizState() {
    var res = await fetch(baseUrl + '/viz/state', { headers: headers() });
    var text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  async function getVizEntities() {
    var res = await fetch(baseUrl + '/viz/entities', { headers: headers() });
    var text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  // ── SSE (chain events) ─────────────────────────────────
  function connectSSE(onEvent) {
    disconnectSSE();
    lastOnEvent = onEvent;
    try {
      sseConnection = new EventSource(baseUrl + '/events' + (adminToken ? '?token=' + encodeURIComponent(adminToken) : ''));
      sseConnection.onopen = function () {
        sseReconnectDelay = 1000;
        sseListeners.forEach(function (fn) { fn('connected'); });
      };
      sseConnection.onmessage = function (ev) {
        try {
          var data = JSON.parse(ev.data);
          if (onEvent) onEvent(data);
        } catch (e) {
          if (onEvent) onEvent({ raw: ev.data });
        }
      };
      sseConnection.onerror = function () {
        sseListeners.forEach(function (fn) { fn('disconnected'); });
        sseConnection.close();
        sseConnection = null;
        sseReconnectTimer = setTimeout(function () { connectSSE(lastOnEvent); }, sseReconnectDelay);
        sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
      };
    } catch (e) {
      sseReconnectTimer = setTimeout(function () { connectSSE(lastOnEvent); }, sseReconnectDelay);
      sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
    }
  }

  function disconnectSSE() {
    if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
    if (sseConnection) { sseConnection.close(); sseConnection = null; }
  }

  // ── SSE (viz events) ───────────────────────────────────
  function connectVizSSE(onEvent) {
    disconnectVizSSE();
    lastVizOnEvent = onEvent;
    try {
      vizSseConnection = new EventSource(baseUrl + '/viz/events' + (adminToken ? '?token=' + encodeURIComponent(adminToken) : ''));
      vizSseConnection.onopen = function () {
        vizReconnectDelay = 1000;
      };
      vizSseConnection.onmessage = function (ev) {
        try {
          var data = JSON.parse(ev.data);
          if (onEvent) onEvent(data);
        } catch (e) {
          if (onEvent) onEvent({ raw: ev.data });
        }
      };
      vizSseConnection.onerror = function () {
        vizSseConnection.close();
        vizSseConnection = null;
        vizReconnectTimer = setTimeout(function () { connectVizSSE(lastVizOnEvent); }, vizReconnectDelay);
        vizReconnectDelay = Math.min(vizReconnectDelay * 2, 30000);
      };
    } catch (e) {
      vizReconnectTimer = setTimeout(function () { connectVizSSE(lastVizOnEvent); }, vizReconnectDelay);
      vizReconnectDelay = Math.min(vizReconnectDelay * 2, 30000);
    }
  }

  function disconnectVizSSE() {
    if (vizReconnectTimer) { clearTimeout(vizReconnectTimer); vizReconnectTimer = null; }
    if (vizSseConnection) { vizSseConnection.close(); vizSseConnection = null; }
  }

  function onConnectionChange(fn) { sseListeners.push(fn); }

  async function checkConnection() {
    try { await getHealth(); return true; } catch { return false; }
  }

  return {
    setBaseUrl, setAdminToken, getAdminToken, headers,
    call, getHealth, getHealthRpc,
    getLeviathanStatus, getPartitionLeaders, getPartitionStatus, getStatus,
    getQuorumStatus, getStateCertificate, verifyStateCertificate,
    getReceipts, getRecentReceipts, getBatches, getLatestBatches, getBatch, getAuditLog, getChainProof,
    verifyChainIntegrity, verifyFinancialBalance, detectDuplicateClaims,
    getClaimsByMember, getClaimsByPrescriber, getClaimsByPharmacy, getClaimsByNdc,
    getPeerInfo, getPeerList, getStateDigest,
    forceBatch,
    getVizState, getVizEntities,
    connectSSE, disconnectSSE, connectVizSSE, disconnectVizSSE,
    onConnectionChange, checkConnection,
  };
})();
