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
| A12b | **Write the recovery card at enrollment**: one share of the enrollment key under a PIN, and nothing else. No public attestation on the card, so a found card reveals nothing, not even a wallet ID; the attestation moves to the phone, generated on demand and short-lived. Issue two cards. This moves here from phase C because the enrollment tap is the only moment the key is available, and a card cannot be issued retroactively. Without it a lost phone destroys the wallet, the claims history and the year-to-date accumulator, with no remedy. Full design and the tiered access rules: `docs/RISK-LOG.md` PRD-1 | I3 | PRD-1, MEM-M5 |
| A13 | **Give the replicas credentials so gossip is actually delivered**, and add an invariant monitor that alarms when a replica's root diverges from the leader's or a batch stalls. This is the prerequisite for phase E, and the monitor is what should have caught 29 hours of dead replication | availability | A-8, C-3 |

**A1 implementation spec.** Written out because it goes first and because getting the ordering wrong would leave the hole open while looking closed.

*Where the verification key comes from.* Implemented 2026-10-17. The sequencer now compiles `StateTransitionProgram` at boot and keeps the verification key in memory. **Measured on a genesis boot: 7,239 ms, once** (the earlier 3,803 ms figure came from a warm member-node process, so budget the larger number). The key hash is asserted against `ZKTRIDENT_TRANSITION_VK_HASH` and the boot **fails closed** on a mismatch; with nothing pinned it prints the hash to pin and warns.

The hash for the current program, to pin in deployment config:

```
ZKTRIDENT_TRANSITION_VK_HASH=9617019925474184580074828633127976039422369210756941418911053898889459585383
```

It changes whenever the circuit changes, which is the point: a recompiled or swapped program is then refused rather than silently trusted.

*The call.* `verify(proof, verificationKey)` from o1js, the same function the harness already uses at `scripts/e2e-verify/run.ts:493` to check batch proofs, with the tamper case beside it at `:501`. That is the pattern to copy; it is proven against this codebase's own proofs.

*Ordering, which is the whole point.* Verification becomes the first thing `submitProof` does. Nothing may happen before it returns true. In the current body at `l2-sequencer-service.ts:291-471` that means it precedes the fingerprint insert at `:298-302`, the partition check at `:305`, the root assertions at `:318-340`, `planTreeUpdate` at `:344`, the WAL append, the apply at `:374-378`, the receipt at `:381`, the audit event at `:398-423`, the claim leaf at `:429-457`, and the gossip broadcast.

*Fingerprint handling.* A-3 also found the fingerprint recorded before the checks and never removed when a later step throws, so a rejected submission permanently poisons that transition. Wrap the body so the fingerprint is removed on any throw, or insert it only once every check has passed. Either is fine; leaving it as is means a failed submission can block the honest retry.

*Distinct errors.* Return different codes for an undecodable proof, a proof that fails verification, and a root mismatch. Today all three collapse into one shape, which is why the audit's probe could not tell a structural decode failure from a cryptographic one without reading the library source.

*Acceptance.* `check-proof-gate.ts`, itself an A1 deliverable, submits four things in order: a well-formed proof with a tampered public output; a valid proof re-pointed at another wallet; a structurally undecodable proof; and one honest proof. The first three must be refused, and the check must assert **no mutation** by comparing status, receipt count, audit-log length and claim-leaf count before and after, not merely that an error came back.

*One thing to measure.* Verification now sits on the submit path. Record the per-proof cost. If it is material at volume, it can move into a proving-pool worker, but only with care: the ordering guarantee above is what makes A1 worth doing, and making verification asynchronous would give it back.

**A1 is done, verified on a running network 2026-10-17.** Results and the one architectural
finding it turned up.

| Case | Outcome | Time | Ledger |
|---|---|---|---|
| Real proof, public output altered, roots left matching current state | **refused**, `reason: invalid` | 5.7 s | unchanged: 31 wallets, 0 accepted |
| The same proof, honest | **accepted**, receipt `l2-00000000` | 4.9 s | advanced: 32 wallets, 1 accepted |
| Malformed submissions (4 shapes) | refused during decoding, before verification | — | unchanged |

The tampered case is the one that matters. Its roots matched current state, so the root check
passed and only cryptography could refuse it. Before A1 it would have been applied.

**The architectural finding: the sequencer's main process cannot do o1js work after the engine
loads.** The engine compiles ten ZkPrograms into that process's single o1js context, and
after that every o1js call there stalls permanently. Measured in both directions:

| Verifier set up | Compile | First verification |
|---|---|---|
| Before the engine | succeeds, 7.2 s | **never returns** |
| After the engine | **never returns**, boot hangs | not reached |
| In its own process | succeeds, 4.6 s | succeeds, 4.2 s |

This is the same wall that moved batch proving into `l2-proving-worker.ts`, met from the other
side, so verification now runs in `l2-verify-worker.ts` behind `VerifyPool`. The in-process
factory is kept for clean single-purpose processes (tests, tools) and documented as unsafe for
the sequencer. **Treat this as a general constraint: anything needing o1js inside the sequencer
process needs a worker, not a function call.**

Two things that fell out of doing this, both recorded rather than fixed:

- **`ZKTRIDENT_FORMULARY_LIMIT` was ignored — fixed 2026-10-17, and it was the whole boot.**
  The variable was documented in the starter's header and passed by three npm scripts, and
  `src/data/formulary-loader.ts`, the loader the sequencer actually imports, never read it, so
  every boot loaded all 32,768 NADAC drugs. `src/data/index.ts` already had the mechanism and
  `src/data/formulary-100.json` already existed; only this file was missing it.

  Measured, because the obvious suspect was wrong: parsing the 13 MB JSON takes **0.4 s**.
  Building the Merkle tree from it takes **about 20 ms per drug**, because `loadFromNadac`
  inserts one leaf at a time and every `setLeaf` rehashes the path to the root of a height-16
  tree. Sampled at 100, 500 and 2,000 drugs the rate is 24.5, 23.3 and 19.5 ms, so the full set
  is **640 to 800 seconds — eleven to thirteen minutes, on the main thread, before the RPC
  server can open its port.** That is the ten-minute boot, essentially in its entirety. With the
  limit honoured the same boot reaches "ready" in about one minute.

  **Both further wins are now done, and measured on the full set.** `MerkleTree.fill()` turned
  out to be no help — it is a plain loop over `setLeaf`, so it costs exactly the same — and
  o1js offers no bottom-up builder, so `buildTreeBottomUp` in `formulary-service.ts` writes one
  through the public `nodes` field. `formulary-tree.test.ts` asserts it produces the identical
  tree, not merely an equal root: same root, every internal node, and the same witnesses, across
  sizes including the odd counts that leave a lone child at some level.

  | full 32,768 drugs | before | after |
  |---|---|---|
  | build the tree | ~700 s (extrapolated from `setLeaf`) | **178 s** (measured) |
  | boot again, same data | ~700 s | **56 s** (restored from cache) |

  So about 12× end to end, and the cache file is 5.4 MB. The restored root is byte-identical to
  the built one.

  **What is deliberately *not* cached, and why it cost 51 of those 56 seconds.** The first
  version cached the per-NDC Poseidon hashes as well, which would have taken the restore to
  about 5 s. A test caught why that is wrong. The cache's digest binds it to the *records*, and
  SHA-256 cannot attest a Poseidon hash, so a cached `ndcHash` can only be verified by
  recomputing it — which is the cost being avoided. Sampling left the rest unverified, and an
  `ndcHash` is a **lookup key**: a wrong one makes `getDrug` return another drug's tier and copay
  for a given NDC while the committed root stays perfectly valid. That is an adjudication fault
  no root check would ever surface, so the hashes are recomputed on every load and the question
  disappears. The residual 51 s is one Poseidon per drug.

  **The way to get that 51 s back is a worker, not a weaker cache.** The formulary load is the
  third thing in this process that wants its own o1js context, after batch proving and proof
  verification. Moving it to a child process would unblock the main thread entirely — the RPC
  server could open its port immediately and the formulary would be ready in parallel with the
  ZkProgram compiles — and the hashes would come from a process spawned in this same boot rather
  than from disk, which is a completely different trust question from a cached file. Not done.

- **The formulary root check could never pass — fixed 2026-10-17.** Every boot printed
  `[Formulary] Root mismatch after restore: expected 19755… got 5791…`. Both numbers are now
  accounted for: `5791…` is exactly the root of an **empty** `FormularyService`, and `19755…`
  is exactly what the real 32,768-drug set produces. The sequencer restores its checkpoint
  *before* it loads the formulary, so the check compared a recorded root against a tree with
  nothing in it, on every boot, forever. That is worse than having no check at all, because a
  genuine mismatch would have produced an identical-looking warning in the same noisy place.
  The expected root is now held and checked at the end of `loadFromNadac`, where the tree
  exists; `formulary-cache.test.ts` pins that it stays silent on a match, warns once on a real
  mismatch, and never compares against an empty tree. Note this is **separate** from
  `[sequencer] Restored roots do not match the rebuilt witness trees`, which concerns the wallet
  and lifecycle trees and is a documented consequence of checkpoints not carrying wallet states.
- **The server's 30 s request timeout is the operative ceiling on verification**, not
  throughput. At about 5 s per submission there is comfortable headroom, but the 20 s verifier
  watchdog has to stay below the request timeout or a stalled verification reappears as a 504
  with no explanation.

Costs to budget: verifier worker compile 4.6 s at boot, then roughly 1 s warm per proof and
about 4 s on a cold first call. One worker is enough at expected rates; `ZKTRIDENT_VERIFY_POOL_SIZE`
raises it. Workers recycle every 50 verifications to release WASM heap.

**A2 implementation record.** Done 2026-10-17. The surface turned out to be wider than the
audit's four endpoints, and one finding in it was wrong in the useful direction.

*What was actually there.* Fourteen listeners across the repository, each deciding bind address
and CORS for itself, with four different answers: eleven defaulted to `0.0.0.0`; seven defaulted
to CORS `*`; the sequencer defaulted to `['http://localhost', 'http://127.0.0.1']`, which carries
no port and therefore **matches no browser**, since a browser sends `http://localhost:4001`; and
eighty-one route handlers wrote `Access-Control-Allow-Origin: '*'` into a `writeHead` header
object, overriding whatever policy the server had just set. Seventy-seven of those were in
`interactive-routes.ts`, which is mounted into the live sequencer.

*The off-list origin was worse than open.* The sequencer answered a disallowed origin with the
literal string `null`. That is not a denial. `Access-Control-Allow-Origin: null` grants any
null-origin context: a `file://` page, a sandboxed iframe, a data URI. The policy that looked
strictest was granting a class of attacker the wildcard would have reached anyway.

*The proxies, and a mistake worth recording.* I first concluded the proxies had no client at
all, and set them **off by default** on that basis. That was wrong, and it would have shipped two
broken dashboards. The check I ran was `grep` for `rpc\.` and for `l2_` in each `app.js`; the
pages actually call a **global `RPC` object** — capital letters — that `rpc.js` defines, so the
calls were there and my pattern could not see them. Worse, the answer was written at the call
site: the comment directly above the `/rpc` dispatch in `nautilus-app-server.ts` reads "The
member dashboard sends JSON-RPC 2.0 to /rpc expecting to reach the Leviathan sequencer." I ran
a grep instead of reading the twelve lines around the thing I was about to switch off. Read out
properly:

| Client | Reaches the sequencer by | Methods |
|---|---|---|
| `dashboard-member` (:4001) | `rpc.js` sets `baseUrl = location.origin`, so **the node's proxy**, unless a sequencer URL is stored | 29, including `l2_submitProof`, `l2_storeMessage`, `l2_requestAttestation` |
| `explorer` (:8000) | **its own proxy**, the only path it has | 34 reads |
| `dashboard-leviathan` (:3030) | same-origin to the sequencer's real `/rpc` — no proxy | 23 |
| `dashboard-pharmacy`, `dashboard-insurer` | the node's proxy | 1 each (`l2_getFormulary`) |
| `dashboard-prescriber`, `dashboard-employer` | neither | 0 |

So the proxies are **on by default with a per-role method allowlist**, which is what the plan
item asked for in the first place. Each role forwards what its own page calls and refuses
everything else, so the proxy stops being a universal passthrough to whatever the sequencer
leaves open — including methods added later. `ZKTRIDENT_RPC_PROXY=0` turns a proxy off. A role
with no list gets no proxy, so adding a role cannot silently open one.

**What narrowing the proxy does not fix, and must not be read as fixing.** Three methods on the
member list should require authentication and do not: `l2_storeMessage` accepts any claimed
sender, `l2_requestAttestation` signs for any wallet, and the claim and message queries take a
wallet ID and return that wallet's records. Those are A-12, A-15, A-16 and A-13. They are
reachable directly on `:3030` by anyone who can reach the sequencer, so the proxy was never
their cause and closing it was never their cure — **A10 is**. What A2 buys here is that a node
serving a dashboard is no longer a path to the methods that node has no business touching.

A2's audit finding also said the proxies forward with the node's own bearer token; they attach no
`Authorization` at all, which is better, and that correction is recorded in
`deferred_security_admin_tasks.md`.

*Where the policy lives now.* `src/security/network-policy.ts`, a leaf module with no imports, so
both `src/l2` and `src/nodes` can use it without a dependency cycle. Four functions: `resolveBindHost`
(loopback default, warns at boot when told to bind wider), `resolveAllowedOrigins` (the local
dashboard origins *with ports*, wildcard only where a caller explicitly permits one),
`corsOriginHeader` (returns null to mean **send no header**, which is what fixes the `null` grant
and the no-Origin case), and `resolveRpcProxyPolicy`.

*TLS: config-ready, not enabled, and that is a deliberate reading of the item.* The item says
"enable TLS on every listener". What I did instead: `tlsCert`/`tlsKey` were already plumbed through
`L2RpcServer` and `NautilusAppServer`, but the sequencer and replica starters never passed them, so
HTTPS was unreachable without a code change. They do now, from `ZKTRIDENT_TLS_CERT`/`_KEY`. No
certificate is generated and none is required; unset, the listener serves HTTP.

I did not turn it on, because on a loopback-only listener it buys nothing a self-signed certificate
does not immediately cost back: the attacker it would stop needs to be reading the loopback
interface, which needs local administrator rights, at which point they can read the process's memory
and its keys directly. It would add a browser trust warning to every dashboard for that. **Two
servers still have no TLS path at all** — `start-explorer.ts` and `src/tools/hr-tool-server.ts` both
construct a plain `http.createServer`. Left as is for the same reason, and recorded here rather than
left silent.

**Where TLS does matter is phase E**, and it is not this kind of TLS. Ten leviathans in a cluster
have to reach each other and nobody else, which is mutual TLS between known peers with pinned
certificates, not server-side TLS on a loopback port. Loopback binding is the right answer for a
single host and the wrong answer for the cluster; A2 secures the former and phase E has to replace
it, not extend it.

*What this does not do.* Binding to loopback protects a single-host deployment. The ten-leviathan
cluster of the target architecture needs these listeners reachable by each other and by nobody
else, which is a private interface or mutual TLS between known peers, not loopback — phase E.
Three non-production dashboards (`src/poc/`, `visualizer/engine/flowchart-orchestrator.ts`) keep
wildcard response headers; they are now loopback-bound, and the files are slated for removal, so
they were not churned.

*Acceptance test.* `scripts/e2e-verify/check-network-surface.ts` dials every listener on loopback
**and on this host's own LAN address**, and checks four things per port: loopback answers while the
LAN address refuses; an allowlisted browser origin is echoed back exactly; a foreign origin gets no
header at all; a node's `/rpc` is refused. A port that is not listening is reported as skipped, never
as a pass, because a closed port proves nothing about the policy it would have applied.

**A9, third clause: the insurer gets a signing key of its own.** Done 2026-10-17. Closes A-29 and
the sharpest part of A-14.

*Two defects that compounded into an employer attestation chain with no integrity at all.*

**A-14's sharpest edge.** Employer attestations were counter-signed with `ZKTRIDENT_ADMIN_TOKEN`.
A bearer token reused as a signing seed is worse than one that is merely shared: a bearer token is
something you *present*, a signing key is what makes statements *attributable to you*. That token
is handed to all four child nodes at boot and is the literal string `admin123` in unsecure mode,
so anyone holding it could counter-sign as the insurer. The signing helper's own doc comment
already read "Uses a deterministic key derived from a dedicated signing seed (NOT the admin
token)" — the helper was right and the **caller** was wrong, which is the kind of defect a code
review catches and a reading of the comment does not.

**A-29.** The sequencer verified the counter-signature against `att.insurerPublicKeyHex`, the key
carried inside the attestation, so the signed document supplied its own trust anchor. Anyone could
generate a keypair, sign an employer attestation and have `l2_registerEmployer` accept it — which
is how a tenant comes into existence.

