# zpk.care — Startup Help (Internal Business & Strategy Notes)

**INTERNAL — REVIEW BEFORE PUBLISHING.** This is internal business material containing forward-looking projections, pricing strategy, and competitor analysis. It must be reviewed before any public release.

*Provenance: Consolidated from four docs/ strategy files — `zkpcare-full-strategic-presentation.md`, `zkpcare-protocol-plan-presentation.md`, `zkpcare-pricing-infrastructure-analysis.md`, and `zkpcare-labor-replacement-pharmacy-nadac.md` (all generated 2026-03-15, zkp.care / zkTrident).*

---

## 1. Positioning & Vision

### Core Thesis: zkp.care *Is* the PBM, Not a PBM Partner

zkp.care **replaces the entire PBM stack**. Every function a traditional PBM charges for is already built into the protocol. The protocol makes the PBM entity unnecessary.

| Traditional PBM Function | zkp.care Replacement | Status |
|---|---|---|
| Claims adjudication ($1-5/claim) | FulfillmentProgram ZK circuit — pharmacy-side, offline | Built |
| Eligibility verification | EligibilityData embedded in member credential | Built |
| Formulary management | FormularyRegistry MerkleTree(16), 32K NDCs | Built |
| Accumulator tracking (ded/OOP) | AccumulatorData in ACCESS_CONTROL tree leaf 127 | Built |
| Provider credentialing | ProviderRegistryService MerkleTree(16), 32K providers | Built |
| Claims history/reporting | ClaimAccumulatorService, 16M-leaf tree, 4 indexes | Built |
| Audit trail | Poseidon hash chain (10-Field commitment) — tamper-evident | Built |
| Prior authorization | AccessControlProgram — ZK verification of approved PAs (approval still requires clinical review) | Built |
| Batch settlement | BatchProgram + ChainProgram recursive proofs | Built |
| Messaging (PA requests, etc.) | MessageStoreService, encrypted, 1M messages | Built |
| Data replication / HA | Leviathan multi-leader gossip + WAL + quorum | Built |
| Member recovery | NFC card + WalletMigrationProgram | Built |

### The Differentiator No One Else Can Match (Structural Moat)

Every transparent PBM (SmithRx, Capital Rx/Judi, Navitus) still runs a **central database with PHI** — transparent about *pricing* but not about *data*. zkp.care is the only platform where:

- **Zero PHI on servers** — only Poseidon hashes; HIPAA liability drops to near-zero (nothing to breach).
- **Adjudication is deterministic** — ZK circuits, not business-rules engines with human overrides.
- **Audit is cryptographic** — tamper-evident hash chain, not SQL query logs.
- **Member owns their data** — proof-gated wallets, enrollment key never leaves device.
- **Infrastructure is distributed** — no single point of failure or breach.
- **5 servers run the entire PBM** — $2,940/year infrastructure for 2M lives (Capital Rx raised $400M).
- **88 people, not 1,500** — 94% headcount reduction.

> "That's not a feature list — that's a **structural moat**. Capital Rx spent $400M building Judi. zkp.care runs on 5 bare-metal servers with 88 employees. The protocol makes the PBM entity unnecessary."

### Three-Sided Value Proposition

- **Employers**: Save $210-469M/year vs. traditional PBMs; verifiable NADAC pricing (not "trust us"); zero PHI liability.
- **zkp.care**: $8.34M margin; 88 FTEs (not 1,500); 47.9% net margin.
- **Pharmacies**: No clawbacks; NADAC + $13; $1.66 profit/fill; instant settlement; no audit chargebacks; predictable cash flow.
- **Members**: $0 generic copay; on-device data; no call center waits; privacy by default; NFC card recovery.

---

## 2. The Problem / Market

### Industry Benchmarks (KFF/FTC 2025-2026)

- Average employer copays: Tier 1 ~$11, Tier 2 ~$37, Tier 3 ~$67, Tier 4 ~$116
- 2026 ACA OOP maximum: $9,200 individual / $18,400 family
- 2026 HDHP minimum deductible: $1,650 individual / $3,300 family
- Transparent PBM savings vs. legacy: 20-30% reduction
- U.S. PBM market: ~$460B (2025), projected $1.04T by 2034
- Big 3 PBMs: 80% market share, 270M lives, $7.3B excess revenue from specialty generic markups (FTC)
- Congress 2026: 100% rebate passthrough mandate (ERISA Section 6702)
- Industry Rx utilization rate: ~58% of members fill at least one prescription per year

### Pain Pharmacies Feel Today

| Problem | Impact | Source |
|---|---|---|
| Retroactive DIR fee clawbacks | $9.1B industry-wide (2019), growing 107,400% since 2010 | Drug Channels |
| Below-cost reimbursements | ~20% of prescriptions filled at a loss | FTC, ASPE |
| Pharmacy closures | 2,300 in 2024 (~8/day); 326 more in 10 weeks after PBM reform failed | Drug Topics |
| Unpredictable cash flow | Actual reimbursement unknown until months after dispensing | APhA |
| PBM-owned pharmacy steering | Big 3 affiliated pharmacies get 68% of specialty revenue (up from 54% in 2016) | FTC |
| Audit chargebacks | 83% of pharmacists see clawbacks 10+ times/month | NCPA |
| Independent closures | 29.4% of all retail pharmacies closed 2010-2021 | ASPE |

