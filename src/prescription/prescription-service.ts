import { Field, MerkleTree } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import {
  WalletRegistry,
  WalletState,
} from '../wallets/wallet-state.js';
import { NftData, NFT_TYPE_PRESCRIPTION } from '../nft/nft-data.js';
import { NftInventory } from '../nft/nft-inventory.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { hashString } from '../zkp/hash-utils.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ACTIVE,
  RX_STATUS_TRANSFERRED,
  EMERGENCY_FILL_HASH,
  isValidStatusTransition,
} from './prescription-data.js';
import { PrescriptionProgram } from './prescription-program.js';

// ─── Result Types ───────────────────────────────────────────────

/**
 * Result of issuing a new prescription.
 */
export interface PrescriptionResult {
  nftData: NftData;
  nftIndex: bigint;
  newInventoryRoot: Field;
  newRegistryRoot: Field;
  prescriptionData: PrescriptionData;
  initialStatus: PrescriptionStatusData;
}

/**
 * Result of a ZK-enforced status update.
 */
export interface StatusUpdateResult {
  proof: Awaited<ReturnType<typeof PrescriptionProgram.proveStatusUpdate>>['proof'];
  newNftData: NftData;
  newInventoryRoot: Field;
  statusEntry: PrescriptionStatusData;
}

/**
 * Result of a pharmacy-to-pharmacy transfer.
 */
export interface TransferResult {
  transferProof: Awaited<ReturnType<typeof PrescriptionProgram.proveTransfer>>['proof'];
  sourceNewInventoryRoot: Field;
  destNftData: NftData;
  destNftIndex: bigint;
  destNewInventoryRoot: Field;
  destNewRegistryRoot: Field;
}

// ─── PrescriptionService ────────────────────────────────────────

/**
 * PrescriptionService — orchestration layer for the prescription flow.
 *
 * Manages prescription creation, cross-wallet minting, ZK-enforced
 * status updates, and pharmacy-to-pharmacy transfers.
 *
 * Preconditions:
 *   await PrescriptionProgram.compile();  // for status updates + transfers
 */
export class PrescriptionService {
  private store: ILocalStore;
  private registry: WalletRegistry;
  private lifecycleTree: MerkleTree;

  constructor(
    store: ILocalStore,
    registry: WalletRegistry,
    lifecycleTree: MerkleTree,
  ) {
    this.store = store;
    this.registry = registry;
    this.lifecycleTree = lifecycleTree;
  }

  // ─── Create Prescription ──────────────────────────────────

  /**
   * Build a PRESCRIPTION NftData with prescription data in the MEDICATION tree
   * and an initial ACTIVE status in the TRANSACTION tree.
   *
   * @param prescriberWalletId — who wrote the prescription (issuer)
   * @param memberWalletId — patient
   * @param pharmacyWalletId — pharmacy that will hold the NFT (subject)
   * @param prescriptionData — the prescription to embed
   * @param forest — MerkleForest to insert into
   * @param rxLeafIndex — leaf index in the MEDICATION tree
   * @param issuedAt — issue date (CCYYMMDD)
   * @param expiresAt — expiration date (CCYYMMDD, Field(0) = never)
   * @param isEmergency — flag emergency prescription in initial status
   */
  buildPrescriptionNft(
    prescriberWalletId: Field,
    memberWalletId: Field,
    pharmacyWalletId: Field,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    issuedAt: Field,
    expiresAt: Field = Field(0),
    isEmergency: boolean = false,
  ): { nftData: NftData; initialStatus: PrescriptionStatusData } {
    // Insert prescription commitment into MEDICATION tree
    forest.setLeaf(
      ForestDomain.MEDICATION,
      rxLeafIndex,
      prescriptionData.commitment(),
    );

    // Build initial ACTIVE status entry at TRANSACTION leaf 0
    const initialStatus = new PrescriptionStatusData({
      prescriptionHash: prescriptionData.commitment(),
      status: RX_STATUS_ACTIVE,
      updatedByWalletId: prescriberWalletId,
      updatedAt: issuedAt,
      pharmacyWalletId,
      fillQuantity: Field(0),
      notesHash: isEmergency ? EMERGENCY_FILL_HASH : Field(0),
    });

    // Insert initial status into TRANSACTION tree at index 0
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      0n,
      initialStatus.commitment(),
    );

