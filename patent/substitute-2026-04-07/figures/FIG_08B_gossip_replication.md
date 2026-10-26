# FIG. 8B — Gossip Replication Protocol: Dedup, Delivery, Quorum, Trust (Compressed)

```
Replacement Sheet

FIG. 8B — Gossip Replication Protocol                           Sheet 9 of 22

== SECTION D: DEDUPLICATION 806 ==

  +----------------------------------------------------------------------+
  | Bounded Deduplication Set 806                                        |
  |                                                                      |
  | seenMessages: string[]      (ordered, oldest first)                  |
  | seenMessageSet: Set<string> (O(1) lookup)                            |
  | MAX_SEEN_MESSAGES = 10,000                                           |
  |                                                                      |
  | markSeen(messageId):                                                 |
  |   if set.has(id): return (already tracked)                           |
  |   if length >= 10,000: evict oldest 5,000 (half), rebuild Set        |
  |   push(messageId) + set.add(messageId)                               |
  |                                                                      |
  | Before eviction:              After eviction:                        |
  | [msg_1 ... msg_5000 ...       [msg_5001 ... msg_10000, NEW_MSG]      |
  |  msg_10000]                    ^new oldest          newest^          |
  |  ^oldest       newest^                                               |
  +----------------------------------------------------------------------+

== SECTION E: BROADCAST vs DIRECTED MESSAGING 808 ==

  BROADCAST (11 types)                   DIRECTED (1 type)
  +----------------------------------+   +----------------------------------+
  | sender.broadcast(msg)            |   | sender.sendTo(peerId, msg)       |
  | -> ALL connected peers           |   | -> ONE specific peer, NO relay   |
  | -> each relays (except sender)   |   |                                  |
  |                                  |   | Type: quorum:vote ONLY           |
  | Types: proof:accepted,           |   | Why: vote goes BACK to proposing |
  |   batch:built/settled/failed,    |   | leader collecting N/2+1 votes.   |
  |   message:stored, state:snapshot,|   | Broadcasting would waste         |
  |   leader:heartbeat/promotion,    |   | bandwidth.                       |
  |   quorum:propose/certificate,    |   |                                  |
  |   peer:announce                  |   | sendTo() returns false if peer   |
  +----------------------------------+   | not found/disconnected.          |
                                         +----------------------------------+

== QUORUM DURABILITY FLOW (3-MESSAGE SEQUENCE) ==

  Leader                         Peer B                    Peer C
    |                              |                         |
    | 1. Accept proof              |                         |
    | 2. Write to own WAL          |                         |
    | 3. fsync                     |                         |
    |                              |                         |
    |-- quorum:propose (BROADCAST) ----------------------->  |
    |                              |                         |
    |                     4. Write to WAL           4. Write to WAL
    |                     5. fsync                  5. fsync
    |                     6. Ed25519 sign           6. Ed25519 sign
    |                              |                         |
    |<--- quorum:vote (DIRECTED) --|                         |
    |<--- quorum:vote (DIRECTED) --------------------------- |
    |                              |                         |
    | 7. Collect N/2+1 votes       |                         |
    | 8. Assemble certificate      |                         |
    | 9. Attach to L2Receipt       |                         |
    |                              |                         |
    |-- quorum:certificate (BROADCAST) --------------------> |

  Threshold: N/2+1 (e.g., 2 of 3)   Timeout: 5,000ms (proceed without cert)
  Each vote = Ed25519 signature over canonical pipe-delimited message.

== TRUST MODEL ==

  GOSSIP PROVIDES:                       GOSSIP DOES NOT PROVIDE:
  +----------------------------------+   +----------------------------------+
  | Replication (all nodes get data) |   | Proof validity (ZK crypto only)  |
  | Durability (WAL + quorum acks)   |   | Ordering consensus (partition    |
  | Leader discovery (heartbeats)    |   |   math is deterministic)         |
  | Failover (promote)               |   | Byzantine fault tolerance        |
  | Peer discovery (announce)        |   | Proof of work / proof of stake   |
  | Auth (HMAC) + Non-repudiation    |   | Validity-determining voting      |
  |   (Ed25519)                      |   |                                  |
  +----------------------------------+   +----------------------------------+

  Proof pathway: ZK proof on device -> partition leader -> o1js verify() ->
    if valid: accept + gossip -> ALL replicas trust (no re-verification)

== NETWORK PARAMETERS ==

  +----------------------------------------------------------------------+
  | MAX_SEEN_MESSAGES: 10,000       | Eviction: half (oldest 50%)        |
  | DEFAULT_MAX_PEERS: 12           | Peer announce: 60s                 |
  | Heartbeat interval: 5,000ms     | Heartbeat timeout: 15,000ms        |
  | Quorum vote timeout: 5,000ms    | Quorum threshold: floor(N/2)+1     |
  | messageId: SHA-256 trunc 32 hex | HMAC: HMAC-SHA256 (optional)       |
  | Vote sig: Ed25519 (128 hex)     | Delivery: HTTP via L2Client        |
  +----------------------------------------------------------------------+
```