### What the FTC Found on Drug Markups (January 2025)

Big 3 PBMs marked up drugs above NADAC by:
- **22% of specialty generics**: over 1,000% above NADAC
- **41% of specialty generics**: 100-1,000% above NADAC
- **Example**: Tadalafil — NADAC ~$27, PBM charged $2,106 (**7,736% markup**)
- **Total extraction**: $7.3 billion above NADAC on specialty generics alone (2017-2022)

### Regulatory Alignment

The 2026 Consolidated Appropriations Act mandates 100% rebate passthrough and delinked compensation by 2028-2029. zkp.care is *already* compliant — the settlement circuit has no field for rebate retention, making non-compliance structurally impossible.

---

## 3. Product & Protocol Plan

### Reference Scale & Assumptions

- **2M lives / 150 employers / ~14M claims per year** at **58% utilization**.
- All figures use: 58% utilization (13.92M claims), 88 FTEs ($8.4M labor), 5 Leviathans ($2,940/yr), per-claim pricing ($0.25 admin + $1.00 dispensing markup), $13 pharmacy dispensing fee.

### Claim Volume (58% Utilization)

| Metric | Value |
|---|---|
| Members | 2,000,000 |
| Utilizing members (58%) | 1,160,000 |
| Avg Rx fills/utilizing member/year | 12 (industry average) |
| Total claims/year | 13,920,000 |
| Claims/day (average) | 38,137 |
| Peak day (1.5× — Monday after holiday) | ~57,000 |
| Peak hour (20% of daily in top 2 hours) | ~5,700/hr |
| Peak minute | ~95/min |

### The Protocol Plan (Plan Design Only zkp.care Can Offer)

| Parameter | Value | Rationale |
|---|---|---|
| Admin fee | $0 PMPM | Per-claim only ($0.25/claim + $1.00 dispensing markup) — employer pays nothing when members don't fill |
| Drug pricing | NADAC passthrough | Exact acquisition cost, verifiable on-chain |
| Pharmacy reimbursement | NADAC + $13 dispensing fee | $1.66 above pharmacy operational cost — attracts pharmacies |
| Rebates | 100% to employer | Cryptographically auditable via Poseidon hash chain |
| Generic copay | $0 | Maximize generic utilization, improve adherence |
| Preferred brand | $15 | Competitive with Cost Plus Basic |
| Non-preferred brand | $40 | Competitive with Employer Premier |
| Specialty | $50 flat | No coinsurance surprises |
| Deductible | $0 / $0 family | Zero friction |
| OOP Max | $2,000 / $4,000 family | Strong member protection |
| Annual Max | Unlimited | No catastrophic gap |
| Formulary | Open + step therapy | ZK circuit enforces clinical rules automatically |

### Compatible Plan Templates (8 Transparent PBM Designs)

All templates use 100% rebate passthrough, NADAC-based transparent pricing, per-claim admin fees, unlimited annual max, and NADAC + $13 dispensing fee to pharmacy. Per-template pricing/admin notes are included where they differ.

| # | Name | Pricing / Admin | Generic | Pref Brand | Non-Pref | Specialty | Deductible (Ind/Fam) | OOP Max (Ind/Fam) | Annual Max |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Cost Plus Basic | NADAC + 2% + $3.50 dispensing | $0 | $15 | $50 | 20% (max $150) | $0 / $0 | $2,000 / $4,000 | Unlimited |
| 2 | Transparent Value | Flat admin, pass-through | $5 | $25 | $60 | 25% (max $250) | $100 / $200 | $3,000 / $6,000 | Unlimited |
| 3 | HDHP Pharmacy Integrated | HSA-compatible, $0.99/claim | $10 | $35 | 30% | 25% (all after deductible) | $1,650 / $3,300 (IRS 2026 HDHP min) | $4,500 / $9,000 | Unlimited |
| 4 | Employer Premier | Richest benefit | $0 | $20 | $40 | $50 flat | $0 / $0 | $1,500 / $3,000 | Unlimited |
| 5 | Cost Plus + Copay Assist | NADAC + 3% + $2 | $3 | $30 | $75 | 20% + $0 preventive tier | $150 / $300 | $3,500 / $7,000 | Unlimited |
| 6 | Small Employer Essential | 3-tier simplified | $10 | $40 | 30% | — | $200 / $400 | $4,000 / $8,000 | Unlimited |
| 7 | GLP-1 Inclusive | Dedicated GLP-1 tier with clinical guardrails | $5 | $35 | $70 | 25% + $150 GLP-1 | $250 / $500 | $4,000 / $8,000 | Unlimited (GLP-1 sub-limit $25K) |
| 8 | Municipal / Public Sector | Broad access, public sector compliant | $5 | $15 | $35 | $50 flat | $0 / $0 | $2,000 / $4,000 | Unlimited |

