# zpk.care

> Fill your prescription without ever revealing your identity — on fully transparent drug plans that scale to millions of members.

zpk.care is a complete, working system for processing pharmacy benefit claims where your personal and health information never leaves your own device. The network only ever sees scrambled cryptographic commitments, never your name, your diagnosis, or your medication history. No need for a national switchboard, and no need for PBMs to store your PHI or PII.

It is given to the world freely under the Apache License 2.0. Use it, build on it, even build a business on it. See the [Mission](#mission) for the spirit behind it.

## Table of contents

1. [Why it matters](#why-it-matters)
2. [How it works (in plain English)](#how-it-works-in-plain-english)
3. [The ZK architecture (the underbelly)](#the-zk-architecture-the-underbelly)
4. [Mission](#mission)
5. [Support this work](#support-this-work)
6. [Getting started](#getting-started)
7. [Documentation](#documentation)
8. [License and patents](#license-and-patents)

## Why it matters

Today a prescription claim passes through systems that see every patient's identity and medication history, and price drugs through hidden rebates and markups. zpk.care removes that risk and hands the benefit back to the people in the system:

- **For patients.** Your health data stays on your phone. Transparent plans are more accessable. Your benefit works offline with a tap of an NFC card. You are never a row in a database waiting to be breached.
- **For pharmacies.** Paid the real cost of the drug plus a fair dispensing fee. No below-cost reimbursement, no surprise clawbacks.
- **For employers and plans.** Lower, fully transparent administrative costs, with every claim independently verifiable. Almost nothing to breach, because no health data is stored.
- **For everyone.** Rules enforced by mathematics, not trust. No spread pricing, no retained rebates, no hidden fees, because the system is built so they are not even possible.

*(These are the outcomes the system is designed to deliver. Real-world results depend on plan configuration.)*

## How it works (in plain English)

1. **Enroll.** Your employer gives you an enrollment code with no personal information in it. On your phone you create a private secret that never leaves your device, which derives a scrambled "wallet" address. Your plan activates coverage against that address, knowing nothing about who you are.
2. **Get a prescription.** Your prescriber sends an e-prescription into your phone's secure credential.
3. **Fill it.** At the pharmacy the math runs on your device. It proves you are covered and calculates exactly what you owe, then outputs only two numbers: what you pay and what the plan pays. No name and no drug name ever leaves your phone.
4. **Settle.** The network verifies the proof in milliseconds and settles payment with finality. The pharmacy is guaranteed fair payment and your deductible updates automatically.
5. **Offline.** A tap of your NFC card proves your coverage in under a millisecond, even with no internet.

## The ZK architecture (the underbelly)

The point of this project is not the dashboards or the website. It is the proof system underneath that makes private, fair claim adjudication possible at all. Here is how it actually works, end to end.

**1. Wallets are math, not keys.** A wallet ID is `Poseidon.hash([domainTag, ...hashedIdentityFields, hash(enrollmentKey)])`. The enrollment key is a high-entropy secret created on the member's device and never transmitted. Domain tags separate roles (member, prescriber, pharmacy, representative) so identical identity data cannot collide across them. There is no traditional private key. Access is demonstrated by a zero-knowledge proof that you know the preimage.

**2. Every state change is a proof.** Built on [o1js](https://github.com/o1-labs/o1js), Mina's TypeScript ZK framework (Poseidon hashing, Merkle trees, recursive `ZkProgram`s). Circuits are arranged so recursion never exceeds two levels, keeping the system safely inside the Pickles / Kimchi proof system:

- `ProofGateProgram` proves wallet ownership from the identity plus enrollment-key preimage.
- `StateTransitionProgram` is the core proof the sequencer accepts (registration, wallet update). Wallet ownership is inlined here, not recursed.
- `EligibilityProgram`, `AccessControlProgram`, `PrescriptionProgram`, `FulfillmentProgram`, and `AccumulatorFulfillmentProgram` form the claim flow: coverage, formulary plus prior auth, script lifecycle, settlement, and deductible / out-of-pocket accumulation.
- `BatchProgram` recursively folds many state-transition proofs into one batch proof. `ChainProgram` chains batches over time. These are what the sequencer produces and gossip-replicates.

**3. Adjudication runs inside the proof.** Fulfillment circuits compute `patientPay = min(total, copay)` and `planPay = total - patientPay`. The accumulator-aware variant prioritizes out-of-pocket-max, then exhausted benefit, then remaining deductible, then copay. Because the math runs inside the proof, no party can quietly mark it up. The result is tamper-evident.

**4. State lives in Merkle commitments.** The sequencer maintains a wallet registry plus a lifecycle tree (`EMPTY` to `REGISTERED` to `ELIGIBLE` to `ACTIVE` to `REVOKED`), a six-domain MerkleForest per credential (member, prescriber, pharmacy, medication, access-control, transaction), a 16M-leaf claim accumulator, a 1M-leaf encrypted message store, a provider registry, a 32K-drug formulary, and benefit plans. All checkpointed to disk and restored on restart.

**5. The Leviathan is the trust layer.** A small set of partitioned sequencer nodes replicates state by epidemic gossip with deduplication. A 5-second heartbeat plus a 15-second timeout triggers deterministic failover, preventing split brain. Durability comes from a write-ahead log (fsync'd, crash-recoverable) plus quorum writes: a proof is not accepted until N/2+1 nodes log it and Ed25519-sign it. Batch proving is parallelized across a pool of child-process workers. There is no L1 settlement layer. The Leviathan network is the trust.

**6. What never leaves the device.** On the phone: names, dates of birth, identifiers, the enrollment key, plaintext medication history. On the network: opaque wallet IDs (Poseidon hashes), state-transition and claim proofs, hash commitments, and encrypted payloads only. The privacy boundary is a property of the math, not a policy.

**Why this enables the future we want to see.** When a system can only act on hashes and proofs, there is no central pile of records to steal, no opaque adjudication for hidden fees, and no rule that can be silently changed without leaving a verifiable trace. Replicate this approach across every benefit category and "trust us, we'll be fair" gets replaced with "verify us, by math."

For the full technical design see [ARCHITECTURE.md](ARCHITECTURE.md). For the zero-knowledge proof system specifically — the file-by-file bundle, the recursive spine, and how the pieces interact at runtime — see [ZKP_OVERVIEW.md](ZKP_OVERVIEW.md); for the line-by-line proof reference see [ZKPROOFS.md](ZKPROOFS.md).

## Mission

**Nobody should have their family's health data exposed and sold — and millions of people a year never got a say in it.**

That is why I built zpk.care. Today, prescription data is copied into central databases people never chose to be part of, then breached by people they will never meet. The worst of it is the national switchboard: the central hub every prescription claim flows through. Because it holds everyone's identity and medications in one place, it is a single point of catastrophic failure. zpk.care removes it — your information stays on your own device, the network only ever sees scrambled math, and there is no central pile of records to steal. No switchboard, no breach.

I also have to step away from this work. My son has a brain tumor and needs me, and I can't give this project the time it deserves. So I am giving it away for free: to give it the best possible chance to protect people, and to keep it from being locked away by any one corporation. There are no restrictions on commercial use.

But openness comes with an ask. If you build on this work:

- Price around the value you genuinely add, not around what people in need can be made to pay.
- Be transparent that your product is built on free, open technology.
- Contribute improvements back to the community when you can.
- Reach out. Good-faith partners are welcome, and I would be glad to recognize those who honor this intent.

This was never built to make anyone rich. It was built to protect families like mine. If it protects yours too, it will have been worth it.

Use it well. Build something good with it. And keep it fair.

## Support this work

zpk.care is free, and always will be. If it has helped you and you would like to give back, here are two completely optional ways:

- **Buy me a coffee:** [your Buy Me a Coffee link here]
- **Help Grant's treatment:** I am stepping back from this project to care for my son, Grant, who is undergoing treatment for a brain tumor. If you would like to help our family, you can contribute here: [your fundraiser link here]

Either way, thank you. The best support of all is to use this to help someone.

## Getting started

You can stand up the entire network (sequencer, all participant nodes, every dashboard) on one machine with a single command.

### Prerequisites

- Node.js 20 or newer (runs TypeScript via `tsx` — no build step)
- git
- macOS, Linux, or Windows
- A modern browser for the dashboards

### Minimum hardware

Running the full demo on one machine: **8 GB RAM, 4 cores** (16 GB / 8 cores is comfortable).

Per node, if deployed separately:

| Node | Min CPU | Min RAM |
|------|:---:|:---:|
| Leviathan sequencer | 8 cores | 16 GB |
| All other nodes (member, prescriber, pharmacy, insurer, employer) | 2 cores | 8 GB |

The sequencer does the heavy zero-knowledge work — proving runs inside it. The other nodes are light web servers; the 8 GB covers the one-time circuit compile during enrollment.

### Step by step

1. **Get the code**
   ```bash
   git clone [your-repo-url]
   cd zpk_care
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Start everything**
   ```bash
   npm run start:leviathan:clean:100:unsecure
   ```
   Frees the dev ports, clears local state, then boots the Leviathan sequencer, two replicas, the proof workers, and every participant node with its dashboard. `:100` loads a 100-drug formulary so first boot is fast. `:unsecure` relaxes RPC auth and CORS for single-machine local development (do not use this mode for anything beyond `localhost`).

   > First boot takes a few minutes while the zero-knowledge circuits compile. This is normal and happens once per run. Watch for the startup banner.

4. **Open the dashboards** in your browser:

   | What | URL |
   |------|-----|
   | Employer marketplace (start here) | http://localhost:4004/marketplace/ |
   | Insurer / plan admin | http://localhost:4004/ |
   | Member (patient) | http://localhost:4001/ |
   | Prescriber | http://localhost:4002/ |
   | Pharmacy | http://localhost:4003/ |
   | Network explorer | http://localhost:8000/ |

5. **Walk the full flow:**
   1. **Marketplace.** Employer browses plans, applies, signs, and activates. Activation spins up that employer's private node and HR Tool on their own ports.
   2. **HR Tool.** Import an employee list and issue enrollment codes. All personal data is hashed locally on the employer's machine.
   3. **Member.** Enroll with a code, then view coverage and drug history.
   4. **Prescriber.** Write an e-prescription.
   5. **Pharmacy.** Fill it and watch the claim settle.
   6. **Explorer.** Inspect the batches, receipts, and chain state behind it all.

6. **Stopping**
   - Press Ctrl+C in the terminal.
   - If a port is still held afterward, run `npm run kill:ports`.

For run variants, ports, and troubleshooting see [RUNNING.md](RUNNING.md). For the full technical design see [ARCHITECTURE.md](ARCHITECTURE.md). For known limitations see [SECURITY.md](SECURITY.md).

## Documentation

For a newcomer, a good reading order is ARCHITECTURE → ZKP_OVERVIEW → ZKPROOFS.

| Doc | What it covers |
|-----|----------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The trust model, the five participants, identity/privacy, and the overall system design |
| [ZKP_OVERVIEW.md](ZKP_OVERVIEW.md) | The zero-knowledge proof system as a bundle — every core file, the recursive `StateTransition → Batch → Chain` spine, and how the systems interact to push proofs and propagate updates (source-verified) |
| [ZKPROOFS.md](ZKPROOFS.md) | The engineering deep dive: every `ZkProgram`, what each proof commits to, and the Pickles recursion constraints, with citations to source |
| [RUNNING.md](RUNNING.md) | Running it on one machine: prerequisites, start commands, ports, and troubleshooting |
| [SECURITY.md](SECURITY.md) | An honest accounting of the proven cryptographic core and the edges that still need hardening |
| [MISSION.md](MISSION.md) | Why this project exists and the spirit in which it is shared |
| [PATENTS.md](PATENTS.md) | Patent stance: none held; released as a defensive publication |

## License and patents

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). You may use, modify, and sell products built on this work. Please honor the spirit in the [Mission](#mission): keep it fair.

A patent application covering aspects of this work was filed but has been allowed to lapse. The author holds no patent and will not pursue one. The full implementation, specification, claims, and figures are published here as a **defensive publication**: these techniques are now public prior art and cannot later be patented and locked away by anyone else. See [PATENTS.md](PATENTS.md).
