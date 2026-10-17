# Audit — adjudication engine (visualizer/engine/*, adjudication-state.json)

Static review, 2026-10-16, working tree. Scope: `visualizer/engine/interactive-routes.ts` (R, 2092), `interactive-service.ts` (S, 6789), `proof-pool.ts` (PP, 507), `proof-pool-types.ts` (PT, 161), `proof-pool-worker.ts` (PW, 460), and the `adjudication-state.json` persistence path in `src/nodes/start-leviathan.ts` (L). Not reviewed: sequencer/RPC internals, circuit soundness, identity/key code outside the engine, Nautilus nodes, dashboards. Auth facts verified against `src/l2/l2-rpc-server.ts` (RPC). Server binds **0.0.0.0:3030** (`L:71`); every engine handler writes `Access-Control-Allow-Origin: *`; dispatch is exact `METHOD:pathname` match (`RPC:499-507`); the 9 `ADMIN_ROUTES` (`R:72-82`) use Bearer `ZKTRIDENT_ADMIN_TOKEN` (`RPC:2661-2671`); all other `/interactive/*` and `/node/*` routes are OPEN (no auth, no session, no rate limit).

Owner rules: I1 raw PHI only in member app; I2 only walletId+ZK proofs leave the phone; I3 enrollment key only on phone/NFC; I4 nothing outside the app reaches app data; I5 employee names/IDs stay on employer host; I6 only the member links employee↔wallet; I7 every state-changing/member-data route authenticates, proofs verified at submission.

## 1. Summary

