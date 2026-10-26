# FIG. 7 — Partitioned Sequencer Network

```
Replacement Sheet

FIG. 7 — PARTITIONED SEQUENCER NETWORK                          Sheet 7 of 22

+=======================================================================+
|| No L1. No consensus. Trust = ZK proof cryptographic validity ONLY.  ||
|| partitionIndex = |walletId| mod partitionCount                      ||
+=======================================================================+

== SECTION A: CLIENT-SIDE PARTITION ROUTER 700 ==

  +----------------------------------------------------------------------+
  | NAUTILUS NODE -- PartitionRouter 700                                 |
  | 1. discoverPartitions() -> {count:3, P0:lev-A, P1:lev-B, P2:lev-C}   |
  | 2. Pre-establish L2Client to EVERY Leviathan                         |
  | 3. Route: partitionIndex = |walletId| mod 3 -> select L2Client       |
  | No centralized dispatcher. No load balancer. No routing oracle.      |
  +---------------+-------------------+-------------------+--------------+
                  | |W|mod3=0         | |W|mod3=1         | |W|mod3=2
                  v                   v                   v

== SECTION B: LEVIATHAN NETWORK 140 ==

  LEVIATHAN A 142-A             LEVIATHAN B 142-B             LEVIATHAN C 142-C
  +-------------------------+   +-------------------------+   +-------------------------+
  || nodeId: "lev-A"       ||   || nodeId: "lev-B"       ||   || nodeId: "lev-C"       ||
  || +-------------------+ ||   || +-------------------+ ||   || +-------------------+ ||
  || | P0 ** LEADER **   | ||   || | P0 Replicated     | ||   || | P0 Replicated     | ||
  || | accepts+batches   | ||   || +-------------------+ ||   || +-------------------+ ||
  || +-------------------+ ||   || | P1 ** LEADER **   | ||   || | P1 Replicated     | ||
  || | P1 Replicated     | ||   || | accepts+batches   | ||   || +-------------------+ ||
  || +-------------------+ ||   || +-------------------+ ||   || | P2 ** LEADER **   | ||
  || | P2 Replicated     | ||   || | P2 Replicated     | ||   || | accepts+batches   | ||
  || +-------------------+ ||   || +-------------------+ ||   || +-------------------+ ||
  || Per-partition         ||   || Per-partition         ||   || Per-partition         ||
  || L2SequencerService    ||   || L2SequencerService    ||   || L2SequencerService    ||
  +------------+------------+   +------------+------------+   +-------------------------+
               |    gossip (12 types)        |
               +-----------------------------+

  WALLET SPACE 702: Poseidon hashes pseudorandom -> ~uniform distribution across partitions.

== SECTION C: TWO-TIER PROOF REJECTION 704 ==

  Proof for walletId W
         |
         v
  +---------------------------+
  | TIER 1: L2SequencerSvc    |
  | |W| mod N == myPartIdx?   |
  +------+----------+---------+
       NO            YES
         |              |
         v              v
  +-----------+   +------------------------+
  | REJECT:   |   | TIER 2: L2Leviathan    |
  | "partition|   | Am I LEADER for        |
  |  mismatch"|   | partition |W| mod N?   |
  +-----------+   +------+----------+------+
                        NO            YES
                        |              |
                        v              v
                  +-----------+   +----------+
                  | REJECT:   |   | ACCEPT   |
                  | "not      |   | Process  |
                  |  leader"  |   | + Gossip |
                  +-----------+   +----------+

== SECTION D: FAILOVER CHAIN 706 ==

  Partition 0: [lev-A (primary), lev-B (backup1), lev-C (backup2)]
  Partition 1: [lev-B (primary), lev-C (backup1), lev-A (backup2)]
  Partition 2: [lev-C (primary), lev-A (backup1), lev-B (backup2)]

  Normal:                               Failover (lev-A down):
  +-------+   +-------+   +-------+   +-------+   +-------+   +-------+
  | lev-A |   | lev-B |   | lev-C |   | lev-A |   | lev-B |   | lev-C |
  | leads |   | leads |   | leads |   | DOWN  |   | leads |   | leads |
  | P0    |   | P1    |   | P2    |   | X X X |   | P1+P0 |   | P2    |
  +-------+   +-------+   +-------+   +-------+   +-------+   +-------+
       |           |           |
       +-- heartbeat (5s) -----+       Timeout: 15s (3 missed heartbeats)
                                       Promotion: deterministic priority.
                                       Split-brain: lower-priority demotes.
                                       NO voting. NO election. NO BFT.
```
