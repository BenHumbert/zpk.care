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
 * A prescription ID names one prescription for good.
 *
 * What was wrong: createPrescription took the caller's rxId as the record key and stored it with no check, so a
 * second POST /interactive/prescribe with the same rxId replaced the prescription (member, drug, status, quantity
 * dispensed and refills used all reset) while its fills stayed under the same key. The engine's own counter could
 * also land on an ID a caller had chosen earlier ("RX-0007") and overwrite it. Now a malformed rxId is 400, one
 * already written or still being proved is 409 before any proof, and an engine-made ID skips taken IDs.
 *
 * Fast: no compile, no proof. The engine is the real prototype over a bare object, so the refusal is the real code.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';
import { AdjudicationService, RegistrationRefused } from '../src/adjudication/interactive-service.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();

/** A prescription already written and dispensed once, with a refill used. */
const written = () => ({ id: 'RX-A', memberWalletId: '1', quantity: 30, quantityDispensed: 30, refills: 2, refillsUsed: 1, status: 'DISPENSED' });

/** The real engine code over a bare object: one written prescription, one still being proved, nothing else. */
function bareEngine(): any {
  const e = Object.create(AdjudicationService.prototype);
  e.compiled = true;
  e.prescriptions = new Map<string, unknown>([['RX-A', written()]]);
  e.pendingPrescriptions = new Map<string, unknown>([['RX-P', { id: 'RX-P' }]]);
  return e;
}

const req = (rxId?: unknown) => ({ prescriberIndex: 0, memberWalletId: '1', ndcHash: '1', pharmacyIndex: 0, quantity: 30, refills: 0, rxId });

describe('createPrescription and a caller\'s rxId', () => {
  test('refuses an ID already written and leaves the record as it was', async () => {
    const e = bareEngine();
    await expect(e.createPrescription(req('RX-A'))).rejects.toMatchObject({ name: 'RegistrationRefused', status: 409 });
    expect(e.prescriptions.get('RX-A')).toEqual(written());
    expect(e.prescriptions.size).toBe(1);
  });

  test('refuses an ID still being proved', async () => {
    const e = bareEngine();
    await expect(e.createPrescription(req('RX-P'))).rejects.toMatchObject({ status: 409 });
    expect(e.pendingPrescriptions.has('RX-P')).toBe(true);
  });

  test('refuses a malformed ID with 400', async () => {
    for (const bad of [{}, 42, 'RX A', 'RX/../1', 'x'.repeat(65)]) {
      await expect(bareEngine().createPrescription(req(bad))).rejects.toMatchObject({ status: 400 });
    }
  });

  test('a fresh ID or no ID passes the gate', async () => {
    // These still fail further on, on the missing infrastructure of the bare engine; what matters is that the
    // ID gate does not refuse them. The two shapes are the harness's and the prescriber node's.
    for (const id of [undefined, '', 'RX-MZ4K2Q1-1', 'RX-1760800000000-ab3f']) {
      const err = await bareEngine().createPrescription(req(id)).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RegistrationRefused);
    }
  });

  test('an engine-made ID skips an ID a caller chose', async () => {
    const e = bareEngine();
    e.prescriptions.set('RX-0007', { ...written(), id: 'RX-0007' });
    e.rxCounter = 6;
    const seen: string[] = [];
    class SeenMap extends Map<string, unknown> {
      set(key: string, value: unknown): this { seen.push(key); return super.set(key, value); }
    }
    e.pendingPrescriptions = new SeenMap();
    e.medByNdcHash = new Map([['1', { brandName: 'X', deaSchedule: 0, formularyEntry: { requiresPriorAuth: false, stepTherapyRequired: false } }]]);
    // a fixture member (memberIndex >= 0), eligible on the ledger, so it reaches the pending entry
    e.enrolledMembers = new Map([['1', { memberIndex: 0, walletId: Field(1), lifecycle: 'ELIGIBLE', displayName: 'Fixture' }]]);
    e.l2Node = { getSequencer: () => ({ lifecycleStateOf: () => ({ state: 2, name: 'eligible' }) }) };
    e.prescriberWalletIds = new Map([[0, Field(1)]]);
    e.prescriberPreimages = new Map([[0, [Field(0), Field(0), Field(0)]]]);
    e.pharmacyWalletIds = new Map([[0, Field(2)]]);
    e.emit = e.emitViz = () => {};
    e.checkStepTherapy = () => ({ allowed: true, message: '' });
    e.checkDeaSchedule = () => ({ allowed: true, warnings: [] });
    // Plan-bound formularies: the drug's entry in the member's formulary (the bare engine has no formulary registry)
    e.formularyEntryFor = () => ({ registry: {}, leafIndex: 0n, entry: { requiresPriorAuth: Field(0), stepTherapyRequired: Field(0) }, copayAmountCents: 1000 });
    e.dispatchProof = async () => { throw new Error('stop after the pending entry'); };

    await expect(e.createPrescription(req())).rejects.toThrow('stop after the pending entry');
    expect(seen).toEqual(['RX-0008']);
    expect(e.prescriptions.get('RX-0007').quantityDispensed).toBe(30);
    expect(e.pendingPrescriptions.has('RX-0008')).toBe(false); // a failed proof frees its ID again
  });
});

describe('POST /interactive/prescribe', () => {
  let server: L2RpcServer;
  let url: string;
  let engine: any;

  beforeAll(async () => {
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-rx-id-reuse' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    engine = bareEngine();
    engine.l2Node = { withProvingLock: (fn: () => Promise<unknown>) => fn() };
    engine.forceBatch = async () => {};
    registerInteractiveRoutes(server, engine as any);
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;
  });

  afterAll(async () => { await server.stop(); });

  test('answers a reused ID with 409', async () => {
    const r = await fetch(`${url}/interactive/prescribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` },
      body: JSON.stringify(req('RX-A')),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/already exists/);
    expect(engine.prescriptions.get('RX-A')).toEqual(written());
  });
});
