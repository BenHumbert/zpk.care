# FIG. 12B — Heartbeat Failover Protocol

```
Replacement Sheet

FIG. 12B — MULTI-LEADER HEARTBEAT FAILOVER: FAILOVER + SPLIT-BRAIN + CLIENT   Sheet 15 of 22
=========================================================================================

SECTION C: FAILOVER DETECTION AND PROMOTION 1204
--------------------------------------------------
Timeline: alpha crashes, beta promotes for P0

 Time    alpha         beta                  gamma
  |t=5s   |--HB(P0:43)-> |                     |       alpha sends last heartbeat
  |t=10s  |==CRASH==|    |                     |       alpha goes offline
  |t=15s             |   | check: gap=10s      |       10s < 15s timeout -> not yet
  |t=20s             |   | check: gap=15s      |       15s >= 15s -> TIMEOUT!
  |                  |   | chain P0:[a,b,g]    |       alpha: DEAD->skip. beta: ME!->PROMOTE
  |                  |   |----PROMO(P0)------->|       beta starts BatchTimer for P0
  |                  |   |                     |       POST: beta leads P0+P1, gamma leads P2
  v                  v   v                     v

checkHeartbeats Algorithm:                 promoteToLeader(partIdx, prevLeader, reason):
+--------------------------------------+   +--------------------------------------+
| for each (partIdx, entry) in         |   | 1. leaderMap[part].currentLeader=me  |
|   leaderMap:                         |   |    .isLocalLeader=true               |
|   if entry.isLocalLeader: SKIP       |   | 2. Start batch timer for partition   |
|   if (now-lastHB) <= timeout: SKIP   |   | 3. Emit 'node:started' event         |
|   TIMEOUT -- walk failover chain:    |   |    {action:'leader_promotion'}       |
|   for candidateId in chain[partIdx]: |   | 4. Broadcast LeaderPromotionPayload  |
|     if candidate==deadLeader: skip   |   |    via 'leader:promotion' gossip     |
|     if candidate==me: PROMOTE SELF   |   +--------------------------------------+
|     if candidateIsAlive(id): break   |
|       (higher-priority should handle)|
|     else: continue (also dead)       |
| Each node decides INDEPENDENTLY.     |
| No election messages. Only heartbeat |
| timestamps + static failover chain.  |
+--------------------------------------+

SECTION D: SPLIT-BRAIN RESOLUTION 1206
----------------------------------------
Scenario: alpha recovers while beta already leads P0

 Time    alpha                beta                  Resolution Rule:
  |       | comes back online   | currently leads P0+P1 |
  |       |--HB(P0)-----------> |                       | chain P0: [alpha, beta, gamma]
  |       |                     | detects: alpha claims |
  |       |                     | P0 too! SPLIT-BRAIN!  | alpha idx=0, beta idx=1
  |       |                     |                       | LOWER INDEX = HIGHER PRIORITY
  |       |<==PROMO(P0,beta)=== |                       |
  |       |                     |                       | alpha: 0 < 1 -> I WIN, KEEP P0
  |       |                     | beta: 0 < 1 -> THEY   | beta: DEMOTE from P0
  |       |                     | WIN, I DEMOTE         |
  v       v                     v                       v

  RESOLVED: alpha leads P0 (restored), beta leads P1 (demoted from P0), gamma leads P2

handlePromotion(payload):                  demoteFromLeader(partIdx):
+--------------------------------------+   +---------------------------------------+
| if I ALSO lead this partition:       |   | 1. Stop batch timer                   |
|   chain = failoverChain[partIdx]     |   | 2. leaderMap[part].isLocalLeader=false|
|   myPri = chain.indexOf(me)          |   | 3. Emit 'node:started' event          |
|   theirPri = chain.indexOf(them)     |   |    {action:'leader_demotion'}         |
|   if theirPri < myPri: DEMOTE self   |   +---------------------------------------+
|   else: IGNORE (my HB wins)          |
| else: Accept, update leaderMap       |
+--------------------------------------+

SECTION E: CLIENT-SIDE TRANSPARENT FAILOVER 1208
--------------------------------------------------
+------------------+     +------------------+     +------------------+     +------------------+
| Entity Node      |     | POST to alpha    |     | ECONNREFUSED     |     | Query any node:  |
| submitProof(prf) | --> | (cached leader   | --> | alpha is down    | --> | l2_getPartition  |
| partition 0      |     | for P0)          |     |                  |     | Leaders()        |
+------------------+     +------------------+     +------------------+     +--------+---------+
                                                                                    |
                    +------------------+     +------------------+                   v
                    | SUCCESS          |     | Retry with beta  |     {P0:beta, P1:beta, P2:gamma}
                    | Transparent to   | <-- | (new P0 leader)  | <-- Update cached leaders
                    | caller           |     |                  |
                    +------------------+     +------------------+

Retry policy: Connection errors only (ECONNREFUSED/ECONNRESET/timeout). Max 1 retry.
DO NOT retry application errors (invalid proof, duplicate receipt, rate limit) -> propagate.
```
