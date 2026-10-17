# Security hardening plan: to production

Status: plan complete, nothing implemented. Written 2026-10-16 across review sessions 1-4, from the code map, a live audit, and a comparison against the filed claims.

**Target is full production operation.** Two consequences run through everything below. First, a property that is implemented and tested but not switched on does not count as done; the seven dormant claims are work items, not documentation choices. Second, **there is no MINA L1 and none is planned.** The Leviathan network is the trust layer. Finality comes from quorum certificates, state certificates at batch boundaries, and the chain proof. Any remaining `l1Status` naming, `SettlementStrategy` hook or "settled on L1" language is vestigial and is removed in phase F so that nobody reads the code and infers a settlement dependency that does not exist.

Authoritative inputs, in order of precedence:
- `docs/AUDIT.md` — 27 ranked findings (`A-n` below), live-verified. Supersedes the findings tables that used to sit in section 2 of this file.
- `docs/INTENDED-VS-ASBUILT.md` — the four structural contradictions (`C-1` to `C-4`) against the design intent recorded in the claims. The patent is no longer being pursued; the abstract and claims now stand as defensive prior art and as the most complete written specification of the target architecture, which is why the comparison still drives work items here.
- `docs/CODEMAP.md` + `docs/codemap/*` — what the code is and where.
- `PLAN-registry-fix.md` — Phase 1, done and committed on the `dev` branch.

Route map of the current system: https://claude.ai/artifact/MVVzf7osD2sJQg1GKtYisx
Filed-versus-running comparison: https://claude.ai/artifact/5MbBi7TpPtVMeTnTNthxzq

## 1. The rules this plan enforces

These are the owner's design rules, stated as things a test can check.

| # | Rule |
|---|------|
| I1 | Raw PHI/PII (name, birth date, cardholder ID) exists only inside the member app on the phone, and only until the hash is made. It is never written to disk, logs, or browser storage. |
| I2 | Only the wallet ID and ZK proofs leave the phone. No per-field hashes, no enrollment-key hash, no preimage. |
| I3 | The enrollment key lives only in the phone's hardware keystore and on the member's offline card, encrypted under a PIN the member typed on the phone. |
| I4 | Nothing outside the app can call the app's functions or read its data: not other apps on the phone, not web pages in the phone's browser, not the local network. |
| I5 | Employee identity (name, employee ID) lives only on the employer's HR machine. What leaves the employer is a salted commitment and a random single-use enrollment code. |
| I6 | Only the member can link employee to wallet. The employer never learns the wallet ID. The insurer learns code to wallet but not code to employee. The sequencer knows wallets only. |
| I7 | Every route that changes state or returns member data authenticates its caller. Every proof is verified when it is submitted, not later in a batch. |

## 2. Where the code stands

See `docs/AUDIT.md`. The one-line summary: I1 holds literally but is defeated in effect, I2, I3, I4 and I7 are broken, I5 is broken in deployment while sound in construction, and I6 holds only by accident. Seven findings are critical.

