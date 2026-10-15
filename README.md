# zpk.care

**Privacy-preserving pharmacy benefit claim adjudication, built on zero-knowledge proofs.**

**License:** Apache 2.0 · **Status:** research prototype · **Stack:** TypeScript, [o1js](https://github.com/o1-labs/o1js) v2.13

> Fill a prescription without revealing your identity, on fully transparent drug plans designed to scale to millions of members.

zpk.care is a complete, working claim adjudication system for pharmacy benefits in which members' personal and health information never leaves their own devices. The network only ever sees cryptographic commitments, never a name, a diagnosis, or a medication history. There is no national switchboard, and no PBM ever needs to store PHI or PII.

The project is released freely under the Apache License 2.0. You may use it, build on it, and build a business on it. The [Mission](#mission) describes the spirit in which it is shared.

## Table of contents

1. [Support this work](#support-this-work)
2. [Project status](#project-status)
3. [Why it matters](#why-it-matters)
4. [How it works](#how-it-works)
5. [Architecture: the zero-knowledge core](#architecture-the-zero-knowledge-core)
6. [Getting started](#getting-started)
7. [Using zpk.care in research or an existing product](#using-zpkcare-in-research-or-an-existing-product)
8. [Open work](#open-work)
9. [Documentation](#documentation)
10. [Mission](#mission)
11. [License and patents](#license-and-patents)

## Support this work

zpk.care is free and always will be. If it has helped you and you would like to give back, either of the options below is appreciated. The best support of all is to use this work to help someone.

**Buy me a coffee**

- **Buy Me a Coffee:** [buymeacoffee.com/benhumbert](https://buymeacoffee.com/benhumbert)
- **BTC:** `bc1qh2ufj2lhgqq706txpm35h433nrhudvq0yts7yy`
- **ETH:** `ben.humbert.eth`

**Help with Grant's treatment.** My son Grant is the reason I started this project. I am now stepping away from it to care for him while he is treated for a pediatric brain tumor that is causing him to go blind. If you would like to help our family:

- **BTC:** `bc1queyzjjgmd7qg7sq7attuz2mwjh7xcz4ddl3yht`
- **ETH:** `0xB6b82bD1775657f97252982D136aA971220DbF64`

## Project status

zpk.care is a **research prototype and reference implementation**. Before you build on it, it helps to know where it stands:

- **Implemented and tested:** the cryptographic core. This covers wallet derivation, the device-only enrollment key, proof generation and verification, in-circuit claim adjudication, the audit hash chain, gossip replication, and write-ahead-log and quorum durability.
- **Not yet production-hardened:** the edges around that core, namely dashboard message encryption, browser key storage, and RPC access control. Each gap and its fix is documented in [SECURITY.md](SECURITY.md).
- **Not independently audited.** The cryptography and key-management design should be reviewed by a third party before any deployment that handles real data.
- **Demo data is fictional.** The bundled prescribers, pharmacies, medications, and members are invented.
- **Not actively maintained.** The author has stepped away from development (see [Support this work](#support-this-work)). If you build on this code, plan to own and maintain your fork.

## Why it matters

Today a prescription claim passes through systems that see every patient's identity and medication history, and that price drugs through hidden rebates and markups. PBM servers also hold large amounts of PHI and PII they do not need. zpk.care removes that exposure and returns the benefit to the people in the system:

- **Members.** Your health data stays on your phone or at home. Transparent plans are easier to access. Your coverage works offline with a tap of an NFC card at the prescriber and at the pharmacy. You are never a row in a database waiting to be breached.
- **Pharmacies.** A fair dispensing fee, with no below-cost reimbursement and no surprise clawbacks. Checkout is faster because staff no longer handle PII at the point of sale.
- **Employers and plans.** Lower, fully transparent administrative costs, with every claim independently verifiable. There is almost nothing to breach, because no health data is stored.
- **Operators.** The system is designed to run lean. The author estimates that a team of about 20 people with $180K of equipment could serve 1 million members.
- **Everyone.** Rules are enforced by mathematics rather than trust, and only transparent plans are supported.

*These are the outcomes the system is designed to deliver. Real-world results depend on plan configuration and deployment, and have not yet been measured in production.*

## How it works

1. **Enroll.** Your employer gives you an enrollment code that contains no personal information. On your phone you create a private secret that never leaves the device, and that secret derives an opaque wallet address. Your plan activates coverage against that address without learning who you are.
2. **Get a prescription.** Once your prescriber is connected to you as your primary care provider (PCP), they send an e-prescription to the pharmacy.
3. **Fill it.** At the pharmacy, your device proves that you are covered and calculates exactly what you owe. It outputs only two numbers: what you pay and what the plan pays. Neither your name nor the drug name leaves your phone.
4. **Settle.** The network verifies the proof in milliseconds and settles the payment with finality. The pharmacy is guaranteed fair payment, and your deductible updates automatically.
5. **Go offline.** A tap of your NFC card proves your coverage in under a millisecond, even with no internet connection.

## Architecture: the zero-knowledge core

The dashboards and website are a demonstration surface. The substance of the project is the proof system underneath them, which makes prescription fills private, fast, and secure.

**1. Wallets are math, not keys.** A wallet ID is `Poseidon.hash([domainTag, ...hashedIdentityFields, hash(enrollmentKey)])`. The enrollment key is a high-entropy secret created on the member's device and never transmitted. Domain tags separate roles (member, prescriber, pharmacy, representative) so identical identity data cannot collide across them. There is no traditional private key. Access is demonstrated by a zero-knowledge proof of knowledge of the preimage.

**2. Every state change is a proof.** The system is built on [o1js](https://github.com/o1-labs/o1js), Mina's TypeScript ZK framework (Poseidon hashing, Merkle trees, recursive `ZkProgram`s). Circuits are arranged so recursion never exceeds two levels, which keeps the system safely within the limits of the Pickles / Kimchi proof system:

- `ProofGateProgram` proves wallet ownership from the identity plus enrollment-key preimage.
- `StateTransitionProgram` is the core proof the sequencer accepts (registration, wallet update). Wallet ownership is inlined here rather than verified recursively.
- `EligibilityProgram`, `AccessControlProgram`, `PrescriptionProgram`, `FulfillmentProgram`, and `AccumulatorFulfillmentProgram` form the claim flow: coverage, formulary and prior authorization, prescription lifecycle, settlement, and deductible / out-of-pocket accumulation.
- `BatchProgram` recursively folds many state-transition proofs into one batch proof, and `ChainProgram` chains batches over time. The sequencer produces these and replicates them by gossip.

**3. Adjudication runs inside the proof.** Fulfillment circuits compute `patientPay = min(total, copay)` and `planPay = total - patientPay`. The accumulator-aware variant applies, in priority order, the out-of-pocket maximum, then exhausted benefit, then remaining deductible, then copay. Because the math runs inside the proof, any party can verify the calculation, and the result is tamper-evident.

**4. State lives in Merkle commitments.** The sequencer maintains a wallet registry and a lifecycle tree (`EMPTY` → `REGISTERED` → `ELIGIBLE` → `ACTIVE` → `REVOKED`), a six-domain MerkleForest per credential (member, prescriber, pharmacy, medication, access control, transaction), a 16M-leaf claim accumulator, a 1M-leaf encrypted message store, a provider registry, a 32K-drug formulary, and benefit plans. All of it is checkpointed to disk and restored on restart.

**5. The Leviathan is the trust layer.** A small set of partitioned sequencer nodes replicates state by epidemic gossip with deduplication. A 5-second heartbeat with a 15-second timeout triggers deterministic failover, which prevents split brain. Durability comes from an fsync'd, crash-recoverable write-ahead log plus quorum writes: a proof is not accepted until N/2+1 nodes have logged it and signed it with Ed25519. Batch proving is parallelized across a pool of child-process workers.

**6. What never leaves the device.** On the phone: names, dates of birth, identifiers, the enrollment key, and plaintext medication history. On the network: opaque wallet IDs (Poseidon hashes), state-transition and claim proofs, hash commitments, and encrypted payloads only. The privacy boundary is a property of the math.

**Why this matters beyond pharmacy.** When a system can act only on hashes and proofs, there is no central store of records to steal, no opaque adjudication to hide fees in, and no rule that can be changed silently without leaving a verifiable trace. Applied across other benefit categories, the same approach replaces "trust us to be fair" with "verify us by math."

For the full technical design see [ARCHITECTURE.md](ARCHITECTURE.md). For the proof system specifically (the file-by-file bundle, the recursive spine, and how the pieces interact at runtime) see [ZKP_OVERVIEW.md](ZKP_OVERVIEW.md). For the line-by-line proof reference see [ZKPROOFS.md](ZKPROOFS.md).

## Getting started

You can run the entire network (sequencer, every participant node, and every dashboard) on one machine with a single command.

### Prerequisites

- Node.js 20 or newer (TypeScript runs through `tsx`; there is no build step)
- git
- macOS, Linux, or Windows
- A modern browser for the dashboards

### Hardware

Full demo on one machine: **64 GB RAM, 4 cores** (16 GB / 8 cores is comfortable).

Per node, if deployed separately:

| Node | Min CPU | Min RAM |
|------|:---:|:---:|
| Leviathan sequencer | 8 cores | 32 GB |
| All other nodes (member, prescriber, pharmacy, insurer, employer) | 2 cores | 8 GB |

The sequencer does the heavy zero-knowledge work, since proving runs inside it. The other nodes are lightweight web servers; their 8 GB covers the one-time circuit compile during enrollment.

### Step by step

1. **Get the code**
   ```bash
   git clone https://github.com/BenHumbert/zpk.care.git
   cd zpk.care
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Start everything**
   ```bash
   npm run start:leviathan:clean:100:unsecure
   ```
   This frees the dev ports, clears local state, and then boots the Leviathan sequencer, two replicas, the proof workers, and every participant node with its dashboard. `:100` loads a 100-drug formulary so the first boot is fast. `:unsecure` relaxes RPC authentication and CORS for single-machine development. Never use this mode beyond `localhost`.

   > The first boot takes a few minutes while the zero-knowledge circuits compile. This is expected and happens once per run. Wait for the startup banner.

4. **Open the dashboards** in your browser:

   | Dashboard | URL |
   |------|-----|
   | Employer marketplace (start here) | http://localhost:4004/marketplace/ |
   | Insurer / plan admin | http://localhost:4004/ |
   | Member (patient) | http://localhost:4001/ |
   | Prescriber | http://localhost:4002/ |
   | Pharmacy | http://localhost:4003/ |
   | Network explorer | http://localhost:8000/ |

5. **Walk through the full flow:**
   1. **Marketplace.** An employer browses plans, applies, signs, and activates. Activation starts that employer's private node and HR Tool on their own ports.
   2. **HR Tool.** Import an employee list and issue enrollment codes. All personal data is hashed locally on the employer's machine.
   3. **Member.** Enroll with a code, then view coverage and drug history.
   4. **Prescriber.** Write an e-prescription.
   5. **Pharmacy.** Fill it and watch the claim settle.
   6. **Explorer.** Inspect the batches, receipts, and chain state behind it all.

6. **Stop**
   - Press Ctrl+C in the terminal.
   - If a port is still held afterward, run `npm run kill:ports`.

7. **Run the tests** (optional)
   ```bash
   npm test
   ```

For run variants, ports, and troubleshooting see [RUNNING.md](RUNNING.md).

## Using zpk.care in research or an existing product

zpk.care is published as a working reference implementation, so it can be studied as a whole, prototyped against, or adopted in parts.

### Suggested evaluation path

1. Run the full network locally and walk through the end-to-end flow ([Getting started](#getting-started)).
2. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the trust model, then [ZKP_OVERVIEW.md](ZKP_OVERVIEW.md) for the proof pipeline.
3. Run `npm test`. The Jest suites cover each layer of the system, the L2 network, failover, WAL and quorum durability, and end-to-end smoke tests. Suites that compile circuits are slow.
4. Read [SECURITY.md](SECURITY.md) before making any decision that involves real data.

### Integration points

| To do this | Start here |
|---|---|
| Connect an existing system to the network | JSON-RPC 2.0 server in [src/l2/l2-rpc-server.ts](src/l2/l2-rpc-server.ts) and the typed TypeScript client in [src/l2/l2-client.ts](src/l2/l2-client.ts), which also streams chain events over Server-Sent Events |
| Reuse the proof circuits | The `ZkProgram`s in [src/eligibility/](src/eligibility/), [src/access-control/](src/access-control/), [src/prescription/](src/prescription/), [src/fulfillment/](src/fulfillment/), [src/engine/](src/engine/), and [src/wallets/](src/wallets/); library exports in [src/index.ts](src/index.ts) |
| Design or add benefit plans | `PlanTemplate` in [src/onboarding/plan-template.ts](src/onboarding/plan-template.ts) (one definition per plan, applied to many members) and the plan registry in [src/eligibility/benefit-plan-registry.ts](src/eligibility/benefit-plan-registry.ts) |
| Load or update a formulary | [src/access-control/formulary-registry.ts](src/access-control/formulary-registry.ts), [src/eligibility/formulary-update-service.ts](src/eligibility/formulary-update-service.ts), and `npm run fetch:nadac` for public NADAC drug data |
| Onboard employers and members | The three-party enrollment ceremony in [src/onboarding/](src/onboarding/) and the employer HR Tool in [src/tools/](src/tools/) |
| Hand finalized batches to an external settlement system | The `SettlementStrategy` hook in [src/l2/l2-node.ts](src/l2/l2-node.ts) |

### Design constraints to know before extending

- **Recursion depth is capped at two.** No proof may verify proofs more than two levels deep, because of a known Pickles limitation. New circuits must fit the existing `StateTransition → Batch → Chain` spine. See [ZKPROOFS.md](ZKPROOFS.md).
- **Tree capacities are part of the circuits.** Merkle tree heights (128 benefit plans, 32,768 formulary entries, 16M claims, 1M messages) are fixed at compile time. Changing one changes the circuit, so it requires recompiling and produces new verification keys.
- **Proving is single-threaded per process.** o1js proves in one thread per process, so throughput scales with the size of the proving-worker pool, not with threads.
- **The privacy boundary must hold end to end.** Any system you connect should receive only wallet IDs, commitments, and proofs. If an integration requires sending PHI or PII to a server, it breaks the core guarantee.

### Before using real data

Complete the hardening items in [SECURITY.md](SECURITY.md), commission an independent review of the cryptography and key management, and complete your own regulatory and compliance review. The `:unsecure` run modes are for local development only.

## Open work

These items are known, scoped, and open to contributors:

- **End-to-end message encryption in the dashboards.** Replace the base64 placeholder with X25519 key agreement and AES-256-GCM. The primitives already exist in [src/security/encryption.ts](src/security/encryption.ts).
- **Hardened enrollment-key storage.** Encrypt the key at rest with Web Crypto, bind it to hardware with WebAuthn / FIDO2, or keep it off the browser entirely and rely on the NFC recovery card.
- **RPC access control.** Add role-based access with wallet-ownership proofs, per-role allowlists on node proxies, and restricted CORS origins.
- **Independent security review** of the circuits, key management, and network protocol.

Details and proposed fixes for each are in [SECURITY.md](SECURITY.md). Improvements are welcome as pull requests.

## Documentation

For a newcomer, a good reading order is ARCHITECTURE → ZKP_OVERVIEW → ZKPROOFS.

| Document | What it covers |
|-----|----------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The trust model, the five participants, identity and privacy, and the overall system design |
| [ZKP_OVERVIEW.md](ZKP_OVERVIEW.md) | The zero-knowledge proof system as a bundle: every core file, the recursive `StateTransition → Batch → Chain` spine, and how the components push proofs and propagate updates (source-verified) |
| [ZKPROOFS.md](ZKPROOFS.md) | The engineering deep dive: every `ZkProgram`, what each proof commits to, and the Pickles recursion constraints, with citations to source |
| [RUNNING.md](RUNNING.md) | Running on one machine: prerequisites, start commands, ports, and troubleshooting |
| [SECURITY.md](SECURITY.md) | An honest accounting of the proven cryptographic core and the edges that still need hardening |
| [MISSION.md](MISSION.md) | Why this project exists and the spirit in which it is shared |
| [PATENTS.md](PATENTS.md) | Patent stance: none held; released as a defensive publication |

## Mission

**Nobody should have their family's health data exposed and sold**

Today, prescription data is copied into centralized databases, which are then breached in all sorts of attacks. Because each one holds everyone's identity and medications in one place, it is a single point of catastrophic failure. zpk.care removes that risk. Your information stays on your own device, the network only ever sees cryptographic commitments, and there is no central store of records to steal.

There are no restrictions on commercial use. Openness does come with an ask. If you build on this work:

- Price around the value you genuinely add, not around what people in need can be extracted to pay.
- Be transparent that your product is built on free, open technology.
- Contribute improvements back to the community when you can.
- Reach out. Good-faith partners are welcome, and I would be glad to recognize those who honor this intent.

This was never built to make anyone rich. It was built to protect families like mine and to make medications affordable. Use it well, build something good with it, and keep it fair.

The full statement is in [MISSION.md](MISSION.md).

## License and patents

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). You may use, modify, and sell products built on this work. Please honor the spirit of the [Mission](#mission) and keep it fair.

A patent application covering aspects of this work was filed and has been allowed to lapse. The author holds no patent and will not pursue one. The full implementation, specification, claims, and figures are published here as a **defensive publication**: these techniques are now public prior art and cannot later be patented and locked away by anyone else. See [PATENTS.md](PATENTS.md).
