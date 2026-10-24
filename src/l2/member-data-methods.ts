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
 * The sequencer methods that return a member's data, and who may read each (D1, finding A-2).
 *
 * The sequencer's RPC server enforces this table (L2RpcServer.authorizeRead). Every node's /rpc proxy reads it too:
 * a proxy signs what it forwards with the node's own key or wallet, so for these methods it would read with the node's
 * rights on behalf of whoever reached its port (NautilusAppServer.handleRpcProxy). Plain TypeScript with no imports,
 * so a node reads the table without loading the sequencer.
 */

/**
 * Who may read a member-data method, besides the plan (a node key with the insurer role) and the operator, who always may:
 * 'self', the wallet itself; 'pcp', a prescriber the member named as primary care (the sequencer's PCP links);
 * 'prescriber', a prescriber the member's consent lets prescribe for it now, as the engine holds that consent (B5: the
 * primary-care prescriber the member named, or one its device authorized for this visit, within the visit's window and
 * for the drug asked about); 'attestation', any signed caller presenting the member's own unexpired attestation;
 * 'signed', any signed caller (the handler answers it with its own data only).
 */
export type MemberDataReader = 'self' | 'pcp' | 'prescriber' | 'attestation' | 'signed';

export interface MemberDataSpec {
  /** Whose data the call returns: a wallet named by `param` ('optional-wallet': only when it is sent), a provider, a directory entry, a receipt's or a claim leaf's member, a message thread, or every wallet (an enumeration). */
  subject: 'wallet' | 'optional-wallet' | 'provider' | 'entity' | 'receipt' | 'leaf' | 'thread' | 'enumeration';
  /** The parameter that names it; 'a|b' means the first of them that is present. */
  param?: string;
  readers: readonly MemberDataReader[];
}

/**
 * The methods that return a member's data, and who may read them (D1, finding A-2). Until this gate, a bare wallet ID
 * returned a member's claims, receipts, messages, accumulator and keys to anyone, and the receipt and audit lists
 * enumerated every wallet. Readers: the wallet itself (its registered signing key), the plan (a node key with the
 * insurer role) and the operator, always; a prescriber the member named as primary care, for claims, receipts and the
 * directory entry; and any signed caller presenting the member's own unexpired attestation, the tap at a counter, for
 * claims, receipts, accumulator and wallet state. Enumerations answer the plan and the operator only. A thread answers
 * any signed caller with that caller's own messages. The pre-script quote (l2_estimateCost with a walletId) also answers
 * a prescriber who may prescribe for the member (owner decision 2026-10-19): the member's price, the drug's availability
 * on its plan and its prior-authorization status, so the prescriber can start a prior authorization before writing. That
 * reader is 'prescriber' alone, the engine's record of the member's consent: the primary-care prescriber the member
 * names now, or one its device authorized for this visit, and only while the provider registry shows the prescriber
 * active. Not 'pcp': the sequencer's PCP links keep every prescriber a member ever named and do not follow a provider's
 * status, so they would let a former or suspended primary-care prescriber read the member's price and prior
 * authorizations.
 *
 * The duplicate-claims check (l2_detectDuplicateClaims) is an enumeration too: it groups the audit log's fills by wallet,
 * drug, date of service and fill number, so each group it returns says that a wallet filled a drug on a day. It answered
 * anyone until the security review of the sweep fixes (2026-10-24). So is the balance check (l2_verifyFinancialBalance),
 * though it names no wallet. Its running totals of patient pay, plan pay, ingredient cost and dispensing fee move by one
 * claim's amounts each time the sequencer accepts a proof, and the event stream, which every member, prescriber and
 * pharmacy node key may open (D2), names the wallet and the receipt of each one, so a key that read the totals around
 * each event had every wallet's claim amounts, and the receipt IDs of fills that do not add up named their wallets. It
 * answered anyone until the review of round eight of the security fixes (2026-10-24), which reproduced that with a
 * pharmacy key. The chain-integrity check stays open: it returns the number of audit events, which the stream and the
 * sequencer's status publish anyway, and the sequence numbers of links that do not hash, which carry no amount, drug or
 * day. A broken link is the sequencer's own record failing to hash, which anyone may check; what the check costs to run
 * is A-80's to limit, per caller.
 *
 * The member's attestation (l2_getAttestation) is not in this table, whose reads the plan and the operator always pass.
 * It is the member's identity at a pharmacy counter, the tap that the attestation reader above and the pharmacy's
 * counter routes accept, so the sequencer gives it to the wallet's own signature only, as it issues one (A10b,
 * L2RpcServer.WALLET_SIGNED_METHODS). Until the sweep of the open routes (2026-10-24) it answered anyone who named the
 * wallet; read here, it then answered the plan and the operator, until the security review of that fix. The member's
 * device reads its own through its node's proxy, signed as the wallet; a pharmacy receives it from the member's tap, not
 * from the sequencer.
 */
