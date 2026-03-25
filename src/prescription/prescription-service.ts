import { Field, MerkleTree } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import {
  WalletRegistry,
  WalletState,
} from '../wallets/wallet-state.js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION } from '../credentials/credential-data.js';
import { CredentialInventory } from '../credentials/credential-inventory.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { hashString } from '../zkp/hash-utils.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ADJUDICATED,
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
  credentialData: CredentialData;
  credentialIndex: bigint;
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
  newCredentialData: CredentialData;
  newInventoryRoot: Field;
  statusEntry: PrescriptionStatusData;
}

/**
 * Result of a pharmacy-to-pharmacy transfer.
 */
export interface TransferResult {
  transferProof: Awaited<ReturnType<typeof PrescriptionProgram.proveTransfer>>['proof'];
  sourceNewInventoryRoot: Field;
  destCredentialData: CredentialData;
  destCredentialIndex: bigint;
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
   * Build a PRESCRIPTION CredentialData with prescription data in the MEDICATION tree
   * and an initial ACTIVE status in the TRANSACTION tree.
   *
   * @param prescriberWalletId — who wrote the prescription (issuer)
   * @param memberWalletId — patient
   * @param pharmacyWalletId — pharmacy that will hold the credential (subject)
   * @param prescriptionData — the prescription to embed
   * @param forest — MerkleForest to insert into
   * @param rxLeafIndex — leaf index in the MEDICATION tree
   * @param issuedAt — issue date (CCYYMMDD)
   * @param expiresAt — expiration date (CCYYMMDD, Field(0) = never)
   * @param isEmergency — flag emergency prescription in initial status
   */
  buildPrescriptionCredential(
    prescriberWalletId: Field,
    memberWalletId: Field,
    pharmacyWalletId: Field,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    issuedAt: Field,
    expiresAt: Field = Field(0),
    isEmergency: boolean = false,
  ): { credentialData: CredentialData; initialStatus: PrescriptionStatusData } {
    // Insert prescription commitment into MEDICATION tree
    forest.setLeaf(
      ForestDomain.MEDICATION,
      rxLeafIndex,
      prescriptionData.commitment(),
    );

    // Build initial ACTIVE status entry at TRANSACTION leaf 0
    const initialStatus = new PrescriptionStatusData({
      prescriptionHash: prescriptionData.commitment(),
      status: RX_STATUS_ADJUDICATED,
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

    const credentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: prescriberWalletId,
      subjectWalletId: pharmacyWalletId,
      issuedAt,
      expiresAt,
      revoked: Field(0),
    });

    return { credentialData, initialStatus };
  }

  /**
   * Mint a prescription credential into a pharmacy's inventory (off-chain).
   *
   * This is the cross-wallet mint: the pharmacy doesn't need to be online.
   * On-chain settlement via CareContract.updateWalletState must be done separately.
   */
  mintPrescriptionToPharmacy(
    pharmacyWalletId: Field,
    credentialData: CredentialData,
    pharmacyInventory: CredentialInventory,
  ): { credentialIndex: bigint; newInventoryRoot: Field; newRegistryRoot: Field } {
    // Insert credential into pharmacy's inventory
    const { index: credentialIndex, newRoot: newInventoryRoot } =
      pharmacyInventory.mint(credentialData);

    // Update wallet registry with new inventory root
    const oldState = this.registry.getState(pharmacyWalletId);
    const newNonce = Field(BigInt(oldState.nonce.toString()) + 1n);
    const newWalletState = new WalletState({
      walletId: pharmacyWalletId,
      credentialInventoryRoot: newInventoryRoot,
      nonce: newNonce,
    });
    this.registry.updateState(pharmacyWalletId, newWalletState);

    return {
      credentialIndex,
      newInventoryRoot,
      newRegistryRoot: this.registry.getRoot(),
    };
  }

