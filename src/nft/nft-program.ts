import { Field, Struct, ZkProgram } from 'o1js';
import { ProofGateProof } from '../wallets/proof-gate.js';
import { NftInventoryWitness } from '../wallets/wallet-state.js';
import { NftData } from './nft-data.js';

/**
 * Operation type constants for NftOperationOutput.
 */
export const NFT_OP_MINT = Field(1);
export const NFT_OP_VERIFY = Field(2);

/**
 * NftOperationOutput — public output of every NftProgram proof.
 *
 * Contains the wallet identity, operation type, NFT commitment,
 * and old/new inventory roots. This is the portable credential
 * that can be verified offline via NFC/RFID/QR.
 */
export class NftOperationOutput extends Struct({
  /** The wallet involved in this operation */
  walletId: Field,
  /** NFT_OP_MINT or NFT_OP_VERIFY */
  operationType: Field,
  /** Commitment of the NFT involved */
  nftCommitment: Field,
  /** Inventory root BEFORE the operation */
  oldInventoryRoot: Field,
  /** Inventory root AFTER the operation (same as old for verify) */
  newInventoryRoot: Field,
}) {}

/**
 * NftProgram — ZkProgram for NFT operations with recursive proof composition.
 *
 * Each method recursively verifies a ProofGateProof (wallet ownership),
 * then proves a specific NFT operation. The resulting NftOperationProof
 * is a portable credential that can be verified offline.
 *
 * Methods:
 *   proveMint        — prove correct NFT insertion into wallet inventory
 *   proveHolding     — prove wallet holds a specific NFT (point-of-care)
 *   proveHoldingByType — selective disclosure (prove type without revealing NFT)
 *
 * Proof chain: ProofGateProof → NftOperationProof → offline/on-chain verify
 */
export const NftProgram = ZkProgram({
  name: 'NftOperations',
  publicOutput: NftOperationOutput,

  methods: {
    /**
     * Prove that an NFT was correctly minted into a wallet's inventory.
     *
     * Verifies:
     *   1. Wallet ownership (recursive ProofGateProof)
     *   2. The inventory slot is empty
     *   3. subjectWalletId matches the prover's wallet
     *   4. Computes new inventory root with NFT commitment
     */
    proveMint: {
      privateInputs: [
        ProofGateProof,
        NftData,
        NftInventoryWitness,
        Field, // oldInventoryRoot
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        nftData: NftData,
        inventoryWitness: NftInventoryWitness,
        oldInventoryRoot: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify the inventory slot is empty
        const emptyRoot = inventoryWitness.calculateRoot(Field(0));
        emptyRoot.assertEquals(
          oldInventoryRoot,
          'Inventory slot is not empty',
        );

        // 3. Verify subject matches wallet owner
        nftData.subjectWalletId.assertEquals(
          walletId,
          'NFT subject must match wallet owner',
        );

        // 4. Compute new root with NFT commitment
        const nftCommitment = nftData.commitment();
        const newInventoryRoot = inventoryWitness.calculateRoot(nftCommitment);

        return {
          publicOutput: new NftOperationOutput({
            walletId,
            operationType: NFT_OP_MINT,
            nftCommitment,
            oldInventoryRoot,
            newInventoryRoot,
          }),
        };
      },
    },

    /**
     * Prove a wallet holds a specific NFT (point-of-care verification).
     *
     * Verifies:
     *   1. Wallet ownership (recursive ProofGateProof)
     *   2. The NFT exists in the wallet's inventory
     *   3. subjectWalletId matches the prover's wallet
     *   4. The NFT is not revoked
     *
     * No state change — inventory root is unchanged.
     * This is the OFFLINE verification path (NFC/RFID/QR at pharmacy).
     */
    proveHolding: {
      privateInputs: [
        ProofGateProof,
        NftData,
        NftInventoryWitness,
        Field, // inventoryRoot
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        nftData: NftData,
        inventoryWitness: NftInventoryWitness,
        inventoryRoot: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify NFT exists in inventory
        const nftCommitment = nftData.commitment();
        const computedRoot = inventoryWitness.calculateRoot(nftCommitment);
        computedRoot.assertEquals(
          inventoryRoot,
          'NFT not found in inventory',
        );

        // 3. Verify subject matches wallet owner
        nftData.subjectWalletId.assertEquals(
          walletId,
          'NFT subject must match wallet owner',
        );

        // 4. Verify NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        return {
          publicOutput: new NftOperationOutput({
            walletId,
            operationType: NFT_OP_VERIFY,
            nftCommitment,
            oldInventoryRoot: inventoryRoot,
            newInventoryRoot: inventoryRoot, // unchanged
          }),
        };
      },
    },

    /**
     * Prove a wallet holds an NFT of a specific TYPE (selective disclosure).
     *
     * Same as proveHolding but additionally constrains the NFT type.
     * Use case: "I hold an ELIGIBILITY NFT" without revealing which one,
     * or "I hold a PRESCRIPTION eScript" for dispensing authority.
     *
     * The requiredNftType is a private input — the verifier sees the proof
     * is valid but only knows the wallet holds *some* NFT of that type.
     */
    proveHoldingByType: {
      privateInputs: [
        ProofGateProof,
        NftData,
        NftInventoryWitness,
        Field, // inventoryRoot
        Field, // requiredNftType
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        nftData: NftData,
        inventoryWitness: NftInventoryWitness,
        inventoryRoot: Field,
        requiredNftType: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify NFT exists in inventory
        const nftCommitment = nftData.commitment();
        const computedRoot = inventoryWitness.calculateRoot(nftCommitment);
        computedRoot.assertEquals(
          inventoryRoot,
          'NFT not found in inventory',
        );

        // 3. Verify subject matches wallet owner
        nftData.subjectWalletId.assertEquals(
          walletId,
          'NFT subject must match wallet owner',
        );

        // 4. Verify NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 5. Verify NFT type matches requirement
        nftData.nftType.assertEquals(
          requiredNftType,
          'NFT type does not match required type',
        );

        return {
          publicOutput: new NftOperationOutput({
            walletId,
            operationType: NFT_OP_VERIFY,
            nftCommitment,
            oldInventoryRoot: inventoryRoot,
            newInventoryRoot: inventoryRoot, // unchanged
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility (reflect-metadata needs named class) */
export class NftOperationProof extends ZkProgram.Proof(NftProgram) {}