What a reader of the old section 2 should know has changed: the hashes that reach the sequencer are not merely exposed, they are **reversible** (all four test members' names and birth dates recovered from one file in 75 seconds); the `/rpc` proxies attach no credentials rather than the node's token; replication is **entirely non-functional** and nothing noticed for 29 hours; and members are bound to a default plan and group rather than their employer's, so benefit amounts are computed from the wrong rules.

## 3. Target production architecture

Each phase moves the system toward this end state. Stating it first, because several fixes only make sense as steps toward it.

| Component | Today | Production target |
|---|---|---|
| **Member device** | A Node HTTP server on `0.0.0.0` with 31 unauthenticated routes, holding the network admin token | The prover and keystore run **inside the app process with no listening socket**. Identity never leaves. The enrollment key lives in the platform keystore and on the offline card. The current Nautilus member node survives only as a loopback-bound development harness with device auth |
| **Provider devices** | Prescriber and pharmacy nodes prove using enrollment keys committed to the repository and derivable from the NPI | Each provider proves with a key held in its own secure storage, provisioned at credentialing, never in source |
| **Adjudication engine** | Runs inside the sequencer process, holds every member's identity preimage, proves on members' and providers' behalf | Runs as the plan's own service, **outside the sequencer**, holding no member identity. Inputs are the pharmacy's claim, the member's credential or attestation, the formulary and the plan rules |
| **Member accumulator** | Updated by the engine proving a member wallet update from the stored preimage on every fill | A **plan-side accumulator record** keyed by wallet ID, updated by a proof the claim path generates. The member's wallet changes only on member-initiated events. See section 7 |
| **Proof acceptance** | Applied when the caller's claimed roots match; the verify call is a library no-op | Verified against a pinned verification key **before any mutation**, and rejected otherwise |
| **Trust layer** | One `L2Node`, no partitioning, dead replication, WAL null, quorum unreachable, chain proof off | At least three leviathan nodes under **separate operational control**, partitioned, authenticated gossip, WAL fsynced before mutation, client acknowledgment only after a quorum majority has logged and signed, heartbeat failover, chain proof producing a non-zero global state root, state certificates at every batch boundary |
| **Credentials** | One shared `admin123`-class token is the sequencer bearer, every node's bearer, and the insurer's signing seed | Per-role credentials from a provisioning mechanism, Ed25519 admin mode armed with a genesis key, TLS on every listener, no environment inheritance to child processes, attestation and quorum keys in a KMS or HSM |
| **Test fixtures and local-only paths** | Fixture identities, committed keys, badge PIN `000000`, `PLAN-GOLD-2026`, `ACME-CORP`, the unsecure path | Relocated to a test-only module tree. The production entry point **cannot reach them**, asserted by an import-graph test and a startup guard that fails closed. Removed and re-verified as the last step before the release is tagged |

## 4. Phases

Finding IDs refer to `docs/AUDIT.md`; `C-n` to `docs/INTENDED-VS-ASBUILT.md`. Each item names the rule it serves.

### Phase A — Close the remote surface and the proof gate

The exploitable perimeter, plus the one integrity fix that everything downstream depends on. No change to the pill pipeline.

| # | Work | Rule | Finding |
|---|---|---|---|
| A1 | **Verify every submitted proof against a pinned verification key before any mutation.** Import the program verifier, compare the verification-key hash, reject on failure. Reject structurally undecodable proofs with a distinct error. Remove the fingerprint record from the pre-check path so a rejected submission leaves no trace | I7 | A-3, C-1 |
| A2 | Bind every listener to loopback or a private interface; replace CORS `*` with an explicit allowlist; enable TLS on every listener; stop the `/rpc` proxies widening reach, with a per-role method allowlist | I4 | A-7 |
| A3 | Remove `/onboarding/backup-key`, the caller-supplied key path in `generate-key`, and `restore-key` from any network surface. Backup and restore become in-app operations writing the offline card | I3 | A-5, MEM-C1, C2, H2 |
| A4 | Clear the derived key when unlock fails; require a fresh PIN for eject; attempt limits with backoff on unlock and on PIN verification | I3, I4 | A-20, MEM-M2 |
| A5 | Device auth on every member-node route that remains, and remove `walletId` and the enrollment token from `/health` and `/onboarding/status` | I4, I7 | A-7, MEM-H1 |
| A6 | Enrollment codes become cryptographically random and single-use: random token IDs, consumed on successful validation, rate-limited, and the validate oracle authenticated | I5 | AUTH-13, C-2 (FIG. 4 `456`) |
| A7 | Move the HR Tool off the insurer host onto the employer's own machine. Remove plaintext PINs from exports and from `/api/employees`. Passphrase policy with confirmation and attempt limits. Stop writing employee identifiers to the plaintext audit log | I5 | A-21, CONT-3 |
| A8 | Gate `activate-status` and `activate` behind insurer admin; never return a tenant admin token on an open route; rotate the four tokens already exposed | I7 | A-4 |
| A9 | Split the shared admin token into per-role credentials. Stop shipping the network admin token to member and provider nodes. Give the insurer a dedicated attestation signing key, not the admin token | I7 | A-14 |
| A10 | Authenticate the sender on `storeMessage`; require a proof for `registerPcpAssignment`; require an ownership proof before `requestAttestation` signs, and pin the verifying key instead of reading it from the attestation | I7 | A-12, A-15, A-16 |
| A11 | Admin-gate `/interactive/state` and strip identity-linked fields from it; admin-gate `update-provider-network`; admin-gate the batch and checkpoint controls | I1, I7 | A-13, A-19, ENG-11 |
| A12 | Fix the two broken routes: the proof-pool credential job type mismatch, and the undeclared identifier that makes member and family history return 500 | correctness | A-24 |
| A13 | **Give the replicas credentials so gossip is actually delivered**, and add an invariant monitor that alarms when a replica's root diverges from the leader's or a batch stalls. This is the prerequisite for phase E, and the monitor is what should have caught 29 hours of dead replication | availability | A-8, C-3 |

**A1 implementation spec.** Written out because it goes first and because getting the ordering wrong would leave the hole open while looking closed.

*Where the verification key comes from.* The sequencer does not compile `StateTransitionProgram` today. Add a compile at boot and keep the verification key in memory. Measured cost on the live member node: **3,803 ms, once**. Assert the key's hash equals a constant pinned in config and **fail closed at boot** if it does not, so that swapping the program is detected rather than silently accepted.

*The call.* `verify(proof, verificationKey)` from o1js, the same function the harness already uses at `scripts/e2e-verify/run.ts:493` to check batch proofs, with the tamper case beside it at `:501`. That is the pattern to copy; it is proven against this codebase's own proofs.

*Ordering, which is the whole point.* Verification becomes the first thing `submitProof` does. Nothing may happen before it returns true. In the current body at `l2-sequencer-service.ts:291-471` that means it precedes the fingerprint insert at `:298-302`, the partition check at `:305`, the root assertions at `:318-340`, `planTreeUpdate` at `:344`, the WAL append, the apply at `:374-378`, the receipt at `:381`, the audit event at `:398-423`, the claim leaf at `:429-457`, and the gossip broadcast.

*Fingerprint handling.* A-3 also found the fingerprint recorded before the checks and never removed when a later step throws, so a rejected submission permanently poisons that transition. Wrap the body so the fingerprint is removed on any throw, or insert it only once every check has passed. Either is fine; leaving it as is means a failed submission can block the honest retry.

*Distinct errors.* Return different codes for an undecodable proof, a proof that fails verification, and a root mismatch. Today all three collapse into one shape, which is why the audit's probe could not tell a structural decode failure from a cryptographic one without reading the library source.

*Acceptance.* `check-proof-gate.ts`, itself an A1 deliverable, submits four things in order: a well-formed proof with a tampered public output; a valid proof re-pointed at another wallet; a structurally undecodable proof; and one honest proof. The first three must be refused, and the check must assert **no mutation** by comparing status, receipt count, audit-log length and claim-leaf count before and after, not merely that an error came back.

*One thing to measure.* Verification now sits on the submit path. Record the per-proof cost. If it is material at volume, it can move into a proving-pool worker, but only with care: the ordering guarantee above is what makes A1 worth doing, and making verification asynchronous would give it back.

### Phase B — Keep identity on the device

The largest phase, and the one that changes the pipeline. Section 7 covers the consequences.

| # | Work | Rule | Finding |
|---|---|---|---|
| B1 | **The device proves its own wallet updates.** Move wallet-update proving out of the engine and into the member app. The engine stops holding member preimages and stops proving on members' behalf | I2 | A-1, C-1, ENG-02 |
| B2 | **Stop sending the preimage.** `register-member` takes a verified registration proof and a wallet ID, nothing else. Delete the preimage fields from the engine's state and from `adjudication-state.json`, and purge the existing file | I2 | A-1, A-6, C-2 |
| B3 | **Split the fill into adjudicate-then-finalize.** The accumulator stays on the member's credential, where the design puts it. The pharmacy adjudicates on the member's prescribing-time authorization and commits a **pending** settlement; the member's offline attestation at pickup finalizes it and applies the accumulator delta; an unclaimed fill reverses after a window using the reversal path that already exists. See section 7 | I2 | A-1, A-11 |
| B4 | Providers prove with keys held in a FIDO2 authenticator, wrapped under its `hmac-secret` so no server can reconstruct one. Retire the passive-tag badge service. Remove the committed fixture enrollment keys and the NPI-derived provider keys from every runtime path. See the design note below | I3 | A-14, ENG-14 |
| B5 | Enforce PCP consent at prescribing: a prescriber who is not the member's consented PCP needs member approval. Add the lifecycle check that today lets revoked and terminated members be billed | I7, correctness | A-16, A-18 |
| B6 | Stop sending the wallet ID to the employer. Remove `/enrollment/confirm`'s wallet storage and the roster's wallet column, so I6 holds by construction rather than by a 401 | I6 | A-9, PHI-9, C-2 |
| B7 | Fire the lifecycle transition the design specifies: ELIGIBLE to ACTIVE on first claim | correctness | C-2 (FIG. 5 §D) |
| B8 | Remove the post-proof settlement rewrite so the committed amounts and the recorded amounts agree. If family pooling must adjust a split, it is computed inside the circuit | integrity | A-23, C-4 |

**Phase B design note: provider authentication and e-prescribing.**

The constraint is that clinicians will not adopt a new ritual, so the credential has to ride on something already on the lanyard. The instinct to bind to the employer badge is right, and it also matches this system's trust model: the provider's key should be in the provider's physical possession so that no central party can prescribe as them.

Three things it has to get right.

*Two cards are one factor.* A zpk.care tag and an employer RFID badge on the same lanyard are both "something you have," they travel together, and they are lost together. Both are passive, so anything that can read one can read it. This matters beyond good practice: DEA EPCS (21 CFR 1311) already mandates two-factor at the moment of signing for controlled substances and explicitly does not accept two possession factors. It wants two of possession, knowledge and biometric. The engine already special-cases Schedule II, so this regime applies.

*The key must not sit whole on a passive tag.* Today `createProviderBadge` writes the entire enrollment key to the tag, AES-256-GCM under scrypt of a six-character PIN, with the salt and IV beside it. A passive read yields everything needed to brute-force the PIN offline, where no rate limit or lockout applies. One million candidates is hours on commodity hardware.

*Decision: a FIDO2 hardware key replaces the passive tag.* This is better than splitting the key between a tag and the server, and it removes a custom protocol we would otherwise have to design and get right. Retire `provider-badge-service.ts` rather than fixing it.

The mechanism is the CTAP2 **`hmac-secret`** extension. The authenticator derives a deterministic symmetric secret from the credential plus a salt, and will only do so after user verification. Wrap the provider's enrollment key under a key derived from that secret. The ciphertext can then live anywhere, including on our own server, because:

- the wrapping secret never leaves the hardware, so there is nothing to read off a tag in a corridor and nothing to brute-force offline;
- the PIN retry counter is enforced **in hardware**, typically eight attempts before lockout, which is the rate limiting we were going to have to build;
- the service holds ciphertext it cannot open, so it cannot prescribe as a provider even if it wanted to;
- the key signs a challenge, so nothing secret crosses the wire and replay is prevented;
- FIPS-series keys satisfy EPCS's hard-token requirement directly, and this is a trodden path rather than an invention. `systemd-cryptenroll` unlocks LUKS volumes with exactly this extension.

| Element | Role | Factor type |
|---|---|---|
| Employer RFID badge | Identifies who is at the workstation and ties our audit trail to the hospital's own access control. Not a secret | none, convenience and identification |
| FIDO2 key, NFC-capable | Holds the wrapping secret in its secure element; unwraps the enrollment key on user verification | possession |
| Key PIN | Gates the authenticator, with hardware-enforced lockout | knowledge |

Prefer an **NFC-capable** key so the gesture is a tap rather than a plug. At a shared clinical workstation, tap is the same motion as the badge and does not depend on which USB port is reachable or what shape it is. Discoverable credentials let the key carry the identity, so nothing has to be typed to identify the provider.

*Friction budget.* Three actions at every signing is one too many for someone writing thirty scripts a day. EPCS requires the two factors at each signing of a controlled substance, and imposes nothing on the rest. So: badge tap opens the session and ties the audit trail; the key plus PIN is required once per session for ordinary prescribing with a timeout; and the key is touched at each signing of a controlled substance, which is how existing EPCS systems already work.

*Recovery, which this design makes mandatory.* If the enrollment key is wrapped under one authenticator's secret and that key is lost, the wallet is unrecoverable. Register **two keys per provider** at credentialing and wrap the enrollment key under both, so either opens it. That is standard FIDO practice. The second route is `WalletMigrationProgram`, which already proves identity continuity across a key change and is currently dead code; reviving it for providers is the same work as reviving it for members in C3.

*Onboarding that is not prohibitive.* Credentialing already exists as a one-time step with NPI, DEA and a lifecycle state in the provider registry. Add to it: the provider generates their enrollment key at the provisioning station or on their own device, never derived from the NPI, which is public; the key is split and one share written to the tag; the tag's identifier and the employer badge's identifier are both bound to the provider's wallet. Day to day is then tap, PIN, prescribe.

*What actually makes an eScript safe to rely on.* Authentication has to happen at signing, not at session start, which is also what EPCS requires. And the prescriber's identity proof has to be **submitted and verified rather than discarded**, which is finding A-22: today the proof is generated and thrown away, so a pharmacy cannot verify that the named prescriber authorized the script. Fixing A-22 is what makes the eScript verifiable, not new machinery. The DEA number check and the Schedule II refill rule already exist and stay.

*Decisions this needs:* the per-provider hardware budget, since two keys each at roughly 25 to 50 dollars is 25 to 50 thousand for a five-hundred-prescriber system, plus a replacement workflow; and whether the employer badge is worth integrating at all, given that it is convenience rather than a factor once the authenticator is in place.

**Scoping decision, 2026-10-16: controlled substances are out of the first production release.** Release one is the adjudication layer, where the innovation lives and where the DEA has no jurisdiction. Three things follow.

*Whether EPCS applies at all depends on which role we occupy, and the adjudicate-first flow puts us in an ambiguous one.* The rule governs the application a practitioner uses to create and sign a prescription, and separately the pharmacy application that receives it; intermediaries in the transmission path have their own narrower obligations, principally that the record is not altered. For **non-controlled** prescribing the DEA imposes nothing, so being in the transmission path is free, constrained only by NCPDP SCRIPT and the network's commercial rules. For **controlled** substances, the moment we sit in that path we acquire obligations, and which set depends on definitions in 1300.03 and 1311.100 that need a regulatory attorney rather than an engineering reading. A later option preserves the architecture: let the script be composed and signed in a certified application and have our adjudication ride alongside as a priced attachment rather than as the prescription of record.

*Our cryptography does not help us here, and assuming otherwise would be an expensive surprise.* EPCS leans on FIPS-approved algorithms for the signing and token side. Poseidon and the Pickles proof system are not FIPS-validated and will not become so. Being cryptographically stronger is not the same as being compliant, because the rule names mechanisms. The resolution is to keep a **FIPS-approved signature on the regulated artifact**, which the NFC attestation code already does with Ed25519 through Node's crypto, and let the zero-knowledge layer do the adjudication work beside it. Do not plan on a ZK proof satisfying a signature requirement.

*The patient-identity requirement bites only on the controlled path.* Federal rules require a controlled-substance prescription to carry the patient's full name and address, which this design never transmits. The resolution, decided 2026-10-16 and deferred to a later build, is a **QR code the member's app generates at the counter** for the pharmacy to scan: no new hardware, and visible consent. The disclosed elements stay in that pharmacy's records as a covered entity already holding such data, so I2 holds for the network with one consented carve-out, to one pharmacy, for one script.

The code must **not** contain the name and address. A QR on a lit screen is readable by anyone who photographs it. It carries a single-use, short-expiry nonce bound to the prescription, and the identity elements ride with the script encrypted to the dispensing pharmacy's own key, openable only with that nonce. Two of two, and it works offline, which the counter requires. Needs a dead-phone fallback where the member shows physical identification and the pharmacy records it by hand, as happens today. Full entry: `docs/RISK-LOG.md` CMP-2.

On the adjudication side the question does not arise, because the pharmacy already holds the patient's details from the script that reached it through its normal channel.

### Phase C — Salt the identity fields and migrate

Must be one operation, because every item here changes the wallet ID.

| # | Work | Rule | Finding |
|---|---|---|---|
| C1 | Add a per-member random salt, generated on the device, stored in the keystore and on the offline card, mixed into every identity field hash. This turns claim 12(d)'s irreversibility premise from false to true | I2, I3 | A-1, C-2 |
| C2 | **Pass the real group and plan through enrollment** so the member is bound to the plan their employer bought. This changes `groupIdHash`, which is why it rides this phase and not phase B | correctness | A-9, BIND-1 |
| C3 | Update the wallet migration proof for the salted preimage, and revive the recovery card path: a working export, a format that matches on both sides, and no key in browser storage | I3 | A-1, MEM-M5, MEM-H4 |
| C4 | Migrate or re-enroll existing wallets. Decide first whether there is live data to preserve (see section 8) | — | — |

### Phase D — Authorize reads and bind the record

| # | Work | Rule | Finding |
|---|---|---|---|
| D1 | **Wallet-ownership proofs for member-data reads.** No bare wallet ID returns claims, receipts, messages, accumulators, PCP links or audit entries. This is the fix that makes the open-read design safe once C1 has made the commitments opaque | I6, I7 | A-2, C-2 |
| D2 | Authenticate the remaining open state-changing routes and RPC methods; remove `recordFill`'s no-proof path | I7 | A-27, AUTH inventory |
| D3 | End-to-end encrypted messaging with keys derived on the device, so the sequencer cannot decrypt. Remove the base64 and hex-plaintext fallbacks | I2 | A-15, C-2 (claim 15) |
| D4 | Fix the duplicate-fill path so a claim is either rejected before payment or recorded. Reconcile the two accumulator divergences | integrity, money | A-10, A-11 |
| D5 | Bind the money into the audit chain: populate the amount fields, wire the enrichment that currently has no callers, make the financial balance check meaningful, and correct the 8-versus-10-field documentation | integrity | A-26, C-4 |
| D6 | Encrypt claim data at rest in checkpoints, and the engine state file | I1 | A-1, BOOT-06 |

### Phase E — Turn the trust layer on

Mandatory for production. Depends on A1 and A13.

**Why this is a continuity requirement, not a scaling nicety.** The snapshot for each recursive proof lives on the leviathan nodes, and the leviathans share a heartbeat and partitions with each other precisely so that losing one does not cut or halt service. That is the whole architecture: proof state is held by the node set, and the failover chain keeps the partition serving when a leader goes.

Right now none of it is in force. Both replicas hold zero receipts and sit at the genesis root, because gossip is delivered over an admin-gated method to replicas that carry no credential. So the proof set lives on exactly one node, with only disk checkpoints behind it. **Losing that one process today means losing the live proof state**, and the heartbeat and failover that are supposed to prevent exactly that have never run outside the test suite. This is why A13 sits in the first phase and why E is not optional for production.

| # | Work | Rule | Finding |
|---|---|---|---|
| E1 | Run at least three leviathan nodes with partitioning enabled. Partition assignment, exclusive acceptance and the client-side router all exist; switch them on | availability | C-3, claim 12 |
| E2 | Authenticated gossip with per-node credentials, and signatures covering the payload rather than only the header | integrity | A-8, REP-03 |
| E3 | WAL enabled and fsynced before mutation, with crash replay and compaction after checkpoint | durability | C-3, claim 18 |
| E4 | Quorum writes: no client acknowledgment until a majority has logged and signed. Quorum certificates on receipts, state certificates at batch boundaries | durability | C-3, claims 18, 10(d) |
| E5 | Heartbeat failover and split-brain demotion in the live topology | availability | C-3, claim 14 |
| E6 | **Enable the chain proof** so the global state root and block height are non-zero, binding the audit chain into one verifiable commitment | integrity | C-4, claims 8(c), 9, 11(b) |
| E7 | Replica batch verification enabled, so a replica checks before it applies | integrity | A-8, REP-02 |
| E8 | Epoch accumulator rotation wired into the product, with persistence | scale | claim 16 |

### Phase F — Isolate the fixtures and cut the dead ends

**What the fixture work is actually about.** The committed enrollment keys and the badge PIN are fake and will never be used again, so this is not secret hygiene. Two real risks remain and neither is about the values:

1. **Code paths that accept or derive identity material.** `generate-key` accepts a caller-supplied enrollment key; provider keys are derived from the NPI, which is public; the engine proves on others' behalf from stored preimages. Those paths are the exposure whatever flows through them. If production can still accept an externally supplied key, an attacker supplies a real one.
2. **Reachable fallbacks that produce a valid-looking result without the real check.** The unsecure path, the hard-coded `verified: true`, the fixture PIN constant, the default plan and group. Each is a branch that answers correctly-shaped without answering correctly.

So the guard is a **reachability assertion**, not a secret scan: an import-graph test proving the production entry point never transitively reaches the fixture tree, plus a startup check that fails closed. That is a property which keeps holding, unlike deletion, which anyone can undo with one import.

**Sequencing.** The acceptance tests use fixture identities, so the fixtures cannot be deleted before the tests pass. Relocate them to a test-only tree early so the guard can assert isolation, keep them for the harness, and make removal plus re-verification the last step before tagging a release.

| # | Work | Rule | Finding |
|---|---|---|---|
| F1 | Relocate fixture identities, committed keys, the badge PIN constant and the default plan and group into a test-only module tree. Add the import-graph test and the fail-closed startup guard. **Pull this forward to phase A**, because it is what proves isolation for everything after it | I3, I7 | A-14, ENG-16 |
| F1b | Remove the unsecure path entirely rather than guarding it. There is no production use for an entry point that sets a shared token and opens CORS | I4, I7 | A-7, A-14 |
| F1c | Delete `src/poc/` (8 files, 3,571 lines). It is unreachable from the production launcher, it is the only place "proof of concept" language survives in the codebase, and its one remaining purpose, generating patent evidence, ended with the filing. Drop the two npm scripts that reach it. `EpochAccumulatorService` lives in `src/l2/` and is unaffected | clarity | §3 |
| F2 | Remove the MINA vestiges: `l1Status` naming, the settlement strategy hook, and any "settled on L1" language. Finality is the quorum and chain proof | clarity | memory note |
| F3 | Delete or wire the dead paths the audit found: the unused verification services, `CareContract`, the unused proof delegate, `UserWalletService`, `AorService`, and the claim-16 service that only the evidence generator constructs | clarity | zk-programs, A-17 |
| F4 | Fix the remaining medium and low findings not otherwise placed: the badge session nobody checks, the mutating GET, unbounded bodies and job maps, restart losing encryption keys and revocations, the engine's constant-message admin signature, the caller-supplied content hash | I7 | AUDIT medium and low |
| F5 | Key management: attestation and quorum keys in a KMS or HSM; documented rotation | I7 | A-12, A-14 |

## 5. Execution order

Letters name the phases; this is the order to execute them in. Two items move from the phase they were originally filed under, and the reason matters.

1. **A1 first, on its own.** Verifying proofs at submission is roughly twenty lines: import the verifier, pin the key, reject on failure. It was originally filed under phase D. It moves to the front because it is the system's headline property, because every other phase builds on a ledger you can trust, and because phase E would otherwise replicate unverified state across three nodes and sign quorum certificates over it. Nothing else in the plan is as small relative to what it buys.
2. **Rest of phase A.** Independent of the pipeline, highest exploitability, and A13 unblocks phase E.
3. **Phase B.** The architectural phase. B3, the plan-side accumulator, is the piece that makes the rest of B possible without breaking the pharmacy counter.
4. **Phase C.** One operation, because every item changes the wallet ID. **C2, the plan and group binding, moves here from phase B** for exactly that reason: it changes `groupIdHash`, so doing it separately would mean migrating wallets twice.
5. **Phase D.** D1 depends on C1: ownership proofs are the access control, and salting is what makes the commitments opaque in the first place. Doing D1 first would be defense in depth over a broken premise.
6. **Phase E.** Depends on A1 and A13.
7. **Phase F, mostly early.** F1 (relocate the fixtures and assert isolation) and F1b (remove the unsecure path) move into phase A, because every later phase is easier to verify once the production entry point provably cannot reach a fallback. F1c (delete `src/poc/`) can be done at any time. The rest is continuous cleanup.
8. **Last step before a release is tagged:** delete the fixture tree, re-run every acceptance check against a network built without it, and tag that verified state. The fixtures cannot go earlier, because the acceptance tests use them.

One sequencing warning. B2 purges stored preimages and C1 changes the derivation. If there is live member data to preserve, the migration in C4 has to run while the old preimages still exist, which means **C4's migration plan has to be decided before B2 deletes anything.** Decide section 8's question 5 before starting phase B.

## 6. Acceptance tests

Every fix phase ends with: the unit tests for the touched code, the checks below for the rules that phase touched, and a live `run-multi.ts` on a fresh network. Paste the summary lines into this file.

Three check scripts exist. Five are new and are themselves phase deliverables.

| Rule | Check | Passes when |
|---|---|---|
| **I1** | `check-phi-containment.ts --strict`, extended with the nine gaps listed in `docs/audit/phi-pii.md` (decrypt the HR correlation table, decode message payloads, treat clinical claim data as a target, scan skipped PDFs, stop assuming the employee ID equals the cardholder ID, capture browser storage) | No plaintext PHI or employee identity in any store, log, API response or browser store outside the device that owns it. Clinical claim data encrypted at rest |
| **I2** | `check-phi-containment.ts --strict` **plus a new `check-reversal.ts`** that rebuilds the 37,572-entry date table and a name dictionary and runs them against every store and API | Zero per-field hashes, zero enrollment-key hashes and zero preimages outside the device, **and** the reversal attack recovers nothing. The second half is the real test: after phase C it must fail even if a hash does leak |
| **I3** | A new `check-key-custody.ts`: attempts export, injection and overwrite of the enrollment key through every remaining interface; inspects browser storage; round-trips a recovery card | The key appears nowhere off the device. No interface exports or replaces it. The card round-trips and restores a working wallet. A failed unlock leaves the device locked |
| **I4** | A new `check-surfaces.ts`: enumerates every listener and its bind address, replays each state-changing route unauthenticated and from a foreign origin, and walks the `/rpc` proxies | Every listener is loopback or private with TLS. Every unauthenticated or cross-origin attempt is refused. No proxy reaches a method the caller could not reach directly |
| **I5** | `check-phi-containment.ts` with the HR table decrypted, plus a code-lifecycle test | Employee identity exists only on the employer machine. Only salted commitments and a random single-use code leave. A code validates once and is refused the second time. No export contains a PIN |
| **I6** | The containment check's linkage pass, extended to pull the real employee ID from the HR table | No store outside a device holds both a wallet ID and its employee identity. The employer roster has no wallet column. The insurer can link code to wallet but not code to employee |
| **I7** | `check-surfaces.ts` plus a new **`check-proof-gate.ts`** that submits, in order: a well-formed proof with a tampered public output; a valid proof re-pointed at another wallet; a structurally undecodable proof; and one honest proof | The first three are refused **at submission**, with no mutation of trees, receipts, audit chain, claim ledger or gossip. The fourth is accepted. Every state-changing route refuses an unauthenticated caller |
| **Trust layer** | A new `check-trust-layer.ts` | At least three nodes, partitioning on, every replica's root matching the leader's within a bounded interval, a WAL file fsynced before mutation, a quorum certificate on a receipt, a state certificate at a batch boundary, a chain proof with a non-zero global state root, and a leader failover completing without data loss |

Two notes on method. The reversal check in I2 and the tampered-proof check in I7 are the two tests that would have caught the worst findings in this audit, and neither existed. Both must run on a network with real proving enabled, not against mocks. And `check-proof-gate.ts` must assert the absence of mutation, not merely the presence of an error, because today a submission can be refused late and still have left a fingerprint behind.

## 7. Impact on the pill pipeline

Phase B is the only phase that changes how a prescription becomes a paid claim. The change is worth stating carefully, because the obvious version of "the member proves their own updates" would break the pharmacy counter.

**Today.** The engine, inside the sequencer, holds every member's identity preimage. On a fill it generates the fulfillment proof using provider keys committed to the repository, then generates a member wallet-update proof from the stored preimage, then submits. Nothing about this requires the member to be present or online, because the sequencer can act as any member.

**Presence and connectivity are different requirements, and conflating them produces the wrong design.** The member is at the counter at pickup; that is where pickup happens. What the member must not need is a working network connection, and that is what the offline attestation solves. So the accumulator stays on the member's credential, where the design and claim 1(c) put it, and the fill splits into two moments.

**Adjudicate first, then send the priced script to the pharmacy** (owner decision, 2026-10-16). Because adjudication is deterministic and in-circuit, and because the formulary, the plan rules and the accumulator are all known at prescribing, the price can be computed before the script ever reaches a pharmacy. This is a real advantage over the traditional flow, where the pharmacy submits a claim and waits for a price: there is no claim round-trip and no switchboard, and the patient learns the cost while still in the room with the prescriber, which is where abandonment at the counter comes from.

| Moment | Member there? | What happens | What proves it |
|---|---|---|---|
| **Prescribing, where adjudication runs** | Yes, with the prescriber, or not at all if the prescriber is the member's consented PCP | The member authorizes the medication. Formulary, plan rules and the accumulator are read, the cost share is computed, and the settlement is committed **pending**. The price is shown before the patient leaves | The prescriber's device proves identity with its own authenticator; the adjudication circuit proves the price follows the published rules |
| **Transmission and dispense** | No, and does not need to be | The pharmacy receives a script with the price already attached and a proof that the price is correct. It dispenses at that price | The pharmacy verifies the adjudication proof offline, against a cached verification key |
| **Pickup at POS** | Yes, by definition | The member taps the card or phone. This finalizes the pending settlement and applies the accumulator delta | The **offline attestation**: signed, time-bound, verifiable with no connectivity, which is the mechanism claim 17 already describes |

An unclaimed fill reverses after a window, using the reversal path already in the circuit. This matches how pharmacy actually works: a filled prescription nobody collects is reversed after a week or two, and the code already has the primitive for it.

What this buys: the accumulator stays member-side, so the member keeps their own benefit state rather than reading a copy of the plan's; connectivity is required nowhere in the chain; and the only moment that needs the member is the one where the member is standing there.

Three design questions it leaves open, which phase B has to answer rather than discover:

- **The read-then-write window, which adjudicating at prescribing makes wider, not narrower.** Adjudication reads the accumulator when the script is written; finalization writes it when the member collects. That gap is now days or weeks, not minutes. Two scripts written in the same window both read the same deductible state and both quote as though the member owes it. The pending settlement already lands in the TRANSACTION tree, so the answer is that a pending delta must be visible to the next adjudication and reserved against. This is no longer an edge case; it is the normal path for anyone on multiple medications, so it has to be designed, not discovered.
- **Stale quotes: re-adjudicate, and treat the quote as a ceiling.** A price computed at prescribing can be stale by collection, but the drift is not symmetric. Within a plan year the deductible paid and the out-of-pocket total only rise, so the patient's share almost always moves **down** between the quote and the counter: the deductible gets met, or the out-of-pocket maximum is reached. The single exception is the annual benefit maximum being exhausted, which moves it sharply up. So neither pure option is right. Honouring the quote blindly makes the patient overpay in the common case; re-adjudicating blindly reintroduces the counter surprise that makes people walk away. Charge **the lower of the quoted price and the re-adjudicated price**. The promise made in the office is never exceeded, the patient keeps any favourable drift, and the plan absorbs a difference only in the rare case where the price rose.
- **The one case that needs an escape hatch.** If the re-adjudicated price is materially *higher* than the quote, the cause is benefit exhaustion, and that is something the member needs to be told rather than silently charged. The pharmacy declines, returns the stock and requests a fresh script, which forces a fresh adjudication and a fresh conversation. This is an existing pharmacy workflow, not a new one: unclaimed fills already go back to the shelf and get reversed, and the reversal path is already in the circuit as operation type 2.
- **What the tap actually proves.** A card-only pickup proves the *card* is present, not the member. That is a feature for a caregiver collecting on someone's behalf and a problem for a stolen card. The representative mechanism already in the code, domain tag 3, is where delegated pickup belongs, with its own authorization rather than by sharing a card.
- **Mail order has no POS moment.** It needs either a delivery-confirmation equivalent or a finalize the member pre-authorizes at prescribing. Decide before B3 ships, because it changes what the pending commitment has to carry.

Two consequences that hold regardless:

- **Latency improves.** Today a fill waits on the single-threaded engine generating two proofs inside the sequencer process. Afterwards the fulfillment proof is generated at the pharmacy and the batch pool aggregates, so the counter is not blocked on the sequencer's proving lock.
- **Revocation still needs an online path.** Offline verification means a pharmacy can honor a credential revoked since it was issued. The time-to-live tiers already in the code are the right shape, with dispensing shortest at four hours. Production needs a revocation check when the pharmacy is online and a bounded staleness window when it is not.
- **The engine's move out of the sequencer** is the enabling refactor and the biggest single piece of work in the plan. Until it happens the sequencer can still act as any member, so B1 and B2 are not really complete.

Phases A, C, D, E and F do not change the pipeline's shape. C changes wallet IDs, which is a migration rather than a flow change. E changes where proofs are stored and how acknowledgment timing works: a client waits for a quorum majority instead of a single node, which adds a round trip and is the point.

## 8. Decisions needed from the owner

These are not engineering choices and they gate the phases named.

1. **Member app platform.** I3 says hardware keystore. Which platforms, and does the first production target include a native app, or does phase B land against the harness first? *Gates B1.*
2. **Who runs the leviathan nodes.** A quorum of three nodes under one operator's control is a durability mechanism, not a trust mechanism. If the claim of no single trusted operator is to mean anything in production, the nodes need separate operational control. *Gates E1 and E4.*
3. **Does the engine move out of the sequencer process.** It is the largest refactor in the plan and the thing that makes B1 and B2 real. *Gates the completion of phase B.*
4. **Who proves the plan-side accumulator update,** the pharmacy or the plan service, and does the member get a verifiable witness of it. *Gates B3.*
5. **Is there live member data to preserve,** or can production start from genesis? If there is, the migration has to be designed before phase B deletes the stored preimages. *Gates B2 and C4.*
6. **Offline tolerance at the pharmacy.** How stale may a credential be when the pharmacy cannot reach the network? This sets the time-to-live tiers and the revocation design. *Gates D1 and the counter flow.*
7. **Key management.** KMS, HSM or operator-held for the attestation authority and the quorum keys, and the rotation story. *Gates A9, E4 and F5.*

My recommendations, for what they are worth: take A1 this week regardless of anything else; decide question 5 before touching phase B; and treat question 2 as a business decision rather than a technical one, because it determines whether the system's central claim survives contact with a real deployment.

---

## State of work (2026-10-16, Session 1: code map)

Done: `docs/CODEMAP.md` (hub) and `docs/codemap/*.md` (9 files, 1,964 lines) written from the working tree. No source changed. Memory index trimmed to one line per entry.

New facts for the audit (details in `docs/CODEMAP.md` §10): the booted sequencer is a plain `L2Node`, so WAL, quorum and failover are dormant; no cryptographic verification of submitted proofs before the batch circuit, and replica verification is the same no-op; Ed25519 admin modes are dormant and weak where present; one admin token serves every process and seeds the insurer's attestation signature; checkpoints hold claims in the clear and `adjudication-state.json` holds member preimages; Nautilus `/rpc` and explorer proxies forward without credentials; the HR Tool runs inside the insurer process; seed and provider enrollment keys are committed and derivable from the NPI; the employer roster stores wallet IDs when `/enrollment/confirm` succeeds; about a dozen static defects.

Corrections to earlier notes: the "PCP root overwritten" box in the route-map artifact does not hold (PCP leaf is MEMBER leaf 0 and is restored intact, `interactive-service.ts:4752, 5673-5680`); the Nautilus `/rpc` proxy attaches no Bearer token (memory note corrected); `interactive-service.ts` line numbers in the artifact have shifted, use `docs/codemap/engine.md`.

Next: Session 2 (defect and PHI/PII audit) starting from `docs/CODEMAP.md` §10 "Session 2 start".

## State of work (2026-10-16, Session 2: defect and PHI/PII audit)

Done: `docs/AUDIT.md` (hub, 27 ranked findings: 7 critical, 20 high, ~40 medium/low) plus seven detail files in `docs/audit/` (913 lines total). Audited against the live network that has been up since 2026-10-15, not a simulation. `scripts/e2e-verify/check-phi-containment.ts` extended from 4 scanned places to 15, with the raw enrollment key added as a target, an I6 wallet-to-employee linkage pass, a per-rule verdict, and `--strict` for use as an acceptance test. No other source file was modified.

Rule verdicts from the live run: **I1 holds literally but is defeated in effect, I2 broken, I3 broken, I4 broken, I5 broken in deployment, I6 holds by accident, I7 broken.** See the audit hub for the basis of each.

The seven critical findings, in order: identity recoverable from the sequencer's disk by inverting unsalted hashes (proven: all four members' names and birth dates recovered in 75 s); any wallet ID yields that member's whole record with no credential; acceptance of a state change is gated by Merkle arithmetic rather than cryptography; an open marketplace route hands out employer tenant admin tokens (retrieved and replayed live); the enrollment key is exportable from the phone by any caller; `register-member` provisions an ELIGIBLE wallet with no proof; and `0.0.0.0` plus CORS `*` plus credential-stripping proxies make all of it reachable from any page the member visits.

