# Intended versus as-built

Session 3 of the review program, written 2026-10-16. Compares what the patent filings describe against what the code does and what the running network actually did. Companions: `CODEMAP.md` (what the code is), `AUDIT.md` (what is wrong with it, findings cited below as A-n).

Swimlane artifact for this session, with the claim matrix, the four contradictions and the three figure diffs: https://claude.ai/artifact/5MbBi7TpPtVMeTnTNthxzq (the as-built route map from the earlier pass stays at https://claude.ai/artifact/MVVzf7osD2sJQg1GKtYisx).

**Status of the filings, updated 2026-10-16.** The owner has stopped pursuing the patent on cost grounds. The abstract and claims now serve two purposes and neither is prosecution: they are **defensive prior art**, establishing the design publicly so nobody else can fence it off, and they are the **best existing specification of the target architecture**. That second purpose is why this comparison still matters. Read every "contradicted" row below as a gap between the system and its own design intent, not as a filing problem. The goal is a product that works, protects PHI and PII, and lowers drug costs through operational excellence.

## What is authoritative

| Document | Date | Status |
|---|---|---|
| Claims 1-19 | filed, receipt in `USPTO Document Submission/` dated 2026-03-10 | **operative.** `02_CLAIMS.docx`, 19 claims |
| Abstract (144 words) | same | operative |
| Specification | `Substitutes and Replacements/specification/SUBSTITUTE_SPECIFICATION.md`, 2026-04-07 | operative, supersedes `01_SPECIFICATION.docx` |
| Drawings | `Substitutes and Replacements/Updated Figures/`, 22 sheets (FIG. 8, 10, 12, 14, 15, 16 split into A/B parts) | operative |
| Claims 1-15 v4 | `Final Submission Version/`, 2026-03-03 | **superseded.** Also at repo root as `zkpcare_patent_claims_1-15_v4.md`; do not cite it as current |

The April substitute is housekeeping only. Its own change list enumerates 37 changes, all of them figure references and drawing splits, and states explicitly: no changes to claims 1-19, the abstract, or any body paragraph not listed. So the claims as filed in March are the intent to compare against.

## Verdict by claim

Four categories. **Practiced** means the running system does it. **Dormant** means the code exists and its tests pass, but the shipped launcher does not switch it on, so the running system does not demonstrate it. **Contradicted** means the running system does the opposite of what the document asserts. **Broken** means the path exists and fails at runtime.