  /**
   * Full prescription issuance flow: build credential + mint to pharmacy.
   *
   * @returns PrescriptionResult with credential data, proof metadata, and registry state
   */
  async issuePrescription(
    prescriberWalletId: Field,
    memberWalletId: Field,
    pharmacyWalletId: Field,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    pharmacyInventory: CredentialInventory,
    rxLeafIndex: bigint,
    issuedAt: Field,
    expiresAt: Field = Field(0),
    isEmergency: boolean = false,
  ): Promise<PrescriptionResult> {
    // 1. Build credential with prescription + initial ACTIVE status
    const { credentialData, initialStatus } = this.buildPrescriptionCredential(
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
    const { credentialIndex, newInventoryRoot, newRegistryRoot } =
      this.mintPrescriptionToPharmacy(
        pharmacyWalletId,
        credentialData,
        pharmacyInventory,
      );

    // 3. Store proof metadata
    const proofId = `rx-issue-${credentialIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify({
      credentialIndex: credentialIndex.toString(),
      prescriberWalletId: prescriberWalletId.toString(),
      pharmacyWalletId: pharmacyWalletId.toString(),
    }));

    return {
      credentialData,
      credentialIndex,
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
   * 3. Create new CredentialData with updated forestRoot
   * 4. Replace credential in pharmacy inventory (same slot, new commitment)
   * 5. Update wallet registry
   *
   * @param pharmacyWalletId — the pharmacy holding the credential
   * @param credentialData — the current prescription credential
   * @param prescriptionData — the prescription in MEDICATION tree
   * @param oldStatus — the current status entry
   * @param newStatus — the new status entry to add
   * @param forest — the MerkleForest (will be mutated after proof)
   * @param rxLeafIndex — prescription leaf index in MEDICATION tree
   * @param currentStatusIndex — current status leaf index in TRANSACTION tree
   * @param pharmacyInventory — the pharmacy's credential inventory
   * @param credentialSlotIndex — the credential's slot in the inventory
   */
  async updateStatus(
    pharmacyWalletId: Field,
    credentialData: CredentialData,
    prescriptionData: PrescriptionData,
    oldStatus: PrescriptionStatusData,
    newStatus: PrescriptionStatusData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    currentStatusIndex: bigint,
    pharmacyInventory: CredentialInventory,
    credentialSlotIndex: bigint,
    prescriberPreimage: Field[] = [],
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
      credentialData,
      prescriptionData,
      oldStatus,
      newStatus,
      forestRoots,
      medicationWitness,
      oldStatusWitness,
      newSlotWitness,
      prescriberPreimage[0] ?? Field(0),
      prescriberPreimage[1] ?? Field(0),
      prescriberPreimage[2] ?? Field(0),
    );

    // Update TRANSACTION tree
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      newSlotIndex,
      newStatus.commitment(),
    );

    // Create new CredentialData with updated forestRoot
    const newCredentialData = new CredentialData({
      credentialType: credentialData.credentialType,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: credentialData.issuerWalletId,
      subjectWalletId: credentialData.subjectWalletId,
      issuedAt: credentialData.issuedAt,
      expiresAt: credentialData.expiresAt,
      revoked: credentialData.revoked,
    });

    // Replace credential in inventory (same slot)
    const newInventoryRoot = pharmacyInventory.updateCredential(
      credentialSlotIndex,
      newCredentialData,
    );

    // Update wallet registry
    const oldState = this.registry.getState(pharmacyWalletId);
    const newNonce = Field(BigInt(oldState.nonce.toString()) + 1n);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        credentialInventoryRoot: newInventoryRoot,
        nonce: newNonce,
      }),
    );

    // Store proof
    const proofId = `rx-status-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      newCredentialData,
      newInventoryRoot,
      statusEntry: newStatus,
    };
  }

  // ─── Transfer ─────────────────────────────────────────────

