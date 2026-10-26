# FIG. 12A — Heartbeat Failover Protocol

```
Replacement Sheet

FIG. 12A — MULTI-LEADER HEARTBEAT FAILOVER: TOPOLOGY + HEARTBEAT PROTOCOL     Sheet 14 of 22
=========================================================================================

SECTION A: NORMAL-STATE MULTI-LEADER TOPOLOGY 1200
----------------------------------------------------
+==========================+  +==========================+  +==========================+
|| LEVIATHAN alpha        ||  || LEVIATHAN beta          ||  || LEVIATHAN gamma        ||
|| LEADS: P0              ||  || LEADS: P1               ||  || LEADS: P2              ||
||   Sequencer_0, WAL_0   ||  ||   Sequencer_1, WAL_1    ||  ||   Sequencer_2, WAL_2   ||
||   BatchTimer_0         ||  ||   BatchTimer_1          ||  ||   BatchTimer_2         ||
|| REPLICATES: P1,P2 (RO) ||  || REPLICATES: P0,P2 (RO)  ||  || REPLICATES: P0,P1 (RO) ||
|| MessageStore (GLOBAL)  ||  || MessageStore (GLOBAL)   ||  || MessageStore (GLOBAL)  ||
+==========================+  +===========================+  +==========================+

DETERMINISTIC FAILOVER CHAIN (pre-configured, static, never changes at runtime):
+-------------------------------+-------------------------------+-------------------------------+
| Partition 0:                  | Partition 1:                  | Partition 2:                  |
|   [alpha,beta,gamma]          |   [beta,gamma,alpha]          |   [gamma,alpha,beta]          |
| alpha=PRIMARY (priority 0)    | beta=PRIMARY (priority 0)     | gamma=PRIMARY (priority 0)    |
| beta=backup-1 (priority 1)    | gamma=backup-1 (priority 1)   | alpha=backup-1 (priority 1)   |
| gamma=backup-2 (priority 2)   | alpha=backup-2 (priority 2)   | beta=backup-2 (priority 2)    |
+-------------------------------+-------------------------------+-------------------------------+
Rule: LOWEST INDEX = HIGHEST PRIORITY. Highest-priority LIVE node leads. No election.

SECTION B: HEARTBEAT BROADCAST PROTOCOL 1202
----------------------------------------------
Heartbeat Sequence (every 5,000ms):

 Time    alpha         beta          gamma
  |       |              |              |
  |t=0s   |----HB------->|              |         HB = leader:heartbeat gossip
  |       |----HB---------------------> |         Broadcast to ALL connected peers
  |       |              |----HB------->|
  |       |<----HB-------|              |
  |       |<----HB--------------------- |
  |       |              |<----HB-------|
  |       |              |              |
  |t=5s   | (repeat)     | (repeat)     | (repeat)
  v       v              v              v

LeaderHeartbeatPayload:                    Leader Tracking -- leaderMap per node:
+---------------------------------------+   +--------------------------------------+
| nodeId: "alpha"                       |  | Example -- beta's leaderMap:         |
| partitions: [0] (led partitions)      |  | P0: leader=alpha, lastHB=t, local=N  |
| partitionSequences: {0: "42"}         |  | P1: leader=beta,  lastHB=t, local=Y  |
| timestamp: 1709312000000              |  | P2: leader=gamma, lastHB=t, local=N  |
| publicKeyHex?: "a1b2..." (Ed25519)    |  +--------------------------------------+
+---------------------------------------+
                                        Heartbeat interval: 5,000ms
                                        Heartbeat timeout:  15,000ms (3 missed = dead)
```
