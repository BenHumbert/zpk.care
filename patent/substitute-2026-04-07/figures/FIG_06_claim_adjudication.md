# FIG. 6 — In-Circuit Healthcare Claim Adjudication

```
Replacement Sheet

FIG. 6 — IN-CIRCUIT HEALTHCARE CLAIM ADJUDICATION               Sheet 6 of 22

+==========================================================================+
|| The ZK proof IS the adjudication. No PBM. No manual review.            ||
|| All healthcare business logic = arithmetic constraints in ZK circuits. ||
+==========================================================================+

=== TWO-CREDENTIAL INPUT ===
  PRESCRIPTION CREDENTIAL (pharmacy)     ELIGIBILITY CREDENTIAL (member)
  +--------------------------------+     +--------------------------------+
  | type: PRESCRIPTION             |     | type: ELIGIBILITY              |
  | forestRoot: H(6 domain roots)  |     | forestRoot: H(6 domain roots)  |
  | issuer: prescriberWalletId     |     | issuer: insurerWalletId        |
  | subject: pharmacyWalletId      |     | subject: memberWalletId        |
  | MEDICATION tree: Rx leaves     |     | ACCESS_CONTROL tree:           |
  | TRANSACTION tree: status/fill  |     |   leaf 0: EligibilityData      |
  +---------------+----------------+     |   leaf 127: AccumulatorData    |
                  +----------+-----------+---------------+----------------+
                             v
  +------------------------------------------------------------------+
  | STEP 610 -- Credential & Forest Root Verification                |
  | [x] type==PRESCRIPTION  [x] revoked==0  [x] computedForestRoot   |
  |     == Poseidon.hash([6 domain roots]) == credential.forestRoot  |
  +-------------------------------+----------------------------------+
                                  v
  +------------------------------------------------------------------+
  | STEP 620 -- Pharmacy Identity Binding                            |
  | Recompute: Poseidon.hash([Field(2), qual, svcProvIdH, enrollH])  |
  | Assert: computed == fulfillmentData.pharmacyWalletId             |
  +-------------------------------+----------------------------------+
                                  v
  +------------------------------------------------------------------+
  | STEP 630 -- Prescription Data Verification (MEDICATION Tree)     |
  | rxCommitment = Poseidon.hash([ndcHash, prescriberWalletId,       |
  |   memberWalletId, writtenDate, expDate, qtyPrescribed, refills]) |
  | medicationWitness.calculateRoot(rxCommitment) == medicationRoot  |
  +-------------------------------+----------------------------------+
                                  v
  +------------------------------------------------------------------+
  | STEP 640 -- Formulary Eligibility Lookup                         |
  | formularyWitness.calculateRoot(entry.commitment()) == formRoot   |
  | Assert: formularyEntry.ndcHash == fulfillmentData.ndcHash        |
  +-------------------------------+----------------------------------+
                                  v
  +------------------------------------------------------------------+
  | STEP 650 -- Quantity Verification (FWA Guard)                    |
  | [x] qtyDispensed <= formularyEntry.maxQuantityPerFill            |
  | [x] qtyDispensed <= prescriptionData.quantityPrescribed          |
  +---------------+----------------------------------+---------------+
                  |                                  |
                  v                                  v
  660a Basic Cost-Share (129)            660b 4-Priority Accumulator (130)
  +------------------------------+       +-------------------------------------+
  | total = ingredient + disp    |       | total = ingredient + dispensingFee  |
  | patientPay = min(total,copay)|       | P1: oopPaid>=oopMax -> patient=0    |
  | planPay = total - patientPay |       | P2: benefitUsed>=max -> patient=all |
  +---------------+--------------+       | P3: deductPaid<deduct -> ded+copay  |
                  |                      | P4: default -> min(total, copay)    |
                  |                      | All via Provable.if (not runtime)   |
                  |                      +------------------+------------------+
                  |              +--------------------------+
                  |              v
                  |   +---------------------------------------------------+
                  |   | STEP 670 -- Deductible Credit                     |
                  |   | deductibleCredit = min(deductiblePay, patientPay) |
                  |   +------------------------+--------------------------+
                  |                            v
                  |   +---------------------------------------------------+
                  |   | STEP 680 -- Accumulator State Transition          |
                  |   | newDeductPaid  = current + deductCredit           |
                  |   | newOopPaid     = current + patientPay             |
                  |   | newBenefitUsed = current + planPay                |
                  |   | newAccumCommit = Poseidon.hash([planYear,         |
                  |   |   deductAmt, newDeductPaid, oopMax, newOopPaid,   |
                  |   |   benefitMax, newBenefitUsed])                    |
                  |   | -> Updates ACCESS_CONTROL leaf 127, new ForestRoot|
                  |   +------------------------+--------------------------+
                  +----------------------------+
                                               v
  +------------------------------------------------------------------+
  | STEP 690 -- Settlement Commitment                                |
  | Basic:  Poseidon.hash([fulfillCommit, patientPay, planPay])      |
  | Accum:  + deductibleCredit. -> TRANSACTION tree -> new ForestRoot|
  +-------------------------------+----------------------------------+
                                  v
  +------------------------------------------------------------------+
  | STEP 695 -- Proof Output                                         |
  | FulfillmentOutput (8): rxHash, oldForest, newForest, entryCmt,   |
  |   patientPay, planPay, opType(1=fill/2=rev), ndcHash             |
  | AccumFulfillmentOutput (10): + newEligForest, deductCredit       |
  +------------------------------------------------------------------+
  INVARIANT: ingredientCost + dispensingFee == patientPay + planPay (by construction)
  WITNESSES: 1.medication 2.status 3.newSlot 4.formulary 5.accumulator(accum only)
```
