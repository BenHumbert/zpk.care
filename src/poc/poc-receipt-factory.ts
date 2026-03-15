/**
 * PoC Receipt Factory — Creates mock L2Receipt, AuditEvent, and ClaimAccumulatorEntry
 * objects for the proof-of-concept testing suite.
 *
 * Bypasses ZK proof generation entirely while producing properly structured
 * data that exercises the full L2 pipeline: receipts, batches, audit log,
 * claim accumulator, and entity node queries.
 *
 * Uses the same wallet derivation functions as production to ensure walletIds
 * are identical to what real enrollment would produce.
 */

import { Field, Poseidon } from 'o1js';
import type { L2Receipt } from '../l2/l2-types.js';
import type { AuditEvent } from '../audit/audit-types.js';
import type { ClaimLeaf, ClaimMetadata, ClaimAccumulatorEntry } from '../l2/claim-accumulator-types.js';
import { computeClaimLeafHash } from '../l2/claim-accumulator-types.js';
import { AuditService } from '../audit/audit-service.js';
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
} from '../wallets/wallet-derivation.js';
import { hashString } from '../zkp/hash-utils.js';
import { DEMO_MEMBERS, DEMO_PRESCRIBERS, DEMO_PHARMACIES, DEMO_MEDICATIONS } from '../data/index.js';
import type { DemoMedication } from '../data/index.js';

// ─── Wallet ID Derivation ────────────────────────────────

export interface DerivedWallets {
  members: { walletId: Field; walletIdStr: string; displayName: string }[];
  prescribers: { walletId: Field; walletIdStr: string; displayName: string }[];
  pharmacies: { walletId: Field; walletIdStr: string; displayName: string }[];
}

/**
 * Pre-compute walletIds for the PoC network.
 * Uses the same derivation functions as production.
 */
export function deriveAllWalletIds(): DerivedWallets {
  const members = DEMO_MEMBERS.slice(0, 5).map((m) => {
    const walletId = deriveMemberWalletId(m.localData, m.enrollmentKey);
    return {
      walletId,
      walletIdStr: walletId.toString(),
      displayName: `${m.localData.firstName} ${m.localData.lastName}`,
    };
  });

  const prescribers = DEMO_PRESCRIBERS.slice(0, 2).map((p) => {
    const walletId = derivePrescriberWalletId(p.localData, p.enrollmentKey);
    return {
      walletId,
      walletIdStr: walletId.toString(),
      displayName: `Dr. ${p.lastName}`,
    };
  });

  const pharmacies = DEMO_PHARMACIES.slice(0, 2).map((p) => {
    const walletId = derivePharmacyWalletId(p.localData, p.enrollmentKey);
    return {
      walletId,
      walletIdStr: walletId.toString(),
      displayName: p.storeName,
    };
  });

  return { members, prescribers, pharmacies };
}

// ─── Per-Partition State ─────────────────────────────────

export interface PartitionState {
  registryRoot: Field;
  lifecycleRoot: Field;
  walletCount: Field;
  chainHash: Field;
  nextSeqNum: bigint;
  nextClaimLeafIndex: bigint;
}

/**
 * ReceiptFactory — creates mock receipts with proper Poseidon audit chain.
 *
 * Maintains per-partition state so that roots, sequence numbers, and
 * audit chain hashes stay consistent across sequential receipt creation.
 */
export class ReceiptFactory {
  private partitionStates: Map<number, PartitionState> = new Map();
  private readonly partitionCount: number;

  constructor(
    partitionCount: number,
    initialRegistryRoot: Field,
    initialLifecycleRoot: Field,
  ) {
    this.partitionCount = partitionCount;
    for (let i = 0; i < partitionCount; i++) {
      this.partitionStates.set(i, {
        registryRoot: initialRegistryRoot,
        lifecycleRoot: initialLifecycleRoot,
        walletCount: Field(0),
        chainHash: Field(BigInt(AuditService.GENESIS_HASH)),
        nextSeqNum: 0n,
        nextClaimLeafIndex: 0n,
      });
    }
  }

