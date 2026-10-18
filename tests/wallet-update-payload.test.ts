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
 * The wallet update the device proves — plan item B1 step two.
 *
 * The engine hands the device a credential as it should now be (fields, forest leaves) and the
 * root they yield; the device must be able to rebuild that root from exactly those parts, and
 * must notice when they do not add up. One derivation, used by both sides, tested against the
 * engine's own objects.
 */
import { Field } from 'o1js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';
import { ACCUMULATOR_LEAF_INDEX } from '../src/access-control/accumulator-data.js';
import { PCP_ASSIGNMENT_LEAF_INDEX } from '../src/eligibility/pcp-assignment-data.js';
import { forestLeavesOf, credentialFieldsOf, rederiveInventoryRoot, walletUpdateAddsUp, FOREST_LEAVES_PER_DOMAIN, type WalletUpdatePayload } from '../src/credentials/wallet-update.js';

function engineSide() {
  const forest = new MerkleForest();
  forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, Field(1111n));
  forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, Field(2222n));
  forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, Field(3333n));
  const credential = new CredentialData({
    credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
    forestRoot: forest.getForestRoot(),
    issuerWalletId: Field(77n),
    subjectWalletId: Field(1001n),
    issuedAt: Field(20260201n),
    expiresAt: Field(0),
    revoked: Field(0),
  });
  const inventory = new CredentialInventory();
  inventory.mint(credential);
  const payload: WalletUpdatePayload = {
    updateId: 'wu-test', walletId: '1001', reason: 'fill',
    oldInventoryRoot: '0', newInventoryRoot: inventory.getRoot().toString(),
    credential: credentialFieldsOf(credential), forestLeaves: forestLeavesOf(forest), inventorySlot: '0',
    claimCommitted: true, createdAt: 1,
  };
  return { forest, credential, inventory, payload };
}

describe('forestLeavesOf', () => {
  test('lists exactly the non-empty leaves, by domain then index', () => {
    const { forest } = engineSide();
    const leaves = forestLeavesOf(forest);
    expect(leaves).toEqual([
      { domain: ForestDomain.MEMBER, index: PCP_ASSIGNMENT_LEAF_INDEX.toString(), leaf: '3333' },
      { domain: ForestDomain.ACCESS_CONTROL, index: '0', leaf: '1111' },
      { domain: ForestDomain.ACCESS_CONTROL, index: ACCUMULATOR_LEAF_INDEX.toString(), leaf: '2222' },
    ]);
    expect(FOREST_LEAVES_PER_DOMAIN).toBe(128);
    expect(forestLeavesOf(new MerkleForest())).toEqual([]);
  });
});

describe('rederiveInventoryRoot', () => {
  test('rebuilds the engine\'s forest root, credential commitment and inventory root from the parts', () => {
    const { forest, credential, inventory, payload } = engineSide();
    const derived = rederiveInventoryRoot(payload);
    expect(derived.forestRoot).toBe(forest.getForestRoot().toString());
    expect(derived.credentialCommitment).toBe(credential.commitment().toString());
    expect(derived.inventoryRoot).toBe(inventory.getRoot().toString());
    expect(walletUpdateAddsUp(payload)).toBe(true);
  });

  test('a changed leaf, a changed field, a missing leaf or a named root that is not theirs do not add up', () => {
    const { payload } = engineSide();
    const tamperedLeaf = { ...payload, forestLeaves: payload.forestLeaves.map((l, i) => (i === 1 ? { ...l, leaf: '9999' } : l)) };
    expect(walletUpdateAddsUp(tamperedLeaf)).toBe(false);
    const tamperedField = { ...payload, credential: { ...payload.credential, expiresAt: '1' } };
    expect(walletUpdateAddsUp(tamperedField)).toBe(false);
    const missingLeaf = { ...payload, forestLeaves: payload.forestLeaves.slice(1) };
    expect(walletUpdateAddsUp(missingLeaf)).toBe(false);
    const wrongRoot = { ...payload, newInventoryRoot: '123' };
    expect(walletUpdateAddsUp(wrongRoot)).toBe(false);
  });

  test('refuses a payload that is not well formed instead of guessing', () => {
    const { payload } = engineSide();
    expect(() => rederiveInventoryRoot({ ...payload, inventorySlot: '1' })).toThrow(/slot 1/);
    expect(() => rederiveInventoryRoot({ ...payload, forestLeaves: [{ domain: 9, index: '0', leaf: '1' }] })).toThrow(/unknown forest domain/);
    expect(() => rederiveInventoryRoot({ ...payload, forestLeaves: [{ domain: 0, index: '128', leaf: '1' }] })).toThrow(/outside the tree/);
    expect(walletUpdateAddsUp({ ...payload, inventorySlot: '1' })).toBe(false);
  });
});
