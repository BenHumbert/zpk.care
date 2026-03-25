import {
  Field,
  Poseidon,
  MerkleTree,
} from 'o1js';
import {
  CredentialData,
  CREDENTIAL_TYPE_ELIGIBILITY,
  CREDENTIAL_TYPE_PRESCRIPTION,
} from '../src/credentials/credential-data.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';
import {
  CredentialProgram,
  CredentialOperationOutput,
  CREDENTIAL_OP_MINT,
  CREDENTIAL_OP_VERIFY,
} from '../src/credentials/credential-program.js';
import {
  serializeCredential,
  deserializeCredential,
  verifyCredentialOffline,
} from '../src/credentials/portable-credential.js';
import type { PortableCredential } from '../src/credentials/portable-credential.js';
import { UserWalletService } from '../src/credentials/user-wallet-service.js';
import {
  EMPTY_CREDENTIAL_ROOT,
  StateTransitionProgram,
} from '../src/engine/state-transition.js';
import {
  LIFECYCLE_REGISTERED,
  LIFECYCLE_ELIGIBLE,
  lifecycleLeafCommitment,
  LifecycleWitness,
} from '../src/engine/lifecycle.js';
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  ProofGateProgram,
} from '../src/wallets/index.js';
import {
  WalletRegistry,
  WalletState,
  CREDENTIAL_INVENTORY_HEIGHT,
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import type { MemberLocalData } from '../src/models/member.js';
import type { PrescriberLocalData } from '../src/models/prescriber.js';
import type { PharmacyLocalData } from '../src/models/pharmacy.js';

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

const testPharmacy: PharmacyLocalData = {
  serviceProviderIdQualifier: 1,
  serviceProviderId: '9876543210',
};

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

// Wallet IDs
const memberWalletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY, Field(0));
const prescriberWalletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
const pharmacyWalletId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);

// A sample forest root (from MerkleForest with some data)
const sampleForest = new MerkleForest();
sampleForest.setLeaf(ForestDomain.MEMBER, 0n, Poseidon.hash([Field(42)]));
const sampleForestRoot = sampleForest.getForestRoot();

/** Helper: create an eligibility credential for a member */
function createEligibilityCredential(
  issuer: Field,
  subject: Field,
  forestRoot: Field = sampleForestRoot,
): CredentialData {
  return new CredentialData({
    credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
    forestRoot,
    issuerWalletId: issuer,
    subjectWalletId: subject,
    issuedAt: Field(20260201),
    expiresAt: Field(20270201),
    revoked: Field(0),
  });
}

/** Helper: create an eScript (prescription) credential for a pharmacy */
function createPrescriptionCredential(
  issuer: Field,
  subject: Field,
  forestRoot: Field = sampleForestRoot,
): CredentialData {
  return new CredentialData({
    credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
    forestRoot,
    issuerWalletId: issuer,
    subjectWalletId: subject,
    issuedAt: Field(20260201),
    expiresAt: Field(20260301),
    revoked: Field(0),
  });
}

// ─── Tests ───────────────────────────────────────────────

