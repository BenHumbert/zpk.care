# Risk log

Opened 2026-10-16. Workflow diagram with both compliance gates marked in place: https://claude.ai/artifact/GWKGdPQXpYkUpTUAPCCQPi

One entry per risk that could stop the product working, expose PHI or PII, or block a release. Technical defects live in `docs/AUDIT.md` as findings `A-n`; this log carries the ones that need a decision, a budget or an external party, and it references rather than repeats them.

**Status values.** `open` needs a decision or work. `mitigated` has a remedy in the plan with a phase assigned. `accepted` is a known cost someone chose. `closed` is done and verified.

**Severity.** `blocking` stops a release. `high` damages the core promise or the money. `medium` needs handling before scale. `low` worth fixing.

---

## Compliance

### CMP-1 — A zero-knowledge proof cannot satisfy a signature requirement on a regulated record

| | |
|---|---|
| **Severity** | high, deferred with controlled substances |
| **Status** | mitigated by design, not yet built |
| **Applies to** | controlled-substance prescribing only. Not release one |

DEA EPCS specifies FIPS-approved cryptography for the signing and token side. Poseidon and the Pickles proof system are not FIPS-validated and will not become so. Being cryptographically stronger does not satisfy a rule that names mechanisms rather than properties.

Three distinct reasons, because only one of them is bureaucratic:

1. **FIPS validation is a process, not a judgment.** It certifies a named implementation, tested by an accredited lab, with a certificate number. The auditor is not asked to assess cryptography; they are asked to confirm a certificate exists. A proof system has no certificate number to show.
2. **The rule predates the technology.** The EPCS rule dates from 2010, before practical general-purpose proof systems existed in deployable form. Nobody rejected zero-knowledge proofs; nobody contemplated them.
3. **A signature and a proof answer different questions, and the regulator needs the signature's question.** A signature says a specific named person holding a specific key asserted this specific record. A proof of knowledge says somebody holding a satisfying witness produced this. For a prescription that may become evidence in a diversion investigation, the DEA needs attributability to a licensed human with a registration number. This part is not absurd and will not be amended away.

**Remedy.** Dual layer. Put a FIPS-approved signature on the regulated artifact, binding the licensed prescriber's legal identity to the prescription record. Let the zero-knowledge layer do the adjudication beside it. The NFC attestation code already uses Ed25519 through Node's crypto, which is the right primitive and is covered by FIPS 186-5. Never plan on a proof discharging a signature obligation.

**Note on scope, because it is easy to overstate.** This constrains the *prescriber* side, where attribution is the point of licensure and was never meant to be private. It does not touch patient privacy. See CMP-3.

### CMP-2 — Controlled-substance prescriptions must carry the patient's name and address

| | |
|---|---|
| **Severity** | high, deferred with controlled substances |
| **Status** | mitigated by design, not yet built |
| **Applies to** | controlled-substance prescribing only. Not release one |

Federal rules require a controlled-substance prescription to contain the patient's full name and address, along with directions for use, drug strength and dosage form, and the prescriber's address. `PrescriptionData` carries none of those: it has a drug hash, two wallet IDs, dates, quantity and refills. The architecture deliberately never transmits patient identity, so the content requirement and the privacy design collide head-on.

**Remedy (owner decision 2026-10-16, deferred to a later build).** The member's app generates a **QR code at the counter** which the pharmacy scans to obtain the required elements. Every pharmacy already scans barcodes all day, so this needs no new hardware, and the consent is visible: the member physically presents the code. The disclosed data stays in that pharmacy's own records as a covered entity already holding such data, and the network never sees it. Rule I2 therefore holds for the network, with one explicit consented carve-out, to one pharmacy, for one script.

