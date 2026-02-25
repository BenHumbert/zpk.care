# Diagram: Partition Failover — Transparent Client-Side Leader Re-Discovery

## Instructions for Diagram Generation

Create a detailed **sequence diagram** showing how a client-side entity node (MemberNode, PrescriberNode, or PharmacyNode) transparently handles a partition leader failure and re-routes to the newly promoted leader without user intervention.

The diagram should use a clean, professional style with:
- Four swim lanes (vertical columns): **Member Device**, **Partition 2 Leader (Alpha)**, **Primary Sequencer (Gateway)**, **Partition 2 Failover (Beta)**
- Time flows top to bottom
- Color coding: Member = green, Alpha (dying) = red/gray, Gateway = blue, Beta (promoted) = purple
- Failure events should be visually distinct (red X or lightning bolt)
- Retry paths should be visually distinct (dashed arrows, different color)
- Include a legend for: Normal request, Connection failure, Retry after re-discovery, Gossip message

---

## Diagram Content — Exact Sequence

### Title
**"Transparent Partition Failover — Client-Side Auto Re-Discovery"**

### Subtitle
"When a leviathan goes down, entity nodes automatically re-discover the new leader and retry. Zero user intervention."

---

### PHASE 1: Normal Operation — Proof Submission Succeeds

**Actor: Member Device (MemberNode)**

The member's device has a cached partition routing table from a previous `discoverPartitions()` call. The table maps wallet IDs to sequencer URLs.

**Show cached routing table on Member Device:**
```
Cached Partition Routing Table:
┌──────────────┬─────────────────────────────┐
│ Partition 0  │ http://alpha:3030           │
│ Partition 1  │ http://beta:3030            │
│ Partition 2  │ http://alpha:3030  ← cached │
│ Partition 3  │ http://gamma:3030           │
└──────────────┴─────────────────────────────┘

walletId mod 4 = 2  →  route to Alpha
```

**Arrow → to Alpha:**
```
client.submitProof(stateTransitionProof)
  → POST http://alpha:3030/rpc
  → { method: "l2_submitProof", params: [...] }
```

**Arrow ← from Alpha (success):**
```
L2Receipt {
  receiptId: "l2-00000042",
  walletId: "22933566...56270809",
  sequenceNumber: 42
}
```

**Annotation:**
> "This is the happy path. The cached partition URL is correct, Alpha is alive, and the proof is accepted."

---

### PHASE 2: Alpha Goes Down — Heartbeat Timeout

**Actor: Partition 2 Leader (Alpha)**

Alpha crashes or becomes unreachable. The member device does NOT know this yet — it still has Alpha cached as the Partition 2 leader.

**Show Alpha failure (red X / lightning bolt):**
```
╔════════════════════════════════╗
║  ALPHA — PARTITION 2 LEADER   ║
║                                ║
║        ╳ CRASHED ╳             ║
║                                ║
║  Last heartbeat: 12:00:00      ║
║  No further heartbeats sent    ║
╚════════════════════════════════╝
```

**Meanwhile, on the server side (between Gateway and Beta):**

**Show heartbeat timeout detection on Beta:**
```
Beta local state:
  Alpha last heartbeat: 12:00:00
  Current time:         12:00:15  (15s elapsed = 3 missed heartbeats)
  Failover chain for Partition 2: [Alpha, Beta, Gamma]
  Beta priority: 1 (next after Alpha)

  → PROMOTE SELF to Partition 2 leader
```

**Arrow from Beta → Gateway (gossip broadcast):**
```
GossipMessage {
  type: "leader:promotion",
  payload: {
    partitionIndex: 2,
    newLeaderId: "beta",
    previousLeaderId: "alpha",
    timestamp: 1708790415000
  }
}
```

**Annotation:**
> "Failover is deterministic — no consensus, no election. Beta checks its position in the pre-configured failover chain and promotes immediately after 15s heartbeat timeout."

---

### PHASE 3: Member Device Encounters Connection Failure

**Actor: Member Device (MemberNode)**

The member tries to submit another proof. The cached routing table still points to Alpha for Partition 2.

**Arrow → to Alpha (FAILS):**
```
client.submitProof(stateTransitionProof)
  → POST http://alpha:3030/rpc
  → ECONNREFUSED (Alpha is down)
```