  /**
   * Get the partition a walletId routes to.
   * Mirrors getPartition() from l2-partition.ts.
   */
  getPartition(walletId: string): number {
    const bigVal = BigInt(walletId);
    return Number(bigVal % BigInt(this.partitionCount));
  }

  /**
   * Create a registration receipt + audit event for a new wallet.
   */
  createRegistrationReceipt(
    walletId: Field,
    partition: number,
  ): { receipt: L2Receipt; auditEvent: AuditEvent } {
    const ps = this.partitionStates.get(partition)!;
    const seqNum = ps.nextSeqNum;
    const walletIdStr = walletId.toString();

    // Simulate root updates (registration increments wallet count)
    const newWalletCount = ps.walletCount.add(1);
    const newRegistryRoot = Poseidon.hash([ps.registryRoot, walletId, newWalletCount]);
    const newLifecycleRoot = Poseidon.hash([ps.lifecycleRoot, walletId, Field(1)]);

    const receiptId = `poc-reg-${walletIdStr.slice(0, 8)}-${seqNum}`;

    const receipt: L2Receipt = {
      receiptId,
      walletId: walletIdStr,
      sequenceNumber: seqNum,
      oldRegistryRoot: ps.registryRoot.toString(),
      newRegistryRoot: newRegistryRoot.toString(),
      oldLifecycleRoot: ps.lifecycleRoot.toString(),
      newLifecycleRoot: newLifecycleRoot.toString(),
      isRegistration: true,
      acceptedAt: Date.now(),
      l1Status: 'pending',
    };

    // Build audit event
    const auditEvent = this.buildAuditEvent(receipt, ps);

    // Update partition state
    ps.registryRoot = newRegistryRoot;
    ps.lifecycleRoot = newLifecycleRoot;
    ps.walletCount = newWalletCount;
    ps.chainHash = Field(BigInt(auditEvent.chainHash));
    ps.nextSeqNum = seqNum + 1n;

    return { receipt, auditEvent };
  }

  /**
   * Create a claim fulfillment receipt + audit event + claim accumulator entry.
   */
  createClaimReceipt(
    memberWalletId: Field,
    prescriberWalletId: Field,
    pharmacyWalletId: Field,
    medication: DemoMedication,
    partition: number,
    patientPayCents: number,
    planPayCents: number,
  ): { receipt: L2Receipt; auditEvent: AuditEvent; claimEntry: ClaimAccumulatorEntry } {
    const ps = this.partitionStates.get(partition)!;
    const seqNum = ps.nextSeqNum;
    const memberWalletIdStr = memberWalletId.toString();
    const ndcHash = hashString(medication.ndc);

    // Simulate root updates (claim updates lifecycle tree)
    const newLifecycleRoot = Poseidon.hash([ps.lifecycleRoot, memberWalletId, ndcHash]);

    const receiptId = `poc-claim-${memberWalletIdStr.slice(0, 8)}-${seqNum}`;

    const receipt: L2Receipt = {
      receiptId,
      walletId: memberWalletIdStr,
      sequenceNumber: seqNum,
      oldRegistryRoot: ps.registryRoot.toString(),
      newRegistryRoot: ps.registryRoot.toString(), // claims don't change registry
      oldLifecycleRoot: ps.lifecycleRoot.toString(),
      newLifecycleRoot: newLifecycleRoot.toString(),
      isRegistration: false,
      acceptedAt: Date.now(),
      l1Status: 'pending',
      claimLeafIndex: ps.nextClaimLeafIndex,
    };

    // Build audit event with claim-specific fields
    const auditEvent = this.buildAuditEvent(receipt, ps, {
      ndcHash: ndcHash.toString(),
      patientPayCents,
      planPayCents,
    });

    // Build claim leaf
    const today = new Date();
    const dateOfService = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

    const claimLeaf: ClaimLeaf = {
      memberWalletId: memberWalletIdStr,
      ndcHash: ndcHash.toString(),
      pharmacyWalletId: pharmacyWalletId.toString(),
      prescriberWalletId: prescriberWalletId.toString(),
      dateOfService,
      patientPayCents: patientPayCents.toString(),
      planPayCents: planPayCents.toString(),
      operationType: '1', // fulfillment
      deductibleCreditCents: '0',
    };

    const claimMetadata: ClaimMetadata = {
      receiptId,
      timestamp: Date.now(),
      ndc: medication.ndc,
      brandName: medication.brandName,
      tierLevel: medication.formularyEntry.tierLevel,
      gpi: medication.gpi,
      therapeuticClass: medication.therapeuticClass,
      daysSupply: 30,
      fillNumber: 0,
    };

    const claimEntry: ClaimAccumulatorEntry = {
      leafIndex: ps.nextClaimLeafIndex,
      leaf: claimLeaf,
      leafHash: computeClaimLeafHash(claimLeaf).toString(),
      metadata: claimMetadata,
    };

    // Update partition state
    ps.lifecycleRoot = newLifecycleRoot;
    ps.chainHash = Field(BigInt(auditEvent.chainHash));
    ps.nextSeqNum = seqNum + 1n;
    ps.nextClaimLeafIndex++;

    return { receipt, auditEvent, claimEntry };
  }