**The requirement that makes it safe: the QR must not carry the name and address.** A QR code is passive data on a lit screen. Anyone who photographs it from across the counter has whatever it contains. So the code carries a **single-use, short-expiry nonce bound to that prescription**, and the identity elements travel with the script as a payload encrypted to the dispensing pharmacy's own key, openable only with that nonce. Two of two: a photographed code is useless without the pharmacy's private key, and the pharmacy's payload is useless without the member's nonce. It also works offline, which matters because the pharmacy must be able to dispense without connectivity.

Three details to get right when it is built: bind the nonce to the prescription identifier so one script's code cannot disclose identity for another; expire and single-use it so a photograph is worthless after collection; and provide a fallback for a dead phone, where the member presents physical identification and the pharmacy records it by hand, which is what happens today anyway.

**A side benefit worth noting.** This strengthens pickup identity generally, not only the controlled carve-out. A card is something you have. An app-generated code behind a biometric unlock is something you have plus something you are, which answers the stolen-card problem and gives the representative mechanism, domain tag 3, a cleaner path for caregiver collection than sharing a card.

**Does not arise on the adjudication side**, because the pharmacy already holds the patient's details from the script that reached it through its normal channel. This is one reason release one is scoped to adjudication.

### CMP-3 — Compliance is widely assumed to defeat the privacy model, and it does not

| | |
|---|---|
| **Severity** | medium, strategic |
| **Status** | open, worth settling before any customer conversation |

The concern is reasonable and the conclusion is wrong, which makes it a risk in its own right: believing compliance is fatal to the design would drive bad scoping.

What compliance actually costs:

| Requirement | Falls on | Privacy cost |
|---|---|---|
| Prescriber attribution, FIPS signature | the prescriber | none. Prescribers are licensed professionals with public registration numbers. Attributability is the point of licensure, not a privacy loss |
| Patient name and address on a controlled script | the member, to one pharmacy, with consent | narrow. That pharmacy already holds this data from its normal channel |
| Certification audit, identity proofing, two-person access control | the operator | none. These are process obligations |

What it does **not** cost: the network still sees no PHI, there is still no central database to breach, and no party can still link employee to wallet to medication history. The core promise survives intact. The prescriber and the patient have opposite requirements, and recognising that is the whole resolution: the prescriber must be attributable, the patient must not be.

### CMP-4 — EPCS certification mechanics and scope boundary unresolved

| | |
|---|---|
| **Severity** | medium, deferred |
| **Status** | open, needs a regulatory attorney |

Certification is required before the software processes its first controlled-substance prescription, and again whenever controlled-substance functionality changes or every two years. With the signing path due to be rewritten three times, certifying early means paying twice. Whether an adjudicate-and-route service counts as the prescribing application, the pharmacy application or an intermediary turns on definitions that need a lawyer, not an engineering reading. Also unresolved: identity proofing at the required NIST level through an approved credential service provider, and two-person authorization for granting signing privileges, neither of which exists today.

**Remedy.** Controlled substances out of release one. Keep the signing path certification-ready, which the FIDO2 decision already does at no extra cost. Revisit after phase E, when the architecture stops moving.

---

## Product

### PRD-1 — A lost phone permanently destroys the wallet, the claims history and the accumulator

| | |
|---|---|
| **Severity** | high. Re-rated from the audit's medium, which judged it as dead code rather than as a benefit-entitlement failure |
| **Status** | open. Design agreed 2026-10-16, card writing moves into phase A |

There is no recovery path today. The inputs work and the proof exists; every piece of plumbing between them is broken or uncalled.

| Piece | State |
|---|---|
| `reconstructAccumulator`, the source for carrying totals across | works, verified live |
| `WalletMigrationProgram`, proves identity continuity | correct, never compiled at runtime |
| `WalletMigrationService` | no runtime caller |
| `exportRecoveryCard` | **never called, so no card is ever written** |
| Browser backup tab | encrypts the literal `server-managed`, so the artifact is worthless |
| Browser restore | PBKDF2 against the server's scrypt, incompatible regardless |
| `EnrollmentService.processMigration` | reads a field absent from `TokenRecord`; would throw |

