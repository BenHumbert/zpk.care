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
 * A wallet update the member's device proves — plan item B1 step two, with B2.
 *
 * The engine is the authority on what a member's credential says (eligibility, the accumulator,
 * a primary-care link, a prior authorization) and it keeps the only working copy. What it may not
 * hold is the member's identity preimage, and without that it cannot prove a wallet update. So it
 * hands the device the credential as it should now be — the fields and the forest leaves, which
 * are commitments, not identity — and the root they yield. The device rebuilds the root from
 * exactly those parts, refuses anything that does not add up, and proves the update with the
 * preimage only it holds. Both sides use the same two functions here, so there is one derivation.
 *
 * Nothing in a payload identifies a person: wallet ids, Poseidon commitments and plan figures.
 */
import { Field } from 'o1js';
import { MerkleForest, ForestDomain, TREE_HEIGHT } from '../zkp/merkle-forest.js';
import { CredentialData } from './credential-data.js';
import { CredentialInventory } from './credential-inventory.js';

/** The credential's fields other than the forest root, which the leaves yield. Decimal strings. */
export interface CredentialFields {
  credentialType: string;
  issuerWalletId: string;
  subjectWalletId: string;
  issuedAt: string;
  expiresAt: string;
  revoked: string;
}

/** One non-empty leaf of the member's forest: which domain tree, which slot, which commitment. */
export interface ForestLeaf {
  domain: number;
  index: string;
  leaf: string;
}

export interface WalletUpdatePayload {
  updateId: string;
  walletId: string;
  /** Why the credential changed: 'credential mint', 'fill', 'prior-auth', 'reversal', 'formulary', 'network', 'rollover', 'pcp'. */
  reason: string;
  /** The inventory root this update starts from: the previous update's result, or the ledger's root. */
  oldInventoryRoot: string;
  /** The inventory root the device must reach, and must be able to rebuild from the parts below. */
  newInventoryRoot: string;
  credential: CredentialFields;
  forestLeaves: ForestLeaf[];
  /** The inventory slot the credential occupies; a member's eligibility credential is slot 0. */
  inventorySlot: string;
  /** True when the engine committed a claim on the sequencer for this root; it lands with the proof. */
  claimCommitted: boolean;
  createdAt: number;
}

/** Leaves per domain tree: a tree of height h holds 2^(h-1) leaves. */
export const FOREST_LEAVES_PER_DOMAIN = 2 ** (TREE_HEIGHT - 1);

const DOMAINS: ForestDomain[] = Object.values(ForestDomain).filter((v): v is ForestDomain => typeof v === 'number');

/** Every non-empty leaf of a forest, by domain then index. */
export function forestLeavesOf(forest: MerkleForest): ForestLeaf[] {
  const leaves: ForestLeaf[] = [];
  const zero = Field(0);
  for (const domain of DOMAINS) {
    for (let index = 0n; index < BigInt(FOREST_LEAVES_PER_DOMAIN); index++) {
      const leaf = forest.getLeaf(domain, index);
      if (leaf.equals(zero).toBoolean()) continue;
      leaves.push({ domain, index: index.toString(), leaf: leaf.toString() });
    }
  }
  return leaves;
}

/** The fields of a credential other than its forest root. */
export function credentialFieldsOf(credential: CredentialData): CredentialFields {
  return {
    credentialType: credential.credentialType.toString(),
    issuerWalletId: credential.issuerWalletId.toString(),
    subjectWalletId: credential.subjectWalletId.toString(),
    issuedAt: credential.issuedAt.toString(),
    expiresAt: credential.expiresAt.toString(),
    revoked: credential.revoked.toString(),
  };
}

/**
 * Rebuild the forest from its leaves, the credential from its fields and that root, and the
 * inventory from that credential in its slot; return the three roots. The device compares the
 * last one to what the engine named. Throws on a payload that is not well formed.
 */
export function rederiveInventoryRoot(payload: Pick<WalletUpdatePayload, 'credential' | 'forestLeaves' | 'inventorySlot'>): {
  forestRoot: string;
  credentialCommitment: string;
  inventoryRoot: string;
} {
  if (payload.inventorySlot !== '0') {
    throw new Error(`wallet update: inventory slot ${payload.inventorySlot} is not the member's eligibility slot`);
  }
  const forest = new MerkleForest();
  for (const entry of payload.forestLeaves) {
    if (!DOMAINS.includes(entry.domain as ForestDomain)) throw new Error(`wallet update: unknown forest domain ${entry.domain}`);
    const index = BigInt(entry.index);
    if (index < 0n || index >= BigInt(FOREST_LEAVES_PER_DOMAIN)) throw new Error(`wallet update: leaf index ${entry.index} is outside the tree`);
    forest.setLeaf(entry.domain as ForestDomain, index, Field(BigInt(entry.leaf)));
  }
  const forestRoot = forest.getForestRoot();
  const c = payload.credential;
  const credential = new CredentialData({
    credentialType: Field(BigInt(c.credentialType)),
    forestRoot,
    issuerWalletId: Field(BigInt(c.issuerWalletId)),
    subjectWalletId: Field(BigInt(c.subjectWalletId)),
    issuedAt: Field(BigInt(c.issuedAt)),
    expiresAt: Field(BigInt(c.expiresAt)),
    revoked: Field(BigInt(c.revoked)),
  });
  const inventory = new CredentialInventory();
  const minted = inventory.mint(credential);
  if (minted.index !== 0n) throw new Error(`wallet update: the credential landed in slot ${minted.index}, not 0`);
  return {
    forestRoot: forestRoot.toString(),
    credentialCommitment: credential.commitment().toString(),
    inventoryRoot: inventory.getRoot().toString(),
  };
}

/** True when the parts the engine sent yield the root it named. */
export function walletUpdateAddsUp(payload: WalletUpdatePayload): boolean {
  try {
    return rederiveInventoryRoot(payload).inventoryRoot === payload.newInventoryRoot;
  } catch {
    return false;
  }
}
