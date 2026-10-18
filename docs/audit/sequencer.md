# Sequencer process — static security audit

Area: `src/l2/l2-sequencer-service.ts`, `l2-rpc-server.ts`, `l2-node.ts`, `l2-peer-network.ts`, `l2-checkpoint.ts`, `l2-client.ts`, `claim-accumulator-service.ts`, `message-store-service.ts`, `provider-registry-service.ts`, `formulary-service.ts`, `src/audit/*`, `l2-proving-pool.ts`/`l2-proving-worker.ts`, `src/nodes/start-leviathan.ts`, `start-explorer.ts`, `proof-delegate.ts`, `start-prover.ts`, replica behaviour. Every `file:line` read in the working tree 2026-10-16. Aliases per `docs/codemap/sequencer-core.md`: `seq`, `node`, `rpc`, `peer`, `ckpt`, `claim`, `msg`, `audit`, `start`, `exp`, `pd`.

Owner rules broken: I1 PHI/PII local only; I2 only walletID + proofs leave the phone; I3 enrollment key only in phone/encrypted NFC; I4 nothing outside the app reaches it; I5 only salted commitment + single-use code leave the employer; I6 only the member links employee↔wallet; I7 every state-change/member-data route authenticates, proofs verified at submission.

## 1. Summary (CRITICAL → LOW)