    const nftData = new NftData({
      nftType: NFT_TYPE_PRESCRIPTION,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: prescriberWalletId,
      subjectWalletId: pharmacyWalletId,
      issuedAt,
      expiresAt,
      revoked: Field(0),
    });

    return { nftData, initialStatus };
  }

  /**
   * Mint a prescription NFT into a pharmacy's inventory (off-chain).
   *
   * This is the cross-wallet mint: the pharmacy doesn't need to be online.
   * On-chain settlement via CareContract.updateWalletState must be done separately.
   */
  mintPrescriptionToPharmacy(
    pharmacyWalletId: Field,
    nftData: NftData,
    pharmacyInventory: NftInventory,
  ): { nftIndex: bigint; newInventoryRoot: Field; newRegistryRoot: Field } {
    // Insert NFT into pharmacy's inventory
    const { index: nftIndex, newRoot: newInventoryRoot } =
      pharmacyInventory.mint(nftData);

    // Update wallet registry with new inventory root
    const oldState = this.registry.getState(pharmacyWalletId);
    const newNonce = Field(BigInt(oldState.nonce.toString()) + 1n);
    const newWalletState = new WalletState({
      walletId: pharmacyWalletId,
      nftInventoryRoot: newInventoryRoot,
      nonce: newNonce,
    });
    this.registry.updateState(pharmacyWalletId, newWalletState);

    return {
      nftIndex,
      newInventoryRoot,
      newRegistryRoot: this.registry.getRoot(),
    };
  }

  /**
   * Full prescription issuance flow: build NFT + mint to pharmacy.
   *
   * @returns PrescriptionResult with NFT data, proof metadata, and registry state
   */
  async issuePrescription(
    prescriberWalletId: Field,
    memberWalletId: Field,
    pharmacyWalletId: Field,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    pharmacyInventory: NftInventory,
    rxLeafIndex: bigint,
    issuedAt: Field,
    expiresAt: Field = Field(0),
    isEmergency: boolean = false,
  ): Promise<PrescriptionResult> {
    // 1. Build NFT with prescription + initial ACTIVE status
    const { nftData, initialStatus } = this.buildPrescriptionNft(
      prescriberWalletId,
      memberWalletId,
      pharmacyWalletId,
      prescriptionData,
      forest,
      rxLeafIndex,
      issuedAt,
      expiresAt,
      isEmergency,
    );

    // 2. Mint into pharmacy's inventory
    const { nftIndex, newInventoryRoot, newRegistryRoot } =
      this.mintPrescriptionToPharmacy(
        pharmacyWalletId,
        nftData,
        pharmacyInventory,
      );

    // 3. Store proof metadata
    const proofId = `rx-issue-${nftIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify({
      nftIndex: nftIndex.toString(),
      prescriberWalletId: prescriberWalletId.toString(),
      pharmacyWalletId: pharmacyWalletId.toString(),
    }));

    return {
      nftData,
      nftIndex,
      newInventoryRoot,
      newRegistryRoot,
      prescriptionData,
      initialStatus,
    };
  }

  // ─── Status Update (ZK-enforced) ─────────────────────────

  /**
   * Update prescription status with a ZK proof of valid transition.
   *
   * 1. Generate PrescriptionProgram.proveStatusUpdate proof
   * 2. Update TRANSACTION tree in forest
   * 3. Create new NftData with updated forestRoot
   * 4. Replace NFT in pharmacy inventory (same slot, new commitment)
   * 5. Update wallet registry
   *
   * @param pharmacyWalletId — the pharmacy holding the NFT
   * @param nftData — the current prescription NFT
   * @param prescriptionData — the prescription in MEDICATION tree
   * @param oldStatus — the current status entry
   * @param newStatus — the new status entry to add
   * @param forest — the MerkleForest (will be mutated after proof)
   * @param rxLeafIndex — prescription leaf index in MEDICATION tree
   * @param currentStatusIndex — current status leaf index in TRANSACTION tree
   * @param pharmacyInventory — the pharmacy's NFT inventory
   * @param nftSlotIndex — the NFT's slot in the inventory
   */
  async updateStatus(
    pharmacyWalletId: Field,
    nftData: NftData,
    prescriptionData: PrescriptionData,
    oldStatus: PrescriptionStatusData,
    newStatus: PrescriptionStatusData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    currentStatusIndex: bigint,
    pharmacyInventory: NftInventory,
    nftSlotIndex: bigint,
  ): Promise<StatusUpdateResult> {
    // Validate transition off-chain first
    const oldStatusVal = BigInt(oldStatus.status.toString());
    const newStatusVal = BigInt(newStatus.status.toString());
    if (!isValidStatusTransition(oldStatusVal, newStatusVal)) {
      throw new Error(
        `Invalid status transition: ${oldStatusVal} → ${newStatusVal}`,
      );
    }

    // Build witnesses BEFORE mutating the forest
    const forestRoots = ForestRoots.fromForest(forest);
    const medicationWitness = forest.getWitness(
      ForestDomain.MEDICATION,
      rxLeafIndex,
    );
    const oldStatusWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      currentStatusIndex,
    );
    const newSlotIndex = currentStatusIndex + 1n;
    const newSlotWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      newSlotIndex,
    );

    // Generate ZK proof
    const result = await PrescriptionProgram.proveStatusUpdate(
      nftData,
      prescriptionData,
      oldStatus,
      newStatus,
      forestRoots,
      medicationWitness,
      oldStatusWitness,
      newSlotWitness,
    );

    // Update TRANSACTION tree
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      newSlotIndex,
      newStatus.commitment(),
    );

    // Create new NftData with updated forestRoot
    const newNftData = new NftData({
      nftType: nftData.nftType,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: nftData.issuerWalletId,
      subjectWalletId: nftData.subjectWalletId,
      issuedAt: nftData.issuedAt,
      expiresAt: nftData.expiresAt,
      revoked: nftData.revoked,
    });

    // Replace NFT in inventory (same slot)
    const newInventoryRoot = pharmacyInventory.updateNft(
      nftSlotIndex,
      newNftData,
    );

    // Update wallet registry
    const oldState = this.registry.getState(pharmacyWalletId);
    const newNonce = Field(BigInt(oldState.nonce.toString()) + 1n);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        nftInventoryRoot: newInventoryRoot,
        nonce: newNonce,
      }),
    );

    // Store proof
    const proofId = `rx-status-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      newNftData,
      newInventoryRoot,
      statusEntry: newStatus,
    };
  }

  // ─── Transfer ─────────────────────────────────────────────

  /**
   * Transfer a prescription from one pharmacy to another.
   *
   * 1. Generate PrescriptionProgram.proveTransfer proof (source side)
   * 2. Remove NFT from source inventory
   * 3. Build dest forest (carries forward history + TRANSFERRED + new ACTIVE)
   * 4. Create new NftData for dest pharmacy
   * 5. Mint into dest inventory
   * 6. Update wallet registry for both pharmacies
   */
  async transferPrescription(
    sourcePharmacyWalletId: Field,
    destPharmacyWalletId: Field,
    nftData: NftData,
    prescriptionData: PrescriptionData,
    oldStatus: PrescriptionStatusData,
    transferStatus: PrescriptionStatusData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    currentStatusIndex: bigint,
    sourceInventory: NftInventory,
    destInventory: NftInventory,
    sourceNftSlotIndex: bigint,
  ): Promise<TransferResult> {
    // Build witnesses BEFORE mutating
    const forestRoots = ForestRoots.fromForest(forest);
    const medicationWitness = forest.getWitness(
      ForestDomain.MEDICATION,
      rxLeafIndex,
    );
    const oldStatusWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      currentStatusIndex,
    );
    const transferSlotIndex = currentStatusIndex + 1n;
    const transferSlotWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      transferSlotIndex,
    );

    // Generate transfer proof
    const result = await PrescriptionProgram.proveTransfer(
      nftData,
      prescriptionData,
      oldStatus,
      transferStatus,
      forestRoots,
      medicationWitness,
      oldStatusWitness,
      transferSlotWitness,
      destPharmacyWalletId,
    );

    // Update source forest with TRANSFERRED status
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      transferSlotIndex,
      transferStatus.commitment(),
    );

    // Remove NFT from source inventory
    const sourceNewInventoryRoot = sourceInventory.removeNft(sourceNftSlotIndex);

    // Update source wallet registry
    const sourceOldState = this.registry.getState(sourcePharmacyWalletId);
    const sourceNewNonce = Field(BigInt(sourceOldState.nonce.toString()) + 1n);
    this.registry.updateState(
      sourcePharmacyWalletId,
      new WalletState({
        walletId: sourcePharmacyWalletId,
        nftInventoryRoot: sourceNewInventoryRoot,
        nonce: sourceNewNonce,
      }),
    );

    // Build dest forest: carry forward all history + add new ACTIVE entry
    // The dest forest has the same MEDICATION tree but TRANSACTION carries forward
    // with the TRANSFERRED entry + a fresh ACTIVE entry
    const destActiveStatusIndex = transferSlotIndex + 1n;
    const destActiveStatus = new PrescriptionStatusData({
      prescriptionHash: prescriptionData.commitment(),
      status: RX_STATUS_ACTIVE,
      updatedByWalletId: destPharmacyWalletId,
      updatedAt: transferStatus.updatedAt,
      pharmacyWalletId: destPharmacyWalletId,
      fillQuantity: Field(0),
      notesHash: Field(0),
    });
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      destActiveStatusIndex,
      destActiveStatus.commitment(),
    );

    // Create new NftData for dest pharmacy
    const destNftData = new NftData({
      nftType: NFT_TYPE_PRESCRIPTION,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: nftData.issuerWalletId,
      subjectWalletId: destPharmacyWalletId,
      issuedAt: nftData.issuedAt,
      expiresAt: nftData.expiresAt,
      revoked: Field(0),
    });

    // Mint into dest inventory
    const { index: destNftIndex, newRoot: destNewInventoryRoot } =
      destInventory.mint(destNftData);

    // Update dest wallet registry
    const destOldState = this.registry.getState(destPharmacyWalletId);
    const destNewNonce = Field(BigInt(destOldState.nonce.toString()) + 1n);
    this.registry.updateState(
      destPharmacyWalletId,
      new WalletState({
        walletId: destPharmacyWalletId,
        nftInventoryRoot: destNewInventoryRoot,
        nonce: destNewNonce,
      }),
    );

    // Store proof
    const proofId = `rx-transfer-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      transferProof: result.proof,
      sourceNewInventoryRoot,
      destNftData,
      destNftIndex,
      destNewInventoryRoot,
      destNewRegistryRoot: this.registry.getRoot(),
    };
  }

  // ─── Verification (off-chain) ─────────────────────────────

  /**
   * Verify that prescription data matches the NFT's forest root.
   *
   * Off-chain check: reconstructs the forest root from the MEDICATION tree
   * and verifies it matches NftData.forestRoot.
   */
  verifyPrescriptionForest(
    nftData: NftData,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
  ): boolean {
    // Check prescription is at the expected leaf
    const storedLeaf = forest.getLeaf(ForestDomain.MEDICATION, rxLeafIndex);
    if (storedLeaf.toString() !== prescriptionData.commitment().toString()) {
      return false;
    }

    // Check forest root matches NFT
    const forestRoot = forest.getForestRoot();
    return forestRoot.toString() === nftData.forestRoot.toString();
  }
}