  /**
   * Get current state for a partition (for passing to applyReplicatedReceipt).
   */
  getPartitionState(partition: number): PartitionState {
    return this.partitionStates.get(partition)!;
  }

  // ─── Internal ─────────────────────────────────────────

  private buildAuditEvent(
    receipt: L2Receipt,
    ps: PartitionState,
    claimFields?: { ndcHash: string; patientPayCents: number; planPayCents: number },
  ): AuditEvent {
    const event: AuditEvent = {
      sequenceNumber: receipt.sequenceNumber,
      receiptId: receipt.receiptId,
      walletId: receipt.walletId,
      isRegistration: receipt.isRegistration,
      oldRegistryRoot: receipt.oldRegistryRoot,
      newRegistryRoot: receipt.newRegistryRoot,
      oldLifecycleRoot: receipt.oldLifecycleRoot,
      newLifecycleRoot: receipt.newLifecycleRoot,
      eventCommitment: '', // computed below
      chainHash: '',       // computed below
      timestamp: Date.now(),
      l1Status: 'pending',
      ndcHash: claimFields?.ndcHash,
      patientPayCents: claimFields?.patientPayCents,
      planPayCents: claimFields?.planPayCents,
    };

    // Compute event commitment using the same algorithm as AuditService
    const eventCommitment = AuditService.computeEventCommitment(event);
    event.eventCommitment = eventCommitment.toString();

    // Compute chain hash
    const chainHash = AuditService.computeChainHash(ps.chainHash, eventCommitment);
    event.chainHash = chainHash.toString();

    return event;
  }
}

/**
 * Get medication pricing based on tier level.
 * Returns { patientPayCents, planPayCents } for a 30-day fill.
 */
export function getMedicationPricing(med: DemoMedication): { patientPayCents: number; planPayCents: number } {
  // Copays follow the tier structure from medications.ts
  const copayByTier: Record<number, number> = {
    1: 1000,   // Tier 1 Generic: $10
    2: 3000,   // Tier 2 Preferred Brand: $30
    3: 6000,   // Tier 3 Non-Preferred Brand: $60
    4: 15000,  // Tier 4 Specialty: $150
  };
  const patientPayCents = copayByTier[med.formularyEntry.tierLevel] ?? 3000;
  // Plan pays the AWP-based cost minus patient copay (30 units)
  const totalCost = med.awpUnitPriceCents * 30;
  const planPayCents = Math.max(0, totalCost - patientPayCents);
  return { patientPayCents, planPayCents };
}