**Show error detection in withPartitionRetry:**
```
╔══════════════════════════════════════════════════╗
║  EntityNodeBase.withPartitionRetry()             ║
║                                                  ║
║  1. getClientForWallet(walletId)                 ║
║     → cached client for Alpha                    ║
║                                                  ║
║  2. fn(client) → client.submitProof(proof)       ║
║     → THROWS: Error("ECONNREFUSED")              ║
║                                                  ║
║  3. isConnectionError(err) → TRUE                ║
║     Matches: "econnrefused"                      ║
║                                                  ║
║  4. → Trigger re-discovery                       ║
╚══════════════════════════════════════════════════╝
```

**Connection error detection (show the check):**
```
isConnectionError checks for:
  ✓ ECONNREFUSED  ← THIS ONE
  ✓ ECONNRESET
  ✓ ETIMEDOUT
  ✓ ENETUNREACH
  ✓ EHOSTUNREACH
  ✓ fetch failed
  ✓ network error
  ✓ socket hang up
  ✓ aborted

  ✗ "Proof rejected" → NOT a connection error (no retry)
  ✗ "Duplicate submission" → NOT a connection error (no retry)
```

**Annotation:**
> "The key distinction: connection errors (the server is unreachable) trigger re-discovery. Application errors (the server received the request but rejected it) propagate immediately without retry."

---

### PHASE 4: Automatic Re-Discovery

**Actor: Member Device (MemberNode)**

After detecting the connection error, `withPartitionRetry` calls `discoverPartitions()` which queries the Gateway (primary sequencer) for the current partition map.

**Arrow → to Gateway:**
```
discoverPartitions()
  → client.getPartitionInfo()
  → POST http://gateway:3030/rpc
  → { method: "l2_getPartitionInfo" }
```

**Arrow ← from Gateway (updated partition map):**
```
PartitionInfo {
  partitioned: true,
  partitionConfig: { partitionCount: 4 },
  allPartitions: [
    { partitionIndex: 0, url: "http://alpha:3030" },    ← still Alpha
    { partitionIndex: 1, url: "http://beta:3030" },
    { partitionIndex: 2, url: "http://beta:3030" },     ← NOW BETA!
    { partitionIndex: 3, url: "http://gamma:3030" },
  ]
}
```

**Show the updated routing table on Member Device:**
```
UPDATED Partition Routing Table:
┌──────────────┬──────────────────────────────────┐
│ Partition 0  │ http://alpha:3030                │
│ Partition 1  │ http://beta:3030                 │
│ Partition 2  │ http://beta:3030  ← UPDATED!     │
│ Partition 3  │ http://gamma:3030                │
└──────────────┴──────────────────────────────────┘

walletId mod 4 = 2  →  now route to Beta
```

**Annotation:**
> "The Gateway sequencer always knows the current partition leaders because it receives leader:promotion gossip messages. The member device refreshes its entire routing table in one call."

---

### PHASE 5: Transparent Retry Against New Leader

**Actor: Member Device (MemberNode)**

`withPartitionRetry` now calls `getClientForWallet(walletId)` again, which returns the new Beta client, and retries the exact same operation.

**Arrow → to Beta (NEW leader):**
```
retryClient.submitProof(stateTransitionProof)
  → POST http://beta:3030/rpc
  → { method: "l2_submitProof", params: [...] }
```

**Arrow ← from Beta (success):**
```
L2Receipt {
  receiptId: "l2-00000043",
  walletId: "22933566...56270809",
  sequenceNumber: 43
}
```

**Show the complete withPartitionRetry flow:**
```
╔══════════════════════════════════════════════════════════╗
║  withPartitionRetry<L2Receipt>(walletId, fn) — COMPLETE ║
║                                                          ║
║  1. client = getClientForWallet(walletId)  → Alpha       ║
║  2. fn(client) → ECONNREFUSED             → CAUGHT       ║
║  3. isConnectionError(err)                 → TRUE         ║
║  4. discoverPartitions()                   → refreshed    ║
║  5. retryClient = getClientForWallet(walletId) → Beta     ║
║  6. fn(retryClient)                        → SUCCESS      ║
║                                                          ║
║  Total: 1 failed attempt + 1 re-discovery + 1 retry     ║
║  Result: L2Receipt returned to caller                    ║
║  User awareness: NONE (transparent)                      ║
╚══════════════════════════════════════════════════════════╝
```

