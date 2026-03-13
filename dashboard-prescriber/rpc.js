/**
 * zkTrident Prescriber — REST API Client + SSE
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
      try { const j = await res.json(); msg = j.error || j.message || msg; } catch { /* use status */ }
      throw new Error(msg);
    }
    const json = await res.json();
    // Envelope: { ok, data, error, timestamp }
    if (!json.ok) {
      throw new Error(json.error || `Request failed: ${method} ${path}`);
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

  function generateKey(enrollmentKey) {
    const body = {};
    if (enrollmentKey) body.enrollmentKey = enrollmentKey;
    return post('/onboarding/generate-key', body);
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

  function backupKey(pin) { return post('/onboarding/backup-key', { pin }); }
  function restoreKey(backup, pin) { return post('/onboarding/restore-key', { backup, pin }); }

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

  // ── Provider Network ───────────────────────────────────────

  function getNetworkPrescribers() { return get('/network/prescribers'); }
  function checkNetwork(walletId) { return get(`/network/check/${encodeURIComponent(walletId)}`); }
  function getNetworkCount() { return get('/network/count'); }

  // ── Formulary ──────────────────────────────────────────────

  function getFormulary(planIdHash) { return get(`/formulary/${encodeURIComponent(planIdHash)}`); }
  function checkDrugCoverage(planIdHash, ndcHash) {
    return get(`/formulary/${encodeURIComponent(planIdHash)}/check/${encodeURIComponent(ndcHash)}`);
  }

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
    backupKey,
    restoreKey,

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

    // Network
    getNetworkPrescribers,
    checkNetwork,
    getNetworkCount,

    // Formulary
    getFormulary,
    checkDrugCoverage,

    // Providers
    getProviders,

    // PCP
    getPcpPatients,

    // Messaging
    sendMessage,
    getInbox,
    getSent,
    getThread,
  };
})();