---

## 4. Business Model, Pricing & P&L

### Revenue Model

- $0.25/claim admin + $1.00/fill dispensing markup = **$17.4M/year** at 58% utilization.
- Per-claim pricing means the employer pays nothing when members don't use benefits — no PMPM tax on healthy populations.

### zkp.care Pricing Tiers

Admin fee = the PBM's processing fee, excluding dispensing. Revenue figures = 13.92M claims/year × fee.

| Tier | Admin Fee | Dispensing Markup | Total Fee/Fill | Admin Revenue | Total Revenue | Admin vs. Capital Rx | Total vs. SmithRx |
|---|---|---|---|---|---|---|---|
| Ultra-Aggressive | $0.10/claim | +$0.50/fill | $0.60 | $1.39M | $8.35M | 90% cheaper | 94% cheaper |
| **Aggressive (recommended)** | **$0.25/claim** | **+$1.00/fill** | **$1.25** | **$3.48M** | **$17.40M** | **75% cheaper** | **88% cheaper** |
| Competitive | $0.35/claim | +$1.50/fill | $1.85 | $4.87M | $25.75M | 65% cheaper | 82% cheaper |
| Premium | $0.50/claim | +$2.00/fill | $2.50 | $6.96M | $34.80M | 50% cheaper | 76% cheaper |
| At Parity (Capital Rx) | $0.99/claim | +$0.00/fill | $0.99 | $13.78M | $13.78M | Even | 90% cheaper |

- Admin vs. Capital Rx compares admin-fee-only revenue ($13.78M at $0.99/claim). Total vs. SmithRx compares total revenue against $144M (utilization-independent PMPM).
- **Recommended pricing: $0.25/claim + $1.00 dispensing fee markup** — annual revenue $17.4M; admin fee 75% below Capital Rx ($3.48M vs. $13.78M); total fee 88% below SmithRx ($17.4M vs. $144M); 95%+ below traditional PBMs ($17.4M vs. $228M-486M).
- **Why the dispensing markup works:** NADAC + dispensing fee is the standard transparent model. Adding $1.00 is invisible to members (they pay copay, not the dispensing fee), fully disclosed/auditable to employers (on-chain via Poseidon hash). Traditional dispensing fees are $2-5/fill, so +$1 stays within market norms.
- **Combined per-fill cost to employer:** $0.25 (admin) + $1.00 (dispensing markup) = **$1.25/fill**. Capital Rx charges $0.99/fill but with opaque pharmacy reimbursement. SmithRx's $6 PMPM = $10.34 per actual fill at 58% utilization vs. zkp.care's $1.25.

### Extraction Above Drug Cost (2M Lives, 58% Utilization)

| Cost Component | Traditional PBM | Transparent PBM (SmithRx/Judi) | zkp.care |
|---|---|---|---|
| Admin fee | $120M-240M/yr ($5-10 PMPM) | $144M/yr ($6 PMPM) | $0 PMPM — per-claim only |
| Spread pricing | $58M-96M/yr | $0 | $0 |
| Rebate retention | $50M-150M/yr | $0 | $0 |
| PBM fee to employer | Included in admin | Included in admin | $17.4M/yr ($0.25/claim + $1.00/fill) |
| **Total extraction above drug cost** | **$228M-486M/yr** | **$144M/yr** | **$17.4M/yr** |

### P&L at 2M Lives (Recommended Pricing, 58% Utilization)

**Revenue**

| Stream | Annual |
|---|---|
| Per-claim admin fee (13.92M × $0.25) | $3,480,000 |
| Dispensing fee markup (13.92M × $1.00) | $13,920,000 |
| **Total gross revenue** | **$17,400,000** |

**Costs**

| Category | Annual | Notes |
|---|---|---|
| Infrastructure (5 Leviathans) | $2,940 | Hetzner AX42 bare metal |
| Bandwidth / CDN | $10,000 | Gossip + RPC traffic (5 nodes) |
| Labor (~88 FTEs) | $8,400,000 | See Operations & Labor Replacement |
| Legal / Compliance | $200,000 | ERISA, HIPAA, state PBM licensing |
| Insurance (E&O, cyber) | $150,000 | |
| Office / Admin | $300,000 | |
| **Total operating costs** | **$9,062,940** | |

**Margin**

| Metric | Value |
|---|---|
| Gross revenue | $17,400,000 |
| Total costs | $9,062,940 |
| **Net margin** | **$8,337,060** |
| **Margin %** | **47.9%** |
| Margin at 5M lives | ~$43.5M revenue, ~$15M costs = **$28.5M (66%)** |

Infrastructure is **0.02% of revenue**. Labor is the dominant cost. Nearly half of every dollar is profit because the protocol replaces human labor.

