# FIG. 13 — Epoch-Based Temporal Accumulator

```
Replacement Sheet

FIG. 13 — EPOCH-BASED TEMPORAL ACCUMULATOR                      Sheet 16 of 22
=================================================================================================

SECTION A: EPOCH TIMELINE WITH MONTHLY ROTATION                                            1300
-------------------------------------------------------------------------------------------------
TIME --->
+----------+ +----------+     +----------+ +=================+
| 2025-01  | | 2025-02  | ... | 2025-12  | || 2026-01       ||
| ARCHIVED | | ARCHIVED |     | ARCHIVED | || ACTIVE        ||
| immutable| | immutable|     | immutable| || (writes here) ||
| root:    | | root:    |     | root:    | || root: "184.." ||
| "38a1.." | | "7c2d.." |     | "e91a.." | || leaves: 15.2M ||
| leaves:  | | leaves:  |     | leaves:  | || (growing)     ||
| 16.7M    | | 16.7M    |     | 16.7M    | +=================+
+----------+ +----------+     +----------+
  Each epoch = 1 ClaimAccumulatorService (MerkleTree(24)+4 indexes+entries). YYYY-MM format.
  Production: tree height scales with volume (e.g., height 25 = 33.5M, or sub-monthly rotation).

SECTION B: SINGLE EPOCH INTERNAL STRUCTURE                                                 1302
-------------------------------------------------------------------------------------------------
+===============================================================================================+
|| ClaimAccumulatorService — ONE EPOCH (e.g., "2026-01")                                       ||
||                                                                                             ||
||  MerkleTree(24)                      | 4 Parallel Index Maps          | entries Map         ||
||  2^24 = 16,777,216 leaf capacity     |                                |                     ||
||         [Root]                       | memberIndex:                   | Map<bigint,         ||
||        /      \                      |   Map<walletId, bigint[]>      |   ClaimAccumEntry>  ||
||      [H01]  [H02]                    | pharmacyIndex:                 |                     ||
||      /  \    /  \                    |   Map<walletId, bigint[]>      | nextLeafIndex:      ||
||    ... ... ... ...                   | prescriberIndex:               |   bigint            ||
||       (depth 24)                     |   Map<walletId, bigint[]>      |   (monotonic)       ||
||  [lf0][lf1][lf2][lf3]...             | ndcIndex:                      |                     ||
||                                      |   Map<ndcHash, bigint[]>       |                     ||
||  Each leaf = Poseidon.hash(9):       | Each maps key -> leaf index[]  |                     ||
||  [memberWalletId, ndcHash,           |   for O(1) lookup              |                     ||
||   pharmacyWalletId, prescriberWId,   |                                |                     ||
||   dateOfService, patientPayCents,    +--------------------------------+--------------------+||
||   planPayCents, operationType,       |                                                      ||
||   deductibleCreditCents]             | EpochInfo: epochId, start/endTimestamp, leafCount,   ||
||                                      |   accumulatorRoot, archived (bool)                   ||
+===============================================================================================+
SECTION C: EPOCH ROTATION MECHANISM                                                        1304
-------------------------------------------------------------------------------------------------
BEFORE rotateEpoch("2026-01"):                  AFTER rotateEpoch("2026-01"):
+--------------------------------------+        +--------------------------------------+
| epochs:                              |        | epochs:                              |
|   "2025-11" -> archived, root:"b4.." |        |   "2025-11" -> archived, root:"b4.." |
|   "2025-12" -> ACTIVE,  root:"e9.."  |        |   "2025-12" -> FROZEN,  root:"e9.."  |
|                                      |        |   "2026-01" -> ACTIVE,  root:"0..."  |
| activeEpochId: "2025-12"             |        | activeEpochId: "2026-01"             |
| activeEpoch: (receiving writes)      |        | activeEpoch: (fresh empty tree)      |
+--------------------------------------+        +--------------------------------------+
                  |
                  v
   Step 1: FREEZE "2025-12" — set endTimestamp, archived=true, final leafCount + root
   Step 2: ARCHIVE — archivedAccumulators.set("2025-12", activeEpoch)
   Step 3: CREATE — new ClaimAccumulatorService() (empty tree, empty indexes, leafIndex=0)
   Step 4: REGISTER — activeEpochId = "2026-01", epochs.set("2026-01", {archived:false,...})
   Returns: EpochInfo of closed "2025-12" epoch
SECTION D: CROSS-EPOCH QUERY AGGREGATION                                                   1306
-------------------------------------------------------------------------------------------------
getClaimsByMember(walletId) --> queryCrossEpoch(acc => acc.getClaimsByMember(wId))
   |
   v
+-------------------------------+      CROSS-EPOCH QUERIES:              EPOCH-SCOPED MERKLE PROOF:
| 1. Query ACTIVE epoch         |        getClaimsByMember(walletId)     getClaimWithProof(epochId,
|    (memberIndex -> entries)   |        getClaimsByPharmacy(walletId)     leafIdx)
| 2. Sort archived DESC by time |        getClaimsByPrescriber(walletId)   -> entry + witnessJson
| 3. Query each archived        |        getClaimsByNdc(ndcHash)              + root
|    (newest -> oldest)         |     SINGLE-EPOCH:                      -> proof verifies against
| 4. Return unified results[]   |       getClaimsByMemberInEpoch(            that epoch's FROZEN root
|    (newest claims first)      |         walletId, epochId)             -> permanently valid
+-------------------------------+     METADATA:                          -> epochId MUST be specified
                                        getActiveRoot(), getRootForEpoch(),  (no cross-epoch proofs)
                                        getTotalLeafCount(), listEpochs()
SECTION E: CHECKPOINT PERSISTENCE                                                          1308
-------------------------------------------------------------------------------------------------
EpochAccumulatorServiceState (serializable):
+----------------------------------------------------------------------+
| activeEpochId: "2026-01"                                             |
| activeEpochState: ClaimAccumState { nextLeafIndex, entries[], root } |
| archivedEpochs: [                                                    |
|   { epochId:"2025-12", info: EpochInfo, state: ClaimAccumState },    |
|   { epochId:"2025-11", info: ..., state: ... }, ...                  |
| ]                                                                    |
+----------------------------------------------------------------------+
   restoreState: 1.CLEAR all -> 2.RESTORE archived (rebuild trees+indexes) ->
                 3.RESTORE active -> 4.VERIFY roots match
SECTION F: PRODUCTION SCALE                                                                1310
-------------------------------------------------------------------------------------------------
US scale: 250M claims/yr, ~20.8M/mo. MerkleTree(24) = 16.7M leaves; production uses larger trees
(height 25 = 33.5M capacity) or sub-monthly rotation to accommodate peak volumes.
25-year archive: 300 epochs, ~6.25B claims, ~4TB disk. Each epoch independently queryable + provable.
Active epoch root committed per L2Batch. Archived roots are fixed historical values.
```