| ID | Sev | Rules | Title | Location | Live check (do NOT run) |
|---|---|---|---|---|---|
| SEQ-01 | CRITICAL | I7 | No cryptographic proof check at submission; forged proof mutates ledger | seq:293,344,374-378; rpc:755 | `POST /rpc l2_submitProof` with a proofJson whose `publicOutput` has `oldRegistryRoot`=`l2_getChainState.registryRoot` and a `newRegistryRoot` recomputed from `l2_getRegistrationWitnesses`, random proof bytes → expect HTTP 200 receipt + `l2_getChainState` root advanced (no valid proof) |
| SEQ-02 | HIGH | I7 | After restore, root enforcement relaxed → arbitrary roots accepted | seq:3059-3062,1452,1469,1485 | restart sequencer with >0 receipt-less/evicted wallets; log prints "tree/root checks are relaxed"; then `l2_submitProof` with any `newRegistryRoot` is accepted |
| SEQ-03 | HIGH | I7 | Poisoned pending pool; no rollback in l2Only → settlement halts | seq:1107-1109,902-907; node:1353-1360 | submit one unverifiable proof (SEQ-01), wait a batch cycle → `/health` `batchesFailed` climbs, `latestBatch` never advances; mutated roots never reverted |
| SEQ-04 | HIGH | I7 | Receipt eviction drops registrations from rebuilt trees on restart | seq:918-934,2833-2840,3059 | register >200 wallets, settle, restart → `l2_getChainState.walletCount` drops and relaxed-roots warning logs |
| SEQ-05 | HIGH | I7 | `requestAttestation` OPEN, lifecycle hard-coded 3, ignores revocation | node:356-376; rpc:2155-2174 | `l2_requestAttestation {walletId}` for any known/revoked wallet → signed attestation with `ls:3` returned to any caller **CLOSED 2026-10-18 (A10b):** `lifecycleStateOf` from the tree; wallet-signed. |
| RPC-01 | HIGH | I7,I1,I6 | OPEN reads of member-linked data (claims, audit, messages, wallet, PCP) | rpc:1189,1114,1636-1675,1739,1747-1777,2133,2143 | `POST /rpc l2_getClaimsByMember {walletId}` with no auth header → full drug/NDC/date/pay history |
| RPC-02 | HIGH | I7,I2 | `l2_storeMessage` OPEN, sender unauthenticated, no encryption check | rpc:1786-1841; msg:75-108 | `l2_storeMessage` with any `senderWalletId` and plaintext `ciphertext` → appended; `l2_getMessagesBySender` shows it **CLOSED 2026-10-18 (A10b), sender half;** encryption check remains D3. |
| RPC-03 | HIGH | I7,I6 | `l2_registerPcpAssignment` OPEN, no proof → forge member↔PCP link | rpc:2117-2131; map at 239 | `l2_registerPcpAssignment {memberWalletId,prescriberWalletId}` no auth → `l2_getPcpAssignments` shows the link **CLOSED 2026-10-18 (A10b):** signed by the member. |
| PRX-01 | HIGH | I2 | Proof delegate `/prove` takes the 7-Field wallet preimage off-device | pd:277-293,331-366; start:520 | `POST :4040/prove {method:'proveRegistration',params:{preimage:[7]}}` with `dev-key` → proof; preimage (incl. hash(enrollmentKey)) crossed the wire |
| BOOT-01 | HIGH | I1,I2,I5,I6 | `adjudication-state.json` plaintext, default mode: member preimage+employeeId+displayName | start:349-360 (engine:5684-5710) | `ls -l l2-data/adjudication-state.json` → not 0o600; file contains `preimageFields`, `employeeId`, `displayName`, `walletId` |
| BOOT-02 | HIGH | I4,I7 | Network admin token placed in the member "phone" process; member binds 0.0.0.0 | start:649-653 (CODEMAP §1 :4001) | inspect member process env → `ZKTRIDENT_ADMIN_TOKEN` present; `:4001` reachable off-host |
| SEQ-06 | MEDIUM | I7 | Fingerprint recorded before checks, never removed on throw → transition permanently blockable | seq:298-302 | submit a proof that fails a later step, resubmit the fixed proof → "Duplicate proof" though it never succeeded |
| SEQ-07 | MEDIUM | — | Duplicate-fill dedup runs after roots/audit advanced → audit/claim divergence | seq:429-457; claim:103-110 | submit two identical fills → audit log grows by 2, claim accumulator leafCount grows by 1; 2nd receipt `claimLeafIndex` = old leaf |
| SEQ-08 | MEDIUM | — | Audit commitment always 0 for pay; `verifyFinancialBalance` is a no-op | seq:398-423; audit:66-77,139-160 | `l2_verifyFinancialBalance` → `balanced:true` with 0 events checked regardless of claims |
| SEQ-09 | MEDIUM | I7 | `recordFill` appends a claim leaf with no proof and no audit event | seq:2140-2145; rpc:1684-1727 | `l2_recordFill` (admin) → `l2_getClaimAccumulatorRoot` leafCount +1 but `l2_getAuditLog` unchanged |
| RPC-04 | MEDIUM | I6 | `l2_submitProof` writes unverified `entityMetadata` (wallet→displayName) | rpc:774-787 | `l2_submitProof` with a registration proof + `entityMetadata{displayName,type}` → `l2_getEntity` returns attacker display name |
| RPC-05 | MEDIUM | I7 | Ed25519 admin signature replayable (30 s window, no nonce/cache) | rpc:2624-2658 | capture an admin `X-Admin-Signature`, resend within 30 s → accepted again |
| RPC-06 | MEDIUM | I7 | `checkAdminAuth` signs a constant message, not path/body-bound | rpc:2661-2671 | one Ed25519 sig over `admin-endpoint\|{}\|ts` opens `/viz/emit`, `/viz/clear`, every adminOnly route for 30 s |
| RPC-07 | MEDIUM | I6,I7 | SSE/viz expose wallet IDs, wallet→displayName, X25519 keys; `/viz/history` ACAO `*` | rpc:595-660,2426-2460,2502-2522 | `GET /events` or `GET /viz/entities` (no auth) → walletId + displayName + encryptionPublicKeyHex |
| RPC-08 | MEDIUM | I4 | ~~Binds 0.0.0.0; CORS `*` in unsecure mode~~ **FIXED by A2, 2026-10-17** | start:72,88-90; rpc:422-425 | `netstat` showed :3030 on 0.0.0.0; unsecure response `Access-Control-Allow-Origin: *`. Now `127.0.0.1` and a port-aware allowlist in both modes |
| REP-01 | MEDIUM | — | Replication non-functional: gossip is ADMIN-gated, replicas hold no token | start:481-487; rpc:691-702; peer:300-315 | `l2_getStateDigest` on :3031 → empty/stale vs :3030; replica logs show l2_gossipRelay Unauthorized |
| REP-02 | MEDIUM | I7 | Replicas apply gossip with no crypto verification; batch verify is flag-only/never enabled | seq:2488-2541; node:981-1009,2480 | code: `applyReplicatedReceipt` overwrites roots from payload; `batchProof.verify()` is the o1js flag |
| REP-03 | MEDIUM | I7 | Gossip signature excludes payload; no secret → accept-all | peer:631-680,671 | start with no `ZKTRIDENT_GOSSIP_SECRET` → `verifyGossip` returns true for any message |
| PRX-02 | MEDIUM | I4,I7 | ~~Explorer forwards any RPC method~~ **FIXED by A2, 2026-10-17**: loopback bind, and the explorer proxy now forwards only the 45 methods its own page calls (403 otherwise). It could not be closed — the explorer page reaches the sequencer no other way. Body cap and per-caller rate limit still outstanding | exp:76-95 | `POST :8000/rpc` any OPEN method → relayed to :3030; no `Authorization` was ever attached |
| BOOT-03 | MEDIUM | I7 | `admin123` default admin token in unsecure mode | start:80-81 | start with `ZKTRIDENT_UNSECURE=true` → `Authorization: Bearer admin123` passes all 17 ADMIN methods |
| BOOT-04 | MEDIUM | I3,I7 | Full `process.env` inherited by every child (gossip secret, genesis key, token) | start:523,557-562,662 | child member/provider process env contains `ZKTRIDENT_GOSSIP_SECRET` and `ZKTRIDENT_GENESIS_ADMIN_KEY` |
| BOOT-05 | MEDIUM | I7 | Gossip secret doubles as the NFC attestation Ed25519 seed; non-hex silently shortens | start:288; node:348-351; nfc:183-190 | any secret-holder (every child/peer) derives the sequencer attestation key and forges attestations |
| BOOT-06 | MEDIUM | I1 | Checkpoint plaintext claim/health data at rest (0o600) | ckpt:295-316; seq:2776-2806 | `l2-data/l2-checkpoint-*.json` contains cleartext `ndc`, `brandName`, `dateOfService`, pay cents, `npi`, `deaNumber` by walletId |
| RPC-09 | LOW | — | `l2_syncWalletState` returns the raw sequencer error string in a success result | rpc:811-814 | `l2_syncWalletState` with a stale root → `{synced:false,error:"<internal root string>"}` |
| RPC-10 | LOW | I7 | `l2_requestAdmission` OPEN write; unsecure genesis accepts any key | rpc:868-916,836-858 | `l2_requestAdmission {nodeId,publicKeyHex}` no auth → stored in `pendingAdmissions` |
| RPC-11 | LOW | — | Body limit 20 MB (doc says 10 MB); explorer proxy has no body cap | rpc:125,151; exp:76-95 | large body to :8000/rpc forwarded unbounded to :3030 |
| REP-04 | LOW | — | Peers banned on gossip alone (no evidence); IBD snapshot applied unverified | node:1101-1109,1127-1170 | a single `admin:eviction` gossip bans a named honest peer; `fromPeerSync` restores without verification |
| PRX-03 | LOW | I7 | `start-prover` standalone defaults to no API key (unauthenticated `/prove`) | start-prover:48-49,84; pd:277-284 | run `start-prover.ts` without `ZKTRIDENT_PROVER_API_KEY` → banner "NONE (unauthenticated)"; `/prove` open |

