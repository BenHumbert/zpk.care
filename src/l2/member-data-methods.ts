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

/** Who may read a member-data method, besides the plan (a node key with the insurer role) and the operator, who always may. */
export type MemberDataReader = 'self' | 'pcp' | 'attestation' | 'signed';

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
 * any signed caller with that caller's own messages.
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
  l2_getReceipt: { subject: 'receipt', param: 'receiptId', readers: ['self'] },
  l2_getClaimWithProof: { subject: 'leaf', param: 'leafIndex', readers: ['self'] },
  l2_estimateCost: { subject: 'optional-wallet', param: 'walletId', readers: ['self', 'attestation'] },
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