Together: forge a keypair, sign an attestation, register a tenant. Neither defect required a
secret of any kind.

*The trust chain, now that it is real.* The insurer is the attestation authority, so its key is
the one anchor that has to be pinned out of band. The sequencer pins it and **refuses employer
registration when it is unset**, rather than accepting a self-signed attestation. The boot
generates the seed and derives the pinned public half **in one place**, hands the seed only to the
insurer child and the public key only to the sequencer, so the two cannot drift apart.

`verifyEmployerSignature` still reads the employer's key from the attestation, and that is now
documented rather than silent: it is sound **only** beside the pinned insurer check, because the
insurer verifies the employer's signature against the public key in its own approved application
record before it counter-signs. A caller that checks only the employer signature is checking
nothing, which is why the sequencer checks both.

*A caveat a deployment needs to know.* An unconfigured seed is generated randomly per boot, so a
default boot is correct rather than merely convenient — but a new seed means a new public key, which
invalidates attestations signed under the previous one. Any deployment that keeps employer
attestations across restarts must set `ZKTRIDENT_INSURER_SIGNING_SEED`. Said in the boot's own
header text as well as here.

*What remains of A-14, stated so the finding is not read as closed.* The same bearer token is
still the sequencer's admin credential, every node's own admin credential, and is still shipped to
all four children at boot. Compromising the most exposed node still yields the credential that
administers the others. Splitting those into per-node credentials, with the sequencer accepting a
scoped token per role rather than one that opens every admin method, is the rest of this item.
The dead Ed25519 admin-key registry already in `l2-rpc-server.ts` is the designed mechanism for it.

*Acceptance test.* `tests/insurer-signing-key.test.ts`, 17 tests. The two that carry the findings:
a key derived from `admin123` no longer verifies as the insurer, and an attacker's self-signed
attestation is refused against the pinned key **while verifying perfectly against its own author's
key** — which proves the refusal comes from the anchor and not from a malformed object. Plus three
structural checks that the wiring holds: the sequencer refuses with no pinned key and passes the
pinned one, the insurer refuses to sign with the admin token and the old line is gone, and the boot
derives the pinned key from the same seed it gives the insurer.

**A12 implementation record.** Done 2026-10-17. Three broken features, not two.

*Credential generation (A-24, ENG-23).* The proof pool deserialises each argument using **its own
declared types**, not anything the caller sends. The two `Credential` methods declared their first
argument as a `StateTransitionProof`, while `CredentialProgram.proveHolding` actually takes a
`ProofGateProof` (`credential-program.ts:139`). There was no `ProofGateProof` entry in the
worker's codec table at all, so a ProofGate proof was parsed as a state-transition proof and the
job died with "Cannot convert undefined to a BigInt" every time the pool was running — which is
the production default, so the feature never worked in production and worked only on the inline
path. The type is now registered and both methods corrected.

*Member and family history (A-24, ENG-19).* Both referenced an identifier called `fulfillment`
that is declared nowhere in that scope, so **every member with at least one prescription got a 500
reading their own history**. `latestFill` is the fill record already in scope four lines above and
carries the settlement commitment. Two sites, same mistake.

*A third, found while verifying A8 (A-28).* A seeded provider node could register but could not
send an eScript. The starters derive the wallet ID from the fixture enrollment key and then drop
the key, so `encryptEScript` threw "Cannot send eScript: enrollment key not available" and the
prescriber path returned 500 on a clean boot. The codemap had recorded the omission as a safety
property — "no enrollment key is placed in local state" — without noting that it breaks the
feature which needs it.

The fix is one line per starter, and the reason it is safe is worth stating: `setEnrollmentKey`
and `useEnrollmentKey` operate on the in-memory obfuscated-key wrapper and **neither touches the
encrypted file or requires the state to be unlocked**. So the seed path still writes nothing to
disk, which is the property the codemap was describing, and a genuinely enrolled node is in
exactly the same position once it has unlocked. The starters also have no PIN — `start-leviathan`
passes `ZKTRIDENT_PIN` only to the member child — so persisting it was not an option anyway.

*The eScript chain had a third link, recorded as A-30 rather than fixed here.* Fixing A-28 moved
the prescriber's error from "enrollment key not available" to "Missing pharmacyWalletId" (the A5
regression, also fixed) and then to "recipient encryption key not registered" — each fix exposing
the next link. That last one is **not** a seeding quirk: `encryptEScript` needs the recipient's
X25519 public key from the sequencer, the member registers its key at enroll, the prescriber
registers its own **only inside the badge-tap handler**, and `pharmacy-routes.ts` contains no
`l2_registerEntity` call at all. So an encrypted eScript to a pharmacy is broken by construction.
Recorded as A-30 with the fix sketch — register the encryption key for every role at startup or
enrollment — rather than extended into this item a fourth time, because it needs its own
verification.

*Why these matter beyond being bugs, and what had to ship with them.* A-17 is the finding that
open credential minting would allow offline impersonation at a pharmacy, and the audit's own note
says it is "blocked in this deployment only by A-24: credential generation currently fails in the
proof pool. Treat as critical the moment A-24 is fixed."

So fixing A-24 **unblocks an attack**. `/interactive/generate-credential` mints a portable
credential for any wallet and `/interactive/credential-status` returns it, and neither was gated.
Shipping the repair on its own would have handed over a working exploit, so both routes were
admin-gated in the same change. That is an interim control and is labelled as one: the right
answer is a proof that the caller owns the wallet, which is the second half of A10. It costs
nothing today because only the visualizer calls these routes and the production launcher does not
serve it — the same situation as the identity dump in A11.

The general lesson, worth keeping: **check what a functional fix unblocks before shipping it.** A
bug can be the only thing standing between an open route and an exploit, and the audit had already
written down that this one was.

**A10, first half: who signed it.** Done 2026-10-17. Closes the forgery in A-12.

*The finding leads with the wrong detail.* A-12 says the attestation key derives from the public
literal `zkpcare-attestation-authority-seed`, so anyone with the source can sign. True, and bad.
But `verifyAttestation` verified against **`att.pk`, the public key carried inside the attestation
itself**, which means forging needed no seed and no secret at all: generate a keypair, sign an
attestation naming any wallet, embed your own public key, and it comes back valid. The pharmacy's
`/nfc/scan` then displayed that wallet as a verified member. A signature is only evidence if you
already know whose signature it should be.

*The fix.* `verifyAttestation(att, expectedPublicKeyHex)` now takes the key the **verifier**
trusts, compares it to the claimed key in constant time before touching the signature, and
**refuses when it has none** — no default, no fallback. Making the parameter required was
deliberate: the compiler then found every call site, which is how the five in the pharmacy's scan
handler were all updated rather than four of them.

*Where a pharmacy gets the key.* It asks the sequencer once, via `l2_getAttestationPublicKey`, and
pins it for the process. A counter that cannot obtain it **refuses to verify** rather than falling
back to trusting the tag. That is a deliberate availability cost and it is the right failure for a
credential check. Offline verification still works for as long as the key is cached, which is what
the design intends: the tag is checked against a key the pharmacy already holds, not against
itself.

*Two things this does not fix, stated rather than implied.*

- **`l2_requestAttestation` is still open**, so the sequencer will sign for any wallet it knows if
  asked. An attacker no longer forges one, but can still *request* one. Closing that needs proof
  that the caller owns the wallet, which is the same machinery as item D1, so it stays with the
  second half of A10.
- **The signing keys are still weak.** The engine's authority derives from the public literal seed,
  and the node's derives from the gossip secret, which every child process inherits (BOOT-05).
  Pinning means a forger must now use the *real* key, and both of those keys are obtainable.

*A third finding this turned up: A-29.* The employer onboarding path has the identical flaw.
`verifyEmployerSignature` and `verifyInsurerSignature` pass `att.publicKeyHex` and
`att.insurerPublicKeyHex` into the verifier, so an employer attestation carries its own trust
anchor and anyone can produce one that verifies. A10 fixed the NFC side only. The insurer's key
should come from its own configuration and the employer's from the approved application record,
both of which the insurer already holds.

*Another gap in the typecheck, found the same way as A8's.* `visualizer/` is not in the main
tsconfig's `include` either, so the engine's caller of this function compiled without complaint
while passing nothing. It failed closed, which is the design working, but it would have silently
broken the engine's own verification. Measured for the record: **44 type errors in
`visualizer/engine`**, alongside 39 in `tests/` and 2 in `scripts/`. Driving those to zero is its
own task; what matters here is that the numbers are now written down.

*Acceptance test.* `tests/attestation-trust.test.ts`, 15 tests. The one that carries the finding
is the pair: a forgery is refused against the trusted key, **and** the same forgery verifies
perfectly against its own author's key — which proves the refusal comes from the key check rather
than from a malformed object. Also: swapping the embedded key to the trusted one does not help,
because the signature then fails; a verifier with no key refuses a genuine attestation, so there
is no fallback path; and two structural checks that every pharmacy call site passes the pinned key
and the engine passes its own.

**A5 implementation record.** Done 2026-10-17.

*The shape of the problem.* The member node had 29 routes and **none of them authenticated
anything**. Anything that could reach the port could read the member's drug history and receipts,
send messages as them, assign their doctor, or mint their NFC identity payload. `GET /health`
additionally handed out the wallet ID, and `/onboarding/status` handed out the wallet ID plus the
enrollment token, group and plan. That identifier is the first link in the chain the audit
described: read it here, then ask the sequencer for that wallet's claims.

*A device session, not a per-request PIN.* The session is issued by `/onboarding/unlock`, which
since item A4 actually verifies the PIN against the encrypted state, so holding one means somebody
proved this device's PIN during this process's life. Requiring the PIN on every request would mean
the browser keeping the PIN, which is strictly worse. 27 of 29 routes now carry `deviceOnly`.

*The two that do not, and why.* `/onboarding/unlock` is open because it is what issues the
session. `/onboarding/eject` authorises on the **PIN** instead, which is strictly stronger than
holding a session a PIN once produced; requiring both would mean a member who knows their PIN
cannot wipe a device whose session expired without unlocking first, which is a two-step for no
gain. An admin credential also satisfies `deviceOnly`, so an operator tool is not locked out of
the node it administers.

*Conditional disclosure rather than a new route.* `/health` and `/onboarding/status` stay open,
because a readiness probe and the app's own pre-unlock onboarding screen both need them before any
session exists. What changed is that they disclose identity **only** to a request carrying the
session. An unauthenticated caller gets the role, the phase and the uptime — enough to answer "is
this node up and how far through onboarding is it", which is all a probe needs. This also fixed an
inconsistency: health read the wallet ID from the entity node while status read it from local
state, so a device that had derived a wallet but not yet built its node reported one and not the
other.

*The app needed real work, not just a header.* Three things, and the second is the one that would
have made the product look broken:

- Same-origin requests carry the session; requests to the sequencer, insurer or prover
  deliberately do **not**, because handing this node's session to another party is the credential
  leak the item exists to prevent. The cross-origin NFC write was left on plain headers for
  exactly that reason.
- **The app reloaded straight into the dashboard** on the strength of a wallet ID in
  `localStorage`, which is not a credential and never was — anyone with the browser profile had
  it. After this change every request from that state would have returned 401 and the app would
  have looked dead. The reload path now asks for the PIN, which is what a locked device should do.
- A session lasts an hour, so one can expire mid-use. The node answers 401 and the app now asks
  for the PIN again rather than showing an unexplained failure forever.

*What this is not, stated so nobody reads more into it.* It is a local session on a loopback-bound
node, so it defends the member against software on their own machine and against anything that
slips past the bind. It does not defend against a person holding the unlocked phone. And it says
nothing to the **sequencer**, whose own reads remain open: that is A-2, and item D1 is the fix.
**The provider and insurer nodes are still fully open** — they have no unlock route and so no
session, and their credential story is a FIDO2 authenticator under item B4. That is a real
remaining gap and it is recorded here rather than implied to be closed.

*Four test suites had to learn the session, which is itself the proof the gate is real.*
`key-custody`, `smoke-leviathan`, `smoke-e2e` and `production-showcase` all drive member
onboarding over HTTP and all started failing with 401s. Each now unlocks over HTTP and carries the
token, exactly as the app does. Both e2e harnesses gained a `mem()` wrapper that attaches it, with
`/onboarding/status`, `/onboarding/unlock` and `/onboarding/eject` deliberately called bare.

*Acceptance test.* `tests/device-session.test.ts`, 34 tests. Every route family is probed without a
session and must refuse; the session then opens them; a wrong session, and a session from another
device, are refused; unlocking again rotates the token and the old one stops working; the open
endpoints disclose nothing to a caller that proved nothing and everything to the device; an
operator bearer works but **still cannot produce the wallet ID while the device is locked**,
because identity lives behind the PIN and not behind the authorisation check; and eject takes the
PIN rather than a session. The last test is structural: it reads the route table and asserts that
the only routes without `deviceOnly` are unlock and eject, so a new route added without the flag
fails here instead of shipping open.

*A correction to this item, caught by the e2e harness and not by any unit test.* The first version
withheld identity on **every** role's `/health`, because `handleHealth` is shared by all node
types. Provider nodes have no unlock route, so nothing can ever authenticate to one to get the
value back, and the harness — which reads the prescriber's and pharmacy's wallet IDs from their
health in order to write a prescription — simply broke with "Missing pharmacyWalletId".

Scoping the withholding to member nodes is also the right line rather than a workaround. MEM-H1 is
about the member node, and a **member's** wallet ID is the one that unlocks PHI through the
sequencer's open reads. A provider's is a hash of an NPI published in a federal directory, and the
sequencer's own provider registry hands it out anyway, so withholding it here would cost a working
flow and buy nothing. What actually protects provider-keyed reads is item D1, at the sequencer.
`tests/device-session.test.ts` now pins that a prescriber node still reports its wallet ID.

The general point: **a shared handler changes every role that uses it.** Reading the client was
not enough here; the regression only appeared when the whole pipeline ran.

*Regression baselines, all matched exactly after the suites were taught the session:*
`smoke-leviathan` 14 of 46, `smoke-e2e` 32 of 65.

**A11 implementation record.** Done 2026-10-17.

*Six routes, one Set.* `interactive-routes.ts` already had a `reg()` helper that applies
`adminOnly` to anything listed in `ADMIN_ROUTES`, so this item is mostly a question of what belongs
in that list. Added: `/interactive/state` (A-13), `update-provider-network` (A-19), and the four
ledger controls `force-batch`, `save-checkpoint`, `retry-batch` and `simulate-batch-failure`
(ENG-11). The harness had already proved `force-batch` open on a live run — it asserts a refusal
and received a 200.

*Gating the dump costs nothing, because it had no production client.* `GET /interactive/state`
returns 137,035 bytes of identity data. Every reader is in `visualizer/src` or `visualizer/dist`,
and the production launcher serves neither; it serves `dashboard-leviathan` and the entity
dashboards, none of which touch the route. So this is another case where the dangerous surface had
no user in the product — the same shape as A2's proxies, with the opposite answer, because here
the non-production reader is a real tool someone runs.

*Departure from the item, stated plainly: the fixture PII is not stripped.* The item says
"admin-gate `/interactive/state` **and strip identity-linked fields from it**". I did the first and
not the second. The reason is what the fields are for. `demoData.members` carries each fixture
member's name, cardholder ID, date of birth, gender and home address, and the visualizer's member
screen **displays exactly those** — it is the screen that shows an operator what PHI looks like
before it is hashed, which is the thing the product claims to protect. Three facts follow:

- these are fictional fixture records in every build, not real members, so the data is not PHI in
  the sense I1 means;
- stripping them breaks the tool that exists to explain the model, and does not remove a single
  byte from the binary, because `MEMBERS` is compiled in either way;
- the fix that actually removes them is **F1**, relocating fixtures to a test-only tree with an
  import-graph test, which the plan already owns.

So gating is the real mitigation here and stripping would be a cosmetic trade against a working
tool. Recorded rather than quietly skipped. If the owner wants the fields masked anyway, the member
picker reads `index`, `firstName`, `lastName`, `cardholderId` and `familyId`, so masking the
cardholder ID to its last four characters is the one change that costs nothing.

*The harness had to be split, and the split is the interesting part.* It reads
`/interactive/state` for two unrelated reasons. Readiness, prescription status and enrolled-member
checks are the harness acting as an operator, and those now carry the admin token through new
`httpAdmin`/`quietAdmin` clients. The PHI sweep near the end reads it **deliberately
unauthenticated**, because its job is to measure what an outsider can collect. That call keeps the
bare client, and a refusal there is now the result we want. Switching it with the others would have
made the sweep silently start passing for the wrong reason, which is the kind of change that turns
an acceptance test into decoration.

