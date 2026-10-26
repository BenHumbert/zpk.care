# FIG. 15B — Quorum Protocol, Certificates, Crash Recovery (Sheet 20 of 22)

```
Replacement Sheet

FIG. 15B — QUORUM DURABILITY PROTOCOL, CERTIFICATES & CRASH RECOVERY          Sheet 20 of 22
=================================================================================================

SECTION C: QUORUM WRITE PROTOCOL (5-STEP)                                                 1504
-------------------------------------------------------------------------------------------------
           Client                  Leader (a)               Peer (b)              Peer (g)
             |                        |                        |                      |
             | submitProof(proof)     |                        |                      |
             |======================> |                        |                      |
             |                  STEP 1: Verify ZK proof        |                      |
             |                    WAL append type='proof'      |                      |
             |                    fsync to disk                |                      |
             |                    Self-vote (Ed25519 sign)     |                      |
             |                        |                        |                      |
             |                  STEP 2: Broadcast quorum:propose                      |
             |                        |---QuorumProposal-----> |                      |
             |                        |---QuorumProposal----------------------------->|
             |                        |                        |                      |
             |                        |                  STEP 3: WAL append + fsync   |
             |                        |                    Ed25519 sign vote          |
             |                        |<===QuorumVote==========|                      |
             |                        |<===QuorumVote=================================|
             |                        |                                               |
             |                  STEP 4: Votes: 3 (self+b+g), Threshold: N/2+1 = 2     |
             |                    3 >= 2 --> QUORUM REACHED                           |
             |                    Assemble QuorumCertificate                          |
             |                        |                                               |
             |                  STEP 5: Apply in-memory mutations                     |
             |                    Write WAL commit marker                             |
             |                    Attach certificate to L2Receipt                     |
             |<====L2Receipt==========|                                               |
             |    {receiptId, walletId, quorumCert: {proposalId, votes:[...]}}        |

TIMEOUT: Peer g DOWN --> votes=2 (self+b), threshold=2, 2>=2 --> QUORUM OK (degraded)
         Both peers DOWN --> votes=1, wait 5000ms --> TIMEOUT, reject: "Quorum timeout: 1/2 votes"

SECTION D: CERTIFICATE STRUCTURES                                                         1506
-------------------------------------------------------------------------------------------------
QuorumCertificate (Per-PROOF, on L2Receipt):      StateCertificate (Per-BATCH, on L2Batch):
+---------------------------------------------+  +--------------------------------------------+
| proposalId: "a3f2.." (= WAL entryId)        |  | version: 1                                 |
| partitionIndex: 0                           |  | batchNumber: "7", partitionIndex: 0        |
| sequenceNumber: "42"                        |  | stateDigest: {                             |
| walEntryHash: SHA-256 of WAL entry          |  |   latestSequenceNumber, latestBatchNumber, |
| stateDigestHash: hash of post-state         |  |   auditChainHash, claimAccumulatorRoot,    |
| leaderId: "alpha"                           |  |   registryRoot, lifecycleRoot,             |
| createdAt: 1709312001000                    |  |   walletCount }                            |
| votes: [                                    |  | stateDigestHash: SHA-256 pipe-delimited    |
|   {voterId:"alpha", signature:"3a4b..",     |  | signatures: [                              |
|    walEntryHash:"7b8c..", ts:...},          |  |   {nodeId:"alpha", signature:"3a4b..",     |
|   {voterId:"beta", signature:"8f9e..",      |  |    publicKeyHex:"7f8e.."},                 |
|    walEntryHash:"9d0a..", ts:...}           |  |   {nodeId:"beta", signature:"8f9e..",      |
| ]                                           |  |    publicKeyHex:"2c3d.."}]                 |
|                                             |  |                                            |
| Proves: N/2+1 nodes durably WAL'd this      |  | Canonical: "zkpcare-state-cert-v1|7|0|     |
|   proof before client ack                   |  |   {hash}|{nodeId}|{ts}"                    |
+---------------------------------------------+  | Proves: N/2+1 agree on state at batch      |
  Scope: per-PROOF   | Freq: every submission |  |   boundary. Replaces L1 as trust proof.    |
  Sign: zkpcare-quorum-vote-v1                |  +--------------------------------------------+
                                                 Scope: per-BATCH | Freq: every batch build

SECTION E: CRASH RECOVERY                                                                  1508
-------------------------------------------------------------------------------------------------
Node restarts after crash:

  PASS 1: COLLECT COMMITS                 PASS 2: LOAD ENTRIES
  Read WAL line-by-line                   Read WAL line-by-line
  if has "commit" field -->               if commit marker --> skip
    add entryId to commitSet              if entryId in commitSet -->
  (skip corrupt/partial lines)              entry.committed = true
          |                               Store in entries Map
          v                                       |
  REPLAY UNCOMMITTED ENTRIES                      v
  getUncommitted(partIdx) sorted by sequenceNumber
          |
          +-- type='proof': Apply receiptData, auditEventData, claimEntryData,
          |     advance roots from receipt's post-mutation values, write commit marker
          |     NO RE-PROVING NEEDED (all outputs pre-computed in WAL entry)
          |
          +-- type='batch_begin' (no matching batch_commit): DISCARD (incomplete batch)
          |
          +-- type='settle'/'fail': Apply settlement/failure status, write commit marker
          |
          v
  Node fully recovered. Resume normal operation.
```
