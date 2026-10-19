/**
 * Read-only network reads for the director's status card and its waits. The director never writes through the API
 * (no force-batch, no proof submission, no eject): this module only knows read methods and refuses any other.
 * Answers are cut down to allowlisted fields before anything else sees them, request bodies are never logged (there
 * are none worth logging: these are GETs and read-only JSON-RPC calls), and the operator token is passed in by the
 * caller, sent only as an Authorization header, and never logged.
 *
 *   const reads = makeReads({ seqUrl: 'http://127.0.0.1:3030', memberUrl: 'http://127.0.0.1:4001', operatorToken, log });
 *   await reads.compiled();                       // GET /interactive/state -> compiled (operator read)
 *   await reads.member(walletId);                 // that member's allowlisted summary (no name, no employee ID)
 *   await reads.receiptsByWallet(walletId);       // l2_getReceiptsByWallet (operator read)
 *   await reads.walletState(walletId);            // l2_getWalletState (operator read)
 *   await reads.status();                         // l2_getStatus (open): nextBatchInMs, batch counts
 *   await reads.memberPhase();                    // :4001 GET /onboarding/status (open): phase only
 *   const stop = await reads.events((e) => ..., { types: ['proof:accepted', 'batch:built', 'batch:settled'] });
 */
import crypto from 'node:crypto';

/** The launcher's node admin token derivation (src/security/node-roles.ts deriveNodeAdminToken). */
const NODE_ADMIN_TOKEN_LABEL = 'zpk.care/node-admin/v1\n';
export function deriveNodeAdminToken(operatorToken, nodeId) {
  if (!operatorToken) throw new Error('deriveNodeAdminToken: the operator token is empty');
  if (!nodeId || nodeId.includes('\n')) throw new Error('deriveNodeAdminToken: nodeId is required and may not contain a newline');
  return crypto.createHmac('sha256', operatorToken).update(NODE_ADMIN_TOKEN_LABEL + nodeId, 'utf8').digest('hex');
}

/** The insurer dashboard's admin token: explicit when the network booted with one, else the launcher's derivation. */
export function insurerAdminToken(env = process.env) {
  if (env.ZKTRIDENT_INSURER_ADMIN_TOKEN) return env.ZKTRIDENT_INSURER_ADMIN_TOKEN;
  return env.ZKTRIDENT_ADMIN_TOKEN ? deriveNodeAdminToken(env.ZKTRIDENT_ADMIN_TOKEN, 'insurer') : '';
}

/** Keeps only the allowlisted fields of `obj` ({ field: true } or a nested spec; arrays are mapped). */
export function pick(obj, spec) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((x) => pick(x, spec));
  const out = {};
  for (const [k, v] of Object.entries(spec)) {
    if (!(k in obj)) continue;
    out[k] = v === true ? (obj[k] !== null && typeof obj[k] === 'object' ? JSON.parse(JSON.stringify(obj[k])) : obj[k]) : pick(obj[k], v);
  }
  return out;
}

/** "__bigint__:123" (the sequencer's BigInt encoding) -> "123". */
const unBig = (k, v) => (typeof v === 'string' && v.startsWith('__bigint__:') ? v.slice(11) : v);

export const MEMBER_FIELDS = Object.freeze({
  walletIdDisplay: true, planId: true, groupId: true, lifecycle: true, pendingWalletUpdates: true, nonce: true, pcpAssigned: true,
  accumulator: { deductiblePaidCents: true, oopPaidCents: true, benefitUsedCents: true, limits: { deductibleAmountCents: true, oopMaxCents: true, annualBenefitMaxCents: true } }
  // never: displayName, employeeId, familyId, relationship, credentialJson, lastAttestation, credentialInventory
});
export const RECEIPT_FIELDS = Object.freeze({
  receiptId: true, sequenceNumber: true, isRegistration: true, acceptedAt: true, l1Status: true, auditEventHash: true,
  claimLeafIndex: true, l2BlockNumber: true, l1BatchNumber: true
});
export const WALLET_STATE_FIELDS = Object.freeze({ credentialInventoryRoot: true, nonce: true });
export const STATUS_FIELDS = Object.freeze({
  nextBatchInMs: true, batchIntervalMs: true, pendingProofs: true, totalProofsAccepted: true, totalBatchesBuilt: true,
  totalBatchesSettled: true, totalBatchesFailed: true, blockHeight: true
});
export const EVENT_FIELDS = Object.freeze({
  type: true, timestamp: true, ts: true, receiptId: true, sequenceNumber: true, batchIndex: true, batchNumber: true,
  transitionCount: true, proofCount: true, claimLeafIndex: true,
  data: { receiptId: true, sequenceNumber: true, batchIndex: true, batchNumber: true, transitionCount: true, proofCount: true, claimLeafIndex: true, status: true }
});

