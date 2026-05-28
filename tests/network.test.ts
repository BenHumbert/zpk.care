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

import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  ProviderNetworkRegistry,
  NetworkMerkleWitness,
  NETWORK_TREE_HEIGHT,
} from '../src/eligibility/provider-network-registry.js';
import {
  EligibilityData,
  COVERAGE_PHARMACY,
  buildEligibilityData,
} from '../src/eligibility/eligibility-data.js';
import {
  InNetworkProgram,
  InNetworkOutput,
} from '../src/eligibility/eligibility-program.js';
import {
  LIFECYCLE_ELIGIBLE,
  LIFECYCLE_ACTIVE,
  LIFECYCLE_REGISTERED,
  lifecycleLeafCommitment,
  LifecycleWitness,
} from '../src/engine/lifecycle.js';
import {
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  ProofGateProgram,
} from '../src/wallets/index.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { hashString } from '../src/zkp/hash-utils.js';
import { PlanTemplate } from '../src/onboarding/plan-template.js';
import type { PrescriberLocalData } from '../src/models/prescriber.js';
import type { PharmacyLocalData } from '../src/models/pharmacy.js';

// ─── Test Data ───────────────────────────────────────────

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

const testPrescriber: PrescriberLocalData = {
  prescriberIdQualifier: 1,
  prescriberId: '1234567890',
};

const testPharmacy: PharmacyLocalData = {
  serviceProviderIdQualifier: 1,
  serviceProviderId: '9876543210',
};

const prescriberWalletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
const pharmacyWalletId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);

// A second prescriber NOT in the network
const outsidePrescriber: PrescriberLocalData = {
  prescriberIdQualifier: 1,
  prescriberId: '5555555555',
};
const outsidePrescriberWalletId = derivePrescriberWalletId(outsidePrescriber, TEST_ENROLLMENT_KEY);

// ─── Tests ───────────────────────────────────────────────