  /**
   * Transfer a prescription from one pharmacy to another.
   *
   * 1. Generate PrescriptionProgram.proveTransfer proof (source side)
   * 2. Remove credential from source inventory
   * 3. Build dest forest (carries forward history + TRANSFERRED + new ACTIVE)
   * 4. Create new CredentialData for dest pharmacy
   * 5. Mint into dest inventory
   * 6. Update wallet registry for both pharmacies
   */
  async transferPrescription(
    sourcePharmacyWalletId: Field,
    destPharmacyWalletId: Field,
    credentialData: CredentialData,
    prescriptionData: PrescriptionData,
    oldStatus: PrescriptionStatusData,
    transferStatus: PrescriptionStatusData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    currentStatusIndex: bigint,
    sourceInventory: CredentialInventory,
    destInventory: CredentialInventory,
    sourceCredentialSlotIndex: bigint,
    prescriberPreimage: Field[] = [],
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
      credentialData,
      prescriptionData,
      oldStatus,
      transferStatus,
      forestRoots,
      medicationWitness,
      oldStatusWitness,
      transferSlotWitness,
      destPharmacyWalletId,
      prescriberPreimage[0] ?? Field(0),
      prescriberPreimage[1] ?? Field(0),
      prescriberPreimage[2] ?? Field(0),
    );

    // Update source forest with TRANSFERRED status
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      transferSlotIndex,
      transferStatus.commitment(),
    );

    // Remove credential from source inventory
    const sourceNewInventoryRoot = sourceInventory.removeCredential(sourceCredentialSlotIndex);

    // Update source wallet registry
    const sourceOldState = this.registry.getState(sourcePharmacyWalletId);
    const sourceNewNonce = Field(BigInt(sourceOldState.nonce.toString()) + 1n);
    this.registry.updateState(
      sourcePharmacyWalletId,
      new WalletState({
        walletId: sourcePharmacyWalletId,
        credentialInventoryRoot: sourceNewInventoryRoot,
        nonce: sourceNewNonce,
      }),
    );

    // Build dest forest: carry forward all history + add new ACTIVE entry
    // The dest forest has the same MEDICATION tree but TRANSACTION carries forward
    // with the TRANSFERRED entry + a fresh ACTIVE entry
    const destActiveStatusIndex = transferSlotIndex + 1n;
    const destActiveStatus = new PrescriptionStatusData({
      prescriptionHash: prescriptionData.commitment(),
      status: RX_STATUS_ADJUDICATED,
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

    // Create new CredentialData for dest pharmacy
    const destCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: credentialData.issuerWalletId,
      subjectWalletId: destPharmacyWalletId,
      issuedAt: credentialData.issuedAt,
      expiresAt: credentialData.expiresAt,
      revoked: Field(0),
    });

    // Mint into dest inventory
    const { index: destCredentialIndex, newRoot: destNewInventoryRoot } =
      destInventory.mint(destCredentialData);

    // Update dest wallet registry
    const destOldState = this.registry.getState(destPharmacyWalletId);
    const destNewNonce = Field(BigInt(destOldState.nonce.toString()) + 1n);
    this.registry.updateState(
      destPharmacyWalletId,
      new WalletState({
        walletId: destPharmacyWalletId,
        credentialInventoryRoot: destNewInventoryRoot,
        nonce: destNewNonce,
      }),
    );

    // Store proof
    const proofId = `rx-transfer-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      transferProof: result.proof,
      sourceNewInventoryRoot,
      destCredentialData,
      destCredentialIndex,
      destNewInventoryRoot,
      destNewRegistryRoot: this.registry.getRoot(),
    };
  }

  // ─── Verification (off-chain) ─────────────────────────────

  /**
   * Verify that prescription data matches the credential's forest root.
   *
   * Off-chain check: reconstructs the forest root from the MEDICATION tree
   * and verifies it matches CredentialData.forestRoot.
   */
  verifyPrescriptionForest(
    credentialData: CredentialData,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
  ): boolean {
    // Check prescription is at the expected leaf
    const storedLeaf = forest.getLeaf(ForestDomain.MEDICATION, rxLeafIndex);
    if (storedLeaf.toString() !== prescriptionData.commitment().toString()) {
      return false;
    }

    // Check forest root matches credential
    const forestRoot = forest.getForestRoot();
    return forestRoot.toString() === credentialData.forestRoot.toString();
  }
}
