# Patents and prior art

**This project is not encumbered by any patent held by the author, and it never will be.**

A nonprovisional U.S. patent application covering aspects of this work was filed in 2026. The author has chosen to **let it lapse** — to deliberately abandon it rather than prosecute, maintain, or enforce it. The reason is personal and final: the author's son's health needs his time and attention far more than a patent does, and the most useful thing this work can do is reach people now, freely. No patent has issued, none will be pursued, and the author will not assert any patent rights against anyone who uses this work.

To put it into the world permanently on those terms, the entire project is released under the **Apache License 2.0** — an OSI-approved open-source license under which anyone may use, modify, distribute, and commercialize it. This is a deliberate choice: open release under Apache 2.0, not a patent, is what carries this technology out into the world and keeps it free for everyone.

## Defensive publication

This software is released openly as a **defensive publication**. By publishing the full implementation - the specification, the claims, the figures, and the working source code - the techniques it describes become public prior art. They remain free for everyone to use and cannot later be patented and locked away by anyone else.

That open release, not a patent, is what keeps this technology free.

## Public prior-art record

The artifacts listed below, together with their commit history in this repository, constitute the public record of the techniques described. Anyone performing a prior-art search on the subject matter should cite this repository (and the commit hashes of these files) as the canonical published source.

**Filed application package** (`Final Submission Version/`):

- `01_SPECIFICATION.docx` - detailed description of the system, 16 sections (I through XVI), 16 figures.
- `02_CLAIMS_1-15_v4.docx` - 19 claims with dependency chains.
- `02_SPECIFICATION_v4_ADDENDUM.docx` - claim-set addendum.
- `03_ABSTRACT.docx` - abstract of the technical disclosure.
- `drawings/FIG_01.docx` through `FIG_16.docx` - 16 architectural figures.
- `04_INFORMATION_DISCLOSURE_STATEMENT.docx` - prior-art references considered.

**Supporting evidence of reduction to practice** (`Final Submission Version/supporting/`):

- `IMPLEMENTATION_EVIDENCE_EXHIBIT.md` - cryptographic evidence that the techniques are not merely described but actually working.
- `CONSOLIDATED_PATENT_ANALYSIS.md` - 14-database prior-art search summary.
- `CLAIM_15_EVIDENCE_AND_ANALYSIS.docx` - proving-pool evidence.
- `PATENT_EVIDENCE_REPORT.md` / `.json` - machine-generated cryptographic test vectors.

**Working reference implementation** (`src/`):

The entire source tree under `src/` is an executable instantiation of the techniques in the specification, published under Apache License 2.0. In particular:

- `src/l2/` - the Leviathan partitioned multi-leader sequencer network, write-ahead log, quorum protocol, gossip replication, recursive batch and chain proofs, accumulator trees, and proving pool.
- `src/engine/`, `src/wallets/`, `src/credentials/` - proof-gated wallets, in-circuit state transitions, and credential issuance / verification.
- `src/eligibility/`, `src/access-control/`, `src/prescription/`, `src/fulfillment/` - the in-circuit claim-adjudication flow.
- `src/onboarding/` - the three-party enrollment ceremony.
- `src/security/`, `src/messaging/`, `src/audit/` - device-side cryptography, encrypted messaging, and the Poseidon audit hash chain.

## Scope of the defensive publication

The following subject matter, as described and embodied in the artifacts above, is published as prior art for the purposes of 35 U.S.C. Sec. 102 and analogous foreign provisions:

- Zero-knowledge claim adjudication for prescription-drug and other healthcare benefits, where personally identifying information and protected health information remain on the participant's device and never reach the adjudicating network.
- Proof-gated wallets whose addresses are derived from hashed identity fields and a device-only enrollment key, with access demonstrated by zero-knowledge proof of preimage rather than by a private-key signature.
- Recursive composition of state-transition proofs into batch proofs and chain proofs in a manner that keeps recursion depth within practical limits for the Pickles / Kimchi proof system.
- In-circuit computation of patient pay and plan pay using accumulator-aware logic (out-of-pocket maximum, exhausted benefit, remaining deductible, copay) so the financial split is tamper-evident.
- Partitioned multi-leader sequencer networks with deterministic failover, heartbeat-based leader election, write-ahead logging with fsync, and N/2+1 Ed25519-signed quorum writes, used as a trust layer in place of a public L1 blockchain.
- Accumulator and message-store Merkle commitments at the capacities described (16M-leaf claim accumulator, 1M-leaf encrypted message store, etc.), indexed for efficient downstream query.
- Three-party enrollment ceremony in which an employer issues an opaque enrollment token, the member derives a wallet identifier on-device from the token plus a device-only enrollment key, and an insurer attestation authority registers the opaque wallet without ever learning the member's identity.

This list is illustrative, not exhaustive. Anything disclosed in the artifacts above is part of the public prior-art record as of the dates of their first public availability in this repository.

## The Apache 2.0 patent grant

The Apache License 2.0 (Section 3) contains a patent-license grant from each contributor. Because the author holds no patent on this work, that clause conveys no patent rights on the author's behalf. It is simply part of the standard, unmodified Apache 2.0 text and is left exactly as written. Contributors who add patented techniques to the work do, however, grant licenses under it.

## Trademarks

This file does not grant rights in the "zpk.care" name. Per Apache License 2.0 Section 6, the license does not grant permission to use the project's trade names, trademarks, or service marks, except as required for reasonable and customary attribution.

---

*This document is a plain statement of intent. It is not legal advice and does not create any legal obligation on the author beyond what is already expressly stated in [LICENSE](LICENSE) and [NOTICE](NOTICE).*