| Claim | Subject | Verdict | Basis |
|---|---|---|---|
| 1 | In-circuit adjudication: formulary witness, cost-share cascade, accumulator transition, drug-identity hash in the output | **practiced** | All three constraint groups are in `accumulator-fulfillment-program.ts`; FIG. 6 steps 610-695 map to real code. Claim 1 requires *generating* a proof, not verifying it, so A-22 does not contradict it |
| 2 | Deductible credit and settlement commitment `Poseidon([fulfillCommit, patientPay, planPay, deductibleCredit])`, "enabling exact reversal" | **practiced, undermined** | The commitment has exactly that form (`:389-394`). But family pooling rewrites patient and plan pay *after* the proof (A-23), so the committed amounts and the recorded amounts differ and exact reversal no longer follows |
| 3 | Pharmacy wallet identity recomputed from preimage inside the adjudication circuit | **practiced** | Three pharmacy preimage fields are private inputs; `computedPharmacyWalletId` is recomputed at `:147` and for reversal at `:513` |
| 4 | Six-domain Merkle forest, composite root, credential payload is the forest root, selective disclosure | **practiced** | `MerkleForest`, six trees, `forestRoot = Poseidon(6 roots)`, credential carries only that root |
| 5 | Proof-gated wallet: no key material, **all state transitions gated exclusively through ZK proof verification, authorized if and only if a valid proof demonstrates knowledge of the preimage** | **contradicted** | See C-1. Acceptance is gated on claimed roots matching; `proof.verify()` is an o1js no-op (A-3), and `register-member` provisions a wallet with no proof at all (A-6) |
| 6 | 256-bit key from OS entropy, base64url, entropy validation over character classes | **practiced** | `randomBytes(32).base64url`; `validateEnrollmentKey` is enforced inside every derivation function (`wallet-derivation.ts:119, 154, 180, 225`), so even a caller-supplied key must pass it |
| 7 | Three-party enrollment; insurer never receives PHI; **no single party holds complete information** | **partly contradicted** | (a)-(c) hold: the token is all hashes, the device hashes locally and proves, the insurer sees no PHI. (d) fails: the sequencer, which the claim does not name as a party, holds the member's reversible preimage (A-1). See C-2 |
| 8 | Three-level recursion: inlined wallet check, pair-pattern batch program, chain program certifying global state | **(a)(b) practiced, (c) dormant** | Inlined selector and the uniform two-proof pattern are real. The chain level is off: `chainProofEnabled: false` live |
| 9 | Ten-field global state commitment | **dormant** | `GlobalState` is ten fields as claimed, but live `globalStateRoot` is `0` and `blockHeight` is `0` after 19 settled batches |
| 10 | Claim accumulator tree, four indexes, in-circuit witnesses, root in each batch record, **plus a multi-node state certificate at each batch boundary** | **(a)-(c) practiced, (d) half dormant** | Tree, indexes, witnesses and the root in the batch record are real. State certificates are not produced: `l2_getStateCertificate` returns "Not a leviathan node" |
| 11 | Audit hash chain whose event commitment includes **financial amounts**; chain hash committed in global state; selective disclosure | **partly contradicted** | The chain and selective disclosure are real. The amount fields are present but always zero and the only code that would fill them has no callers, so the chain binds no money (A-26). The global-state binding is dormant with claim 9 |
| 12 | Partitioned network: exclusive partitions by `walletId mod count`, client-side router, **zero-authentication read endpoints whose privacy derives from the computational irreversibility of the hash function** | **(a)-(c) dormant, (d) premise disproven** | Live: `partitioned: false`, no partition config. (d) is the live design and its stated rationale is false: the identity hashes are unsalted and I inverted them in 75 seconds (A-1). See C-2 |
| 13 | Gossip protocol, twelve typed messages, idempotent dedup, trust from proof validity alone, directed messaging, entity-node read replicas | **dormant** | Sixteen message types are defined, a superset of the twelve claimed. But gossip is wholly non-functional: the relay is admin-gated and replicas carry no token, so both replicas sit at the genesis root (A-8). Entity nodes keep no replicas; they proxy |
| 14 | Multi-leader sovereignty, heartbeat, deterministic failover, split-brain demotion, transparent client failover | **dormant** | `L2Leviathan` implements all of it and has 88 passing tests, but nothing outside the multi-node orchestrator ever constructs it |
| 15 | Message store; **payloads encrypted with keys derived from user enrollment keys such that the sequencer cannot decrypt any message** | **contradicted** | Tree, metadata-only leaves, four indexes and the root in the batch record are real. The encryption claim is not: dashboards send base64 with `iv:'0'`, the member node falls back to hex plaintext, and the engine holds seed members' X25519 private keys derived from enrollment keys committed in the repo, so it can decrypt (A-15) |
| 16 | Epoch accumulator with rotation and cross-epoch queries | **dormant** | `EpochAccumulatorService` is constructed in exactly one place: `src/poc/patent-evidence-runner.ts:1122`, the evidence generator. The product never instantiates it |
| 17 | Portable credential: mint / holding / holding-by-type each verifying ownership recursively; self-contained format; offline verification; tiered delegation TTLs | **broken** | Format, recursion and the TTL tiers are real (`OFFLINE_TTL_MS`: read 72 h, write 24 h, **pickup 4 h**, the shortest for dispensing, as claimed). But generation fails at runtime (A-24), `proveMint` is reachable only through `UserWalletService`, which nothing instantiates, and `verifyCredentialOffline` ignores the verification key it is handed |
| 18 | WAL and quorum: log-then-ack, **no client acknowledgment until a threshold of nodes have logged and signed**, quorum certificates, state certificates, crash replay, compaction | **dormant** | Fully implemented with 57 passing tests, entirely off in the shipped boot: `walProvider` is null and quorum is unreachable. Clients are acknowledged immediately by a single node |
| 19 | Proving pool: forked workers with isolated WASM, split-phase prepare/prove/finalize, JSON IPC with decimal field encoding, worker recycling, crash recovery, FIFO dispatch | **practiced** | The best-matched claim in the set. Live: pool size 2, two workers alive, 19 jobs completed, 6 recycles |

Counting claims: **7 practiced** (1, 2, 3, 4, 6, 19, and 8 in part), **7 dormant** (9, 12, 13, 14, 16, 18, and 10 in part), **3 contradicted** (5, 15, and 7 in part), **1 broken** (17), **1 mixed** (11).

## The four structural contradictions

### C-1. "Gated exclusively by ZK proof" is not how acceptance works

The title of the application is "Proof-Gated Wallet System." Claim 5(c) requires that a state transition be authorized "if and only if a valid zero-knowledge proof demonstrates knowledge of the identity fields and enrollment key." FIG. 5's banner reads "Access gated EXCLUSIVELY by ZK proof," and labels the ProofGate proof "sole authorization for wallet ops." FIG. 6's banner reads "The ZK proof IS the adjudication."