| ID | Sev | Rules | Title | Location | Live check (do not run) |
|---|---|---|---|---|---|
| ENG-01 | CRITICAL | I7,I2 | Unauthenticated register-member provisions ELIGIBLE wallets with no caller proof | R:147-174; S:1554-1601 | POST `/interactive/register-member` with `{walletId=Poseidon(0,f0..f5), preimageFields:[f0..f5], displayName}`, no auth → 200 `{registered:true,lifecycle:"ELIGIBLE"}`; new wallet now ELIGIBLE on the sequencer |
| ENG-02 | CRITICAL | I2,I3 | Member identity preimage incl. hash(enrollmentKey) persisted cleartext; engine proves as any member | S:1601,5083-5112,5696; L:356-359 | Inspect `l2-data/adjudication-state.json` → each `enrolledMembers[].preimageFields` holds 6 decimal Fields (5th = hash(enrollmentKey)); these are the only inputs `proveAndSubmitWalletUpdate` needs |
| ENG-03 | CRITICAL | I7 | Unauthenticated prescribe+fill bills the plan; eligibility/formulary/PA/identity proofs discarded; costs caller-set | R:377-468; S:2298-2303,2665-2666,2805-2824,3020 | POST `/interactive/fill` `{prescriptionId, ingredientCostCents:99999999}` with no auth → `fill-status` returns `planPayCents` scaled to the supplied cost; no eligibility/formulary proof is verified on the ledger |
| ENG-04 | HIGH | I7 | REVOKED members remain billable (no lifecycle check in prescribe/dispense/reverse) | S:2064-2145,2611-2667,3286-3308 | terminate-member (admin), then POST `/interactive/prescribe` + `/interactive/fill` for that walletId → fill succeeds, plan pays |
| ENG-05 | HIGH | I7 | update-provider-network OPEN but runs the admin-class per-member proof cascade | R:1086-1108; S:4435-4568 | POST `/interactive/update-provider-network` `{prescriberWalletId,action:"REMOVE"}` no auth → 200; one submitted wallet-update per active member, every member's eligibility rewritten |
| ENG-06 | HIGH | I5,I6,I4 | GET /interactive/state dumps walletId↔employeeId↔displayName↔credential↔attestation unauthenticated | R:121-139; S:6040-6063,6347-6365 | GET `/interactive/state` no auth → `enrolledMembers[]` with full `walletId`, `employeeId`, `credentialJson`, `lastAttestation`; `walletDirectory` maps every walletId→name |
| ENG-07 | HIGH | I4,I7 | OPEN generate-credential + getState → mint & exfiltrate a member's portable credential/attestation | R:953-998; S:5405-5475,6061-6062 | POST `/interactive/generate-credential` `{walletId}`, poll, then GET `/interactive/state` → `credentialJson` + `lastAttestation` for that member, usable offline at a pharmacy |
| ENG-08 | HIGH | I7,I4 | OPEN member claim/history reads by bare walletId | R:733-801,901-922,512-523,1351-1504 | GET `/node/claims-by-member?walletId=X` (or `/node/dur`, `/node/receipts-by-wallet`, `/interactive/threads`) no auth → that member's cross-pharmacy drug history |
| ENG-09 | HIGH | I7 | Engine attestation signing key derived from a public literal seed | S:511-513,5469-5475,6605-6611 | Reproduce `new SequencerAttestationAuthority(Buffer.from('zkpcare-attestation-authority-seed'))` offline → sign a `{walletId,ls:3}` attestation that `verifyAttestation` accepts |
| ENG-10 | MEDIUM | I7 | Caller-asserted identity/role & no consent on OPEN state-changers | R:525-542,636-676,678-705,707-731,263-290; S:2552-2558,3214-3224 | POST `/interactive/update-rx-status` `{role:"prescriber",actorIndex:0,newStatus:"CANCELLED"}` no auth → cancels another party's Rx; mark-filled takes pharmacy identity from the Rx record |
| ENG-11 | MEDIUM | I7 | OPEN batch/DA control routes | R:1200-1287,1673-1690 | POST `/interactive/simulate-batch-failure` (or `force-batch`/`retry-batch`/`save-checkpoint`) no auth → 200, batch state mutated |
| ENG-12 | MEDIUM | I7 | GET step-therapy-check mutates formulary + every member's eligibility/credential | R:1133-1157; S:1989,809-866 | GET `/interactive/step-therapy-check?memberWalletId=X&ndcHash=<backfill drug>` no auth → formulary root changes, all members' eligibilityData rewritten, no wallet update submitted |
| ENG-13 | MEDIUM | — | Family-pooling pay rewrite: settlement commitment ≠ claim metadata | S:2824-2825,2908-2920,2962-2977,3008-3014 | Enroll ≥2 members same `familyId`, fill past pooling threshold → settlement leaf (proof pay) and `l2_getClaimsByMember` (pooled pay) report different patient/plan pay for the same fill |
| ENG-14 | MEDIUM | I1,I3,I7 | Seed enroll handles raw member PII + committed enrollment keys in-process; insurer/seed X25519 keys are source constants | S:1011-1061,774-787 | POST `/interactive/enroll` `{memberIndex:0}` → engine reads `MEMBERS[0].enrollmentKey` + raw name/DOB in the sequencer process; `ADMIN-INSURER-ENCRYPTION-KEY-2026` derives the insurer X25519 key |
| ENG-15 | MEDIUM | I4 | Per-handler CORS `*` overrides restrictive server policy; 0.0.0.0 bind | R:124,169,…; L:71; RPC:420-424 | From any origin, `fetch('http://<host>:3030/interactive/state')` in a browser → readable (ACAO `*`), bypassing RPC's localhost-only default |
| ENG-16 | MEDIUM | I7 | Badge tap: DEV PIN 000000, verified:true & registry ACTIVE hard-coded, 8h session never checked | R:1937-1973; S:6478,6569,6594-6611 | POST `/interactive/badge/tap` `{providerType:"prescriber",providerIndex:0}` no auth → `authenticated:true` + signed 8h session; no route consumes the session |
| ENG-17 | MEDIUM | I4 | No rate limit, unbounded readBody, unbounded job maps on OPEN routes | R:2069-2078,142,413-415,950,573-592 | Repeated POST `/interactive/prescribe-and-fill` → `fillJobs` grows one entry per call (jobKey includes `Date.now()`), never pruned unless fill-status polled; body size uncapped |
| ENG-18 | MEDIUM | — | Restart loses encryption keys/messages/attestation revocations (msgNonce kept) | S:5849,5841-6029; S:3708,4080-4083 | Send a message, restart, GET `/interactive/threads` → empty; a terminated member's un-expired attestation again passes `verifyAttestation` (revocation set is empty) |
| ENG-19 | LOW | — | member-history/family-history reference undeclared `fulfillment` → 500 | S:4922,4985 (decl only S:3044) | GET `/interactive/member-history?walletId=X` for a member with ≥1 Rx → 500 `fulfillment is not defined` |
| ENG-20 | LOW | — | prescribe-and-fill never marks filled → always throws at dispense | R:544-634; S:2458,2626 | POST `/interactive/prescribe-and-fill` → `fill-status` → `error: Cannot dispense prescription in ADJUDICATED status` |
| ENG-21 | LOW | — | badge/:key route unreachable (exact-match dispatch) | R:2013; RPC:499-507 | GET `/interactive/badge/prescriber-0` → falls through to static/404, never hits the handler |
| ENG-22 | LOW | — | Engine viz loopback sends no admin auth to admin-gated /viz/emit | L:313-326; RPC:455-462 | With a token configured, engine `POST /viz/emit` has no `Authorization` → 401, viz events silently dropped (fails closed) |
| ENG-23 | LOW | — | Proof pool ignores caller type tags; credential job type mismatch breaks generate-credential under the pool | PW:240-251,341-354; PP:203; S:5428-5441 | With the proof pool running (prod default), POST `/interactive/generate-credential` → job `error` (ProofGate proof parsed as StateTransitionProof); inline path works |
| ENG-24 | LOW | — | /node/publish-formulary ignores its inputs (no-op) | R:1692-1721 | POST `/node/publish-formulary` with any `formularyRoot`/`entriesJson` → 200 "published" but nothing is stored |
| ENG-25 | LOW | — | Discarded proofs built with vacuous bounds (day-supply==max, PA qty==max) | S:2301-2302,1868 | Code read: `requestedDaySupply = Field(maxDaySupply)`; `approvedQuantity = maxQuantityPerFill` — assertions cannot bind (proofs discarded anyway) |
| ENG-26 | LOW | — | Non-batch engine state only persisted on the 60s timer | L:349-373,742-744 | Hard-kill (SIGKILL) within 60s of a mark-filled → that FILLED status and any step-therapy formulary growth are lost on restart (graceful SIGTERM does save) |
| ENG-27 | LOW | — | updateRxStatus actorIndex unvalidated → undefined access → 500 | S:3228-3230; R:636-676 | POST `/interactive/update-rx-status` `{role:"prescriber",actorIndex:999,...}` → 500 (`PRESCRIBERS[999]` undefined) |