/** The only JSON-RPC methods this module will send. */
const READ_METHODS = new Set(['l2_getStatus', 'l2_getReceiptsByWallet', 'l2_getWalletState']);

export function makeReads({ seqUrl = 'http://127.0.0.1:3030', memberUrl = 'http://127.0.0.1:4001', operatorToken = '', log = () => {}, timeoutMs = 20000 } = {}) {
  const seq = String(seqUrl).replace(/\/+$/, '');
  const mem = String(memberUrl).replace(/\/+$/, '');
  const auth = operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {};
  let rpcId = 0;

  async function getJson(url, { authed = false } = {}) {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...(authed ? auth : {}) }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    log(`read GET ${new URL(url).pathname} ${res.status}`);
    if (!res.ok) throw new Error(`GET ${new URL(url).pathname} answered ${res.status}`);
    return JSON.parse(text, unBig);
  }
  async function rpc(method, params = {}, { authed = true } = {}) {
    if (!READ_METHODS.has(method)) throw new Error(`reads: ${method} is not a read method this tool may call`);
    const res = await fetch(`${seq}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authed ? auth : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    log(`read ${method} ${res.status}`);
    const j = text ? JSON.parse(text, unBig) : {};
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
    return j.result;
  }
  const unwrap = (j) => (j && typeof j === 'object' && 'ok' in j && 'data' in j ? j.data : j);

  return {
    /** True once the engine has compiled every circuit (operator read of /interactive/state). */
    async compiled() {
      const s = await getJson(`${seq}/interactive/state`, { authed: true });
      return pick(s, { compiled: true, ready: true });
    },
    /** One enrolled member's allowlisted summary, found by wallet ID; null when not enrolled yet. */
    async member(walletId) {
      const s = await getJson(`${seq}/interactive/state`, { authed: true });
      const list = Array.isArray(s.enrolledMembers) ? s.enrolledMembers : [];
      const w = String(walletId);
      const m = list.find((x) => String(x.walletId) === w || String(x.walletIdDisplay) === w);
      return m ? pick(m, MEMBER_FIELDS) : null;
    },
    async receiptsByWallet(walletId) {
      const r = await rpc('l2_getReceiptsByWallet', { walletId: String(walletId) });
      return pick(Array.isArray(r) ? r : [], RECEIPT_FIELDS);
    },
    async walletState(walletId) {
      return pick(await rpc('l2_getWalletState', { walletId: String(walletId) }), WALLET_STATE_FIELDS);
    },
    async status() {
      return pick(await rpc('l2_getStatus', {}, { authed: false }), STATUS_FIELDS);
    },
    /** The member device's onboarding phase (an open route that answers the phase only). */
    async memberPhase() {
      const j = unwrap(await getJson(`${mem}/onboarding/status`));
      return j && (j.phase || (j.onboarding && j.onboarding.phase)) || null;
    },
    /** The sequencer's event stream, read in Node with the token in a header. Returns a stop function. */
    async events(onEvent, { types = null } = {}) {
      const ac = new AbortController();
      const res = await fetch(`${seq}/events`, { headers: { Accept: 'text/event-stream', ...auth }, signal: ac.signal });
      log(`read GET /events ${res.status}`);
      if (!res.ok || !res.body) throw new Error(`/events answered ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
              if (!data) continue;
              let j;
              try { j = JSON.parse(data, unBig); } catch { continue; }
              if (types && !types.includes(j.type)) continue;
              try { onEvent(pick(j, EVENT_FIELDS)); } catch { /* a listener's problem is not the stream's */ }
            }
          }
        } catch { /* aborted */ }
      })();
      return () => ac.abort();
    }
  };
}