*Acceptance test.* `tests/interactive-admin-gates.test.ts`, 13 tests, reading the registration
table rather than making requests, because the question is which routes carry the flag. It asserts
each newly gated route is in the set, that the pre-existing gates survived, that the console stream
stays open, and three things that keep the test honest: that every path in the set is a path this
file actually registers (a typo in the Set gates nothing and nothing complains), that the helper
still consults the set at all, and that the harness's PHI sweep still uses the **bare** client.

**A8 implementation record.** Done 2026-10-17. **Closes critical A-4.**

*The cause is sharper than the finding states, and the sharper version changes the fix.* The
audit called this an open route that returns a token. It is, but the code was doing it on purpose:
the rekey route carries the comment "Not admin-gated — applicationId (128-bit random) acts as the
bearer secret". A hundred and twenty-eight random bits **is** a fine secret. The defect is that
the same value is simultaneously an identifier, and this identifier is

- printed to the console at submission (`[marketplace] Application submitted: EMPAPP-…`),
- written to `nautilus-data/marketplace-applications.json` in plaintext,
- carried in URL paths, where proxies, browser history and access logs record it,
- and handed to the employer with "Save your application ID", plus a field to type it back in.

A secret that is logged, filed in the clear and put in a URL is not a secret. So the fix is not to
add a gate; it is to stop one value doing two jobs.

*What changed.* `applicationId` keeps every job above. A separate 256-bit secret is generated at
submission, returned **once** as a single `activationCode` string the employer saves, and kept only
as a SHA-256 hash. Credentials come from a new `POST /marketplace/api/activate-credentials/
:applicationId` that takes the secret **in the body**, compares it in constant time, and works
exactly once. `activate-status` stays open and reports progress, because progress is not a
credential and the dashboard polls it every two seconds.

*Both leaking paths, not just the named one.* The audit named `activate-status`. The `activate`
POST also returned the token on its idempotent branch, so re-posting activate for an
already-provisioned tenant handed it out again. Closing only the route named in the finding would
have left the same credential one request away.

*A second hole in the same family, which the audit did not record.* `POST
/employer-applications/:applicationId/rekey` replaced the employer's `publicKeyHex` for anyone
presenting the application ID. That is the key the insurer is about to attest, so a reader of the
insurer's log or its plaintext store could substitute their own signing identity for the
employer's before signature. It now requires the same secret. It is still **not** insurer-admin
gated, because an employer who has lost their key has to be able to recover without the insurer,
which is the whole point of the route.

*Why not the plan's original prescription.* This item said "gate `activate-status` and `activate`
behind insurer admin". That closes the hole and also ends self-service employer signup, which is
an active product goal rather than an accident: the employer applies on a public page and has no
prior credential to authenticate with. The one-time secret closes the hole and keeps the employer
able to finish their own activation. The cost is one line of UX — the employer saves an activation
code instead of an application ID — against the insurer having to deliver credentials out of band
for every tenant.

*On rotating the four exposed tokens.* They belonged to e2e fixture tenants (`e2e-a-mva0yqkn-admin-…`),
and the owner's standing instruction is that fixture keys are fake and will never be used again.
The application store is not on disk at all right now. So there is nothing to rotate; what mattered
was that new tenants stop being issued the same way, which is what changed.

*The no-oracle property.* An unknown application and a wrong secret return the same status and the
same message, so neither route can be used to discover which application IDs exist.

*Acceptance test.* `tests/marketplace-credentials.test.ts`, 13 tests. It asserts the secret is not
the application ID, that only its hash is stored and the secret appears in no stored field, that
collection is refused without it, with a wrong one, and with the application ID presented as the
secret, that a replay is refused, that an unknown application is indistinguishable from a wrong
secret, and that rekey can no longer swap the signing key without it. One test is **structural**:
it reads the route file and asserts the admin token appears in no response other than the
secret-gated one, so a future edit cannot quietly put it back on a route no test exercises.

The suite stands up a **stub sequencer**, because `apply` checks employer-ID uniqueness against
the sequencer and fails closed when it cannot reach one. That is correct behaviour and was left
alone rather than loosened to suit a test.

*Two bugs of my own that this item surfaced, and the gap that hid them.* `npx tsc --noEmit` checks
only `src/**/*`: the main tsconfig's `include` says so, and `tests` is in its `exclude`. So
`scripts/` and `tests/` have never been typechecked. `tsx` and `ts-jest` transpile without
checking, which means a type or syntax error in an acceptance script only surfaces when it runs.
Two had already shipped:

- `check-phi-containment.ts` carried a **broken string literal** from the A3 commit, so the PHI
  containment check would have crashed on its next run. It was a shell heredoc eating a backslash
  escape, the third time that happened this session.
- `run.ts` had a **duplicate `const cred`** from this item, which only appeared when I ran the live
  verification and esbuild refused the file.

Added `tsconfig.scripts.json` and `npm run typecheck:scripts`, which overrides the base config's
`rootDir`. The acceptance scripts are now clean; two pre-existing errors remain elsewhere in
`scripts/` (`bootstrap-system.ts:262`, `measure-verify.ts:47`), neither on the verification path,
recorded rather than fixed. Also added `npm run typecheck` as a name for the `src` check that was
only ever invoked by hand. **`tests/` is still unchecked** — 39 errors under the same options — and
that is a job of its own rather than a line in this item.

The lesson for the cost rules: *a green typecheck was never covering the code that proves the
fixes work*. Run both from here on.

*A new finding the live run turned up, unrelated to this item.* **A-28: a seeded provider node can
register but cannot send an eScript.** The prescriber starter derives the wallet ID from the
fixture enrollment key and then never stores the key, so `encryptEScript` throws
`Cannot send eScript: enrollment key not available` and the prescriber path returns 500. The
codemap recorded the omission as a safety property — "no enrollment key is placed in local state"
— without noting that it breaks the feature that needs it. Independent of A3, which touched only
the deleted backup route in that file. Belongs with A-24 in item A12.

*Four harness assertions failed and none of them is A8.* One expects the sequencer to refuse
`admin123`, which it accepts because this boot set `ZKTRIDENT_UNSECURE=true` — a boot-mode
mismatch, not a defect. Two are **A-9**, the member not being bound to the employer's group, which
item C2 owns. The fourth is A-28 above. All five A8 assertions passed.

**A4 implementation record.** Done 2026-10-17.

*The root cause was one sentence wide.* `unlock(pin)` derived a scrypt key and returned. Deriving
a key **cannot fail** — scrypt is a key-derivation function, not a check — so the key was set for
any input, including six characters of junk. `isUnlocked()` was literally `derivedKey !== null`,
so it became true. The unlock handler's catch returned 400 without locking, so the key stayed set
across requests. And that flag was the **only** gate on the route that deletes the device's state
file. Four links, one request: any junk PIN armed the wipe. With the launcher's environment PIN the
flag was already true at boot, so eject needed no PIN at all.

*The fix is to make the function mean what its name says.* `unlock` now decrypts the state file
with the derived key before reporting success. A wrong PIN wipes the candidate key, counts the
attempt and throws, leaving the device exactly as locked as it was. A first run with no state file
is still accepted, because there is nothing on the device to protect yet. `isUnlocked()` now
reports a separate `pinVerified` flag rather than the presence of a key.

*Eject asks again anyway.* It takes a PIN in the request body and checks it with a new `verifyPin`,
which verifies without changing the lock state. `unlock` verifying would have been enough to close
the finding, but an irreversible action should prove the owner is at the device **now**, not that
someone unlocked it this morning. Both paths share one attempt counter, so neither can be used to
grind the other's limit.

*Attempt limiting, and where the counter had to live.* A six-digit PIN is a million guesses and
scrypt at N=2^15 costs about a tenth of a second, so an unbounded attacker finishes the space in
roughly a day. Three failures are free, then the delay doubles from 2 s to a 15-minute ceiling.
**The counter cannot live inside the encrypted state file**, because that file is encrypted under
the very PIN being guessed — a counter in there could not be read until the guess had already
succeeded. So it is a plaintext sidecar, mode 0600, beside the state, which also means it survives
a process restart. A wipe clears it, so a fresh enrollment on the same device is not born locked
out.

**Backoff, never a wipe.** The obvious design, erase after N failures, would have converted this
very finding — a device wipeable by an unauthenticated caller — from a bug into a documented
feature reachable by anyone able to send ten requests. Delay is the only safe lever.

*A damaged file is not a wrong PIN.* The check distinguishes a malformed envelope from a failed
authentication tag, and only the second counts against the limit. Otherwise the owner of a
corrupted state file would be locked out of their own device by the corruption.

*A fifth link, which the audit did not have and reading the code would not have found.* Probing
the running node turned up that the unlock route returned `{ unlocked: true, alreadyUnlocked: true
}` the moment the state was unlocked, **without looking at the PIN at all**. The launcher
auto-unlocks from the environment, so that is a device's normal condition after boot, which means
the member-facing PIN screen accepted any PIN for the life of the process. It granted a caller
nothing they did not already have, so it is not a privilege escalation; what it did was make the
PIN gate decorative, and a prompt that accepts anything is worse than no prompt because it implies
a check happened. The route now verifies either way, rate-limited on the same counter, and a wrong
PIN does not lock a device that was legitimately open. **This is the second finding this session
that only a live probe would surface** — the first was A2's `/rpc` proxies having clients that a
grep could not see. Read the code, then poke the thing.

*A failure no longer half-erases the app.* The member dashboard used to clear all browser state
"regardless of server result", so a refused eject still emptied the app while the device kept its
key and wallet. It now prompts for the PIN, sends it, and clears the browser copy **only** when the
device confirms the erase.

*Known limit, recorded rather than hidden.* The backoff is wall-clock, so moving the device clock
forward skips it. Whoever can set the clock already holds the device, which is not a threat this
mechanism can address; a monotonic counter would survive a clock change but not a file delete, and
the same holder can delete the file.

*Acceptance test.* `tests/pin-custody.test.ts`, 24 tests. It walks the original chain step by step
against a real HTTP server with a real encrypted state: a junk unlock is refused, eject with no PIN
is refused, eject with a wrong PIN is refused, repeated wrong PINs start answering 429 with a
`Retry-After`, and the state file still exists after every one of them. Only the right PIN erases
it. It also pins the properties that are easy to regress: a correct PIN is refused while throttled,
the counter survives a new instance, and the counter is never written inside the encrypted file.

**A3 implementation record.** Done 2026-10-17.

*The finding was scoped too narrowly.* The audit recorded `backup-key`, `restore-key` and the
inbound-key path against the **member node**. All three were also on the **pharmacy** and
**prescriber** nodes, with the same shape and the same absence of authentication, so a provider's
enrollment key was exportable by anyone who could reach the port. Six routes removed, not two,
and three `generate-key` handlers changed, not one.

*Two of them had live clients, which is why reading the client first mattered.* After A2, where I
nearly switched off a proxy two dashboards depend on, I checked before deleting:

| Route | Client | What the client did |
|---|---|---|
| `backup-key` | `dashboard-prescriber` | A **Backup Key** button that prompted for a PIN and then **rendered the AES-GCM blob into the page** as selectable text |
| `generate-key` inbound key | `dashboard-pharmacy` | An **enrollment-key input field**, on a wizard panel whose own description read "A cryptographic enrollment key will be generated locally on this device. It is NEVER transmitted." |
| `restore-key` | none, on any dashboard | Nothing. Pure surface |

Both clients are removed with the routes: the prescriber's button, its handler and its markup; the
pharmacy's input, its label and the argument that carried it. The member dashboard's Restore tab is
**not** touched, because it never used these routes — it decrypts a pasted card with Web Crypto in
the browser. It writes the recovered key to plaintext `localStorage`, which is MEM-H4 and belongs
to item C3.

*Why authentication was not the answer.* Rule I3 puts the enrollment key in secure storage and on
an offline card under a PIN. A route that returns the key cannot be made to satisfy that by adding
a token, because the export is the breach, not the lack of a check. `backup-key` was worse than
unauthenticated: it took the **PIN from the request body**, so the caller chose the PIN, received
the ciphertext and decrypted at leisure. A card-plus-PIN second factor means something only when
the party holding the card is not also the party that set the PIN, and over HTTP it always was.

*What tests do instead of posting a key.* `production-showcase.test.ts` imported known seed keys
over HTTP so later proofs would be deterministic. It builds its nodes in-process, so it now sets
the key on the device's own local state directly — which is what a device does. The phase still
advances through the route; only the key stops crossing a boundary.

*A sweep for anything else that touches key material*, since this finding's scope was wrong once
already. Every remaining `useEnrollmentKey` call reconstructs the key inside a closure to derive
the wallet, derive an encryption keypair (returning only the public half), or encrypt a message;
none returns it. `setEnrollmentKey` is now reached only from `generate-key`, with a locally
generated key. Two key-adjacent routes are left alone because the plan already owns them: the
provider `/interactive/badge/tap` on the pharmacy and prescriber nodes, where the badge is the
enrollment key under a fixed development PIN, is retired by the phase-C decision to use a FIDO2
authenticator instead; and the employer `set-pin-hash` and marketplace `rekey` routes belong to
items A8 and A9.

*Acceptance test.* `tests/key-custody.test.ts`, 20 tests. It asserts the two routes are **absent
from the route table** of all three node types, which is stronger than a 404 from a running server
because a route cannot be reintroduced without failing here, and it checks no remaining path
matches backup, restore, export or reveal at all. The inbound-key path is checked behaviourally:
hand a member node a strong, known key, derive a wallet, and assert the wallet is **not** the one
that key would produce. It also reads the real generated key out of local state in-process and
proves it appears in no response body.

The last test is the positive counterpart, and it is there to fail fast. It sets a known key on a
device in-process and asserts the derived wallet equals `deriveMemberWalletId` over that key — the
exact mechanism `production-showcase.test.ts` now depends on. Without it, a mistake in the seeding
helper would only surface fifteen minutes into a suite that generates real recursive proofs.

*The gap this leaves, stated rather than hidden.* **There is no backup at all until A12b writes the
card.** That is a product gap, not a regression in safety: what existed was not a usable backup but
an export anyone on the port could request, delivered as text in a browser. A12b is already in
phase A for this reason, because the enrollment tap is the only moment the key is in hand. Until
then a lost device loses the wallet, which was already true in practice — the browser card flow
encrypts the literal string `server-managed` for normally-enrolled users (MEM-M5), so the designed
recovery path has never worked.

**A6 implementation record.** Done 2026-10-17. Closes the validate half of AUTH-13 and the
cross-tenant exposure recorded the same day as **A-31**; FIG. 4 `456` (DISTRIBUTED → CONSUMED) now
describes the code.

What a code is now. `src/onboarding/enrollment-code.ts`: `PPPP-XXXX-XXXX-XXXX-XXXX`, 80 random
bits in Crockford base32 behind a four-character routing prefix derived from the issuing employer's
ID, with one canonical spelling (upper case; `O`→`0`, `I`/`L`→`1`; `U` is not in the alphabet). The
member node canonicalises at `accept-token`, so the PIN hash is computed over exactly the string the
employer holds. `TokenAuthority.generateToken` issues these when no ID is named; the employer's
`/tokens/generate` refuses a caller-chosen ID outright, since the HR Tool never sends one and an
operator-chosen code is exactly as guessable as its operator.

How a code is consumed. `TokenAuthority.redeemTokenWithPin` validates and consumes in one step and
returns no wallet ID; `EmployerNode.redeemTokenWithPin` wraps it and does the roster and
enrollment-cap bookkeeping that `confirmEnrollment` used to do on the member's say-so. The validate
oracle calls it. `validateToken`, `validateTokenWithPin` and `consumeToken(walletId)` remain for the
in-process `EnrollmentService` and the engine, where employer and insurer are one process and I6
does not arise. `/enrollment/confirm`, `/tokens/:id/submit`, `confirmEnrollment` and
`submitTokenToInsurer` are deleted: every one of them carried the member's wallet ID to the
employer, and the only reason the first never leaked one is that the member node called an
admin-only route without credentials and got a 401. The member node no longer calls the employer
at all.

Who may ask the oracle. `POST /tokens/:tokenId/validate` answers only a request signed by the
insurer: `X-Admin-Signature` / `X-Content-Hash` in the format the HR Tool already uses, verified by
`src/security/signed-request.ts` against `attestation.insurerPublicKeyHex`, the key the sequencer
only stored after checking the insurer's counter-signature against the key it pins (A9). The trust
chain is insurer → sequencer → attestation → employer, and no secret had to be distributed. The
verifier recomputes the content hash from the body actually received, names the signer it expects,
enforces a 30 s window and refuses a replayed signature; `checkNautilusAdminAuth` does none of the
first (AUTH-14), and moving it onto this verifier is part of A9's remainder. Order of refusals: an
unsigned request is 401 before anything about the node is disclosed; no attestation loaded is 503;
a bad signature 401; then `tokenPinHash` required, the orphan check (generation succeeded,
set-pin-hash did not: 409, not a PIN attempt), then redemption. In front of all of it,
`src/security/rate-limit.ts`: 60 a minute per caller address and 600 overall, per node.