Severity counts: CRITICAL 3, HIGH 6, MEDIUM 9, LOW 9 (27 total).

## 2. Findings

### ENG-01 — CRITICAL — Unauthenticated register-member provisions ELIGIBLE wallets with no caller proof (I7, I2)
**Evidence.** `/interactive/register-member` is OPEN (not in `ADMIN_ROUTES`, `R:72-82`; handler `R:147-174`). The only validation is `Poseidon.hash([Field(0), ...preimageFields]) === walletId` (`S:1554-1555`) — the caller supplies *both* sides, so it is trivially satisfiable (`DOMAIN_TAG_MEMBER=0`). The service then `adminMutate('register member: ELIGIBLE', provision(walletId, LIFECYCLE_ELIGIBLE))` (`S:1595-1597`) — a direct sequencer-tree mutation with **no proof** — and mints a credential via an engine-generated proof (`S:1601`).
**Impact.** Any network client reaching `0.0.0.0:3030` (`L:71`) can create arbitrarily many ELIGIBLE member wallets on the ledger with no credential, token, group, or possession proof. Each becomes immediately usable for plan-paid claims (see ENG-03); combined, the plan is exposed to unbounded fraudulent enrollment + billing.
**Fix sketch.** Require proof-of-possession (a member-signed registration proof the sequencer verifies) before `provision`; gate the route; do not let the engine both generate and submit the member's proof from caller-supplied preimages.

### ENG-02 — CRITICAL — Member preimage incl. hash(enrollmentKey) held by engine and persisted cleartext; engine can prove as any member (I2, I3)
**Evidence.** The 6 preimage Fields (5th is `hash(enrollmentKey)`, per `wallet-derivation`) are stored on the `EnrolledMember` (`S:1661`) and serialized **in plaintext** to `l2-data/adjudication-state.json` beside `walletId`, `displayName`, `employeeId` (`S:5695-5696`; write `L:356-359`). `proveAndSubmitWalletUpdate` needs only `{walletId, preimageFields}` to generate a valid `StateTransitionProgram.proveWalletUpdate` (`S:5083-5112`), and is called for every mint/fill/PA/rollover.
**Impact.** I2 is broken at enrollment: the hashed identity set (incl. the enrollment-key hash) leaves the phone and lands on sequencer disk. Anyone who reads `adjudication-state.json` (ops, backup, host compromise) can produce valid wallet-update proofs for **every** registered member — i.e. impersonate them on the ledger indefinitely — without the phone or the enrollment key. The engine already does this on every claim, so member "proving" is not device-bound.
**Fix sketch.** Keep member proving on the device; never transmit/persist preimage Fields on the sequencer. If server-side proving is required, hold inputs only transiently and encrypt at rest; treat the file as key material.

