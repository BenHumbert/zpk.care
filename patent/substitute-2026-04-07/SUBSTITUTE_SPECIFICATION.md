# UNITED STATES PATENT APPLICATION

## PROOF-GATED WALLET SYSTEM WITH IN-CIRCUIT HEALTHCARE CLAIM ADJUDICATION AND CONSENSUS-FREE SEQUENCER NETWORK

---

### CROSS-REFERENCE TO RELATED APPLICATIONS

[0001] Not Applicable.

---

### FIELD OF THE INVENTION

[0002] The present invention relates generally to proof-gated blockchain wallet systems and zero-knowledge proof circuits for healthcare data processing, and more particularly to systems and methods for deriving wallet identities without private keys, adjudicating pharmacy benefit claims as arithmetic constraints inside zero-knowledge circuits, and operating consensus-free distributed sequencer networks using cryptographic proof validity as the sole trust mechanism, wherein all member protected health information remains exclusively on the member's own device, prescribers and pharmacies interact with members only through opaque cryptographic wallet identifiers, and only algebraic hash commitments are stored on the network.

---

### BACKGROUND OF THE INVENTION

[0003] Healthcare claim adjudication — the process by which a pharmacy benefit manager (PBM) determines how much a patient pays (copay, coinsurance, deductible) and how much the insurer pays for a prescription drug — is among the most data-intensive operations in the United States healthcare system. Approximately 6.7 billion prescription claims are adjudicated annually, each requiring real-time access to formulary data, benefit plan parameters, patient accumulator state (deductible paid, out-of-pocket maximum spent, annual benefit used), and drug identity information.

[0004] Current adjudication systems suffer from several fundamental limitations.

[0005] First, they require centralized storage of protected health information (PHI). Insurers, PBMs, and clearinghouses maintain databases containing patient names, dates of birth, Social Security numbers, medication histories, and financial data. The 2024 breach of Change Healthcare exposed approximately 100 million patient records, demonstrating the catastrophic risk inherent in centralized PHI storage.

[0006] Second, existing blockchain-based healthcare systems, while offering tamper evidence and decentralization, universally execute business logic in plaintext smart contracts while using zero-knowledge proofs (ZKPs) exclusively for identity verification or data privacy. No existing system encodes healthcare adjudication logic — formulary lookup, copay computation, deductible accumulator state transitions — as arithmetic constraints inside a zero-knowledge circuit. A comprehensive search across 14 databases (USPTO, EPO Espacenet, WIPO PatentScope, arXiv, IEEE Xplore, ACM Digital Library, and others), examining over 150 references from 2015 through 2026, confirms this gap.

