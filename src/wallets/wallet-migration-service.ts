/**
 * Wallet Migration Service — client + insurer orchestration for wallet migration.
 *
 * Handles the two-sided flow:
 *   - Client side: recover old key from NFC card, generate new wallet, create proof
 *   - Insurer side: verify proof, reconstruct accumulator, process migration
 *
 * The service is stateless — all state lives in the caller's context.
 */

import { Field } from 'o1js';
import type { RecoveryCard } from '../security/recovery-card.js';
import { importRecoveryCard } from '../security/recovery-card.js';
import {
  generateEnrollmentKey,
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  memberTransitionPreimage,
  prescriberTransitionPreimage,
  pharmacyTransitionPreimage,
  DOMAIN_TAG_MEMBER,
  DOMAIN_TAG_PRESCRIBER,
  DOMAIN_TAG_PHARMACY,
} from './wallet-derivation.js';
import type { MemberLocalData } from '../models/member.js';
import type { PrescriberLocalData } from '../models/prescriber.js';
import type { PharmacyLocalData } from '../models/pharmacy.js';
import { WalletMigrationProgram } from './wallet-migration-program.js';
import type { WalletMigrationProof } from './wallet-migration-program.js';

// ─── Types ──────────────────────────────────────────────

/** Result of recovering wallet identity from an NFC card */
export interface RecoveryResult {
  /** The decrypted old enrollment key */
  oldEnrollmentKey: string;
  /** The old wallet ID (derived from entity data + old key) */
  oldWalletId: string;
  /** Domain tag from the recovery card */
  domainTag: number;
}

/** Result of preparing a new wallet */
export interface NewWalletResult {
  /** The newly generated enrollment key */
  newEnrollmentKey: string;
  /** The new wallet ID (derived from entity data + new key) */
  newWalletId: string;
}

/** Migration request submitted to the insurer/sequencer */
export interface MigrationRequest {
  /** Serialized WalletMigrationProof JSON */
  migrationProofJson: string;
  /** Token ID hash from the recovery card (insurer looks up consumed token) */
  tokenIdHash: string;
  /** Employee ID hash from the recovery card */
  employeeIdHash: string;
  /** Group ID hash from the recovery card (plan lookup) */
  groupIdHash: string;
  /** The old wallet ID being migrated from */
  oldWalletId: string;
  /** The new wallet ID being migrated to */
  newWalletId: string;
  /** Domain tag (0=member, 1=prescriber, 2=pharmacy) */
  domainTag: number;
}

// ─── Entity Data Union ──────────────────────────────────

type EntityLocalData = MemberLocalData | PrescriberLocalData | PharmacyLocalData;

// ─── Service ────────────────────────────────────────────

/**
 * WalletMigrationService — stateless orchestrator for wallet migration.
 */
export class WalletMigrationService {
  /**
   * Step 1: Recover the old enrollment key from an NFC recovery card.
   *
   * Decrypts the card with the user's PIN and derives the old wallet ID
   * from the entity's local data + recovered key.
   *
   * @param card — the NFC recovery card
   * @param pin — user's PIN
   * @param local — the entity's local identifying data
   * @returns Recovery result with old key and wallet ID
   */
  static recoverFromCard(
    card: RecoveryCard,
    pin: string,
    local: EntityLocalData,
  ): RecoveryResult {
    const oldEnrollmentKey = importRecoveryCard(card, pin);

    let oldWalletId: Field;
    if (card.domainTag === 0) {
      let groupIdHash: Field;
      try {
        groupIdHash = card.groupIdHash ? Field(BigInt(card.groupIdHash)) : Field(0);
      } catch {
        throw new Error(
          `Invalid groupIdHash on recovery card: "${card.groupIdHash}". ` +
          'Expected a decimal numeric string. The card data may be corrupted.',
        );
      }
      oldWalletId = deriveMemberWalletId(local as MemberLocalData, oldEnrollmentKey, groupIdHash);
    } else if (card.domainTag === 1) {
      oldWalletId = derivePrescriberWalletId(local as PrescriberLocalData, oldEnrollmentKey);
    } else if (card.domainTag === 2) {
      oldWalletId = derivePharmacyWalletId(local as PharmacyLocalData, oldEnrollmentKey);
    } else {
      throw new Error(`Unsupported domain tag: ${card.domainTag}`);
    }

    // Verify derived wallet ID matches card
    if (oldWalletId.toString() !== card.walletId) {
      throw new Error(
        'Wallet ID mismatch: derived wallet ID does not match recovery card. ' +
        'Ensure the correct identity data was provided.',
      );
    }

    return {
      oldEnrollmentKey,
      oldWalletId: oldWalletId.toString(),
      domainTag: card.domainTag,
    };
  }

