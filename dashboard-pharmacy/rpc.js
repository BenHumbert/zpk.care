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

// Adjuda-GATOR Pharmacy Nautilus — REST API Client
// Talks to the local Nautilus server at the same origin.

const BASE_URL = location.origin;

// ── Helpers ───────────────────────────────────────────────────

// Normalize a value into a safe error message string (avoids "[object Object]")
function errMsg(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string') return e.message;
  if (typeof e.error === 'string') return e.error;
  if (e.error && typeof e.error.message === 'string') return e.error.message;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}

async function request(method, path, body, headers) {
  const opts = {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
  };
  if (body !== undefined && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }
  const url = BASE_URL + path;
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = (j.error != null ? errMsg(j.error) : (typeof j.message === 'string' ? j.message : '')) || msg; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // All responses use { ok, data, error, timestamp } envelope
  if (!json.ok) {
    const err = new Error(errMsg(json.error) || 'Unknown API error');
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return stripBigints(json.data);
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

function get(path, headers) { return request('GET', path, undefined, headers); }

// D1: the member's attestation from the last scan this node verified. Kept in memory only, never in
// browser storage. The DUR reads present it as X-Member-Attestation, and only for the wallet it names.
let lastTap = null;
function tapHeader(memberWalletId) {
  return lastTap && lastTap.w === memberWalletId
    ? { 'X-Member-Attestation': btoa(JSON.stringify(lastTap)) }
    : undefined;
}
function post(path, body) { return request('POST', path, body); }

// ── SSE Connection ────────────────────────────────────────────

class SSEConnection {
  constructor() {
    this.source = null;
    this.listeners = [];
    this.reconnectTimer = null;
    this.connected = false;
    this._delay = 1000;
  }

  connect() {
    if (this.source) this.disconnect();
    try {
      this.source = new EventSource(BASE_URL + '/events');
      this.source.onopen = () => {
        this.connected = true;
        this._delay = 1000;
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
        this.reconnectTimer = setTimeout(() => this.connect(), this._delay);
        this._delay = Math.min(this._delay * 2, 30000);
      };
    } catch (_) {
      this.connected = false;
      this.reconnectTimer = setTimeout(() => this.connect(), this._delay);
      this._delay = Math.min(this._delay * 2, 30000);
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
    // No arguments: the node generates the key itself and accepts none from the network (A3).
    generateKey() {
      return post('/onboarding/generate-key', {});
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
    // backupKey and restoreKey are gone. The routes they called exported and overwrote the
    // enrollment key over HTTP; see the note in src/nodes/routes/pharmacy-routes.ts.
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

  // ── Prescriptions (server-side state from sequencer) ──────
  prescriptions: {
    list() { return get('/prescriptions/list'); },
  },

  // ── Dispensing ─────────────────────────────────────────────
  dispensing: {
    list() {
      return get('/dispensing');
    },
    summary() {
      return get('/dispensing/summary');
    },
    markFilled(params) {
      // Marks a script as physically filled (no ZK proofs — status update only).
      // params: { prescriptionId, memberWalletId, ndcHash }
      return post('/dispensing/mark-filled', params);
    },
    fill(params) {
      // Legacy: prescribe-and-fill (creates Rx + dispenses in one step).
      return post('/dispensing/fill', params);
    },
    dispense(params) {
      // Dispense an existing FILLED prescription (3 ZK proofs: ProofGate + PrescriptionStatus + AccumulatorFulfillment).
      // params: { prescriptionId, quantityDispensed, ingredientCostCents, dispensingFeeCents }
      return post('/dispensing/dispense', params);
    },
    fillStatus(jobKey) {
      return get('/dispensing/fill-status?jobKey=' + encodeURIComponent(jobKey));
    },
    reverse(params) {
      // Fires async ZK reversal proof. Returns 202 { jobKey, status: 'pending' }.
      // params: { prescriptionId, reason? }
      return post('/dispensing/reverse', params);
    },
    reverseStatus(jobKey) {
      return get('/dispensing/reverse-status?jobKey=' + encodeURIComponent(jobKey));
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
      return get('/dur/patient/' + encodeURIComponent(memberWalletId) + '/full-history', tapHeader(memberWalletId));
    },
    activeMedications(memberWalletId) {
      return get('/dur/patient/' + encodeURIComponent(memberWalletId) + '/active-medications', tapHeader(memberWalletId));
    },
    checkDuplicate(memberWalletId, ndcHash) {
      return get('/dur/patient/' + encodeURIComponent(memberWalletId) + '/check/' + encodeURIComponent(ndcHash), tapHeader(memberWalletId));
    },
    claimDetail(leafIndex) {
      return get('/dur/claim/' + encodeURIComponent(leafIndex));
    },
  },

  // ── Formulary (via sequencer RPC proxy) ───────────────────
  formulary: {
    async get(planIdHash) {
      const res = await fetch(BASE_URL + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getFormulary', params: { planIdHash } }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'RPC error');
      return stripBigints(json.result);
    },
  },

  // (Interactive namespace removed — proof pipeline now handled by pharmacy routes internally)

  // ── NFC ────────────────────────────────────────────────────
  nfc: {
    async scan(params) {
      // params: { attestation?, walletId?, payload?, payloadObject?, payloadBase64? }
      lastTap = null;
      const result = await post('/nfc/scan', params);
      // Keep the tap only once this node has verified it against the sequencer's pinned key.
      if (result && result.attestationVerified && params && params.attestation && params.attestation.w === result.walletId) {
        lastTap = params.attestation;
      }
      return result;
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