### ENG-03 — CRITICAL — Unauthenticated prescribe+fill bills the plan; enforcing proofs discarded; costs caller-controlled (I7)
**Evidence.** `/interactive/prescribe` and `/interactive/fill` are OPEN (`R:377-468`). In `createPrescription` the ProofGate/Eligibility/formulary/PA/messaging proofs are generated then **discarded** (`S:2178-2388`; formulary day-supply arg is pinned to the max, `S:2301-2302`); nothing is submitted. At fill, the `AccumulatorFulfillment` proof is discarded and only its `publicOutput` read (`S:2805-2824`); the sole submitted proof is a bare `proveWalletUpdate` (`S:3020`) that does not encode pay, eligibility, formulary, PA, or provider identity. Costs default to AWP×qty / 200 but caller-supplied `ingredientCostCents`/`dispensingFeeCents` are accepted unbounded (`S:2665-2666`); `prescriberIndex`/`pharmacyIndex` are caller-chosen (`R:396-401`).
**Impact.** An unauthenticated caller can drive plan-paid claims of attacker-chosen magnitude for any ELIGIBLE wallet (ENG-01). None of the rules a PBM relies on — eligibility, on-formulary, prior-auth, step-therapy soundness, prescriber/pharmacy identity, pricing — is enforced on the committed ledger; they live only in plain TS and in proofs no verifier ever sees.
**Fix sketch.** Submit and verify the fulfillment/eligibility/formulary/PA proofs at the sequencer (bind pay + roots in the submitted proof); validate/clamp cost inputs; authenticate the pharmacy caller.

### ENG-04 — HIGH — REVOKED members remain billable (no lifecycle check) (I7)
**Evidence.** `createPrescription` (`S:2064-2145`), `dispensePrescription` (`S:2611-2667`), `reversePrescription` (`S:3286-3308`) and `assignPcp` (`S:4705-4711`) never test `enrolled.lifecycle === 'REVOKED'`; the guard exists only in messaging/credential/cascades (`S:3665,4336,4519,4634,5377`). `terminateMember` sets REVOKED (`S:4073-4075`) but those paths ignore it.
**Impact.** A terminated member (or anyone, via OPEN routes) can still prescribe and fill, and the plan pays. The documented termination control does not actually stop claims.
**Fix sketch.** Check lifecycle at the start of prescribe/dispense/reverse and reject REVOKED; ideally enforce in-circuit.

### ENG-05 — HIGH — update-provider-network OPEN but runs the admin-class per-member cascade (I7)
**Evidence.** `/interactive/update-provider-network` is **not** in `ADMIN_ROUTES` (`R:72-82`) though `update-formulary` is; handler `R:1086-1108`. `updateProviderNetwork` iterates all non-REVOKED members and submits a wallet-update per member while rewriting their eligibility/network/credential (`S:4519-4568`).
**Impact.** An unauthenticated caller rewrites the provider network and every active member's eligibility commitment, forcing N submitted proofs — a privileged, member-wide state change missing the gate its sibling route has.
**Fix sketch.** Add `/interactive/update-provider-network` to `ADMIN_ROUTES`.

### ENG-06 — HIGH — GET /interactive/state unauthenticated dump of member-linked data (I5, I6, I4)
**Evidence.** OPEN (`R:121-139`). `getState` returns per member: full `walletId`, `displayName`, `employeeId`, `familyId`, `accumulator`, full `credentialJson`, and `lastAttestation` (`S:6040-6063`), plus `walletDirectory` mapping every walletId→{displayName,type} (`S:6347-6365`), plus `demoData.members` with raw seed PII (firstName/lastName/cardholderId/dateOfBirth/address, `S:6213-6227`).
**Impact.** Anyone reaching the port gets the wallet↔employeeId↔name↔family↔drug-accumulator linkage (breaks I5 employeeId containment and I6 wallet-unlinkability) and can lift any member's portable credential + attestation (breaks I4). Raw seed PII is served from the sequencer (I1-shaped, fixtures today).
**Fix sketch.** Authenticate `/interactive/state`; drop `employeeId`/`credentialJson`/`lastAttestation`/raw PII from any open projection; remove the walletId→name directory.