Severity counts: CRITICAL 1 · HIGH 10 · MEDIUM 17 · LOW 5 (33 total).

## 2. Findings

### SEQ-01 — CRITICAL — No cryptographic proof verification at submission
**Evidence.** `submitProof` calls `proof.verify()` (seq:293). In o1js 2.13 `Proof.verify()` only sets `this.shouldVerify = Bool(true)` and has "no effect" outside a circuit (`node_modules/o1js/.../proof.js:91-93`); no file imports `verify` from o1js (grep). All subsequent logic uses `proof.publicOutput` (seq:295): the old-root equality checks (seq:321-340) and `planTreeUpdate` (seq:344) read caller-supplied roots, then `treeUpdate.apply()` sets `currentRegistryRoot/currentLifecycleRoot` from `output.new*` (seq:374-378). The first real verification is in-circuit at batch time (`batch-program.ts:91-92`). `l2_submitProof` is RATE-only, no auth (rpc:718-723,691).
**Impact.** Any network caller (60/min/IP, unlimited via the explorer) crafts a proof JSON with arbitrary proof bytes and a chosen `publicOutput`. For registration they compute the correct `newRegistryRoot` from OPEN `l2_getRegistrationWitnesses`; the assertion at seq:1453 passes and an **arbitrary walletId is registered with no knowledge of its identity preimage** (identity squatting, bogus wallets). For a wallet update they read OPEN `l2_getWalletState` and **overwrite a victim wallet's credentialInventoryRoot/nonce**. Audit chain, claim accumulator and receipts all advance and are gossiped (seq:398-463; node:522-548) before any crypto check.
**Fix sketch.** Verify the submitted proof out-of-circuit against the compiled `StateTransitionProgram` verification key (`verify(proof, vk)` / `Program.verify`) before any mutation; reject on failure.

### SEQ-02 — HIGH — Restore relaxes root enforcement
**Evidence.** On `restoreState`, `treesAuthoritative = this.treesMatchRoots()` (seq:3059); when the rebuilt trees do not match the restored roots the flag is false and a warning logs (seq:3060-3062). `planTreeUpdate` skips the `output.newRegistryRoot`/`newLifecycleRoot` equality assertions whenever `treesAuthoritative` is false (seq:1452,1469,1485), and `assertTreesMatchRoots` downgrades to `console.warn` (seq:1419-1426).
**Impact.** Combined with SEQ-01, after any restart that leaves receipt-less or evicted wallets (see SEQ-04), the sequencer accepts a forged proof with an **arbitrary** `newRegistryRoot`/`newLifecycleRoot` — the attacker sets the ledger roots to any value.
**Fix sketch.** Do not accept external proofs while `treesAuthoritative` is false; require an admin tree rebuild first, and never skip the new-root assertion.

### SEQ-03 — HIGH — Poisoned pending pool, no rollback in l2Only
**Evidence.** An unverifiable proof accepted by SEQ-01 fails in-circuit in `BatchProgram.wrapSingle` at batch time. In l2Only the failure handler `markBatchFailed` throws immediately (seq:1107-1109) so `rollbackBatchState` (seq:1159-1217) never runs; the batch catch in `executeBatchCycle` only emits `batch:failed` and increments a counter (node:1353-1360). Drained transitions are unshifted back to the pool front (seq:902-907; node:1500), and the failing proof is never identified or removed.
**Impact.** One forged proof permanently stalls settlement: every subsequent batch re-drains the same poison and fails. The SEQ-01 mutations (roots, audit chain, claim leaves) are never reverted and are written into the next checkpoint. Denial of settlement + persisted corrupt state, no operator recovery path.
**Fix sketch.** On batch proving failure, identify and evict the offending transition and roll mutable state back to the last settled snapshot even in l2Only.

