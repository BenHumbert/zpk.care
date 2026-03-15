# zkp.care Protocol Plan — Strategic Presentation

## The Case: zkp.care Doesn't Need a PBM Partner — It *Is* the PBM

The question isn't "which plan to partner with" — it's recognizing that zkp.care **replaces the entire PBM stack**. Every function a traditional PBM charges for is already built into the protocol:

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

---

## The Numbers at 2M Lives (58% Utilization — ~14M Claims/Year)

| Cost Component | Traditional PBM | Transparent PBM (SmithRx/Judi) | **zkp.care** |
|---|---|---|---|
| Admin fee | $120M-240M/yr ($5-10 PMPM) | $144M/yr ($6 PMPM) | **$0 PMPM** — per-claim only |
| Spread pricing | $58M-96M/yr | $0 | **$0** |
| Rebate retention | $50M-150M/yr | $0 | **$0** |
| PBM fee to employer | Included in admin | Included in admin | **$17.4M/yr** ($0.25/claim + $1.00/fill) |
| **Total extraction above drug cost** | **$228M-486M/yr** | **$144M/yr** | **$17.4M/yr** |

The infrastructure cost for zkp.care is 5 bare-metal servers at $49/month each ($2,940/year). JIT (just-in-time) batch proving means workers pull claims instantly — no timer delays, 30-45 second claim-to-proof latency. No call centers, no claims analysts, no network contracting teams — the ZK circuits make those functions deterministic.

---

## The Protocol Plan

A plan design that only zkp.care can offer — one that's impossible without ZK infrastructure:

| Parameter | Value | Rationale |
|---|---|---|
| **Admin fee** | $0 PMPM | Per-claim pricing only ($0.25/claim + $1.00 dispensing markup) — employer pays nothing when members don't fill |
| **Drug pricing** | NADAC passthrough | Exact acquisition cost, verifiable on-chain |
| **Pharmacy reimbursement** | NADAC + $13 dispensing fee | $1.66 above pharmacy operational cost — attracts pharmacies |
| **Rebates** | 100% to employer | Cryptographically auditable via Poseidon hash chain |
| **Generic copay** | $0 | Maximize generic utilization, improve adherence |
| **Preferred brand** | $15 | Competitive with Cost Plus Basic |
| **Non-preferred brand** | $40 | Competitive with Employer Premier |
| **Specialty** | $50 flat | No coinsurance surprises — flat copay |
| **Deductible** | $0 / $0 family | Zero friction |
| **OOP Max** | $2,000 / $4,000 family | Strong member protection |
| **Annual Max** | Unlimited | No catastrophic gap |
| **Formulary** | Open + step therapy | ZK circuit enforces clinical rules automatically |

---

## Why This Works at Scale (2M Lives / 150 Employers)

### Revenue Model
- $0.25/claim admin + $1.00/fill dispensing markup = **$17.4M/year** at 58% utilization
- Per-claim pricing means employer pays nothing when members don't use benefits — no PMPM tax on healthy populations

### Employer Savings
- **$126.6M/year** vs. transparent PBM ($144M - $17.4M)
- **$210.6M-468.6M/year** vs. traditional PBMs

### The Pitch to Employers
> "SmithRx charges you $6 PMPM whether your employees fill prescriptions or not. We charge $1.25 per actual fill — $0.25 admin + $1.00 dispensing markup. For a 13,000-life employer at 58% utilization, that's $116K/year instead of $936K/year. Same benefits, cryptographic audit trail, zero PHI exposure. And when your members don't fill, you pay nothing."

### Regulatory Alignment
The 2026 Consolidated Appropriations Act mandates 100% rebate passthrough and delinked compensation by 2028-2029. zkp.care is *already* compliant — the settlement circuit has no field for rebate retention, making non-compliance structurally impossible.

### Direct Pharmacy Leverage
2M lives = negotiate NADAC + $13 dispensing fee directly with Walgreens/CVS/independents. $1.66 above their operational cost on every fill. No pharmacy network middleman needed. The ProviderRegistryService already handles credentialing.

