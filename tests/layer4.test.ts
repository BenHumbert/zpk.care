import {
  Field,
  Poseidon,
  MerkleTree,
} from 'o1js';
import {
  NftData,
  NFT_TYPE_ELIGIBILITY,
  NFT_TYPE_PRESCRIPTION,
} from '../src/nft/nft-data.js';
import { NftInventory } from '../src/nft/nft-inventory.js';
import {
  NftProgram,
  NftOperationOutput,
  NFT_OP_MINT,
  NFT_OP_VERIFY,
} from '../src/nft/nft-program.js';
import {
  serializeCredential,
  deserializeCredential,
} from '../src/nft/portable-credential.js';
import type { PortableCredential } from '../src/nft/portable-credential.js';
import { UserWalletService } from '../src/nft/user-wallet-service.js';
import {
  EMPTY_NFT_ROOT,
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
  NFT_INVENTORY_HEIGHT,
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
const memberWalletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
const prescriberWalletId = derivePrescriberWalletId(testPrescriber, TEST_ENROLLMENT_KEY);
const pharmacyWalletId = derivePharmacyWalletId(testPharmacy, TEST_ENROLLMENT_KEY);

// A sample forest root (from MerkleForest with some data)
const sampleForest = new MerkleForest();
sampleForest.setLeaf(ForestDomain.MEMBER, 0n, Poseidon.hash([Field(42)]));
const sampleForestRoot = sampleForest.getForestRoot();

/** Helper: create an eligibility NFT for a member */
function createEligibilityNft(
  issuer: Field,
  subject: Field,
  forestRoot: Field = sampleForestRoot,
): NftData {
  return new NftData({
    nftType: NFT_TYPE_ELIGIBILITY,
    forestRoot,
    issuerWalletId: issuer,
    subjectWalletId: subject,
    issuedAt: Field(20260201),
    expiresAt: Field(20270201),
    revoked: Field(0),
  });
}

/** Helper: create an eScript (prescription) NFT for a pharmacy */
function createPrescriptionNft(
  issuer: Field,
  subject: Field,
  forestRoot: Field = sampleForestRoot,
): NftData {
  return new NftData({
    nftType: NFT_TYPE_PRESCRIPTION,
    forestRoot,
    issuerWalletId: issuer,
    subjectWalletId: subject,
    issuedAt: Field(20260201),
    expiresAt: Field(20260301),
    revoked: Field(0),
  });
}

// ─── Tests ───────────────────────────────────────────────

describe('Layer 4 — NFT System / User Path', () => {
  // ─── NFT Data Model ──────────────────────────────────

  describe('NFT Data Model', () => {
    test('NftData commitment is deterministic', () => {
      const nft1 = createEligibilityNft(prescriberWalletId, memberWalletId);
      const nft2 = createEligibilityNft(prescriberWalletId, memberWalletId);
      expect(nft1.commitment().toString()).toBe(nft2.commitment().toString());
    });

    test('commitment changes when any field changes', () => {
      const baseNft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const baseCommitment = baseNft.commitment().toString();

      // Change nftType
      const nft2 = new NftData({ ...baseNft, nftType: NFT_TYPE_PRESCRIPTION });
      expect(nft2.commitment().toString()).not.toBe(baseCommitment);

      // Change forestRoot
      const nft3 = new NftData({ ...baseNft, forestRoot: Field(999) });
      expect(nft3.commitment().toString()).not.toBe(baseCommitment);

      // Change issuerWalletId
      const nft4 = new NftData({ ...baseNft, issuerWalletId: Field(888) });
      expect(nft4.commitment().toString()).not.toBe(baseCommitment);

      // Change revoked
      const nft5 = new NftData({ ...baseNft, revoked: Field(1) });
      expect(nft5.commitment().toString()).not.toBe(baseCommitment);
    });

    test('NFT type constants have correct values', () => {
      expect(NFT_TYPE_ELIGIBILITY.toString()).toBe('1');
      expect(NFT_TYPE_PRESCRIPTION.toString()).toBe('2');
    });

    test('different forestRoots produce different commitments', () => {
      const forest2 = new MerkleForest();
      forest2.setLeaf(ForestDomain.MEDICATION, 0n, Poseidon.hash([Field(99)]));
      const otherRoot = forest2.getForestRoot();

      const nft1 = createEligibilityNft(prescriberWalletId, memberWalletId, sampleForestRoot);
      const nft2 = createEligibilityNft(prescriberWalletId, memberWalletId, otherRoot);

      expect(nft1.commitment().toString()).not.toBe(nft2.commitment().toString());
    });

    test('commitment matches manual Poseidon.hash of all 7 fields', () => {
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const manual = Poseidon.hash([
        nft.nftType,
        nft.forestRoot,
        nft.issuerWalletId,
        nft.subjectWalletId,
        nft.issuedAt,
        nft.expiresAt,
        nft.revoked,
      ]);
      expect(nft.commitment().toString()).toBe(manual.toString());
    });
  });

  // ─── NFT Inventory Manager ───────────────────────────

  describe('NFT Inventory Manager', () => {
    test('empty inventory has EMPTY_NFT_ROOT', () => {
      const inventory = new NftInventory();
      expect(inventory.getRoot().toString()).toBe(EMPTY_NFT_ROOT.toString());
    });

    test('mint inserts eligibility NFT and changes root', () => {
      const inventory = new NftInventory();
      const oldRoot = inventory.getRoot();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);

      const { index, newRoot } = inventory.mint(nft);

      expect(index).toBe(0n);
      expect(newRoot.toString()).not.toBe(oldRoot.toString());
      expect(inventory.getRoot().toString()).toBe(newRoot.toString());
    });

    test('getWitness validates inclusion of minted NFT', () => {
      const inventory = new NftInventory();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const { index } = inventory.mint(nft);

      const witness = inventory.getWitness(index);
      const computedRoot = witness.calculateRoot(nft.commitment());
      expect(computedRoot.toString()).toBe(inventory.getRoot().toString());
    });

    test('mint increments count', () => {
      const inventory = new NftInventory();
      expect(inventory.count).toBe(0);

      inventory.mint(createEligibilityNft(prescriberWalletId, memberWalletId));
      expect(inventory.count).toBe(1);

      inventory.mint(createPrescriptionNft(prescriberWalletId, pharmacyWalletId));
      expect(inventory.count).toBe(2);
    });

    test('cannot exceed 64 NFT capacity', () => {
      const inventory = new NftInventory();
      // Fill all 64 slots
      for (let i = 0; i < 64; i++) {
        inventory.mint(
          new NftData({
            nftType: NFT_TYPE_ELIGIBILITY,
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
        inventory.mint(createEligibilityNft(prescriberWalletId, memberWalletId)),
      ).toThrow('NFT inventory full');
    });

    test('revoke marks NFT revoked and changes root', () => {
      const inventory = new NftInventory();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const { index } = inventory.mint(nft);
      const rootBeforeRevoke = inventory.getRoot();

      const newRoot = inventory.revoke(index);
      expect(newRoot.toString()).not.toBe(rootBeforeRevoke.toString());

      // Verify the revoked NFT has revoked=1
      const revokedNft = inventory.getNft(index)!;
      expect(revokedNft.revoked.toString()).toBe('1');

      // Verify the revoked commitment is in the tree
      const witness = inventory.getWitness(index);
      const computedRoot = witness.calculateRoot(revokedNft.commitment());
      expect(computedRoot.toString()).toBe(inventory.getRoot().toString());
    });
  });

  // ─── NftProgram — proveMint ──────────────────────────

  describe('NftProgram — proveMint', () => {
    beforeAll(async () => {
      // Compile ProofGateProgram first (NftProgram depends on it for recursive verification)
      await ProofGateProgram.compile();
      await NftProgram.compile();
    });

    test('generates valid proof when minting eligibility NFT into member wallet', async () => {
      const inventory = new NftInventory();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      // Generate ownership proof
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      // Get witness for empty slot 0
      const witness = inventory.getWitness(0n);
      const oldRoot = inventory.getRoot();

      // Prove the mint
      const result = await NftProgram.proveMint(
        pgResult.proof,
        nft,
        witness,
        oldRoot,
      );

      expect(result.proof).toBeDefined();

      const output = result.proof.publicOutput as unknown as NftOperationOutput;
      expect(output.walletId.toString()).toBe(memberWalletId.toString());
      expect(output.operationType.toString()).toBe(NFT_OP_MINT.toString());
      expect(output.nftCommitment.toString()).toBe(nft.commitment().toString());
      expect(output.oldInventoryRoot.toString()).toBe(oldRoot.toString());
      expect(output.newInventoryRoot.toString()).not.toBe(oldRoot.toString());
    });

    test('proof verifies standalone (simulates offline verification)', async () => {
      const inventory = new NftInventory();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await NftProgram.proveMint(
        pgResult.proof,
        nft,
        witness,
        inventory.getRoot(),
      );

      // Standalone verification (simulates offline NFC/RFID check)
      const isValid = await NftProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });

    test('rejects insertion at occupied slot', async () => {
      const inventory = new NftInventory();
      const nft1 = createEligibilityNft(prescriberWalletId, memberWalletId);
      const nft2 = new NftData({
        ...nft1,
        forestRoot: Field(999),
      });
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      // Mint first NFT at slot 0
      inventory.mint(nft1);

      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      // Try to mint at slot 0 using witness from BEFORE mint — root won't match
      // The inventory root has changed, so using the old empty root will fail
      const emptyInventory = new NftInventory();
      const witnessForSlot0 = emptyInventory.getWitness(0n);

      await expect(
        NftProgram.proveMint(
          pgResult.proof,
          nft2,
          witnessForSlot0,
          inventory.getRoot(), // current root (with slot 0 occupied)
        ),
      ).rejects.toThrow();
    });

    test('rejects subjectWalletId != walletId (wrong recipient)', async () => {
      const inventory = new NftInventory();
      // NFT with pharmacy as subject, but member proves ownership
      const wrongNft = createEligibilityNft(prescriberWalletId, pharmacyWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const witness = inventory.getWitness(0n);

      await expect(
        NftProgram.proveMint(
          pgResult.proof,
          wrongNft,
          witness,
          inventory.getRoot(),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── NftProgram — proveHolding ───────────────────────

  describe('NftProgram — proveHolding', () => {
    test('member proves holding eligibility NFT — valid proof', async () => {
      const inventory = new NftInventory();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      inventory.mint(nft);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await NftProgram.proveHolding(
        pgResult.proof,
        nft,
        witness,
        inventory.getRoot(),
      );

      const output = result.proof.publicOutput as unknown as NftOperationOutput;
      expect(output.walletId.toString()).toBe(memberWalletId.toString());
      expect(output.operationType.toString()).toBe(NFT_OP_VERIFY.toString());
      // Root unchanged for verification
      expect(output.oldInventoryRoot.toString()).toBe(output.newInventoryRoot.toString());
    });

    test('proof verifies standalone (offline at pharmacy)', async () => {
      const inventory = new NftInventory();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      inventory.mint(nft);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await NftProgram.proveHolding(
        pgResult.proof,
        nft,
        witness,
        inventory.getRoot(),
      );

      const isValid = await NftProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });

    test('rejects proof for NFT not in inventory', async () => {
      const inventory = new NftInventory();
      // Don't mint — inventory is empty
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const witness = inventory.getWitness(0n);

      await expect(
        NftProgram.proveHolding(
          pgResult.proof,
          nft,
          witness,
          inventory.getRoot(),
        ),
      ).rejects.toThrow();
    });

    test('rejects revoked NFT', async () => {
      const inventory = new NftInventory();
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const { index } = inventory.mint(nft);

      // Revoke the NFT
      inventory.revoke(index);
      const revokedNft = inventory.getNft(index)!;

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const witness = inventory.getWitness(index);

      await expect(
        NftProgram.proveHolding(
          pgResult.proof,
          revokedNft,
          witness,
          inventory.getRoot(),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── NftProgram — proveHoldingByType ─────────────────

  describe('NftProgram — proveHoldingByType', () => {
    test('pharmacy proves holding PRESCRIPTION type — succeeds', async () => {
      const inventory = new NftInventory();
      const nft = createPrescriptionNft(prescriberWalletId, pharmacyWalletId);
      inventory.mint(nft);

      const preimage = pharmacyWalletPreimage(testPharmacy, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await NftProgram.proveHoldingByType(
        pgResult.proof,
        nft,
        witness,
        inventory.getRoot(),
        NFT_TYPE_PRESCRIPTION,
      );

      const output = result.proof.publicOutput as unknown as NftOperationOutput;
      expect(output.walletId.toString()).toBe(pharmacyWalletId.toString());
      expect(output.operationType.toString()).toBe(NFT_OP_VERIFY.toString());
    });

    test('rejects when type does not match', async () => {
      const inventory = new NftInventory();
      // NFT is ELIGIBILITY type
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      inventory.mint(nft);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyMember(
        memberWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      );

      const witness = inventory.getWitness(0n);

      // Try to prove it's a PRESCRIPTION type — should fail
      await expect(
        NftProgram.proveHoldingByType(
          pgResult.proof,
          nft,
          witness,
          inventory.getRoot(),
          NFT_TYPE_PRESCRIPTION, // wrong type!
        ),
      ).rejects.toThrow();
    });

    test('proof verifies standalone (offline)', async () => {
      const inventory = new NftInventory();
      const nft = createPrescriptionNft(prescriberWalletId, pharmacyWalletId);
      inventory.mint(nft);

      const preimage = pharmacyWalletPreimage(testPharmacy, TEST_ENROLLMENT_KEY);
      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyWalletId,
        preimage[0]!, preimage[1]!, preimage[2]!,
      );

      const witness = inventory.getWitness(0n);
      const result = await NftProgram.proveHoldingByType(
        pgResult.proof,
        nft,
        witness,
        inventory.getRoot(),
        NFT_TYPE_PRESCRIPTION,
      );

      const isValid = await NftProgram.verify(result.proof);
      expect(isValid).toBe(true);
    });
  });

  // ─── Portable Credential ─────────────────────────────

  describe('Portable Credential Serialization', () => {
    test('serializeCredential produces valid JSON', () => {
      // Create a mock proof-like object for serialization
      const mockOutput = new NftOperationOutput({
        walletId: memberWalletId,
        operationType: NFT_OP_VERIFY,
        nftCommitment: Poseidon.hash([Field(1)]),
        oldInventoryRoot: EMPTY_NFT_ROOT,
        newInventoryRoot: EMPTY_NFT_ROOT,
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
        'nft-holding',
        Field(12345),
      );

      expect(credential.version).toBe(1);
      expect(credential.proofType).toBe('nft-holding');
      expect(credential.publicOutput.walletId).toBe(memberWalletId.toString());
      expect(credential.publicOutput.operationType).toBe(NFT_OP_VERIFY.toString());
      expect(credential.verificationKeyHash).toBe('12345');
      expect(credential.expiresAt).toBe(0);
      expect(credential.createdAt).toBeGreaterThan(0);
    });

    test('deserializeCredential reconstructs credential', () => {
      const original: PortableCredential = {
        version: 1,
        proofType: 'nft-holding',
        proofJson: {
          publicInput: [],
          publicOutput: ['1', '2'],
          maxProofsVerified: 2,
          proof: 'test-proof-data',
        },
        publicOutput: {
          walletId: '123',
          operationType: '2',
          nftCommitment: '456',
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
      const mockOutput = new NftOperationOutput({
        walletId: pharmacyWalletId,
        operationType: NFT_OP_MINT,
        nftCommitment: Poseidon.hash([Field(42)]),
        oldInventoryRoot: EMPTY_NFT_ROOT,
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
        'nft-mint',
        Field(777),
        1800000000000,
      );

      const json = JSON.stringify(credential);
      const restored = deserializeCredential(json);

      expect(restored.version).toBe(credential.version);
      expect(restored.proofType).toBe(credential.proofType);
      expect(restored.publicOutput.walletId).toBe(credential.publicOutput.walletId);
      expect(restored.publicOutput.nftCommitment).toBe(credential.publicOutput.nftCommitment);
      expect(restored.verificationKeyHash).toBe(credential.verificationKeyHash);
      expect(restored.expiresAt).toBe(1800000000000);
    });
  });

  // ─── User Wallet Service ─────────────────────────────

  describe('User Wallet Service', () => {
    let store: InMemoryStore;
    let memberInventory: NftInventory;
    let registry: WalletRegistry;
    let lifecycleTree: MerkleTree;

    beforeAll(async () => {
      // Compile StateTransitionProgram (ProofGate + NftProgram already compiled above)
      await StateTransitionProgram.compile();
    });

    beforeEach(() => {
      store = new InMemoryStore();
      memberInventory = new NftInventory();
      registry = new WalletRegistry();
      lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);

      // Register the member wallet in the registry
      const memberIndex = registry.register(memberWalletId);

      // Set lifecycle to ELIGIBLE (required for wallet updates)
      const lifecycleLeaf = lifecycleLeafCommitment(memberWalletId, LIFECYCLE_ELIGIBLE);
      lifecycleTree.setLeaf(memberIndex, lifecycleLeaf);
    });

    test('mintNft orchestrates full proof chain (ProofGate → NftProgram → StateTransition)', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      const result = await service.mintNft(
        preimage,
        'member',
        nft,
        LIFECYCLE_ELIGIBLE,
      );

      // NftOperationProof exists
      expect(result.nftProof).toBeDefined();

      // StateTransitionProof exists
      expect(result.stateProof).toBeDefined();

      // NFT index assigned
      expect(result.nftIndex).toBe(0n);

      // Inventory updated
      expect(service.getNftCount()).toBe(1);
    });

    test('proveNftHolding returns verifiable portable proof', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      // First mint an NFT
      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const mintResult = await service.mintNft(preimage, 'member', nft, LIFECYCLE_ELIGIBLE);

      // Now prove holding
      const holdingProof = await service.proveNftHolding(preimage, 'member', mintResult.nftIndex);

      expect(holdingProof).toBeDefined();

      // Verify the proof standalone
      const isValid = await NftProgram.verify(holdingProof);
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

      const nft = createEligibilityNft(prescriberWalletId, memberWalletId);
      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);
      const mintResult = await service.mintNft(preimage, 'member', nft, LIFECYCLE_ELIGIBLE);

      const holdingProof = await service.proveNftHolding(preimage, 'member', mintResult.nftIndex);

      const credential = service.exportCredential(
        holdingProof as any,
        'nft-holding',
        Field(12345),
      );

      expect(credential.version).toBe(1);
      expect(credential.proofType).toBe('nft-holding');
      expect(credential.publicOutput.walletId).toBe(memberWalletId.toString());

      // Should be JSON serializable
      const json = JSON.stringify(credential);
      expect(json.length).toBeGreaterThan(0);
    });

    test('tracks NFT count and inventory state', async () => {
      const service = new UserWalletService(
        store,
        memberWalletId,
        memberInventory,
        registry,
        lifecycleTree,
      );

      expect(service.getNftCount()).toBe(0);

      const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

      // Mint first NFT
      const nft1 = createEligibilityNft(prescriberWalletId, memberWalletId);
      await service.mintNft(preimage, 'member', nft1, LIFECYCLE_ELIGIBLE);
      expect(service.getNftCount()).toBe(1);

      // Verify inventory is accessible
      const inventory = service.getInventory();
      expect(inventory.getNft(0n)).toBeDefined();
      expect(inventory.getNft(0n)!.nftType.toString()).toBe(NFT_TYPE_ELIGIBILITY.toString());
    });
  });
});
