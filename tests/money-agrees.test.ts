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
 * What is billed, what the ledger holds and what the audit chain commits to agree — plan items D4 and D5,
 * findings A-10, A-11 and A-26.
 *
 * The ledger refuses a duplicate fill instead of silently returning the first one, keeps the remainder of
 * a partial fill apart from a duplicate by the fill number, and frees a fill's key when it is reversed.
 * The sequencer refuses the duplicate before anything is written: roots, receipts and the audit chain are
 * exactly as they were. The audit event's commitment binds the amounts and the operation type from the
 * moment it is created; the balance check counts claims, nets reversals and flags a split that does not
 * add up; the RPC reconciles the chain with the ledger. The engine's fill job handler no longer answers a
 * new dispense with a finished job's result.
 *
 * The sequencer's read gate answers the duplicate check, whose groups name wallets, and the balance check
 * the plan and the operator only (D1). This suite asked both with no credential, so once they were gated
 * it read the refusal instead of the result (the review of round eight of the security fixes,
 * 2026-10-24); it asks them with the operator's bearer now.
 */
import { Field, MerkleTree, Poseidon } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { ClaimAccumulatorService, DuplicateFillError } from '../src/l2/claim-accumulator-service.js';
import { AuditService } from '../src/audit/audit-service.js';
import type { AuditEvent } from '../src/audit/audit-types.js';
import type { ClaimSubmissionMetadata } from '../src/l2/l2-types.js';
import type { ClaimLeaf, ClaimMetadata } from '../src/l2/claim-accumulator-types.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';

jest.setTimeout(60_000);

const REG_ROOT = [Field(1000), Field(1001), Field(1002), Field(1003), Field(1004)];
const LC_ROOT = Field(2000);
const WALLET_A = Field(100);
const NDC_A = Poseidon.hash([Field(BigInt('00378180510'))]).toString();
const NDC_B = Poseidon.hash([Field(BigInt('00093721510'))]).toString();

function mockProof(walletId: Field, oldRoot: Field, newRoot: Field) {
  return { verify: () => {}, publicOutput: { walletId, oldRegistryRoot: oldRoot, newRegistryRoot: newRoot, oldLifecycleRoot: LC_ROOT, newLifecycleRoot: LC_ROOT }, toJSON: () => ({}) } as any;
}
function claim(overrides: Partial<ClaimSubmissionMetadata> = {}): ClaimSubmissionMetadata {
  return {
    ndcHash: NDC_A, memberWalletId: WALLET_A.toString(), pharmacyWalletId: '5001', prescriberWalletId: '6001', dateOfService: '20261018',
    patientPayCents: '1000', planPayCents: '3700', operationType: '1', ingredientCostCents: 4500, dispensingFeeCents: 200, quantityDispensed: 30, fillNumber: 0,
    ...overrides,
  };
}
function leafOf(m: ClaimSubmissionMetadata): ClaimLeaf {
  return { memberWalletId: m.memberWalletId, ndcHash: m.ndcHash, pharmacyWalletId: m.pharmacyWalletId, prescriberWalletId: m.prescriberWalletId, dateOfService: m.dateOfService, patientPayCents: m.patientPayCents, planPayCents: m.planPayCents, operationType: m.operationType, deductibleCreditCents: '0' };
}
const meta = (fillNumber?: number): ClaimMetadata => ({ receiptId: `r-${Math.random()}`, timestamp: Date.now(), fillNumber });