describe('Layer 4 — Credential System / User Path', () => {
  // ─── Credential Data Model ──────────────────────────────────

  describe('Credential Data Model', () => {
    test('CredentialData commitment is deterministic', () => {
      const credential1 = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const credential2 = createEligibilityCredential(prescriberWalletId, memberWalletId);
      expect(credential1.commitment().toString()).toBe(credential2.commitment().toString());
    });

    test('commitment changes when any field changes', () => {
      const baseCredential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const baseCommitment = baseCredential.commitment().toString();

      // Change credentialType
      const credential2 = new CredentialData({ ...baseCredential, credentialType: CREDENTIAL_TYPE_PRESCRIPTION });
      expect(credential2.commitment().toString()).not.toBe(baseCommitment);

      // Change forestRoot
      const credential3 = new CredentialData({ ...baseCredential, forestRoot: Field(999) });
      expect(credential3.commitment().toString()).not.toBe(baseCommitment);

      // Change issuerWalletId
      const credential4 = new CredentialData({ ...baseCredential, issuerWalletId: Field(888) });
      expect(credential4.commitment().toString()).not.toBe(baseCommitment);

      // Change revoked
      const credential5 = new CredentialData({ ...baseCredential, revoked: Field(1) });
      expect(credential5.commitment().toString()).not.toBe(baseCommitment);
    });

    test('credential type constants have correct values', () => {
      expect(CREDENTIAL_TYPE_ELIGIBILITY.toString()).toBe('1');
      expect(CREDENTIAL_TYPE_PRESCRIPTION.toString()).toBe('2');
    });

    test('different forestRoots produce different commitments', () => {
      const forest2 = new MerkleForest();
      forest2.setLeaf(ForestDomain.MEDICATION, 0n, Poseidon.hash([Field(99)]));
      const otherRoot = forest2.getForestRoot();

      const credential1 = createEligibilityCredential(prescriberWalletId, memberWalletId, sampleForestRoot);
      const credential2 = createEligibilityCredential(prescriberWalletId, memberWalletId, otherRoot);

      expect(credential1.commitment().toString()).not.toBe(credential2.commitment().toString());
    });

    test('commitment matches manual Poseidon.hash of all 7 fields', () => {
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const manual = Poseidon.hash([
        credential.credentialType,
        credential.forestRoot,
        credential.issuerWalletId,
        credential.subjectWalletId,
        credential.issuedAt,
        credential.expiresAt,
        credential.revoked,
      ]);
      expect(credential.commitment().toString()).toBe(manual.toString());
    });
  });

  // ─── Credential Inventory Manager ───────────────────────────

  describe('Credential Inventory Manager', () => {
    test('empty inventory has EMPTY_CREDENTIAL_ROOT', () => {
      const inventory = new CredentialInventory();
      expect(inventory.getRoot().toString()).toBe(EMPTY_CREDENTIAL_ROOT.toString());
    });

    test('mint inserts eligibility credential and changes root', () => {
      const inventory = new CredentialInventory();
      const oldRoot = inventory.getRoot();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);

      const { index, newRoot } = inventory.mint(credential);

      expect(index).toBe(0n);
      expect(newRoot.toString()).not.toBe(oldRoot.toString());
      expect(inventory.getRoot().toString()).toBe(newRoot.toString());
    });

    test('getWitness validates inclusion of minted credential', () => {
      const inventory = new CredentialInventory();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const { index } = inventory.mint(credential);

      const witness = inventory.getWitness(index);
      const computedRoot = witness.calculateRoot(credential.commitment());
      expect(computedRoot.toString()).toBe(inventory.getRoot().toString());
    });

    test('mint increments count', () => {
      const inventory = new CredentialInventory();
      expect(inventory.count).toBe(0);

      inventory.mint(createEligibilityCredential(prescriberWalletId, memberWalletId));
      expect(inventory.count).toBe(1);

      inventory.mint(createPrescriptionCredential(prescriberWalletId, pharmacyWalletId));
      expect(inventory.count).toBe(2);
    });

    test('cannot exceed 64 credential capacity', () => {
      const inventory = new CredentialInventory();
      // Fill all 64 slots
      for (let i = 0; i < 64; i++) {
        inventory.mint(
          new CredentialData({
            credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
            forestRoot: Field(i),
            issuerWalletId: prescriberWalletId,
            subjectWalletId: memberWalletId,
            issuedAt: Field(20260201),
            expiresAt: Field(0),
            revoked: Field(0),
          }),
        );
      }
      expect(inventory.count).toBe(64);

      // 65th should throw
      expect(() =>
        inventory.mint(createEligibilityCredential(prescriberWalletId, memberWalletId)),
      ).toThrow('Credential inventory full');
    });

    test('revoke marks credential revoked and changes root', () => {
      const inventory = new CredentialInventory();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const { index } = inventory.mint(credential);
      const rootBeforeRevoke = inventory.getRoot();

      const newRoot = inventory.revoke(index);
      expect(newRoot.toString()).not.toBe(rootBeforeRevoke.toString());

      // Verify the revoked credential has revoked=1
      const revokedCredential = inventory.getCredential(index)!;
      expect(revokedCredential.revoked.toString()).toBe('1');

      // Verify the revoked commitment is in the tree
      const witness = inventory.getWitness(index);
      const computedRoot = witness.calculateRoot(revokedCredential.commitment());
      expect(computedRoot.toString()).toBe(inventory.getRoot().toString());
    });
  });

  // ─── CredentialProgram — proveMint ──────────────────────────

  describe('CredentialProgram — proveMint', () => {
    beforeAll(async () => {
      // Compile ProofGateProgram first (CredentialProgram depends on it for recursive verification)
      await ProofGateProgram.compile();
      await CredentialProgram.compile();
    });

    test('generates valid proof when minting eligibility credential into member wallet', async () => {
      const inventory = new CredentialInventory();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));

      // Generate ownership proof
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      // Get witness for empty slot 0
      const witness = inventory.getWitness(0n);
      const oldRoot = inventory.getRoot();

      // Prove the mint
      const result = await CredentialProgram.proveMint(
        pgResult.proof,
        credential,
        witness,
        oldRoot,
      );

      expect(result.proof).toBeDefined();

      const output = result.proof.publicOutput as unknown as CredentialOperationOutput;
      expect(output.walletId.toString()).toBe(memberWalletId.toString());
      expect(output.operationType.toString()).toBe(CREDENTIAL_OP_MINT.toString());
      expect(output.credentialCommitment.toString()).toBe(credential.commitment().toString());
      expect(output.oldInventoryRoot.toString()).toBe(oldRoot.toString());
      expect(output.newInventoryRoot.toString()).not.toBe(oldRoot.toString());
    });

    test('proof verifies standalone (simulates offline verification)', async () => {
      const inventory = new CredentialInventory();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));

      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await CredentialProgram.proveMint(
        pgResult.proof,
        credential,
        witness,
        inventory.getRoot(),
      );

      // Standalone verification (simulates offline NFC/RFID check)
      const isValid = await CredentialProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });

    test('rejects insertion at occupied slot', async () => {
      const inventory = new CredentialInventory();
      const credential1 = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const credential2 = new CredentialData({
        ...credential1,
        forestRoot: Field(999),
      });
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));

      // Mint first credential at slot 0
      inventory.mint(credential1);

      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      // Try to mint at slot 0 using witness from BEFORE mint — root won't match
      // The inventory root has changed, so using the old empty root will fail
      const emptyInventory = new CredentialInventory();
      const witnessForSlot0 = emptyInventory.getWitness(0n);

      await expect(
        CredentialProgram.proveMint(
          pgResult.proof,
          credential2,
          witnessForSlot0,
          inventory.getRoot(), // current root (with slot 0 occupied)
        ),
      ).rejects.toThrow();
    });

    test('rejects subjectWalletId != walletId (wrong recipient)', async () => {
      const inventory = new CredentialInventory();
      // Credential with pharmacy as subject, but member proves ownership
      const wrongCredential = createEligibilityCredential(prescriberWalletId, pharmacyWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));

      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(0n);

      await expect(
        CredentialProgram.proveMint(
          pgResult.proof,
          wrongCredential,
          witness,
          inventory.getRoot(),
        ),
      ).rejects.toThrow();
    });

    // 14-R04: proveMint rejects pre-revoked credential
    test('rejects pre-revoked credential (revoked=1)', async () => {
      const inventory = new CredentialInventory();
      const revokedCredential = new CredentialData({
        credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
        forestRoot: sampleForestRoot,
        issuerWalletId: prescriberWalletId,
        subjectWalletId: memberWalletId,
        issuedAt: Field(20260201),
        expiresAt: Field(20270201),
        revoked: Field(1), // PRE-REVOKED
      });
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));

      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(0n);

      await expect(
        CredentialProgram.proveMint(
          pgResult.proof,
          revokedCredential,
          witness,
          inventory.getRoot(),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── CredentialProgram — proveHolding ───────────────────────

  describe('CredentialProgram — proveHolding', () => {
    test('member proves holding eligibility credential — valid proof', async () => {
      const inventory = new CredentialInventory();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      inventory.mint(credential);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await CredentialProgram.proveHolding(
        pgResult.proof,
        credential,
        witness,
        inventory.getRoot(),
      );

      const output = result.proof.publicOutput as unknown as CredentialOperationOutput;
      expect(output.walletId.toString()).toBe(memberWalletId.toString());
      expect(output.operationType.toString()).toBe(CREDENTIAL_OP_VERIFY.toString());
      // Root unchanged for verification
      expect(output.oldInventoryRoot.toString()).toBe(output.newInventoryRoot.toString());
    });

    test('proof verifies standalone (offline at pharmacy)', async () => {
      const inventory = new CredentialInventory();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      inventory.mint(credential);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await CredentialProgram.proveHolding(
        pgResult.proof,
        credential,
        witness,
        inventory.getRoot(),
      );

      const isValid = await CredentialProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });

    test('rejects proof for credential not in inventory', async () => {
      const inventory = new CredentialInventory();
      // Don't mint — inventory is empty
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(0n);

      await expect(
        CredentialProgram.proveHolding(
          pgResult.proof,
          credential,
          witness,
          inventory.getRoot(),
        ),
      ).rejects.toThrow();
    });

    test('rejects revoked credential', async () => {
      const inventory = new CredentialInventory();
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const { index } = inventory.mint(credential);

      // Revoke the credential
      inventory.revoke(index);
      const revokedCredential = inventory.getCredential(index)!;

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(index);

      await expect(
        CredentialProgram.proveHolding(
          pgResult.proof,
          revokedCredential,
          witness,
          inventory.getRoot(),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── CredentialProgram — proveHoldingByType ─────────────────

  describe('CredentialProgram — proveHoldingByType', () => {
    test('pharmacy proves holding PRESCRIPTION type — succeeds', async () => {
      const inventory = new CredentialInventory();
      const credential = createPrescriptionCredential(prescriberWalletId, pharmacyWalletId);
      inventory.mint(credential);

      const preimage = pharmacyWalletPreimage(testPharmacy, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await CredentialProgram.proveHoldingByType(
        pgResult.proof,
        credential,
        witness,
        inventory.getRoot(),
        CREDENTIAL_TYPE_PRESCRIPTION,
      );

      const output = result.proof.publicOutput as unknown as CredentialOperationOutput;
      expect(output.walletId.toString()).toBe(pharmacyWalletId.toString());
      expect(output.operationType.toString()).toBe(CREDENTIAL_OP_VERIFY.toString());
    });

    test('rejects when type does not match', async () => {
      const inventory = new CredentialInventory();
      // Credential is ELIGIBILITY type
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      inventory.mint(credential);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!, preimage[5]!,
      );

      const witness = inventory.getWitness(0n);

      // Try to prove it's a PRESCRIPTION type — should fail
      await expect(
        CredentialProgram.proveHoldingByType(
          pgResult.proof,
          credential,
          witness,
          inventory.getRoot(),
          CREDENTIAL_TYPE_PRESCRIPTION, // wrong type!
        ),
      ).rejects.toThrow();
    });

    test('proof verifies standalone (offline)', async () => {
      const inventory = new CredentialInventory();
      const credential = createPrescriptionCredential(prescriberWalletId, pharmacyWalletId);
      inventory.mint(credential);

      const preimage = pharmacyWalletPreimage(testPharmacy, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await CredentialProgram.proveHoldingByType(
        pgResult.proof,
        credential,
        witness,
        inventory.getRoot(),
        CREDENTIAL_TYPE_PRESCRIPTION,
      );

      const isValid = await CredentialProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });
  });

  // ─── Portable Credential ─────────────────────────────

  describe('Portable Credential Serialization', () => {
    test('serializeCredential produces valid JSON', () => {
      // Create a mock proof-like object for serialization
      const mockOutput = new CredentialOperationOutput({
        walletId: memberWalletId,
        operationType: CREDENTIAL_OP_VERIFY,
        credentialCommitment: Poseidon.hash([Field(1)]),
        oldInventoryRoot: EMPTY_CREDENTIAL_ROOT,
        newInventoryRoot: EMPTY_CREDENTIAL_ROOT,
      });

      const mockProof = {
        toJSON: () => ({
          publicInput: [],
          publicOutput: ['1', '2', '3', '4', '5'],
          maxProofsVerified: 2 as const,
          proof: 'mock-proof-data',
        }),
        publicOutput: mockOutput,
      };

      const credential = serializeCredential(
        mockProof,
        'credential-holding',
        Field(12345),
      );

      expect(credential.version).toBe(1);
      expect(credential.proofType).toBe('credential-holding');
      expect(credential.publicOutput.walletId).toBe(memberWalletId.toString());
      expect(credential.publicOutput.operationType).toBe(CREDENTIAL_OP_VERIFY.toString());
      expect(credential.verificationKeyHash).toBe('12345');
      expect(credential.expiresAt).toBe(0);
      expect(credential.createdAt).toBeGreaterThan(0);
    });

    test('deserializeCredential reconstructs credential', () => {
      const original: PortableCredential = {
        version: 1,
        proofType: 'credential-holding',
        proofJson: {
          publicInput: [],
          publicOutput: ['1', '2'],
          maxProofsVerified: 2,
          proof: 'test-proof-data',
        },
        publicOutput: {
          walletId: '123',
          operationType: '2',
          credentialCommitment: '456',
          oldInventoryRoot: '789',
          newInventoryRoot: '789',
        },
        verificationKeyHash: '999',
        createdAt: 1700000000000,
        expiresAt: 0,
      };

      const json = JSON.stringify(original);
      const restored = deserializeCredential(json);

      expect(restored.version).toBe(original.version);
      expect(restored.proofType).toBe(original.proofType);
      expect(restored.publicOutput.walletId).toBe(original.publicOutput.walletId);
      expect(restored.verificationKeyHash).toBe(original.verificationKeyHash);
      expect(restored.proofJson.proof).toBe(original.proofJson.proof);
    });

    test('round-trip serialize → deserialize preserves data', () => {
      const mockOutput = new CredentialOperationOutput({
        walletId: pharmacyWalletId,
        operationType: CREDENTIAL_OP_MINT,
        credentialCommitment: Poseidon.hash([Field(42)]),
        oldInventoryRoot: EMPTY_CREDENTIAL_ROOT,
        newInventoryRoot: Poseidon.hash([Field(100)]),
      });

      const mockProof = {
        toJSON: () => ({
          publicInput: [],
          publicOutput: ['1'],
          maxProofsVerified: 2 as const,
          proof: 'round-trip-test-proof',
        }),
        publicOutput: mockOutput,
      };

      const credential = serializeCredential(
        mockProof,
        'credential-mint',
        Field(777),
        1800000000000,
      );

      const json = JSON.stringify(credential);
      const restored = deserializeCredential(json);

      expect(restored.version).toBe(credential.version);
      expect(restored.proofType).toBe(credential.proofType);
      expect(restored.publicOutput.walletId).toBe(credential.publicOutput.walletId);
      expect(restored.publicOutput.credentialCommitment).toBe(credential.publicOutput.credentialCommitment);
      expect(restored.verificationKeyHash).toBe(credential.verificationKeyHash);
      expect(restored.expiresAt).toBe(1800000000000);
    });
  });

  // ─── User Wallet Service ─────────────────────────────

  describe('User Wallet Service', () => {
    let store: InMemoryStore;
    let memberInventory: CredentialInventory;
    let registry: WalletRegistry;
    let lifecycleTree: MerkleTree;

    beforeAll(async () => {
      // Compile StateTransitionProgram (ProofGate + CredentialProgram already compiled above)
      await StateTransitionProgram.compile();
    });

    beforeEach(() => {
      store = new InMemoryStore();
      memberInventory = new CredentialInventory();
      registry = new WalletRegistry();
      lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);

      // Register the member wallet in the registry
      const memberIndex = registry.register(memberWalletId);

      // Set lifecycle to ELIGIBLE (required for wallet updates)
      const lifecycleLeaf = lifecycleLeafCommitment(memberWalletId, LIFECYCLE_ELIGIBLE);
      lifecycleTree.setLeaf(memberIndex, lifecycleLeaf);
    });

    test('mintCredential orchestrates full proof chain (ProofGate → CredentialProgram → StateTransition)', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));

      const result = await service.mintCredential(
        preimage,
        'member',
        credential,
        LIFECYCLE_ELIGIBLE,
      );

      // CredentialOperationProof exists
      expect(result.credentialProof).toBeDefined();

      // StateTransitionProof exists
      expect(result.stateProof).toBeDefined();

      // Credential index assigned
      expect(result.credentialIndex).toBe(0n);

      // Inventory updated
      expect(service.getCredentialCount()).toBe(1);
    });

    test('proveCredentialHolding returns verifiable portable proof', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      // First mint a credential
      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const mintResult = await service.mintCredential(preimage, 'member', credential, LIFECYCLE_ELIGIBLE);

      // Now prove holding
      const holdingProof = await service.proveCredentialHolding(preimage, 'member', mintResult.credentialIndex);

      expect(holdingProof).toBeDefined();

      // Verify the proof standalone
      const isValid = await CredentialProgram.verify(holdingProof);
      expect(isValid).toBe(true);
    });

    test('exportCredential produces serializable credential', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const mintResult = await service.mintCredential(preimage, 'member', credential, LIFECYCLE_ELIGIBLE);

      const holdingProof = await service.proveCredentialHolding(preimage, 'member', mintResult.credentialIndex);

      const portableCredential = service.exportCredential(
        holdingProof as any,
        'credential-holding',
        Field(12345),
      );

      expect(portableCredential.version).toBe(1);
      expect(portableCredential.proofType).toBe('credential-holding');
      expect(portableCredential.publicOutput.walletId).toBe(memberWalletId.toString());

      // Should be JSON serializable
      const json = JSON.stringify(portableCredential);
      expect(json.length).toBeGreaterThan(0);
    });

    // 14-R14: verifyCredentialOffline succeeds with valid proof
    test('verifyCredentialOffline succeeds with valid holding proof', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      const credential = createEligibilityCredential(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));
      const mintResult = await service.mintCredential(preimage, 'member', credential, LIFECYCLE_ELIGIBLE);

      const holdingProof = await service.proveCredentialHolding(preimage, 'member', mintResult.credentialIndex);

      const portableCredential = service.exportCredential(
        holdingProof as any,
        'credential-holding',
        Field(12345),
      );

      // verifyCredentialOffline should validate this real proof
      // Note: verificationKey param is a string (vk hash), the function
      // uses CredentialProgram.verify internally which was compiled in beforeAll
      const isValid = await verifyCredentialOffline(
        portableCredential,
        '12345', // matches verificationKeyHash
      );
      expect(isValid).toBe(true);
    });

    test('tracks credential count and inventory state', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      expect(service.getCredentialCount()).toBe(0);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY, Field(0));

      // Mint first credential
      const credential1 = createEligibilityCredential(prescriberWalletId, memberWalletId);
      await service.mintCredential(preimage, 'member', credential1, LIFECYCLE_ELIGIBLE);
      expect(service.getCredentialCount()).toBe(1);

      // Verify inventory is accessible
      const inventory = service.getInventory();
      expect(inventory.getCredential(0n)).toBeDefined();
      expect(inventory.getCredential(0n)!.credentialType.toString()).toBe(CREDENTIAL_TYPE_ELIGIBILITY.toString());
    });
  });
});