export const MEMBER_DATA_METHODS: Readonly<Record<string, MemberDataSpec>> = {
  l2_getClaimsByMember: { subject: 'wallet', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_getReceiptsByWallet: { subject: 'wallet', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_reconstructAccumulator: { subject: 'wallet', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_getWalletState: { subject: 'wallet', param: 'walletId|0', readers: ['self', 'attestation'] },
  l2_getWalletWitnesses: { subject: 'wallet', param: 'walletId|0', readers: ['self', 'attestation'] },
  l2_getMessagesByWallet: { subject: 'wallet', param: 'walletId', readers: ['self'] },
  l2_getMessagesBySender: { subject: 'wallet', param: 'walletId', readers: ['self'] },
  l2_getMessagesByRecipient: { subject: 'wallet', param: 'walletId', readers: ['self'] },
  l2_getMessagesByThread: { subject: 'thread', readers: ['signed'] },
  l2_getEntity: { subject: 'entity', param: 'walletId', readers: ['self', 'pcp', 'attestation'] },
  l2_getEncryptionKey: { subject: 'wallet', param: 'walletId', readers: ['signed'] },
  l2_getPcpAssignments: { subject: 'provider', param: 'prescriberWalletId', readers: ['self'] },
  l2_getClaimsByPharmacy: { subject: 'provider', param: 'walletId', readers: ['self'] },
  l2_getClaimsByPrescriber: { subject: 'provider', param: 'walletId', readers: ['self'] },
  l2_getClaimsByNdc: { subject: 'enumeration', readers: [] },
  l2_getAllReceipts: { subject: 'enumeration', readers: [] },
  l2_getAuditLog: { subject: 'enumeration', readers: [] },
  l2_detectDuplicateClaims: { subject: 'enumeration', readers: [] },
  l2_verifyFinancialBalance: { subject: 'enumeration', readers: [] },
  l2_getReceipt: { subject: 'receipt', param: 'receiptId', readers: ['self'] },
  l2_getClaimWithProof: { subject: 'leaf', param: 'leafIndex', readers: ['self'] },
  l2_estimateCost: { subject: 'optional-wallet', param: 'walletId', readers: ['self', 'prescriber', 'attestation'] },
};

/** The table's entry for a method, or undefined (an own key only, so 'constructor' and the like are not methods). */
export function memberDataSpecOf(method: string): MemberDataSpec | undefined {
  return Object.prototype.hasOwnProperty.call(MEMBER_DATA_METHODS, method) ? MEMBER_DATA_METHODS[method] : undefined;
}

/**
 * Whether this call is one the read gate decides: any method in the table, except an optional-wallet method sent
 * without its wallet (a cost estimate that names no member), which stays open.
 */
export function callReadsMemberData(method: string, params: unknown): boolean {
  const spec = memberDataSpecOf(method);
  if (!spec) return false;
  if (spec.subject !== 'optional-wallet') return true;
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  return (spec.param ?? '').split('|').some((key) => typeof p[key] === 'string' && (p[key] as string).length > 0);
}