How the insurer finds the employer. A code is required; there is no enrollment the insurer
accepts on a wallet's say-so. The code's prefix is matched against the sequencer's tenant registry
and exactly the matching employer is asked; an identifier that is not a code is tried only against
the employer the member named; a static `employerUrl` still wins for single-tenant deployments. The
fan-out is gone. It had posted each member's code and `Poseidon(code, 0, PIN)` hash to every
tenant's open oracle until one recognised it, and an 8-digit PIN inverts offline from that hash in
minutes, so any tenant could have enrolled as another employer's employee first. That is A-31. A
401, 503 or 429 from an employer is reported as a 502 and never read as a verdict; "not found"
moves to the next candidate; any other reason is the verdict and a 403. On `valid` the insurer
records the redemption against the wallet and persists it before doing anything else, so a retry
after a crash is idempotent for that wallet and a 403 for any other. The window in which a crash
between the employer's consumption and that write burns a code is one in-memory write and a file
save; recovery is HR re-issuing a code, which is an existing flow. Persistence is best-effort while
the insurer's local state is locked, which it is in the production boot, where only the member
child receives a PIN; the enrollment registry has had the same limitation since it was written,
and both belong with the insurer-host work in A7.

Verified. `tests/enrollment-codes.test.ts`, 48 tests: the code (format, randomness, the base32 bit
reader at both ends of the alphabet, repair of what people type), the authority (redeem consumes,
twice refused, wrong PIN does not consume, five lock it, no PIN bound cannot be redeemed), the
verifier (wrong key, wrong signer, wrong path or method, swapped body, stale, replayed, no key),
the limiter, the employer oracle through its real handlers (unsigned 401 with and without an
attestation, attacker key 401, swapped body 401, wrong PIN leaves the code unused, right PIN
consumes it and counts the cap once, replay 401, second redemption "already consumed", orphan 409,
foreign code "not found", caller-chosen ID 400, the removed routes absent), the insurer against a
stub sequencer and two stub tenants (code required; only the issuing tenant is probed, with a
signature the stub verifies; redemption persisted; same wallet idempotent without a second probe;
other wallet 403; unknown prefix 403 with no probe; wrong PIN not recorded; a tenant's 401 is a
502; a non-code identifier never fans out; no seed is a 500; redeemed codes survive a restart), and
the member node (what was typed is stored canonical; the employer callback is gone). The eight
A-phase suites pass; `onboarding` and `wallet-migration` carry the same 17 failures by name as
HEAD; `smoke-leviathan` is 14 of 46 with identical names; `smoke-e2e` went from 32 failures to 30,
P2d and P2e, with no new failure by name; `production-showcase` 26 of 35 failing, its recorded baseline exactly
(count-matched rather than diffed by name: the suite takes 22 minutes, and it never touches the
enrollment-code path, with no `/tokens/generate` and no employer node, so a swap is not plausible). Typecheck unchanged
at the 21-error src baseline. Live: on a secured boot (random admin token and gossip secret, no `ZKTRIDENT_UNSECURE`; the harness
confirms the old demo token is refused), the HR Tool issued two codes, the member device accepted
`JF8M-79KP-6AD8-4YFB-7WP1`, and the insurer logged `Code redeemed with employer E2E-EMP-MVD53IDO`
and then `Member enrolled`, with no 401, 403, 502 or 503 anywhere on the path: the signed probe
was verified by a spawned employer node against its own attestation and the code was redeemed.
Through the enrollment and registration stages the harness recorded 38 passes and 3 failures, all
three known: two are A-9 (the wallet is not bound to the employer group, item C2) and one is A-30
(the pharmacy never registers an encryption key, so an eScript cannot be sent). Full pipeline for
this run, with the sequencer's stderr captured in the boot log this time: 94 of 111 checks passed across 24 steps by the harness's own
summary, 94 PASS / 34 FAIL lines against 93 / 36 on the last complete run. It reached the end
for the first time since the stage-19 deaths, with the sequencer still up afterwards and nothing
in its captured stderr beyond a routine `Worker 0 recycled after 3 jobs (WASM heap reclaimed)`;
the earlier deaths coincided with the orphaned processes described below, which is consistent
with starvation rather than a defect, though not proof of it..

Found on the way, recorded rather than fixed. `GET /groups` is still open (AUTH-13's other half,
A7). `role`, `groupId` and `planId` are still taken from the body (A-9, C2). Anyone holding a valid
code and PIN can still name any `walletId`; binding the wallet to its prover is B2. The orchestrator
never reaps the employer nodes and HR Tools it spawns: five employer nodes and three HR Tools from
four harness runs since 14:08 were still alive on this machine, which is an availability and
hygiene problem for A7 or phase F. And the smoke and showcase suites do not hang: Jest finishes and
then does not exit, because of open handles; run them with `--forceExit`, and treat a "wedged" run
as finished until proven otherwise.

**A7 implementation record.** Done 2026-10-17. Closes **A-21** (PHI-4, CONT-3) and the other half
of **AUTH-13**; records why the orchestrator's children used to outlive it, and stops it.

Where the HR Tool runs. Nowhere on the insurer's host. The orchestrator no longer spawns it;
activation returns `hrToolSetup` (a command and four steps) instead of a hosted URL, the marketplace
page shows those steps where the link used to be, and the sequencer's tenant registry no longer
requires `hrToolUrl`. The employer's HR administrator runs `npm run start:hr-tool` on their own
machine and, the first time, `POST /api/setup` takes the employer node URL and the admin token that
activation handed over once, plus a passphrase of at least 12 characters typed twice. The token is
stored encrypted under that passphrase beside the workspace's client key (`admin.token.enc`, mode
0600) and is never read from a process environment again; `EMPLOYER_NODE_URL` survives only as the
default offered on the setup screen. `POST /api/workspace/admin-token` stores or rotates it for a
workspace created before this change, after the passphrase is typed again.

Unlocking. `POST /api/unlock` opens the one workspace on the machine, or the one named by its
employer node URL, and no longer creates anything. It is attempt-limited by
`src/security/attempt-limiter.ts`, the device PIN's shape from A4: three free attempts, then a delay
that doubles from two seconds to a fifteen-minute cap, counted in a plaintext sidecar beside the
encrypted workspaces because the counter cannot live inside a file encrypted under the passphrase
being guessed. A throttled attempt is a 429 with `Retry-After`. Never a wipe.

The second factor. The PIN is returned once, in the import result, for the SMS step; the import
response says so and the page offers the one-time download there. It is kept encrypted in the
correlation table so that a lost text can be re-sent, but `/api/employees`, `/api/employees/:id` and
`/api/export/tokens` never carry it again. Reading one back is `POST /api/employees/:hash/pin`: the
passphrase again, compared in constant time and counted on the unlock limiter, and an audit line
that names the hash. The reason for keeping it at all is stated in the code: an HR insider who can
read code and PIN later holds both factors, so the reveal is deliberate and recorded rather than
a column in a list. The audit log otherwise records hashes and counts: `employees:lookup` names a
hash prefix, `employees:list` records whether a search happened and never the term.

The employer node. `GET /groups`, `/groups/:groupId` and `/groups/:groupId/stats` are admin, which
closes AUTH-13; the HR Tool and the employer dashboard both hold the token, and the smoke test that
read them bare now sends it and asserts the 401 first.

Tenants that die with their parent. Five employer nodes and three HR Tools from four harness runs
were found alive on this machine, and a later shutdown of mine missed a whole network because a
PowerShell filter was mangled by shell quoting and I read "0 processes" as success while the port
count said otherwise. Two things change. The orchestrator spawns the employer node from the node
binary with tsx's loader rather than through `npx` and a shell, so a tenant is one process instead
of three, and passes `ZKTRIDENT_PARENT_PID`; `src/nodes/parent-watchdog.ts` polls that PID every
ten seconds and shuts the node down when it is gone, which is the case the graceful handlers can
never cover. `ZKTRIDENT_UNSECURE` is no longer passed to the child, and is stripped from what it
inherits; the employer launcher never read it, so this is hygiene, and the "bearer-mode admin" on
spawned nodes is simply what every node does until a client key is registered, which is A9's
remainder. The harness and `run-multi.ts` start their own HR Tool(s), as an employer would, and
stop them however they exit.

Verified. `tests/hr-tool-lockdown.test.ts`, 15 tests that start the real server binary the way an
employer would, against a stub employer node that records the credential it is shown: unlock before
setup refused; the passphrase policy; setup stores the token encrypted and the environment token is
ignored; the stored token is what reaches the employer node; three wrong passphrases plain, the
fourth throttled with `Retry-After`, the right one accepted after the delay with the token on file;
PINs once at import, never in lists or exports; the reveal needs the passphrase and returns the same
PIN; the audit log names hashes and events only; and, by construction, the orchestrator spawns no
HR Tool and ties the tenant to its parent, the launcher watches it, the group reads are admin, and
the server reads no token from its environment. `tests/attempt-limiter.test.ts` (6) and
`tests/parent-watchdog.test.ts` (5, one of them across processes). The A6 and marketplace suites pass; `smoke-e2e` stays at 30 of
65 failing with P2f and P13a passing under the gate. Typecheck src 20 (one of the 21 baseline errors
was in the code replaced), scripts 2. Live, on a secured boot after the stale network was found and
killed (below): `Activation hands over HR Tool setup steps, not a hosted URL`, `A short passphrase is
refused at setup`, `HR Tool workspace set up with the activation credentials`, `PINs were returned
once, at import`, `The export carries no PINs`, `The employee list carries no PINs`, then enrollment
through `Insurer accepted the enrollment` and the registration proof, with the three known failures
(two A-9, one A-30) and nothing new. Tenant shape and the orphan fix: the tenant is one `node.exe --import tsx
…start-employer-nautilus.ts` with the insurer's node process as its parent, and the harness's HR Tool one
process under the harness, both confirmed in the process table. When the insurer's node process was then
killed hard, the tenant was gone within two seconds. Whether the watchdog's poll or the broken stdio pipe
got there first is not observable from outside, so the mechanism is also proven in isolation:
`tests/parent-watchdog.test.ts` spawns a quiet child with no pipes at all watching a dummy parent, kills
the dummy, and the child exits on its own. Full pipeline:
100 of 117 checks passed across 24 steps, to the end; the six checks A7 added all pass and the 34
failures are identical by name to the A6 run.

A mistake, recorded because it changed a result. The first A7 live run was invalid: the A6-era
network was still running underneath it, so the old insurer answered activation with a hosted URL
and the only failure that run showed was the old code. The check that said the network was down
counted processes through a filter that shell quoting had broken; the port count in the same output
said nine. The rule from it: trust the port count over the process count, and put any PowerShell
filter in a `.ps1` file run with `-File`, never inline.

Left for later, by design. The correlation table is still plaintext inside its encrypted file, on
the employer's machine, which is where I5 puts it. The legacy CLI `src/tools/hr-tool.ts` still
takes `EMPLOYER_ADMIN_TOKEN` from its environment; it is not in the product path and is queued for
the fixture clean-up. Moving the HR Tool from the bearer token to its Ed25519 client key, with the
employer node registering that key and `checkNautilusAdminAuth` recomputing the body hash, is A9's
remainder, now with the verifier and the hand-over flow in place.

**A9 remainder implementation spec: one credential per principal.** Written 2026-10-17 before the
work, because the credential model is what A13 (replica credentials) and phase E (per-node gossip
identities) build on, and getting it wrong twice would cost more than writing it down once.

What is wrong, measured. `ZKTRIDENT_ADMIN_TOKEN` is five things: the sequencer's bearer for 17 admin
RPC methods and every admin-gated HTTP route; the insurer node's own admin bearer; the credential the
insurer, member and prescriber nodes present to the sequencer (`clientOptions.adminToken`, and nine
hand-built `Authorization: Bearer` headers in `insurer-routes.ts`, `marketplace-routes.ts`,
`member-routes.ts`, `prescriber-routes.ts` and `start-insurer-nautilus.ts`); the value the launcher
puts in all four children's environment; and, because every child inherits `process.env`, a value
the explorer and the proof-pool workers carry too. The sequencer has an Ed25519 admin-key path, but
its registry is empty in every real boot, so the bearer path is the one in force; its HTTP-route
variant signs a constant message, so one signature would open every admin route; and the node
servers' own Ed25519 mode signs the caller's `X-Content-Hash` header without recomputing it
(AUTH-14) and has no caller that registers a key. Node admin surfaces today: insurer 13 routes,
employer 13, marketplace 6; member, prescriber and pharmacy nodes have none. Sequencer admin calls by
role today: insurer `l2_credentialProvider`, `l2_updateProviderStatus`, `l2_publishPlanOverlay`,
`l2_registerEmployer`, `l2_revokeEmployerAttestation`, `l2_registerEmployerNode`; member and
prescriber `l2_registerEntity`; pharmacy none (A-30 will add `l2_registerEntity`); employer none.

The model. Three kinds of principal, each with exactly one kind of credential:

- **The network operator** keeps `ZKTRIDENT_ADMIN_TOKEN` as a bearer, and it is accepted only by the
  sequencer. The harness, the operator console and a human at the Leviathan dashboard are this
  principal. Nothing else ever holds the value: the launcher strips it (and every other secret it
  knows) from the environment it hands to any child, including the explorer and the proof workers.
- **A node** holds an Ed25519 key of its own, generated by the launcher at boot (32 random bytes,
  never written to disk, new on every boot) and handed to the child through its environment as
  `ZKTRIDENT_NODE_ID` + `ZKTRIDENT_NODE_KEY_SEED`. Before spawning, the launcher registers the public
  half on its in-process RPC server with a **role**. The sequencer authorises a signed request by
  role: insurer may call the six methods above plus `l2_storePlan`, `l2_deletePlan`, `l2_storeFormulary`
  and `l2_deregisterEmployerNode`, and the engine's insurer actions (`approve-prior-auth`,
  `deny-prior-auth`, `terminate-member`, `terminate-group`, `update-formulary`, `plan-year-rollover`);
  member, prescriber and pharmacy may call `l2_registerEntity` and nothing else; `replica` may call
  `l2_gossipRelay` (unused until A13); the operator's keys, genesis and admitted, keep every method.
  A signature with a valid key and the wrong role is a 403, not a 401. Compromise of a node now
  yields that node's role, not the network.
- **A node's own admin routes** (insurer, employer, marketplace) authenticate the people and tools
  that operate *that node*: bearer with that node's own token, or a signature from a client key that
  node registered. The insurer node's token is `ZKTRIDENT_INSURER_ADMIN_TOKEN` when set, otherwise
  derived by the launcher as `HMAC-SHA256(ZKTRIDENT_ADMIN_TOKEN, 'zpk.care/node-admin/v1\n' + 'insurer')`,
  so a one-variable deployment keeps working and the insurer node still cannot recover the operator's
  token from what it holds. Employer tenants already have per-tenant tokens (A8).

One wire format, one verifier. Every signed request, to the sequencer or to a node, is
`src/security/signed-request.ts`'s: `X-Admin-Signature: <signerId>:<timestamp>:<sigHex>` over
`${METHOD}:${path}|${timestamp}|${sha256(body)}`, hash recomputed from the bytes received, 30 s
window, replay cache. For RPC the path is `/rpc` and the body is the JSON-RPC envelope, which binds
the method and the parameters. The sequencer's `${method}|${paramsHash}|${ts}` format and its
constant-message route variant are deleted, `L2Client` signs the new way, and the node servers'
Mode A becomes the same verifier, which closes AUTH-14. Because the signature covers the body and
the gate runs before the handler, the body is read once at the gate and cached on the request
(`src/security/request-body.ts`); the three body readers (sequencer, node servers, engine routes)
return the cached bytes. Bearer and signature are alternatives everywhere, not modes: registering a
key no longer switches a server to signature-only, so the insurer keeps reaching a tenant's routes
with the tenant token after the HR Tool registers its key.

The HR Tool. It already generates an Ed25519 client key at setup and stores it under the passphrase;
what was missing is the employer node registering it. `POST /admin/client-keys` (admin-gated, so the
tenant token presented once at setup is what authorises the registration) records the key; the HR
Tool then signs every request and uses the stored token only to re-register after the employer node
has restarted (keys are held in memory, and tenants die with their parent). `GET` lists and `DELETE`
revokes.

Launcher hygiene, in the same change because it touches the same function: children are spawned
with `process.execPath --import tsx`, no shell, `windowsHide`, `ZKTRIDENT_PARENT_PID` set, and the
member, prescriber, pharmacy and insurer scripts watch their parent the way the employer node does
(A7), so no node outlives the sequencer that keyed it.