### SEQ-04 — HIGH — Receipt eviction silently drops registrations after restart
**Evidence.** `evictOldEntries` keeps only the 200 newest settled receipts (seq:918-934). `exportState` rebuilds `registeredWallets` by scanning `state.receipts` for `isRegistration` (seq:2833-2840); evicted registrations are absent. `restoreState` rebuilds the witness trees only from `state.registeredWallets` (seq:3035-3056), then relaxes enforcement when roots mismatch (seq:3059).
**Impact.** After >200 settled registrations and a restart, early-registered wallets vanish from the rebuilt registry/lifecycle trees (accepted state silently lost), `walletCount` drops, and root checks are globally relaxed (feeds SEQ-02). `walletLifecycleStates` still lists them, so the data structures disagree.
**Fix sketch.** Persist the authoritative registered-wallet set (and tree leaves) independently of evictable receipts.

### SEQ-05 — HIGH — `requestAttestation` mints signed ACTIVE attestations for any caller
**Evidence.** `l2_requestAttestation` is OPEN (rpc:2155-2174). `node.requestAttestation` sets `lifecycleState: 3` hard-coded (node:373) and never consults `walletLifecycleStates`; it signs for any wallet with receipts, a provider record, messages, or in `knownWallets` (node:362-368). The sequencer Ed25519 key signs it (node:370-376; nfc:205-230).
**Impact.** Any unauthenticated caller obtains a validly signed "ACTIVE" NFC attestation for any wallet that has any network footprint, **including REVOKED wallets** (lifecycle 4). Pharmacies treat the signature as proof of coverage, so revocation is bypassed and attestations are mintable by third parties.
**Fix sketch.** Gate the RPC (authenticate the requesting wallet/device), set `lifecycleState` from `walletLifecycleStates`, and refuse non-ACTIVE wallets.

### RPC-01 — HIGH — OPEN reads of member-linked data
**Evidence.** No auth on: `l2_getReceipt` (rpc:1069), `l2_getReceiptsByWallet` (1189), `l2_getAllReceipts` (1201), `l2_getAuditLog` (1114; walletId per event), `l2_getClaimsByMember/Pharmacy/Prescriber/Ndc` (1636-1666), `l2_getClaimWithProof` (1668), `l2_reconstructAccumulator` (2143), `l2_estimateCost` with `walletId` (1473-1545, calls `reconstructAccumulator`), `l2_getWalletState`/`l2_getWalletWitnesses` (1739,1733), `l2_getEntity` (1904), `l2_getEncryptionKey` (1434), `l2_getMessagesBy*` (1747-1777), `l2_getPcpAssignments` (2133), `l2_getAttestation` (2176).
**Impact.** Any caller, from any origin via any Nautilus `/rpc` proxy or the explorer, retrieves a member's full drug/NDC/date/pay history, deductible/OOP balances, PCP links, messages, X25519 key and display identity from a bare wallet ID — no binding to the requesting member (I7), exposing member-linked health/financial data (I1/I6).
**Fix sketch.** Require the caller to prove control of the wallet (or an authorized relationship) for every wallet-scoped read.

### RPC-02 — HIGH — `l2_storeMessage` unauthenticated, spoofable sender, no encryption check
**Evidence.** `l2_storeMessage` is OPEN (rpc:1786-1841). `appendMessage` stores the supplied `payload` verbatim and indexes it under the caller-supplied `senderWalletId`/`recipientWalletId` with no sender authentication and no check that `ciphertext` is encrypted (msg:75-108).
**Impact.** Anyone writes messages into any member's history under any claimed sender (impersonation, history pollution); dashboards that submit `btoa(body)` with `iv:'0',tag:'0'` store recoverable plaintext readable through OPEN `l2_getMessagesByWallet`.
**Fix sketch.** Authenticate the sender wallet, and reject payloads that are not well-formed ciphertext.

### RPC-03 — HIGH — `l2_registerPcpAssignment` unauthenticated, no proof
**Evidence.** OPEN handler appends `{memberWalletId, prescriberWalletId, effectiveDate}` to in-memory `pcpAssignments` with no proof and no caller auth (rpc:2117-2131).
**Impact.** Anyone forges or enumerates member→PCP relationships (member-linked data write + read via `l2_getPcpAssignments`).
**Fix sketch.** Require the member's wallet-update proof (the device path already produces one) before recording a PCP link.

### PRX-01 — HIGH — Proof delegate takes the wallet preimage off-device
**Evidence.** `POST :4040/prove` consumes `params.preimage[0..6]` — the 7-Field wallet preimage (domain tag + hashed identity fields + `hash(enrollmentKey)`) — and runs `StateTransitionProgram.proveRegistration/proveWalletUpdate` (pd:331-366). Auth is `X-Api-Key !== apiKey` (non-constant-time, pd:280-284) and absent entirely when `apiKey` is unset; `start-leviathan` spawns it with the demo default `dev-key` (start:520). Server binds 0.0.0.0, no CORS/TLS (pd:305).
**Impact.** When delegation is used, the complete wallet-derivation preimage (including the enrollment-key hash) leaves the phone to a 0.0.0.0 service behind a shared/weak or absent key — a direct I2 break; the member dashboard can POST it with no key (`dashboard-member/rpc.js`).
**Fix sketch.** Keep proving on the device; if a delegate is unavoidable, require a strong per-caller key with constant-time compare and bind to localhost.

