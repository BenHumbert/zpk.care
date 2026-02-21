/**
 * Utility helpers for the visualizer.
 */

/** Truncate a wallet/hash ID for display */
export function truncateId(id, len = 8) {
  if (!id || id.length <= len * 2 + 3) return id || '—';
  return `${id.slice(0, len)}...${id.slice(-len)}`;
}

/** Format cents as dollar string */
export function formatCents(cents) {
  if (typeof cents === 'string') {
    if (cents.startsWith('$')) return cents;
    cents = parseInt(cents, 10);
  }
  if (typeof cents !== 'number' || isNaN(cents)) return '$0.00';
  return `$${(cents / 100).toFixed(2)}`;
}

/** Format timestamp as HH:MM:SS */
export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/** Format timestamp as relative (e.g., "2s ago") */
export function formatRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 1000) return 'now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

/** Actor type color map */
export const ACTOR_COLORS = {
  member: '#4fc3f7',
  prescriber: '#66bb6a',
  pharmacy: '#ffa726',
  insurer: '#ab47bc',
  employer: '#78909c',
};

/** Lane color map */
export const LANE_COLORS = {
  enrollment: '#1565c0',
  eligibility: '#2e7d32',
  prescription: '#e65100',
  fulfillment: '#ad1457',
  messaging: '#6a1b9a',
  batch: '#37474f',
};

/** Lane icons */
export const LANE_ICONS = {
  enrollment: '\u{1F4CB}',   // clipboard
  eligibility: '\u{2705}',  // check mark
  prescription: '\u{1F48A}', // pill
  fulfillment: '\u{1F4B0}', // money bag
  messaging: '\u{1F4E8}',   // envelope
  batch: '\u{1F4E6}',       // package
};

/** Human-readable event type descriptions */
export function describeEvent(event) {
  const type = event.type;
  const d = event.data || {};
  const target = event.target ? ` \u2192 ${event.target}` : '';

  switch (type) {
    case 'viz:token:generated':
      return `Token generated for ${d.memberHint || 'member'}${target}`;
    case 'viz:token:consumed':
      return `Token ${d.tokenId} consumed`;
    case 'viz:enrollment:started':
      return `Enrollment started — ${d.step || ''}`;
    case 'viz:enrollment:complete':
      return `Enrollment complete — ${d.lifecycle || ''}${target}`;
    case 'viz:eligibility:check':
      return `Eligibility check — plan: ${d.plan || ''}`;
    case 'viz:eligibility:verified':
      return `Eligible \u2714 — ${d.coverageType || ''}${target}`;
    case 'viz:formulary:check':
      return `Formulary check — ${d.medication || ''} (Tier ${d.tier || '?'})`;
    case 'viz:formulary:verified':
      return `On formulary \u2714 — Copay: ${d.copay || ''}${d.requiresPA ? ' [PA Required]' : ''}`;
    case 'viz:prescription:written':
      return `Rx written — ${d.drug || ''} #${d.qty || ''}${target}`;
    case 'viz:prescription:sent':
      return `eScript sent${target}`;
    case 'viz:prescription:received':
      return `eScript received from ${d.from || ''}`;
    case 'viz:prescription:status':
      return `Rx status: ${d.oldStatus ? d.oldStatus + ' \u2192 ' : ''}${d.newStatus || d.status || ''} — ${d.drug || ''}`;
    case 'viz:fulfillment:started':
      return `Fill started — ${d.drug || ''} x${d.qty || ''}${target}`;
    case 'viz:fulfillment:settled':
      return `Claim settled — Patient: ${d.patientPay || ''}, Plan: ${d.planPay || ''}${target}`;
    case 'viz:accumulator:updated':
      return `Accumulators updated — ${d.member || ''} Ded: ${d.deductiblePaid || ''}`;
    case 'viz:reversal:processed':
      return `Reversal — ${d.drug || ''} Refund: ${d.patientRefund || ''}${target}`;
    case 'viz:message:sent':
      return `${d.messageType || 'Message'} sent${target}`;
    case 'viz:message:received':
      return `${d.messageType || 'Message'} received from ${d.from || ''}`;
    case 'viz:delegation:created':
      return `Delegation: ${d.scope || ''} to ${d.delegate || ''}${target}`;
    case 'viz:batch:submitted':
      return `Batch submitted — ${d.pendingCount ? d.pendingCount + ' pending' : d.receiptId || ''}`;
    case 'viz:batch:settled':
      return `Batch settled — L1 tx: ${d.l1TxHash || ''}`;
    default:
      return type;
  }
}

/** Generate a fake wallet-id-like hash for insurer view */
export function toOpaqueId(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(12, '0') + '...';
}