Verified by. `tests/node-roles.test.ts` (allowlists, derivation, key generation, environment
scrubbing); `tests/rpc-role-auth.test.ts` (a real `L2RpcServer`: bearer still works with keys
registered; insurer key passes its methods and routes and is refused the operator's; member key
passes `l2_registerEntity` only; replay, tampered body and the old constant-message signature all
refused; a handler behind the gate still receives the body); `tests/nautilus-signed-admin.test.ts`
(a forged `X-Content-Hash` is refused: AUTH-14; bearer and signature both accepted; replay refused);
`tests/hr-tool-lockdown.test.ts` extended (setup registers the key; requests are signed; a 401
re-registers once); `tests/launcher-credentials.test.ts` (no child receives the operator token or any
other secret it does not need; each gets a key; spawn is shell-less). Then the full secured pipeline,
which now exercises the insurer's role for provider credentialing at boot and the member's for its
encryption key, with the failure set compared by name.

**A9 remainder implementation record.** Done 2026-10-17. Closes **A-14** and **AUTH-14**.

What changed, by principal. The network operator's `ZKTRIDENT_ADMIN_TOKEN` is now accepted by the
sequencer and by nothing else: the launcher strips it, and every other secret it knows, from the
environment of every child it starts (`childEnvironment`), including the explorer, the prover and
the proof-pool workers, which inherited all of it before. Each node the launcher spawns gets an
Ed25519 key generated for that process and never written to disk (`generateNodeKey`), handed over
as `ZKTRIDENT_NODE_ID` + `ZKTRIDENT_NODE_KEY_SEED`, and registered on the in-process RPC server with
a role before the spawn (`L2RpcServer.registerNodeKey`, entries marked ephemeral and excluded from
checkpoints). The sequencer's gate (`authorize`) accepts the operator's bearer or a registered key's
signature as alternatives, never as modes, and authorises a signature by the key's role from the
tables in `src/security/node-roles.ts`: insurer ten methods and six engine actions, member,
prescriber and pharmacy `l2_registerEntity` only, replica `l2_gossipRelay`; the wrong role is 403
(`RPC_FORBIDDEN`, -32004), not 401. The insurer node's own routes take `ZKTRIDENT_INSURER_ADMIN_TOKEN`,
derived from the operator's token by HMAC when not set, so the insurer holds a token it cannot turn
back into the network's. Member, prescriber and pharmacy nodes have no admin routes and hold no
token at all.

One wire format. The sequencer's `${method}|${paramsHash}|${ts}` signature and its constant-message
variant for HTTP routes are deleted; `L2Client`, the node servers' outbound helper
(`sequencerAuthHeaders`, `signedFetch`, `sequencerClientOptions`) and the orchestrator all sign with
`src/security/signed-request.ts`, and the sequencer and the node servers verify with it. That closes
AUTH-14: `checkNautilusAdminAuth` recomputes the content hash from the body received instead of
trusting the caller's header. Because the signature covers the body and the gate runs first, the
body is read once per request and cached (`src/security/request-body.ts`); the sequencer's, the node
servers' and the engine's readers share it. Nine hand-built bearer headers in `insurer-routes.ts`,
`marketplace-routes.ts`, `member-routes.ts`, `prescriber-routes.ts`, `start-insurer-nautilus.ts` and
the orchestrator became signed calls; two dead ones to the insurer's open `/enrollment/process` were
removed; seven `clientOptions: { adminToken }` sites became `sequencerClientOptions()`.

The HR Tool. The employer node gained `POST`/`GET`/`DELETE /admin/client-keys` (admin-gated, so the
tenant token presented once at setup authorises the registration). The HR Tool registers its client
key at setup and signs every request from then on; the stored token is used again only to re-register
after the employer node has restarted, which a 401 to a signed request signals. `authMode` reports
`ed25519`.

Launcher hygiene. Children, the explorer and the prover are spawned with `process.execPath --import tsx`,
no shell, `windowsHide`, `ZKTRIDENT_PARENT_PID`; the member, prescriber, pharmacy, insurer and prover
scripts watch their parent as the employer node has since A7. The harness drives the insurer with
its own token and probes the split: the operator token is refused by the insurer node and the
insurer token by the sequencer.

Verified. `tests/node-roles.test.ts` (12), `tests/rpc-role-auth.test.ts` (15, a real sequencer:
bearer with keys registered; insurer passes its methods and routes and is 403 on the operator's;
member passes `l2_registerEntity` only; unknown signer, tampered body, replay and both old formats
refused; a handler behind the gate receives the signed body; node keys never persisted),
`tests/nautilus-signed-admin.test.ts` (6, AUTH-14 forged hash refused, bearer and signature as
alternatives, replay, revocation, the outbound signer), `tests/launcher-credentials.test.ts` (10),
`tests/hr-tool-lockdown.test.ts` (15, now asserting the registration and the signed requests). The
thirteen suites this change touches pass, 211 tests. Typecheck src 20, scripts 2. Live, on a secured
clean boot with an explicit insurer token: the insurer credentialed the providers under its own role,
the member registered its encryption key under its own, the tenant was registered by the insurer's
signature; 104 of 121 checks across 24 steps (the two new credential probes pass; A7 100 of 117), the 17 failing checks identical by name to the B1 runs.

Still open under A-14's heading, deliberately: the operator's credential is a bearer, and unsecure
mode still defaults it to `admin123` (F1b removes that mode). The replicas' keys are A13, now one
`registerNodeKey` call each.

**Step 2 implementation spec: the one-shot identity change.** Written 2026-10-18 before the work.
Items A12b, C1, B2 (the half that can be done before the engine stops proving for members), C2 and
C4, in two commits, because the second depends on the protocol the first establishes and each has
to be verified live on its own. Production starts at genesis (owner), so C4 is a clean state and a
note, not a migration; wallet IDs change with this step and nothing enrolled before it survives it.

