/**
 * Adjuda-GATOR RPC Client — Browser JSON-RPC 2.0 + SSE
 */
const RPC = (() => {
  // Auto-detect: same origin if served from Leviathan, otherwise configurable
  let baseUrl = location.origin;
  let adminToken = null;
  let requestId = 0;

  function setBaseUrl(url) { baseUrl = url.replace(/\/$/, ''); }
  function setAdminToken(token) { adminToken = token; }

  async function call(method, params = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['X-Admin-Token'] = adminToken;
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${json.error.message} (${json.error.code})`);
    return json.result;
  }

  // Unwrap __bigint__:N values recursively
  function unwrapBigInt(v) {
    if (typeof v === 'string' && v.startsWith('__bigint__:')) return v.slice(11);
    if (Array.isArray(v)) return v.map(unwrapBigInt);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = unwrapBigInt(val);
      return out;
    }
    return v;
  }

  async function rpc(method, params = {}) {
    const raw = await call(method, params);
    return unwrapBigInt(raw);
  }

  // SSE
  function connectSSE(onEvent, onError) {
    const es = new EventSource(`${baseUrl}/events`);
    es.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch {}
    };
    es.onerror = () => { if (onError) onError(); };
    return es;
  }

  // Health check
  async function health() {
    const res = await fetch(`${baseUrl}/health`);
    return res.ok;
  }

  // Convenience methods
  return {
    setBaseUrl,
    setAdminToken,
    call: rpc,
    health,
    connectSSE,

    getStatus: () => rpc('l2_getStatus'),
    getChainState: () => rpc('l2_getChainState'),
    getAllBatches: () => rpc('l2_getAllBatches'),
    getAllReceipts: () => rpc('l2_getAllReceipts'),
    getBatch: (n) => rpc('l2_getBatch', { batchNumber: String(n) }),
    getReceipt: (id) => rpc('l2_getReceipt', { receiptId: id }),
    getReceiptsByWallet: (wid) => rpc('l2_getReceiptsByWallet', { walletId: wid }),
    getFormulary: () => rpc('l2_getFormulary'),
    getAuditLog: () => rpc('l2_getAuditLog'),
    getClaimsByMember: (wid) => rpc('l2_getClaimsByMember', { walletId: wid }),
    getClaimsByNdc: (ndc) => rpc('l2_getClaimsByNdc', { ndcHash: ndc }),
    forceBatch: () => rpc('l2_forceBatch'),
    getLeviathanStatus: () => rpc('l2_getLeviathanStatus'),
    getQuorumStatus: () => rpc('l2_getQuorumStatus'),

    // Health endpoint (not RPC — direct REST)
    getHealthData: async () => {
      const res = await fetch(`${baseUrl}/health`);
      return res.json();
    },
  };
})();