Two findings are new and have no phase in this plan yet: **A-8**, gossip replication is entirely non-functional (admin-gated relay, tokenless replicas; both replicas hold zero after 19 batches), and **A-18/A-19**, missing lifecycle checks and an open provider-network cascade. Section 4 of the audit hub maps every finding onto phases A-D and flags these two.

Phase-ordering note for section 3 of this plan: fixing the plan/group binding (A-9) changes `groupIdHash` and therefore wallet IDs, so it has to be sequenced against the migration work in phase C rather than done independently.

Next: Session 3 (intended versus as-built against the patent filings). Then Session 4 completes the phases, order and acceptance tests below.

## State of work (2026-10-16, Session 3: intended versus as-built)

Done: `docs/INTENDED-VS-ASBUILT.md` plus a swimlane artifact at https://claude.ai/artifact/5MbBi7TpPtVMeTnTNthxzq.

Authoritative filing established: **claims 1-19**, filed 2026-03-10 (receipt in `USPTO Document Submission/`), with an April 7 substitute specification whose own change list is 37 changes, all figure references and drawing splits, and which explicitly changes no claim, the abstract, or any other body paragraph. The 15-claim v4 set in `Final Submission Version/` and at the repo root is **superseded** and should not be cited as current.

Of the 19 claims: 7 practiced, 7 dormant (implemented with passing tests but not switched on by this launcher), 3 contradicted by the running system, 1 broken at runtime. Four structural contradictions, in the order that matters:

- **C-1** The title property. Claim 5(c) and FIG. 5 require authorization if and only if a valid proof demonstrates knowledge of the preimage; acceptance is actually gated on claimed roots matching, with the verification call a library no-op. This is audit finding A-3 and a code defect, not a missing invention.
- **C-2** Claim 12(d) grounds the open read endpoints in "computational irreversibility of the hash function". That premise is false as implemented, which A-1 proves. Salting the identity fields in phase C makes the claim's premise true, so the fix and the filing point the same way.
- **C-3** Claims 12, 13, 14, 18 and 10(d) describe a distributed consensus-free network. The shipped boot runs one node with dead replication and dormant durability. **Needs a decision, not just a fix:** either wire it into the default boot, or state in the project docs which properties are implemented-and-tested rather than demonstrated-in-deployment.
- **C-4** Claims 8(c), 9 and 11(b) describe a chain proof over a ten-field global state binding the audit chain. Live: `chainProofEnabled: false`, global state root and block height both 0 after 19 settled batches.

Three new small items for the phases below, not previously listed: FIG. 5's `ELIGIBLE --first claim--> ACTIVE` transition never happens (all four live members have claims and remain ELIGIBLE) — phase B; FIG. 4's token `CONSUMED` state never happens on the employer node, so codes stay replayable until expiry — phase A; and the sequencer plus its in-process engine hold member preimages and prove on members' behalf while appearing nowhere in FIG. 4's three-party model — phase B, same work as A-1.