describe('the ledger', () => {
  test('refuses a second fill with the same key instead of returning the first, and keeps the remainder of a partial fill apart by its fill number', () => {
    const acc = new ClaimAccumulatorService();
    const first = acc.appendClaim(leafOf(claim()), meta(0));
    expect(() => acc.appendClaim(leafOf(claim({ patientPayCents: '999' })), meta(0))).toThrow(DuplicateFillError);
    expect(acc.getLeafCount()).toBe(1n);
    const remainder = acc.appendClaim(leafOf(claim()), meta(1));
    expect(remainder.leafIndex).toBe(first.leafIndex + 1n);
    expect(acc.hasActiveFill(WALLET_A.toString(), NDC_A, '5001', '20261018', 0)?.leafIndex).toBe(first.leafIndex);
    expect(acc.hasActiveFill(WALLET_A.toString(), NDC_A, '5001', '20261018', 2)).toBeUndefined();
    // another drug, another day, another pharmacy: not duplicates
    acc.appendClaim(leafOf(claim({ ndcHash: NDC_B })), meta(0));
    acc.appendClaim(leafOf(claim({ dateOfService: '20261019' })), meta(0));
    acc.appendClaim(leafOf(claim({ pharmacyWalletId: '5002' })), meta(0));
    expect(acc.getLeafCount()).toBe(5n);
  });

  test('a reversal frees its fill\'s key, so the prescription can be filled again after it; totals net the reversal', () => {
    const acc = new ClaimAccumulatorService();
    acc.appendClaim(leafOf(claim()), meta(0));
    acc.appendClaim(leafOf(claim({ operationType: '2' })), meta(0));
    expect(acc.hasActiveFill(WALLET_A.toString(), NDC_A, '5001', '20261018', 0)).toBeUndefined();
    acc.appendClaim(leafOf(claim({ patientPayCents: '1200', planPayCents: '3500' })), meta(0));
    const t = acc.getTotals();
    expect(t.claimCount).toBe(2);
    expect(t.reversalCount).toBe(1);
    expect(t.patientPayCents).toBe(1200n);
    expect(t.planPayCents).toBe(3500n);
  });

  test('a restored checkpoint enforces the same rule', () => {
    const acc = new ClaimAccumulatorService();
    acc.appendClaim(leafOf(claim()), meta(0));
    acc.appendClaim(leafOf(claim()), meta(1));
    const restored = new ClaimAccumulatorService();
    restored.restoreState(acc.exportState());
    expect(restored.getRoot().toString()).toBe(acc.getRoot().toString());
    expect(() => restored.appendClaim(leafOf(claim()), meta(0))).toThrow(DuplicateFillError);
    expect(() => restored.appendClaim(leafOf(claim()), meta(1))).toThrow(DuplicateFillError);
    expect(restored.appendClaim(leafOf(claim()), meta(2)).leafIndex).toBe(2n);
  });
});

describe('the sequencer', () => {
  let seq: L2SequencerService;
  beforeEach(() => {
    seq = new L2SequencerService(new InMemoryStore(), REG_ROOT[0], LC_ROOT, Field(0));
    seq.setTransitionVerifier(createAcceptAllVerifierForTests('tests/money-agrees.test.ts'));
  });

  test('refuses a duplicate claim before anything is written: roots, receipts and the audit chain unchanged', async () => {
    await seq.submitProof(mockProof(WALLET_A, REG_ROOT[0], REG_ROOT[1]), claim());
    const before = { root: seq.getClaimAccumulatorRoot(), receipts: seq.getAllReceipts().length, chain: seq.getAuditLog().latestChainHash, reg: seq.getCurrentRegistryRoot().toString() };
    await expect(seq.submitProof(mockProof(WALLET_A, REG_ROOT[1], REG_ROOT[2]), claim({ patientPayCents: '1500' }))).rejects.toThrow(/Duplicate fill/);
    expect(seq.getClaimAccumulatorRoot()).toBe(before.root);
    expect(seq.getAllReceipts().length).toBe(before.receipts);
    expect(seq.getAuditLog().latestChainHash).toBe(before.chain);
    expect(seq.getCurrentRegistryRoot().toString()).toBe(before.reg);
    // the same transition with the remainder of a partial fill passes
    const receipt = await seq.submitProof(mockProof(WALLET_A, REG_ROOT[1], REG_ROOT[2]), claim({ fillNumber: 1 }));
    expect(receipt.claimLeafIndex).toBe(1n);
  });

  test('writes the money, the operation and the costs into the audit event when it is created, and the commitment binds them', async () => {
    await seq.submitProof(mockProof(WALLET_A, REG_ROOT[0], REG_ROOT[1]), claim());
    await seq.submitProof(mockProof(WALLET_A, REG_ROOT[1], REG_ROOT[2]));  // not a claim
    const [fill, plain] = seq.getAuditLog().events;
    expect(fill.patientPayCents).toBe(1000);
    expect(fill.planPayCents).toBe(3700);
    expect(fill.operationType).toBe(1);
    expect(fill.claimContext?.ingredientCostCents).toBe(4500);
    expect(fill.claimContext?.dispensingFeeCents).toBe(200);
    expect(fill.claimContext?.fillNumber).toBe(0);
    expect(plain.patientPayCents).toBeUndefined();
    expect(plain.operationType).toBeUndefined();
    expect(AuditService.computeEventCommitment(fill).toString()).toBe(fill.eventCommitment);
    expect(AuditService.computeEventCommitment({ ...fill, patientPayCents: 1001 }).toString()).not.toBe(fill.eventCommitment);
    expect(AuditService.computeEventCommitment({ ...fill, operationType: 2 }).toString()).not.toBe(fill.eventCommitment);
    expect(AuditService.verifyReceiptChain(seq.getAuditLog()).isValid).toBe(true);
  });
});

