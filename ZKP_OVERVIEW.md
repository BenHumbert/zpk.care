# ZKP Care — Zero-Knowledge Proof System Overview

A source-verified map of the **core recursive proof system**: which files make up the bundle,
which part is the recursive "spine" that constitutes the system as a whole, and how the whole
thing interacts at runtime to push proofs to the sequencer and propagate updates across nodes.

> **Scope.** This document is the *bundle-and-interaction* explainer. For the line-by-line proof
> deep dive see [ZKPROOFS.md](ZKPROOFS.md); for the trust model and participants see
> [ARCHITECTURE.md](ARCHITECTURE.md); for known operational gaps see [SECURITY.md](SECURITY.md);
> for running it see [RUNNING.md](RUNNING.md).
>
> Every program name, method, struct field, recursion depth, and tree height below was verified
> line-by-line against the source (71/71 adversarial checks confirmed, 2026-05-31).

## Table of contents

1. [What "the recursive proof system" is](#1-what-the-recursive-proof-system-is)
2. [The recursive spine (the part that IS the system as a whole)](#2-the-recursive-spine-the-part-that-is-the-system-as-a-whole)
3. [ZK primitives the spine is built on](#3-zk-primitives-the-spine-is-built-on)
4. [Domain circuits (depth-0 leaf proofs that feed the spine)](#4-domain-circuits-depth-0-leaf-proofs-that-feed-the-spine)
5. [What makes the recursion actually run (drivers)](#5-what-makes-the-recursion-actually-run-drivers)
6. [Bundle boundary summary](#6-bundle-boundary-summary)
7. [How the systems interact — submission and propagation](#7-how-the-systems-interact--submission-and-propagation)

---

## 1. What "the recursive proof system" is

At the heart of this repo is a three-stage proof spine: **`StateTransitionProof` → `BatchProof` → `ChainProof`**. A depth-0 `StateTransitionProgram` proves one valid registry+lifecycle transition (inlining wallet ownership rather than recursing into it). `BatchProgram` recursively wraps and tree-merges those transitions into a single `BatchProof`, and `ChainProgram` recursively folds each new `BatchProof` into the prior `ChainProof`, committing all 10 `GlobalState` fields into one `globalStateRoot`. Every recursive method is uniformly **2-proof (`maxProofsVerified=2`)** to dodge the Pickles `#1939` bug — which is also why the chain is deliberately capped at 2 recursion levels. Surrounding this spine is a fleet of **depth-0 domain circuits** (eligibility, access-control, prescription, fulfillment, credential, messaging, etc.) that each emit a leaf public output the sequencer either *folds* into the spine or *logs* — they are feeders, not part of the recursion.

## 2. The recursive spine (the part that IS the system as a whole)

| File | Export | Recursive? | Public Output | Role |
|---|---|---|---|---|
| [src/engine/state-transition.ts](src/engine/state-transition.ts) | `StateTransitionProgram` (ZkProgram name `'StateTransition'`) | No — depth 0; wallet ownership **inlined** via `computeWalletId` (`Provable.switch` over member/prescriber/pharmacy Poseidon hashes), not recursed | `TransitionOutput { walletId, oldRegistryRoot, newRegistryRoot, oldLifecycleRoot, newLifecycleRoot }` | Depth-0 leaf circuit (`proveRegistration`, `proveWalletUpdate`) proving a single registry+lifecycle transition; emits the `TransitionOutput` `BatchProgram` consumes. |
| [src/l2/batch-program.ts](src/l2/batch-program.ts) | `BatchProgram` (name `'BatchSettlement'`) | **YES** — depth 1: `wrapSingle`/`wrapPair` verify two `StateTransitionProof`; `mergeBatches` verifies two `SelfProof` (`.verify()` on both) | `BatchOutput { oldRegistryRoot, newRegistryRoot, oldLifecycleRoot, newLifecycleRoot, registrationCount, transitionCount }` | Recursive aggregator that wraps transition proofs and tree-merges `BatchProof`s with sequential root-chain enforcement. |
| [src/l2/chain-program.ts](src/l2/chain-program.ts) | `ChainProgram` (name `'ChainProof'`) | **YES** — depth 1: `advance` verifies the prior `ChainProof` (`SelfProof`) **and** a new `BatchProof`; `genesis` verifies one `BatchProof` | `ChainOutput { globalStateRoot, blockHeight, registryRoot, lifecycleRoot, walletCount }` (defined in `global-state.ts`) | Top-of-spine blockchain circuit folding each `BatchProof` into the prior `ChainProof`; the latest `ChainProof` certifies the whole history. |
| [src/l2/global-state.ts](src/l2/global-state.ts) | `GlobalState` + `computeGlobalStateRoot` + `ChainOutput` | No — depth 0 (Structs + Poseidon helper) | `GlobalState` = 10 Fields: `walletRegistryRoot, walletCount, adminPublicKeyHash, lifecycleRoot, benefitPlanRoot, credentialRegistryRoot, eligibilityVkHash, messagingRoot, auditChainHash, blockHeight` | `computeGlobalStateRoot` = `Poseidon.hash` of those 10 fields in order; defines `ChainOutput`, the Struct the chain emits. |
| [src/engine/care-contract.ts](src/engine/care-contract.ts) | `CareContract` (o1js `SmartContract`) | Terminal verifier — `settleTransition` calls `.verify()` on a `StateTransitionProof`, `settleBatch` on a `BatchProof` | n/a — **8 `@state(Field)` slots**: `walletRegistryRoot, walletCount, adminPublicKeyHash, lifecycleRoot, benefitPlanRoot, credentialRegistryRoot, eligibilityVkHash, messagingRoot` | On-chain settlement endpoint: verifies the spine's proofs against current roots and applies the new roots. Not a ZkProgram. |
| [src/engine/lifecycle.ts](src/engine/lifecycle.ts) | `LIFECYCLE_*` constants + `lifecycleLeafCommitment` + `assertValidTransition` + `isValidTransition` + `LifecycleWitness` | No — depth 0 (helpers + witness) | n/a | Lifecycle-state primitive shared by the transition circuit and contract: states `LIFECYCLE_EMPTY(0)→REGISTERED(1)→ELIGIBLE(2)→ACTIVE(3)→REVOKED(4)`, leaf commitment `Poseidon.hash([walletId, lifecycle])`, in-circuit validator, and `LifecycleWitness` (**height 11**). |

**Why these are "the whole system":** Only `BatchProgram` and `ChainProgram` actually *fold proofs into other proofs* — they are the entire recursion. `StateTransitionProgram`, `GlobalState`, and `lifecycle` define exactly the inputs and committed state those two recursive circuits operate on, and `CareContract` is the terminal on-chain verifier. Every other circuit merely produces a depth-0 leaf proof that this spine either consumes (transitions) or commits/logs — it never participates in the fold.

## 3. ZK primitives the spine is built on

| File | Export | Role |
|---|---|---|
| [src/zkp/hash-utils.ts](src/zkp/hash-utils.ts) | `hashString`, `hashStrings`, `dateToField`, `hashDate`, `centsToField`, `codeToField`, `quantityToField` | Foundational PHI/PII-to-Field encoders (Poseidon string hashing; date/cents/code/quantity conversions; `hashDate = Poseidon.hash([Field(BigInt(dateStr))])`) every commitment and derivation path builds on. |
| [src/zkp/commitment.ts](src/zkp/commitment.ts) | `buildMemberData`/`buildPrescriberData`/`buildPharmacyData`/`buildMedicationData`/`buildMedicationPricingData`/`buildTransactionHeaderData`/`generateMemberIdentifier` | Off-circuit builders converting raw local PHI/PII into ZK-compatible hashed domain Structs consumed as leaves/witnesses. |
| [src/zkp/merkle-forest.ts](src/zkp/merkle-forest.ts) | `MerkleForest`, `TREE_HEIGHT (=8)`, `ForestMerkleWitness (height 8)`, `ForestDomain` | Manages the **6 domain trees, each height 8** (`MEMBER=0, PRESCRIBER=1, PHARMACY=2, MEDICATION=3, ACCESS_CONTROL=4, TRANSACTION=5`) and composes their roots into one forest root via `Poseidon.hash(roots)`. |
| [src/zkp/index.ts](src/zkp/index.ts) | barrel re-export of hash-utils / merkle-forest / commitment | Public entry point for the zkp primitives package. |
| [src/wallets/wallet-derivation.ts](src/wallets/wallet-derivation.ts) | `derive{Member,Prescriber,Pharmacy,Representative}WalletId`, `generateEnrollmentKey`, `paddedPreimage`, `DOMAIN_TAG_*` | Derives deterministic key-less wallet IDs and the padded preimage Field arrays fed as private inputs to ProofGate/StateTransition. Domain tags: `MEMBER=0, PRESCRIBER=1, PHARMACY=2, REPRESENTATIVE=3`. |
| [src/wallets/wallet-state.ts](src/wallets/wallet-state.ts) | `WalletState { walletId, credentialInventoryRoot, nonce }`, `WalletRegistry`, `WalletRegistryWitness (height 11)`, `CredentialInventoryWitness (height 7)` | Defines the per-wallet leaf commitment `Poseidon.hash([walletId, credentialInventoryRoot, nonce])` and the registry tree (`MerkleTree(11)`) whose root is the on-chain wallet registry state. Also the source of `WALLET_TREE_HEIGHT=11`, reused by `LifecycleWitness`. |

These six are the **shared vocabulary** — Poseidon hashing, date/money encoding, wallet-ID derivation, the 6-tree forest, and the registry leaf — that both the recursive spine and every domain circuit speak. Note the three distinct tree heights: **registry & lifecycle = 11**, **forest domain trees = 8**, **credential inventory = 7**.

## 4. Domain circuits (depth-0 leaf proofs that feed the spine)

### Claim-flow circuits

| File | Export | Recursive? | Public Output | Role |
|---|---|---|---|---|
| [src/eligibility/eligibility-program.ts](src/eligibility/eligibility-program.ts) | **two programs:** `EligibilityProgram` + `InNetworkProgram` | `proveEligibility` depth 0; `InNetworkProgram.proveInNetwork` **depth 1** (`ProofGateProof` in privateInputs, calls `.verify()`) | `EligibilityOutput { credentialCommitment, benefitPlanCommitment, forestRoot, coverageType }`; `InNetworkOutput { walletId, lifecycleRoot, networkRoot }` | Proves an ELIGIBILITY credential carries valid in-registry, in-date benefit-plan data; separately proves a wallet owner is in-network. |
| [src/access-control/access-control-program.ts](src/access-control/access-control-program.ts) | `AccessControlProgram` | No — depth 0 (`proveFormularyAccess`, `provePriorAuth`) | `AccessControlOutput { credentialCommitment, medicationHash, formularyRoot, tierLevel, copayAmount, priorAuthRequired }` | Proves a medication is on-formulary within quantity/day-supply limits and that a valid prior auth exists when required. |
| [src/prescription/prescription-program.ts](src/prescription/prescription-program.ts) | `PrescriptionProgram` | No — depth 0 (`proveStatusUpdate`, `proveTransfer`) | `PrescriptionOutput { prescriptionHash, oldForestRoot, newForestRoot, pharmacyWalletId, statusCode, operationType, memberWalletId }` | Proves valid prescription status transitions and pharmacy-to-pharmacy transfers via the TRANSACTION tree. |
| [src/fulfillment/fulfillment-program.ts](src/fulfillment/fulfillment-program.ts) | `FulfillmentProgram` (+ `FULFILL_OP_CLAIM`/`FULFILL_OP_REVERSAL`) | No — depth 0 (`proveFulfillment`, `proveReversal`) | `FulfillmentOutput { prescriptionHash, oldForestRoot, newForestRoot, entryCommitment, patientPayCents, planPayCents, operationType, ndcHash }` (8 fields) | The proof IS the adjudication: deterministically computes copay/plan-pay from the formulary for a fulfillment or reversal. |
| [src/fulfillment/accumulator-fulfillment-program.ts](src/fulfillment/accumulator-fulfillment-program.ts) | `AccumulatorFulfillmentProgram` | No — depth 0 (`proveFulfillmentWithAccumulator`, `proveReversalWithAccumulator`) | `AccumulatorFulfillmentOutput` (10 fields): `prescriptionHash, oldForestRoot, newForestRoot, entryCommitment, patientPayCents, planPayCents, operationType, newEligibilityForestRoot, deductibleCreditCents, ndcHash` | Adjudicates copay in-circuit against deductible/OOPM/annual-max accumulator state across two credentials; emits new prescription + eligibility forest roots. |

### Ancillary circuits

| File | Export | Recursive? | Public Output | Role |
|---|---|---|---|---|
| [src/wallets/proof-gate.ts](src/wallets/proof-gate.ts) | `ProofGateProgram` / `ProofGateProof` | No — depth 0 (`verifyMember`, `verifyPrescriber`, `verifyPharmacy`, `verifyRepresentative`) | none — `publicInput` is a single `Field` (walletIdentity); no publicOutput Struct | Base ownership circuit proving knowledge of a wallet's hash preimage; its `ProofGateProof` is the leaf consumed by `CredentialProgram` / `InNetworkProgram`. |
| [src/credentials/credential-program.ts](src/credentials/credential-program.ts) | `CredentialProgram` | **YES** — depth 1; **every** method (`proveMint`, `proveHolding`, `proveHoldingByType`) takes a `ProofGateProof` and calls `ownershipProof.verify()` | `CredentialOperationOutput { walletId, operationType, credentialCommitment, oldInventoryRoot, newInventoryRoot }` | Proves wallet ownership + credential mint/hold/selective-disclosure against the wallet's inventory tree. |
| [src/messaging/messaging-program.ts](src/messaging/messaging-program.ts) | `MessagingProgram` | No — depth 0 (`proveSendMessage`, `proveDelegate`) | `MessagingOutput { commitment, senderWalletId, recipientWalletId, contentHash, messageType, operationType, messagingRoot }` | Proves a message or delegation is well-formed and committed to its registry tree. |
| [src/eligibility/pcp-verification-program.ts](src/eligibility/pcp-verification-program.ts) | `PcpVerificationProgram` | No — depth 0 (single method `verifyPcpAssignment`) | `PcpVerificationOutput { credentialCommitment, memberWalletId, pcpWalletId, forestRoot, consentScopeFlags }` | Proves a prescriber is the member's assigned PCP; the proof itself serves as consent. |
| [src/wallets/wallet-migration-program.ts](src/wallets/wallet-migration-program.ts) | `WalletMigrationProgram` / `WalletMigrationProof` | No — depth 0 (`maxProofsVerified=0`; single method `proveIdentityContinuity`, 14 raw `Field` inputs = two 7-field padded preimages) | `MigrationOutput { domainTag, oldWalletId, newWalletId }` | Proves identity continuity between old and new wallet (same PHI/identity, changed enrollment key). |

**None of these are part of the recursive spine.** Each emits a depth-0 — or at most one-level, ProofGate-recursive (`CredentialProgram`, `InNetworkProgram`) — output that the sequencer either *folds* into the spine (only `StateTransitionProof` outputs do this) or simply *logs/commits* (fulfillment, prescription, messaging flow into accumulators, audit, and forest roots — never into `BatchProgram`/`ChainProgram`).

## 5. What makes the recursion actually run (drivers)

| File | Export | Role |
|---|---|---|
| [src/l2/l2-sequencer-service.ts](src/l2/l2-sequencer-service.ts) | `L2SequencerService` (+ `DEFAULT_BATCH_INTERVAL_MS=180_000`, `MAX_TRANSITIONS_PER_BATCH=2`) | Verifies submitted `StateTransitionProof`s (`submitProof` → `proof.verify()`), queues them, and calls `BatchProgram.wrapSingle/wrapPair/mergeBatches` (in `buildBatch`) + `ChainProgram.genesis/advance` (in `produceChainProof`) to settle the L2 chain. Not a ZkProgram. |
| [src/l2/l2-proving-pool.ts](src/l2/l2-proving-pool.ts) | `ProvingPool` | Forks N child-process workers via `child_process.fork` (each its own o1js Pickles context) and dispatches `ProvingJobRequest`s for CPU-parallel proving. Not a circuit. |
| [src/l2/l2-proving-worker.ts](src/l2/l2-proving-worker.ts) | child-process entry point (no exports; `process.on('message', …)`) | Compiles `StateTransitionProgram → BatchProgram → ChainProgram` and runs the `wrapSingle/wrapPair/mergeBatches` tree-merge + `ChainProgram.genesis/advance` recursion off the main thread. |
| [src/l2/l2-types.ts](src/l2/l2-types.ts) | `L2Receipt`, `L2Block`, `L2Batch`, `L2NodeConfig`, … | Pure TypeScript types (no runtime code). `L2Batch` carries the serialized `batchProofJson` (required) and optional `chainProofJson`. |

These are **not circuits** — they orchestrate compilation, proving, batching, and chaining in plain TypeScript, turning the static recursive ZkPrograms into a running, settling L2 chain.

## 6. Bundle boundary summary

**This bundle (the core recursive proof system) includes:**

- **Recursion spine:** [state-transition.ts](src/engine/state-transition.ts), [batch-program.ts](src/l2/batch-program.ts), [chain-program.ts](src/l2/chain-program.ts), [global-state.ts](src/l2/global-state.ts)
- **On-chain settlement + lifecycle primitive:** [care-contract.ts](src/engine/care-contract.ts), [lifecycle.ts](src/engine/lifecycle.ts)
- **ZK primitives it's built on:** [hash-utils.ts](src/zkp/hash-utils.ts), [commitment.ts](src/zkp/commitment.ts), [merkle-forest.ts](src/zkp/merkle-forest.ts), [zkp/index.ts](src/zkp/index.ts), [wallet-derivation.ts](src/wallets/wallet-derivation.ts), [wallet-state.ts](src/wallets/wallet-state.ts)
- **Base ownership circuit:** [proof-gate.ts](src/wallets/proof-gate.ts)
- **Drivers that run the recursion:** [l2-sequencer-service.ts](src/l2/l2-sequencer-service.ts), [l2-proving-pool.ts](src/l2/l2-proving-pool.ts), [l2-proving-worker.ts](src/l2/l2-proving-worker.ts), [l2-types.ts](src/l2/l2-types.ts)
- **Domain feeder circuits:** [eligibility-program.ts](src/eligibility/eligibility-program.ts) (2 programs), [access-control-program.ts](src/access-control/access-control-program.ts), [prescription-program.ts](src/prescription/prescription-program.ts), [fulfillment-program.ts](src/fulfillment/fulfillment-program.ts), [accumulator-fulfillment-program.ts](src/fulfillment/accumulator-fulfillment-program.ts), [credential-program.ts](src/credentials/credential-program.ts), [messaging-program.ts](src/messaging/messaging-program.ts), [pcp-verification-program.ts](src/eligibility/pcp-verification-program.ts), [wallet-migration-program.ts](src/wallets/wallet-migration-program.ts)

**It depends on, but does NOT include, the L2 operations layer:**

- Leviathan multi-leader networking, gossip replication, peer management, failover (`l2-leviathan*`, `l2-peer*`)
- Durability/consensus — WAL (`l2-wal`) and quorum writes/certificates (`l2-quorum*`)
- Storage, checkpoint/recovery, RPC server/client, accumulator/index services (`l2-checkpoint`, `l2-rpc-server`, `l2-client`, `claim-accumulator-service`, `message-store-service`, `audit-service`)

**The dividing line:** the ZK core ends at *proof generation, recursive folding, and on-chain settlement* — anything that ships proofs between nodes, persists them durably, achieves quorum, or serves them over the wire is the **L2 operations layer**, not part of this bundle.

---

## 7. How the systems interact — submission and propagation

This is the layer the bundle *plugs into*. Two flows matter: **(A) how a proof gets pushed to and accepted by the sequencer**, and **(B) how every other node learns about it**.

### A. The push path (device → sequencer → finality)

```
[device]  build proof          [node]  forward via RPC      [sequencer]  accept + commit
PHI/PII ──▶ ZkProgram.prove ──▶ L2Client.submitProof ──▶ L2RpcServer ──▶ L2SequencerService.submitProof
(local only)   (leaf proof)        (JSON-RPC 2.0)          (HTTP)              │
                                                                              ▼
                                                          1. proof.verify()  (reject if invalid)
                                                          2. WAL append (fsync, uncommitted)
                                                          3. quorum: propose → collect N/2+1 votes → certificate
                                                          4. mutate state (registry/lifecycle trees)
                                                          5. append AuditEvent to Poseidon hash-chain
                                                          6. side-effects: ClaimAccumulator / MessageStore append
                                                          7. WAL commit marker + return L2Receipt (with cert)
```

1. **Proof is built on the participant's own device.** Raw PHI/PII never leaves it. The device runs the relevant ZkProgram — `StateTransitionProgram` for register/update, or the claim-flow circuits (`AccumulatorFulfillmentProgram`, etc.) — producing a leaf proof whose public output carries only hashes and roots. The entity node ([member-node.ts](src/nodes/member-node.ts), [pharmacy-node.ts](src/nodes/pharmacy-node.ts), …, all built on [entity-node-base.ts](src/nodes/entity-node-base.ts)) holds local plaintext in [nautilus-local-state.ts](src/nodes/nautilus-local-state.ts); the network sees only the proof.

2. **The node forwards the proof** through [l2-client.ts](src/l2/l2-client.ts) (the SDK) over JSON-RPC to the sequencer's [l2-rpc-server.ts](src/l2/l2-rpc-server.ts). Only the `StateTransitionProof` is what actually mutates registry/lifecycle state and enters the settlement spine; claim proofs (fulfillment/prescription) are submitted with their metadata and get *logged* into accumulators + audit, not folded into batches.

3. **`L2SequencerService.submitProof()` verifies it** — `proof.verify()` rejects anything that doesn't satisfy the circuit. This is the trust gate: the sequencer never trusts the submitter, only the proof.

4. **Write-Ahead Log first ([l2-wal.ts](src/l2/l2-wal.ts)).** The proof is appended to a per-partition fsync'd NDJSON log as *uncommitted* before any in-memory state changes — so a crash mid-accept replays cleanly.

5. **Quorum, not unilateral acceptance ([l2-quorum-service.ts](src/l2/l2-quorum-service.ts)).** In a multi-node deployment the leader broadcasts a `quorum:propose`, each peer re-verifies the proof and returns an Ed25519-signed `quorum:vote`, and once **N/2+1** votes are in, the leader assembles a `QuorumCertificate`, writes the WAL commit marker, mutates state, and returns the `L2Receipt` carrying that certificate. **That receipt + certificate is finality** — there is no L1 round-trip in the default config.

6. **State mutation + audit.** The wallet registry leaf and lifecycle leaf are updated (their new roots are exactly the `newRegistryRoot`/`newLifecycleRoot` the proof committed to), an `AuditEvent` is appended to the Poseidon hash-chain ([audit-service.ts](src/audit/audit-service.ts)), and claim/message side-effects land in [claim-accumulator-service.ts](src/l2/claim-accumulator-service.ts) / [message-store-service.ts](src/l2/message-store-service.ts).

7. **Batch boundary → the recursive spine fires.** On a timer (`DEFAULT_BATCH_INTERVAL_MS`) or when pending count hits `MAX_TRANSITIONS_PER_BATCH`, the sequencer drains queued `StateTransitionProof`s and the [proving pool](src/l2/l2-proving-pool.ts) runs `BatchProgram.wrapPair/wrapSingle → mergeBatches` (balanced tree) and optionally `ChainProgram.advance`, producing the `L2Batch` (`batchProofJson` + optional `chainProofJson`) with a `StateCertificate` attached.

### B. The propagation path (sequencer → all other nodes)

The Leviathan network ([l2-leviathan.ts](src/l2/l2-leviathan.ts)) is a set of cooperating sequencer nodes, not a single server. Updates spread by **epidemic gossip** ([l2-peer-network.ts](src/l2/l2-peer-network.ts)), with bounded-set dedup so a message is relayed at most once:

```
                         ┌──────────────── gossip (epidemic broadcast, deduped) ────────────────┐
                         │                                                                       │
  [leader/sequencer] ──proof:accepted──▶ [replica] ──relay──▶ [replica] ──relay──▶ [replica]
        │  batch:built ─────────────────────▶  apply idempotently (applyReplicatedReceipt/Batch/Settlement)
        │  batch:settled / batch:failed ────▶
        │  state:snapshot ──────────────────▶  (full-state catch-up)
        │  message:stored / plan:updated / formulary:updated
        │  leader:heartbeat (every 5s) ─────▶  miss > 15s ⇒ deterministic failover promotion
        └  quorum:propose / quorum:vote / quorum:certificate  (directed, for the consensus in A.5)
```

- **Gossip message types** cover the whole lifecycle: `proof:accepted`, `batch:built`, `batch:settled`, `batch:failed`, `state:snapshot`, `peer:announce`, plus `message:stored`, `plan:updated/deleted`, `formulary:updated`, the two leader-management messages (`leader:heartbeat`, `leader:promotion`), the three directed quorum messages, and `admin:eviction`.
- **Replicas apply everything idempotently** (`applyReplicatedReceipt` / `applyReplicatedBatch` / `applyReplicatedSettlement`) — receiving the same gossip twice is a no-op, so eventual consistency holds despite the epidemic flooding.
- **New nodes bootstrap via Initial Block Download** — `L2Node.fromPeerSync(peerUrl, …)` pulls a full `state:snapshot` from an existing peer, then catches up on live gossip.
- **Multi-leader partitioning.** Leviathan runs N partition sequencers; each *leads* one partition (owns its root chain) and *replicates* the rest. Writes route to the owning leader by hashing the `walletId` (`PartitionRouter`); reads aggregate across partitions. This removes root-contention between concurrent leaders.
- **Failover without split-brain.** A 5s heartbeat with a 15s timeout triggers promotion along a **deterministic failover chain** fixed up front — if two nodes race to promote, the higher-priority one deterministically wins.
- **Durability + verifiability anchors.** The WAL gives per-node crash recovery; the quorum certificate on each receipt proves N/2+1 nodes committed it; a **state certificate** (N/2+1 signatures over the batch's state digest, signers checked against the *registered peer registry*, not embedded keys) rides on each `L2Batch`; and the head `ChainProof` (~22 KB) lets any node verify the entire history from scratch.

**The one-line mental model:** *devices prove locally → nodes relay the proof → the sequencer verifies, logs, and reaches quorum (that's finality) → the recursive spine periodically folds accepted transitions into a chain proof → gossip fans every receipt, batch, and settlement out to all replicas, who apply them idempotently and can take over via deterministic failover.*

---

*Source-verified against the implementation on 2026-05-31. For the operational gaps that still need hardening before a real-data deployment, see [SECURITY.md](SECURITY.md).*