---

## The Differentiator No One Else Can Match

Every transparent PBM (SmithRx, Capital Rx/Judi, Navitus) still runs a **central database with PHI**. They're transparent about *pricing* but not about *data*. zkp.care is the only platform where:

- **Zero PHI on servers** — only Poseidon hashes. HIPAA liability drops to near-zero
- **Adjudication is deterministic** — ZK circuits, not business rules engines with human overrides
- **Audit is cryptographic** — tamper-evident hash chain, not SQL query logs
- **Member owns their data** — proof-gated wallets, enrollment key never leaves device
- **Infrastructure is distributed** — no single point of failure, no single point of breach
- **5 servers run the entire PBM** — $2,940/year infrastructure for 2M lives. Capital Rx raised $400M.
- **88 people, not 1,500** — 94% headcount reduction vs. traditional PBMs

That's not a feature list — that's a **structural moat**. Capital Rx spent $400M building Judi. zkp.care runs on 5 bare-metal servers with 88 employees. The protocol makes the PBM entity unnecessary.

---

## Compatible Plan Templates (8 Transparent PBM Designs)

All templates use 100% rebate passthrough, NADAC-based transparent pricing, and per-claim admin fees.

### 1. Cost Plus Basic
- NADAC + 2% + $3.50 dispensing. $0 generic, $15 pref brand, $50 non-pref, 20% specialty (max $150)
- Deductible: $0/$0. OOP Max: $2,000/$4,000. Annual Max: Unlimited

### 2. Transparent Value
- Flat admin, pass-through. $5 generic, $25 pref brand, $60 non-pref, 25% specialty (max $250)
- Deductible: $100/$200. OOP Max: $3,000/$6,000. Annual Max: Unlimited

### 3. HDHP Pharmacy Integrated
- HSA-compatible, $0.99/claim. $10/$35/30%/25% specialty (all after deductible)
- Deductible: $1,650/$3,300 (IRS 2026 HDHP min). OOP Max: $4,500/$9,000. Annual Max: Unlimited

### 4. Employer Premier
- Richest benefit. $0/$20/$40/$50 flat specialty
- Deductible: $0/$0. OOP Max: $1,500/$3,000. Annual Max: Unlimited

### 5. Cost Plus + Copay Assist
- NADAC + 3% + $2. $3/$30/$75/20% specialty + $0 preventive tier
- Deductible: $150/$300. OOP Max: $3,500/$7,000. Annual Max: Unlimited

### 6. Small Employer Essential
- 3-tier simplified. $10/$40/30% specialty
- Deductible: $200/$400. OOP Max: $4,000/$8,000. Annual Max: Unlimited

### 7. GLP-1 Inclusive
- Dedicated GLP-1 tier with clinical guardrails. $5/$35/$70/25% specialty/$150 GLP-1
- Deductible: $250/$500. OOP Max: $4,000/$8,000. Annual Max: Unlimited (GLP-1 sub-limit $25K)

### 8. Municipal / Public Sector
- Broad access, public sector compliant. $5/$15/$35/$50 flat specialty
- Deductible: $0/$0. OOP Max: $2,000/$4,000. Annual Max: Unlimited

---

## Industry Benchmarks (KFF/FTC 2025-2026)

- Average employer copays: Tier 1 ~$11, Tier 2 ~$37, Tier 3 ~$67, Tier 4 ~$116
- 2026 ACA OOP maximum: $9,200 individual / $18,400 family
- 2026 HDHP minimum deductible: $1,650 individual / $3,300 family
- Transparent PBM savings vs. legacy: 20-30% reduction
- U.S. PBM market: ~$460B (2025), projected $1.04T by 2034
- Big 3 PBMs: 80% market share, 270M lives, $7.3B excess revenue from specialty generic markups (FTC)
- Congress 2026: 100% rebate passthrough mandate (ERISA Section 6702)
- Industry Rx utilization rate: ~58% of members fill at least one prescription per year

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

---

*Generated 2026-03-15 — zkp.care / zkTrident*
