# FIG. 15A — WAL Structure and Lifecycle (Sheet 19 of 22)

```
Replacement Sheet

FIG. 15A — WRITE-AHEAD LOG — STRUCTURE & LIFECYCLE                            Sheet 19 of 22
=================================================================================================

SECTION A: WRITE-AHEAD LOG STRUCTURE                                                       1500
-------------------------------------------------------------------------------------------------
WAL File Layout (NDJSON) — {dataDir}/wal/partition-0.wal:

  Line 1: {"entryId":"a3f2..","sequenceNumber":"0","type":"proof","partitionIndex":0,
           "walletId":"4829..","proofJson":"..","receiptData":{..},"auditEventData":{..},
           "stateSnapshot":{"registryRoot":"..","lifecycleRoot":"..","walletCount":"1",
           "auditChainHash":".."},"integrityHash":"b7c1..","timestamp":1709312000000,
           "committed":false}
  Line 2: {"commit":"a3f2.."}   <-- commit marker
  Line 3: {"entryId":"d4e5..","sequenceNumber":"1","type":"proof",...,"committed":false}
  Line 4: {"commit":"d4e5.."}   <-- commit marker
  Line 5: {"entryId":"f6a7..","sequenceNumber":"2","type":"batch_begin",...}
  Line 6: {"entryId":"c8b9..","sequenceNumber":"3","type":"batch_commit",...}
  Line 7: {"commit":"f6a7.."}
  Line 8: {"commit":"c8b9.."}   <-- crash here? lines 7-8 may not exist

WalEntry Fields:                                     Six Entry Types:
+-----------------------------------------------+   +------------------------------+
| entryId: SHA-256 first 128 bits               |   | 'proof'        ZK proof OK   |
|   (type:part:seq:ts, truncated to 32 hex)     |
| sequenceNumber: monotonic per partition       |   | 'batch_begin'  build start   |
| type: one of 6 types                          |   | 'batch_commit' build done    |
| partitionIndex: which partition               |   | 'batch_abort'  build failed  |
| walletId?: target wallet                      |   | 'settle'       settlement OK |
| proofJson?: serialized ZK proof               |   | 'fail'         settle failed |
| receiptData?: {id, walletId, roots...}        |   +------------------------------+
| auditEventData?: {walletId, roots...}         |
| claimEntryData?: {leaf, metadata}             |   stateSnapshot?: {registryRoot,
| batchData?: {batchNumber, proofCount...}      |     lifecycleRoot, walletCount,
| integrityHash: SHA-256 first 128 bits         |
|   (critical fields, truncated to 32 hex)      |     auditChainHash}
| timestamp, committed, originNodeId?           |
+----------------------------------------------+

SECTION B: WAL LIFECYCLE — APPEND -> COMMIT -> COMPACT                                     1502
-------------------------------------------------------------------------------------------------
WAL SAFETY CONTRACT:

  +--------+     +--------+     +------------+     +----------+
  | APPEND |---->| FSYNC  |---->| IN-MEMORY  |---->| COMMIT   |
  | to WAL |     | to disk|     | MUTATIONS  |     | MARKER   |
  | file   |     |        |     | applied    |     | to WAL   |
  +--------+     +--------+     +------------+     +----------+
       |              |               |                  |
  crash here:    crash here:     crash here:         crash here:
  partial write  entry durable,  entry on disk,      COMMITTED.
  (skip on       recoverable     not committed —     No data loss.
   recovery)     from WAL        replay from WAL

COMPACTION (after checkpoint):

  BEFORE: partition-0.wal                        AFTER: partition-0.wal
  +---------------------------------------+     +-------------------------------+
  | entry seq=0 (committed)   <- remove   |     | entry seq=3 (committed)       |
  | commit seq=0              <- remove   |     | commit seq=3                  |
  | entry seq=1 (committed)   <- remove   |     | entry seq=4 (uncommitted)     |
  | commit seq=1              <- remove   |     +-------------------------------+
  | entry seq=2 (committed)   <- remove   |
  |   <- checkpoint here                  |     truncateBefore(partition=0,
  | commit seq=2              <- remove   |       beforeSeq=2):
  | entry seq=3 (committed)   <- KEEP     |     1. Filter: keep seq > 2
  | commit seq=3              <- KEEP     |     2. Write to temp file
  | entry seq=4 (uncommitted) <- KEEP     |     3. fsync temp
  +---------------------------------------+     4. Atomic rename: temp -> .wal

Two implementations: FileWalProvider (production: NDJSON + fsync + atomic truncation + corrupt
line skip) and InMemoryWalProvider (testing: Map<partition, WalEntry[]>, same IWalProvider API)
```