**The harm, in the plan's own numbers.** With a 500 dollar deductible and an 8,000 dollar out-of-pocket maximum, a member whose accumulator does not carry over pays the deductible a second time and loses their out-of-pocket progress. A dropped phone becomes a 500 dollar charge plus the rest of the year's exposure. Accumulators are contractual, so this produces a regulatory complaint rather than a support ticket.

**Design (owner, 2026-10-16): one card written at enrollment, two functions, different protection.** The card is written during the enrollment tap, which is the only clean moment, because that is when the key is generated and in memory. This is why it belongs in phase A and not phase C: a card cannot be issued retroactively for a key that is already gone.

| Contents | Protection | Purpose |
|---|---|---|
| One **share** of the enrollment key, and nothing else | PIN typed on the phone, plus an online release of the second share | Restores the wallet onto a new phone. This is `recovery-card.ts`, built but unwired |

**Revised 2026-10-16: the card carries no public attestation.** Adjudicating at prescribing makes it redundant. The pharmacy already holds the script with its price and a proof that the price is right, so it has no coverage question left to ask at the counter. The attestation existed for the older model where coverage was checked on arrival.

Removing it is a security gain, not just a simplification: **a found card now reveals nothing at all, not even a wallet ID.** That matters because wallet IDs are the lookup key for claims history through endpoints that stay open until phase D, so a static readable attestation on a physical object was a link from a dropped card to a queryable medication history.

The attestation mechanism itself is not deleted. It moves from the card to the **phone**, generated on demand, short-expiry and biometric-gated, which is strictly stronger than a static long-lived one on a passive tag: it can be revoked in real time and it expires on its own.

**The trap to avoid: the card must not be a bearer instrument,** for medication or for the wallet. If the card alone dispenses, a stolen card dispenses, which is diversion for controlled substances and fraud for specialty drugs. If the card alone restores the wallet, a stolen card is an account takeover. So access is tiered:

| Situation | Presented | Allowed |
|---|---|---|
| Normal | Phone, biometric, QR | Everything: any medication, finalize settlement, identity disclosure for a controlled script |
| Emergency, no phone | Nothing cryptographic | Non-controlled only, dispensing against the already-priced script. **The pharmacy checks photo identification against the name it already holds from the script**, which is what pharmacies do today. Settlement finalizes on the pharmacy's attestation instead of the member's. The card is not needed for this and no longer helps with it |
| Recovery | Card plus PIN on a new phone | Restores the wallet and carries the accumulator |

The emergency path needs no new cryptography. The pharmacy already has the patient's name from the script that arrived through its normal channel, so checking photo identification against it is the control pharmacies already apply every day. A stolen card with no matching identification gets nothing.

**Why the split share matters, and why it is affordable here.** A passive card holding ciphertext with its salt and initialization vector beside it permits an **offline** brute force of a short PIN, the same flaw as the provider badge. The asymmetry that solves it: the point-of-sale path must work offline, but **recovery can require connectivity**, because the member is setting up a new phone when they use it. So the card carries one share and the second is released online, rate-limited. A stolen card alone yields nothing to unlimited offline compute.

**Two further requirements.** Issue **two cards at enrollment**, one kept at home, because losing the card and the phone together is otherwise unrecoverable; this matches the two-authenticator rule for providers. And the card must be **revocable**, because a member who rotates their enrollment key after a suspected compromise would otherwise leave an old card as a live path back into the wallet. The attestation format already carries a nonce intended as the revocation handle.

### PRD-2 — Emergency and inpatient care is out of scope, and the data would not answer the question anyway

| | |
|---|---|
| **Severity** | low as a risk, high as a scoping clarification |
| **Status** | closed by decision, 2026-10-16 |

The question was whether an emergency department should be able to pull minimal data to stabilise a patient. The answer is no, for two independent reasons, and both are worth recording so that nobody promises it later.