### ENG-07 — HIGH — OPEN generate-credential + getState → mint and exfiltrate a member's credential/attestation (I4, I7)
**Evidence.** `/interactive/generate-credential` is OPEN (`R:953-998`); it proves ProofGate+Credential from the member's engine-held inputs and stores `lastCredentialJson` + `lastAttestation` (`S:5405-5475`), which `getState` then serves (`S:6061-6062`).
**Impact.** Any caller can force generation of, then read, a member's offline-verifiable portable credential and 24h attestation and present them as that member at a pharmacy — impersonation without the device.
**Fix sketch.** Authenticate generate-credential to the member; return the credential only to the authenticated member; do not expose it via open state.

### ENG-08 — HIGH — OPEN member claim/history reads by bare walletId (I7, I4)
**Evidence.** All OPEN: `/node/claims-by-member`, `/node/dur`, `/node/receipts-by-wallet` (`R:1351-1504`), `/interactive/member-history`, `/interactive/family-history` (`R:733-801`), `/interactive/threads` (`R:901-922`), `/interactive/prescriptions-by-pharmacy` (`R:512-523`). Each returns member-linked history given only a walletId.
**Impact.** Anyone with a walletId (available from ENG-06 or the SSE/viz feeds) reads a member's cross-pharmacy drug history, receipts, and message threads. (member/family-history additionally 500 — see ENG-19.)
**Fix sketch.** Require caller authentication bound to the subject wallet (member/PCP) before returning member-linked data.