[0007] Third, all existing blockchain wallet architectures require private key material in some form. Even systems marketed as "keyless" (including Sui zkLogin, Aptos Keyless, and MIT CSAIL's 2025 "Keyless Blockchain Accounts") require ephemeral signing keys generated per session. No production system eliminates private keys entirely in favor of zero-knowledge proof verification as the sole access mechanism.

[0008] Fourth, existing healthcare enrollment protocols require the insurer to possess member PHI. The standard EDI 834 enrollment transaction transmits full member identity (name, date of birth, Social Security number, dependents) from employer to insurer. No existing system allows an insurer to enroll and manage members using only opaque cryptographic identifiers.

[0009] What is needed is a system that performs healthcare claim adjudication entirely within zero-knowledge circuits, ensures that member PHI never leaves the member's own device such that no other party — including prescribers, pharmacies, insurers, and network operators — can determine a member's real-world identity, operates distributed sequencer networks without consensus mechanisms, and provides offline-verifiable healthcare credentials — all while maintaining HIPAA compliance through cryptographic privacy guarantees rather than access control policies.

---

### SUMMARY OF THE INVENTION

[0010] In accordance with one aspect of the present invention, a method for adjudicating a healthcare claim using a zero-knowledge circuit is provided. The method includes encoding as arithmetic constraints within the circuit a formulary eligibility lookup by drug identity code against a benefit plan, a cost-share computation producing patient copay amounts considering deductible status, out-of-pocket maximum, and annual benefit maximum, and a deductible accumulator state transition updating member running totals as in-circuit state variables. The method further includes generating a zero-knowledge proof establishing adjudication correctness without revealing protected health information, and committing the resulting proof and updated accumulator root to a member wallet state.

[0011] In accordance with another aspect of the present invention, a system for organizing healthcare data as a multi-domain Merkle forest is provided. The system includes six domain-specific Merkle trees using a ZK-friendly algebraic hash function, a composite forest root computed as the hash of all six tree roots, and a credential whose cryptographic payload is the forest root, producing a provably distinct credential state upon any domain change.

[0012] In accordance with another aspect, a method for establishing and accessing a blockchain wallet without a private key is provided. The method includes deriving a wallet identifier as a hash of identity fields plus a user-generated enrollment key, registering the identifier on a distributed sequencer network as the sole wallet address with no associated signing key, and gating all state transitions exclusively through zero-knowledge proof verification.

[0013] In accordance with another aspect, a partitioned sequencer network, a gossip-based replication protocol, a multi-leader failover architecture, a portable zero-knowledge credential format with offline verification capability, and a quorum durability protocol ensuring zero data loss through write-ahead logging and Ed25519-signed multi-node acknowledgment before client confirmation are provided. Additionally, a parallel zero-knowledge proving architecture is provided, wherein the sequencer distributes proof generation across isolated worker processes via a split-phase batch construction protocol, reclaiming monotonically-growing WebAssembly heap memory through periodic worker process recycling.

---

### BRIEF DESCRIPTION OF THE DRAWINGS

[0014] FIG. 1 is a system architecture diagram illustrating the overall structure of the zero-knowledge healthcare claim adjudication system in accordance with an embodiment of the present invention.

[0015] FIG. 2 is a block diagram illustrating the three-level recursive proof chain comprising a state transition proof, a batch proof, and a chain proof.

[0016] FIG. 3 is a data structure diagram illustrating the six-domain Merkle forest embedded within a healthcare credential.

[0017] FIG. 4 is a flowchart illustrating the three-party enrollment ceremony among an employer system, a member device, and an insurer system.

[0018] FIG. 5 is a block diagram illustrating the proof-gated wallet derivation process using Poseidon hash with domain tags.

[0019] FIG. 6 is a flowchart illustrating the in-circuit healthcare claim adjudication method including formulary lookup, copay computation, and accumulator state transition.

[0020] FIG. 7 is a diagram illustrating the partitioned sequencer network with deterministic wallet-to-partition routing.

[0021] FIGS. 8A and 8B are diagrams illustrating the gossip-based replication protocol with twelve typed event messages. FIG. 8A illustrates the gossip message envelope structure, the twelve typed event messages organized in four functional groups, and the epidemic spread mechanism. FIG. 8B illustrates the gossip message deduplication using a bounded set with half-eviction, broadcast versus directed messaging modes, and the trust model distinguishing durability acknowledgments from validity determination.

[0022] FIG. 9 is a block diagram illustrating the claim accumulator tree with four parallel index structures.

[0023] FIGS. 10A and 10B are diagrams illustrating the Poseidon hash audit chain with selective event disclosure. FIG. 10A illustrates the hash chain linking mechanism and ten-field event commitment structure. FIG. 10B illustrates the audit chain binding to global state via slot 8 of the ten-field GlobalState commitment and the six-check audit verification suite.

[0024] FIG. 11 is a block diagram illustrating the encrypted message store with Poseidon-committed Merkle leaves and off-tree ciphertext storage.

[0025] FIGS. 12A and 12B are diagrams illustrating the multi-leader heartbeat failover protocol with deterministic priority chain. FIG. 12A illustrates the heartbeat protocol under normal operation, including the partition topology and heartbeat broadcast mechanism. FIG. 12B illustrates leader failure detection, deterministic failover promotion, split-brain resolution, and client-side transparent failover with automatic partition rediscovery.

[0026] FIG. 13 is a diagram illustrating the epoch-based temporal accumulator with monthly rotation and cross-epoch aggregation.

[0027] FIGS. 14A and 14B are block diagrams illustrating the portable zero-knowledge credential format and offline verification flow. FIG. 14A illustrates the credential architecture, including the full zero-knowledge proof credential format and the compact NFC attestation format. FIG. 14B illustrates the NFC tag NDEF encoding for NTAG216, offline verification flows at point-of-care, and delegation credential time-to-live tiers.

[0028] FIGS. 15A and 15B are diagrams illustrating the write-ahead log and quorum durability protocol. FIG. 15A illustrates the per-partition log structure, NDJSON entry format, commit marker lifecycle, and log compaction via atomic write strategy. FIG. 15B illustrates the five-step quorum write protocol with Ed25519-signed vote collection, quorum certificate assembly, state certificate generation at batch boundaries, and crash recovery by replaying uncommitted log entries.

[0029] FIGS. 16A and 16B are block diagrams illustrating the proving pool architecture within a Leviathan Sequencer. FIG. 16A illustrates the pool architecture overview, including the worker process pool with isolated WASM contexts, the IPC message protocol with six message types, and the FIFO job dispatch mechanism. FIG. 16B illustrates the worker lifecycle state machine, the split-phase batch construction integration with the sequencer, the WebAssembly heap reclamation through periodic worker recycling, and the crash detection with automatic recovery mechanism.

---

### DETAILED DESCRIPTION OF PREFERRED EMBODIMENTS

[0030] The following detailed description refers to the accompanying drawings. The same reference numerals may be used in different drawings to identify the same or similar elements. The detailed description does not limit the invention. Instead, the scope of the invention is defined by the appended claims.

[0031] Throughout this specification, the term "Poseidon hash" refers to the algebraic hash function defined by Grassi et al. (USENIX Security, 2021), operating natively over prime fields and designed for efficient verification inside zero-knowledge circuits. In the preferred embodiment, Poseidon operates over the Pasta curve finite field with modulus p = 28948022309329048855892746252171976963363056481941560715954676764349967630337. The term "ZK circuit" or "zero-knowledge circuit" refers to an arithmetic circuit whose satisfying assignment constitutes a witness for a zero-knowledge proof. The term "in-circuit" means that a computation is encoded as arithmetic constraints verified by the proving system, not performed as a post-hoc check outside the proof.

#### I. System Architecture Overview

[0032] Referring now to FIG. 1, the zero-knowledge healthcare claim adjudication system 100 comprises four principal layers.

[0033] An entity node layer 110 includes a plurality of entity nodes, each operating on a user device. Entity nodes include member nodes 112, prescriber nodes 114, pharmacy nodes 116, and insurer nodes 118. Member protected health information (PHI) — including patient name, date of birth, cardholder identifier, and all other personally identifiable information (PII) — resides exclusively on member nodes 112 and is never transmitted to any other node or to the network in any form, whether plaintext or encrypted. Prescriber nodes 114 and pharmacy nodes 116 hold only their own professional credentials (such as NPI numbers) locally and never receive or store member PHI. Insurer nodes 118 hold no PHI of any kind. Prescriber nodes 114 and pharmacy nodes 116 interact with member data exclusively through opaque wallet identifiers (Poseidon hashes) that are computationally irreversible — no node other than the member's own device can determine the member's name, date of birth, or any identifying information from a wallet identifier. Each entity node generates zero-knowledge proofs attesting to the validity of healthcare operations without revealing the underlying data.

[0034] The information visible to each entity type is strictly partitioned. A prescriber node 114 can query the sequencer network for a member's prescription history using the member's opaque wallet identifier, receiving drug names, NDC codes, dates of service, and cost amounts — but never the member's name, date of birth, cardholder identifier, or any field from which member identity could be determined. A pharmacy node 116 can similarly query a member's full cross-pharmacy drug history for drug utilization review (drug interaction checking) using only the opaque wallet identifier — again receiving drug-level metadata but never member identity. An insurer node 118 can query aggregate claims data, generate reports, and perform audits — all keyed by opaque wallet identifiers. At no point in any query path does a member's name or personally identifiable information leave the member's device. The wallet identifier, being a Poseidon hash of multiple identity fields plus a secret enrollment key, cannot be inverted to recover any constituent field.

[0035] A zero-knowledge proof layer 120 includes a plurality of ZK programs (also referred to herein as "ZkPrograms") that define arithmetic circuits for specific healthcare operations. In the preferred embodiment, fourteen ZkPrograms are provided: a proof gate program 121 for wallet ownership verification, a state transition program 122 for wallet state changes, a credential program 123 for credential issuance and verification, an eligibility program 124, an in-network verification program 125, a primary care provider verification program 126, an access control program 127, a prescription program 128, a fulfillment program 129 for basic claim adjudication, an accumulator fulfillment program 130 for accumulator-aware claim adjudication, a messaging program 131, a wallet migration program 132, a batch program 133 for proof aggregation, and a chain program 134 for recursive chain state certification.

[0036] A sequencer network layer 140 (referred to herein as a "Leviathan network") includes a plurality of sequencer nodes 142 (referred to herein as "Leviathans"), each owning an exclusive partition of the wallet address space. The sequencer network layer 140 operates as an L2-only settlement layer without L1 blockchain settlement. Trust derives exclusively from the cryptographic validity of zero-knowledge proofs, not from consensus mechanisms, proof of work, proof of stake, or Byzantine fault tolerance protocols.

[0037] A data layer 150 includes proof-gated wallets 152, multi-domain Merkle forests 154, a claim accumulator tree 156, a message store 158, and a Poseidon hash audit chain 160. All data stored in the data layer 150 consists of Poseidon hash commitments. Privacy derives from the computational irreversibility of the Poseidon hash function, not from access control policies.

#### II. Proof-Gated Wallet Without Private Key (FIG. 5)

[0038] Referring now to FIG. 5, the system provides a method for establishing and accessing a blockchain wallet without generating, storing, or using a private key at any point during the wallet lifecycle.

[0039] A wallet identifier is derived as:

    walletId = Poseidon.hash([domainTag, hashedField_0, hashedField_1, ..., hashedField_n, hash(enrollmentKey)])

[0040] wherein `domainTag` is an integer constant distinguishing entity types (0 for member, 1 for prescriber, 2 for pharmacy, 3 for representative), `hashedField_0` through `hashedField_n` are Poseidon hashes of identity fields computed locally on the user's device, and `enrollmentKey` is a 256-bit cryptographically random value generated on the user's device from the operating system entropy pool and never transmitted to any other party. The enrollment key is encoded as a base64url string for storage on the device, and is validated for format compliance by verifying the presence of at least three of four character classes selected from uppercase letters, lowercase letters, digits, and symbols.

[0041] In the preferred embodiment for a member entity, the wallet identifier is computed as:

    walletId = Poseidon.hash([Field(0), hashString(cardholderId), hashDate(dateOfBirth), hashString(firstName), hashString(lastName), hashString(enrollmentKey)])

[0042] wherein `hashString()` applies Poseidon hash to the UTF-8 byte representation of the input string and `hashDate()` applies Poseidon hash to the numeric date representation, preventing brute-force recovery of the date of birth from the wallet identifier (approximately 36,500 possible date values in a typical range).

[0043] The wallet identifier IS the wallet address. No private key, mnemonic phrase, seed, or signing key exists or is ever generated. The wallet identifier is registered directly in a Merkle tree maintained by the sequencer network.

[0044] All state transitions on the wallet are gated exclusively through zero-knowledge proof verification. A proof gate program 121 provides four verification methods, one per entity type. Each method accepts the wallet identifier as a public input and the identity preimage fields as private inputs, then verifies in-circuit that the Poseidon hash of the private inputs matches the public wallet identifier. A valid proof constitutes the sole authorization mechanism for wallet operations.

[0045] In the state transition program 122, wallet verification is inlined rather than composed recursively. The program computes all entity-type hash variants (member: 6-field, prescriber: 4-field, pharmacy: 4-field Poseidon hashes) within the circuit and selects the correct variant using a circuit-compatible conditional selector based on the domain tag. This design deliberately eliminates one recursion level from the proof chain, working around a limitation in the Pickles recursive SNARK system where `maxProofsVerified=2` fails at recursion depth greater than or equal to two.

#### III. Multi-Domain Merkle Forest (FIG. 3)

[0046] Referring now to FIG. 3, each healthcare credential in the system embeds a multi-domain Merkle forest 154 comprising six domain-specific Merkle trees, each using Poseidon as the internal hash function and having a height of 8 (supporting 128 leaves per tree).

[0047] The six domains are: MEMBER (index 0), containing member identity commitments; PRESCRIBER (index 1), containing prescriber credential commitments; PHARMACY (index 2), containing pharmacy credential commitments; MEDICATION (index 3), containing prescription and formulary data commitments; ACCESS_CONTROL (index 4), containing eligibility data, prior authorization data, and accumulator state; and TRANSACTION (index 5), containing fulfillment settlement commitments.

[0048] A composite forest root is computed as:

    ForestRoot = Poseidon.hash([root_MEMBER, root_PRESCRIBER, root_PHARMACY, root_MEDICATION, root_ACCESS_CONTROL, root_TRANSACTION])

[0049] This forest root is the sole cryptographic payload of a credential data structure, which is a seven-field Poseidon-committed structure comprising credential type, forest root, issuer wallet identifier, subject wallet identifier, issue date, expiration date, and revocation flag. The credential commitment is:

    credentialCommitment = Poseidon.hash([credentialType, forestRoot, issuerWalletId, subjectWalletId, issuedAt, expiresAt, revoked])

[0050] Any modification to any leaf in any domain tree produces a different forest root, which in turn produces a different credential commitment, providing cryptographic tamper evidence across all six healthcare data domains.

[0051] Selective domain disclosure is achieved through Merkle witnesses. A Merkle witness for a leaf in one domain tree proves the leaf's inclusion without revealing the contents of any other domain tree, enabling privacy-preserving point-of-care verification.

#### IV. Three-Party Enrollment Ceremony (FIG. 4)

[0052] Referring now to FIG. 4, the system provides a privacy-preserving enrollment protocol involving three parties, wherein no single party holds complete identity information.

[0053] In a first step (step 410), an employer system generates a cryptographic enrollment token. The token is an eight-field Poseidon-committed structure containing hashed employee identifier, hashed family identifier, hashed group identifier, hashed plan identifier, and additional administrative fields. The token contains zero protected health information — only Poseidon hash commitments.

[0054] In a second step (step 420), a member device receives the enrollment token and performs the following operations entirely on-device: hashing PHI fields locally using Poseidon hash, computing the wallet identifier as described in Section II, and generating a zero-knowledge proof of correct wallet derivation without transmitting raw PHI.

[0055] In a third step (step 430), an insurer system receives and registers only the wallet identifier and the zero-knowledge proof. The insurer system never receives, processes, or stores any member PHI — no name, no date of birth, no Social Security number, no cardholder identifier in any form. The insurer system registers the wallet identifier in a wallet registry Merkle tree and sets the wallet lifecycle state to REGISTERED. For the entire lifetime of the member's enrollment, the insurer identifies the member solely by this opaque wallet identifier.

[0056] The information separation is enforced cryptographically: the employer holds only the enrollment token; the member holds the identity preimage and enrollment key on the member's own device; the insurer holds only the opaque wallet identifier (a Poseidon hash); prescribers and pharmacies likewise interact with the member exclusively through this opaque identifier. No party other than the member can determine the member's real-world identity from the wallet identifier, as the Poseidon hash function is computationally irreversible and the enrollment key (mixed into the hash) is known only to the member.

#### V. In-Circuit Healthcare Claim Adjudication (FIG. 6)

[0057] Referring now to FIG. 6, the system provides a method for performing healthcare claim adjudication entirely within zero-knowledge circuits, wherein the ZK proof IS the adjudication — no separate insurer processing step is required.

[0058] The fulfillment program 129 and accumulator fulfillment program 130 encode the following healthcare business logic as arithmetic constraints inside ZK circuits:

[0059] **Step 610 — Credential and Forest Root Verification.** The circuit verifies that the prescription credential is of type PRESCRIPTION, is not revoked, and that the forest root computed from the six domain tree roots matches the forest root stored in the credential.

[0060] **Step 620 — Pharmacy Wallet Identity Binding.** The circuit recomputes the pharmacy wallet identifier from its preimage fields (domain tag, qualifier, service provider identifier hash, enrollment key hash) and verifies it matches the pharmacy wallet identifier in the fulfillment data. This prevents unauthorized pharmacy substitution.

[0061] **Step 630 — Prescription Data Verification.** The circuit verifies that the prescription data commitment exists in the MEDICATION domain tree of the credential's Merkle forest using a Merkle witness.

[0062] **Step 640 — Formulary Eligibility Lookup.** The circuit verifies that the formulary entry exists in the formulary registry Merkle tree using a Merkle witness, and that the NDC (National Drug Code) hash in the formulary entry matches the NDC hash in the fulfillment data. This is an in-circuit formulary lookup by drug identity code.

[0063] **Step 650 — Quantity Verification.** The circuit verifies that the quantity dispensed does not exceed the formulary maximum per fill and does not exceed the quantity prescribed (a fraud, waste, and abuse guard).

[0064] **Step 660 — Cost-Share Computation.** In the basic fulfillment program 129, the circuit computes:

    total = ingredientCostCents + dispensingFeeCents
    patientPay = min(total, formulary.copayAmountCents)
    planPay = total - patientPay

[0065] In the accumulator fulfillment program 130, a four-priority cascade is computed entirely in-circuit using conditional selectors:

[0066] Priority 1 (highest — regulatory requirement): If the member's out-of-pocket maximum (OOPM) has been met, the patient pays zero and the plan pays the total.

[0067] Priority 2: If the annual benefit maximum has been exhausted, the patient pays the total.

[0068] Priority 3: If the member is in the deductible phase (deductible not yet met), the patient pays the minimum of the total and the remaining deductible, plus a copay on the post-deductible remainder.

[0069] Priority 4: Normal copay — the patient pays the minimum of the total and the formulary copay amount.

[0070] All four branches are encoded as in-circuit conditional selections, not as external if/else logic. The proving system enforces that exactly one branch is selected and the arithmetic is correct.

[0071] **Step 670 — Deductible Credit Computation.** The circuit computes a deductible credit amount as the minimum of the deductible payment and the patient payment (after OOPM capping), enabling exact reversal tracking.

[0072] **Step 680 — Accumulator State Transition.** The circuit updates the member's accumulator state in-circuit:

    newDeductiblePaid = currentDeductiblePaid + deductibleCredit
    newOopPaid = currentOopPaid + patientPay
    newBenefitUsed = currentBenefitUsed + planPay

[0073] The new accumulator commitment is:

    newAccumulatorCommitment = Poseidon.hash([planYear, deductibleAmount, newDeductiblePaid, oopMax, newOopPaid, benefitMax, newBenefitUsed])

[0074] **Step 690 — Settlement Commitment.** The circuit computes a settlement commitment. In the basic fulfillment program 129, the settlement commitment is a three-field hash:

    settlementCommitment = Poseidon.hash([fulfillmentCommitment, patientPay, planPay])

[0075] In the accumulator fulfillment program 130, the settlement commitment is a four-field hash that additionally includes the deductible credit for exact reversal tracking:

    settlementCommitment = Poseidon.hash([fulfillmentCommitment, patientPay, planPay, deductibleCredit])

[0076] The settlement commitment is stored in the TRANSACTION domain tree of the credential's Merkle forest.

[0077] **Step 695 — Proof Output.** The resulting zero-knowledge proof has a public output of 8 fields (basic) or 10 fields (accumulator-aware), including the prescription hash, old and new forest roots, entry commitment, patient pay, plan pay, operation type, and NDC hash. The NDC hash is exposed in the proof output to enable drug identity tracking without revealing the plaintext NDC code outside the circuit.

[0078] The financial balance constraint (ingredientCost + dispensingFee == patientPay + planPay) is enforced via field equality assertions inside the circuit. Any imbalance causes proof generation to fail.

#### VI. Recursive Proof Chain for Healthcare State (FIG. 2)

[0079] Referring now to FIG. 2, the system provides a three-level recursive proof hierarchy for certifying healthcare state.

[0080] **Level 0 — State Transition Proof.** The state transition program 122 produces a state transition proof per transaction. This is the base case with no recursion. Each proof carries a public output of five fields: wallet identifier, old registry root, new registry root, old lifecycle root, and new lifecycle root. Wallet verification is inlined (as described in Section II) to avoid adding a recursion level.

[0081] **Level 1 — Batch Proof.** The batch program 133 aggregates state transition proofs. A single-transition base case (`wrapSingle`) takes one state transition proof as a private input, calls an in-circuit verification method on the proof, and produces a batch output of six fields: old and new registry roots, old and new lifecycle roots, registration count, and transition count. A two-transition base case (`wrapPair`) takes two state transition proofs as private inputs, calls an in-circuit verification method on each proof, enforces root chaining between the two proofs (the new roots of the first proof must equal the old roots of the second proof), and produces the same six-field batch output. A recursive method (`mergeBatches`) takes two batch proofs as private inputs, calls an in-circuit verification method on each, enforces root chaining, and sums the counts. This binary tree structure supports batches of any size: two transitions are wrapped directly via `wrapPair`, odd-count batches use `wrapSingle` for the remaining transition, and `mergeBatches` combines batch proofs recursively to produce a single aggregated batch proof.

[0082] Both methods accept exactly two proofs (a uniform pair pattern), avoiding a bug in the Pickles recursive SNARK system (specifically in the `wrap_main.ml` module) where methods with heterogeneous proof counts crash at recursion depth two or greater.

[0083] **Level 2 — Chain Proof.** The chain program 134 certifies a ten-field global state commitment:

    globalStateRoot = Poseidon.hash([walletRegistryRoot, walletCount, adminPublicKeyHash, lifecycleRoot, benefitPlanRoot, credentialRegistryRoot, eligibilityVkHash, messagingRoot, auditChainHash, blockHeight])

[0084] A genesis method creates block 0 from the first batch proof. An advance method takes the previous chain proof and a new batch proof, verifies both in-circuit, enforces chain continuity (batch old roots must equal previous block's roots), increments block height, and accumulates wallet count.

[0085] The chain proof output exposes `registryRoot` and `lifecycleRoot` explicitly because Poseidon hashes are non-invertible inside a circuit, and the next block's batch proof must chain from these roots without requiring global state decomposition.

[0086] Each chain proof — approximately 22 kilobytes — encapsulates the entire chain history. A node holding only the latest chain proof can verify the complete contract-level state — wallet registry, lifecycle, benefit plans, credential registry, messaging configuration, and audit chain — without storing any transaction history. Append-only data stores such as the claim accumulator (Section VII) and message store (Section X) are committed as metadata fields in each batch record and attested by multi-node state certificates (Section XI-A) rather than included in the chain proof global state root, reflecting an intentional separation between the fixed-cardinality contract state (ten fields, proven in-circuit) and the unbounded append-only stores (millions of entries, attested by quorum).

#### VII. Claim Accumulator Tree (FIG. 9)

[0087] Referring now to FIG. 9, the system provides a claim accumulator tree 156 comprising a Merkle tree of depth 24 (supporting approximately 16.7 million leaves) for accumulating adjudicated pharmacy claims as zero-knowledge commitments.

[0088] Each leaf is a nine-field Poseidon hash:

    claimLeaf = Poseidon.hash([memberWalletId, ndcHash, pharmacyWalletId, prescriberWalletId, dateOfService, patientPayCents, planPayCents, operationType, deductibleCreditCents])

[0089] Four parallel index structures provide O(1) lookup by member wallet identifier, pharmacy wallet identifier, prescriber wallet identifier, and NDC drug code. Each index is implemented as a map from the key (as a string) to an array of leaf indices (as big integers).

[0090] The claim accumulator root is committed as a metadata field in each L2 batch record produced by the sequencer at batch-creation time, alongside the cryptographically certified batch proof. The batch proof itself — covering wallet registry root transitions, lifecycle root transitions, and transaction counts — is verified in-circuit by the ChainZkProgram via `BatchProof.verify()`. The claim accumulator root is not one of the fields inside the batch proof's public output; rather, it is stored in the same batch data structure as the proof, providing an associative binding: any node can verify that the batch proof is valid and can independently verify the claim accumulator root by recomputing it from the accumulated claim leaves. The state certificate mechanism (described in Section XI-A) provides an additional integrity guarantee: at each batch boundary, a majority of sequencer nodes sign a state digest that includes the claim accumulator root, the registry root, the lifecycle root, and the audit chain hash. This Ed25519-signed multi-node attestation ensures that no single node can unilaterally alter the claim accumulator root without detection by the quorum.

[0091] Merkle witnesses generated from the accumulator tree are circuit-compatible, enabling verification that a specific claim exists in the accumulator without revealing other claims.

#### VIII. Poseidon Hash Audit Chain (FIGS. 10A-10B)

[0092] Referring now to FIGS. 10A and 10B, the system provides a tamper-evident audit chain 160 for HIPAA compliance.

[0093] Each audit event commitment is a ten-field Poseidon hash:

    eventCommitment = Poseidon.hash([walletId, oldRegistryRoot, newRegistryRoot, oldLifecycleRoot, newLifecycleRoot, sequenceNumber, isRegistration, ndcHash, patientPayCents, planPayCents])

[0094] Chain hashes link events cryptographically:

    chainHash_n = Poseidon.hash([chainHash_{n-1}, eventCommitment_n])

[0095] starting from a genesis hash `Poseidon.hash([Field(0)])`. Any modification to any event breaks all subsequent chain hashes. The foregoing hash chain linking mechanism and event commitment structure are illustrated in FIG. 10A.

[0096] As described with reference to FIG. 10A, the hash chain structure inherently supports selective event disclosure for individual audit entries. To verify a single event at position n, an auditor need only be provided with the event commitment (eventCommitment_n), the chain hash value immediately preceding the event (chainHash_{n-1}), and the chain hash value immediately following the event (chainHash_n). The auditor verifies the event's inclusion by recomputing Poseidon.hash([chainHash_{n-1}, eventCommitment_n]) and confirming that the result equals chainHash_n. This verification requires no knowledge of any other event commitment or chain hash value in the chain, enabling privacy-preserving audit of individual events without exposing the full audit history.

[0097] Referring still to FIG. 10B, the current audit chain hash is committed as one of the ten fields in the global state root (slot 8: `auditChainHash`), binding the audit trail to all other healthcare state — wallet registry, lifecycle, benefit plan, credential registry, eligibility verification key hash, and messaging — in a single recursive zero-knowledge proof.

[0098] As further illustrated in FIG. 10B, a full audit suite provides six verification checks: chain integrity, financial balance (patient pay + plan pay equals ingredient cost + dispensing fee for every claim), duplicate detection (grouping by wallet identifier + NDC hash + date of service), sequence gap detection, orphaned receipt detection, and enrollment consistency.

#### IX. Partitioned Sequencer Network (FIG. 7)

[0099] Referring now to FIG. 7, the sequencer network layer 140 — referred to herein as the "zkTrident Network" or "Leviathan network" — partitions the wallet address space across N sequencer nodes using deterministic modular arithmetic:

    partitionIndex = |walletId| mod partitionCount

[0100] wherein `walletId` is the decimal representation of the Poseidon hash (a big integer) and `partitionCount` is the total number of sequencer partitions. Because Poseidon hashes are pseudorandom over the finite field, this produces approximately uniform partition distribution.

[0101] Each sequencer accepts proofs exclusively for wallets in its assigned partition and rejects proofs for wallets in other partitions. A proof submission to the wrong partition returns an error without processing.

[0102] A client-side partition router pre-discovers all partition sequencer URLs and computes the correct destination for any wallet operation using only the wallet identifier and partition count. No central dispatcher, load balancer, or routing oracle is required. Any client can independently compute the correct routing destination.

[0103] The sequencer network provides 43 public RPC endpoints (37 zero-authentication read endpoints and 6 write endpoints) requiring no authentication for read operations. All stored data consists of Poseidon hash commitments, and privacy derives from the computational irreversibility of the hash function rather than from access control mechanisms. No member name, date of birth, cardholder identifier, or any personally identifiable information is stored on or transmitted through the sequencer network at any time — members are identified solely by their opaque wallet identifiers.

#### X. Gossip-Replicated ZK Proof Propagation (FIGS. 8A-8B)

[0104] Referring now to FIGS. 8A and 8B, the system replicates zero-knowledge proof lifecycle events across all sequencer nodes using twelve typed gossip messages: `proof:accepted` (a ZK proof verified and accepted), `batch:built` (a batch of proofs assembled), `batch:settled` (a batch confirmed as settled), `batch:failed` (a batch settlement failed), `state:snapshot` (a full state snapshot for initial block download (IBD), the process by which a new node synchronizes with the network by downloading the complete current state from an existing peer), `message:stored` (an encrypted message stored in the message store), `peer:announce` (a node announces its presence), `leader:heartbeat` (a partition leader broadcasts liveness), `leader:promotion` (a failover event announcing new leadership), `quorum:propose` (a leader proposes a write-ahead log entry for quorum confirmation), `quorum:vote` (a peer responds with a signed durability acknowledgment), and `quorum:certificate` (a leader broadcasts the completed quorum certificate).

[0105] As shown in FIG. 8B, all replication is idempotent — duplicate messages are detected and skipped using a bounded deduplication set (maximum 10,000 message identifiers with half-eviction at capacity). After gossip propagation, every node holds identical proof records.

[0106] The trust mechanism for proof correctness is zero-knowledge proof cryptographic validity only. No Byzantine fault tolerance, proof of work, proof of stake, or validity-determining consensus voting is employed. Quorum durability votes (described in Section XI-A below) confirm that a peer has persistently written a proof entry to its local write-ahead log; they do not determine whether the proof is valid. Proof validity is established exclusively by the zero-knowledge proving system at the point of initial acceptance by the partition leader.

[0107] Referring still to FIG. 8B, the gossip protocol supports both broadcast messaging (sent to all connected peers) and directed messaging (sent to a specific peer). Directed messaging is used for quorum vote responses, where a peer sends its signed durability acknowledgment directly to the proposing leader rather than broadcasting it to the entire network.

[0108] Entity nodes — nodes operated by pharmacies, prescribers, insurers, or other healthcare entities — may participate in the gossip network as read-only replicas by configuring the node role as `replica` rather than `sequencer`. A replica node receives all gossip message types, applies them via idempotent replication methods (which silently skip duplicate messages), and maintains a complete read-only copy of all proofs, batches, receipts, audit events, claim accumulator entries, and encrypted messages in the global dataset. Replica nodes do not own any partition and do not accept proof submissions or produce batches. All read query endpoints (40 or more RPC methods) operate identically on replica nodes and sequencer nodes, enabling entity nodes to serve local read queries for any proof in the global dataset without routing to a partition leader.

#### XI. Multi-Leader Consensus-Free Failover (FIGS. 12A-12B)

[0109] Referring now to FIG. 12A, the system provides a multi-leader architecture where N sequencer nodes each serve as sovereign leader of one partition.

[0110] Each leader broadcasts a heartbeat message at a configurable interval (in the preferred embodiment, every 5,000 milliseconds). If a leader's heartbeat is not received within a timeout period (in the preferred embodiment, 15,000 milliseconds, corresponding to three missed heartbeats), the next node in a deterministic failover chain automatically promotes itself to leader of the orphaned partition.

[0111] The failover chain is a pre-configured priority ordering. For example, with three partitions and three nodes (alpha, beta, gamma): partition 0 failover chain is alpha → beta → gamma; partition 1 is beta → gamma → alpha; partition 2 is gamma → alpha → beta.

[0112] Referring now to FIG. 12B, split-brain resolution is deterministic: if two nodes promote simultaneously for the same partition, the lower-priority node demotes immediately upon receiving the higher-priority node's `leader:promotion` gossip message. Zero-knowledge proof validity is node-independent — proofs generated by any leader are equally valid.

[0113] No consensus messages are exchanged for leader election. The failover decision is computed independently by each node from local state (heartbeat timestamps) and the pre-configured priority chain.

[0114] As further illustrated in FIG. 12B, on the client side, each entity node (member 112, prescriber 114, pharmacy 116) maintains a cached partition routing table mapping wallet identifiers to sequencer URLs. When a partition-routed operation fails with a connection-level error (e.g., connection refused, connection reset, or timeout — indicating the cached leader is unreachable), the entity node automatically re-discovers the current partition leaders from any reachable sequencer node and retries the operation exactly once against the newly discovered leader. This transparent client-side failover operates without user intervention and without application-level awareness — the proof submission call returns successfully after the retry. Only connection-level errors trigger rediscovery; application-level rejections (such as invalid proof or duplicate submission) propagate immediately without retry.

#### XI-A. Write-Ahead Log and Quorum Durability (FIGS. 15A-15B)

[0115] Referring now to FIGS. 15A and 15B, the system provides a write-ahead log (WAL) and quorum durability protocol that ensures zero data loss across the sequencer network without employing consensus mechanisms for proof validity determination.

[0116] **Write-Ahead Log.** Referring to FIG. 15A, each sequencer node maintains a per-partition append-only log file in newline-delimited JSON (NDJSON) format. The log file path follows the pattern `{dataDir}/wal/partition-{index}.wal`. Every state mutation — whether a proof acceptance, batch assembly, or batch settlement — is first appended to the write-ahead log and flushed to persistent storage via an operating system `fsync` call before any in-memory state mutations are applied. Each log entry contains a unique entry identifier (SHA-256 hash of the entry content), a monotonic sequence number, entry type (proof, batch_begin, batch_commit, batch_abort, settle, or fail), the serialized proof data, pre-computed receipt and audit event data, a state snapshot recording the registry root, lifecycle root, wallet count, and audit chain hash at the time of the entry, and an integrity hash computed from the critical fields.

[0117] After all in-memory state mutations for an entry have been successfully applied (including Merkle tree root advancement, receipt storage, audit event generation, and claim accumulator updates), a commit marker is written to the log as a separate line, indicating that the entry's mutations have been fully applied.

[0118] **Crash Recovery.** Referring now to FIG. 15B, upon restart after a crash, the sequencer reads the write-ahead log and identifies uncommitted entries — those with no corresponding commit marker. Uncommitted proof entries are replayed by applying the pre-computed receipt and audit event data directly to in-memory state, advancing roots from the receipt's post-mutation values, and writing a commit marker. Uncommitted `batch_begin` entries without a corresponding `batch_commit` are discarded, as the pending proof pool will be repopulated by client resubmission. This two-pass recovery (first collect commit markers, then process entries) ensures that all accepted proofs are recoverable even if the crash occurred between the first mutation and the last mutation in a multi-step state transition.

[0119] **Log Compaction.** After a successful checkpoint (described in Section XV), the write-ahead log is truncated to remove entries at or below the checkpointed sequence number. Truncation uses an atomic write strategy: entries to be retained are written to a temporary file, the temporary file is flushed via `fsync`, and the temporary file is atomically renamed to replace the original log file. This ensures the log file is always in a consistent state, even if a crash occurs during compaction.

[0120] **Quorum Write Protocol.** Referring still to FIG. 15B, the quorum write protocol ensures that a proof is not acknowledged to the submitting client until a configurable threshold of sequencer nodes (in the preferred embodiment, N/2+1 where N is the total number of sequencer nodes serving a partition's failover chain) have each durably written the proof entry to their respective write-ahead logs and returned a cryptographic acknowledgment.

[0121] The protocol proceeds as follows:

[0122] Step 1: The partition leader accepts a zero-knowledge proof, verifies it, and appends a write-ahead log entry locally (with `fsync`).

[0123] Step 2: The leader broadcasts a `quorum:propose` gossip message to all peer nodes, containing a proposal identifier (equal to the WAL entry identifier), the partition index, the sequence number, a SHA-256 hash of the WAL entry content, a hash of the post-mutation state digest, the leader identifier, and a timestamp.

[0124] Step 3: Each peer node receives the proposal, appends the corresponding entry to its own write-ahead log (with `fsync`), and constructs a signed vote. The vote is signed using Ed25519 over a canonical message of the form:

    "zkpcare-quorum-vote-v1|{proposalId}|{walEntryHash}|{voterId}|{timestamp}"

[0125] The peer sends its signed vote directly back to the leader via directed gossip messaging (not broadcast).

[0126] Step 4: The leader collects votes. The leader's own local WAL write counts as a self-vote (signed automatically). When the threshold number of valid votes (N/2+1) has been collected, the leader assembles a quorum certificate containing the proposal metadata, the set of N/2+1 signed votes, and the leader identifier.

[0127] Step 5: The leader applies the state mutations to in-memory state, attaches the quorum certificate to the receipt, and returns the receipt to the client.

[0128] If the threshold is not reached within a configurable timeout period (in the preferred embodiment, 5,000 milliseconds), the proposal is rejected and the client receives an error indicating insufficient quorum.

[0129] **Quorum Certificate.** A quorum certificate is a data structure containing the proposal identifier, partition index, sequence number, WAL entry hash, state digest hash, the array of N/2+1 Ed25519-signed votes (each comprising a voter identifier, the WAL entry hash, a 128-character hexadecimal Ed25519 signature, and a timestamp), the leader identifier, and a creation timestamp. The quorum certificate is attached to the L2 receipt returned to the client, providing cryptographic proof that a majority of sequencer nodes have durably written the proof data before the client received confirmation.

[0130] **Ed25519 Key Management.** Each sequencer node holds an Ed25519 signing keypair. In the preferred embodiment, the keypair is deterministically derived from the node identifier using SHA-512 hashing of the node identifier bytes to produce the 32-byte seed, followed by PKCS#8 DER encoding for the private key and SPKI DER encoding for the public key. Public keys are exchanged via the leader heartbeat gossip messages, enabling each node to verify votes from any peer without a separate key distribution protocol.

[0131] **State Certificates at Batch Boundaries.** At each batch boundary (when `buildBatch()` completes), the partition leader creates a state certificate — a batch-level attestation that the aggregate state at that point has been acknowledged by a majority of sequencer nodes. The state certificate contains a version number, the batch number, the partition index, a state digest (comprising the latest sequence number, the latest batch number, the audit chain hash, the claim accumulator root, the registry root, the lifecycle root, and the wallet count), a hash of the state digest, and an array of signatures. Each signature entry contains a node identifier, a 128-character hexadecimal Ed25519 signature over a canonical message of the form:

    "zkpcare-state-cert-v1|{batchNumber}|{partitionIndex}|{stateDigestHash}|{nodeId}|{timestamp}"

[0132] and the signer's public key in hexadecimal. The state certificate is attached to the L2 batch data structure.

[0133] A state certificate is considered valid if it contains at least N/2+1 valid signatures from known peer nodes, where each signature verifies against the canonical message constructed from the certificate's own fields. Any tampering with the state digest invalidates all signatures.

[0134] **Checkpoint Atomicity.** Referring again to FIG. 15A, checkpoint files (JSON snapshots of sequencer state) are written using an atomic strategy: the checkpoint data is written to a temporary file, the temporary file is flushed via `fsync`, and the temporary file is atomically renamed to the final path. This prevents corrupted checkpoint files from partial writes during a crash. After a successful checkpoint, the write-ahead log is compacted as described above.

[0135] **Backward Compatibility.** The write-ahead log and quorum protocol are optional enhancements. When the write-ahead log is not configured, all WAL-related operations are silently skipped using optional chaining. When the quorum service is not enabled, proof submission falls back to fire-and-forget gossip replication (the pre-existing behavior). Single-node deployments operate without WAL or quorum with no behavioral change.

#### XII. Encrypted Message Store (FIG. 11)

[0136] Referring now to FIG. 11, the system provides an encrypted message store 158 comprising a Merkle tree of depth 20 (supporting approximately 1,048,576 messages).

[0137] Each Merkle leaf is a five-field Poseidon hash:

    leafHash = Poseidon.hash([messageCommitment, senderWalletId, recipientWalletId, messageType, threadIdHash])

[0138] Encrypted message payloads (ciphertext, initialization vector, and GCM authentication tag) are stored alongside the Merkle tree but are NOT included in the tree itself. The sequencer cannot decrypt any message payload — decryption requires the X25519 private key derived from the enrollment key, which remains exclusively on the member's device.

[0139] Four parallel index structures provide O(1) lookup by sender, recipient, wallet (union of sender and recipient), and thread identifier.

[0140] The message store root committed in each batch record (Claim 15(d)) is distinct from the messaging root in the global state commitment (Claim 9, field 7). The global state messaging root is a composite hash of three administrator-configured messaging trees (a message registry, a delegation registry, and an encryption key registry), whereas the message store root is the Merkle root of the encrypted message history maintained by the message store service on the sequencer. The message store root is sequencer metadata accompanying the batch but is not included in the ten-field global state hash committed by the chain proof.

#### XIII. Epoch-Based Temporal Accumulator (FIG. 13)

[0141] Referring now to FIG. 13, the system provides epoch-based temporal accumulation with monthly Merkle tree rotation. Each epoch is an independent claim accumulator instance (Merkle tree of depth 24 with four index structures). Upon epoch rotation, the current epoch is frozen (marked as archived and immutable), and a fresh epoch with an empty Merkle tree is created as the new active epoch.

[0142] Cross-epoch aggregation queries search the active epoch first, then all archived epochs, returning a unified result set. This design supports production scale of approximately 250 million claims per year.

#### XIV. Portable ZK Credential with Offline Verification (FIGS. 14A-14B)

[0143] Referring now to FIGS. 14A and 14B, the system provides a self-contained JSON credential format transportable via NFC (NTAG216 tags with 888-byte capacity), QR code, or RFID.

[0144] The credential program 123 provides three methods: a mint method proving correct credential insertion into a wallet inventory Merkle tree, a holding method proving a wallet holds a specific credential (for point-of-care verification), and a holding-by-type method proving a wallet holds a credential of a specified type without revealing which specific credential (selective disclosure). Each method recursively verifies a wallet ownership proof in-circuit.

[0145] A portable credential structure contains a protocol version, proof type identifier, the JSON-serialized zero-knowledge proof, extracted public output fields for quick inspection, the verification key hash, creation timestamp, and expiration timestamp. For capacity-constrained transports such as NFC tags (NTAG216: 888-byte capacity), a compact credential attestation format is provided as an alternative: as illustrated in FIG. 14B, the sequencer verifies the full zero-knowledge proof, then produces an Ed25519-signed attestation containing the wallet identifier, credential commitment, forest root, lifecycle state, expiration timestamp, and a revocation nonce. The compact attestation is approximately 578 bytes, fitting within NTAG216 capacity. At point-of-care, the verifier checks the Ed25519 signature (sub-millisecond) rather than re-verifying the full zero-knowledge proof. The full proof remains available for QR code or network-based transport where capacity is not constrained.

[0146] As shown in FIG. 14B, offline verification at point-of-care (for example, at a pharmacy counter) requires zero network connectivity. The verifier reconstructs the proof from the JSON representation and verifies it against a cached verification key using the ZkProgram verification method. No issuer lookup, blockchain query, or trusted third party is needed.

[0147] Referring still to FIG. 14B, for delegation credentials (Appointment of Representative under CMS-1696), tiered time-to-live (TTL) values enforce risk-proportional expiration: 72 hours for read-only access (low risk), 24 hours for write access (medium risk), and 4 hours for medication pickup (high risk). A 48-hour cool-down period is required before pickup scope activates.

#### XV. Reduction to Practice

[0148] The system described herein has been reduced to practice as a working software implementation comprising approximately 48,000 lines of TypeScript code across 160 source files, with 1,120 or more passing unit tests covering every subsystem. The implementation uses the o1js version 2.13.0 zero-knowledge proof library operating over the Pasta curve with the Kimchi/Pickles recursive SNARK proving system. The write-ahead log, quorum durability protocol, Ed25519 key management, quorum certificate assembly, and state certificate generation described in Section XI-A have been implemented and verified with 57 dedicated unit tests (27 for the write-ahead log and 30 for the quorum service).

[0149] Machine-generated cryptographic evidence demonstrating every claim element was produced by executing the actual codebase on February 24, 2026. All Poseidon hash values, Merkle roots, partition computations, Ed25519 signatures, and quorum certificates presented in the accompanying exhibits are real outputs of the respective cryptographic functions, not simulations, mockups, or hypothetical values.

#### XVI. Parallel Zero-Knowledge Proving Architecture (FIGS. 16A-16B)

##### A. Technical Problem: WASM Heap Monotonic Growth

[0150] Referring now to FIGS. 16A and 16B, the system addresses a fundamental resource constraint in zero-knowledge proof generation. The Pickles/Kimchi recursive SNARK engine, which underpins all ZkProgram verification in the system, executes within a WebAssembly (WASM) runtime. The WASM linear memory model allocates memory in 64KB pages that can only grow -- never shrink -- during the lifetime of a process. Each in-circuit `StateTransitionProof.verify()` call within BatchProgram allocates approximately 60 megabytes of WASM heap for the Pickles accumulator and Kimchi constraint system. This memory is not reclaimable by JavaScript garbage collection because it resides in the WASM linear memory space, which has no compaction or deallocation API.

[0151] In a production Leviathan Sequencer processing hundreds of batches, the WASM heap grows monotonically until the process exhausts available physical memory, at which point operating system virtual memory paging causes severe latency degradation and eventual process termination. A single-process architecture is therefore fundamentally bounded in the number of proofs it can generate before requiring a restart.

##### B. Proving Pool Architecture

[0152] The proving pool 1600 (FIG. 16A) solves this resource constraint by distributing zero-knowledge proof generation across a plurality of isolated worker processes 1610, 1612, 1614 forked from the Leviathan Sequencer process 1602. Each worker process maintains its own independent WASM runtime with a separate linear memory space. No shared mutable state exists between the sequencer process 1602 and any worker process, or between any two worker processes. Isolation is achieved exclusively through operating system process boundaries -- no mutexes, shared memory segments, or lock-free data structures are required.

[0153] The sequencer process 1602 acts as the pool coordinator, maintaining a worker registry 1604 that tracks the state of each worker (compiling, idle, proving, or dead), its cumulative job count, and its current job assignment. The coordinator dispatches proving jobs to idle workers via IPC 1606 and receives completed proofs via the same channel.

##### C. Split-Phase Batch Construction Protocol

[0154] The batch construction lifecycle is divided into three sequential phases that execute across process boundaries, ensuring that the sequencer process 1602 never invokes ZkProgram proving methods and therefore accumulates no WASM heap growth from proof generation.

[0155] **Phase 1 -- Prepare (Sequencer Process 1602).** The sequencer drains pending StateTransitionProofs from its acceptance queue, collecting up to the maximum batch size (default: 2 transitions, constrained by the Pickles recursion depth limitation). Each StateTransitionProof is serialized to a JSON object via the o1js `proof.toJSON()` method. All finite field values within the proof's public input and output structures are encoded as decimal strings (base-10 representations of elements in the Pasta curve finite field, modulus p = 28948022309329048855892746252171976963363056481941560715954676764349967630337). The serialized proofs, together with the current administrative state configuration (adminPublicKeyHash, benefitPlanRoot, credentialRegistryRoot, eligibilityVkHash, messagingRoot as decimal strings) and the latest ChainProof JSON (if chain proof generation is enabled), are assembled into a proving job request 1620.

[0156] **Phase 2 -- Prove (Worker Process 1610).** The coordinator selects the first idle worker from the pool and dispatches the proving job request 1620 via IPC. The worker deserializes each StateTransitionProof from its JSON representation using `ZkProgram.Proof.fromJSON()`, which reconstructs the proof object with full Pickles accumulator state. The worker then executes the BatchProgram methods:

[0157] - For a single transition: `BatchProgram.wrapSingle(stateTransitionProof)`, which calls `StateTransitionProof.verify(proof)` in-circuit, producing a BatchProof.
- For two transitions: `BatchProgram.wrapPair(proof1, proof2)`, which calls `StateTransitionProof.verify()` on both proofs in-circuit, enforcing root continuity (`proof1.newRegistryRoot === proof2.oldRegistryRoot`), and producing a merged BatchProof.
- For recursive merge: `BatchProgram.mergeBatches(batchProof1, batchProof2)`, which verifies both BatchProofs in-circuit and produces a single aggregated BatchProof.

[0158] If administrative state is provided, the worker additionally executes ChainProgram.advance() (or ChainProgram.genesis() for the first block), passing the BatchProof for in-circuit verification. The resulting BatchProof and optional ChainProof are serialized to JSON, the public output fields are extracted and encoded as decimal strings, and the complete result 1622 is returned to the coordinator via IPC.

[0159] **Phase 3 -- Finalize (Sequencer Process 1602).** The coordinator deserializes the BatchProof and ChainProof from the worker's JSON response, constructs the L2Batch metadata record (batch number, creation timestamp, transition count, registry and lifecycle root transitions, the serialized batch proof JSON, and the worker identifier that produced the proof), marks all constituent transaction receipts as settled, appends the batch to the sequencer's local batch store, and broadcasts a `batch:built` gossip event 1624 to all peers in the zkTrident Network. At no point during the finalize phase does the sequencer process invoke any ZkProgram proving or verification method. The split-phase protocol integration with the sequencer process is further illustrated in FIG. 16B.

##### D. IPC Message Protocol

[0160] Communication between the coordinator and workers uses operating system IPC channels (Node.js `child_process.fork()` with `serialization: 'json'`). The protocol defines six message types organized into two directions:

[0161] **Coordinator-to-Worker Messages:**

| Message Type | Purpose | Payload |
|---|---|---|
| `compile` | Instruct worker to compile ZkProgram verification keys | (none) |
| `prove` | Dispatch a proving job | jobId (string), request (ProvingJobRequest) |
| `shutdown` | Initiate graceful termination | (none) |

[0162] **Worker-to-Coordinator Messages:**

| Message Type | Purpose | Payload |
|---|---|---|
| `ready` | Signal successful compilation | compileTimeMs (number) |
| `result` | Return completed proof | jobId (string), result (ProvingJobResult) |
| `error` | Report proving failure | jobId (string), message (string) |

[0163] All ZK proof objects are serialized via `proof.toJSON()` for transport and reconstructed via `ZkProgram.Proof.fromJSON()` on receipt. All algebraic field elements are encoded as decimal strings. This serialization format is lossless -- every field element, every Pickles accumulator component, and every Kimchi commitment survives the IPC round-trip without precision loss, because decimal string encoding preserves the exact integer value of each element in the finite field.

[0164] The coordinator monitors IPC channel health by checking the return value of each `process.send()` call. A `false` return indicates the IPC buffer is saturated (the kernel's pipe buffer has reached capacity because the receiving process's event loop is blocked), which is an early warning signal of impending WASM heap exhaustion in the worker.

##### E. Worker Recycling for WASM Heap Reclamation

[0165] The proving pool implements a worker recycling mechanism 1630 (FIG. 16B) that proactively terminates and replaces worker processes before their WASM heap grows to problematic sizes. The recycling threshold is configurable (default: disabled; recommended: 5 proving jobs per worker, corresponding to approximately 300 megabytes of accumulated WASM heap).

[0166] The recycling lifecycle proceeds as follows:

[0167] 1. After each successful prove job, the coordinator increments the worker's cumulative job counter.
2. When the counter reaches the recycling threshold, the coordinator initiates recycling:
   - (a) The coordinator resolves the pending job promise (the job's caller receives the result immediately -- recycling does not delay job completion).
   - (b) The coordinator sends a `shutdown` message to the exhausted worker and removes it from the active worker pool.
   - (c) After a configurable grace period (default: 5 seconds), the coordinator sends SIGTERM to the worker process if it has not exited voluntarily.
   - (d) The coordinator forks a fresh worker process, which inherits the recycled worker's crash restart count (recycling is not counted as a crash).
   - (e) The coordinator sends a `compile` message to the new worker, initiating ZkProgram verification key compilation.
   - (f) Upon receiving the `ready` message, the new worker is marked idle and begins accepting prove jobs.
3. The coordinator emits a `worker:recycled` lifecycle event containing the old worker's identifier and cumulative job count, enabling operational dashboards to distinguish planned recycling from unexpected crashes.

[0168] The recycling mechanism is critical for production operation. Without recycling, a worker processing proofs continuously would exhaust 4 gigabytes of WASM heap in approximately 67 proofs (67 x 60MB = 4,020MB). With the default recycling threshold of 5 jobs, each worker's WASM heap never exceeds approximately 300 megabytes before being reclaimed through process termination.

##### F. Crash Detection and Automatic Recovery

[0169] Referring to FIG. 16B, the coordinator monitors each worker process for unexpected termination via operating system exit event handlers. When a worker crashes (exits with non-zero code or is killed by a signal):

[0170] 1. The coordinator marks the worker as dead and removes it from the active pool.
2. If a proving job was in-flight on the crashed worker, the coordinator rejects the job's promise with a diagnostic error including the worker's exit code and signal.
3. The coordinator distinguishes crashes from recycling by checking whether the worker was still registered in the active pool at the time of exit. Workers that have already been removed by the recycling mechanism (Section XVI.E) are not treated as crashes.
4. If the worker's cumulative restart count is below the maximum restart threshold (default: 3), the coordinator spawns a replacement worker, compiles its ZkProgram verification keys, and upon readiness, drains the job queue.
5. If the restart threshold is exceeded, the coordinator does not spawn a replacement, reducing the pool's capacity. This prevents infinite restart loops caused by systematic compilation failures or corrupted WASM state.

##### G. Job Dispatch and Queuing

[0171] Incoming proving requests follow a FIFO dispatch protocol:

[0172] 1. If an idle worker exists in the pool, the job is dispatched immediately.
2. If all workers are busy, the job is enqueued in a FIFO queue.
3. When any worker completes a job (and is not being recycled), the coordinator dequeues the oldest pending job and dispatches it.
4. Each dispatched job is subject to a configurable proving timeout (default: 5 minutes). If the timeout fires before the worker returns a result, the job is failed, the worker is marked idle, and the queue is drained.

[0173] The coordinator maintains aggregate statistics: total jobs completed, total jobs failed, cumulative proving time, and average proving time per job. These statistics are exposed via the `l2_getHealth` RPC endpoint and the HTTP `/health` endpoint, enabling operational monitoring of proving throughput.

##### H. Proving Pool Integration with Leviathan Network

[0174] In a multi-leader Leviathan network (Section XI), each Leviathan that owns a partition may optionally configure a proving pool for that partition's sequencer. The proving pool is configured at startup with a pool size (number of worker processes), recycling threshold, and timeout parameters. The pool is transparent to the rest of the system -- the gossip replication protocol (Section X), the heartbeat failover protocol (Section XI), and the client-side partition router (Claim 12) are unaware of whether a Leviathan's batches are produced by a single-process sequencer or by a proving pool. The only observable difference is the `workerId` field stamped on each L2Batch, indicating which worker produced the proof.

---

### CLAIMS

**Claim 1.** A method for adjudicating a healthcare claim using a zero-knowledge circuit, comprising:

(a) encoding as arithmetic constraints in a zero-knowledge circuit:

  (i) a formulary eligibility lookup by drug identity code against a benefit plan, wherein the circuit verifies a Merkle witness proving the existence of a formulary entry in a formulary registry Merkle tree and verifies that the drug identity code in the formulary entry matches the drug identity code in the claim data;

  (ii) a cost-share computation from a formulary tier, accumulator balances, and plan parameters, producing a patient copay amount, wherein the computation implements a priority-ordered cascade evaluating an out-of-pocket maximum, an annual benefit maximum, a deductible phase, and a formulary copay tier, each computed as in-circuit conditional branches;

  (iii) a deductible accumulator state transition updating a member deductible paid amount, an out-of-pocket paid amount, and an annual benefit used amount as in-circuit state variables;

(b) generating a zero-knowledge proof establishing correctness of the adjudication without revealing protected health information, member identity, drug identity in plaintext form, or dosage information; and

(c) committing the resulting proof output and an updated accumulator root to the member wallet state, wherein the proof output includes a drug identity hash enabling drug identity tracking without revealing the plaintext drug identity code outside the circuit.

**Claim 2.** The method of claim 1, wherein the deductible accumulator state transition further comprises computing a deductible credit amount as the minimum of the patient copay amount and a remaining deductible amount, and incorporating the deductible credit into a settlement commitment of the form Poseidon.hash([fulfillmentCommitment, patientPay, planPay, deductibleCredit]), enabling exact reversal of all accumulator state upon claim reversal.

**Claim 3.** The method of claim 1, wherein the zero-knowledge circuit further comprises verifying a pharmacy wallet identity binding by recomputing a pharmacy wallet identifier from its preimage fields within the circuit and verifying it matches a pharmacy wallet identifier included in the claim data.

**Claim 4.** A system for organizing healthcare data as a multi-domain Merkle forest committed in a verifiable credential, comprising:

(a) six domain-specific Merkle trees, each using a ZK-friendly algebraic hash function as the internal hash function, the six domains being: member identity, prescriber credentials, pharmacy credentials, medication and formulary data, access control including eligibility and accumulator state, and transaction settlement history;

(b) a composite forest root computed as the hash of all six domain tree roots;

(c) a credential whose sole cryptographic payload is the composite forest root, the credential being a multi-field hash commitment that produces a provably distinct credential state upon any change to any leaf in any domain tree; and

(d) selective domain disclosure via Merkle witnesses for individual domain trees, enabling proof of data in one domain without revealing contents of other domains.

**Claim 5.** A method for establishing and accessing a blockchain wallet without a private key, comprising:

(a) deriving a wallet identifier by computing a hash of a domain tag, one or more hashed identity fields, and a hash of a user-generated enrollment key, wherein the domain tag is an integer constant distinguishing entity types, the identity fields are hashed locally on a user device, and the enrollment key is a cryptographically random value generated on the user device and never transmitted to any other party;

(b) registering the wallet identifier on a distributed sequencer network as the sole wallet address, with no associated signing key, mnemonic phrase, seed, or key material of any kind;

(c) gating all state transitions on the wallet exclusively through zero-knowledge proof verification, wherein a state transition is authorized if and only if a valid zero-knowledge proof demonstrates knowledge of the identity fields and enrollment key that produce the wallet identifier; and

(d) wherein wallet access cannot be obtained by key theft, seed phrase compromise, or private key extraction, as no such material exists at any point in the wallet lifecycle.

**Claim 6.** The method of claim 5, wherein the enrollment key is a 256-bit value generated from an operating system entropy pool on the user device, encoded as base64url, and validated for minimum entropy including at least three of four character classes selected from uppercase letters, lowercase letters, digits, and symbols.

**Claim 7.** A method for privacy-preserving healthcare identity enrollment involving three parties, comprising:

(a) an employer system generating a cryptographic enrollment token comprising a plurality of Poseidon hash commitments of employee identification data, group identification data, plan identification data, and family identification data, the token containing zero protected health information;

(b) a member device, upon receipt of the token, performing entirely on-device: hashing protected health information fields locally, computing a wallet identifier as a Poseidon hash of a domain tag, the hashed identity fields, and a hash of a locally-generated enrollment key, and generating a zero-knowledge proof of correct wallet derivation;

(c) an insurer system receiving and registering only the wallet identifier and the zero-knowledge proof, wherein the insurer system never receives, processes, or stores any protected health information in any form; and

(d) wherein no single party holds complete information: the employer holds only the enrollment token, the member holds the identity preimage and enrollment key, and the insurer holds only the opaque wallet identifier.

**Claim 8.** A system for certifying healthcare state via a multi-level recursive zero-knowledge proof hierarchy, comprising:

(a) a state transition program producing a state transition proof per healthcare transaction, with wallet verification inlined as a hash computation with a conditional selector across entity types to avoid adding a recursion level;

(b) a batch program aggregating state transition proofs via in-circuit verification of constituent proofs, producing a batch proof valid only if all constituent proofs verify, using a uniform pair pattern where both a base-case wrapping method and a recursive merging method accept exactly two proofs; and

(c) a chain program certifying a global state commitment comprising a plurality of healthcare-specific state fields including at least a wallet registry root, a lifecycle root, a benefit plan root, a credential registry root, an audit chain hash, and a block height, via in-circuit verification of batch proofs, producing a chain proof that recursively encapsulates all prior chain history.

**Claim 9.** The system of claim 8, wherein the global state commitment is a ten-field Poseidon hash comprising a wallet registry root, a wallet count, an administrator public key hash, a lifecycle root, a benefit plan root, a credential registry root, an eligibility verification key hash, a messaging root, an audit chain hash, and a block height.

**Claim 10.** A computer-implemented data structure for accumulating adjudicated pharmacy claims as zero-knowledge commitments with multi-dimensional lookup capability, comprising:

(a) a Merkle tree of a predetermined depth wherein each leaf is a Poseidon hash of a plurality of claim fields including at least a member wallet identifier, a drug identity hash, a pharmacy wallet identifier, a prescriber wallet identifier, a date of service, a patient pay amount, and a plan pay amount;

(b) a plurality of parallel index structures, each mapping a different claim field key to leaf indices, supporting lookup by at least member wallet identifier, pharmacy wallet identifier, prescriber wallet identifier, and drug identity hash;

(c) Merkle witness generation producing inclusion proofs verifiable inside a zero-knowledge circuit without revealing other leaf values; and

(d) a claim accumulator root committed as a metadata field in each batch record alongside the cryptographically certified batch proof, and further attested by a multi-node state certificate comprising Ed25519-signed acknowledgments from a majority of sequencer nodes at each batch boundary.

**Claim 11.** A method for privacy-preserving healthcare compliance auditing using a hash chain with selective disclosure, comprising:

(a) maintaining an audit chain as successive hash commitments wherein each event commitment is a multi-field hash of state transition fields including wallet identifier, old and new registry roots, old and new lifecycle roots, sequence number, registration flag, drug identity hash, and financial amounts, and each chain link is a hash of the previous chain hash and the current event commitment, starting from a genesis hash;

(b) committing the current audit chain hash in a global state commitment that binds the audit chain to all other healthcare state in a single recursive zero-knowledge proof;

(c) selective event disclosure for individual audit entries, wherein an auditor may be provided with a specific event commitment, its sequence position, and the chain hash values immediately before and after the event, enabling the auditor to verify the event's inclusion in the chain by recomputing the chain link hash without requiring disclosure of any other entry; and

(d) the audit chain being append-only, tamper-evident, and independently verifiable by any party with the genesis hash.

**Claim 12.** A partitioned sequencer network for processing zero-knowledge healthcare proofs, comprising:

(a) a plurality of sequencer nodes, each assigned an exclusive partition of a wallet address space, wherein the partition assignment is computed as the wallet identifier modulo the total partition count;

(b) each sequencer node accepting proofs exclusively for wallets in its assigned partition and rejecting proofs for wallets in other partitions;

(c) a client-side partition router that pre-discovers all partition sequencer endpoints and computes the correct destination for any wallet operation using only the wallet identifier and partition count, without any central dispatcher, load balancer, or routing oracle; and

(d) a plurality of zero-authentication read endpoints exposing only hash commitments, wherein privacy derives from the computational irreversibility of the hash function rather than from access control mechanisms.

**Claim 13.** A gossip replication protocol for propagating zero-knowledge proof lifecycle events across a sequencer network, comprising:

(a) a plurality of typed gossip messages including at least proof acceptance, batch assembly, batch settlement, batch failure, state snapshot for initial block download, message storage, peer announcement, leader heartbeat, leader promotion, quorum proposal, quorum vote, and quorum certificate event types;

(b) idempotent replication wherein duplicate messages are detected and skipped using a bounded deduplication set;

(c) a trust mechanism based exclusively on zero-knowledge proof cryptographic validity, without Byzantine fault tolerance, proof of work, proof of stake, or validity-determining consensus voting, wherein the correctness of each healthcare proof is established solely by the zero-knowledge proving system and not by any node voting on proof validity; and

(d) directed messaging capability wherein a gossip message may be sent to a specific peer node rather than broadcast to all peers, enabling point-to-point communication for quorum vote responses; and

(e) entity node participation wherein entity nodes receive gossip messages from the sequencer network without owning any partition, maintaining read-only replicas that enable entity nodes to serve local read queries for any proof in the global dataset without routing to a partition leader.

**Claim 14.** A multi-leader sequencer architecture for zero-knowledge healthcare proof processing, comprising:

(a) a plurality of sequencer nodes, each serving as sovereign leader of at least one partition of a wallet address space;

(b) a heartbeat protocol wherein each leader broadcasts liveness signals at a configurable interval;

(c) a deterministic failover chain specifying a priority ordering of nodes for each partition, wherein upon a leader's heartbeat timeout, the highest-priority live node in the failover chain automatically promotes itself to leader of the orphaned partition without exchanging any consensus messages;

(d) split-brain resolution wherein if two nodes promote simultaneously for the same partition, the lower-priority node demotes immediately upon receiving the higher-priority node's promotion gossip message; and

(e) transparent client-side failover wherein entity nodes, being nodes that participate in the network without owning any partition, each cache a partition routing table, and upon a connection-level failure to a cached partition leader, automatically re-discovers the current partition leaders from the sequencer network and retries the operation exactly once against the newly promoted leader without user intervention or application-level awareness.

**Claim 15.** A message store for encrypted healthcare communications, comprising:

(a) a Merkle tree wherein each leaf is a hash commitment of message metadata including a message content commitment, sender wallet identifier, recipient wallet identifier, message type, and thread identifier, but not the message content itself;

(b) encrypted message payloads stored alongside but not within the Merkle tree, the encryption using keys derived from user enrollment keys such that the sequencer cannot decrypt any message;

(c) a plurality of parallel index structures supporting lookup by sender, recipient, wallet union, and thread identifier; and

(d) a message store root committed as a metadata field in each batch record alongside the cryptographically certified batch proof, associating the message history with the same batch data structure that carries the chain proof global state commitment.

**Claim 16.** An epoch-based temporal accumulator for healthcare claim history, comprising:

(a) a plurality of claim accumulator instances, each comprising a Merkle tree and a plurality of index structures, with at most one instance designated as active and receiving writes, and remaining instances designated as archived and immutable;

(b) an epoch rotation operation that freezes the active instance and creates a fresh active instance with an empty Merkle tree; and

(c) cross-epoch aggregation queries that search the active epoch first and then all archived epochs, returning a unified result set.

**Claim 17.** A portable zero-knowledge credential for offline healthcare verification, comprising:

(a) a zero-knowledge credential program providing at least: a mint method proving correct credential insertion into a wallet inventory, a holding method proving a wallet holds a specific credential, and a holding-by-type method proving a wallet holds a credential of a specified type without revealing which specific credential, each method verifying wallet ownership in-circuit via recursive proof composition;

(b) a self-contained credential format containing a serialized zero-knowledge proof, extracted public output fields, a verification key hash, and expiration metadata, transportable via NFC, QR code, or RFID;

(c) offline verification capability wherein the credential is verified at point-of-care using only the serialized proof and a cached verification key, with zero network connectivity, zero issuer lookup, and zero blockchain query required; and

(d) for delegation credentials, tiered time-to-live values enforcing risk-proportional expiration with a shortest time-to-live for medication dispensing operations.

**Claim 18.** A method for ensuring durable replication of zero-knowledge proofs across a sequencer network prior to client acknowledgment, comprising:

(a) a per-partition write-ahead log maintained by each sequencer node, wherein each proof acceptance, batch assembly, and batch settlement is appended as a log entry and flushed to persistent storage before any in-memory state mutations are applied, each entry containing a unique identifier, a monotonic sequence number, an entry type, serialized proof data, pre-computed receipt and audit event data, a state snapshot, and an integrity hash;

(b) a quorum write protocol wherein, upon accepting a zero-knowledge proof, the partition leader appends a write-ahead log entry locally, broadcasts a proposal to peer sequencer nodes, and does not acknowledge the proof to the submitting client until a configurable threshold of sequencer nodes have each appended the entry to their respective write-ahead logs and returned a cryptographically signed acknowledgment;

(c) quorum certificates comprising the threshold set of Ed25519-signed acknowledgments, each acknowledgment signed over a canonical deterministic message including the proposal identifier, the write-ahead log entry hash, the voter identifier, and a timestamp, the quorum certificate being attached to the receipt returned to the client as cryptographic proof of durable multi-node replication;

(d) state certificates at batch boundaries, each comprising a threshold set of Ed25519 signatures over a canonical deterministic message including a state digest hash computed from the aggregate sequencer state at the batch boundary, providing a cryptographic attestation that a majority of sequencer nodes agree on the state at each batch point;

(e) crash recovery by replaying uncommitted write-ahead log entries, wherein entries with no commit marker are re-applied from pre-computed data and marked as committed, and incomplete batch entries are discarded; and

(f) log compaction after checkpoint, wherein committed entries at or below the checkpointed sequence number are removed via an atomic write strategy comprising writing retained entries to a temporary file, flushing the temporary file to persistent storage, and atomically renaming the temporary file to replace the original log file.

**Claim 19.** The system of Claim 12, further comprising a proving pool subsystem within each sequencer node for parallelizing zero-knowledge proof generation across isolated computation contexts, the subsystem comprising:

(a) a plurality of worker processes forked from the sequencer process via operating system process isolation, each worker maintaining an independent zero-knowledge proving context with its own WebAssembly memory space, wherein the WASM runtime compiles the BatchZkProgram and ChainZkProgram verification keys independently in each worker, such that no shared mutable state exists between the sequencer process and any worker process or between any two worker processes;

(b) a split-phase batch construction protocol dividing the batch lifecycle into three sequential phases executing across process boundaries: (i) a prepare phase executing on the sequencer process, which drains pending proofs from the acceptance queue and serializes them as JSON with finite field values encoded as decimal strings; (ii) a prove phase executing on an idle worker process, which deserializes the proofs, invokes the BatchZkProgram's in-circuit verify methods to produce a BatchProof, and returns the result serialized as JSON; (iii) a finalize phase executing on the sequencer process, which deserializes the proofs, stamps batch metadata, updates receipt settlement status, and broadcasts a gossip event;

(c) an inter-process communication protocol using operating system IPC channels with JSON serialization, comprising message types for compilation, job dispatch, result return, error reporting, and graceful shutdown, wherein all ZK proof objects are transported via `proof.toJSON()` and reconstructed via `ZkProgram.Proof.fromJSON()` and all algebraic field values are encoded as decimal strings for lossless transport;

(d) a worker recycling mechanism configured to terminate and replace a worker process after a configurable number of completed proving jobs, wherein the recycling reclaims WebAssembly heap memory that grows monotonically within the WASM runtime and cannot be reclaimed by garbage collection, as the WASM linear memory model provides no compaction or deallocation API;

(e) a crash detection and automatic recovery mechanism wherein the sequencer monitors each worker for unexpected termination, rejects any in-flight job assigned to the crashed worker, spawns a replacement, and ceases replacement attempts after a configurable maximum restart count; and

(f) a job dispatch and queuing mechanism wherein incoming requests are dispatched to idle workers immediately or enqueued in a FIFO queue when all workers are busy, with configurable per-job timeouts and aggregate statistics exposed via RPC.

---

### ABSTRACT

A system for adjudicating healthcare claims using zero-knowledge circuits on proof-gated wallets without private keys. The system encodes formulary lookup, cost-share computation, and deductible accumulator state transitions as arithmetic constraints inside zero-knowledge circuits, generating correctness proofs without revealing protected health information. Wallet identifiers are derived as Poseidon hash commitments of identity fields and a user-generated enrollment key, with all state transitions gated exclusively through zero-knowledge proof verification rather than cryptographic signatures. Healthcare data is organized as a six-domain Merkle forest committed in verifiable credentials with selective domain disclosure. A partitioned sequencer network distributes proof processing across multiple leader nodes using gossip-based replication and deterministic failover without consensus protocols, achieving consistency through zero-knowledge proof validity and multi-node attestation. The system supports offline credential verification, encrypted messaging, privacy-preserving compliance auditing with selective event disclosure, and parallel proof generation via process-isolated worker pools with periodic recycling to reclaim monotonically-growing WebAssembly heap memory.

---

*[END OF SPECIFICATION]*