**Annotation:**
> "From the MemberNode.submitProof() caller's perspective, this looks like a normal (slightly slower) proof submission. The failover was handled entirely inside withPartitionRetry. No error propagated, no user action required."

---

### FINAL STATE — After Failover

**Show three summary boxes:**

**Member Device:**
```
✓ Proof submitted successfully (receipt l2-00000043)
✓ Partition routing table updated (Partition 2 → Beta)
✓ Future requests for this partition go directly to Beta
✗ No user notification or intervention needed
✗ No application-level error surfaced
```

**Alpha (Failed Leader):**
```
✗ Crashed / unreachable
✗ No longer serving Partition 2
  (Will rejoin as follower if it recovers)
```

**Beta (Promoted Leader):**
```
✓ Promoted to Partition 2 leader via failover chain
✓ Already had full state via gossip replication
✓ Serving proofs for Partition 2 wallets
✓ Broadcasting heartbeats for Partition 2
```

---

## Entity Types That Use This Mechanism

All three **client-side** entity nodes use `withPartitionRetry` for partition-routed operations:

```
┌──────────────────┬──────────────────────────────────────────────┐
│ MemberNode       │ submitProof(proof)                           │
│ (member phone)   │   routes to OWN wallet's partition           │
│                  │   withPartitionRetry(this.walletId, ...)     │
├──────────────────┼──────────────────────────────────────────────┤
│ PrescriberNode   │ submitProof(proof)                           │
│ (workstation)    │   routes to OWN wallet's partition           │
│                  │   withPartitionRetry(this.walletId, ...)     │
├──────────────────┼──────────────────────────────────────────────┤
│ PharmacyNode     │ submitProof(proof, memberWalletId?)          │
│ (POS terminal)   │   routes to MEMBER's partition for fills     │
│                  │   withPartitionRetry(targetWallet, ...)      │
│                  │   (targetWallet = memberWalletId or own)     │
└──────────────────┴──────────────────────────────────────────────┘
```

**Server-side entities do NOT use this mechanism:**
- **InsurerNode** — no wallet, no partition routing
- **L2Leviathan** — IS the sequencer, handles failover server-side

---

## Visual Style Notes

1. **Swim lanes**: Four vertical columns. Member (green), Alpha (red/gray after crash), Gateway (blue), Beta (purple after promotion).
2. **Phase transitions**: Clear horizontal dividers between the 5 phases.
3. **Failure indicator**: Red X or lightning bolt on Alpha when it crashes.
4. **Retry arrow**: Dashed green arrow from Member → Beta (distinct from the solid arrow to Alpha).
5. **Routing table updates**: Show BEFORE and AFTER with the changed row highlighted.
6. **The withPartitionRetry box**: Use a distinctive double-border (like the ZK proof boxes in the enrollment diagram).
7. **Timeline**: Show approximate wall-clock time at each phase boundary.
8. **The overall flow should read top-to-bottom**, with clear separation between normal operation → failure → detection → re-discovery → retry.

## Key Architectural Properties to Highlight

Add these as callout boxes or annotations:

1. **Exactly one retry**: `withPartitionRetry` retries exactly once after re-discovery. If the retry also fails (e.g., Gateway is also down), the error propagates to the caller. This prevents infinite retry loops.
2. **Connection vs. application errors**: Only connection-level failures (ECONNREFUSED, timeout, etc.) trigger re-discovery. Application-level rejections ("proof invalid", "duplicate submission") propagate immediately — they indicate a real problem, not a stale routing table.
3. **Gossip ensures state availability**: Beta already has all of Alpha's proofs and state via gossip replication. The failover leader doesn't need to sync — it already has everything.
4. **Deterministic failover chain**: No consensus needed. Each node independently computes who should be the new leader from the pre-configured priority ordering.
5. **Pharmacy cross-partition routing**: PharmacyNode is special — it routes fulfillment proofs to the MEMBER's partition, not its own. This means a pharmacy may need to re-discover if a different partition's leader fails, not just its own.
6. **No PHI in failover**: The entire failover mechanism operates on opaque wallet IDs and partition indices. No member name, DOB, or PII is involved at any point in the re-discovery or retry flow.