What is wrong, measured. The member's wallet ID is `Poseidon(0, hash(cardholderId), hash(dob),
hash(firstName), hash(lastName), hash(enrollmentKey), groupIdHash)` with every field hash unsalted
(`hash-utils.ts:31-34, 62-64`); A-1 inverted all four members' names and birth dates from the engine's
state file in 75 seconds. The app sends only the code at `/onboarding/accept-token`, so the device
derives the wallet with `groupIdHash = Field(0)` and the engine binds every member to `PLAN-GOLD-2026`
/ `ACME-CORP` (A-9), even though the insurer learns the real `groupIdHash` and `planIdHash` from the
employer when it redeems the code (`insurer-routes.ts` `redeemWithEmployers`) and the member's own
device never does. `register-member` provisions ELIGIBLE for any caller whose six fields hash to the
wallet ID they name (A-6). `exportRecoveryCard` has no caller, so no card is ever written (PRD-1).

Where the salt goes. Every circuit that re-derives a member wallet (ProofGate `verifyMember`,
StateTransition `proveRegistration` / `proveWalletUpdate`, WalletMigration) takes the six field
hashes as private inputs and recomputes the Poseidon over them; none hashes a name. So the salt is
mixed into each field hash **off-circuit** — `hashIdentityField(value, salt) = Poseidon(hash(salt),
...fields(value))`, `hashIdentityDate` likewise — and no program, verification key or proof format
changes. The salt is 32 random bytes generated on the device at `derive-wallet`, kept in the encrypted
device state and inside the recovery deposit, never in a request or a response. Provider wallets
are unchanged (an NPI is public; B4 replaces provider keys anyway). Fixture identities get a
deterministic salt per fixture so the console and the suites stay reproducible; they are fake people,
and F1 isolates them.

The enrollment order (C2). Redeem before derive, so the device knows the real group:
`accept-token` (code) → `generate-key` → **`/onboarding/redeem {tokenPIN}`**, which asks the insurer
`POST /enrollment/process {code, tokenPinHash}` with no wallet; the insurer redeems the code with the
employer exactly as A6 built it, records the redemption keyed by the code with no wallet yet, and
returns `{groupIdHash, planIdHash, employerId}` → `derive-wallet` with that `groupIdHash` → `enroll`,
which calls **`POST /enrollment/complete {code, walletId, recoveryDeposits}`**: the insurer binds the
wallet to the redemption (idempotent for the same wallet, 403 for another), records the enrollment,
stores the deposits, and from commit two on approves the wallet with the engine. A code consumed by a
device that dies before deriving is a new code from HR, the same window A6 already has.

The recovery cards (A12b). PRD-1's design, read exactly: the card must yield nothing to unlimited
offline compute, so nothing on it depends on the PIN. At `enroll` the device splits the enrollment
key twice with one-time pads: card A carries `{v:3, id: cardIdA, s: shareA1}` and card B likewise,
each about ninety bytes, each with its own random id and share, so one can be revoked without the
other. The other halves go to the insurer in the deposits, with the identity salt, the group and plan
hashes and the domain tag, and a **PIN verifier** `scrypt(recoveryPin, cardId)` computed on the device,
so the insurer never sees the PIN and a found card reveals nothing: no wallet ID, no hash, no
ciphertext to test a PIN against. Recovery on a new phone is `POST /onboarding/recover {card, pin,
identity fields}`: the device asks `POST /recovery/release {cardId, pinVerifier}`, which the insurer
answers only when the verifier matches, attempt-limited per card with `attempt-limiter.ts` (three
free, doubling to fifteen minutes) and locked after ten; the device combines the shares, re-derives
the wallet from the typed fields with the released salt and group, confirms it on the sequencer, and
is the same wallet again, no migration needed. `POST /recovery/revoke {cardId, pinVerifier}` closes a
card; `POST /recovery-card/issue {recoveryPin}` on the device issues a fresh pair later. The device
keeps the card ids and nothing else of the cards; the enroll response carries the two payloads once,
for the app to write to tags. Route names stay clear of the custody tests' rule (no backup, restore,
export-key or reveal).

Commit two: the engine's gate (B2 now) and the real plan. The insurer, at `complete`, posts
`POST /interactive/approve-member {walletId, groupIdHash, planIdHash, employerId}` signed with its
node key (role insurer, added to the route table). `register-member` then provisions ELIGIBLE only
when three things hold: the insurer approved this wallet, the sequencer's lifecycle tree shows it
REGISTERED (the member's own registration proof was accepted under A1), and the six fields hash to
it; and it binds the plan from the approval, never from the request: the member record carries the
real `planId`, `groupId`, `employerId`, the accumulator limits come from the sequencer's plan store
(`getPlan`), the network from the plan's overlay with an empty list meaning every credentialed
provider, and the `PLAN-GOLD-2026` / `ACME-CORP` defaults are deleted. The preimage still reaches the
engine, because the engine still proves wallet updates for members; that half of B2 is phase B's,
with the engine's move. C4: `clean:state`, and a note that device and engine state from before this
step is not readable.

Verified by. Commit one: `tests/identity-salt.test.ts` (domain separation, salt sensitivity and
reproducibility, preimage/transition/migration consistency, the wallet is the Poseidon of the
salted preimage), `tests/recovery-card.test.ts` (split/combine, payload size and opacity, release
refused with a wrong verifier and throttled, correct verifier releases once per card id, revoke, two
cards independent, the device stores no share, the custody route rule), `tests/enrollment-order.test.ts`
(redeem before derive against a stub insurer; the wallet carries the real group; complete binds one
wallet only); the harness enrolls with a recovery PIN, checks the two cards are opaque, exercises
release with a wrong PIN and then the right one, recombines, re-derives the enrolled wallet from the
fields it enrolled with, and checks no salt appears in `/health` or the state dump. Commit two:
`tests/register-member-gate.test.ts` (no approval → 403; approval without REGISTERED → 409; both →
ELIGIBLE with the real plan; the request's plan is ignored); the harness checks the enrolled member's
record carries `PLAN-E2E-…` and the employer's group, and that the deductible comes from that plan.
Both commits: the full secured pipeline, failures compared by name.

**Step 2, commit one implementation record: salted identities, redeem before derive, two recovery cards.**
Done 2026-10-18. Closes the inversion half of **A-1** (C1), the wallet-binding half of **A-9** (C2) and
**PRD-1** (A12b). The engine's gate and plan binding are commit two.

The salt (C1). `hash-utils.ts` gained `hashIdentityField(value, salt)` and `hashIdentityDate`, Poseidon
over the salt's hash and the value's fields, distinct from `hashString` of either. The member wallet's
five private inputs are now those salted hashes; the group hash is the sixth as before; the wallet is
still the Poseidon of the domain tag and the six, so ProofGate, StateTransition and WalletMigration
are untouched and no verification key changed. `deriveMemberWalletId`, `memberWalletPreimage`,
`memberTransitionPreimage`, `secureMemberDerivation`, `MemberNode.buildPreimage` and the migration
service's member branches take the salt; every caller passes one, fixture code through
`fixtureIdentitySalt(seed)`, a function of the fixture. The device generates its salt at
`derive-wallet` (`generateIdentitySalt`, 32 bytes), keeps it in `nautilus-state.enc`, and sends it
nowhere but inside a recovery deposit. The harness recomputes the six inputs with the salt from the
device state, and checks that the unsalted dictionary no longer matches the stored name hash.

The order (C2). `POST /onboarding/redeem {tokenPIN}` is the new step between `generate-key` and
`derive-wallet`: the device asks the insurer's `/enrollment/process` with the code and PIN hash and
**no wallet**, the insurer redeems with the issuing employer exactly as A6 built it, records the
redemption against the code with the PIN hash and no wallet, and answers `{groupIdHash, planIdHash,
employerId}`, which the device keeps as `enrollment` and bakes into the wallet at derivation. A
repeat with the same code and PIN hash is answered from the record; another PIN hash is refused, so
a code-only holder learns nothing after consumption. `/onboarding/enroll` then calls the new
`/enrollment/complete {code, walletId, recoveryDeposits}`, which binds the wallet (idempotent for the
same wallet, 403 for another) and records the enrollment with the real hashes. A device with no
insurer configured keeps the old derivation (the group named with the code, or none). The member
dashboard redeems before deriving, with the PIN it already collected.

The cards (A12b). `recovery-card.ts` v3: `splitEnrollmentKey` one-time-pads the key; a card is
`{v:3, id, s}`, about ninety bytes, and nothing on it depends on the PIN. `issueRecoveryCards` makes
two cards with independent shares and ids, and two deposits: the other share, the salt, the group
and plan hashes and `recoveryPinVerifier(pin, cardId)`, scrypt under the card id, computed on the
device. `enroll` requires a recovery PIN, issues both at the tap, files the deposits with
`/enrollment/complete`, keeps the card ids only, and returns the two payloads once. The insurer's
`/recovery/release {cardId, pinVerifier}` answers only against the stored verifier, attempt-limited
per card with `attempt-limiter.ts` (three free, doubling to fifteen minutes) and thirty a minute per
caller, and locks a card after ten failures; `/recovery/revoke` closes one; `/recovery/deposit` files
a fresh pair for an enrolled wallet, which `/recovery-card/issue` on the device uses. Recovery is
`POST /onboarding/recover {card, recoveryPin, identity fields}` on a new device: release, recombine,
re-derive with the released salt and group, confirm the wallet exists on the sequencer
(`l2_getEntity`), and it is the same wallet again; a wrong name derives a wallet nobody registered
and is a 404. The completion screen shows the two cards once and drops them on entering the app.
The v2 card format stays for the migration service until C3.

Verified. `tests/identity-salt.test.ts` (12), `tests/recovery-card.test.ts` (10, including a real
insurer: wrong verifier refused and throttled with Retry-After, right verifier releases once per
card, revocation, deposits for an unknown wallet refused), `tests/enrollment-order.test.ts` (5, a
real member node against stub insurer and sequencer: derive refused before redeem, redeem carries
no wallet, the wallet carries the real group and a salt that stays on the device, enroll needs the
PIN and issues two opaque cards whose deposits match and recombine, a second device recovers the
same wallet and a wrong PIN or a wrong name does not). `tests/enrollment-codes.test.ts` follows the
split; `tests/key-custody.test.ts` derives with the device's salt; `tests/entity-nodes.test.ts` and
`tests/wallet-migration.test.ts` pass the salt; onboarding + wallet-migration 17 failing, identical
by name. Typecheck src 20, scripts 2. Live: 120 of 134 checks across 25 steps on a clean secured boot (A9: 104 of 121; the harness gained the redeem, card, salt and recovery checks), 14 failing checks, all among the A9 run's 17, three of which now pass: the wallet is bound to the employer group, the sixth input recomputes from the raw value, and hash(enrollmentKey) no longer reaches the network.

Not here, by design: the preimage still reaches the engine and the engine still provisions ELIGIBLE
on it; the insurer's approval and the real plan in the engine are commit two. State from before this
commit is not readable by design (C4, genesis).

**A13 implementation record: the replicas have credentials, and someone is watching.** Done
2026-10-18. Closes **A-8** and the replication half of **C-3**; the last phase A item, so phase A
is closed.

*What was wrong, in two layers.* Gossip travels over `l2_gossipRelay`, an admin method. The replica
servers were built with no credential and the leader's peer clients carried the operator's token,
which a replica server could not check, so every relay died at the gate: 29 hours, 20 proofs, 19
batches, and both replicas at the genesis root. Under that, a second fault the gate had hidden: no
server in the launcher was ever given its node's peer network, so a relay that passed the gate
would have answered "Peer network not configured". Nothing watched either.

*Keys.* The leader and each replica get a node key at boot (`generateNodeKey`), like every node the
launcher issues. The leader's server registers the replicas under the `replica` role; each replica's
server registers the leader under a new `sequencer` role and its sibling replicas under `replica`. A
peer network now signs every call with its node's own key (`PeerNetworkConfig.nodeKey`,
`L2NodeOptions.nodeKey`), in the one wire format and with the operator's token only as the fallback
of a network started without keys. `replica` may call `l2_gossipRelay` and `l2_requestSnapshot` (it
pulls the leader's state when it connects); `sequencer` may call `l2_gossipRelay` and nothing else,
so the operator's token opens nothing on a replica and the leader's key opens no operator method
there. The gossip HMAC under `ZKTRIDENT_GOSSIP_SECRET` stays as the inner check; signatures over the
payload itself are phase E (E2).

*Wiring.* After the replicas start, each replica server is given its node's peer network, and the
leader's server its own, so `l2_gossipRelay` reaches `handleIncomingAndRelay` on both sides.

*The monitor.* `src/l2/invariant-monitor.ts` reads the leader and both replicas in-process every
five seconds. A replica is in step when both its roots equal the leader's; out of step for longer
than the grace period (30 s) is an alarm. Proofs pending with no batch built for longer than three
batch intervals (at least a minute) is an alarm; a batch built restarts that clock. Alarms are
logged once on raise and once on clear, and the last report rides on the leader's `l2_getStatus` as
`invariants`, where the harness reads it. The proof counters are reported as a hint, not as the
invariant, because a leader restored from a checkpoint keeps its lifetime count while an in-memory
replica starts from zero.

*What the first live run showed, and the second half.* With credentials in place the monitor fired
within 37 seconds of boot, and it was right. Four faults the gate had hidden, all in the peer
network rather than the keys: a replica answered a relay only after relaying onward, and that
relay waited on a leader whose event loop was busy proving in-process, so the leader's own relay
timed out; one timeout marked the replica disconnected, silently and for good; the leader's admin
mutations (seed providers at boot, ELIGIBLE after registration) never travelled, so a replica's
roots lagged until the next receipt overwrote them; and a replica never took the leader's state
when it connected, so it started at genesis although `syncOnConnect` said otherwise. Now a relay
is answered first and relayed onward in the background, with the sender named so nobody relays a
message back to where it came from; a peer stays connected until three relays in a row fail, is
then marked disconnected and said so once, and is tried again on every announce (and the url it was
reached at is kept for that); the sequencer tells its node about every `adminMutate` and the node
gossips the roots as `state:roots`, which replicas apply as they apply a receipt's; and a replica
takes the seed's snapshot when it connects. The launcher gives the leader its peer network through a
new public `L2Node.ensurePeerNetwork(seedPeers)` instead of reaching into private state. The monitor
stays as it was: the invariant is real now.

*Verified.* `tests/replica-credentials.test.ts` (5, a real leader and replica with servers and peer
networks: an unsigned relay, the operator's token and a stranger's key refused by the replica, the
leader's signature accepted and limited to gossip, the replica's gossip and snapshot request
accepted by the leader and its operator method refused, a broadcast crossing the peer network on
the leader's key and a keyless network unable to deliver, the report on `l2_getStatus`),
`tests/invariant-monitor.test.ts` (7, a fake clock through in step, out of step inside and beyond
the grace, recovery, stall, batch built, nothing pending, defaults), `tests/replication-liveness.test.ts`
(4: a replica with a slow peer answers the leader at once and relays in the background; a peer
survives two failed relays, is given up after the third with one warning, and comes back on
reconnection; a replica connecting after the leader has state takes that state and then follows
each admin mutation; a sequencer ignores roots gossip). `tests/node-roles.test.ts` now
states the two new facts (a replica may pull a snapshot; a sequencer relays gossip only). Widening
the regression set to the gossip and Leviathan suites turned up three stale expectations that fail
on the previous commit as well: the peer-network suite expected `l2_getPeerInfo` without a peer
network to answer `unknown` where the handler has long answered the node's own id, and two Leviathan
tests looked for promotion and demotion under `node:started` where the implementation emits
`leader:promoted` / `leader:demoted`. The tests were corrected; the implementation was right. All
191 tests across those three suites pass. Typecheck src 20, scripts 2. Live: 146 of 159 checks across 28 steps on a clean secured genesis boot; the ten A13 checks all pass (both replicas hold the leader's registry and lifecycle roots and every accepted proof, the monitor reports them in step with no stalled batch, a replica refuses an unsigned relay and the operator's token); the 13 failing checks identical by name to the A10b run; both replicas took the leader's snapshot at connect, no alarm during the run, and one transient relay failure per replica was tolerated and logged as recovered instead of dropping the peer.

**A10b implementation record: the wallet speaks for itself.** Done 2026-10-18. Closes **A-15**,
**A-16**, the open half of **A-12**, **A-30**, and **A-32** (new, found on the way). A-17 stays
mitigated, on purpose; see below.

*The key.* `src/security/wallet-key.ts`: `deriveWalletSigningKey(enrollmentKey)` is an Ed25519 key
whose seed is HKDF-SHA256 of the enrollment key under a fixed label, a sibling of the X25519
encryption key `messaging/encryption.ts` derives from the same root (a different derivation, so
neither key follows from the other's public half). Derived when needed and not kept: the enrollment
key stays the only secret (I3), and recovering it on a new device reproduces the same signing key,
so recovery needs no re-registration. The public half travels as `signingPublicKeyHex` on
`l2_registerEntity`, beside the encryption key.

*Ownership.* The key is set once. A later registration for the same wallet must present the same
key (a restarted provider node, a recovered device) or come from the operator; anything else is
refused with the reason, so nobody takes over an identity by re-registering it. The insurer's
`l2_credentialProvider` and a registration proof's display metadata no longer erase a wallet's keys
when they rewrite its entry. **A-32**, found here: `l2_registerEntity` credentialed any
`prescriber`/`pharmacy` entity ACTIVE in the provider registry as a side effect for whichever node
called it, so a member node's key could mint an active prescriber, and a node could register an
entity of any kind. Now a node registers only entities of its own role, and the side effect runs
only for the operator and the insurer, the principals that credential.

*The gate.* `L2RpcServer.WALLET_SIGNED_METHODS` names, per method, the parameter that is the wallet
spoken for: `l2_storeMessage` → `message.senderWalletId`, `l2_registerPcpAssignment` →
`memberWalletId`, `l2_requestAttestation` → `walletId`. Such a request carries a signature in the
one wire format (`signed-request.ts`) whose signer id is that wallet, verified against the wallet's
registered signing key over the exact bytes, inside the window and the replay cache. A bearer
token, a node key, another wallet's key or a wallet with no key registered are all
`RPC_UNAUTHORIZED` with the reason; the operator's token does not let anyone speak as a member.
Refusals a handler makes on a rule travel as `RequestRefused` (`src/l2/request-refused.ts`) and
reach the caller with their message instead of "Internal error".

*The attestation tells the truth.* `L2SequencerService.lifecycleStateOf(walletId)` decodes the
wallet's leaf in the lifecycle tree; `requestAttestation` states that value (REGISTERED 1, ELIGIBLE
2, ACTIVE 3), refuses a revoked wallet, and gives nothing to a wallet the ledger does not hold.
"Known to the entity registry" is no longer registration, and ACTIVE is no longer a constant.

*The callers.* `L2Client` takes a per-call signer; every node's `storeMessage` and
`requestAttestation` sign as the node's wallet automatically when the node holds its enrollment key
(`EntityNodeBase.walletSigner`, wired by `NautilusAppServer.setEntityNode`). The member node
registers its signing key at enrollment, signs its PCP registration after the PCP proof, and serves
`POST /attestation/request` (device session), which the member page now calls; the page's direct
`l2_storeMessage` and `l2_requestAttestation` calls are gone, and so are those two methods from
the member proxy's allowlist, where unsigned they could only fail. The employer node's
`/messaging/send` sent as a pseudo-wallet derived from the employer id, to a member wallet the
employer must not know (I6); it is now refused at the sequencer like any other unsigned sender and
is listed for removal in the naming and cleanup pass.

*A-30.* Both provider starters register their entity at boot with both public keys
(`src/nodes/provider-registration.ts`, node-signed, idempotent under the ownership rule), so an
encrypted eScript can reach a pharmacy; the prescriber's badge-tap registration uses the same
helper in place of a `require` inside an ES module that produced no key. Neither registration
credentials the provider; the badge reports PENDING until the insurer does.

*What stays open, stated.* A-17: the engine's `generate-credential` and `credential-status` are
called only by the operator's console and the harness, never by the member page; the right fix is
B1 step two, when the device proves its own credential, so the admin gate stays and the finding
carries the note. The engine's own write routes (`/interactive/prescribe`, `/fill`,
`/mark-filled`, `/assign-pcp`) are the console's orchestration surface and were never part of A10;
they leave with B1 step two, and D2 catches what remains.

*Verified.* `tests/wallet-key.test.ts` (4: deterministic, separate from the encryption key, round
trip and replay), `tests/wallet-signed-rpc.test.ts` (12, a real sequencer server: ownership, the
A-32 rules, each method refused unsigned / bearer / node key / other wallet / replay and accepted
with the wallet's own signature, the attestation's lifecycle from the ledger, a revoked and an
unregistered wallet refused), `tests/message-submission.test.ts` unchanged and green (the node's
own `storeMessage` is in-process and never passes the gate). Typecheck src 20, scripts 2. Live:
136 of 149 checks across 27 steps on a clean secured genesis boot; the nine A10b checks all pass (a forged message, a forged PCP link, and a bare and an operator-token attestation request are refused; the member's own node obtains an attestation that states the ledger's lifecycle and verifies against the pinned key, and sends a message the sequencer lists under it); 13 failing checks, the previous run's 14 minus the attestation probe that now passes, nothing new; both provider nodes registered their entity with both keys at boot.

**Step 2, commit two implementation record: the engine's door, and the real plan.** Done 2026-10-18.
Closes **A-6** (B2 as far as it can go before the engine stops proving for members) and **A-9**
(C2's engine half), and records **C4** as a note.

The approval. `/enrollment/complete` now does one more thing before it answers: it resolves the plan
the employer's code enrols into from its hash against the plans the insurer published
(`l2_getPlans`; a code whose plan is not on the sequencer is a 409 with the reason), and posts
`POST /interactive/approve-member {walletId, groupIdHash, planIdHash, planId, employerId}` to the
engine, signed with the insurer node's own key; the route is admin-gated and listed for the insurer
role (`node-roles.ts`), so the operator's bearer or the insurer's signature opens it and a member's
key is a 403. The engine keeps approvals in memory and in its checkpoint (`approvedMembers`, absent
in older checkpoints), idempotent for the same binding and 409 for a different one.

The door (B2 now, A-6). `register-member` provisions ELIGIBLE only when three things hold, in this
order: the insurer approved this wallet (otherwise 403, "no insurer approval"); the sequencer's
lifecycle tree shows the wallet REGISTERED, which only the member's own registration proof puts
there under A1 (otherwise 409, "not registered on the ledger yet"); and the six fields hash to the
wallet (as before). Refusals carry their status (`RegistrationRefused`) instead of a 500. Nothing in
the request body decides any of it: `groupId` and `planId` are gone from the request contract.

The plan (C2, A-9). The member record is bound from the approval, never from the request: `planId`
is the insurer's plan, `groupId` is the employer group hash (the plain group id stays with the
employer, I5), the accumulator limits come from that plan as stored on the sequencer
(`getPlan(planId)` → `bindPlan`: deductible, out-of-pocket maximum, annual benefit maximum), and
the provider network from the plan's overlay, where an empty list means every credentialed provider,
the overlay's own convention. The `PLAN-GOLD-2026` / `ACME-CORP` defaults are deleted from this
path; the console's fixture enrollment keeps its demo plan. The state dump's member entry now shows
`accumulator.limits`, and the pharmacy's fill result already carried them, so the harness's claim
expectations follow the real plan automatically.

Around it. The member node stops sending plan and group hints with `register-member`; the engine never
reads them now. The harness publishes its plan with a provider network named by wallet id (the seven
prescribers and five pharmacies the demo table had, plus the prescriber and pharmacy nodes), so the
out-of-network check exercises the plan-bound network, and a new check asserts the engine took the
network from the plan rather than from a table.

C4. Production starts at genesis (owner). Device state and engine checkpoints from before Step 2 are
not readable by design: the wallet formula changed with the salt and the group, and nothing enrolled
before it survives. `npm run clean:state` before the first boot on this commit.

Verified. `tests/register-member-gate.test.ts` (5, the engine's routes on a real sequencer server
with a stand-in service: approve-member 401 unsigned, 403 for a member key, 200 for the insurer key
and the operator; a conflicting re-approval 409; register-member 403 for an unapproved wallet, 409
before the ledger registration, 200 after, with the plan from the approval and the body's plan
ignored), `tests/engine-plan-binding.test.ts` (4, the pure binding), `tests/enrollment-codes.test.ts`
(completion resolves the plan and approves, asserted against the stub), `tests/node-roles.test.ts`
(the insurer may call approve-member). Typecheck src 20, scripts 2. Live: 127 of 141 checks across 26 steps on a clean secured genesis boot, every commit-two check passing (the member record carries the harness's plan, its group hash, its out-of-pocket maximum and its provider network; a fabricated identity is refused with 403 and told why; the out-of-network prescriber is refused against the plan-bound network), the 14 failing checks identical by name to the previous run.

Still inside the engine, by design: the preimage still arrives with `register-member`, because the
engine still proves wallet updates for members; that leaves with B1 step two. A-1 therefore stays
half open until then.

**B1 implementation record, first half.** Done 2026-10-17. Closes the residue of **A-13** and unblanks
the console without weakening any gate.

What moved. The fixture people the console displays (members, prescribers, pharmacies: names,
birth dates, addresses, NPIs) were embedded in `GET /interactive/state`, the sequencer's admin-gated
view of enrolled members, which had two bad effects: the privileged payload carried person records
that are not members, and the console, which sent no credential, went blank when A11 gated it. They
are a static import, so they are now a static file: `src/data/fixture-directory.ts` is the same
projection moved out of the engine unchanged, and the explorer serves it at `/fixtures.json` beside
the console's own pages, built on first request. The dump carries no person records other than
enrolled members; measured live it went from 137 KB to 62 KB. The medications and the plan block
stay in the dump because they carry the engine's live formulary state and no identity.

How the console reads it. `visualizer/src/js/interactive/state-client.js` is the one way to load
state: the gated dump plus `/fixtures.json`, merged into the `demoData` shape every screen already
reads, so no screen changed. `operator-auth.js` is a scoped wrapper around `fetch` that attaches
the network operator's token to every request to an `/interactive/` path, kept in this browser's
localStorage the way the employer dashboard keeps its own, prompted for once on a 401 and retried
once. An interceptor rather than sixty-six edited call sites, on purpose: one implementation to
review. The fourteen places that fetched the dump directly now go through the client.

Verified. `tests/fixture-directory.test.ts` (4): the directory's shape and absence of runtime
fields; the engine no longer maps the fixture people into the payload; the console loads through the
client and no screen fetches the dump directly; the explorer, started the way the boot starts it,
serves `/fixtures.json` as cacheable JSON. Live, on a secured boot: `/fixtures.json` 200 with the
directory; `/interactive/state` 401 bare and 200 with the operator token, no `members`, `prescribers`
or `pharmacies` under `demoData` and no fixture surname anywhere in it. The harness reads the
directory from the explorer and asserts both. Full pipeline: 102 of 119 checks across 24 steps (A7: 100 of 117), the 17 failures identical by name to A7's.

**B1 implementation spec, second half: carve the engine out of the visualizer.** The owner's
direction, 2026-10-17: the visualizer was built to see how everything worked; the adjudication
logic that grew inside it is the product, so it leaves. Measured before starting:

- The production set is three modules, 9,993 lines: `interactive-service.ts` (6,769,
  `AdjudicationService`), `interactive-routes.ts` (2,075, 49 routes) and the proof pool
  (`proof-pool.ts`, `proof-pool-worker.ts`, `proof-pool-types.ts`, 1,149). They import ~40 `src/`
  modules and nothing from the visualizer. `nfc-bridge.ts` (1,029) is the USB reader driver for the
  MIKROE-2540: the boot never constructs it, the routes only need its event types, and its native
  dependency (`node-hid`) is declared in the visualizer's own package, so it is tooling and stays.
  `auto-mode-controller`, `flowchart-orchestrator`, `scenario`, `start-interactive` and `nfc-test`
  import the service and stay behind as console drivers.
- Coupling to the sequencer process, which decides how far the engine can move: `l2Node.getSequencer()`
  ten times, including direct reads of the state trees (`getStateTrees().registry`, `.lifecycle`) and
  `adminMutate` to provision seed providers and to register members as ELIGIBLE; `submitProof` three
  times; `emitMessagingAuditEvent` three; `saveCheckpoint`, `getStatus`, `forceBatch`,
  `buildBatchDirect` once each. The first group has no RPC equivalent and must not get one as-is:
  it is the engine reaching into the ledger.
- Identity: 57 references to preimages and enrollment keys. The engine derives provider wallets
  from fixture enrollment keys, keeps member `preimageFields`, and registers members by
  administrative mutation. That is phase B's problem (B2, B3, C1), not a relocation's.
- Ten of the 49 routes are called by production node servers (`fill` ×4, `resolve-indices`,
  `register-member`, `prescribe`, `fill-status`, `badge`, `reverse`, `prescriptions-by-pharmacy`,
  `prescribe-and-fill`, `mark-filled`); the console calls 66 sites; the harness drives the rest.
- Typecheck debt the move will expose: 28 errors in the four files (16 in `proof-pool-worker.ts`,
  all TS2556 spread-argument calls; 8 in the service, one of them a real bug, see the record; 2 each
  in the routes and the NFC bridge), plus 10 that are already in the src baseline.
- State: the boot persists `exportState()` to `l2-data/adjudication-state.json` every 60 s and on
  shutdown, and restores it at start.

Two steps, in order. **Step one, relocation, mechanical:** move the three modules to a new
`src/adjudication/` with their file names unchanged (the names, the `/interactive/*` paths and
`registerInteractiveRoutes` are renamed together in the naming pass after the program, not one at a
time), rewrite their `../../src/` imports to `../`, give the routes an interface of their own for the
NFC reader (`nfc-port.ts`) that the visualizer's bridge implements, import the engine statically in
`start-leviathan.ts` instead of by a path string inside a try/catch marked optional (an engine that
fails to load is a boot failure, not a warning), fix the 28 errors so the engine is under `tsc` like
everything else in `src/`, re-point the console drivers and the structural tests, add a structural
test that nothing under `src/` imports from `visualizer/` again, and verify with the suites and a
full secured run. **Step two, its own process:** replace the tree reads and `adminMutate` with
sequencer methods that carry authorisation, move the viz events and the checkpoint with the engine,
give it its own listener and operator credential, and point the node servers at it; this is
scheduled with phase B because the identity it holds has to leave at the same time.

**B1 step one implementation record.** Done 2026-10-17. The engine is out of the visualizer.

What moved. `interactive-service.ts`, `interactive-routes.ts`, `proof-pool.ts`, `proof-pool-worker.ts`
and `proof-pool-types.ts` went with `git mv` to a new `src/adjudication/`, history preserved as
renames and names unchanged on purpose (see the spec above). Their 89 `../../src/` imports became
`../`. `src/nodes/start-leviathan.ts` imports `AdjudicationService`, `registerInteractiveRoutes` and
`ProofPool` statically; the path-string imports and the try/catch that logged "AdjudicationService
not available (optional)" and carried on are gone, so an engine that cannot load is a boot failure.
The pool's worker is `src/adjudication/proof-pool-worker.ts`, named by the boot and also the pool's
own default, which now resolves with `fileURLToPath` instead of a hand-edited URL pathname.

The NFC reader. The routes needed only the reader's event and payload types, and the USB bridge's
native dependency (`node-hid`) is declared in the visualizer's own package, so the bridge stayed
where it was. `src/adjudication/nfc-port.ts` owns `NfcTagEvent`, `NdefPayload`, `NfcBridgeStatus` and
the `NfcReader` interface the routes take; `visualizer/engine/nfc-bridge.ts` imports them and
implements the interface. Nothing under `src/` imports from `visualizer/` any more, and a sequencer
carries no USB code.

Typecheck. The engine sat outside `tsc` (rootDir `src/`) with 28 errors; all are fixed, so src stays
at its 20-error baseline with about 10,000 more lines under the checker. The 16 TS2556 spread calls
in the worker go through one declared `ProveFn` rest signature; four `member.memberIndex` reads in
`enrollMember` use the parameter (the fixture type never had the field); `updateFormularyEntry` and
`planYearRollover` declare the `Promise` they return, which also cleared the two `withProvingLock`
errors in the routes; `'warn'` joined `ConsoleEventType`; the bridge no longer emits `walletId: null`.
One of the 28 was a real bug: the engine computed `hashString(tokenData.groupId!)`, but the validation
result never carried a plain group ID (the token holds hashes, by design), so the call threw on
`undefined` inside a bare catch and the group's `enrolledCount` never incremented for engine
enrollments. It now uses the hash the result carries. `enrollment-service.ts:232-234` has the same
shape of error and is still in the src baseline; it is reached only by seed runners and tests, and
goes with the typecheck-to-zero work. Scripts typecheck unchanged at 2.

Verified. `tests/engine-location.test.ts` (6): the modules are where this record says; nothing under
`src/` imports from the visualizer; the boot imports the engine statically and by no computed path;
the worker file the boot names exists; the routes depend on the port and the bridge implements it;
nothing under `src/adjudication/` imports `node-hid`. The three structural suites that read the
engine's source were re-pointed and pass (`interactive-admin-gates`, `attestation-trust`,
`fixture-directory`). Live, on a secured clean boot: routes registered, four workers started, ten
programs compiled, 102 of 119 checks across 24 steps, the 17 failing checks identical by name to the B1 first-half run and to A7's.

Not done here, by design: the engine still reads the sequencer's trees and calls `adminMutate`,
still holds member preimages, and still answers on the sequencer's listener. That is step two,
scheduled with phase B.

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

**Sequencing resolved 2026-10-16: production starts from genesis.** There is no live member data to preserve, so B2's purge and C1's new derivation collapse into a single change. Land the salt and the group binding together, on the final formula, then wipe state and launch. No one-time migration run is needed. C4 drops to nothing. This does **not** remove wallet migration as a recovery feature: a member who loses their phone still needs continuity for their claims history and year-to-date accumulator, which is risk-log PRD-1 and has to work before launch.

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

## 7b. Release one: recommendation, 2026-10-16

**Shape.** The adjudication layer, operated by the sister company, for **non-controlled outpatient pharmacy benefit**, starting from genesis.

**In scope:** verified proofs at submission; identity that never leaves the device, salted; the adjudication engine out of the sequencer process; access control on member data; the trust layer switched on and treated as disaster recovery; the money-correctness defects fixed; fixtures isolated and removed at tag.

**Explicitly out, and the architecture leaves room for each:** controlled substances and EPCS certification; the counter QR disclosure; emergency-department or medication-history access; external quorum operators; and being the prescriber's system of record for e-prescribing.

**Ordered recommendations, with the cost of skipping each.**

| # | Recommendation | If skipped |
|---|---|---|
| R1 | **A1 next, alone.** Verify submitted proofs before any mutation. Twenty lines plus the check script | Every later phase builds on state any reachable caller can write. Replication and quorum would propagate it across ten nodes and sign certificates over it |
| R2 | **Collapse B and C into one derivation change.** Genesis makes this free: salt, group binding and stopping the preimage send all land together on the final formula, then wipe | Two migrations instead of none, and a window where two derivations coexist |
| R3 | **Move the engine out of the sequencer. Keep it in phase B** | The operator can impersonate any member, so I2 is false in substance whatever else lands. With a single named operator that is the central trust question, not a theoretical one |
| R4 | **Phase E as disaster recovery, not decentralisation.** Replication, write-ahead log, failover, standby nodes joining by snapshot | A single machine loss loses live proof state. The ten-per-million plan is not executable, because nothing replicates today |
| R5 | **Fix the money before scaling:** the duplicate-fill drop, the accumulator divergence, and binding amounts into the audit chain | Scaling a system that charges members for claims it has no record of, with no check able to detect it, because the balance check reports over zero claims |
| R6 | **Measure transitions per batch before buying hardware.** The cap of two at 28.6 seconds is the throughput ceiling | Buying ten times the hardware needed, or discovering mid-launch that ten times more is needed |
| R7 | **Write the two missing acceptance checks first:** the hash-reversal attack and the tampered-proof submission | Re-introducing the exact class of defect that this audit found, without noticing |
| R8 | **Hold the non-goals.** No EPCS, no controlled substances, no QR, no medication-history service in release one | Scope creep into three separate regulatory surfaces, each with its own certification or consent model |

**The one real fork.** R3 is the long pole: roughly 6,800 lines, the route mounting, the state file, the key holdings, and who proves what in three flows. The only genuine lever for a faster release is to ship without it and accept that the operator can write any member's state. My recommendation is to do it, because the product's claim is privacy from everyone including the operator, and the sister company is now a named party rather than an abstraction.

**Honest cost.** Roughly sixteen to twenty-two sessions at one phase-slice per session: A1 alone, three or four for the rest of A, four to six for B including the engine move, one or two for C, three for D, two or three for E, one or two for F.

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

## State of work (2026-10-17, Session 5: phase A items A1 and A2)

**A1 — proofs are verified before any state is written. Done and proven on a live network.**

```
TAMPERED (public output altered, roots left matching current state)
  -> refused: "not valid against this deployment's verification key [reason: invalid]"   5.7 s
     ledger: wallets=31  accepted=0   UNCHANGED
HONEST
  -> ACCEPTED  receipt=l2-00000000  isReg=True                                            4.9 s
     ledger: wallets=32  accepted=1   ADVANCED
```

The implementation is a child-process verifier (`l2-verify-worker.ts`, `l2-verify-pool.ts`) and a
refusal that fails closed when no verifier is configured. The reason it is a process and not a
function call is the finding worth carrying forward: **after the adjudication engine compiles its
ten ZkPrograms into the sequencer's single global o1js context, no further o1js work completes in
that process.** Measured both directions — verifier set up before the engine, the compile succeeds
and the first verification never returns; set up after, the compile itself never returns. The same
wall put batch proving in a worker. Treat it as a standing constraint.

**A2 — the remote surface is closed. Done.** Fourteen listeners, one policy module
(`src/security/network-policy.ts`): loopback binds, a port-aware CORS allowlist, no
`Access-Control-Allow-Origin` at all for an off-list origin or a request with no `Origin`, 81
wildcard overrides removed from live route handlers, both `/rpc` proxies narrowed to a per-role
method allowlist, and TLS wired through the two sequencer starters so HTTPS is configuration
rather than a code change. Full record above, including the two places the audit was wrong and the
one place I was.

**The mistake to carry forward.** I concluded the `/rpc` proxies had no client, from a `grep` for
`rpc\.` and `l2_` in each dashboard's `app.js`. The pages call a global `RPC` object that `rpc.js`
defines, so the pattern could not see the calls, and acting on that would have shipped a broken
member dashboard and a broken explorer. Checking what a client *is* has to mean reading the
client, not pattern-matching one spelling of its call site.

**Test and typecheck baseline, unchanged by either item.** The suite is not green and was not green
before: 5 failures reproduced on a stashed HEAD (3 in `formulary-update.test.ts`, 1 in
`claim-accumulator-integration.test.ts`, 1 in `l2.test.ts` asserting `MAX_TRANSITIONS_PER_BATCH`
is 4 where the source says 2). Typecheck: 21 pre-existing errors, same count after both items.

**Acceptance tests added this session.** `scripts/e2e-verify/check-proof-gate.ts` (A1) and
`scripts/e2e-verify/check-network-surface.ts` (A2). Both treat an inconclusive result as a failure
rather than a pass, which is what the first version of the proof-gate check got wrong — a client
timeout was being counted as a refusal.

**Next: A3.** Remove `/onboarding/backup-key`, the caller-supplied key path in `generate-key`, and
`restore-key` from the network surface. A2 narrowed who can reach those routes; it did not change
what they do, and they are the remaining I3 break.

## State of work (2026-10-17, Session 5: phase A, items A1-A5, A8, A10a, A11, A12)

**Nine items done, all verified against a running network rather than only against tests.**

| Item | What it closed | Finding |
|---|---|---|
| A1 | Submitted proofs are cryptographically verified before any state is written | **A-3** (critical) |
| A2 | Loopback binds, a port-aware CORS allowlist, proxies narrowed per role | **A-7** (critical) |
| A3 | The enrollment key cannot be exported, injected or replaced | **A-5** (critical) |
| A4 | A wrong PIN no longer unlocks; eject demands a fresh PIN; attempt backoff | A-20, MEM-M2 |
| A5 | The member node authenticates; the open endpoints stop leaking the wallet ID | MEM-H1 |
| A8 | The employer admin token is no longer handed out on an open route | **A-4** (critical) |
| A10a | Attestations verify against a trusted key, not the tag's own | A-12 (forgery half) |
| A11 | The identity dump, the eligibility cascade and the ledger controls are gated | A-13, A-19 |
| A12 | Three broken features, plus the gate that had to ship with the fix | A-24, A-28, A-17 |

**Criticals: four of seven closed** (A-3, A-4, A-5, A-7). Three remain and they are the ones that
need design rather than gates: **A-1** the reversible identity hashes, **A-2** credential-free
member reads, **A-6** proofless member creation.

**Four new findings this session**, all recorded in `docs/AUDIT.md`: **A-28** a seeded provider
cannot send an eScript (fixed in A12), **A-29** the employer attestation path has the same
embedded-key flaw A10a fixed for NFC, plus two corrections to existing findings — the `/rpc`
proxies attach no `Authorization` at all, and A-5's scope covered all three node types rather than
the member node alone.

**Three lessons that cost real time and should outlive this session.**

1. **A grep is not a client inventory.** A2 nearly switched off two dashboards because I searched
   for `rpc.` and `l2_` while the pages call a global `RPC` object. The answer was in a comment at
   the dispatch site. *Read the client.*
2. **A shared handler changes every role.** A5 silenced the provider nodes' health endpoint
   because `handleHealth` is common to all node types, and provider nodes can never authenticate.
   Only running the whole pipeline caught it. *Reading the client is not enough when the code is
   shared.*
3. **Check what a functional fix unblocks.** Fixing A-24 removed the bug that was the only thing
   stopping the A-17 impersonation path, which the audit had already written down. The gate had to
   ship in the same commit.

**A process gap closed, and two still open.** `npx tsc --noEmit` covers **only `src/**/*`**, and
both `tsx` and `ts-jest` transpile without checking, so `scripts/`, `tests/` and `visualizer/`
have never been typechecked. Two of my own bugs had already shipped through that gap. Added
`tsconfig.scripts.json` and `npm run typecheck:scripts`. Current counts, for tracking rather than
as a gate: **src 21, scripts 2, tests 39, visualizer/engine 44.**

**Performance, outside the security scope but requested by the owner.** The formulary Merkle tree
build was the sequencer's whole boot delay: ~700 s, not the 0.4 s JSON parse. Now ~12x faster — a
bottom-up builder plus a disk cache keyed on a digest of the records — and `ZKTRIDENT_FORMULARY_LIMIT`
is honoured, which it never was. A dev boot now reaches ready in about a minute. Also fixed a
formulary root check that had been comparing against an **empty tree** on every boot since it was
written, so it could never pass and its warning was noise.

**Regression baselines, all re-matched exactly. Do not re-derive these.** `smoke-leviathan` 14 of
46, `smoke-e2e` 32 of 65, `onboarding` + `wallet-migration` 17, `formulary-update` 3,
`production-showcase` 26 of 35 (one better than its 27 baseline). Every acceptance suite added this
session passes in full: proof gate, network surface, key custody, PIN custody, marketplace
credentials, admin gates, device session, attestation trust.

**Git: 27 commits on local `dev`, nothing pushed, `origin/main` untouched.**

**Next, per the owner's agreed order.** Finish Step 1: **A9** split the shared admin token (A-14),
**A10b** authenticate `storeMessage` and require proofs for PCP assignment and attestation
requests (A-15, A-16, and the open half of A-12 and A-17), **A13** give the replicas credentials
(A-8). Then **Step 2, the one-shot identity change**, which is the item with a deadline: write the
recovery card first (**A12b**), then salt the identity fields (**C1**, closing A-1), then require a
real registration proof (**B2**, closing A-6), then bind the real group and plan (**C2**, closing
A-9), then re-enroll. One migration, three criticals, and it only stays cheap while there are no
real members.

## State of work (2026-10-17, Session 5: phase A items A9 third clause and A6; B1 re-prioritised)

Since the previous entry: **A9's third clause** (the insurer signs with a key of its own, pinned on
the sequencer; A-29 closed, A-14 narrowed) and **A6** (enrollment codes random, single-use and
redeemed through one insurer-signed question; AUTH-13's validate half and the new **A-31** closed) are
done, both verified on a secured live network. Two audit corrections: A-13 and A-17 claimed the
production launcher does not serve the engine's routes. It does (`start-leviathan.ts:452`), so those
gates are load-bearing in production. Measured the same day: 668 of 716 requests in a live pipeline
run go to `/interactive/*`, so the pipeline measures the engine's orchestration far more than the
node servers' own. **B1 therefore moves from "later" to before phase D**, with a cheap first half
slotted right after A7: stop couriering static fixture data through the gated identity dump, and
split the real identity fields onto their own gated path, which unblanks the visualizer and shrinks
the privileged surface instead of merely locking it.

**Scoreboard:** 31 findings; 13 fixed (A-3, A-4, A-5, A-7, A-12, A-13, A-14, A-19, A-20, A-24, A-28,
A-29, A-31); 1 mitigated (A-17); 17 open, three of them critical (A-1, A-2, A-6). Phase A items
still open: A7, A9 remainder, A10b, A12b, A13.

**Baselines, re-matched by failing-test name rather than by count:** `onboarding` + `wallet-migration`
17; `smoke-leviathan` 14 of 46; `smoke-e2e` 30 of 65 failing, down from 32 (P2d and P2e pass under the
new contract); `production-showcase` see the A6 record; full pipeline 94 of 111 checks across 24
steps, to the end. Typecheck src 21, scripts 2. Acceptance suites added this session: 10, 226 tests,
all passing.

**Operational lessons, recorded because they cost an hour each.** (1) The smoke and showcase suites
finish and then Jest does not exit; run them with `--forceExit`, read a "wedged" run as finished
until proven otherwise, and give `production-showcase` more than ten minutes. (2) The orchestrator
never reaps the employer nodes and HR Tools it spawns, and stopping a shell does not stop its node
child: list node processes by command line before blaming the code for a stall. Eight such orphans,
one from 10:09, were starving the box. (3) `git stash` under `core.autocrlf=true` re-checks every
file out as CRLF; a script that edits files must match in LF and write back in each file's own
endings, and refuse to write anything when an anchor is not found exactly once.

**Git:** with this commit, 31 commits on local `dev`, nothing pushed, `origin/main` untouched.

**Next, in the agreed upstream-to-downstream order:** **A7** (HR Tool off the insurer host, plaintext
PINs out of exports and `/api/employees`, passphrase policy with attempt limits, `GET /groups` gated,
the spawned-tenant lifecycle and the bearer-mode admin auth the orchestrator gives spawned nodes),
then the cheap half of **B1**, then **A9's remainder** (per-node credentials, moving admin auth onto
`signed-request.ts`), then **Step 2** (A12b → C1 → B2 → C2 → C4, the one-shot identity change), then
A10b, A13, full B1, phase D.

**Addendum, later the same session: A7 done.** Scoreboard: 31 findings; 14 fixed (A-21 joins the list); 1
mitigated; 16 open, three of them critical (A-1, A-2, A-6). AUTH-13 is closed. Phase A items still open:
A9 remainder, A10b, A12b, A13. Acceptance suites added this session: 13, 251 tests, all passing. Typecheck
src 20 (a baseline error sat in code A7 replaced), scripts 2. Git: with this commit, 32 commits on local
`dev`, nothing pushed, `origin/main` untouched. One lesson added to the list above, because it invalidated a
live run: (4) a process count that says zero while the port count says nine is a broken check, not a clean
box; trust the ports, and keep any PowerShell filter in a `.ps1` file run with `-File`, never inline through
bash. **Next:** the cheap half of B1 (stop couriering fixture data through the gated identity dump), then
A9's remainder (per-node credentials; the HR Tool onto its Ed25519 key with the employer node registering
it; admin auth onto `signed-request.ts`), then Step 2 (A12b → C1 → B2 → C2 → C4), then A10b, A13, full B1,
phase D.

**Addendum, later the same session: B1 first half and B1 step one done.** The console reads the fixture
people from `/fixtures.json` and authenticates as the operator; the engine lives in `src/adjudication/`,
imported statically by the boot and typechecked with the rest of `src/`. Scoreboard, counted from the
audit's own status column (the two addenda above counted A-12 and A-14 as fixed; the audit marks them
partly fixed): 31 findings; 12 fixed; 2 partly fixed (A-12, A-14); 1 mitigated (A-17); 16 open, three of
them critical (A-1, A-2, A-6). Phase A items still open: A9 remainder, A10b, A12b, A13. Acceptance suites
added this session: 15, 261 tests, all passing. Typecheck src 20 with the engine's ~10,000 lines now inside
the count (its 28 errors fixed), scripts 2. Pipeline 102 of 119 checks across 24 steps, the 17 failing checks identical by name to the B1 first-half run and to A7's. Git: with this commit, 34 commits on local
`dev`, nothing pushed, `origin/main` untouched. **Next:** A9's remainder (per-node credentials; the HR
Tool onto its Ed25519 key with the employer node registering it; admin auth onto `signed-request.ts`), then
Step 2 (A12b → C1 → B2 → C2 → C4), then A10b (with A-30's pharmacy key registration), A13, B1 step two with
phase B, phase D.

**Addendum, later the same session: A9 remainder done.** One credential per principal: the operator's
bearer is accepted by the sequencer only; every node the launcher spawns signs with a key of its own
and is authorised by role; the insurer node has its own admin token; no child inherits a secret; the
node servers verify with the shared verifier (AUTH-14 closed); the HR Tool signs with a key the
employer node registered. Scoreboard: 31 findings; 13 fixed; 1 partly fixed (A-12); 1 mitigated
(A-17); 16 open, three of them critical (A-1, A-2, A-6). Phase A items still open: A10b, A12b, A13.
Acceptance suites added this session: 19, 304 tests, all passing. Typecheck src 20, scripts 2.
Onboarding + wallet-migration 17 (count-matched). Pipeline 104 of 121 checks across 24 steps (the two new credential probes pass; A7 100 of 117), the 17 failing checks identical by name to the B1 runs. Git: with this commit, 35
commits on local `dev`, nothing pushed, `origin/main` untouched. **Next:** Step 2 (A12b → C1 → B2 →
C2 → C4), then A10b (with A-30's pharmacy key registration), A13 (one `registerNodeKey` per replica
and the invariant monitor), B1 step two with phase B, phase D.

**Addendum, 2026-10-18: Step 2, commit one done.** The member's identity fields are salted on the
device (C1), the code is redeemed before the wallet is derived so the wallet carries the employer's
real group (C2), and two recovery cards are issued at the enrollment tap with the other share held by
the insurer behind an attempt-limited PIN verifier (A12b, PRD-1 closed). Scoreboard: 31 findings; 13
fixed; 3 partly fixed (A-12, A-1, A-9); 1 mitigated (A-17); 14 open, three of them critical (A-1 and
A-6 until commit two, A-2). Acceptance suites added this session: 22, 331 tests, all passing.
Typecheck src 20, scripts 2. Onboarding + wallet-migration 17 by name. Pipeline 120 of 134 checks across 25 steps on a clean secured boot (A9: 104 of 121; the harness gained the redeem, card, salt and recovery checks), 14 failing checks, all among the A9 run's 17, three of which now pass: the wallet is bound to the employer group, the sixth input recomputes from the raw value, and hash(enrollmentKey) no longer reaches the network. Git: with
this commit, 36 commits on local `dev`, nothing pushed, `origin/main` untouched. **Next:** Step 2,
commit two (the insurer approves the wallet with the engine; `register-member` requires the approval
and the member's accepted registration proof; the real plan in the engine; the defaults deleted), then
A10b (with A-30), A13, B1 step two with phase B, phase D.

**Addendum, 2026-10-18: Step 2, commit two done.** The insurer approves each wallet with the engine
at enrollment completion, naming the plan it resolved from the employer's code; `register-member`
provisions ELIGIBLE only for an approved wallet whose own registration proof the sequencer accepted,
and binds the plan, the group and the accumulator limits from the approval. Scoreboard: 31 findings;
15 fixed; 2 partly fixed (A-12, A-1); 1 mitigated (A-17); 12 open, two of them critical (A-1 until
B1 step two, A-2). Phase A items still open: A10b, A13. Acceptance suites added this session: 24,
340 tests, all passing. Typecheck src 20, scripts 2. Pipeline 127 of 141 checks across 26 steps on a clean secured genesis boot, every commit-two check passing (the member record carries the harness's plan, its group hash, its out-of-pocket maximum and its provider network; a fabricated identity is refused with 403 and told why; the out-of-network prescriber is refused against the plan-bound network), the 14 failing checks identical by name to the previous run. Git: with this commit, 37
commits on local `dev`, nothing pushed, `origin/main` untouched. **Next:** A10b (authenticate
`l2_storeMessage`, proofs for `l2_registerPcpAssignment` and `l2_requestAttestation`, the pharmacy's
encryption key for A-30), then A13 (replica keys under the `replica` role and the invariant monitor),
then B1 step two with phase B, then phase D.

**Addendum, 2026-10-18: A10b done.** Each wallet signs for itself: an Ed25519 key derived on the
device from the enrollment key, registered beside the encryption key and owned by it; `l2_storeMessage`,
`l2_registerPcpAssignment` and `l2_requestAttestation` accept only the wallet's own signature; the
attestation states the ledger's lifecycle; both provider nodes register their keys at boot; a node
registers only entities of its own kind and never credentials one (A-32). Scoreboard, recounted from
the rows (the previous addendum said 12 open; it was 13): 32 findings; 20 fixed (A-3, A-4, A-5, A-6,
A-7, A-9, A-12, A-13, A-14, A-15, A-16, A-19, A-20, A-21, A-24, A-28, A-29, A-30, A-31, A-32); 1 partly
fixed (A-1, until B1 step two); 1 mitigated (A-17, until B1 step two); 10 open (A-2, A-8, A-10, A-11,
A-18, A-22, A-23, A-25, A-26, A-27), one of them critical (A-2). Phase A item still open: A13.
Acceptance suites added this session: 26, 356 tests, all passing. Typecheck src 20, scripts 2.
Pipeline 136 of 149 checks across 27 steps on a clean secured genesis boot; the nine A10b checks all pass (a forged message, a forged PCP link, and a bare and an operator-token attestation request are refused; the member's own node obtains an attestation that states the ledger's lifecycle and verifies against the pinned key, and sends a message the sequencer lists under it); 13 failing checks, the previous run's 14 minus the attestation probe that now passes, nothing new; both provider nodes registered their entity with both keys at boot. Git: with this commit, 38 commits on local `dev`, nothing pushed,
`origin/main` untouched. **Next:** A13 (one `registerNodeKey` per replica under the `replica` role,
and the invariant monitor), then B1 step two with phase B, then phase D.

**Addendum, 2026-10-18: A13 done; phase A closed.** The leader and both replicas sign peer calls with
their own node keys (roles `sequencer` and `replica`), every server is wired to its peer network, so
gossip lands for the first time, and the invariant monitor on the leader alarms when a replica is
out of step for 30 s or a batch is overdue, reporting on `l2_getStatus`. Scoreboard: 32 findings;
21 fixed (the A10b list plus A-8); 1 partly fixed (A-1, until B1 step two); 1 mitigated (A-17, until
B1 step two); 9 open (A-2, A-10, A-11, A-18, A-22, A-23, A-25, A-26, A-27), one of them critical
(A-2). Phase A: closed. Acceptance suites added this session: 29, 372 tests, all passing. Typecheck
src 20, scripts 2. Pipeline 146 of 159 checks across 28 steps on a clean secured genesis boot; the ten A13 checks all pass (both replicas hold the leader's registry and lifecycle roots and every accepted proof, the monitor reports them in step with no stalled batch, a replica refuses an unsigned relay and the operator's token); the 13 failing checks identical by name to the A10b run; both replicas took the leader's snapshot at connect, no alarm during the run, and one transient relay failure per replica was tolerated and logged as recovered instead of dropping the peer. Git: with this commit, 39 commits on local `dev`, nothing
pushed, `origin/main` untouched. **Next:** B1 step two with phase B (the engine stops proving for
members and providers; the preimage leaves the engine, closing A-1), then phase D.

## State of work (2026-10-18, Session 5 closed: phase A complete, Step 2 done, B1 first half and step one)

Since the previous entry, over three stretches from 2026-10-17 to 2026-10-18: **A7** (the HR Tool runs
on the employer's machine; tenants die with their parent), **A9 remainder** (one credential per
principal: node keys with roles, one signed-request format, the operator token leaves no process),
**B1 first half and step one** (fixture people off the privileged route; the engine moved to
`src/adjudication/` under `tsc`), **Step 2** in two commits (salted identity fields, the code
redeemed before the wallet exists, two recovery cards with the insurer-held share; then the engine's
door and the real plan), **A10b** (the wallet speaks for itself: an Ed25519 key derived on the device
signs messages, PCP links and attestation requests; provider keys registered at boot; a node
registers only its own kind), and **A13** (replicas with credentials, gossip delivered and kept
alive, the invariant monitor on `l2_getStatus`). **Phase A is complete.** Each item has its
implementation record above and a dated note on its finding in `docs/AUDIT.md`.

**Scoreboard:** 32 findings; 21 fixed (A-3, A-4, A-5, A-6, A-7, A-8, A-9, A-12, A-13, A-14, A-15,
A-16, A-19, A-20, A-21, A-24, A-28, A-29, A-30, A-31, A-32); 1 partly fixed (A-1: salted, but the six
hashes still reach the engine, which still proves for members — B1 step two); 1 mitigated (A-17: the
admin gate stays until the device proves its own credential, also B1 step two); 9 open (A-2, A-10,
A-11, A-18, A-22, A-23, A-25, A-26, A-27), one of them critical (A-2, item D1). Criticals closed: five
of seven.

**Baselines, re-matched by failing-test name:** `onboarding` + `wallet-migration` 17, the same names
all session. Acceptance suites added this session: 29, 372 tests, all passing. The wider regression
batch (36 suites, the gossip, Leviathan, message-submission and multi-node suites included) 633
passing, after three expectations that had been stale on every earlier commit were corrected.
Typecheck src 20, scripts 2. Full pipeline 146 of 159 checks across 28 steps on a secured genesis
boot; the 13 failing checks the same by name since the A10b run: the provider-node paths (the
prescriber dashboard path, the fill through the pharmacy node, the portable credential, the three
rebuilt accumulator totals, the sequencer's claim list for the member), the drug-history consent
probe (D1), and the five identity hashes still reaching the engine (A-1, B1 step two).

**Git:** 39 commits on local `dev` plus this entry, nothing pushed, `origin/main` untouched.
`_dashfix.mjs` in the repository root is untracked and not part of this program (an em-dash
normaliser for the top-level documents); left for the owner.

**Next: Session 6, phase B**, in the plan's order. B1 step two with B2 first: the device proves its
own wallet updates, the preimage leaves the engine, `register-member` takes a receipt and a wallet
ID and nothing else; that closes A-1 and takes away A-17's reason to stay gated. Then B3, adjudicate
then finalize, with the open questions of §7 settled before it ships rather than discovered: the
read-then-write window (a pending delta visible to the next adjudication), stale quotes as a
ceiling, the benefit-exhaustion escape hatch, what a card-only tap proves (the representative
pickup), and mail order's finalize. Then B5 (PCP consent at prescribing, lifecycle check), B7
(ELIGIBLE to ACTIVE on first claim), B8 (no settlement rewrite after the proof), B6 (no wallet ID to
the employer), and B4 (FIDO2 provider keys) last, since it needs hardware on the desk. Decisions to
take at the kickoff: the pending-delta rule, the representative-pickup rule, the mail-order finalize.

**Operational lessons this stretch.** (1) A monitor that fires on its first run is doing its job: the
A13 alarm led, within the hour, to four real faults in the peer network that the admin gate had
hidden for 29 hours; read the alarm before touching the check. (2) Run the live harness only after
Jest has finished: CPU contention stretched a 25-second registration proof past the 30-second HTTP
timeout and exposed a race in the harness, which now waits for the engine record instead of
reading it once. (3) Widening the regression set to suites nobody had run this program turned up
three stale expectations; each time the implementation was right and the test was corrected.
(4) A script that writes JavaScript string literals must escape prose or build it with
`JSON.stringify`; one apostrophe broke a documentation script three times before it was quoted.
