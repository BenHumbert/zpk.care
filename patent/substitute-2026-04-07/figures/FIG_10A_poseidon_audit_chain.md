# FIG. 10A — Poseidon Hash Audit Chain

```
Replacement Sheet

FIG. 10A — POSEIDON HASH AUDIT CHAIN: HASH CHAIN LINKING + EVENT COMMITMENT   Sheet 11 of 22
=========================================================================================

SECTION A: HASH CHAIN LINKING 1000
------------------------------------
Genesis: Poseidon.hash([Field(0)])
Rule: chainHash_n = Poseidon.hash([chainHash_{n-1}, eventCommitment_n])

+----------------+     +------------------+
| Genesis Seed   |     | AuditEvent 0     |
| Poseidon.hash  |     | eventCommitment_0|
| ([Field(0)])   |     | = Poseidon.hash  |
+-------+--------+     | ([10 fields])    |
        |              +--------+---------+
        v                       v
   +--------------------------------------+
   | chainHash_0 = Poseidon.hash(         |
   |   [genesisHash, eventCommitment_0])  |
   +------------------+-------------------+
                      |          +------------------+
                      v          | AuditEvent 1     |
                      |          | eventCommitment_1|
                      |          +--------+---------+
                      v                   v
                 +--------------------------------------+
                 | chainHash_1 = Poseidon.hash(         |
                 |   [chainHash_0, eventCommitment_1])  |
                 +------------------+-------------------+
                                    |
                                   ...
                                    v
                 +--------------------------------------+
                 | chainHash_N = Poseidon.hash(         |      = latestChainHash
                 |   [chainHash_{N-1}, eventCommit_N])  |      = auditChainHash in    GlobalState 
                 +--------------------------------------+

TAMPER DETECTION: If event K is modified -> eventCommitment_K changes -> chainHash_K changes
-> ALL subsequent chainHash values break. Verification walks forward from genesis.

SECTION B: TEN-FIELD EVENT COMMITMENT 1002
--------------------------------------------
eventCommitment = Poseidon.hash([
  F1:  walletId             wallet involved
  F2:  oldRegistryRoot      registry root BEFORE
  F3:  newRegistryRoot      registry root AFTER
  F4:  oldLifecycleRoot     lifecycle root BEFORE
  F5:  newLifecycleRoot     lifecycle root AFTER
  F6:  sequenceNumber       monotonic event sequence
  F7:  isRegistration       1 if wallet reg, else 0
  F8:  ndcHash              drug identity (0 if non-claim)
  F9:  patientPayCents      patient copay (0 if non-claim)
  F10: planPayCents         insurer pay (0 if non-claim)
])
Registration events: F8-F10 = 0.  Claim events: F8-F10 populated from proof output.

AuditEvent Structure:
+-----------------------------------------------+-----------------------------------------------+
| CORE IDENTITY:                                | CRYPTOGRAPHIC CHAIN:                          |
|   sequenceNumber (monotonic from L2Receipt)   |   eventCommitment = Poseidon.hash([10 fields])|
|   receiptId (links to L2Receipt)              |   chainHash = Poseidon.hash([prev, commit])   |
|   walletId (opaque Poseidon hash)             |                                               |
|   isRegistration (boolean)                    | METADATA:                                     |
|                                               |   timestamp (ms epoch)                        |
| STATE ROOTS (before/after):                   |   l1Status ('pending'|'batched'|'settled')    |
|   oldRegistryRoot, newRegistryRoot            |   l2BlockNumber? (set after batching)         |
|   oldLifecycleRoot, newLifecycleRoot          |   l1BatchNumber? (set after batching)         |
|                                               |                                               |
| CLAIM DATA (optional):                        |                                               |
|   ndcHash?, patientPayCents?, planPayCents?   |                                               |
+-----------------------------------------------+-----------------------------------------------+
```