### ENG-09 — HIGH — Engine attestation signing key derived from a public literal seed (I7)
**Evidence.** `new SequencerAttestationAuthority(Buffer.from('zkpcare-attestation-authority-seed'))` (`S:511-513`) — a constant in source. This key signs member credential attestations (`S:5469-5475`, `lifecycleState:3` hard-coded `S:5472`) and provider badge sessions (`S:6605-6611`).
**Impact.** The Ed25519 signature is the integrity gate for offline credential/badge verification, yet the private key is reconstructable by anyone from the repo. Attackers can forge "sequencer-signed" attestations for any walletId with ACTIVE lifecycle, defeating pharmacy-side verification.
**Fix sketch.** Load the attestation seed from a secret (as the node's own authority does via `ZKTRIDENT_GOSSIP_SECRET`), never a literal; rotate.

### ENG-10 — MEDIUM — Caller-asserted identity/role and no consent on OPEN state-changers (I7)
**Evidence.** `markFilled` only checks status==ADJUDICATED and takes the pharmacy identity from the Rx record, not the caller (`S:2552-2558`). `updateRxStatus` trusts caller `role`/`actorIndex` strings (`S:3214-3224`; route `R:636-676`). `reversePrescription` has no caller identity (`S:3291-3308`). `assignPcp` requires no member consent (`S:4705-4711`). `requestPriorAuth` (`R:263-290`) accepts any prescriberIndex.
**Impact.** Any caller advances, cancels/rejects, reverses, or PCP-binds another party's prescriptions; the "only prescribers can cancel" / "only pharmacies can reject" checks are bypassed by setting the `role` field.
**Fix sketch.** Authenticate each actor and derive identity/role from the authenticated principal, not the body.

### ENG-11 — MEDIUM — OPEN batch/data-availability control routes (I7)
**Evidence.** OPEN: `/interactive/force-batch`, `/interactive/save-checkpoint`, `/interactive/retry-batch`, `/interactive/simulate-batch-failure` (`R:1200-1287`) and `/node/force-batch` (`R:1673-1690`).
**Impact.** An unauthenticated caller can force batching, trigger checkpoint writes, retry batches, and mark a settled batch failed — disrupting settlement/DA timing and L1 status on demand.
**Fix sketch.** Move these to `ADMIN_ROUTES`; keep `simulate-batch-failure` out of production builds.

### ENG-12 — MEDIUM — GET step-therapy-check mutates formulary and every member's eligibility (I7)
**Evidence.** OPEN GET (`R:1133-1157`). `checkStepTherapy` calls `getFormularyLeafIndex` (`S:1989`), which for a not-yet-materialized backfill drug adds a formulary entry and then rewrites **every** enrolled member's `eligibilityData`, forest leaf 0, `credentialData`, and `benefitPlanRegistry.updatePlan(0n,…)` (`S:818-863`) — a GET with cross-member write side effects and no submitted proof.
**Impact.** An unauthenticated GET silently changes shared formulary state and all members' in-engine eligibility commitments (which later submitted proofs build on), with no authentication and no ledger proof.
**Fix sketch.** Make lookup pure (materialize formulary entries only in an authenticated admin write path); never mutate member state from a GET.

### ENG-13 — MEDIUM — Family-pooling rewrite makes settlement commitment disagree with claim metadata
**Evidence.** Pay is read from the proof output (`S:2824-2825`) then overwritten by family pooling (`S:2908-2920`). The TRANSACTION-tree settlement commitment uses the **proof's** pay fields (`S:2962-2977`), while the submitted claim metadata uses the **rewritten** pay (`S:3008-3009`). `daysSupply` is hard-coded 30 in claim metadata (`S:3014`; reverse `S:3445`).
**Impact.** For any fill where family pooling applies, the committed settlement record and the queryable claim history report different patient/plan pay for the same fill; reconciliation/audit over claim history will not match the committed forest. Bounded to pooled fills.
**Fix sketch.** Compute pooling before building the settlement commitment so the committed leaf, the accumulator, and the claim metadata use one value; record actual days-supply.

### ENG-14 — MEDIUM — Seed enroll handles raw PII + committed enrollment keys in-process; insurer/seed keys are constants (I1, I3, I7)
**Evidence.** `/interactive/enroll` (OPEN, `R:177-223`) → `enrollMember` reads `MEMBERS[i].enrollmentKey` and raw name/DOB/cardholderId in the sequencer process (`S:1011,1053-1061,1372`). Insurer X25519 key is `deriveEncryptionKeyPair('ADMIN-INSURER-ENCRYPTION-KEY-2026')` (`S:787`); seed provider private keys come from committed `enrollmentKey`s (`S:774-784`).
**Impact.** The fixture path puts raw PII and enrollment keys inside the sequencer (I1/I3 pattern break; real if seed identities were real), and the insurer/seed-party private keys are reconstructable from source, so the sequencer (or anyone) can decrypt seed-party messages.
**Fix sketch.** Keep the seed path out of production; derive insurer/seed keys from secrets, not literals.

### ENG-15 — MEDIUM — Per-handler CORS `*` overrides the restrictive server policy; 0.0.0.0 bind (I4)
**Evidence.** Every engine handler sets `Access-Control-Allow-Origin: *` (e.g. `R:124,169,…`), overriding RPC's localhost-only default (`RPC:420-424`); the server binds 0.0.0.0 (`L:71`).
**Impact.** Any web page in any browser that can reach the host (LAN/localhost) can read member-linked engine responses cross-origin, and any network peer can call the OPEN routes directly.
**Fix sketch.** Honor the server's CORS allowlist in engine handlers; bind to loopback unless a reverse proxy enforces auth.

### ENG-16 — MEDIUM — Badge tap: dev PIN, hard-coded verified/ACTIVE, session never checked (I7)
**Evidence.** `/interactive/badge/tap` OPEN (`R:1937-1973`); `authenticateFromBadge(badge, DEV_BADGE_PIN='000000')` (`S:6478`; const `provider-badge-service.ts:55`); `verified:true` (`S:6569`) and `credentialState:'ACTIVE'`/`registryVerified:true` (`S:6594-6599`) are hard-coded; the 8h Ed25519 session is returned and never consumed by any route (`S:6605-6611`).
**Impact.** Any caller "authenticates" as any seed provider with the fixed dev PIN and receives a signed 8h session; the verified/registry results are cosmetic. Inert today only because no route checks the session.
**Fix sketch.** Remove the dev PIN and hard-coded verdicts; if sessions are intended, have state-changing provider routes require and verify them.

### ENG-17 — MEDIUM — No rate limit, unbounded body, unbounded job maps on OPEN routes (I4)
**Evidence.** `readBody` has no size cap (`R:2069-2078`). No engine route has a rate class (`R` comment / `RPC:717-723`). `enrollmentJobs`/`fillJobs`/`credentialJobs` are in-memory maps keyed by caller input (`R:142,413-415,950`); `prescribe-and-fill` builds `jobKey` with `Date.now()` (`R:588`) so each call adds an entry pruned only when fill-status is polled (`R:496-505`).
**Impact.** An unauthenticated client can exhaust memory (large bodies, growing job maps) and CPU (ZK proving behind the proving lock) on the single sequencer.
**Fix sketch.** Cap body size, add per-IP rate limiting, bound/evict job maps by count+TTL independent of polling.

### ENG-18 — MEDIUM — Restart loses encryption keys, messages, and attestation revocations
**Evidence.** `restoreState` restores `msgNonce` (`S:5849`) but not `messageRegistry`/`encryptedPayloads`/`encryptionKeys`/`attestation` revocations (`S:5841-6029`; not-restored set per engine map §2). `sendMessage` then throws when keys are absent (`S:3708`); `terminateMember` revokes a nonce only in memory (`S:4080-4083`).
**Impact.** After any restart, message history is gone and messaging to/from restored device members fails; revoked member/badge attestations (deterministic key, un-expired) verify as valid again — a revocation-loss integrity bug.
**Fix sketch.** Persist/restore the revocation set and key registry (or re-derive deterministically); persist encrypted message blobs.

### ENG-19 — LOW — member-history/family-history reference an undeclared `fulfillment` → 500
**Evidence.** `S:4922` and `S:4985` read `fulfillment.settlementCommitment`, but `fulfillment` is declared only at `S:3044` inside `dispensePrescription`; the loops here declare `fills`/`latestFill`. ES-module strict mode + tsx (no type-check) → `ReferenceError` once the per-Rx loop body runs.
**Impact.** `GET /interactive/member-history` / `family-history` return HTTP 500 for any member with ≥1 prescription — the endpoints are effectively non-functional (caught → 500, no data leak).
**Fix sketch.** Use `latestFill` (already in scope) instead of `fulfillment`.

### ENG-20 — LOW — prescribe-and-fill never marks filled → always throws at dispense
**Evidence.** `createPrescription` leaves status `ADJUDICATED` (`S:2458`); `prescribe-and-fill` (`R:544-634`) calls `dispensePrescription` directly, which requires FILLED/PARTIALLY_FILLED (`S:2626`) and never calls `markFilled`.
**Impact.** Every `/interactive/prescribe-and-fill` call errors at step 2 — dead/misleading path.
**Fix sketch.** Insert `markFilled` between prescribe and dispense, or remove the route.

### ENG-21 — LOW — badge/:key route is unreachable (exact-match dispatch)
**Evidence.** Registered as the literal key `GET:/interactive/badge/` (`R:2013`); dispatch is exact `METHOD:pathname` (`RPC:499-507`), so `/interactive/badge/prescriber-0` never matches.
**Impact.** Dead code that reads as a live endpoint.
**Fix sketch.** Register a prefix/pattern route or drop it.

### ENG-22 — LOW — Engine viz loopback sends no admin auth to the admin-gated /viz/emit
**Evidence.** The launcher's `vizEmitter` POSTs `/viz/emit` with only Content-Type/Length, no `Authorization` (`L:313-326`); `/viz/emit` is admin-gated (`RPC:455-462`).
**Impact.** With a token configured, every engine viz event is 401'd and dropped (fails closed) — the dashboard shows no engine viz activity. No security impact.
**Fix sketch.** Emit viz events in-process instead of via an authenticated HTTP loopback.

### ENG-23 — LOW — Proof pool ignores caller type tags; credential job type mismatch
**Evidence.** The pool request carries only `{program,method,args}` (`PP:203`); the worker deserializes by its **own** `methodDef.argTypes` (`PW:341-354`). `Credential.proveHolding`/`proveHoldingByType` declare arg0 `'StateTransitionProof'` (`PW:240,243,248`) and there is no `ProofGateProof` type, but the service sends a ProofGate proof tagged `'ProofGateProof'` (`S:5428-5441`). The inline path uses the correct classes.
**Impact.** With the proof pool running (prod default, `L:376`), `generate-credential` always fails (ProofGate proof parsed as a StateTransitionProof). Functional, not a security hole.
**Fix sketch.** Add a `ProofGateProof` type to both registries, or transmit and honor the caller's arg types.

### ENG-24 — LOW — /node/publish-formulary ignores its inputs
**Evidence.** Validates `planIdHash`/`formularyRoot`/`entriesJson` then calls only `seq.getFormulary(planIdHash)` and returns success (`R:1692-1721`); `formularyRoot`/`entriesJson` are discarded.
**Impact.** Misleading no-op route that reports "published."
**Fix sketch.** Implement or remove.

### ENG-25 — LOW — Discarded proofs built with vacuous bounds
**Evidence.** Formulary-access day-supply arg is `Field(maxDaySupply)` (`S:2301-2302`), so the circuit's `daySupply ≤ maxDaySupply` can never fail; PA approval uses `approvedQuantity = maxQuantityPerFill` (`S:1868`) with no clinical criteria.
**Impact.** Even if these proofs were verified, they would not bind day-supply or PA quantity. Moot today since the proofs are discarded (ENG-03).
**Fix sketch.** Pass the actual requested day-supply/quantity; set PA quantity from the approval decision.

### ENG-26 — LOW — Non-batch engine state only persisted on the 60s timer
**Evidence.** `saveAdjudicationState` runs on `batch:settled`/`batch:built` and a 60s interval (`L:365-373`); a save-on-shutdown exists for graceful SIGINT/SIGTERM (`L:742-744`) but not for hard crashes.
**Impact.** A SIGKILL/power loss within 60s of a non-batch change (mark-filled status, step-therapy formulary growth) loses that state; the atomic tmp+rename (`L:356-359`) avoids torn files but there is no fsync.
**Fix sketch.** Save on the mutating operations (or shorten the interval) and fsync before rename.

### ENG-27 — LOW — updateRxStatus actorIndex unvalidated → undefined access → 500
**Evidence.** `PRESCRIBERS[opts.actorIndex]` / `PHARMACIES[opts.actorIndex]` dereferenced without range check (`S:3228-3230`); route validates only that `actorIndex` is a number (`R:649-652`).
**Impact.** An out-of-range `actorIndex` throws a TypeError → HTTP 500 (caught). Minor crash path.
**Fix sketch.** Validate the index against the array length.

## 3. Not a finding

- **No save-on-shutdown** (engine map open question): a graceful SIGINT/SIGTERM handler does call `saveAdjudicationState()` (`L:716-754, 742-744`). Only hard crashes are exposed (ENG-26).
- **Proof-pool worker crash loses accepted state**: a crash rejects only the single in-flight job (`PP:431-444`) and restarts the worker; the enclosing engine operation errors cleanly before any sequencer submit. No ledger corruption.
- **PHI/raw enrollment key crossing proof-pool IPC**: only Field decimal strings / Struct+witness+proof JSON cross (`S:877-898`; `PP:261-265`); no raw PHI or raw enrollment key is serialized. The hashed preimages that cross are within the same trusted host process tree (folded into ENG-02).
- **reset / terminate-member / terminate-group / approve-/deny-prior-auth / update-formulary / decrypt-thread / create-delegation / plan-year-rollover**: these are in `ADMIN_ROUTES` (`R:72-82`) and gated by the Bearer admin token (`RPC:2661-2671`); not an engine-side auth gap (the shared-token weakness is a sequencer/key-management concern out of scope).
- **l2-status / all-receipts / all-batches / audit-log / chain-state / formulary read routes**: ledger metadata with truncated wallet IDs; lower sensitivity than the by-wallet member reads (ENG-08).
- **ADMIN_ROUTES exact-match gating**: gating is keyed on the same exact `METHOD:path` as registration (`RPC:393-395,503`), so the 9 admin routes are correctly gated (no prefix-escape).

## 4. Open questions

- Is `/interactive/register-member` (engine proves for the member) transitional, to be replaced by device/`:4040` delegate proving? Nothing in the engine references the delegate. Resolving this decides whether ENG-01/ENG-02 are "as designed."
- Does the submitted `proveWalletUpdate` get cryptographically verified anywhere before batch time? CODEMAP §8 says `seq:293 proof.verify()` is only the o1js flag (sequencer scope). If so, ENG-03's ledger changes precede any cryptographic check.
- Intended verifier for the discarded eligibility/formulary/PA/identity/fulfillment proofs — is any process meant to consume them, or is the design relying on plain-TS checks only?
- Is `demoData` raw PII (`S:6213-6227`) ever populated from real members in any deployment, or strictly fixtures? That decides whether ENG-06's PII exposure is I1-critical.
- Should the engine attestation seed (`S:512`) and insurer encryption seed (`S:787`) come from env/secret like the node authority (`L:288`)?
