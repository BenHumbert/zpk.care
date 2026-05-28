# Architecture

This document explains how zpk.care works: the trust model, how identity and
privacy are constructed, the zero-knowledge proof system, and the Leviathan L2
network that ties it together. For *running* the system see
[RUNNING.md](RUNNING.md); for known gaps see [SECURITY.md](SECURITY.md).

---

## 1. Design goals

1. **PHI/PII never leaves the device.** The network stores only Poseidon hash
   commitments and zero-knowledge proofs. No participant — not even the
   insurer or the sequencer — can read a member's identity or medication
   history from the network.
2. **Verifiable adjudication.** A claim's outcome (covered? what copay?) is
   computed *inside a zero-knowledge circuit* against published rules and
   public NADAC pricing, so it is provable and cannot be silently altered.
3. **No single trusted operator.** State is held by a small network of
   cooperating sequencer nodes (the "Leviathan") that replicate via gossip and
   confirm writes by quorum, with crash-safe logging and checkpoints.
4. **Runs without a public blockchain.** There is no L1 settlement layer; the
   Leviathan network *is* the trust layer.

## 2. The five participants and who sees what

| Participant | Holds | Sees on the network |
|-------------|-------|---------------------|
| **Member** (patient) | Identity + device-only enrollment key; their own wallet & credentials | Their own opaque wallet ID and proofs |
| **Prescriber** | Provider credential | Opaque wallet IDs; their own scripts |
| **Pharmacy** | Provider credential | Opaque wallet IDs; claims they fill |
| **Insurer** (plan/PBM) | Attestation authority; benefit rules & formulary | **Opaque wallet IDs only** — never member identity |
| **Employer** (plan sponsor) | Enrollment tokens; employee roster (hashed) | Opaque hashes only; never employee identity on the network |

The key property: the **insurer is an attestation authority, not a data
vault.** It registers wallets and mints credentials against hashes it is
given, and never learns the people behind them.

## 3. Identity: wallets and the enrollment key

A **wallet ID** is a Poseidon hash over a domain tag, the participant's
identity fields, and a **device-only enrollment key**:

```
walletId = Poseidon.hash([ domainTag, ...hashedIdentityFields, hash(enrollmentKey) ])
```

- The **enrollment key** is a high-entropy secret generated on the member's
  device. It is **never transmitted** and is mixed into wallet derivation, so
  even a full breach of identity data cannot reconstruct or take over a wallet
  without it.
- **Domain tags** separate entity types (member = 0, prescriber = 1,
  pharmacy = 2, representative = 3), so identical identity data can't collide
  across roles.
- Members bind to their employer group, so changing employers means a new
  enrollment ceremony — the wallet is intentionally not portable across plans.

Wallets are **proof-gated**: there are no private keys controlling them in the
usual sense. Access is demonstrated by a zero-knowledge proof that you know the
preimage (identity + enrollment key) that hashes to the wallet ID.

## 4. The zero-knowledge proof system

Built on **[o1js](https://github.com/o1-labs/o1js)** (MINA's TypeScript ZK
framework — Poseidon hashing, Merkle trees, and recursive `ZkProgram`s).

### Proof composition

Programs are organized so that **recursion never exceeds two levels** — this
deliberately works around a Pickles/Kimchi limitation where deeper recursion
with `maxProofsVerified = 2` fails. The main programs:

- **ProofGateProgram** — proves wallet ownership from the identity +
  enrollment-key preimage (`verifyMember` / `verifyPrescriber` /
  `verifyPharmacy` / `verifyRepresentative`). The base layer.
- **StateTransitionProgram** — the core proof submitted to the sequencer.
  `proveRegistration` (add a wallet) and `proveWalletUpdate` (state change).
  Wallet-ownership is *inlined* here (not recursive) to stay within the
  recursion limit. Its output is portable and verifiable offline.
- **CredentialProgram** — issues/holds credentials; recursively verifies a
  ProofGate proof.
- **EligibilityProgram / AccessControlProgram / PrescriptionProgram /
  FulfillmentProgram / AccumulatorFulfillmentProgram** — the claim-flow
  circuits (coverage, formulary + prior-auth, script lifecycle, settlement,
  and deductible/out-of-pocket accumulation).
- **MessagingProgram, PcpVerificationProgram, WalletMigrationProgram** —
  encrypted messaging/delegation, primary-care assignment, and device recovery.
- **BatchProgram** then **ChainProgram** — recursively fold many
  state-transition proofs into one batch proof, then chain batches together.
  This is what the sequencer produces.

### In-circuit settlement

