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
 * Adjuda-GATOR Prescriber — REST API Client + SSE
 *
 * Talks to the local Nautilus server via REST endpoints.
 * All responses are wrapped in { ok, data, error, timestamp } envelope.
 */
const API = (() => {
  let baseUrl = location.origin;
  let eventSource = null;

  function setBaseUrl(url) { baseUrl = url.replace(/\/$/, ''); }
  function getBaseUrl() { return baseUrl; }

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

  // ── Core request helper ────────────────────────────────────

  async function request(method, path, body) {
    const opts = {
      method,
      headers: {},
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, opts);
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = j.error != null ? errMsg(j.error) : (typeof j.message === 'string' ? j.message : msg); } catch { /* use status */ }
      const err = new Error(msg);
      err.status = res.status;   // a refusal the page answers differently (403: the member's tap is needed)
      throw err;
    }
    const json = await res.json();
    // Envelope: { ok, data, error, timestamp }
    if (!json.ok) {
      throw new Error(json.error != null ? errMsg(json.error) : `Request failed: ${method} ${path}`);
    }
    return stripBigints(json.data);
  }

  async function get(path) { return request('GET', path); }
  async function post(path, body) { return request('POST', path, body || {}); }

  // ── SSE ────────────────────────────────────────────────────

  let sseReconnectDelay = 1000;
  const SSE_MAX_DELAY = 30000;

  function connectSSE(onEvent, onError, onOpen) {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    try {
      eventSource = new EventSource(`${baseUrl}/events`);
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (onEvent) onEvent(data);
        } catch { /* ignore parse errors */ }
      };
      eventSource.onopen = () => {
        sseReconnectDelay = 1000; // Reset on successful connection
        if (onOpen) onOpen();
      };
      eventSource.onerror = () => {
        if (onError) onError();
        eventSource.close();
        eventSource = null;
        // Reconnect with exponential backoff
        setTimeout(() => connectSSE(onEvent, onError, onOpen), sseReconnectDelay);
        sseReconnectDelay = Math.min(sseReconnectDelay * 2, SSE_MAX_DELAY);
      };
    } catch {
      setTimeout(() => connectSSE(onEvent, onError, onOpen), sseReconnectDelay);
      sseReconnectDelay = Math.min(sseReconnectDelay * 2, SSE_MAX_DELAY);
    }
    return eventSource;
  }

  function disconnectSSE() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  // ── Health ─────────────────────────────────────────────────

  async function health() {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.ok ? json.data : null;
    } catch {
      return null;
    }
  }

  // ── Onboarding ─────────────────────────────────────────────

  function getOnboardingStatus() { return get('/onboarding/status'); }

  function acceptToken(tokenId, groupId, planId, validUntil) {
    const body = { tokenId };
    if (groupId) body.groupId = groupId;
    if (planId) body.planId = planId;
    if (validUntil) body.validUntil = validUntil;
    return post('/onboarding/accept-token', body);
  }

  // The node generates the key itself and accepts none from the network (A3).
  function generateKey() {
    return post('/onboarding/generate-key', {});
  }

  function deriveWallet(prescriberIdQualifier, prescriberId) {
    return post('/onboarding/derive-wallet', {
      prescriberIdQualifier: Number(prescriberIdQualifier),
      prescriberId: String(prescriberId),
    });
  }

  function enroll(insurerUrl) {
    const body = {};
    if (insurerUrl) body.insurerUrl = insurerUrl;
    return post('/onboarding/enroll', body);
  }

  function compile() { return post('/onboarding/compile'); }

  // backupKey and restoreKey are gone. The routes they called exported and overwrote the
  // enrollment key over HTTP; see the note in src/nodes/routes/prescriber-routes.ts.

  // ── Proofs ─────────────────────────────────────────────────

  function generateRegistrationProof() { return post('/proof/registration'); }
  function getProofTimings() { return get('/proof-timings'); }

  // ── Prescriptions ──────────────────────────────────────────

  function getPrescriptions() { return get('/prescriptions'); }
  function getPrescriptionSummary() { return get('/prescriptions/summary'); }
  function getPrescriptionsByRange(start, end) {
    return get(`/prescriptions/range?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  }
  function getPrescriptionsByPatient(memberWalletId) {
    return get(`/prescriptions/patient/${encodeURIComponent(memberWalletId)}`);
  }
  function getPrescriptionsByMedication(ndcHash) {
    return get(`/prescriptions/medication/${encodeURIComponent(ndcHash)}`);
  }
  function getPrescriptionsByPharmacy(pharmacyWalletId) {
    return get(`/prescriptions/pharmacy/${encodeURIComponent(pharmacyWalletId)}`);
  }
  function getPatientCount() { return get('/prescriptions/patients/count'); }
  function getPharmacyCount() { return get('/prescriptions/pharmacies/count'); }
  function getMedicationBreakdown() { return get('/prescriptions/medications/breakdown'); }
  function writePrescription(data) { return post('/prescriptions/write', data); }

  // ── Prescribe with ZK Proof (async — polls for result) ─────

  function prescribeWithProof(data) { return post('/prescriptions/prescribe', data); }
  function prescribeStatus(jobKey) { return get('/prescriptions/prescribe-status?jobKey=' + encodeURIComponent(jobKey)); }

  // ── Provider Network ───────────────────────────────────────

  function getNetworkPrescribers() { return get('/network/prescribers'); }
  function checkNetwork(walletId) { return get(`/network/check/${encodeURIComponent(walletId)}`); }
  function getNetworkCount() { return get('/network/count'); }

  // ── Formulary (legacy) ──────────────────────────────────────
  function getFormulary(planIdHash) { return get(`/formulary/${encodeURIComponent(planIdHash)}`); }
  function checkDrugCoverage(planIdHash, ndcHash) {
    return get(`/formulary/${encodeURIComponent(planIdHash)}/check/${encodeURIComponent(ndcHash)}`);
  }

  // ── Formulary (Option C — paginated) ──────────────────────
  function getFormularyCategories() { return get('/formulary-categories'); }
  function getFormularyPage(params) {
    var qs = [];
    if (params.namePrefix) qs.push('namePrefix=' + encodeURIComponent(params.namePrefix));
    if (params.classification) qs.push('classification=' + encodeURIComponent(params.classification));
    if (params.tierLevel) qs.push('tierLevel=' + params.tierLevel);
    if (params.route) qs.push('route=' + encodeURIComponent(params.route));
    if (params.planIdHash) qs.push('planIdHash=' + encodeURIComponent(params.planIdHash));
    if (params.offset != null) qs.push('offset=' + params.offset);
    if (params.limit != null) qs.push('limit=' + params.limit);
    return get('/formulary-page' + (qs.length ? '?' + qs.join('&') : ''));
  }
  function getFormularyDrug(ndcHash) { return get(`/formulary-drug/${encodeURIComponent(ndcHash)}`); }
  function getFormularyRoutes() { return get('/formulary-routes'); }
  function getFormularyDrugCount() { return get('/formulary-drug-count'); }
  function getFormularyRoot() { return get('/formulary-root'); }
  function getFormularyWitness(ndcHash) { return get(`/formulary-witness/${encodeURIComponent(ndcHash)}`); }

  // ── Providers ─────────────────────────────────────────────

  function getProviders(role) {
    const q = role ? `?role=${encodeURIComponent(role)}` : '';
    return get(`/providers${q}`);
  }

  // ── PCP ────────────────────────────────────────────────────

  function getPcpPatients() { return get('/pcp/patients'); }

  // ── Messaging ──────────────────────────────────────────────

  function sendMessage(message, payload) { return post('/messaging/send', { message, payload }); }
  function getInbox() { return get('/messaging/inbox'); }
  function getSent() { return get('/messaging/sent'); }
  function getThread(threadIdHash) { return get(`/messaging/thread/${encodeURIComponent(threadIdHash)}`); }

  // ── Cost Estimation (proxied through Nautilus → sequencer RPC) ──
  function estimateCost(params) { return post('/estimate-cost', params); }

  // ── Public API ─────────────────────────────────────────────

  return {
    setBaseUrl,
    getBaseUrl,
    health,
    connectSSE,
    disconnectSSE,

    // Onboarding
    getOnboardingStatus,
    acceptToken,
    generateKey,
    deriveWallet,
    enroll,
    compile,

    // Proofs
    generateRegistrationProof,
    getProofTimings,

    // Prescriptions
    getPrescriptions,
    getPrescriptionSummary,
    getPrescriptionsByRange,
    getPrescriptionsByPatient,
    getPrescriptionsByMedication,
    getPrescriptionsByPharmacy,
    getPatientCount,
    getPharmacyCount,
    getMedicationBreakdown,
    writePrescription,
    prescribeWithProof,
    prescribeStatus,

    // Network
    getNetworkPrescribers,
    checkNetwork,
    getNetworkCount,

    // Formulary (legacy)
    getFormulary,
    checkDrugCoverage,
    // Formulary (Option C — paginated)
    getFormularyCategories,
    getFormularyPage,
    getFormularyDrug,
    getFormularyRoutes,
    getFormularyDrugCount,
    getFormularyRoot,
    getFormularyWitness,

    // Providers
    getProviders,

    // PCP
    getPcpPatients,

    // Messaging
    sendMessage,
    getInbox,
    getSent,
    getThread,

    // Cost estimation
    estimateCost,
  };
})();
