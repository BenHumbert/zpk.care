# FIG. 3 — Six-Domain Merkle Forest Credential Structure

```
Replacement Sheet

FIG. 3 — SIX-DOMAIN MERKLE FOREST                               Sheet 3 of 22
=====================================================================================

CREDENTIAL COMMITMENT 302
---------------------------------------------------------------------------------------------
  credentialCommitment = Poseidon.hash([credentialType, forestRoot, issuerWalletId,
                          subjectWalletId, issuedAt, expiresAt, revoked])
  (7 Fields — single hash embedded in NFT credential)

FOREST ROOT COMPUTATION 304
---------------------------------------------------------------------------------------------
  forestRoot = Poseidon.hash([root_0, root_1, root_2, root_3, root_4, root_5])
  (6 domain tree roots combined into single Field)

SIX DOMAIN TREES (MerkleTree height=8, 128 leaves each)                                 306
---------------------------------------------------------------------------------------------
  TREE 0: MEMBER 308          |  TREE 1: PRESCRIBER 310      |  TREE 2: PHARMACY 312
  Domain Tag: 0               |  Domain Tag: 1               |  Domain Tag: 2
  Leaf: H(cardholderIdHash,   |  Leaf: H(prescriberIdQual,   |  Leaf: H(serviceProviderIdQual,
    dateOfBirth, genderCode,  |    prescriberIdHash)         |    serviceProviderIdHash)
    firstNameHash,            |                              |
    lastNameHash)             |                              |
                              |                              |
  TREE 3: MEDICATION 314      |  TREE 4: ACCESS_CTRL 316     |  TREE 5: TRANSACTION 318
  Domain Tag: 3               |  Domain Tag: 3               |  Domain Tag: 5
  Leaf: H(rxRefNumberHash,    |  Leaf 0: EligibilityData     |  Leaf: H(fulfillment
    ndcHash, quantityDisp,    |  Leaf 1+: PriorAuthData      |    .commitment(),
    fillNumber, daysSupply,   |  Leaf 127: AccumulatorData   |    patientPay,
    compoundCode, dawCode)    |    (deductible, oop, max)    |    planPay)

TREE DETAIL — ACCESS_CONTROL 316 (Expanded)                                              320
---------------------------------------------------------------------------------------------
  Leaf Index  |  Contents                           |  Structure
  ---------------------------------------------------------------------------
  0           |  EligibilityData 320-A              |  H(planIdHash, groupIdHash, effectiveDate,
              |                                     |    terminationDate, copayAmountCents,
              |                                     |    coverageType, formularyRoot, networkRoot)
  1 .. 126    |  PriorAuthData 320-B (per drug)     |  H(ndcHash, memberWalletId, prescriberWalletId,
              |                                     |    approvalDate, expirationDate,
              |                                     |    approvedQuantity, authCodeHash)
  127         |  AccumulatorData 320-C              |  H(planYear, deductibleAmountCents,
              |                                     |    deductiblePaidCents, oopMaxCents,
              |                                     |    oopPaidCents, annualBenefitMaxCents,
              |                                     |    annualBenefitUsedCents)

SELECTIVE DISCLOSURE PROTOCOL                                                            330
---------------------------------------------------------------------------------------------
  Step 1 (332): Prover selects leaf index i in domain tree t
  Step 2 (334): Prover computes MerkleWitness(tree_t, i) — sibling path, height 8
  Step 3 (336): Prover supplies leaf preimage fields as private inputs to ZkProgram
  Step 4 (338): Verifier checks: H(preimage) == leaf_i, witness.calculateRoot() == root_t,
                H(...all roots...) == forestRoot, forestRoot matches credential

  Result: Verifier learns ONLY the disclosed fields. All other trees/leaves stay hidden.

COMPOSITION CHAIN (Credential to Settlement)                                             340
---------------------------------------------------------------------------------------------
  Level  Ref   Proof                      Proves
  ----   ----  -------------------------  -------------------------------------------
  L0     342   EligibilityProof           Member is eligible under benefit plan
  L1     344   PrescriptionProof          Prescriber authorized for this medication
  L2     346   FulfillmentProof           Pharmacy dispensed, copay/planpay computed
  L3     348   AccumFulfillmentProof      Accumulators updated (deductible, OOP)
  L4     350   StateTransitionProof       Forest root updated, inline wallet verify
  (L5)   352   BatchProof/ChainProof      Sequencer batches into chain (FIG. 2)

MERKLE FOREST STRUCTURE (Visual)                                                         360
---------------------------------------------------------------------------------------------
                          forestRoot 362
                              |
          +-------+-------+---+---+-------+-------+
          |       |       |       |       |       |
        root_0  root_1  root_2  root_3  root_4  root_5
        364     366     368     370     372     374
          |       |       |       |       |       |
        [128]  [128]   [128]   [128]   [128]   [128]   <- leaves per tree
       MEMBER PRESCR  PHARMA  MEDIC   ACCESS  TRANSACT
```
