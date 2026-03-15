# zkp.care — Pricing & Infrastructure Analysis

## Scale: 2M Lives / 150 Employers / ~14M Claims per Year (58% Utilization)

---

## Part 1: Competitive Fee Analysis — How Much Can You Charge?

### What Competitors Charge

| Competitor | Model | Per-Claim | PMPM | Annual (2M lives) |
|---|---|---|---|---|
| **Traditional PBM (Big 3)** | Spread + retained rebates | $1-5/claim | $5-10 PMPM | $228M-486M |
| **Capital Rx / Judi Health** | Flat per-claim | **$0.99/claim** | ~$1.03 PMPM | $13.78M |
| **SmithRx** | Flat PMPM | N/A | **$6.00 PMPM** | $144M |
| **Navitus** | Flat PMPM | N/A | $5.00-7.50 PMPM | $120M-180M |
| **AffirmedRx** | Flat admin | varies | ~$4-6 PMPM | $96M-144M |

**Note on utilization**: At 58% member utilization (industry average), 2M members generate ~13.92M claims/year (1.16M utilizing members x 12 fills). Per-claim PBMs like Capital Rx scale with utilization; PMPM PBMs like SmithRx charge the same regardless. This is a structural advantage of per-claim pricing for lower-utilization populations.

**Capital Rx PMPM**: $0.99/claim x 13.92M claims = $13.78M/year ÷ 2M members ÷ 12 months = **$1.03 PMPM** (not ~$1.24 as sometimes cited — that figure incorrectly uses 100% utilization volume).

### What zkp.care Can Charge and Still Undercut Everyone

