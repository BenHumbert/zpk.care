// zkTrident Pharmacy Nautilus — REST API Client
// Talks to the local Nautilus server at the same origin.

const BASE_URL = location.origin;

// ── Helpers ───────────────────────────────────────────────────

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }
  const url = BASE_URL + path;
  const res = await fetch(url, opts);
  const json = await res.json();
  // All responses use { ok, data, error, timestamp } envelope
  if (!json.ok) {
    const err = new Error(json.error || 'Unknown API error');
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return json.data;
}

function get(path) { return request('GET', path); }
function post(path, body) { return request('POST', path, body); }

// ── SSE Connection ────────────────────────────────────────────

class SSEConnection {
  constructor() {
    this.source = null;
    this.listeners = [];
    this.reconnectTimer = null;
    this.connected = false;
  }

  connect() {
    if (this.source) this.disconnect();
    try {
      this.source = new EventSource(BASE_URL + '/events');
      this.source.onopen = () => {
        this.connected = true;
        this._notify({ type: '__connection', data: { connected: true } });
      };
      this.source.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          this._notify(data);
        } catch (_) {
          this._notify({ type: 'raw', data: ev.data });
        }
      };
      this.source.onerror = () => {
        this.connected = false;
        this._notify({ type: '__connection', data: { connected: false } });
        this.source.close();
        this.source = null;
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      };
    } catch (_) {
      this.connected = false;
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this.connected = false;
  }

  onEvent(fn) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  _notify(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (_) { /* ignore */ }
    }
  }
}

// ── API Object ────────────────────────────────────────────────

const API = {

  // ── Health ──────────────────────────────────────────────────
  health() {
    return get('/health');
  },

  // ── Onboarding ─────────────────────────────────────────────
  onboarding: {
    status() {
      return get('/onboarding/status');
    },
    acceptToken(params) {
      // params: { tokenId, groupId?, planId?, validUntil? }
      return post('/onboarding/accept-token', params);
    },
    generateKey(params) {
      // params: { enrollmentKey? }
      return post('/onboarding/generate-key', params || {});
    },
    deriveWallet(params) {
      // params: { serviceProviderIdQualifier, serviceProviderId }
      return post('/onboarding/derive-wallet', params);
    },
    enroll(params) {
      // params: { insurerUrl? }
      return post('/onboarding/enroll', params || {});
    },
    compile() {
      return post('/onboarding/compile', {});
    },
    backupKey(params) {
      // params: { pin }
      return post('/onboarding/backup-key', params);
    },
    restoreKey(params) {
      // params: { backup, pin }
      return post('/onboarding/restore-key', params);
    },
  },

  // ── Proof ──────────────────────────────────────────────────
  proof: {
    registration() {
      return post('/proof/registration', {});
    },
    timings() {
      return get('/proof-timings');
    },
  },

  // ── Dispensing ─────────────────────────────────────────────
  dispensing: {
    list() {
      return get('/dispensing');
    },
    summary() {
      return get('/dispensing/summary');
    },
    range(start, end) {
      return get('/dispensing/range?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end));
    },
    byPatient(memberWalletId) {
      return get('/dispensing/patient/' + encodeURIComponent(memberWalletId));
    },
    byPrescriber(prescriberWalletId) {
      return get('/dispensing/prescriber/' + encodeURIComponent(prescriberWalletId));
    },
    byMedication(ndcHash) {
      return get('/dispensing/medication/' + encodeURIComponent(ndcHash));
    },
    medicationsBreakdown() {
      return get('/dispensing/medications/breakdown');
    },
    prescribersBreakdown() {
      return get('/dispensing/prescribers/breakdown');
    },
  },

  // ── DUR (Drug Utilization Review) ──────────────────────────
  dur: {
    fullHistory(memberWalletId) {
      return get('/dur/patient/' + encodeURIComponent(memberWalletId) + '/full-history');
    },
    activeMedications(memberWalletId) {
      return get('/dur/patient/' + encodeURIComponent(memberWalletId) + '/active-medications');
    },
    checkDuplicate(memberWalletId, ndcHash) {
      return get('/dur/patient/' + encodeURIComponent(memberWalletId) + '/check/' + encodeURIComponent(ndcHash));
    },
    claimDetail(leafIndex) {
      return get('/dur/claim/' + encodeURIComponent(leafIndex));
    },
  },

  // ── NFC ────────────────────────────────────────────────────
  nfc: {
    scan(params) {
      // params: { walletId?, payload?, payloadObject?, payloadBase64? }
      return post('/nfc/scan', params);
    },
  },

  // ── Messaging ──────────────────────────────────────────────
  messaging: {
    send(params) {
      // params: { message, payload }
      return post('/messaging/send', params);
    },
    inbox() {
      return get('/messaging/inbox');
    },
    sent() {
      return get('/messaging/sent');
    },
    thread(threadIdHash) {
      return get('/messaging/thread/' + encodeURIComponent(threadIdHash));
    },
  },

  // ── SSE ────────────────────────────────────────────────────
  sse: new SSEConnection(),
};

// Export for module or global use
if (typeof window !== 'undefined') {
  window.API = API;
}
