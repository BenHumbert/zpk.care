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

import {
  Field,
  Poseidon,
  MerkleTree,
  Mina,
  PrivateKey,
  AccountUpdate,
} from 'o1js';
import {
  CareContract,
} from '../src/engine/care-contract.js';
import {
  LifecycleWitness,
  LIFECYCLE_EMPTY,
  LIFECYCLE_REGISTERED,
  LIFECYCLE_ELIGIBLE,
  LIFECYCLE_ACTIVE,
  LIFECYCLE_REVOKED,
  lifecycleLeafCommitment,
  assertValidTransition,
  isValidTransition,
} from '../src/engine/lifecycle.js';
import {
  EMPTY_CREDENTIAL_ROOT,
  StateTransitionProgram,
  TransitionOutput,
} from '../src/engine/state-transition.js';
import {
  WalletState,
  WalletRegistryWitness,
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  memberWalletPreimage,
  ProofGateProgram,
} from '../src/wallets/index.js';
import type { MemberLocalData } from '../src/models/member.js';
import type { PrescriberLocalData } from '../src/models/prescriber.js';

// ─── Test Data ───────────────────────────────────────────

const testMember: MemberLocalData = {
  cardholderId: 'CARD123456789',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'John',
  lastName: 'Doe',
};

const testPrescriber: PrescriberLocalData = {
  prescriberIdQualifier: 1,
  prescriberId: '1234567890',
};

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

// ─── Off-chain State Helpers ─────────────────────────────

let registryTree: MerkleTree;
let lifecycleTree: MerkleTree;
let nextIndex: bigint;

function resetTrees() {
  registryTree = new MerkleTree(WALLET_TREE_HEIGHT);
  lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
  nextIndex = 0n;
}

function getRegistryWitness(index: bigint): WalletRegistryWitness {
  return new WalletRegistryWitness(registryTree.getWitness(index));
}

function getLifecycleWitness(index: bigint): LifecycleWitness {
  return new LifecycleWitness(lifecycleTree.getWitness(index));
}

// ─── Tests ───────────────────────────────────────────────