As built, a submitted transition is accepted when the roots the caller claims match the sequencer's current roots. The verification call at that point sets a flag and performs no cryptography, as the o1js source itself documents. State, receipt, audit chain, claim leaf and gossip all happen before any circuit runs. The batch circuit is the first real check, and by then the change is committed with no rollback path in L2-only mode. Separately, `register-member` creates an ELIGIBLE wallet with no proof in the request at all, and the ProofGate proofs that FIG. 5 calls "sole authorization" are generated and thrown away.

The mechanism the claim describes exists and works: the circuits verify, and the harness confirms batch proofs verify against independently compiled keys and that tampered copies fail. What is wrong is the enforcement point. This is a code defect, not a missing invention, and A-3 in the audit is the fix.

### C-2. The privacy boundary is drawn in the right place, but what crosses it is not opaque

FIG. 4 draws an explicit line: "PHI BOUNDARY — NOTHING BELOW CONTAINS PHI/PII, ONLY POSEIDON HASHES," with step 420d submitting `{ walletId, tokenHash, groupIdHash }`. FIG. 5 annotates the enrollment-key hash row with "NEVER TRANSMITTED" and states "Private inputs NEVER leave prover's device. Verifier learns ONLY that a valid preimage exists." Claim 7(d) partitions knowledge so that the member alone holds the identity preimage. Claim 12(d) justifies zero-authentication read endpoints on the ground that "privacy derives from the computational irreversibility of the hash function rather than from access control mechanisms."

As built, the member node posts all six preimage fields, including the hash of the enrollment key, to the sequencer, which stores them in the clear in `l2-data/adjudication-state.json`. The verifier therefore learns the preimage itself, not merely that one exists. And the hashes are unsalted single-value Poseidon hashes over small domains, so they invert: from that one file I recovered every test member's first name, last name and date of birth, using a 37,572-entry date table and a twenty-name list, in 75 seconds.

Three consequences, which should be read separately:

1. The row FIG. 5 labels "NEVER TRANSMITTED" is transmitted and persisted. Read charitably the label means the key rather than its hash, and the raw key genuinely never leaves the device, which I confirmed. Read literally it is wrong.
2. Claim 7(d)'s partition does not hold, because a party the claim does not name holds the member's reversible identity.
3. Claim 12(d) is sound as written and false as implemented. Open read endpoints are safe exactly when the commitments are irreversible. They are not, because of the unsalted low-entropy inputs. Salting the identity fields, already planned as fix phase C, would make the claim's premise true. Until then, audit finding A-2 is not a bug against the design; it is the design operating on a broken assumption.

### C-3. A consensus-free distributed network, running as one node

Five claims describe the network: 12 (partitions and routing), 13 (gossip), 14 (multi-leader failover), 18 (WAL and quorum durability), and 10(d) (state certificates from a majority of nodes at every batch boundary). The abstract advertises "a partitioned sequencer network distributing proof processing across multiple leader nodes using gossip-based replication and deterministic failover."

The running system is a single `L2Node` with `partitioned: false`. Two replicas exist and hold nothing: gossip is delivered over an admin-gated method while the replicas are constructed without a token, so every message is rejected and both sit at the genesis root after 19 batches. `L2Leviathan` is never constructed outside the multi-node orchestrator. The write-ahead log provider is null. Quorum and state-certificate queries answer "Not a leviathan node." Clients are acknowledged by one node with no durable replication, which is the specific thing claim 18(b) says must not happen.

This is the widest intent-to-reality gap in the filings, and the least alarming in one sense: the code exists and is well tested (88 Leviathan, 57 WAL and quorum, 91 peer-network tests passing). The deployed launcher simply does not wire it up, and one of the wires is broken (A-8). The honest statement is that the distributed properties are implemented and untested *as deployed*, not demonstrated.

### C-4. The top of the proof hierarchy is switched off

Claim 8(c) and claim 9 describe a chain program certifying a ten-field global state commitment, and claim 11(b) binds the audit chain into it so that one recursive proof covers all healthcare state. FIG. 5 states the design "keeps proof chain to 3 levels: StateTransition(0) → Batch(1) → Chain(2)."

Live, `chainProofEnabled` is false, `globalStateRoot` is `0` and `blockHeight` is `0` after 19 settled batches. Only levels 0 and 1 run. So the single artifact that would let an outside party check the whole system's state in one verification is never produced, and the audit chain is bound to nothing. Combined with A-26, where the event commitment's financial fields are always zero, the audit trail commits to neither the money nor the global state.