Two items belong with a patent attorney rather than in this plan: the FIG. 5 annotation that the enrollment-key hash is never transmitted, and claim 12(d)'s irreversibility rationale. Both describe the embodiment rather than the claimed mechanisms, and both become accurate once the planned fixes land.

Next: Session 4 completes the phases, order and acceptance tests in sections 3 onward of this plan.

## State of work (2026-10-16, Session 4: plan completed)

Done: this plan, sections 1 through 8. Section 1 is unchanged. Section 2's findings tables were replaced by a pointer to `docs/AUDIT.md`, which supersedes them and is live-verified; the superseded tables are preserved in git history and in the backup noted below. Sections 3 through 8 are new: the production target architecture, six phases with every work item mapped to a finding, the execution order with two justified re-sequencings, acceptance tests per rule I1-I7, the pill-pipeline impact, and seven decisions that gate the phases.

Two framing corrections from the owner, applied throughout: **the target is full production operation**, so the seven dormant claims are work items in phase E rather than a documentation choice; and **there is no MINA L1 and none is planned**, so finality is the quorum certificate, the state certificate and the chain proof, and phase F removes the vestigial L1 naming.

Key design decisions recorded in the plan rather than left to a fix session:
- Verifying proofs at submission moves to the front of the queue, out of phase D. It is about twenty lines and everything else depends on a trustworthy ledger.
- The plan and group binding moves from phase B to phase C, because it changes `groupIdHash` and therefore wallet IDs, and must ride the same migration as salting.
- The member accumulator moves to a **plan-side record** so that a pharmacy fill never requires the member's device to be present. This is what makes "the device proves its own updates" compatible with a pickup window, and section 7 works through the counter flow.
- Five of the eight acceptance checks do not exist yet and are phase deliverables. Two of them, the hash-reversal attack and the tampered-proof submission, are the tests that would have caught this audit's worst findings.

Backup of the pre-Session-4 file: the session scratchpad, `plan-before-session4.md.bak`.

**The fix phases are next.** Note that there are now six phases and 44 work items, not the four phases the original session sequence assumed, because production operation adds phase E (turning the trust layer on) and phase F (removing the scaffolding). Phase A alone is thirteen items. Plan on more than four sessions, and keep one phase per session as the cost rules say.

Start with A1 alone, then the rest of phase A. Decide section 8 question 5 before beginning phase B.
