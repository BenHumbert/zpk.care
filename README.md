# zpk.care

**A privacy-preserving, zero-knowledge system for adjudicating prescription-drug
benefit claims** — built so that a patient's personal and health information
never leaves their own device, while pharmacies, prescribers, employers, and the
plan still get everything they need to process a claim.

It is given to the world freely under the **Apache License 2.0**. Please read
**[MISSION.md](MISSION.md)** — it explains why this exists and the spirit in
which it's shared.

> Status: this is a **working research / reference implementation**. It runs
> end-to-end on a single machine and demonstrates the full architecture. It is
> **not yet production-hardened** — see **[SECURITY.md](SECURITY.md)** for an
> honest list of known limitations and how each one is meant to be solved.

---

## What problem it solves

Today, prescription-drug claims flow through opaque middlemen (pharmacy benefit
managers). Pricing is secret, spreads and rebates are hidden, and a patient's
identity and medication history are copied into databases far outside their
control. zpk.care reorganizes this around two ideas:

1. **Your data stays with you.** A member's identity and health details live
   only on their own device. The network stores only Poseidon hash commitments
   and zero-knowledge proofs — never names, dates of birth, or medication
   history in the clear. The insurer sees an opaque wallet ID, not a person.
2. **Transparent pricing, no middleman vault.** Claims are adjudicated by
   zero-knowledge proof against published benefit rules and NADAC (the public
   CMS drug-acquisition cost), with the copay computed *inside the circuit* —
   so the math is verifiable and can't be quietly marked up.

Instead of a public blockchain, the trust layer is a small **"Leviathan"
network** of cooperating sequencer nodes that agree on state via gossip
replication and quorum writes.

## Quick start

**Prerequisites**
- **Node.js 20+** (uses ES modules + [`tsx`](https://github.com/privatenumber/tsx); no separate build step needed to run)
- **~8 GB RAM** recommended — the system compiles real zero-knowledge circuits and runs a small pool of prover worker processes
- macOS, Linux, or Windows

**Install and run**
```bash
npm install
npm run start:leviathan:clean:100
```

That single command:
- kills anything on the dev ports and clears local chain state (`:clean`),
- starts the Leviathan sequencer + two replicas,
- compiles the zero-knowledge programs and starts a small prover pool,
- boots the insurer node, then the member / prescriber / pharmacy nodes,
- and serves every dashboard.

The `:100` limits the demo formulary to ~100 drugs so the first boot is fast.
First startup compiles circuits and can take a few minutes; watch the logs for
each node reaching `ready`. See **[RUNNING.md](RUNNING.md)** for variants,
ports, hardware notes, and troubleshooting.

## What you're looking at

Once everything is up, open these in a browser:

| URL | Who it's for | What it does |
|-----|--------------|--------------|
| `http://localhost:4004/marketplace/` | Employer (self-service) | Browse plans, apply, sign the benefit agreement, activate |
| `http://localhost:4004/` | Insurer / plan admin | Credentialing, plans, formulary, claims, reports, audit |
| `http://localhost:4001/` | Member (patient) | Enroll, view drug history, secure messaging |
| `http://localhost:4002/` | Prescriber | Write e-scripts, look up patients & formulary |
| `http://localhost:4003/` | Pharmacy | Fill scripts, drug-utilization review |
| `http://localhost:8000/` | Anyone | Block explorer — inspect batches, receipts, chain state |

The sequencer's JSON-RPC + event stream listens on `http://localhost:3030`.
Employer nodes and their HR Tools are **spawned on demand** when an employer
activates in the marketplace (they get their own ephemeral ports).

## How it works in 60 seconds

There are five kinds of participant: **member, prescriber, pharmacy, insurer,
and employer**. A member's wallet ID is a Poseidon hash of their identity plus a
device-only secret (the "enrollment key") that is *never transmitted*. Every
action — enrolling, filling a prescription, updating coverage — is turned into a
**zero-knowledge state-transition proof** on the participant's own device and
submitted to the Leviathan sequencer, which batches and chains the proofs.
Because the proof verifies the rules without revealing the inputs, the network
can confirm "this claim is valid and the member owes $20" without ever learning
who the member is or what drug they took.

The full design — wallet derivation, the proof-composition graph, the L2 /
Leviathan trust layer, and the three-party enrollment ceremony — is in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Repository map

```
src/                 TypeScript backend (the whole system)
  l2/                Leviathan sequencer, batching, gossip, quorum, accumulators
  nodes/             Per-participant HTTP nodes + the leviathan launcher
  onboarding/        Three-party enrollment ceremony (tokens, roster, attestation)
  engine/            Core state-transition zero-knowledge program
  wallets/           Wallet-ID derivation + proof-gate ownership program
  credentials/       Credential issuance, NFC attestation, provider badges
  eligibility/  access-control/  prescription/  fulfillment/   claim flow circuits
  messaging/         Encrypted member <-> provider messaging
  tools/             The HR Tool (runs on the employer's own workstation)
dashboard-*/         Browser UIs (vanilla JS) for each participant + marketplace
explorer/            Static block-explorer UI
visualizer/          Animated end-to-end demo
scripts/             Bootstrap + data-loading utilities
tests/               Jest test suites
```

## Documentation

- **[MISSION.md](MISSION.md)** — why this exists and how it's meant to be used
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the technical design, in depth
- **[RUNNING.md](RUNNING.md)** — running it, ports, hardware, troubleshooting
- **[SECURITY.md](SECURITY.md)** — known limitations and the path to hardening

## License

Apache License 2.0 — see **[LICENSE](LICENSE)** and **[NOTICE](NOTICE)**.
You may use, modify, and sell products based on this work. Please honor the
spirit described in [MISSION.md](MISSION.md): keep it fair.