### BOOT-01 — HIGH — `adjudication-state.json` persists member identity material in plaintext
**Evidence.** `start-leviathan` writes the engine's `exportState()` to `{checkpointDir}/adjudication-state.json` with `fs.writeFileSync(tmpPath, JSON.stringify(state))` at default file mode (start:349-360). `enrolledMembers[]` carries `walletId`, `displayName`, `employeeId`, `familyId`, `relationship`, and `preimageFields` (the wallet-ID preimage) and credential JSON (engine:5684-5710).
**Impact.** The member→wallet linkage (`employeeId`/`displayName` beside `walletId`, I5/I6) and the wallet preimage (hashed PII + hash(enrollmentKey), I2/I3) sit on the sequencer host in cleartext, world-readable by default perms. Per-field hashes are unsalted (CODEMAP §6, `hash-utils.ts:31-34`), so low-entropy fields (DOB, name) are brute-forceable from the file.
**Fix sketch.** The sequencer host must not hold member preimages/identity; if retained, encrypt at rest with 0o600 and strip `employeeId`/`displayName`/`preimageFields`.

### BOOT-02 — HIGH — Network admin token handed to the member "phone" process
**Evidence.** `spawnEntity('member', …, { ZKTRIDENT_ADMIN_TOKEN: adminToken, … })` (start:649-653); the member node binds 0.0.0.0 with CORS `*` (CODEMAP §1, :4001).
**Impact.** The member-device process holds the network-wide admin bearer token (used for 17 ADMIN RPCs and admin HTTP routes). Compromise of the phone process (which is network-reachable) yields full sequencer admin (I4/I7); the same token is shared by sequencer, insurer and provider nodes.
**Fix sketch.** The member device must never hold the network admin token; member RPCs it needs are OPEN, so remove the env injection.

### SEQ-06 — MEDIUM — Fingerprint recorded before checks, never cleared on throw
**Evidence.** The dedup fingerprint is added to `seenProofFingerprints` at seq:302, before the root checks (321-340), `planTreeUpdate` (344), WAL re-check (367) and apply (374); no `delete`/try-finally removes it on a later throw (grep seq:298-302, 1519, 3017-3032 only clear/restore).
**Impact.** A transition that fails any later step is permanently rejected as "Duplicate proof" on a corrected resubmission — a transient failure can brick a wallet's registration/update. The set also grows unbounded and is checkpointed.
**Fix sketch.** Record the fingerprint only after the transition is fully applied; bound/evict the set.

### SEQ-07 — MEDIUM — Duplicate-fill dedup diverges audit chain from claim accumulator
**Evidence.** `submitProof` advances roots and appends an audit event (seq:374-423) before the claim append; `appendClaim` returns the existing entry for a duplicate `(member:ndc:pharmacy:date)` fill without adding a leaf (claim:103-110), and the receipt's `claimLeafIndex` points at the old leaf (seq:456).
**Impact.** A duplicate fill produces a new audit event and root advance but no new claim leaf — audit log, claim accumulator and receipt disagree; downstream reconciliation and `reconstructAccumulator` under/over-count. Bounded financial inconsistency.
**Fix sketch.** Perform the dedup decision before mutating roots/audit, or emit a matching audit/no-op consistently.

### SEQ-08 — MEDIUM — Audit commitment omits amounts; financial-balance check is a no-op
**Evidence.** `computeEventCommitment` hashes `patientPayCents`/`planPayCents` (audit:66-77), but `submitProof` never sets them on the `AuditEvent` (seq:398-417), so they hash as 0. `verifyFinancialBalance` skips any event lacking `claimContext`/pay (audit:148), and `claimContext` is only set by `enrichAuditEvent`, which has no callers (seq:2403; grep).
**Impact.** The DA hash chain does not bind claim amounts, and the financial-balance audit always returns balanced with zero events examined — a documented integrity control that verifies nothing.
**Fix sketch.** Populate pay fields on the audit event (or remove them from the commitment) and make `verifyFinancialBalance` operate on claim-accumulator data.

### SEQ-09 — MEDIUM — `recordFill` writes a ledger leaf with no proof and no audit event
**Evidence.** `recordFill` calls `claimAccumulator.appendClaim` directly (seq:2140-2145); no proof, and no `AuditEvent` is emitted. Exposed as ADMIN `l2_recordFill` (rpc:1684-1727).
**Impact.** An admin-token holder (token is shared with every node incl. the member process, BOOT-02/04) injects arbitrary claim leaves that never appear in the audit chain, so audit vs. claim state silently diverge.
**Fix sketch.** Route all claim writes through the proof+audit path, or at minimum emit a corresponding audit event.