describe('Provider Network by Plan (GAP 2)', () => {
  // ─── ProviderNetworkRegistry ───────────────────────────

  describe('ProviderNetworkRegistry', () => {
    test('empty registry has valid Merkle root', () => {
      const registry = new ProviderNetworkRegistry();
      const emptyTree = new MerkleTree(NETWORK_TREE_HEIGHT);
      expect(registry.getRoot().toString()).toBe(emptyTree.getRoot().toString());
    });

    test('addProvider changes root and increments count', () => {
      const registry = new ProviderNetworkRegistry();
      const oldRoot = registry.getRoot();
      expect(registry.count).toBe(0);

      const { index, newRoot } = registry.addProvider(prescriberWalletId);
      expect(index).toBe(0n);
      expect(registry.count).toBe(1);
      expect(newRoot.toString()).not.toBe(oldRoot.toString());
      expect(registry.getRoot().toString()).toBe(newRoot.toString());
    });

    test('multiple providers get sequential indices', () => {
      const registry = new ProviderNetworkRegistry();
      const r1 = registry.addProvider(prescriberWalletId);
      const r2 = registry.addProvider(pharmacyWalletId);

      expect(r1.index).toBe(0n);
      expect(r2.index).toBe(1n);
      expect(registry.count).toBe(2);
    });

    test('rejects duplicate provider', () => {
      const registry = new ProviderNetworkRegistry();
      registry.addProvider(prescriberWalletId);

      expect(() => registry.addProvider(prescriberWalletId))
        .toThrow('Provider already in network');
    });

    test('isInNetwork returns correct status', () => {
      const registry = new ProviderNetworkRegistry();
      registry.addProvider(prescriberWalletId);

      expect(registry.isInNetwork(prescriberWalletId)).toBe(true);
      expect(registry.isInNetwork(pharmacyWalletId)).toBe(false);
    });

    test('getIndex returns index for registered, undefined for unregistered', () => {
      const registry = new ProviderNetworkRegistry();
      registry.addProvider(prescriberWalletId);

      expect(registry.getIndex(prescriberWalletId)).toBe(0n);
      expect(registry.getIndex(pharmacyWalletId)).toBeUndefined();
    });

    test('getWitness produces valid Merkle proof', () => {
      const registry = new ProviderNetworkRegistry();
      registry.addProvider(prescriberWalletId);
      registry.addProvider(pharmacyWalletId);

      const witness = registry.getWitness(prescriberWalletId);
      const computedRoot = witness.calculateRoot(prescriberWalletId);
      expect(computedRoot.toString()).toBe(registry.getRoot().toString());
    });

    test('getWitness throws for unregistered provider', () => {
      const registry = new ProviderNetworkRegistry();
      expect(() => registry.getWitness(prescriberWalletId))
        .toThrow('Provider not in network');
    });

    test('supports up to 2048 providers', () => {
      const registry = new ProviderNetworkRegistry();
      // Add a handful to confirm scaling (not all 2048 — too slow for test)
      for (let i = 0; i < 100; i++) {
        const walletId = Poseidon.hash([Field(i), Field(999)]);
        registry.addProvider(walletId);
      }
      expect(registry.count).toBe(100);

      // Verify last one's witness
      const lastWallet = Poseidon.hash([Field(99), Field(999)]);
      const witness = registry.getWitness(lastWallet);
      const computedRoot = witness.calculateRoot(lastWallet);
      expect(computedRoot.toString()).toBe(registry.getRoot().toString());
    });
  });

  // ─── EligibilityData with networkRoot ──────────────────

  describe('EligibilityData — 8-field commitment', () => {
    test('networkRoot=Field(0) produces different commitment than non-zero', () => {
      const base = new EligibilityData({
        planIdHash: hashString('PLAN-NET-TEST'),
        groupIdHash: hashString('GRP-001'),
        effectiveDate: Field(20260101),
        terminationDate: Field(20261231),
        copayAmountCents: Field(2000),
        coverageType: COVERAGE_PHARMACY,
        formularyRoot: Field(0),
        networkRoot: Field(0),
      });

      const withNetwork = new EligibilityData({
        ...base,
        networkRoot: Field(12345),
      });

      expect(base.commitment().toString()).not.toBe(withNetwork.commitment().toString());
    });

    test('buildEligibilityData defaults networkRoot to Field(0)', () => {
      const ed = buildEligibilityData({
        planId: 'PLAN-1',
        groupId: 'GRP-1',
        effectiveDate: '20260101',
        terminationDate: '20261231',
        copayAmount: 2000,
        coverageType: 1,
        formularyRoot: '0',
        // no networkRoot specified
      });
      expect(ed.networkRoot.toString()).toBe('0');
    });

    test('buildEligibilityData passes explicit networkRoot', () => {
      const ed = buildEligibilityData({
        planId: 'PLAN-1',
        groupId: 'GRP-1',
        effectiveDate: '20260101',
        terminationDate: '20261231',
        copayAmount: 2000,
        coverageType: 1,
        formularyRoot: '0',
        networkRoot: '12345',
      });
      expect(ed.networkRoot.toString()).toBe('12345');
    });
  });

  // ─── PlanTemplate with provider network ────────────────

  describe('PlanTemplate — provider network integration', () => {
    test('PlanTemplate without providers sets networkRoot=Field(0)', () => {
      const template = new PlanTemplate({
        planId: 'NO-NETWORK',
        copayAmountCents: 2000,
        coverageType: 1,
        deductibleAmountCents: 0,
        oopMaxCents: 0,
        annualBenefitMaxCents: 0,
        formularyEntries: [],
        // no providerWalletIds
      });

      expect(template.networkRoot.toString()).toBe('0');
    });

    test('PlanTemplate with providers builds network registry', () => {
      const template = new PlanTemplate({
        planId: 'WITH-NETWORK',
        copayAmountCents: 2000,
        coverageType: 1,
        deductibleAmountCents: 0,
        oopMaxCents: 0,
        annualBenefitMaxCents: 0,
        formularyEntries: [],
        providerWalletIds: [prescriberWalletId, pharmacyWalletId],
      });

      expect(template.networkRoot.toString()).not.toBe('0');
      expect(template.networkRegistry.count).toBe(2);
      expect(template.networkRegistry.isInNetwork(prescriberWalletId)).toBe(true);
      expect(template.networkRegistry.isInNetwork(pharmacyWalletId)).toBe(true);
    });

    test('PlanTemplate buildEligibilityData includes networkRoot', () => {
      const template = new PlanTemplate({
        planId: 'NET-PLAN',
        copayAmountCents: 3000,
        coverageType: 1,
        deductibleAmountCents: 50000,
        oopMaxCents: 800000,
        annualBenefitMaxCents: 0,
        formularyEntries: [],
        providerWalletIds: [prescriberWalletId],
      });

      const eligData = template.buildEligibilityData('GRP-1', '20260101', '20261231');
      expect(eligData.networkRoot.toString()).toBe(template.networkRoot.toString());
      expect(eligData.networkRoot.toString()).not.toBe('0');
    });
  });

  // ─── InNetworkProgram — network verification ───────────

  describe('InNetworkProgram — network tree verification', () => {
    beforeAll(async () => {
      await ProofGateProgram.compile();
      await InNetworkProgram.compile();
    });

    /** Helper: set up lifecycle tree with a wallet at a given lifecycle state */
    function setupLifecycleTree(walletId: Field, lifecycle: Field, index: bigint = 0n) {
      const tree = new MerkleTree(WALLET_TREE_HEIGHT);
      const leaf = lifecycleLeafCommitment(walletId, lifecycle);
      tree.setLeaf(index, leaf);
      return tree;
    }

    test('proves in-network with real provider network', async () => {
      // Build a network with the prescriber in it
      const networkRegistry = new ProviderNetworkRegistry();
      networkRegistry.addProvider(prescriberWalletId);
      const networkRoot = networkRegistry.getRoot();
      const networkWitness = networkRegistry.getWitness(prescriberWalletId);

      // Lifecycle setup
      const lcTree = setupLifecycleTree(prescriberWalletId, LIFECYCLE_ELIGIBLE);
      const lcWitness = new LifecycleWitness(lcTree.getWitness(0n));
      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyPrescriber(
        prescriberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const result = await InNetworkProgram.proveInNetwork(
        pgResult.proof,
        LIFECYCLE_ELIGIBLE,
        lcWitness,
        lcTree.getRoot(),
        networkRoot,
        networkWitness,
      );

      expect(result.proof).toBeDefined();
      const output = result.proof.publicOutput as unknown as InNetworkOutput;
      expect(output.walletId.toString()).toBe(prescriberWalletId.toString());
      expect(output.networkRoot.toString()).toBe(networkRoot.toString());

      const isValid = await InNetworkProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });

    test('rejects provider NOT in network tree', async () => {
      // Build a network that does NOT include the outside prescriber
      const networkRegistry = new ProviderNetworkRegistry();
      networkRegistry.addProvider(prescriberWalletId); // only the insider
      const networkRoot = networkRegistry.getRoot();

      // Use a witness for index 0 (the insider's slot) — wrong wallet
      // The circuit will check calculateRoot(outsideWalletId) !== networkRoot
      const emptyTree = new MerkleTree(NETWORK_TREE_HEIGHT);
      const dummyWitness = new NetworkMerkleWitness(emptyTree.getWitness(0n));

      // Lifecycle for the outside prescriber
      const lcTree = setupLifecycleTree(outsidePrescriberWalletId, LIFECYCLE_ACTIVE);
      const lcWitness = new LifecycleWitness(lcTree.getWitness(0n));
      const preimage = prescriberWalletPreimage(outsidePrescriber, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyPrescriber(
        outsidePrescriberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      await expect(
        InNetworkProgram.proveInNetwork(
          pgResult.proof,
          LIFECYCLE_ACTIVE,
          lcWitness,
          lcTree.getRoot(),
          networkRoot,
          dummyWitness,
        ),
      ).rejects.toThrow();
    });

    test('networkRoot=Field(0) skips network check (all providers accepted)', async () => {
      const lcTree = setupLifecycleTree(prescriberWalletId, LIFECYCLE_ACTIVE);
      const lcWitness = new LifecycleWitness(lcTree.getWitness(0n));
      const preimage = prescriberWalletPreimage(testPrescriber, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyPrescriber(
        prescriberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      // networkRoot=0 + dummy witness → should still pass
      const emptyTree = new MerkleTree(NETWORK_TREE_HEIGHT);
      const dummyWitness = new NetworkMerkleWitness(emptyTree.getWitness(0n));

      const result = await InNetworkProgram.proveInNetwork(
        pgResult.proof,
        LIFECYCLE_ACTIVE,
        lcWitness,
        lcTree.getRoot(),
        Field(0),
        dummyWitness,
      );

      expect(result.proof).toBeDefined();
      const output = result.proof.publicOutput as unknown as InNetworkOutput;
      expect(output.networkRoot.toString()).toBe('0');

      const isValid = await InNetworkProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });
  });
});