**It is the wrong benefit.** Emergency, inpatient and facility care adjudicate under the **medical** benefit with the health plan. Pharmacy benefit covers outpatient retail and mail. An emergency department never queries a PBM for coverage, and drugs given during an admission are billed inside the facility charge. One nuance in the other direction: a **discharge prescription is pharmacy benefit**, so the output of an emergency visit is in scope even though the visit is not.

**The data does not contain the answer.** The system records dispensed medications: drug identity, quantity, dates, costs, prescriber and pharmacy. There is **no allergy data anywhere** in the model, and no field for it in any of the six domain trees. Medication history and an allergy list are different artifacts. What the accumulator could support is "what is this patient currently taking", which permits interaction and duplicate-therapy inference, and that is already what the drug-utilisation-review surface does. It cannot support "what is this patient allergic to", and conflating the two would mean promising a clinical safety feature the data cannot back.

**Future product, not a missing feature.** A medication-history service for treatment purposes is a real and valuable thing, and this system would hold an unusually complete record for it. It is also a separate product with its own consent model and its own disclosure surface under HIPAA treatment-purpose rules. Out of scope for release one; do not let it leak into the architecture as an assumed capability.

---

## Technical

Full detail in `docs/AUDIT.md`. Listed here because each needs a decision or carries release risk.

| ID | Risk | Severity | Status | Where |
|---|---|---|---|---|
| TEC-1 | Stored identity hashes are unsalted and reversible. Names and birth dates recovered from one file in 75 seconds | blocking | mitigated, phases B and C | A-1 |
| TEC-2 | A state change is accepted on Merkle arithmetic alone; no cryptographic verification before mutation | blocking | mitigated, phase A item A1, specified | A-3 |
| TEC-3 | Any wallet ID returns that member's full record with no credential | blocking | mitigated, phases C and D | A-2 |
| TEC-4 | Gossip replication non-functional. Live proof state exists on one process; the failover meant to prevent loss has never run outside tests | blocking | mitigated, A13 then phase E | A-8, C-3 |
| TEC-5 | Every clinical and financial rule is enforced only in TypeScript; the proofs attesting to them are discarded, so no relying party can verify an adjudication | high | mitigated, phase D | A-22 |
| TEC-6 | A duplicate fill charged a member and recorded no claim. Money moved with no ledger entry | high | mitigated, phase D | A-10 |
| TEC-7 | Ledger and engine accumulators disagree for half the test members | high | open, cause isolated for one of two | A-11 |
| TEC-8 | One shared secret is the sequencer bearer, every node's bearer and the insurer's signing seed, and it ships to the member device | high | mitigated, phase A item A9 | A-14 |
| TEC-9 | The read-then-write accumulator window is now days or weeks, because adjudication happens at prescribing. Normal path for anyone on several medications | high | open, needs the reservation design | plan §7 |
| TEC-10 | Poseidon and Pickles are not FIPS-validated, which also limits any future federal or state programme that specifies approved cryptography, not only EPCS | medium | accepted, dual-layer remedy | CMP-1 |

---

## Open decisions blocking work

| ID | Decision | Blocks | Owner |
|---|---|---|---|
| DEC-1 | Is there live member data to preserve, or can production start from genesis? The migration must be designed before phase B deletes the stored preimages | phase B | owner |
| DEC-2 | Who operates the leviathan nodes? Three under one operator is durability, not trust | phase E quorum | owner, business decision |
| DEC-3 | Does the adjudication engine move out of the sequencer process? It is the largest refactor and what makes B1 and B2 real | phase B completion | owner |
| DEC-4 | Quote honoured as a ceiling, confirmed? Charge the lower of quoted and re-adjudicated, with a pharmacy decline when the price rose materially | phase B3 | owner |
| DEC-5 | Member app platform and keystore target | phase B1 | owner |
| DEC-6 | Per-provider authenticator budget and replacement workflow | phase B4 | owner |
| DEC-7 | Key management for attestation and quorum keys: KMS, HSM or operator-held | phases A9, E4, F5 | owner |