### RPC-04 — MEDIUM — Unverified `entityMetadata` bound to a wallet at registration
**Evidence.** On a registration result, `l2_submitProof` writes caller-supplied `entityMetadata.displayName/type/...` into `entityRegistry` keyed by the wallet (rpc:774-787); the comment concedes it is "untrusted display data."
**Impact.** Combined with SEQ-01 (walletId itself attacker-chosen), an attacker binds an arbitrary display name/type to any wallet, surfaced through OPEN `l2_getEntity`, `/viz/entities`, SSE and dashboards.
**Fix sketch.** Do not accept display metadata on `l2_submitProof`; set it only through an authenticated registration route.

### RPC-05 — MEDIUM — Replayable Ed25519 admin signature
**Evidence.** `verifyAdminSignature` accepts any signature within `abs(now-ts) <= 30_000` with no nonce and no seen-signature cache (rpc:2635-2656).
**Impact.** A captured admin request is replayable for 30 s (e.g., repeat `l2_forceBatch`, `l2_revokeAdminKey`). Dormant today (Bearer mode shipped) but active if Ed25519 mode is enabled.
**Fix sketch.** Add a per-signature nonce with a replay cache.

### RPC-06 — MEDIUM — Constant-message admin signature for non-RPC routes
**Evidence.** `checkAdminAuth` verifies Ed25519 over the fixed string `admin-endpoint|sha256('{}')|ts` (rpc:2669), not bound to method, path or body.
**Impact.** One signature authorizes every admin-gated HTTP route (`/viz/emit`, `/viz/entities`, `/viz/clear`, all `adminOnly` engine routes) for 30 s. Dormant in Bearer mode.
**Fix sketch.** Bind the signed message to the HTTP method, path and body hash.

### RPC-07 — MEDIUM — SSE/viz expose wallet IDs and the wallet→displayName map
**Evidence.** OPEN `GET /events` streams `proof:accepted.data.walletId` and messaging audit events (rpc:595-660; node:500-504,629-640); OPEN `GET /viz/events`/`/viz/entities`/`/viz/state`/`/viz/history` expose `actorWalletId`/`targetWalletId`, `displayName` and `encryptionPublicKeyHex` (rpc:2426-2522); `/viz/history` forces `Access-Control-Allow-Origin: *` (rpc:2454-2458).
**Impact.** Any origin subscribes to live wallet activity and the wallet→display-name + X25519-key registry (I6), with a CORS wildcard on `/viz/history`.
**Fix sketch.** Gate viz/SSE behind auth or emit only non-identifying handles; drop the wildcard.

### RPC-08 — MEDIUM — Binds all interfaces; CORS wildcard in unsecure — **FIXED by A2, 2026-10-17**
**Evidence.** Default host `0.0.0.0` (start:72); `allowedOrigins` becomes `['*']` in unsecure mode (start:88-90), echoed as `Access-Control-Allow-Origin: *` (rpc:424). Default secure origin list lacks ports, so `:4001` dashboards get `null` unless proxied.
**Impact.** The sequencer is reachable off-host; unsecure deployments accept any browser origin.
**Fix sketch.** Default to 127.0.0.1; never use `*`; include ports in the allow-list.
**Fixed.** All three, in `src/security/network-policy.ts`. One thing this finding understated: the
port-less list did not merely fail to match, it answered the off-list origin with the literal string
`null`, and `Access-Control-Allow-Origin: null` grants every null-origin context — a `file://` page, a
sandboxed iframe, a data URI. The policy that looked strictest was granting a class of caller that the
wildcard would also have reached. The header is now omitted entirely for an off-list origin and for a
request that carries no `Origin` at all.

### REP-01 — MEDIUM — Replication is non-functional in the shipped topology
**Evidence.** Gossip is delivered via `client.gossipRelay` → `l2_gossipRelay`, which is in `ADMIN_METHODS` (peer:300-315; rpc:207-225). The sequencer's peer client attaches the admin bearer (peer:150-154), but replica RPC servers are built with `{port,host,enableSSE:false,allowedOrigins}` only — no `adminToken`, no `unsecureMode` (start:481-487). The admin gate then default-denies: `if (!this.options.adminToken) return Unauthorized` (rpc:696-702). Replica→sequencer gossip carries no token either (replica node options omit `adminToken`).
**Impact.** Every `l2_gossipRelay` between sequencer and replicas is rejected both directions, so replicas never apply any receipt/batch/settlement. The "Bitcoin-style full node / data-availability" redundancy is an illusion: the only live copy is the single sequencer's in-memory store + checkpoint. Replicas serve empty/stale OPEN RPC.
**Fix sketch.** Give replicas a credential for the gossip channel (or make gossip a dedicated authenticated non-ADMIN path) and verify replication end-to-end.