## Swimlane diff, line by line

Only the three figures with as-built counterparts in the route map. Each row quotes the figure and states what the system does.

### FIG. 4, three-party enrollment ceremony

| Figure says | As built | Status |
|---|---|---|
| 420a "Generate enrollmentKey ... NEVER transmitted" | True for the raw key, verified live. But `generate-key` also accepts a caller-supplied key, and `backup-key` exports the real key to any caller under a caller-chosen PIN (A-5) | diverges |
| 420d "Submit to insurer: { walletId, tokenHash, groupIdHash } (NO PHI)" | To the insurer, yes. But the device also posts all six preimage fields to the sequencer (A-1) | **contradicted** |
| "PHI BOUNDARY — nothing below contains PHI/PII, only Poseidon hashes" | Literally true, materially false: the hashes invert (A-1) | **contradicted** |
| 430a "Verify token signature + check roster" | Conditional. The insurer skips validation entirely when no token ID is sent, and the employer's validate never consumes the code | diverges |
| 430b/c "Register walletId ... lifecycle EMPTY → REGISTERED → ELIGIBLE → ACTIVE" | The engine jumps straight to ELIGIBLE by administrative mutation at registration (A-6) | diverges |
| Separation table, "walletId: Employer NEVER" | Holds today only because the member's confirm call is unauthenticated against an admin route and 401s. `confirmEnrollment` would store it | holds by accident |
| Token lifecycle "DISTRIBUTED → CONSUMED" | CONSUMED never happens on the employer node; codes stay replayable until expiry | diverges |
| Parties shown: employer, member, insurer | The sequencer and its in-process adjudication engine hold member preimages and prove on members' behalf, and appear nowhere in the figure | **structural omission** |

### FIG. 5, proof-gated wallet derivation

| Figure says | As built | Status |
|---|---|---|
| Section A derivation, four entity types, domain tags 0-3 | Matches exactly, including field order and the padding convention | matches |
| "hashString(enrollmentKey) NEVER TRANSMITTED" | The hash is transmitted and stored in the clear | **contradicted** |
| Section B "ProofGateProof = sole authorization for wallet ops" | ProofGate proofs are generated and discarded; they authorize nothing | **contradicted** |
| "Private inputs NEVER leave prover's device. Verifier learns ONLY that a valid preimage exists" | The verifier receives the preimage (A-1) | **contradicted** |
| Section C inlined switch across three hash variants | Matches, including the `Provable.switch` selector and the stated reason | matches |
| "Keeps proof chain to 3 levels ... → Chain(2)" | Level 2 is disabled at runtime (C-4) | dormant |
| Section D "ELIGIBLE --1st claim--> ACTIVE" | All four live members have filed claims and are all still ELIGIBLE. The ACTIVE transition does not occur | diverges |

### FIG. 6, in-circuit claim adjudication

| Figure says | As built | Status |
|---|---|---|
| Steps 610-650: credential and forest-root check, pharmacy identity binding, prescription witness, formulary witness, quantity guard | All present in the circuit, in this order | matches |
| Step 660b four-priority cascade via `Provable.if` | Matches: out-of-pocket max, exhausted benefit, remaining deductible, then copay | matches |
| Steps 670-690: deductible credit, accumulator transition, settlement commitment | Matches, including the commitment's field list | matches |
| Step 695 output shapes, 8 and 10 fields including `ndcHash` | Matches | matches |
| "INVARIANT: ingredientCost + dispensingFee == patientPay + planPay (by construction)" | Holds inside the circuit. Broken in the ledger by the post-proof pooling rewrite (A-23), and the ledger disagrees with the engine for two of four members (A-11) | diverges |
| "The ZK proof IS the adjudication. No PBM. No manual review." | The proof is discarded; the recorded outcome is the engine's TypeScript result (A-22) | **contradicted** |

## Where the documents are more accurate than I expected

Worth stating plainly, because the gaps above are the exception rather than the rule in the technical detail:

- The adjudication circuit matches FIG. 6 step for step, including the pharmacy identity recomputation that claim 3 adds and the exact settlement commitment form that claim 2 specifies.
- Wallet derivation matches FIG. 5 field for field across all four entity types, and the entropy validation claim 6 describes is genuinely enforced on every derivation path.
- The proving-pool claim 19 is accurate in every element I could check, down to decimal-string field encoding and worker recycling, and the live pool confirms it.
- The gossip message taxonomy in claim 13 understates what exists: sixteen types against twelve claimed.
- The delegation TTL tiers of claim 17(d) are real and ordered as claimed, with dispensing shortest at four hours.
- The three-party information separation of claim 7(a)-(c) holds: the employer's token carries only hashes, the device hashes locally, and the insurer never receives PHI, which I confirmed by scanning every store and endpoint.

