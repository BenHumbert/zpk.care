import { Field, Poseidon, ZkProgram } from 'o1js';
import {
  DOMAIN_TAG_MEMBER,
  DOMAIN_TAG_PRESCRIBER,
  DOMAIN_TAG_PHARMACY,
  DOMAIN_TAG_REPRESENTATIVE,
} from './wallet-derivation.js';

/**
 * ProofGate — ZkProgram that proves wallet ownership.
 *
 * The prover demonstrates knowledge of the preimage Fields
 * (hashed PHI + enrollment key hash) that, when hashed with the
 * domain tag, produce the wallet identity.
 *
 * No private key. The "secret" is the combination of:
 *   1. The member's identity data (hashed off-circuit)
 *   2. The insurer enrollment key (hashed off-circuit)
 *
 * The enrollment key is generated on the member's device and
 * NEVER transmitted to the insurer. The insurer only sees the
 * resulting wallet ID (a hash). Even if PHI is breached, the
 * wallet is safe because the enrollment key is unknown.
 *
 * Public input:  walletIdentity (the wallet "address")
 * Private inputs: the preimage Fields (including enrollment key hash)
 *
 * Three methods — one per entity type:
 *   Member:     6 Fields (cardholderIdHash, dob, firstNameHash, lastNameHash, enrollmentKeyHash, groupIdHash)
 *   Prescriber: 3 Fields (qualifierCode, prescriberIdHash, enrollmentKeyHash)
 *   Pharmacy:   3 Fields (qualifierCode, serviceProviderIdHash, enrollmentKeyHash)
 */
export const ProofGateProgram = ZkProgram({
  name: 'ProofGate',
  publicInput: Field,

  methods: {
    /**
     * Prove ownership of a member wallet.
     * Private inputs are the 6 preimage Fields from memberWalletPreimage().
     * Includes groupIdHash — binds wallet ownership to employer group.
     */
    verifyMember: {
      privateInputs: [Field, Field, Field, Field, Field, Field],
      async method(
        walletIdentity: Field,
        cardholderIdHash: Field,
        dateOfBirth: Field,
        firstNameHash: Field,
        lastNameHash: Field,
        enrollmentKeyHash: Field,
        groupIdHash: Field,
      ) {
        const computed = Poseidon.hash([
          DOMAIN_TAG_MEMBER,
          cardholderIdHash,
          dateOfBirth,
          firstNameHash,
          lastNameHash,
          enrollmentKeyHash,
          groupIdHash,
        ]);
        computed.assertEquals(walletIdentity);
      },
    },

    /**
     * Prove ownership of a prescriber wallet.
     * Private inputs are the 3 preimage Fields from prescriberWalletPreimage().
     */
    verifyPrescriber: {
      privateInputs: [Field, Field, Field],
      async method(
        walletIdentity: Field,
        qualifierCode: Field,
        prescriberIdHash: Field,
        enrollmentKeyHash: Field,
      ) {
        const computed = Poseidon.hash([
          DOMAIN_TAG_PRESCRIBER,
          qualifierCode,
          prescriberIdHash,
          enrollmentKeyHash,
        ]);
        computed.assertEquals(walletIdentity);
      },
    },

    /**
     * Prove ownership of a pharmacy wallet.
     * Private inputs are the 3 preimage Fields from pharmacyWalletPreimage().
     */
    verifyPharmacy: {
      privateInputs: [Field, Field, Field],
      async method(
        walletIdentity: Field,
        qualifierCode: Field,
        serviceProviderIdHash: Field,
        enrollmentKeyHash: Field,
      ) {
        const computed = Poseidon.hash([
          DOMAIN_TAG_PHARMACY,
          qualifierCode,
          serviceProviderIdHash,
          enrollmentKeyHash,
        ]);
        computed.assertEquals(walletIdentity);
      },
    },

    /**
     * Prove ownership of a representative wallet (AOR).
     * Private inputs are the 3 preimage Fields from representativeWalletPreimage().
     */
    verifyRepresentative: {
      privateInputs: [Field, Field, Field],
      async method(
        walletIdentity: Field,
        qualifierCode: Field,
        representativeIdHash: Field,
        enrollmentKeyHash: Field,
      ) {
        const computed = Poseidon.hash([
          DOMAIN_TAG_REPRESENTATIVE,
          qualifierCode,
          representativeIdHash,
          enrollmentKeyHash,
        ]);
        computed.assertEquals(walletIdentity);
      },
    },
  },
});

/** The proof class — use this type when passing proofs around */
export const ProofGateProof = ZkProgram.Proof(ProofGateProgram);