**Admin fee comparison** (apples-to-apples — the PBM's processing fee, excluding dispensing):

| zkp.care Pricing Tier | Admin Fee | Dispensing Markup | Total Fee/Fill | Admin Revenue | Total Revenue | Admin vs. Capital Rx | Total vs. SmithRx |
|---|---|---|---|---|---|---|---|
| **Ultra-Aggressive** | $0.10/claim | +$0.50/fill | $0.60 | $1.39M | $8.35M | **90% cheaper** | **94% cheaper** |
| **Aggressive (recommended)** | $0.25/claim | +$1.00/fill | $1.25 | $3.48M | $17.40M | **75% cheaper** | **88% cheaper** |
| **Competitive** | $0.35/claim | +$1.50/fill | $1.85 | $4.87M | $25.75M | **65% cheaper** | **82% cheaper** |
| **Premium** | $0.50/claim | +$2.00/fill | $2.50 | $6.96M | $34.80M | **50% cheaper** | **76% cheaper** |
| **At Parity (Capital Rx)** | $0.99/claim | +$0.00/fill | $0.99 | $13.78M | $13.78M | **Even** | **90% cheaper** |

All revenue figures: 13.92M claims/year x fee. Admin vs. Capital Rx compares admin-fee-only revenue ($13.78M at $0.99/claim). Total vs. SmithRx compares total revenue against $144M (PMPM, utilization-independent).

### Recommended Pricing: $0.25/claim + $1.00 dispensing fee markup

**Annual revenue: $17.4M** (13.92M claims x $1.25/fill)

- **Admin fee 75% below Capital Rx** — $3.48M vs. $13.78M for the same claims
- **Total fee 88% below SmithRx** — $17.4M vs. $144M
- **95%+ below traditional PBMs** — $17.4M vs. $228M-486M

**Why the dispensing fee markup works**: NADAC + dispensing fee is the standard transparent pricing model. Adding $1.00 to the dispensing fee is invisible to members (they pay copay, not dispensing fee) and obvious to employers (fully disclosed, auditable on-chain via Poseidon hash). Traditional dispensing fees are $2-5/fill — adding $1 keeps you well within market norms.

**Combined per-fill cost to employer**: $0.25 (admin) + $1.00 (dispensing markup) = **$1.25/fill**. Capital Rx charges $0.99/fill but with no dispensing markup transparency — pharmacy reimbursement is negotiated opaquely. zkp.care's total is $0.26 more per fill, but you get full dispensing transparency, zero PHI, and ZK adjudication. SmithRx charges $6 PMPM regardless of utilization — at 58% utilization that's $10.34 per actual fill vs. your $1.25.

---

## Part 2: Infrastructure Costs — Right-Sized Leviathan Fleet

### Claim Volume at 2M Lives (58% Utilization)

| Metric | Value |
|---|---|
| Members | 2,000,000 |
| Utilizing members (58%) | 1,160,000 |
| Avg Rx fills/utilizing member/year | 12 (industry average) |
| Total claims/year | 13,920,000 |
| Claims/day (average) | 38,137 |
| Peak day (1.5x — Monday after holiday) | ~57,000 |
| Peak hour (20% of daily in top 2 hours) | ~5,700/hr |
| Peak minute | ~95/min |

### Why Not 750 Nodes

The original 5-per-employer model assumed isolated proving capacity per employer. In practice:

1. **Statistical multiplexing** — 150 employers' claims don't spike simultaneously. Shared sequencers handle all partitions.
2. **Logical partitioning, not physical** — Leviathan's multi-partition architecture already supports multiple employer partitions per node.
3. **Replicas are for durability, not throughput** — they serve reads and failover, not parallel proving.

### JIT (Just-In-Time) Batch Proving

The protocol uses **JIT batching** — no timer-based batch intervals. Workers pull claims from the pending pool the instant they're idle:

```
Claim arrives → pending pool → idle worker grabs immediately → proves → batch finalizes
```

| Metric | Timer-Based (legacy) | **JIT** |
|---|---|---|
| Worst-case latency | timer + prove (3+ min) | **prove only (~30-45s)** |
| Worker utilization at peak | Low (idle between timers) | **100%** |
| Worker utilization off-peak | Same as peak | **0% (sleeping)** |
| Self-regulating | No | **Yes** |

JIT is self-regulating — during the 2am lull, workers sleep. During the 10am rush, every worker is saturated. No wasted cycles.

### Per-Node Throughput (JIT)

Each Leviathan runs 6 proving workers (800MB each, 8-core box). With 25% worker recycle overhead (~4.5 effective workers):

| Batch Size | Prove Time | Claims/min | Claims/day | Notes |
|---|---|---|---|---|
| 1 (wrapSingle) | ~30s | 9 | 12,960 | Lowest latency |
| 2 (wrapPair) | ~30-45s | 12-18 | 17,280-25,920 | Best balance |
| 4 (2 pairs + merge) | ~60s | 18 | 25,920 | Higher throughput |

### Recommended Topology: 5 Leviathans

| Role | Count | Purpose |
|---|---|---|
| **Sequencer 1-3** | 3 | 50 employer partitions each, 6 proving workers, WAL + JIT batching |
| **Replica 1** | 1 | Gossip replication, read queries, automatic failover |
| **Replica 2** | 1 | Second replica for quorum writes + geographic redundancy |
| **Total** | **5** | |

At JIT + batch_size=2: **~25,000 claims/day per sequencer**. Three sequencers handle ~75,000 claims/day combined — comfortably above the 57,000 peak day. Two replicas provide HA with 15s deterministic failover.

### Per-Node Spec Requirements

| Component | Minimum | Recommended | Notes |
|---|---|---|---|
| **CPU** | 4 cores | 8-16 cores | ZK proving is single-threaded per worker, but 6 workers run in parallel |
| **RAM** | 4 GB | 8-16 GB | Main process: 400MB + workers: 800MB each. 6 workers = 5.2GB min |
| **Disk** | 50 GB NVMe | 256 GB NVMe | WAL writes need fast fsync. Checkpoints: 5-10MB. Epochs: grows over years |
| **Network** | 100 Mbps | 1 Gbps | Gossip replication, SSE connections, RPC |

### Hosting Cost (5 Nodes)

| Option | $/Node/Mo | 5 Nodes/Mo | Annual |
|---|---|---|---|
| **Hetzner AX42** (8c, 64GB, bare metal) | $49 | **$245** | **$2,940** |
| **Hetzner EX44** (14c, 64GB, bare metal) | $47 | **$235** | **$2,820** |
| **OVH Advance-1** (16c, 64GB, bare metal) | $100 | **$500** | **$6,000** |
| **AWS m6i.4xlarge** (on-demand) | $561 | **$2,805** | **$33,660** |
| **AWS 3-year reserved** | $225 | **$1,125** | **$13,500** |

### Power Consumption (5 Nodes)

| Config | Idle | Load | Monthly Cost |
|---|---|---|---|
| 5x Ryzen 7 (Hetzner) | 250-400 W | 500-750 W | Included in Hetzner pricing |
| 5x Xeon Silver (colo) | 400-600 W | 1,000-1,400 W | ~$100/mo at $0.10/kWh |

### Recommended: 5x Hetzner AX42

| Node | Spec | Hetzner Plan | $/Mo |
|---|---|---|---|
| Sequencer 1 | 8c, 64GB | AX42 | $49 |
| Sequencer 2 | 8c, 64GB | AX42 | $49 |
| Sequencer 3 | 8c, 64GB | AX42 | $49 |
| Replica 1 | 8c, 64GB | AX42 | $49 |
| Replica 2 | 8c, 64GB | AX42 | $49 |
| **Total** | | | **$245/mo** |

**Annual infrastructure cost: ~$2,940**

### Scaling Path

| Scale | Leviathans | Annual Cost | Notes |
|---|---|---|---|
| 2M lives (current target) | 5 | $2,940 | 3 sequencers + 2 replicas |
| 5M lives | 8-10 | $4,704-$5,880 | Add sequencers for peak throughput |
| 10M lives | 14-20 | $8,232-$11,760 | Geographic distribution |
| 50M lives | 50-80 | $29,400-$47,040 | Still under $50K/year |

The protocol scales linearly. Even at 50M lives (20% of the Big 3's volume), infrastructure is under $50K/year.

---

## Part 3: P&L at Recommended Pricing

### Revenue ($0.25/claim + $1.00 dispensing markup, 58% utilization)

| Revenue Stream | Annual |
|---|---|
| Per-claim admin fee (13.92M x $0.25) | $3,480,000 |
| Dispensing fee markup (13.92M x $1.00) | $13,920,000 |
| **Total gross revenue** | **$17,400,000** |

### Costs

| Cost Category | Annual | Notes |
|---|---|---|
| Infrastructure (5 Leviathans) | $2,940 | Hetzner AX42 bare metal |
| Bandwidth / CDN | $10,000 | Gossip + RPC traffic (5 nodes) |
| Labor (~88 FTEs) | $8,400,000 | See labor-replacement doc for breakdown |
| Legal / Compliance | $200,000 | ERISA, HIPAA, state PBM licensing |
| Insurance (E&O, cyber) | $150,000 | |
| Office / Admin | $300,000 | |
| **Total operating costs** | **$9,062,940** | |

**Note**: Infrastructure is $2,940/year (0.02% of revenue) — a rounding error. Labor is the dominant cost at ~$8.4M. See [labor-replacement doc](zkpcare-labor-replacement-pharmacy-nadac.md) for the full ~88 FTE breakdown — 94% fewer people than a traditional PBM (~1,500 FTEs).

### Margin

| Metric | Value |
|---|---|
| **Gross revenue** | $17,400,000 |
| **Total costs** | $9,062,940 |
| **Net margin** | **$8,337,060** |
| **Margin %** | **47.9%** |

**Infrastructure is 0.02% of revenue.** Five bare-metal servers run the entire 2M-life PBM. Nearly half of every dollar is profit because the protocol replaces human labor.

---

## Part 4: Comparison Summary

| Metric | Traditional PBM | Capital Rx | SmithRx | **zkp.care** |
|---|---|---|---|---|
| Employer fee (2M lives/yr) | $228M-486M | $13.78M | $144M | **$17.40M** |
| Per-fill cost | $1-5 | $0.99 | ~$10.34/fill* | **$1.25** |
| PMPM equivalent | $5-10 | $1.03 | $6.00 | **$0.73** |
| PHI on servers | Yes | Yes | Yes | **No** |
| Adjudication | Central server | Central server | Central server | **ZK circuit (offline)** |
| Audit trail | SQL logs | SQL logs | SQL logs | **Poseidon hash chain** |
| Infrastructure cost | $50M+/yr | Unknown (raised $400M) | Unknown | **$2,940/yr** |
| Headcount | 1,000s | ~850 (Capital Rx) | ~550 (SmithRx) | **~88** |

*SmithRx per-fill: $144M ÷ 13.92M claims = $10.34/fill effective cost at 58% utilization. PMPM models punish low-utilization populations.

### The Pitch

> "We charge $1.25 per fill — $0.25 admin + $1.00 dispensing markup. That's $0.73 PMPM. Capital Rx charges $0.99 per claim but runs a central database with your members' PHI. SmithRx charges $6.00 PMPM regardless of how many prescriptions your members fill. We run zero PHI on our servers. Your claims are adjudicated by a ZK circuit at the pharmacy in 30 seconds — no network round-trip, no central point of breach. Our entire infrastructure is 5 servers at $245/month. And every dollar is cryptographically auditable."

---

*Generated 2026-03-15 — zkp.care / zkTrident*