### REP-02 — MEDIUM — Replicas apply gossip without cryptographic verification
**Evidence.** `applyReplicatedReceipt` overwrites `currentRegistryRoot/LifecycleRoot/WalletCount` from payload strings, registers wallets, and appends audit events + claim entries with no proof (seq:2488-2541; the comment at seq:2480 claims "the sequencer already verified it", which SEQ-01 shows it did not). The replica `batch:built` path guards on `batchVerificationEnabled` and then calls the flag-only `batchProof.verify()` (node:985-989); `verifyGossipBatches` is never set by the launcher.
**Impact.** A peer that can deliver gossip (an admin-token holder, or if REP-01 is "fixed" naively) defines a replica's entire state — roots, registrations, audit chain, claims — with no verification.
**Fix sketch.** Verify batch/chain proofs out-of-circuit on replicas before applying, and derive roots from verified proofs, not payload strings.

### REP-03 — MEDIUM — Gossip signature excludes the payload
**Evidence.** Both the HMAC and Ed25519 gossip signatures cover only `messageId:type:senderId:timestamp` (peer:633-644,656-668); with no `gossipSecret` and no peer-key map, `verifyGossip` returns `true` for everything (peer:671).
**Impact.** Even when a shared secret is configured, the state-bearing payload (receipt, roots, batch, claim) is unauthenticated and can be altered/replayed with a valid header signature; with no secret (the default banner path) all gossip is accepted.
**Fix sketch.** Include a hash of the payload in the signed message; require authentication in production.

### PRX-02 — MEDIUM — Explorer strips auth and proxies any method
**Evidence.** `POST :8000/rpc` forwards the raw body to `<sequencer>/rpc` with only `Content-Type` (exp:82-95); Authorization/X-Admin-Signature never reach the sequencer, there is no body cap, and all proxied `l2_submitProof` share the explorer's socket IP for the rate limiter (rpc:719).
**Impact.** Every OPEN method is reachable from any origin through :8000 (0.0.0.0); the per-IP proof rate limit collapses to one bucket for all explorer traffic.
**Fix sketch.** Allow-list only read-only methods on the proxy; set `X-Forwarded-For` honoring on the limiter or rate-limit the proxy itself.

### BOOT-03 — MEDIUM — `admin123` default admin token in unsecure mode
**Evidence.** `adminToken = unsecureMode ? (env.ZKTRIDENT_ADMIN_TOKEN ?? 'admin123') : env.ZKTRIDENT_ADMIN_TOKEN` (start:81); unsecure also sets CORS `*` and RPC Bearer mode.
**Impact.** A `ZKTRIDENT_UNSECURE=true` instance that is network-reachable grants all 17 ADMIN RPCs and admin HTTP routes to anyone with the well-known token (effectively unauthenticated admin).
**Fix sketch.** Never default a token; fail closed if unsecure mode is used off-localhost.

### BOOT-04 — MEDIUM — All children inherit the full launcher environment
**Evidence.** `spawnEntity`/prover/explorer build child env as `{...process.env, …}` (start:523,557-562,662) with `shell:true`.
**Impact.** `ZKTRIDENT_GOSSIP_SECRET` (= attestation seed, BOOT-05), `ZKTRIDENT_GENESIS_ADMIN_KEY` and `ZKTRIDENT_ADMIN_TOKEN` reach the member and provider processes. Any child compromise yields the network admin token and attestation signing seed.
**Fix sketch.** Pass only the minimal env each child needs; do not spread `process.env`.

### BOOT-05 — MEDIUM — Gossip secret doubles as the attestation signing seed
**Evidence.** `node.enableAttestations(gossipSecret)` (start:288) → `new SequencerAttestationAuthority(Buffer.from(seed,'hex'))` (node:350) → SHA-256 → Ed25519 (nfc:183-190).
**Impact.** The gossip HMAC secret — shared with every peer and every child (BOOT-04) — deterministically derives the sequencer's NFC attestation private key, so any holder forges sequencer-signed attestations (compounds SEQ-05). A non-hex secret decodes to a shortened/empty seed, weakening the key silently.
**Fix sketch.** Use an independent, hex-validated attestation key; separate it from the gossip secret.

### BOOT-06 — MEDIUM — Checkpoint holds plaintext claim/health data at rest
**Evidence.** `L2CheckpointStore.save` writes `l2Stringify(checkpoint)` (tmp+fsync+rename, mode 0o600, ckpt:306-313). The serialized `sequencerState` includes cleartext `ndc`, `brandName`, `dateOfService`, `patientPayCents`/`planPayCents`, provider `npi`/`deaNumber`, and employer `signerName`/`signerTitle`, all keyed by walletId (seq:2776-2806).
**Impact.** Drug/medication history, amounts and provider identifiers for every member are at rest in cleartext on the sequencer host. 0o600 bounds it to the file owner, but the network is supposed to hold only wallet IDs + hash commitments (I1).
**Fix sketch.** Encrypt checkpoint contents at rest, or store only hash commitments and keep plaintext claim metadata off the sequencer.

### RPC-09 — LOW — Internal error string leaked in a success result
**Evidence.** `l2_syncWalletState` returns `{synced:false, error: <raw sequencer message>}` inside a JSON-RPC success (rpc:811-814).
**Impact.** Leaks internal root/state strings to any caller (the method is OPEN).
**Fix sketch.** Return a generic error code.