### Employer Savings

- **$126.6M/year** vs. transparent PBM ($144M − $17.4M).
- **$210.6M-468.6M/year** vs. traditional PBMs.

---

## 5. Infrastructure & Cost / Fleet Sizing

### Why Not 750 Nodes

The original 5-per-employer model assumed isolated proving capacity per employer. In practice:
1. **Statistical multiplexing** — 150 employers' claims don't spike simultaneously; shared sequencers handle all partitions.
2. **Logical partitioning, not physical** — Leviathan's multi-partition architecture already supports multiple employer partitions per node.
3. **Replicas are for durability, not throughput** — they serve reads and failover, not parallel proving.

### JIT (Just-In-Time) Batch Proving

No timer-based intervals. Workers pull claims from the pending pool the instant they're idle:
`Claim arrives → pending pool → idle worker grabs immediately → proves → batch finalizes`. JIT is self-regulating: workers sleep during the 2am lull and saturate during the 10am rush.

| Metric | Timer-Based (legacy) | JIT (zkp.care) |
|---|---|---|
| Worst-case latency | timer + prove (3+ min) | prove only (~30-45s) |
| Worker utilization at peak | Low (idle between timers) | 100% |
| Worker utilization off-peak | Same as peak | 0% (sleeping) |
| Self-regulating | No | Yes |

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
| Sequencer 1-3 | 3 | 50 employer partitions each, 6 proving workers, WAL + JIT batching |
| Replica 1 | 1 | Gossip replication, read queries, automatic failover |
| Replica 2 | 1 | Second replica for quorum writes + geographic redundancy |
| **Total** | **5** | |

At JIT + batch_size=2: **~25,000 claims/day per sequencer**. Three sequencers handle ~75,000 claims/day combined — above the 57,000 peak day. Two replicas provide HA with 15s deterministic failover.

### Per-Node Spec Requirements

| Component | Minimum | Recommended | Notes |
|---|---|---|---|
| CPU | 4 cores | 8-16 cores | ZK proving single-threaded per worker; 6 workers in parallel |
| RAM | 4 GB | 8-16 GB | Main process 400MB + workers 800MB each; 6 workers = 5.2GB min |
| Disk | 50 GB NVMe | 256 GB NVMe | WAL needs fast fsync; checkpoints 5-10MB; epochs grow over years |
| Network | 100 Mbps | 1 Gbps | Gossip replication, SSE connections, RPC |

### Hosting Cost (5 Nodes)

| Option | $/Node/Mo | 5 Nodes/Mo | Annual |
|---|---|---|---|
| **Hetzner AX42** (8c, 64GB, bare metal) | $49 | **$245** | **$2,940** |
| Hetzner EX44 (14c, 64GB, bare metal) | $47 | $235 | $2,820 |
| OVH Advance-1 (16c, 64GB, bare metal) | $100 | $500 | $6,000 |
| AWS m6i.4xlarge (on-demand) | $561 | $2,805 | $33,660 |
| AWS 3-year reserved | $225 | $1,125 | $13,500 |

**Recommended: 5× Hetzner AX42** — 5 nodes (Sequencer 1-3, Replica 1-2), each 8c/64GB AX42 at $49/mo = **$245/mo total = ~$2,940/year**.

### Power Consumption (5 Nodes)

| Config | Idle | Load | Monthly Cost |
|---|---|---|---|
| 5× Ryzen 7 (Hetzner) | 250-400 W | 500-750 W | Included in Hetzner pricing |
| 5× Xeon Silver (colo) | 400-600 W | 1,000-1,400 W | ~$100/mo at $0.10/kWh |

### Scaling Path

| Scale | Leviathans | Annual Cost | Notes |
|---|---|---|---|
| 2M lives (current target) | 5 | $2,940 | 3 sequencers + 2 replicas |
| 5M lives | 8-10 | $4,704-$5,880 | Add sequencers for peak throughput |
| 10M lives | 14-20 | $8,232-$11,760 | Geographic distribution |
| 50M lives | 50-80 | $29,400-$47,040 | Still under $50K/year |

