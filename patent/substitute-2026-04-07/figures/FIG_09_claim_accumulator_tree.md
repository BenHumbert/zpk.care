# FIG. 9 — Claim Accumulator Tree

```
Replacement Sheet

FIG. 9 — CLAIM ACCUMULATOR TREE WITH FOUR PARALLEL INDEXES      Sheet 10 of 22
=========================================================================================

SECTION A: DATA FLOW -- ZK PROOF -> CLAIM LEAF 900
---------------------------------------------------
+-------------------------+     +-------------------------+     +-------------------------+
| Pharmacy Device         |     | StateTransitionProof    |     | submitProof(proof,      |
| FulfillmentProof 129    | --> | 122 (wraps fulfillment) | --> | metadata)               |
| ndcHash verified in     |     |                         |     | L2Sequencer accepts     |
| circuit (step 640)      |     |                         |     +------------+------------+
+-------------------------+     +-------------------------+                  |
                                                                             v
+-------------------------+     +-----------------------------------------------------+
| ClaimAccumulatorService |     | ClaimSubmissionMetadata (9 crypto fields):          |
| .appendClaim(leaf,meta) | <-- | ndcHash, memberWalletId, pharmacyWalletId,          |
| 1. Poseidon hash (9 F)  |     | prescriberWalletId, dateOfService, patientPayCents, |
| 2. Set leaf in tree     |     | planPayCents, operationType, deductibleCreditCents  |
| 3. Store entry + meta   |     +-----------------------------------------------------+
| 4. Update 4 indexes     |
| 5. Increment nextLeafIdx|
+-------------------------+

SECTION B: MERKLE TREE(24) STRUCTURE 902
-----------------------------------------
         [  Root  ]                   ClaimLeaf (9-Field Poseidon Hash):
        /          \                  leafHash = Poseidon.hash([
      /              \                  F1: memberWalletId,    F2: ndcHash,
   [H_L]           [H_R]               F3: pharmacyWalletId,  F4: prescriberWalletId,
  /     \          /     \              F5: dateOfService,     F6: patientPayCents,
[..]   [..]     [..]   [..]            F7: planPayCents,      F8: operationType,
  ... (24 levels deep) ...              F9: deductibleCreditCents
[lf0][lf1][lf2][lf3]...[lf_16M]      ])
                                      Capacity: 2^24 = 16,777,216 leaves
                                      All identity fields = Poseidon hashes. No plaintext PHI.

SECTION C: FOUR PARALLEL INDEX STRUCTURES 904
----------------------------------------------
Each index: Map<string, bigint[]>  Key = Poseidon hash  Value = leaf indices

  INDEX 1: memberIndex                     INDEX 2: pharmacyIndex
  Map<memberWalletId, bigint[]>            Map<pharmacyWalletId, bigint[]>
  +------------------------------+         +------------------------------+
  | member_A -> [0, 5, 12]       |         | pharm_X -> [0, 1, 3, 5]      |
  | member_B -> [1, 8]           |         | pharm_Y -> [7, 8, 9, 12]     |
  | member_C -> [3, 7, 9]        |         | pharm_Z -> [2, 4, 6]         |
  +------------------------------+         +------------------------------+

  INDEX 3: prescriberIndex                 INDEX 4: ndcIndex
  Map<prescriberWalletId, bigint[]>        Map<ndcHash, bigint[]>
  +------------------------------+         +------------------------------+
  | prescriber_P -> [0, 1, 3]    |         | ndc_Atorva  -> [0, 5]        |
  | prescriber_Q -> [5, 7, 8]    |         | ndc_Metform -> [1, 8, 12]    |
  | prescriber_R -> [2, 4, 6]    |         | ndc_Amoxi   -> [3, 7, 9]     |
  +------------------------------+         +------------------------------+

  Single claim at leafIndex N appears in ALL FOUR indexes (member, pharmacy, prescriber, ndc)

SECTION D: QUERY AND MERKLE WITNESS FLOW 906
----------------------------------------------
6 RPC Methods:                             Merkle Witness Verification:
  l2_getClaimsByMember(walletId)             l2_getClaimWithProof(leafIndex):
  l2_getClaimsByPharmacy(walletId)             1. entry = entries.get(leafIndex)
  l2_getClaimsByPrescriber(walletId)           2. witness = tree.getWitness(idx) -- 24 siblings
  l2_getClaimsByNdc(ndcHash)                   3. root = tree.getRoot()
  l2_getClaimWithProof(leafIndex)              Verifier: computedRoot = witness.calculateRoot(
    -> returns entry + 24-sibling witness        Poseidon.hash([9 fields]))
  l2_getClaimAccumulatorRoot()                 assert computedRoot == root -> PROVES claim exists
    -> returns { root, leafCount }           ClaimAccumulatorWitness extends MerkleWitness(24)

SECTION E: BATCH INTEGRATION 908
----------------------------------
+--------------------------------------------+     +--------------------------------------------+
| L2Receipt { claimLeafIndex?: bigint }      |     | L2Batch { claimAccumulatorRoot?: string }  |
| Links receipt to specific claim in tree    |     | Snapshot of tree root at batch creation    |
+--------------------------------------------+     +--------------------------------------------+
```