describe('the balance check', () => {
  const event = (over: Partial<AuditEvent>): AuditEvent => ({
    sequenceNumber: 1n, receiptId: 'r', walletId: '100', isRegistration: false, oldRegistryRoot: '1', newRegistryRoot: '2', oldLifecycleRoot: '3', newLifecycleRoot: '3',
    eventCommitment: '0', chainHash: '0', timestamp: 0, l1Status: 'pending', ...over,
  } as AuditEvent);
  const ctx = (ingredientCostCents: number, dispensingFeeCents: number, fillNumber = 0) => ({ pharmacyWalletId: '5001', memberWalletId: '100', prescriberWalletId: '6001', ndcHash: NDC_A, ingredientCostCents, dispensingFeeCents, quantityDispensed: '30', dateOfService: 20261018, fillNumber });

  test('counts fills, nets reversals, ignores transitions that are not claims and flags a split that does not add up', () => {
    const r = AuditService.verifyFinancialBalance([
      event({ receiptId: 'a', patientPayCents: 1000, planPayCents: 3700, operationType: 1, claimContext: ctx(4500, 200) }),
      event({ receiptId: 'b', patientPayCents: 1000, planPayCents: 3700, operationType: 2, claimContext: ctx(4500, 200) }),
      event({ receiptId: 'c', patientPayCents: 500, planPayCents: 500, operationType: 1, claimContext: ctx(900, 200) }),
      event({ receiptId: 'd' }),
    ]);
    expect(r.totalClaims).toBe(2);
    expect(r.reversals).toBe(1);
    expect(r.totalPatientPayCents).toBe(500);
    expect(r.totalPlanPayCents).toBe(500);
    expect(r.isValid).toBe(false);
    expect(r.imbalancedClaims).toEqual(['c']);
  });

  test('duplicate detection looks at fills only and tells a partial fill\'s remainder apart', () => {
    const r = AuditService.detectDuplicateClaims([
      event({ receiptId: 'a', operationType: 1, claimContext: ctx(1, 1, 0) }),
      event({ receiptId: 'b', operationType: 2, claimContext: ctx(1, 1, 0) }),
      event({ receiptId: 'c', operationType: 1, claimContext: ctx(1, 1, 1) }),
    ]);
    expect(r.hasDuplicates).toBe(false);
    const dup = AuditService.detectDuplicateClaims([
      event({ receiptId: 'a', operationType: 1, claimContext: ctx(1, 1, 0) }),
      event({ receiptId: 'b', operationType: 1, claimContext: ctx(1, 1, 0) }),
    ]);
    expect(dup.hasDuplicates).toBe(true);
  });
});

