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
 * Prescribing and dispensing ask the ledger whether a member can be billed.
 *
 * What was wrong: createPrescription and dispensePrescription checked only the engine's own copy of the member's
 * lifecycle (enrolled.lifecycle) and never the sequencer's lifecycle tree. The two can drift (a termination that
 * stopped half-way, a restore from an older engine checkpoint, a batch rollback), so a member the ledger shows
 * revoked while the engine copy still says ELIGIBLE got past both checks. Now the ledger must show the wallet
 * eligible or active, a ledger revocation brings the engine copy into step, and an engine copy that says terminated
 * still refuses. A copy brought into step has no termination date, so the operator can still run the termination.
 *
 * A real L2Node sequencer and a real AdjudicationService, programs not compiled, nothing proved. The formulary is cut
 * to 100 drugs before anything loads src/data, or the engine constructor would hash the full formulary.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(180_000);

let svc: any;
let seq: any;
let LC: any;
let CredentialData: any;
let ndcHash: string;
let next = 88_000_001n;

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  ({ CredentialData } = await import('../src/credentials/credential-data.js'));
  LC = await import('../src/engine/lifecycle.js');
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-ledger-gate' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  svc = new AdjudicationService(() => {}, () => {}, node) as any;
  svc.compiled = true;
  seq = node.getSequencer();
  ndcHash = svc.medByNdcHash.keys().next().value;
});

/**
 * A member in the engine with the given engine copy of its lifecycle, provisioned on the ledger at `ledgerState`
 * (or not at all). memberIndex -1 is a member with a device; it is in network for prescriber 0 and pharmacy 0.
 */
function member(copy: 'ELIGIBLE' | 'REVOKED', ledgerState: Field | undefined, memberIndex = -1) {
  const wid = Field(next++);
  if (ledgerState) seq.adminMutate('test', ({ provision }: any) => { provision(wid, ledgerState); });
  const m: any = {
    memberIndex, walletId: wid, walletIdStr: wid.toString(), displayName: `Member ${wid.toString()}`, lifecycle: copy,
    credentialData: new CredentialData({ credentialType: Field(1), forestRoot: Field(0), issuerWalletId: Field(0), subjectWalletId: wid, issuedAt: Field(0), expiresAt: Field(0), revoked: Field(0) }),
    inNetworkPrescriberIndices: [0], inNetworkPharmacyIndices: [0],
  };
  svc.enrolledMembers.set(m.walletIdStr, m);
  return m;
}

/** The ledger revokes the wallet; the engine copy is not told. */
function revokeOnLedgerOnly(m: { walletId: Field }) {
  seq.adminMutate('test', ({ setLifecycle }: any) => { setLifecycle(m.walletId, LC.LIFECYCLE_REVOKED); });
}

const prescribe = (m: { walletIdStr: string }) =>
  svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: m.walletIdStr, ndcHash, quantity: 30, refills: 0 });

describe('the ledger lifecycle gate', () => {
  test('prescribe refuses a member the ledger shows revoked while the engine copy says eligible, and brings the copy into step', async () => {
    const m = member('ELIGIBLE', LC.LIFECYCLE_ELIGIBLE);
    revokeOnLedgerOnly(m);
    expect(seq.lifecycleStateOf(m.walletIdStr)?.name).toBe('revoked');
    await expect(prescribe(m)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/terminated; no prescription can be written/) });
    expect(m.lifecycle).toBe('REVOKED');
  });

  test('dispense refuses it before any other check', async () => {
    const m = member('ELIGIBLE', LC.LIFECYCLE_REVOKED, 0);
    svc.prescriptions.set('RX-LEDGER-1', { memberWalletId: m.walletIdStr, ndcHash, pharmacyIndex: 0, prescriberIndex: 0, quantity: 30, quantityDispensed: 0, status: 'FILLED', statusHistory: [] });
    // 31 of 30 would be refused by the quantity check, so nothing could prove even if this gate were missing
    await expect(svc.dispensePrescription({ prescriptionId: 'RX-LEDGER-1', quantityDispensed: 31 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/terminated; the prescription cannot be dispensed/) });
    expect(m.lifecycle).toBe('REVOKED');
  });

  test('a member the ledger shows only registered, or does not hold, is refused', async () => {
    for (const m of [member('ELIGIBLE', LC.LIFECYCLE_REGISTERED), member('ELIGIBLE', undefined)]) {
      await expect(prescribe(m)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/ledger does not show this member eligible/) });
      expect(m.lifecycle).toBe('ELIGIBLE');
    }
  });

  test('an eligible member gets past the ledger check, and an engine copy that says terminated still refuses', async () => {
    // past the gate, a member with a device and no PCP or authorization is refused at the consent check
    await expect(prescribe(member('ELIGIBLE', LC.LIFECYCLE_ELIGIBLE))).rejects.toMatchObject({ status: 403 });
    await expect(prescribe(member('REVOKED', LC.LIFECYCLE_ELIGIBLE))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/terminated/) });
  });

  test('a copy brought into step can still be terminated', async () => {
    const m = member('ELIGIBLE', LC.LIFECYCLE_ELIGIBLE);
    svc.prescriptions.set('RX-LEDGER-OPEN', { memberWalletId: m.walletIdStr, ndcHash, pharmacyIndex: 0, prescriberIndex: 0, quantity: 30, quantityDispensed: 0, status: 'ADJUDICATED', statusHistory: [] });
    revokeOnLedgerOnly(m);
    await expect(prescribe(m)).rejects.toMatchObject({ status: 409 });
    expect(m.lifecycle).toBe('REVOKED');
    const r = svc.terminateMember({ memberWalletId: m.walletIdStr, terminationDate: '20261019' });
    expect(r.cancelledPrescriptions).toEqual(['RX-LEDGER-OPEN']);
    expect(m.terminationDate).toBe('20261019');
    expect(() => svc.terminateMember({ memberWalletId: m.walletIdStr })).toThrow(/already terminated/);
  });
});
