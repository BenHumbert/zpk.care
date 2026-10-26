# FIG. 10B — Poseidon Hash Audit Chain

```
Replacement Sheet

FIG. 10B — POSEIDON HASH AUDIT CHAIN: GLOBALSTATE BINDING + AUDIT SUITE       Sheet 12 of 22
=========================================================================================

SECTION C: BINDING TO GLOBAL STATE 1004
-----------------------------------------
+=============================================+
|| GlobalState (10-Field Poseidon Commitment)||        Binding Chain:
||                                           ||
|| globalStateRoot = Poseidon.hash([         ||     auditChainHash (latest chainHash)
||   slot 0: walletRegistryRoot              ||              |
||   slot 1: walletCount                     ||              v
||   slot 2: adminPublicKeyHash              ||     GlobalState (10-field Poseidon commitment)
||   slot 3: lifecycleRoot                   ||              |
||   slot 4: benefitPlanRoot                 ||              v
||   slot 5: credentialRegistryRoot          ||     ChainProof (recursive ZK proof, ~22KB)
||   slot 6: eligibilityVkHash               ||
||   slot 7: messagingRoot                   ||     Single proof encapsulates: wallet registry,
||   slot 8: auditChainHash  <-- AUDIT HEAD  ||     lifecycle, benefit plans, credentials,
||   slot 9: blockHeight                     ||     messaging, ALL audit trail history,
|| ])                                        ||     and block height.
+=============================================+

SECTION D: SIX-CHECK AUDIT SUITE 1006
-----------------------------------------
AuditService.runFullAudit() -- stateless, no persistent state
Input: AuditLog, L2Batch[], OnChainState, rosterEntries[]
Output: FullAuditReport { overallHealthy, 6 check results }

+---+---------------------------+-----------+--------------------------------------------------+
| # | CHECK NAME                | SEVERITY  | WHAT IT VERIFIES                                 |
+---+---------------------------+-----------+--------------------------------------------------+
| 1 | Chain Integrity           | CRITICAL  | Walk from genesis, recompute each chainHash.     |
|   |                           |           | Poseidon.hash([prev, commit]) == event.chainHash |
+---+---------------------------+-----------+--------------------------------------------------+
| 2 | Financial Balance         | CRITICAL  | patientPay + planPay == ingredientCost + fee     |
|   |                           |           | for every claim event with claimContext          |
+---+---------------------------+-----------+--------------------------------------------------+
| 3 | Duplicate Detection       | CRITICAL  | Group by walletId | claimContext.ndcHash |       |
|   |                           |           | claimContext.dateOfService. Multiple receipts    |
|   |                           |           | in same group = duplicate                        |
+---+---------------------------+-----------+--------------------------------------------------+
| 4 | Sequence Gaps             | CRITICAL  | Each event.seqNum == previous.seqNum + 1.        |
|   |                           |           | Any gap = missing event (data loss/corruption)   |
+---+---------------------------+-----------+--------------------------------------------------+
| 5 | Orphaned Receipts         | INFO      | Events with status=='pending' older than 10 min. |
|   |                           |           | Expected during normal batch intervals           |
+---+---------------------------+-----------+--------------------------------------------------+
| 6 | Enrollment Consistency    | CRITICAL  | L2 registration events vs roster entries.        |
|   |                           |           | Detect unregistered or unrostered wallets        |
+---+---------------------------+-----------+--------------------------------------------------+

OVERALL HEALTH FORMULA:
+=========================================================================================+
|| overallHealthy = chainIntegrity.isValid && financialBalance.isValid                   ||
||   && !duplicates.hasDuplicates && !sequenceGaps.hasGaps                               ||
||   && enrollment.isConsistent                                                          ||
|| EXCLUDED: orphanedReceipts (pending work is normal)                                   ||
+=========================================================================================+
```