describe('the RPC and the engine\'s fill job', () => {
  const OPERATOR = 'operator-token-for-tests';
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  let node: L2Node;
  let server: L2RpcServer;
  let url: string;
  let release: (() => void) | null = null;
  let dispenses = 0;
  const service = {
    getState() { return { compiled: true, enrolledMembers: [] }; },
    isProvingReady() { return true; }, // a proving route refuses with 503 while the engine's provers start
    getL2Node() { return { withProvingLock: (fn: () => Promise<unknown>) => fn() }; },
    async forceBatch() {},
    dispensePrescription(opts: { prescriptionId: string }) {
      dispenses++;
      return new Promise((resolve, reject) => { release = () => (dispenses === 1 ? reject(new Error('Quantity dispensed (31) exceeds remaining prescribed qty')) : resolve({ prescriptionId: opts.prescriptionId, adjudication: { patientPayCents: 1000 } })); });
    },
  };
  const standIn = new Proxy(service, { get(t, p) { if (p in t) return (t as any)[p]; return typeof p === 'string' && p !== 'then' ? () => undefined : undefined; } });
  const bearer = { Authorization: `Bearer ${OPERATOR}` };
  const rpc = async (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()) as { result?: any; error?: { message: string } };
  };
  const fill = (prescriptionId: string) => fetch(`${url}/interactive/fill`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer }, body: JSON.stringify({ prescriptionId }) });
  const status = async (prescriptionId: string) => (await (await fetch(`${url}/interactive/fill-status?prescriptionId=${prescriptionId}`, { headers: bearer })).json()) as any;
  const until = async (pred: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await pred()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('condition not met'); };

  beforeAll(async () => {
    node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-money' }, new InMemoryStore(), REG_ROOT[0], LC_ROOT, Field(0));
    node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/money-agrees.test.ts'));
    server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    registerInteractiveRoutes(server, standIn as any);
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;
  });
  afterAll(async () => { await server.stop(); });

  test('l2_verifyFinancialBalance reconciles the audit chain with the ledger and reports the netted money', async () => {
    const seq = node.getSequencer();
    await seq.submitProof(mockProof(WALLET_A, REG_ROOT[0], REG_ROOT[1]), claim());
    await seq.submitProof(mockProof(WALLET_A, REG_ROOT[1], REG_ROOT[2]), claim({ ndcHash: NDC_B, patientPayCents: '2000', planPayCents: '2700' }));
    await seq.submitProof(mockProof(WALLET_A, REG_ROOT[2], REG_ROOT[3]), claim({ ndcHash: NDC_B, patientPayCents: '2000', planPayCents: '2700', operationType: '2' }));
    const r = (await rpc('l2_verifyFinancialBalance', {}, bearer)).result;
    expect(r.totalClaims).toBe(2);
    expect(r.reversals).toBe(1);
    expect(r.totalPatientPayCents).toBe(1000);
    expect(r.totalPlanPayCents).toBe(3700);
    expect(r.ledger).toEqual({ claimCount: 2, reversalCount: 1, patientPayCents: '1000', planPayCents: '3700' });
    expect(r.reconciled).toBe(true);
    expect(r.balanced).toBe(true);
    expect(r.valid).toBe(true);
    expect((await rpc('l2_detectDuplicateClaims', {}, bearer)).result?.hasDuplicates).toBe(false);
  });

  test('a fill request after a failed attempt starts a new job instead of being answered with the old error; a running job is shared', async () => {
    const r1 = await fill('RX-1');
    expect(r1.status).toBe(202);
    await until(async () => release !== null);
    const again = await fill('RX-1');              // the same dispense, still running: shared, not duplicated
    expect(again.status).toBe(202);
    expect(dispenses).toBe(1);
    release!(); release = null;
    await until(async () => (await status('RX-1')).status === 'error');
    const r2 = await fill('RX-1');                 // the retry after the rejected attempt
    expect(r2.status).toBe(202);
    await until(async () => release !== null);
    expect(dispenses).toBe(2);
    release!(); release = null;
    await until(async () => (await status('RX-1')).status === 'complete');
    expect((await status('RX-1')).result?.adjudication?.patientPayCents).toBe(1000);
  });
});