  /**
   * Step 2: Generate a new wallet with a fresh enrollment key.
   *
   * Creates a new enrollment key on the user's device and derives
   * the new wallet ID from the same entity data + new key.
   *
   * @param local — the entity's local identifying data
   * @param domainTag — 0=member, 1=prescriber, 2=pharmacy
   * @returns New wallet result with new key and wallet ID
   */
  static prepareNewWallet(
    local: EntityLocalData,
    domainTag: number,
    groupIdHash?: Field,
  ): NewWalletResult {
    const newEnrollmentKey = generateEnrollmentKey();

    let newWalletId: Field;
    if (domainTag === 0) {
      newWalletId = deriveMemberWalletId(local as MemberLocalData, newEnrollmentKey, groupIdHash ?? Field(0));
    } else if (domainTag === 1) {
      newWalletId = derivePrescriberWalletId(local as PrescriberLocalData, newEnrollmentKey);
    } else if (domainTag === 2) {
      newWalletId = derivePharmacyWalletId(local as PharmacyLocalData, newEnrollmentKey);
    } else {
      throw new Error(`Unsupported domain tag: ${domainTag}`);
    }

    return {
      newEnrollmentKey,
      newWalletId: newWalletId.toString(),
    };
  }

  /**
   * Step 3: Create a ZK proof of identity continuity.
   *
   * Proves that the old and new wallet IDs share the same identity
   * fields but have different enrollment keys. Zero PHI is revealed.
   *
   * @param local — the entity's local identifying data
   * @param oldEnrollmentKey — from Step 1 (NFC card recovery)
   * @param newEnrollmentKey — from Step 2 (new wallet generation)
   * @param domainTag — 0=member, 1=prescriber, 2=pharmacy
   * @returns WalletMigrationProof proving identity continuity
   */
  static async createMigrationProof(
    local: EntityLocalData,
    oldEnrollmentKey: string,
    newEnrollmentKey: string,
    domainTag: number,
    groupIdHash?: Field,
  ): Promise<WalletMigrationProof> {
    let oldPreimage: Field[];
    let newPreimage: Field[];

    if (domainTag === 0) {
      oldPreimage = memberTransitionPreimage(local as MemberLocalData, oldEnrollmentKey, groupIdHash ?? Field(0));
      newPreimage = memberTransitionPreimage(local as MemberLocalData, newEnrollmentKey, groupIdHash ?? Field(0));
    } else if (domainTag === 1) {
      oldPreimage = prescriberTransitionPreimage(local as PrescriberLocalData, oldEnrollmentKey);
      newPreimage = prescriberTransitionPreimage(local as PrescriberLocalData, newEnrollmentKey);
    } else if (domainTag === 2) {
      oldPreimage = pharmacyTransitionPreimage(local as PharmacyLocalData, oldEnrollmentKey);
      newPreimage = pharmacyTransitionPreimage(local as PharmacyLocalData, newEnrollmentKey);
    } else {
      throw new Error(`Unsupported domain tag: ${domainTag}`);
    }

    // Both preimages should be 7 Fields: [domainTag, f0, f1, f2, f3, f4, f5]
    const result = await WalletMigrationProgram.proveIdentityContinuity(
      oldPreimage[0], oldPreimage[1], oldPreimage[2], oldPreimage[3], oldPreimage[4], oldPreimage[5], oldPreimage[6],
      newPreimage[0], newPreimage[1], newPreimage[2], newPreimage[3], newPreimage[4], newPreimage[5], newPreimage[6],
    );

    return result.proof as WalletMigrationProof;
  }

  /**
   * Step 4: Build the migration request for submission to insurer/sequencer.
   *
   * Packages the proof with recovery card metadata into a request
   * that the insurer can use to verify identity and process migration.
   *
   * @param proof — WalletMigrationProof from Step 3
   * @param card — the recovery card (contains insurer identification hashes)
   * @param newWalletId — the new wallet ID from Step 2
   */
  static buildMigrationRequest(
    proof: WalletMigrationProof,
    card: RecoveryCard,
    newWalletId: string,
  ): MigrationRequest {
    return {
      migrationProofJson: JSON.stringify(proof.toJSON()),
      tokenIdHash: card.tokenIdHash,
      employeeIdHash: card.employeeIdHash,
      groupIdHash: card.groupIdHash,
      oldWalletId: card.walletId,
      newWalletId,
      domainTag: card.domainTag,
    };
  }
}