## Claim subject matter that exists only outside the product

| Claim | Element | Only reachable through |
|---|---|---|
| 16 | Epoch accumulator | `src/poc/patent-evidence-runner.ts:1122`, the evidence generator |
| 17(a) | `proveMint` | `UserWalletService`, which nothing instantiates |
| 17(d) | Delegation TTL tiers | `AorService`, which nothing instantiates |
| 12, 13, 14, 18 | The distributed network | `L2Leviathan` and the WAL and quorum services, which only the multi-node orchestrator and the test suites construct |

The evidence generator is worth a note of its own. `patent-evidence-runner.ts` produces the "cryptographic evidence of reduction to practice" exhibit listed in the manifest, and it is the only runtime caller of at least one claimed subsystem. Evidence produced by a generator that exercises code the product does not run is still evidence the code works, but it is not evidence the system runs that way.

## What follows

**Code changes, already on the plan.** C-1 is audit finding A-3, slated for fix phase D. C-2 is A-1 and A-9, phases B and C, and salting the identity fields turns claim 12(d) from false to true. The claim 15 encryption gap is the known messaging work in phase D. The claim 11 zero amounts are A-26. The claim 17 breakage is A-24. The FIG. 5 lifecycle divergence and the FIG. 4 token-consumption divergence are new, small, and belong in phases B and A respectively.

**C-3 and C-4 need a decision, not just a fix.** The distributed claims and the chain-proof claim describe behavior the shipped launcher does not enable. There are two legitimate paths: wire them into the default boot so the running system demonstrates them, or state clearly in the project's own documentation which properties are implemented-and-tested versus demonstrated-in-deployment. The first is a few lines of launcher configuration plus the replica token fix in A-8. I would do that before any public claim rests on those properties.

**The two items previously flagged for a patent attorney are moot** now that prosecution has stopped. They remain useful as engineering targets rather than legal exposure: the FIG. 5 annotation that the enrollment-key hash is never transmitted describes the behavior phase B is building, and claim 12(d)'s irreversibility rationale describes the property phase C's salting establishes. Both become true statements about the system once those phases land, which is the only sense in which they now matter.

**What the claims are good for from here.** They are the most complete written specification of the intended architecture that exists, written when the design was fresh, and they are more precise than the prose docs in several places. Phase E's work list is essentially claims 12, 13, 14, 16 and 18 turned into tasks. When a question comes up about what a subsystem was supposed to do, the claim text is a better answer than re-deriving intent from the code.

## Open questions

1. Was the chain proof deliberately disabled for local performance, or has it regressed? Nothing in the launcher logs the decision, and `chainProofEnabled: false` is silent.
2. Is the single-partition, single-node boot the intended local topology, with the distributed path reserved for hardware deployment? If so, the project's own docs should say which claims the local boot exercises.
3. Does the member's benefit plan get corrected later in the flow, or do all fills use the default plan's rules? This affects whether claim 1's cost-share is computed against the right plan parameters at all.
4. Should the sequencer and its in-process engine appear in FIG. 4 as a fourth party, given what they currently hold?
5. Is the evidence exhibit regenerated against the current tree, and does it assert anything the audit now contradicts? I did not open it; it is listed as not filed.

## State of work (end of Session 3)

**Done.** This file. Established that the operative filing is claims 1-19 from March, with an April substitute that changes only drawings, and that the root `zkpcare_patent_claims_1-15_v4.md` is superseded and should not be cited. Diffed all 19 claims and the three swimlane figures against code and live behavior. Verified claim elements against the running network where the claim asserts runtime behavior: chain proof disabled, no partitioning, quorum unreachable, proving pool matching, TTL tiers present, entropy validation enforced, pharmacy binding in-circuit.

**Not done.** I read the substitute specification's change list and the three swimlane figures, not the full 92 KB specification body, and not the supporting exhibits. If Session 4 or a filing review needs the specification's own factual assertions checked paragraph by paragraph, that is a separate pass; sections VIII, X, XI, XI-A, XIV and XVI are the ones whose subject matter is dormant or contradicted above.

**Session 4 next:** finish `PLAN-security-hardening.md`. Carry forward three things from here. The lifecycle and token-consumption divergences are new small items for phases B and A. C-3 needs an explicit decision on local topology. And the ordering argument from the audit stands: A-3 and A-2 first, because C-1 and C-2 are the contradictions an outside reader would find first.
