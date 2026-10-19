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
 * Every party's messaging key sits at its own wallet-registry slot.
 *
 * What was wrong: the engine stored seed messaging keys by a hand-made index, prescriber i at slot i and pharmacy i
 * at slot 10+i. The seed has 16 prescribers and 15 pharmacies, so pharmacies 0-5 overwrote prescribers 10-15 in
 * encryptionKeys and in the KeyRegistry leaves: prescribers 10-15 had no key leaf, and their messages were sealed
 * with pharmacy 0-5's private key. Now each seed provider keys at its wallet-registry index, the slot members already
 * use. The review added the member side: a member's key slot is its live registry index, never the walletIndex saved
 * in a checkpoint, which after a restore can name a provider's slot.
 *
 * A real engine on a real L2Node, programs not compiled, nothing proved. The formulary is cut to 100 drugs before
 * anything loads src/data, or the engine constructor would hash the full formulary.
 */
import * as fs from 'fs';
import { Field, MerkleTree, Poseidon } from 'o1js';
import { deriveEncryptionKeyPair, deriveSharedSecret, decryptMessage, publicKeyToFields } from '../src/messaging/encryption.js';
import { LIFECYCLE_ELIGIBLE } from '../src/engine/lifecycle.js';

jest.setTimeout(180_000);

let svc: any;
let node: any;
let PRESCRIBERS: any[];
let PHARMACIES: any[];

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  ({ PRESCRIBERS, PHARMACIES } = await import('../src/data/index.js'));
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const empty = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-key-slots' }, new InMemoryStore(), empty, empty, Field(0));
  svc = new AdjudicationService(() => {}, () => {}, node);
});

const registry = () => node.getSequencer().getStateTrees().registry;

describe('the engine\'s messaging keys', () => {
  test('the seed has more than ten prescribers', () => {
    expect(PRESCRIBERS.length).toBe(12);
    expect(PHARMACIES.length).toBe(8);
  });

  test('every seed prescriber and pharmacy has its own key at its own wallet-registry slot', () => {
    const reg = registry();
    const parties: Array<[Field, string]> = [
      ...PRESCRIBERS.map((p, i) => [svc.prescriberWalletIds.get(i), p.enrollmentKey] as [Field, string]),
      ...PHARMACIES.map((p, i) => [svc.pharmacyWalletIds.get(i), p.enrollmentKey] as [Field, string]),
    ];
    for (const [wid, ek] of parties) {
      const kp = deriveEncryptionKeyPair(ek);
      const slot: bigint = reg.getIndex(wid);
      const { pubKeyX, pubKeyY } = publicKeyToFields(kp.publicKey);
      expect(svc.keyRegistry.getKeyCommitment(slot).toString()).toBe(Poseidon.hash([wid, pubKeyX, pubKeyY]).toString());
      expect(svc.encryptionKeys.get(Number(slot)).publicKey.equals(kp.publicKey)).toBe(true);
    }
    expect(svc.keyRegistry.count).toBe(20);
  });

  test('a message from prescriber 10 to pharmacy 1 is sealed with their keys, not pharmacy 0\'s', () => {
    const sender: Field = svc.prescriberWalletIds.get(10);
    const recipient: Field = svc.pharmacyWalletIds.get(1);
    const idx: bigint = svc.sendInternalMessage(sender, recipient, Field(1), 'eScript', 'Rx test');
    const pl = svc.encryptedPayloads.get(idx.toString());
    expect(pl.ciphertext).not.toBe('');
    const [ct, iv, tag] = [pl.ciphertext, pl.iv, pl.tag].map((h: string) => Buffer.from(h, 'hex'));
    const rx10 = deriveEncryptionKeyPair(PRESCRIBERS[10].enrollmentKey);
    const ph0 = deriveEncryptionKeyPair(PHARMACIES[0].enrollmentKey);
    const ph1 = deriveEncryptionKeyPair(PHARMACIES[1].enrollmentKey);
    // the sender's own key opens it, and so does the recipient's
    expect(decryptMessage(ct, iv, tag, deriveSharedSecret(rx10.privateKey, ph1.publicKey))).toBe('Subject: eScript\n\nRx test');
    expect(decryptMessage(ct, iv, tag, deriveSharedSecret(ph1.privateKey, rx10.publicKey))).toBe('Subject: eScript\n\nRx test');
    // pharmacy 0, whose key used to sit in prescriber 10's slot, cannot
    expect(() => decryptMessage(ct, iv, tag, deriveSharedSecret(ph0.privateKey, ph1.publicKey))).toThrow();
    // the engine's own round trip, for the sender and the recipient
    expect(svc.decryptMessageByIndex(Number(idx), sender.toString())?.body).toBe('Rx test');
    expect(svc.decryptMessageByIndex(Number(idx), recipient.toString())?.body).toBe('Rx test');
  });

  test('no slot is computed as 10 plus a seed index any more', () => {
    const src = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8');
    expect(src).not.toMatch(/10 \+ (i|idx|index|opts\.pharmacyIndex)\b/);
  });

  test('a member whose saved walletIndex names a pharmacy\'s slot keys at its own live registry index', () => {
    const reg = registry();
    const pharmacySlot = Number(reg.getIndex(svc.pharmacyWalletIds.get(0)));
    const wid = Field(77_000_001n);
    node.getSequencer().adminMutate('test: provision a member', ({ provision }: any) => { provision(wid, LIFECYCLE_ELIGIBLE); });
    const live = Number(reg.getIndex(wid));
    expect(live).not.toBe(pharmacySlot);
    // as a checkpoint restore leaves it: the member's saved index is now a provider's live slot
    svc.enrolledMembers.set(wid.toString(), { walletId: wid, walletIdStr: wid.toString(), walletIndex: pharmacySlot, lifecycle: 'ELIGIBLE', displayName: 'R' });
    try {
      expect(svc.findKeyIndexForWallet(wid)).toBe(live);
      expect(svc.resolveWalletId('member', undefined, wid.toString()).keyIndex).toBe(live);
      // a system message to the member is not sealed to pharmacy 0's key
      const idx: bigint = svc.sendInternalMessage(svc.adminWalletId, wid, Field(1), 'Notice', 'for R only');
      expect(svc.encryptedPayloads.get(idx.toString()).recipientKeyIndex).toBe(live);
    } finally {
      svc.enrolledMembers.delete(wid.toString());
    }
  });

  test("the insurer's key sits at the reserved slot outside the registry range, so no enrolled wallet can overwrite it", () => {
    const reserved = (svc.constructor as any).ADMIN_KEY_INDEX;
    expect(reserved).toBe(-2);
    expect(svc.findKeyIndexForWallet(svc.adminWalletId.toString())).toBe(reserved);
    expect(svc.encryptionKeys.get(reserved)).toBeDefined();
    expect(svc.encryptionKeys.has(999)).toBe(false);
  });
});