The fulfillment circuits compute the financial split deterministically:
`patientPay = min(total, copay)` and `planPay = total − patientPay`, with the
accumulator-aware variant prioritizing out-of-pocket-max, then exhausted
benefit, then remaining deductible, then the normal copay. Because this is
inside the proof, the amounts are tamper-evident.

## 5. State model

The sequencer maintains several Merkle-committed structures (capacities are the
design targets):

- **Wallet registry + lifecycle trees** — every wallet's state commitment and
  its lifecycle stage: `EMPTY → REGISTERED → ELIGIBLE → ACTIVE → REVOKED`.
- **MerkleForest** — per-credential bundle of 6 domain trees (member,
  prescriber, pharmacy, medication, access-control, transaction), reduced to a
  single `forestRoot`.
- **Claim accumulator** (`MerkleTree(24)`, ~16M leaves) — every fill/reversal,
  with NDC drug identity, indexed by member/pharmacy/prescriber/drug.
- **Message store** (`MerkleTree(20)`, ~1M) — encrypted message payloads only.
- **Provider registry** (`MerkleTree(16)`) — credentialed prescribers and
  pharmacies with a lifecycle state machine.
- **Formulary** (`MerkleTree(16)`, ~32K drugs) + **benefit plans** — the
  published drug list and plan rules, with per-plan overlays.

All of these are checkpointed to disk and restored on restart.

## 6. The Leviathan L2 network

The trust layer is a set of sequencer nodes:

- **Sequencer** accepts state-transition proofs, verifies them, appends to an
  audit hash-chain, batches them (`BatchProgram` → `ChainProgram`), and serves
  state over JSON-RPC + Server-Sent Events.
- **Replicas** receive everything via **gossip** (epidemic broadcast with
  dedup) and can serve reads or take over.
- **Multi-leader partitioning** — `L2Leviathan` runs N partition sequencers,
  each leading one partition and replicating the rest, with a 5s heartbeat,
  15s failover timeout, and a deterministic failover chain to prevent
  split-brain.
- **Durability** — an optional **write-ahead log** (fsync'd, crash-recoverable)
  and **quorum writes** (a proof isn't accepted until N/2+1 nodes log and
  Ed25519-sign it) provide zero-data-loss guarantees.
- **Proving pool** — because o1js proving is single-threaded per process, batch
  proving is offloaded to a pool of child-process workers for real parallelism.

## 7. Three-party enrollment ceremony

Enrolling a member is split so no single party holds everything:

1. **Employer** issues a `GroupEnrollmentToken` — all fields are hashes; the
   employer's HR Tool keeps the name↔hash mapping locally (see §8).
2. **Member** receives the token (+ an out-of-band PIN), generates their
   enrollment key *on device*, and derives their wallet ID locally.
3. **Insurer** validates the token, registers the opaque wallet, and mints an
   eligibility credential — seeing only hashes, plan ID, group ID, and dates.

The insurer never sees a name, date of birth, or the enrollment key.

## 8. Employer self-onboarding (marketplace → HR Tool)

The newest subsystem lets an employer onboard themselves:

1. **Marketplace** (served by the insurer node at `/marketplace/`): the
   employer generates an Ed25519 keypair in-browser, applies, uploads their
   CP-575, and **signs a benefit-plan agreement**. The signed
   `EmployerAttestation` (with a monotonic sequence number to prevent replay)
   is registered on the sequencer; a legal DOCX is generated.
2. **Spawn-on-activate**: on activation, an orchestrator forks a per-employer
   node (whose pinned public key must match the on-chain attestation, or it
   refuses to start) and a **1:1 HR Tool**, then registers the tenant.
3. **HR Tool** runs only on the employer's own admin workstation. It parses an
   employee CSV, hashes all PII locally with a per-group random seed
   (domain-separated Poseidon, so the same employee is unlinkable across
   groups), encrypts the name↔hash correlation table at rest (scrypt +
   AES-256-GCM), and sends the employer node only opaque hashes plus a
   PIN-binding hash. Plaintext employee data never leaves the workstation.

## 9. The privacy boundary, summarized

| On the member's device (never transmitted) | On the network (commitments + proofs only) |
|---|---|
| Name, DOB, identifiers | Opaque wallet ID (a Poseidon hash) |
| Enrollment key (the device secret) | State-transition / claim proofs |
| Medication history in the clear | Hash commitments + encrypted payloads |
| Employee PII (on the HR workstation) | Employee ID **hashes** only |

The cryptographic core that enforces this boundary — wallet derivation, proof
generation and verification, the enrollment-key model, in-circuit settlement —
is fully implemented and real. The edges that still need hardening before any
real-data deployment are listed honestly in [SECURITY.md](SECURITY.md).