The protocol scales linearly. Even at 50M lives (20% of the Big 3's volume), infrastructure is under $50K/year.

---

## 6. Operations & Labor Replacement

**Premise**: A mid-size PBM serving 2M lives employs ~1,500 people. zkp.care needs ~88 to do the same work (**94% reduction**). **Labor savings: $52-92M/year.**

### Claims Processing & Adjudication (~120-210 FTEs)

| Role | Headcount | Avg Salary | Total Cost | zkp.care Replacement |
|---|---|---|---|---|
| Claims exception handlers | 50-80 | $50,000 | $2.5-4.0M | FulfillmentProgram ZK circuit rejects invalid claims at proof generation — no exceptions reach sequencer. If a proof doesn't verify, it doesn't exist. |
| Claims auditors/analysts | 20-40 | $55,800 | $1.1-2.2M | Poseidon hash chain is tamper-evident. Every claim = Poseidon.hash(10 Fields incl. walletId, ndcHash, patientPay, planPay). Modification breaks chain — detectable via AuditService.verifyReceiptChain(). |
| Rules/config analysts | 30-50 | $65,000 | $2.0-3.3M | BenefitPlanConfig on sequencer with WAL durability. Formulary = MerkleTree(16). Changes propagate via gossip. |
| IT/system support | 20-40 | $85,000 | $1.7-3.4M | Leviathan self-healing: WAL recovery, gossip replication, automatic failover on 15s heartbeat timeout. |
| **Subtotal** | **120-210** | | **$7.3-12.9M** | |

### Prior Authorization (~120-180 FTEs)

| Role | Headcount | Avg Salary | Total Cost | zkp.care Replacement |
|---|---|---|---|---|
| PA intake specialists | 40-60 | $43,000 | $1.7-2.6M | AccessControlProgram ZK circuit checks formulary membership + quantity limits deterministically. PA verification at pharmacy instant (<1ms). |
| PA clinical reviewers (PharmD) | 30-50 | $140,000 | $4.2-7.0M | **PARTIALLY REPLACED.** Approval decisions still need clinical judgment. Once approved, PA embedded in member's MerkleForest — verification instant via ZK proof. Eliminates re-review on every fill. |
| PA support/follow-up | 50-70 | $45,000 | $2.3-3.2M | After approval, no follow-up — pharmacy verifies PA via Merkle witness proof. |
| **Subtotal** | **120-180** | | **$8.2-12.8M** | |

**Industry context**: PA costs $11/request manually, $1.88 electronically. Industry spends **$13 billion/year** on PA. zkp.care eliminates PA verification cost; approval decisions still require clinical staff. Net reduction ~60% of PA labor. **Note**: Step therapy enforcement not yet implemented in ZK circuit (field exists in FormularyEntry but not asserted). Planned for future release.

### Member Services / Call Center (~200-300 FTEs)

| Role | Headcount | Avg Salary | Total Cost | zkp.care Replacement |
|---|---|---|---|---|
| Benefit inquiry agents | 80-120 | $40,000 | $3.2-4.8M | EligibilityData + AccumulatorData in member credential. Cached on device: deductible status, OOP progress, formulary coverage queryable offline via BenefitCheckService. |
| Claims status agents | 50-80 | $38,000 | $1.9-3.0M | L2Receipt returned real-time via SSE. Claim status is a hash lookup. SSE with 256-event replay buffer. |
| Enrollment/eligibility agents | 40-60 | $42,000 | $1.7-2.5M | Three-party enrollment: employer token → member derives wallet on device → insurer processes via EnrollmentService. Member submits only walletId + tokenId (zero PHI transmitted). Insurer-assisted, not fully self-service. |
| Supervisors/QA | 30-40 | $55,000 | $1.7-2.2M | No call center = no supervisors. |
| **Subtotal** | **200-300** | | **$8.5-12.5M** | |

**Industry context**: PBM calls cost $4.20-$4.35 each. At 0.5-1.2 calls/member/year, a 2M-member PBM handles 1-2.4M calls/year = $4.2-10.4M in call center costs.

### Clinical / Formulary Management (~100-150 FTEs)

| Role | Headcount | Avg Salary | Total Cost | zkp.care Replacement |
|---|---|---|---|---|
| Clinical pharmacists (P&T) | 40-60 | $145,000 | $5.8-8.7M | **NOT FULLY REPLACED.** Formulary decisions (inclusion, tier placement) need clinical judgment. Execution automated — publish to MerkleTree, gossip to all nodes. |
| Formulary analysts | 30-50 | $65,000 | $2.0-3.3M | FormularyRegistry MerkleTree updates propagate automatically. BenefitPlanConfig stored with WAL + gossip. |
| Drug utilization reviewers | 30-40 | $130,000 | $3.9-5.2M | ClaimAccumulatorService provides NDC-level claim data via 4 indexes (member, pharmacy, prescriber, NDC) + 6 RPC query methods. Analytics/pattern detection tooling is future work. |
| **Subtotal** | **100-150** | | **$11.7-17.2M** | |

**Note**: Still need ~10-15 clinical pharmacists for formulary committee decisions and drug evaluation. The 100+ support staff who code/configure/maintain formulary systems are replaced.

### Network Contracting (~45-75 FTEs)

| Role | Headcount | Avg Salary | Total Cost | zkp.care Replacement |
|---|---|---|---|---|
| Network contract managers | 15-25 | $113,800 | $1.7-2.8M | ProviderRegistryService handles credentialing with 5-state lifecycle (PENDING → VERIFIED → ACTIVE → SUSPENDED → TERMINATED). NFC credential attestation enables instant member verification (<1ms Ed25519 sig check). |
| Contract support/admin | 30-50 | $50,000 | $1.5-2.5M | At 2M lives, direct pharmacy contracting replaces thousands of negotiations. NADAC + dispensing fee = universal rate. No MAC lists. |
| **Subtotal** | **45-75** | | **$3.2-5.3M** | |

### Finance / Rebate Administration (~60-90 FTEs)

| Role | Headcount | Avg Salary | Total Cost | zkp.care Replacement |
|---|---|---|---|---|
| Rebate analysts | 20-30 | $65,000 | $1.3-2.0M | 100% passthrough is a protocol rule. NDC-level claim data on-chain means rebate reconciliation is a deterministic query. |
| Financial reconciliation | 20-30 | $60,000 | $1.2-1.8M | L2Batch settlement sequencer-finalized with Poseidon root commitments. No EOD file reconciliation, no claim-level payment disputes. |
| Reporting/analytics | 20-30 | $75,000 | $1.5-2.3M | ReportingService generates 12 report types from VerifiedClaim data (claims register, pharmacy/prescriber/member activity, medication utilization, financial summary, PA, reversals, tier analysis, therapeutic class, time series, cross-tab). |
| **Subtotal** | **60-90** | | **$4.0-6.1M** | |

### Compliance / Regulatory (~45-75 FTEs)

| Role | Headcount | Avg Salary | Total Cost | zkp.care Replacement |
|---|---|---|---|---|
| Compliance officers | 15-25 | $75,000 | $1.1-1.9M | Tamper-evident audit trail (AuditService) with Poseidon hash chain. Tampering detectable via verifyReceiptChain() — post-hoc but cryptographically guaranteed. |
| HIPAA/privacy staff | 15-25 | $70,000 | $1.1-1.8M | **Zero PHI on servers** — only Poseidon hashes. HIPAA liability drops to near-zero (nothing to breach). |
| Regulatory analysts | 15-25 | $65,000 | $1.0-1.6M | ERISA 100% passthrough is structural — settlement circuit has no field for rebate retention. |
| **Subtotal** | **45-75** | | **$3.2-5.3M** | |

### Total Labor Replacement Summary

| Department | Traditional PBM FTEs | Annual Labor Cost | % Replaced | Remaining Human Need |
|---|---|---|---|---|
| Claims Processing | 120-210 | $7.3-12.9M | 100% | 0 FTEs |
| Prior Authorization | 120-180 | $8.2-12.8M | 83% | ~25 (15 PharmDs + 10 intake) |
| Call Center | 200-300 | $8.5-12.5M | 92% | ~20 (employer onboarding, edge cases) |
| Clinical/Formulary | 100-150 | $11.7-17.2M | 95% | ~8 (5 P&T PharmDs + 3 analysts) |
| Network Contracting | 45-75 | $3.2-5.3M | 96% | ~3 (chain relationships) |
| Finance/Rebate | 60-90 | $4.0-6.1M | 97% | ~3 (financial reporting, tax) |
| Compliance | 45-75 | $3.2-5.3M | 93% | ~5 (regulatory affairs) |
| IT/Infrastructure | 40-60 | $3.4-5.1M | 92% | ~5 (2 SREs + 3 engineers) |
| Account Management | 75-120 | $5.3-11.4M | 92% | ~10 (enterprise accounts) |
| Executive/HR/Other | 75-120 | $6.0-12.0M | N/A | ~9 (CEO, CTO, COO, CFO, GC + 4 support) |
| **TOTAL** | **~1,500** | **$60.8-100.6M** | | **~88 FTEs** |

---

## 7. Competitive Landscape

### What Competitors Charge

| Competitor | Model | Per-Claim | PMPM | Annual (2M lives) |
|---|---|---|---|---|
| Traditional PBM (Big 3) | Spread + retained rebates | $1-5/claim | $5-10 PMPM | $228M-486M |
| Capital Rx / Judi Health | Flat per-claim | $0.99/claim | ~$1.03 PMPM | $13.78M |
| SmithRx | Flat PMPM | N/A | $6.00 PMPM | $144M |
| Navitus | Flat PMPM | N/A | $5.00-7.50 PMPM | $120M-180M |
| AffirmedRx | Flat admin | varies | ~$4-6 PMPM | $96M-144M |

- **Key insight**: PMPM PBMs charge the same regardless of utilization. At 58% utilization, SmithRx costs **$10.34 per actual fill** ($144M ÷ 13.92M claims). Per-claim pricing punishes PMPM models on lower-utilization populations.
- **Capital Rx PMPM derivation:** $0.99/claim × 13.92M claims = $13.78M/year ÷ 2M members ÷ 12 months = **$1.03 PMPM** (not ~$1.24, which incorrectly assumes 100% utilization volume).

### Head-to-Head Comparison

| Metric | Traditional PBM | Capital Rx | SmithRx | zkp.care |
|---|---|---|---|---|
| Employer fee (2M lives/yr) | $228M-486M | $13.78M | $144M | **$17.40M** |
| Per-fill cost | $1-5 | $0.99 | ~$10.34/fill* | **$1.25** |
| PMPM equivalent | $5-10 | $1.03 | $6.00 | **$0.73** |
| PHI on servers | Yes | Yes | Yes | **No** |
| Adjudication | Central server | Central server | Central server | **ZK circuit (offline)** |
| Audit trail | SQL logs | SQL logs | SQL logs | **Poseidon hash chain** |
| Infrastructure cost | $50M+/yr | Unknown (raised $400M) | Unknown | **$2,940/yr** |
| Headcount | 1,000s | ~850 (Capital Rx) | ~550 (SmithRx) | **~88** |

*SmithRx per-fill: $144M ÷ 13.92M claims = $10.34/fill effective at 58% utilization. PMPM models punish low-utilization populations.

### NADAC — Access, Comparison, and Advantage

**Accessing NADAC (100% public, free, no license):**

| Detail | Info |
|---|---|
| Publisher | CMS (Centers for Medicare & Medicaid Services) |
| URL | https://www.medicaid.gov/medicaid/nadac |
| Data download | https://data.medicaid.gov/dataset/f38d0706-1239-442c-a3cc-40ef1b686ac0/data |
| Update frequency | Weekly (monthly summary on 1st Monday after the 15th) |
| Cost | $0 — open public data |
| License required | No |
| Format | CSV/API — NDC, drug name, NADAC per unit, pricing unit, effective date |

Workflow: download weekly, hash each NDC + price into FormularyRegistry MerkleTree, publish via gossip. Pharmacies/employers independently verify against the public NADAC source.

**NADAC vs. Other Pricing Benchmarks:**

| Benchmark | Relative to NADAC | Who Sets It | Transparent? |
|---|---|---|---|
| NADAC | Baseline | CMS (survey of actual pharmacy invoices) | Yes — public weekly data |
| WAC (Wholesale Acquisition Cost) | ~13% above NADAC | Manufacturers | Semi — published, no discounts reflected |
| AWP (Average Wholesale Price) | ~113% above NADAC (2.13x) | Publishers (First Databank, Medi-Span) | No — "Ain't What's Paid" |
| MAC (Maximum Allowable Cost) | Varies wildly | Each PBM sets own MAC list | No — proprietary, opaque |

**The spread traditional PBMs exploit**: AWP ~113% above NADAC. PBMs contract employers at "AWP minus X%" (e.g., AWP-85%) while reimbursing pharmacies at "AWP minus Y%" (e.g., AWP-88%). The 3% spread on a $100 AWP drug = $3/fill pure profit, invisible to both parties.

**zkp.care's NADAC Advantage:**

| Feature | Traditional PBM | Transparent PBM | zkp.care |
|---|---|---|---|
| Drug pricing basis | AWP minus X% (opaque) | NADAC (transparent) | NADAC (on-chain, verifiable) |
| Employer can verify price | No | Partially (reports) | Yes — Poseidon hash of NADAC price in MerkleTree, compared to public CMS data |
| Spread pricing | $1.4B+ (Big 3, FTC) | $0 (contractual) | $0 (structurally impossible — single NADAC source, deterministic settlement) |
| MAC manipulation | Unilateral PBM control | Some use MAC | No MAC — NADAC only |
| Price update lag | PBM-controlled timing | Weekly (NADAC) | Weekly (automated NADAC ingest + MerkleTree update) |

**Differentiator**: Single NADAC source of truth published to FormularyRegistry MerkleTree. Copay hashed into each formulary entry, verified by FulfillmentProgram ZK circuit at POS. Settlement amounts (patientPay + planPay) committed to TRANSACTION tree via Poseidon.hash; pharmacy and employer see the same settlement commitment. Spread pricing is structurally impossible — no intermediary cost mapping where a spread could hide. **Note**: Current FormularyEntry contains copayAmountCents (patient cost-sharing), not full NADAC acquisition cost. Adding NADAC cost as a hashed field would make spread pricing cryptographically impossible (verifiable vs. public CMS data). Enhancement planned.

**Pipeline: NADAC → FormularyRegistry → ZK Proof**

```
Weekly NADAC CSV from CMS
  → Parse NDC + NADAC per unit
  → Compute: reimbursement = NADAC + $13 dispensing fee
  → Build FormularyEntry per NDC: { ndcHash, tierLevel, nadacCents, dispensingFeeCents, requiresPriorAuth, ... }
  → Insert into FormularyRegistry MerkleTree(16)
  → Publish formularyRoot via l2_storeFormulary RPC
  → Gossip replicates to all Leviathans
  → Member credential updated with new formularyRoot
  → Pharmacy FulfillmentProgram uses Merkle witness to verify price at POS
```

---

## 8. Go-to-Market & Pitches

### The Pharmacy Pitch

| Metric / Feature | Traditional PBM | zkp.care |
|---|---|---|
| Reimbursement basis | MAC or AWP-% (opaque) | NADAC + $13 dispensing (transparent) |
| Pharmacy profit per fill | Often negative after DIR | $1.66 guaranteed above operational cost |
| Retroactive clawbacks | $9.1B industry (2019) | $0 — impossible by protocol |
| Payment timing | 30-60 days + retroactive adjustments | Batch cycle settlement (minutes) |
| No spread pricing | PBMs billing plans $100, paying pharmacy $60 | NADAC passthrough = no hidden margin |
| Network access fee | $500-$2,000/yr | $0 |
| Credentialing | Annual CAQH paperwork | NFC credential attestation — Ed25519 sig (<1ms) |
| Audit chargebacks | 83% see 10+/month | $0 — ZK proofs verified at submission |
| Verify reimbursement before dispensing | No | Yes — Merkle witness at POS |

**Why $13 dispensing fee works:** Actual cost to dispense = **$11.34** (NACDS operational cost data). Medicaid acquisition-cost programs reimburse $10-12 dispensing fees; Cost Plus Drugs pays $12/Rx to affiliate pharmacies. At NADAC + $13: pharmacy clears **$1.66 profit per fill** above operational cost, guaranteed; no hidden clawbacks; generic margin preserved (generics = profit engine: $12.7B industry-wide vs. -$0.5B on brands); **more attractive than Cost Plus Drugs ($12) and Medicaid ($10-12)** — pharmacies prioritize the network.

> "We reimburse at NADAC + $13 dispensing fee — that's $1.66 above your operational cost on every fill. No DIR fees. No retroactive clawbacks. No spread pricing. What you see at point of sale is what you get paid — settled cryptographically within the batch cycle, not 60 days later. Our provider badge lets your pharmacists verify any member with a tap — no phone calls to verify eligibility. And because our claims are ZK proofs, they're mathematically correct by construction — no audit chargebacks."

### The Employer Pitch — Cost Sensitivity

> "SmithRx charges you $6 PMPM whether your employees fill prescriptions or not. We charge $1.25 per actual fill — $0.25 admin + $1.00 dispensing markup. For a 13,000-life employer at 58% utilization, that's $116K/year instead of $936K/year. Same benefits, cryptographic audit trail, zero PHI exposure. And when your members don't fill, you pay nothing."

### The Master Pitch

> "We charge $1.25 per fill — $0.25 admin + $1.00 dispensing markup. That's $0.73 PMPM. Capital Rx charges $0.99 per claim but runs a central database with your members' PHI. SmithRx charges $6.00 PMPM regardless of how many prescriptions your members fill — at 58% utilization, that's $10.34 per actual fill. We run zero PHI on our servers. Your claims are adjudicated by a ZK circuit at the pharmacy in 30 seconds — no network round-trip, no central point of breach. Our entire infrastructure is 5 servers at $245/month. 88 employees instead of 1,500. And every dollar is cryptographically auditable."

### 100-Person Employer Example (58% Utilization)

| Line Item | Calculation | Annual Cost |
|---|---|---|
| Admin fee | 696 claims × $0.25 | $174 |
| Dispensing markup | 696 fills × $1.00 | $696 |
| Drug cost (NADAC) | 696 fills × ~$45 avg | $31,320 |
| Dispensing fee to pharmacy | 696 fills × $13.00 | $9,048 |
| Member copays collected | 696 fills × ~$5 avg | (-$3,480) |
| **Total employer cost** | | **$37,758/yr** |

| | zkp.care | Traditional PBM | SmithRx |
|---|---|---|---|
| Total/yr | **$37,758** | $47,000-55,000 | $42,000-46,000 |
| Admin cost/yr | **$870** | $6,000-12,000 | $7,200 |
| PMPM | **$31.47** | $39-46 | $35-38 |
| PMPM admin only | **$0.73** | $5-10 | $6.00 |
| Per employee admin/yr | **$8.70** | $60-120 | $72 |

> "Your pharmacy benefit costs $37,758 per year — that's $31.47 PMPM. A traditional PBM charges $47,000-$55,000 for the same drugs. Our admin fee is $870 total — $8.70 per employee per year. Your employees get $0 generic copays, $0 deductible, and their health data never touches our servers."

---

## Sources

- KFF 2024-2025 Employer Health Benefits Surveys
- FTC Second Interim PBM Report (Jan 2025)
- SmithRx, Capital Rx/Judi Health, Navitus, AffirmedRx, RxBenefits public documentation
- Mark Cuban Cost Plus Drug Company payer model
- Congress 2026 Consolidated Appropriations Act (ERISA Section 6702)
- DOL Proposed PBM Fee Disclosure Rule (Jan 2026)
- Fortune Business Insights, Precedence Research PBM market sizing
- Milliman blockchain/PBM disruption analysis
- NACDS operational cost data ($11.34/fill)
- Additional pharmacy-pain sources cited inline: Drug Channels, Drug Topics, APhA, NCPA, ASPE

*All figures consolidated from the four source decks (generated 2026-03-15 — zkp.care / zkTrident). Verify before any public use.*