### RPC-10 — LOW — Unauthenticated admission write; unsecure genesis accepts any key
**Evidence.** `l2_requestAdmission` is OPEN and writes `pendingAdmissions` (cap 100, rpc:868-916). Genesis `l2_registerAdminKey` in unsecure mode registers any 64-hex key when `ZKTRIDENT_GENESIS_ADMIN_KEY` is unset (rpc:836-858).
**Impact.** Minor pending-admission flooding; in unsecure mode the first admin key is attacker-settable (only matters if later switched to Ed25519 mode).
**Fix sketch.** Rate-limit admission; require a genesis key even in unsecure mode.

### RPC-11 — LOW — Body-limit doc mismatch; unbounded proxy body
**Evidence.** `maxBodyBytes` default is 20 MB while the doc comment says 10 MB (rpc:125,151). The explorer proxy streams the body with no cap (exp:76-95).
**Impact.** Misleading limit; large bodies forwarded unbounded through :8000.
**Fix sketch.** Align the comment; cap the proxy body.

### REP-04 — LOW — Ban-on-gossip and unverified IBD snapshot
**Evidence.** Receivers ban a named peer on an `admin:eviction` gossip with no evidence check (node:1101-1109); `fromPeerSync` restores a peer snapshot without verification (node:1127-1170).
**Impact.** If gossip delivery were reachable, a malicious peer could evict honest peers and seed a new node with forged state. Gated today by REP-01.
**Fix sketch.** Require signed equivocation evidence; verify snapshot roots/proofs on IBD.

### PRX-03 — LOW — Standalone prover is unauthenticated by default
**Evidence.** `start-prover.ts` defaults `ZKTRIDENT_PROVER_API_KEY` to none and prints "NONE (unauthenticated)"; `/prove` then has no auth (start-prover:48-49,84; pd:277-284).
**Impact.** A standalone prover accepts wallet-preimage proving from anyone (see PRX-01). Under the launcher it gets `dev-key` (a weak default).
**Fix sketch.** Require a strong key; refuse to start without one.

## 3. Not a finding (checked, acceptable or by design)

- Bearer admin compare uses `timingSafeEqual` (rpc:2609-2614) — constant-time, OK.
- Checkpoint write is atomic (tmp + fsync + rename) at mode 0o600 (ckpt:306-313) — durability/permissions OK; the concern is plaintext content (BOOT-06), not the write.
- Pagination clamps `limit ≤ 1000` and `offset ≥ 0` (rpc:1119-1124,1206-1208); negative limits yield empty slices, no crash.
- Partition check (seq:305-315) is correct but inert — the launcher sets `partitionConfig` only when `PARTITION_COUNT>1` (start:93-96); single-partition default is fine.
- WAL/quorum/heartbeat/failover/`L2Leviathan` are dormant (not constructed by the launcher; `walProvider` stays null, seq:245) — not live attack surface; noted in open questions.
- `l2_requestSnapshot` and `l2_gossipRelay` are ADMIN (rpc:207-225); on replicas they are default-denied (no token). Acceptable gating (the problem is the shared token, BOOT-02/03, and broken delivery, REP-01).
- Static request timeout writes 504 but does not abort the handler (rpc:410-418) — hygiene, not security.
- Static file handler validates the path regex, rejects `..`, and checks `startsWith(dashboardDir)` (rpc:512-540) — OK. (The explorer's `path.join` without a canonical-prefix check, exp:188-201, is a separate dashboards/explorer concern, low risk given the regex.)
- Admin action logging prints `nodeId`, partial public key and reason (rpc:848-860) — identifiers, not secrets; no walletId/token logged in the sequencer core (grep).
- VK-commitment peer gating (peer:197-205) rejects software-version-mismatched peers — a useful control, not a weakness.

## 4. Open questions

1. Are `employeeId`/`displayName` in `adjudication-state.json` real values or placeholders in production? If real, BOOT-01 is CRITICAL (raw PII on the sequencer host).
2. Is the Ed25519 admin mode ever enabled in production (a genesis key registered)? Nothing in the tree registers one, so RPC-05/RPC-06 are dormant; if enabled they become live.
3. REP-01 makes replication non-functional in the shipped topology — is a different launcher/credential expected to carry gossip to replicas, or are replicas dead code?
4. Is `ZKTRIDENT_GOSSIP_SECRET` required to be hex? If not, BOOT-05 silently shortens the attestation key (node:350).
5. Operational recovery for a poisoned pool in l2Only (SEQ-03): is there any intended path, or does a single forged proof require a full restart from a pre-poison checkpoint?
6. `pcpAssignments` and `entityRegistry` live only in the RPC-server process and are not in the checkpoint (rpc:239,236; 2688-2699) — are PCP links and wallet→displayName intentionally lost on restart?
7. Is `l2_recordFill` (no proof, no audit event) a production path or fixture-only? Only `scripts/e2e-verify/run.ts` calls it.
8. `atypes:34` documents an 8-field audit commitment; `audit:66-77` hashes 10 (last two always 0). Which is canonical for external verifiers (affects SEQ-08)?
