# FIG. 8A — Gossip Replication Protocol: Envelope, Messages, Spread (Compressed)

```
Replacement Sheet

FIG. 8A — Gossip Replication Protocol                           Sheet 8 of 22

+=======================================================================+
|| Replication is idempotent. Trust = ZK proof validity ONLY.          ||
|| Quorum votes = durability acks, NOT validity votes. No BFT/PoW/PoS. ||
+=======================================================================+

== SECTION A: GOSSIP MESSAGE ENVELOPE 800 ==

  +------------------------------------------------------------------+
  | GossipMessage 800                                                |
  | +--------------------------------------------------------------+ |
  | | messageId : string   SHA-256(type:senderId:ts:extra)[0:32]   | |
  | | type      : GossipMessageType   (1 of 12 typed events)       | |
  | | senderId  : string   nodeId of ORIGINAL sender               | |
  | | timestamp : number   ms since epoch (creation time)          | |
  | | payload   : GossipPayload   (union of 12 typed interfaces)   | |
  | | signature?: string   HMAC-SHA256 hex (optional gossipSecret) | |
  | +--------------------------------------------------------------+ |
  +------------------------------------------------------------------+

== SECTION B: TWELVE TYPED GOSSIP MESSAGES 802 ==

  +--------+---------------------+----------------------------------+-----------+
  | GROUP  | TYPE                | PAYLOAD SUMMARY                  | DELIVERY  |
  +--------+---------------------+----------------------------------+-----------+
  |        | proof:accepted      | L2Receipt + AuditEvent +         | BROADCAST |
  | PROOF  |                     |   claimEntry? + roots + count    |           |
  | LIFE-  | batch:built         | L2Batch + L2Block +              | BROADCAST |
  | CYCLE  |                     |   updatedReceipts/AuditEvents    |           |
  | (4)    | batch:settled       | batchNum + l1TxHash + roots      | BROADCAST |
  |        | batch:failed        | batchNum + reason                | BROADCAST |
  +--------+---------------------+----------------------------------+-----------+
  | DATA   | message:stored      | leafIndex + StoredMessage +      | BROADCAST |
  | STORES |                     |   MessagePayload + leafHash      |           |
  | (2)    | state:snapshot      | Full L2SequencerState (for IBD)  | BROADCAST |
  +--------+---------------------+----------------------------------+-----------+
  | LEADER | leader:heartbeat    | nodeId + partitions[] +          | BROADCAST |
  | -SHIP  |                     |   seqNums + pubKeyHex (5s/15s)   |           |
  | (2)    | leader:promotion    | newLeader + partIdx + prev +     | BROADCAST |
  |        |                     |   reason (timeout/manual/rejoin) |           |
  +--------+---------------------+----------------------------------+-----------+
  | QUORUM | quorum:propose      | proposalId + partIdx + seqNum +  | BROADCAST |
  | DURA-  |                     |   walEntryHash + stateDigest     |           |
  | BILITY | quorum:vote         | proposalId + voterId +           | DIRECTED  |
  | (3)    |                     |   walEntryHash + Ed25519 sig     |(to leader)|
  |        | quorum:certificate  | proposalId + votes[] (N/2+1) +   | BROADCAST |
  |        |                     |   stateDigest + leaderId         |           |
  +--------+---------------------+----------------------------------+-----------+
  | DISC-  | peer:announce       | nodeId + role + endpoint +       | BROADCAST |
  | OVERY  |                     |   partitions[] + capabilities    |           |
  | (1)    |                     |                                  |           |
  +--------+---------------------+----------------------------------+-----------+
  CRITICAL: quorum:vote confirms DURABLE WAL WRITE, NOT proof validity.

== SECTION C: EPIDEMIC SPREAD MECHANISM 804 ==

  5-node example: Leader A accepts proof

  Step 1: ORIGINATION                    Step 2: RELAY (from B)
  +-------+                              LEV-B relays broadcastExcept(A)
  | LEV-A | -> broadcast()                    |
  +---+---+                                   +----+----+----+
      |                                       |    |    |    |
      +----+----+----+                        v    v    v    v
      |    |    |    |                      [C]  [D]  [E]  -- ALL
      v    v    v    v                      ALREADY SEEN -> DROP
    [B]  [C]  [D]  [E]
    each marks messageId as seen           After relay: ALL nodes have message.
                                           Deduplication prevents infinite loops.

  handleIncomingAndRelay(msg, from):
  +----------------------------------------------------------------------+
  | 1. verifyGossip(msg) -- no secret? skip. HMAC mismatch? REJECT       |
  | 2. seenMessageSet.has(msgId)? YES -> return false (duplicate)        |
  | 3. markSeen(msgId) -- add to set + array                             |
  | 4. Notify handlers -- handler(msg) applies state mutations           |
  | 5. If gossipRelayEnabled: broadcastExcept(msg, fromPeerId)           |
  +----------------------------------------------------------------------+
```
