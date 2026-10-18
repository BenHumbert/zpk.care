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
 * The device proves its own portable credential — plan item B1 step two, finding A-17.
 *
 * Real proofs: the member node compiles its programs, proves it owns a wallet, rebuilds the
 * credential from the parts the engine would have handed it, proves it holds that credential, and
 * the result verifies offline the way a pharmacy would verify it. A credential for another wallet
 * cannot be proved with this wallet's ownership proof; a tampered credential does not verify. And
 * the engine's source mints none for a member with a device.
 */
import fs from 'fs';
import { Field, Poseidon } from 'o1js';
import { MemberNode } from '../src/nodes/member-node.js';
import { DOMAIN_TAG_MEMBER } from '../src/wallets/wallet-derivation.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';
import { ACCUMULATOR_LEAF_INDEX } from '../src/access-control/accumulator-data.js';
import { forestLeavesOf, credentialFieldsOf, rebuildCredential, rederiveInventoryRoot } from '../src/credentials/wallet-update.js';
import { verifyCredentialOffline } from '../src/credentials/portable-credential.js';

jest.setTimeout(600_000);

const fields = [11n, 12n, 13n, 14n, 15n, 16n].map((n) => Field(n));
const walletId = Poseidon.hash([DOMAIN_TAG_MEMBER, ...fields]);

function partsFor(subject: Field) {
  const forest = new MerkleForest();
  forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, Field(4001n));
  forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, Field(4002n));
  const credential = new CredentialData({
    credentialType: CREDENTIAL_TYPE_ELIGIBILITY, forestRoot: forest.getForestRoot(), issuerWalletId: Field(9n),
    subjectWalletId: subject, issuedAt: Field(20260201n), expiresAt: Field(0), revoked: Field(0),
  });
  const inventory = new CredentialInventory();
  inventory.mint(credential);
  return { credential: credentialFieldsOf(credential), forestLeaves: forestLeavesOf(forest), inventorySlot: '0', inventoryRoot: inventory.getRoot().toString() };
}

let node: MemberNode;
let ownershipProofJson: string;

beforeAll(async () => {
  node = new MemberNode({ role: 'member', walletId: walletId.toString(), sequencerUrl: 'http://127.0.0.1:1', displayName: 'device under test' });
  const compiled = await node.compilePrograms();
  expect(compiled.map((c) => c.program)).toEqual(['StateTransitionProgram', 'ProofGateProgram', 'CredentialProgram']);
  ownershipProofJson = await node.proveOwnership(walletId, fields);
});

describe('the device\'s portable credential', () => {
  test('is proved from the parts, names the wallet, and verifies offline; a tampered one does not', async () => {
    const parts = partsFor(walletId);
    const rebuilt = rebuildCredential(parts);
    expect(rebuilt.inventory.getRoot().toString()).toBe(parts.inventoryRoot);
    expect(rederiveInventoryRoot(parts).inventoryRoot).toBe(parts.inventoryRoot);
    const credential = await node.proveCredentialHolding(ownershipProofJson, rebuilt.credential, rebuilt.inventory);
    expect(credential.proofType).toBe('credential-type-holding');
    expect(credential.publicOutput.walletId).toBe(walletId.toString());
    expect(credential.publicOutput.credentialCommitment).toBe(rebuilt.credential.commitment().toString());
    expect(credential.publicOutput.newInventoryRoot).toBe(parts.inventoryRoot);
    expect(credential.expiresAt).toBe(0);
    expect(await verifyCredentialOffline(credential, '')).toBe(true);
    const tampered = JSON.parse(JSON.stringify(credential));
    const pj = tampered.proofJson;
    if (Array.isArray(pj.publicOutput) && pj.publicOutput.length) pj.publicOutput[0] = (BigInt(pj.publicOutput[0]) + 1n).toString();
    expect(await verifyCredentialOffline(tampered, '').catch(() => false)).toBe(false);
  });

  test('cannot be proved for a credential whose subject is another wallet', async () => {
    const other = partsFor(Field(777n));
    const rebuilt = rebuildCredential(other);
    await expect(node.proveCredentialHolding(ownershipProofJson, rebuilt.credential, rebuilt.inventory)).rejects.toThrow();
  });

  test('the engine mints none for a member with a device', () => {
    const src = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8');
    const fn = src.slice(src.indexOf('async generateCredential('), src.indexOf('async verifyCredential('));
    expect(fn).toMatch(/enrolled\.memberIndex < 0/);
    expect(fn).toMatch(/generates its own portable credential/);
  });
});