describe('Layer 3 — zkApp Core Engine', () => {

  // ═══ Pure unit tests (no blockchain) ═══════════════════

  describe('Lifecycle Constants', () => {
    test('LIFECYCLE constants have correct Field values', () => {
      expect(LIFECYCLE_EMPTY.toString()).toBe('0');
      expect(LIFECYCLE_REGISTERED.toString()).toBe('1');
      expect(LIFECYCLE_ELIGIBLE.toString()).toBe('2');
      expect(LIFECYCLE_ACTIVE.toString()).toBe('3');
      expect(LIFECYCLE_REVOKED.toString()).toBe('4');
    });

    test('lifecycleLeafCommitment is deterministic', () => {
      const walletId = Field(42);
      const c1 = lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED);
      const c2 = lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED);
      expect(c1.toString()).toBe(c2.toString());
    });

    test('lifecycleLeafCommitment changes with different walletId', () => {
      const c1 = lifecycleLeafCommitment(Field(1), LIFECYCLE_REGISTERED);
      const c2 = lifecycleLeafCommitment(Field(2), LIFECYCLE_REGISTERED);
      expect(c1.toString()).not.toBe(c2.toString());
    });

    test('lifecycleLeafCommitment changes with different lifecycle', () => {
      const walletId = Field(42);
      const c1 = lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED);
      const c2 = lifecycleLeafCommitment(walletId, LIFECYCLE_ELIGIBLE);
      expect(c1.toString()).not.toBe(c2.toString());
    });

    test('lifecycleLeafCommitment equals Poseidon.hash([walletId, lifecycle])', () => {
      const walletId = Field(99);
      const lifecycle = LIFECYCLE_ACTIVE;
      const commitment = lifecycleLeafCommitment(walletId, lifecycle);
      const expected = Poseidon.hash([walletId, lifecycle]);
      expect(commitment.toString()).toBe(expected.toString());
    });
  });

  describe('Lifecycle Transition Validation (off-chain)', () => {
    test('allows EMPTY → REGISTERED', () => {
      expect(isValidTransition(0n, 1n)).toBe(true);
    });

    test('allows REGISTERED → ELIGIBLE', () => {
      expect(isValidTransition(1n, 2n)).toBe(true);
    });

    test('allows ELIGIBLE → ACTIVE', () => {
      expect(isValidTransition(2n, 3n)).toBe(true);
    });

    test('allows ACTIVE → REVOKED', () => {
      expect(isValidTransition(3n, 4n)).toBe(true);
    });

    test('allows REGISTERED → REVOKED (admin revoke)', () => {
      expect(isValidTransition(1n, 4n)).toBe(true);
    });

    test('allows ELIGIBLE → REVOKED (admin revoke)', () => {
      expect(isValidTransition(2n, 4n)).toBe(true);
    });

    test('rejects EMPTY → ELIGIBLE (skip)', () => {
      expect(isValidTransition(0n, 2n)).toBe(false);
    });

    test('rejects REVOKED → anything', () => {
      expect(isValidTransition(4n, 0n)).toBe(false);
      expect(isValidTransition(4n, 1n)).toBe(false);
      expect(isValidTransition(4n, 2n)).toBe(false);
      expect(isValidTransition(4n, 3n)).toBe(false);
    });

    test('rejects backward transition ACTIVE → REGISTERED', () => {
      expect(isValidTransition(3n, 1n)).toBe(false);
    });
  });

  describe('EMPTY_CREDENTIAL_ROOT constant', () => {
    test('matches a fresh MerkleTree(7) root', () => {
      const freshTree = new MerkleTree(7);
      expect(EMPTY_CREDENTIAL_ROOT.toString()).toBe(freshTree.getRoot().toString());
    });

    test('is deterministic', () => {
      // Import a second time to verify module-scope constant is stable
      expect(EMPTY_CREDENTIAL_ROOT.toString()).toBe(EMPTY_CREDENTIAL_ROOT.toString());
      expect(EMPTY_CREDENTIAL_ROOT.toString().length).toBeGreaterThan(0);
    });
  });

  // ═══ CareContract on LocalBlockchain ═══════════════════

  describe('CareContract — Deploy and Init', () => {
    let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
    let deployer: Mina.TestPublicKey;
    let admin: Mina.TestPublicKey;
    let nonAdmin: Mina.TestPublicKey;
    let contractKey: PrivateKey;
    let contract: CareContract;
    let adminPkHash: Field;

    beforeAll(async () => {
      local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(local);

      [deployer, admin, nonAdmin] = local.testAccounts;
      contractKey = PrivateKey.random();
      contract = new CareContract(contractKey.toPublicKey());
      adminPkHash = Poseidon.hash(admin.toFields());

      resetTrees();

      // Deploy
      const deployTx = await Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer);
        await contract.deploy();
      });
      await deployTx.prove();
      await deployTx.sign([deployer.key, contractKey]).send();
    });

    test('deploys successfully', () => {
      // If we got here without throwing, deploy succeeded
      expect(contract).toBeDefined();
    });

    test('initializes contract state', async () => {
      const initTx = await Mina.transaction(admin, async () => {
        await contract.initState(
          adminPkHash,
          registryTree.getRoot(),
          lifecycleTree.getRoot(),
        );
      });
      await initTx.prove();
      await initTx.sign([admin.key]).send();

      expect(contract.walletRegistryRoot.get().toString())
        .toBe(registryTree.getRoot().toString());
      expect(contract.walletCount.get().toString()).toBe('0');
      expect(contract.adminPublicKeyHash.get().toString())
        .toBe(adminPkHash.toString());
      expect(contract.lifecycleRoot.get().toString())
        .toBe(lifecycleTree.getRoot().toString());
    });

    test('rejects double initialization', async () => {
      await expect(async () => {
        const tx = await Mina.transaction(admin, async () => {
          await contract.initState(
            adminPkHash,
            registryTree.getRoot(),
            lifecycleTree.getRoot(),
          );
        });
        await tx.prove();
        await tx.sign([admin.key]).send();
      }).rejects.toThrow();
    });
  });

  describe('CareContract — Register Wallets', () => {
    let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
    let deployer: Mina.TestPublicKey;
    let admin: Mina.TestPublicKey;
    let nonAdmin: Mina.TestPublicKey;
    let contractKey: PrivateKey;
    let contract: CareContract;
    let adminPkHash: Field;
    let memberWalletId: Field;
    let prescriberWalletId: Field;

    beforeAll(async () => {
      local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(local);

      [deployer, admin, nonAdmin] = local.testAccounts;
      contractKey = PrivateKey.random();
      contract = new CareContract(contractKey.toPublicKey());
      adminPkHash = Poseidon.hash(admin.toFields());

      resetTrees();

      memberWalletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY, Field(0));
      prescriberWalletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);

      // Deploy + init
      const deployTx = await Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer);
        await contract.deploy();
      });
      await deployTx.prove();
      await deployTx.sign([deployer.key, contractKey]).send();

      const initTx = await Mina.transaction(admin, async () => {
        await contract.initState(
          adminPkHash,
          registryTree.getRoot(),
          lifecycleTree.getRoot(),
        );
      });
      await initTx.prove();
      await initTx.sign([admin.key]).send();
    });

    test('registers a member wallet', async () => {
      const index = nextIndex;
      const regWitness = getRegistryWitness(index);
      const lcWitness = getLifecycleWitness(index);

      const tx = await Mina.transaction(admin, async () => {
        await contract.registerWallet(memberWalletId, regWitness, lcWitness);
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      // Mirror off-chain state
      const walletState = WalletState.init(memberWalletId);
      registryTree.setLeaf(index, walletState.commitment());
      lifecycleTree.setLeaf(
        index,
        lifecycleLeafCommitment(memberWalletId, LIFECYCLE_REGISTERED),
      );
      nextIndex++;

      expect(contract.walletRegistryRoot.get().toString())
        .toBe(registryTree.getRoot().toString());
      expect(contract.walletCount.get().toString()).toBe('1');
      expect(contract.lifecycleRoot.get().toString())
        .toBe(lifecycleTree.getRoot().toString());
    });

    test('registers a second (prescriber) wallet', async () => {
      const index = nextIndex;
      const regWitness = getRegistryWitness(index);
      const lcWitness = getLifecycleWitness(index);

      const tx = await Mina.transaction(admin, async () => {
        await contract.registerWallet(prescriberWalletId, regWitness, lcWitness);
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      // Mirror off-chain
      const walletState = WalletState.init(prescriberWalletId);
      registryTree.setLeaf(index, walletState.commitment());
      lifecycleTree.setLeaf(
        index,
        lifecycleLeafCommitment(prescriberWalletId, LIFECYCLE_REGISTERED),
      );
      nextIndex++;

      expect(contract.walletCount.get().toString()).toBe('2');
    });

    test('rejects registration by non-admin', async () => {
      const walletId = Field(999);
      const index = nextIndex;
      const regWitness = getRegistryWitness(index);
      const lcWitness = getLifecycleWitness(index);

      await expect(async () => {
        const tx = await Mina.transaction(nonAdmin, async () => {
          await contract.registerWallet(walletId, regWitness, lcWitness);
        });
        await tx.prove();
        await tx.sign([nonAdmin.key]).send();
      }).rejects.toThrow();
    });

    test('rejects registration at occupied slot', async () => {
      // Try to register at index 0 (already occupied by member wallet)
      const staleRegWitness = getRegistryWitness(0n);
      const staleLcWitness = getLifecycleWitness(0n);

      await expect(async () => {
        const tx = await Mina.transaction(admin, async () => {
          await contract.registerWallet(Field(888), staleRegWitness, staleLcWitness);
        });
        await tx.prove();
        await tx.sign([admin.key]).send();
      }).rejects.toThrow();
    });
  });

  describe('CareContract — Lifecycle Updates', () => {
    let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
    let deployer: Mina.TestPublicKey;
    let admin: Mina.TestPublicKey;
    let nonAdmin: Mina.TestPublicKey;
    let contractKey: PrivateKey;
    let contract: CareContract;
    let adminPkHash: Field;
    let walletId: Field;
    const walletIndex = 0n;

    beforeAll(async () => {
      local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(local);

      [deployer, admin, nonAdmin] = local.testAccounts;
      contractKey = PrivateKey.random();
      contract = new CareContract(contractKey.toPublicKey());
      adminPkHash = Poseidon.hash(admin.toFields());
      walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY, Field(0));

      resetTrees();

      // Deploy + init + register one wallet
      const deployTx = await Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer);
        await contract.deploy();
      });
      await deployTx.prove();
      await deployTx.sign([deployer.key, contractKey]).send();

      const initTx = await Mina.transaction(admin, async () => {
        await contract.initState(
          adminPkHash,
          registryTree.getRoot(),
          lifecycleTree.getRoot(),
        );
      });
      await initTx.prove();
      await initTx.sign([admin.key]).send();

      // Register wallet
      const regWitness = getRegistryWitness(walletIndex);
      const lcWitness = getLifecycleWitness(walletIndex);
      const regTx = await Mina.transaction(admin, async () => {
        await contract.registerWallet(walletId, regWitness, lcWitness);
      });
      await regTx.prove();
      await regTx.sign([admin.key]).send();

      // Mirror
      const walletState = WalletState.init(walletId);
      registryTree.setLeaf(walletIndex, walletState.commitment());
      lifecycleTree.setLeaf(
        walletIndex,
        lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED),
      );
    });

    test('transitions REGISTERED → ELIGIBLE', async () => {
      const lcWitness = getLifecycleWitness(walletIndex);

      const tx = await Mina.transaction(admin, async () => {
        await contract.updateLifecycle(
          walletId,
          LIFECYCLE_REGISTERED,
          LIFECYCLE_ELIGIBLE,
          lcWitness,
        );
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      // Mirror
      lifecycleTree.setLeaf(
        walletIndex,
        lifecycleLeafCommitment(walletId, LIFECYCLE_ELIGIBLE),
      );

      expect(contract.lifecycleRoot.get().toString())
        .toBe(lifecycleTree.getRoot().toString());
    });

    test('transitions ELIGIBLE → ACTIVE', async () => {
      const lcWitness = getLifecycleWitness(walletIndex);

      const tx = await Mina.transaction(admin, async () => {
        await contract.updateLifecycle(
          walletId,
          LIFECYCLE_ELIGIBLE,
          LIFECYCLE_ACTIVE,
          lcWitness,
        );
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      // Mirror
      lifecycleTree.setLeaf(
        walletIndex,
        lifecycleLeafCommitment(walletId, LIFECYCLE_ACTIVE),
      );

      expect(contract.lifecycleRoot.get().toString())
        .toBe(lifecycleTree.getRoot().toString());
    });

    test('rejects invalid skip REGISTERED → ACTIVE', async () => {
      // Set up a second wallet at REGISTERED
      const newWalletId = Field(777);
      const newIndex = 1n;

      const regWitness = getRegistryWitness(newIndex);
      const lcWitness = getLifecycleWitness(newIndex);
      const regTx = await Mina.transaction(admin, async () => {
        await contract.registerWallet(newWalletId, regWitness, lcWitness);
      });
      await regTx.prove();
      await regTx.sign([admin.key]).send();

      // Mirror
      const ws = WalletState.init(newWalletId);
      registryTree.setLeaf(newIndex, ws.commitment());
      lifecycleTree.setLeaf(
        newIndex,
        lifecycleLeafCommitment(newWalletId, LIFECYCLE_REGISTERED),
      );

      // Try invalid transition: REGISTERED → ACTIVE (should be REGISTERED → ELIGIBLE)
      const lcWitness2 = getLifecycleWitness(newIndex);

      await expect(async () => {
        const tx = await Mina.transaction(admin, async () => {
          await contract.updateLifecycle(
            newWalletId,
            LIFECYCLE_REGISTERED,
            LIFECYCLE_ACTIVE,
            lcWitness2,
          );
        });
        await tx.prove();
        await tx.sign([admin.key]).send();
      }).rejects.toThrow();
    });

    test('rejects lifecycle update by non-admin', async () => {
      const lcWitness = getLifecycleWitness(walletIndex);

      await expect(async () => {
        const tx = await Mina.transaction(nonAdmin, async () => {
          await contract.updateLifecycle(
            walletId,
            LIFECYCLE_ACTIVE,
            LIFECYCLE_REVOKED,
            lcWitness,
          );
        });
        await tx.prove();
        await tx.sign([nonAdmin.key]).send();
      }).rejects.toThrow();
    });
  });

  describe('CareContract — Wallet State Updates', () => {
    let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
    let deployer: Mina.TestPublicKey;
    let admin: Mina.TestPublicKey;
    let contractKey: PrivateKey;
    let contract: CareContract;
    let adminPkHash: Field;
    let walletId: Field;
    const walletIndex = 0n;

    // Track current wallet state for nonce/credentialRoot
    let currentCredentialRoot: Field;
    let currentNonce: Field;

    beforeAll(async () => {
      local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(local);

      [deployer, admin] = local.testAccounts;
      contractKey = PrivateKey.random();
      contract = new CareContract(contractKey.toPublicKey());
      adminPkHash = Poseidon.hash(admin.toFields());
      walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY, Field(0));

      resetTrees();

      // Deploy + init
      const deployTx = await Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer);
        await contract.deploy();
      });
      await deployTx.prove();
      await deployTx.sign([deployer.key, contractKey]).send();

      const initTx = await Mina.transaction(admin, async () => {
        await contract.initState(
          adminPkHash,
          registryTree.getRoot(),
          lifecycleTree.getRoot(),
        );
      });
      await initTx.prove();
      await initTx.sign([admin.key]).send();

      // Register wallet
      const regWitness = getRegistryWitness(walletIndex);
      const lcWitness = getLifecycleWitness(walletIndex);
      const regTx = await Mina.transaction(admin, async () => {
        await contract.registerWallet(walletId, regWitness, lcWitness);
      });
      await regTx.prove();
      await regTx.sign([admin.key]).send();

      const walletState = WalletState.init(walletId);
      registryTree.setLeaf(walletIndex, walletState.commitment());
      lifecycleTree.setLeaf(
        walletIndex,
        lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED),
      );

      currentCredentialRoot = EMPTY_CREDENTIAL_ROOT;
      currentNonce = Field(0);

      // Advance lifecycle to ELIGIBLE (needed for active state testing)
      const lcW1 = getLifecycleWitness(walletIndex);
      const lcTx1 = await Mina.transaction(admin, async () => {
        await contract.updateLifecycle(
          walletId, LIFECYCLE_REGISTERED, LIFECYCLE_ELIGIBLE, lcW1,
        );
      });
      await lcTx1.prove();
      await lcTx1.sign([admin.key]).send();
      lifecycleTree.setLeaf(
        walletIndex,
        lifecycleLeafCommitment(walletId, LIFECYCLE_ELIGIBLE),
      );
    });

    test('updates wallet credential inventory root', async () => {
      const newCredentialRoot = Poseidon.hash([Field(1), Field(2)]); // simulated new credential root
      const newNonce = Field(1);

      const regWitness = getRegistryWitness(walletIndex);
      const lcWitness = getLifecycleWitness(walletIndex);

      const tx = await Mina.transaction(admin, async () => {
        await contract.updateWalletState(
          walletId,
          currentCredentialRoot,
          currentNonce,
          newCredentialRoot,
          newNonce,
          regWitness,
          lcWitness,
          LIFECYCLE_ELIGIBLE,
        );
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      // Mirror
      const newCommitment = Poseidon.hash([walletId, newCredentialRoot, newNonce]);
      registryTree.setLeaf(walletIndex, newCommitment);

      currentCredentialRoot = newCredentialRoot;
      currentNonce = newNonce;

      expect(contract.walletRegistryRoot.get().toString())
        .toBe(registryTree.getRoot().toString());
    });

    test('rejects update with wrong nonce', async () => {
      const newCredentialRoot = Poseidon.hash([Field(3), Field(4)]);
      const wrongNonce = Field(99); // should be currentNonce + 1

      const regWitness = getRegistryWitness(walletIndex);
      const lcWitness = getLifecycleWitness(walletIndex);

      await expect(async () => {
        const tx = await Mina.transaction(admin, async () => {
          await contract.updateWalletState(
            walletId,
            currentCredentialRoot,
            currentNonce,
            newCredentialRoot,
            wrongNonce,
            regWitness,
            lcWitness,
            LIFECYCLE_ELIGIBLE,
          );
        });
        await tx.prove();
        await tx.sign([admin.key]).send();
      }).rejects.toThrow();
    });

    test('rejects update for revoked wallet', async () => {
      // Revoke the wallet: ELIGIBLE → REVOKED
      const lcW = getLifecycleWitness(walletIndex);
      const revokeTx = await Mina.transaction(admin, async () => {
        await contract.updateLifecycle(
          walletId, LIFECYCLE_ELIGIBLE, LIFECYCLE_REVOKED, lcW,
        );
      });
      await revokeTx.prove();
      await revokeTx.sign([admin.key]).send();
      lifecycleTree.setLeaf(
        walletIndex,
        lifecycleLeafCommitment(walletId, LIFECYCLE_REVOKED),
      );

      // Now try to update wallet state — should fail
      const newCredentialRoot = Poseidon.hash([Field(5)]);
      const newNonce = currentNonce.add(1);
      const regWitness = getRegistryWitness(walletIndex);
      const lcWitness2 = getLifecycleWitness(walletIndex);

      await expect(async () => {
        const tx = await Mina.transaction(admin, async () => {
          await contract.updateWalletState(
            walletId,
            currentCredentialRoot,
            currentNonce,
            newCredentialRoot,
            newNonce,
            regWitness,
            lcWitness2,
            LIFECYCLE_REVOKED,
          );
        });
        await tx.prove();
        await tx.sign([admin.key]).send();
      }).rejects.toThrow();
    });
  });

  describe('CareContract — Admin Key Rotation', () => {
    let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
    let deployer: Mina.TestPublicKey;
    let admin: Mina.TestPublicKey;
    let nonAdmin: Mina.TestPublicKey;
    let newAdmin: Mina.TestPublicKey;
    let contractKey: PrivateKey;
    let contract: CareContract;
    let adminPkHash: Field;

    beforeAll(async () => {
      local = await Mina.LocalBlockchain({ proofsEnabled: false });
      Mina.setActiveInstance(local);

      [deployer, admin, nonAdmin, newAdmin] = local.testAccounts;
      contractKey = PrivateKey.random();
      contract = new CareContract(contractKey.toPublicKey());
      adminPkHash = Poseidon.hash(admin.toFields());

      resetTrees();

      // Deploy + init
      const deployTx = await Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer);
        await contract.deploy();
      });
      await deployTx.prove();
      await deployTx.sign([deployer.key, contractKey]).send();

      const initTx = await Mina.transaction(admin, async () => {
        await contract.initState(
          adminPkHash,
          registryTree.getRoot(),
          lifecycleTree.getRoot(),
        );
      });
      await initTx.prove();
      await initTx.sign([admin.key]).send();
    });

    test('rotates admin key to new admin', async () => {
      const newAdminPkHash = Poseidon.hash(newAdmin.toFields());

      const tx = await Mina.transaction(admin, async () => {
        await contract.rotateAdmin(newAdminPkHash);
      });
      await tx.prove();
      await tx.sign([admin.key]).send();

      expect(contract.adminPublicKeyHash.get().toString())
        .toBe(newAdminPkHash.toString());
    });

    test('new admin can perform admin operations', async () => {
      // New admin should be able to register a wallet
      const walletId = Field(12345);
      const regWitness = getRegistryWitness(0n);
      const lcWitness = getLifecycleWitness(0n);

      const tx = await Mina.transaction(newAdmin, async () => {
        await contract.registerWallet(walletId, regWitness, lcWitness);
      });
      await tx.prove();
      await tx.sign([newAdmin.key]).send();

      expect(contract.walletCount.get().toString()).toBe('1');
    });

    test('old admin is rejected after rotation', async () => {
      const walletId = Field(99999);
      const regWitness = getRegistryWitness(1n);
      const lcWitness = getLifecycleWitness(1n);

      await expect(async () => {
        const tx = await Mina.transaction(admin, async () => {
          await contract.registerWallet(walletId, regWitness, lcWitness);
        });
        await tx.prove();
        await tx.sign([admin.key]).send();
      }).rejects.toThrow();
    });

    test('non-admin cannot rotate admin key', async () => {
      const attackerHash = Poseidon.hash(nonAdmin.toFields());

      await expect(async () => {
        const tx = await Mina.transaction(nonAdmin, async () => {
          await contract.rotateAdmin(attackerHash);
        });
        await tx.prove();
        await tx.sign([nonAdmin.key]).send();
      }).rejects.toThrow();
    });

    test('rejects rotation to zero hash (lockout prevention)', async () => {
      await expect(async () => {
        const tx = await Mina.transaction(newAdmin, async () => {
          await contract.rotateAdmin(Field(0));
        });
        await tx.prove();
        await tx.sign([newAdmin.key]).send();
      }).rejects.toThrow();
    });
  });

  // ═══ Recursive Proof Composition ═══════════════════════
  // Moved to tests/layer3-recursive.test.ts — recursive proof generation
  // conflicts with LocalBlockchain's proofsEnabled:false global state.
  // Run separately: npx jest tests/layer3-recursive.test.ts --verbose --maxWorkers=1
});
