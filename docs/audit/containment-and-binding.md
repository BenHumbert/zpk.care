# Containment, hash reversal, and enrollment binding

Session 2 findings verified directly against the running network and its own files on 2026-10-16. Companion files: `phi-pii.md`, `auth-and-exposure.md`, `proofs-and-crypto.md`. Hub: `../AUDIT.md`.

Network under test: the sequencer started 2026-10-15 15:47 with admin token `e897…aa3` (secure Bearer mode), four member devices (:4001, :4011–:4013), two employer tenants and their HR Tools, replicas :3031/:3032. Test identities are fictional.

## 1. CONT-1 (critical, I2) — the stored identity hashes are reversible, so the sequencer's disk reveals who each wallet belongs to

`l2-data/adjudication-state.json` stores, per enrolled member, the 6-Field wallet preimage (`src/adjudication/interactive-service.ts:5695-5696`, written by `src/nodes/start-leviathan.ts:349-362`). The hashes are unsalted: `hashString(v) = Poseidon(Encoding.stringToFields(v))` and `hashDate` likewise, with no salt and no per-field domain tag (`src/zkp/hash-utils.ts:31-34, 62-64`).

Reversal run on this machine, reading only that file:

| Field (preimage slot) | Search space used | Result |
|---|---|---|
| date of birth `[1]` | all dates 1920-2020, 37,572 hashes | **all 4 members recovered** |
| first name `[2]` | 20-name list | **all 4 recovered** |
| last name `[3]` | same 20-name list | **all 4 recovered** |
| cardholder / employee ID `[0]` | 8 format guesses | no match; depends on knowing the employer's ID format |
| hash(enrollment key) `[4]` | 2^256 | not reachable by search |

Recovered values, matching what each member typed on their device in the earlier run: `19921103 Rowan Ashgrove`, `19870412 Avery Quillfeather`, `20010219 Sasha Penhallow`, `19750828 Jules Marrowind`.

Cost: the whole date table took 75 s at 498 Poseidon hashes/s in plain Node with o1js. An optimized Poseidon implementation is orders of magnitude faster, so treat 75 s as the slow end.

Consequence: anyone who can read one JSON file on the sequencer host learns the name and birth date behind every wallet ID. Because the same file also carries `displayName`, `planId`, and the wallet's claim receipts, and the claim accumulator in the checkpoints carries drug NDC, brand, date and amounts per wallet, this collapses the design's central privacy promise. The enrollment key is the one field entropy protects.

Fix direction (do not implement in this session): the phone proves its own wallet updates so the preimage never leaves the device (planned fix phase B), and the identity fields get a per-member salt held on the phone and the recovery card (phase C). Salting alone fixes reversibility; not sending the preimage fixes the exposure.

## 2. CONT-2 (high, I2) — scope of the on-disk exposure, and what is clean

`scripts/e2e-verify/check-phi-containment.ts` was extended this session to scan every store and every unauthenticated API surface, not just the sequencer's disk and `/interactive/state`. Full output: the session scratchpad file `containment-2026-10-16.txt`.

| Surface (all probed with no credentials) | Raw PHI | Per-field hashes | Enrollment key |
|---|---|---|---|
| Sequencer disk (`l2-data/`: engine state + checkpoints) | — | **all 4 members, all 5 hashes** | — |
| `GET /interactive/state` | — | — | — |
| `/viz/state`, `/viz/entities`, `/viz/history` | — | — | — |
| `/events` SSE (6 s sample) | — | — | — |
| 9 per-wallet RPCs on :3030 (claims, receipts, messages, accumulator, PCP, entity, key, state, attestation) | — | — | — |
| Same 9 RPCs on replica :3031 | — | — | — |
| Member node `/health`, `/onboarding/status` (4 devices) | — | — | — |
| Member node `/rpc` proxy | — | — | — |
| Explorer `/rpc` proxy | — | — | — |
| Employer nodes `/health`, `/roster`, `/groups`, `/tokens` (4 tenants) | — | — | — |
| HR Tools `/api/status`, `/api/employees`, `/api/export/tokens` (4 tools) | — | — | — |
| Network log (2,533 lines) | — | — | — |
| Insurer disk (`nautilus-data/`) | — | — | — |
| HR Tool disk, unencrypted files | — | — | — |
| Each member's own device, decrypted | — | own 5 hashes | own key |

Verdict from the check: **I1 holds, I3 holds, I6 holds, I2 broken.** The I2 break is persistence, not API exposure: no live endpoint serves the preimage, and the raw enrollment key appears nowhere outside its own device. The member app's scrub after hashing (`src/security/secure-context.ts:78`) and the device's AES-256-GCM state both hold up under direct inspection.

Rules the check still does not cover: the browser's `localStorage` (needs a browser context), the employer dashboard's rendered roster, authenticated surfaces (it deliberately probes as an outsider), and the member node's `/drugs`/`/receipts` routes.

## 3. CONT-3 (low, I5) — the HR Tool's plaintext audit log can record an employee ID, but did not here

`hr-tool-data/<employer>/<workspace>/[groups/<group>/]audit.log` is plaintext beside the encrypted correlation table and group seed. Two write sites can put identity in it: `src/tools/hr-tool-server.ts:792` writes `employeeId=<plaintext>` on the single-employee lookup route, and `:773` writes the operator's search term. Neither route was exercised in the run, so the live logs on disk contain only group IDs, counts and the employer URL, for example `import group=GRP-A-MVA0YQKN total=2 success=2 failed=0 skipped=0`.

This refines the Session 1 code-map claim, which stated the plaintext employee ID was in the log: the code path exists but is conditional. Severity stays low because the file never leaves the employer's machine, where employee identity is permitted under I5; the defect is that it defeats the encryption-at-rest the neighbouring files have.

## 4. BIND-1 (high, correctness) — enrolled members are bound to a default plan and group, not their employer's

All four members on the sequencer carry `planId: PLAN-GOLD-2026` and `groupId: ACME-CORP`, with `employeeId` and `familyId` empty:

```
wallet 15692759402919…  planId=PLAN-GOLD-2026  groupId=ACME-CORP  employeeId=""  lifecycle=ELIGIBLE
wallet 20558373595314…  planId=PLAN-GOLD-2026  groupId=ACME-CORP  employeeId=""  lifecycle=ELIGIBLE
wallet 83424142783175…  planId=PLAN-GOLD-2026  groupId=ACME-CORP  employeeId=""  lifecycle=ELIGIBLE
wallet 16425677108535…  planId=PLAN-GOLD-2026  groupId=ACME-CORP  employeeId=""  lifecycle=ELIGIBLE
```

The plans the employers actually bought are registered on the same sequencer, with different rules: `PLAN-E2E-MVA0YQKN` ("E2E Gold", copay 1000, deductible 50000, OOP max 800000, family deductible 100000). The employer groups were `GRP-A-MVA0YQKN` and `GRP-B-MVA0YQKN`.

Cause chain, each step already mapped: the member app posts only `{tokenId}` to `/onboarding/accept-token` (`dashboard-member/app.js:375`), the node takes group and plan from the request body and so stores empty strings (`src/nodes/routes/member-routes.ts:108-120`), the empty group becomes `groupIdHash = Field(0)` in the wallet derivation (`:235-236`), and the engine substitutes its fixture defaults when registering (`src/adjudication/interactive-service.ts` register path). The employer's token carried the real group, and nothing ever compares the two.

Consequences:
- Adjudication runs against the wrong benefit rules. Copay, deductible, OOP max and family pooling all come from the default plan, not the purchased one. This is a plausible contributor to the two accumulator-rebuild failures in the last live run (engine totals 53000/50000 versus ledger 2400/1400), which `proofs-and-crypto.md` traces to root cause.
- The three-party ceremony's central binding is not in force: the employer attests a group, the member enrolls, and the sequencer records a group unrelated to either.
- It is why I6 currently holds. The wallet-to-employee link is absent because the fields are empty, not because anything prevents it. Filling them in, as `/enrollment/confirm` would (`src/nodes/employer-node.ts:434`), breaks I6 immediately.

This is the deferred Phase 2 item named in `scripts/e2e-verify/PLAN-registry-fix.md` ("wallet-to-group binding and plan/group pass-through"). The live evidence here raises it from a tidiness issue to a correctness one, because benefit amounts are computed from the wrong plan.

## 5. Live run failures, itemized

The last multi-employer run (`harness-multi-resume2.log`, 2026-10-15 16:45) scored **119 of 127**, not the 241/254 quoted in `SESSION-KICKOFF.md` (that figure was an earlier attempt). All eight failures, with the harness's own expected-versus-actual:

| # | Check | Expected | Actual |
|---|---|---|---|
| 1 | a duplicate is rejected before payment or recorded as a claim | rejected, or one new claim leaf | `adjudicated (patient pays 1000) with 0 new leaf` |
| 2 | wallet `2055837359…` accumulator rebuilt from the ledger equals engine totals | `oop 53000, deductible 50000` | `oop 2400, deductible 1400, claims 2` |
| 3 | wallet `1642567710…` same | `oop 3100, deductible 3100` | `oop 2100, deductible 2100, claims 2` |
| 4 | portable credential generated | `proofJson` | `Proof worker error: Cannot convert undefined to a BigInt` |
| 5-8 | `hash(enrollmentKey)` stays off the network, per member A1/A2/B1/B2 | not found | `sequencer disk: l2-data\adjudication-state.json` |

Failures 5-8 are CONT-1/CONT-2 above. Failures 1-4 are integrity defects; see `proofs-and-crypto.md`. Note on #1: the member was charged 1000 cents and the ledger recorded nothing, so money moved without a claim record.

## Open questions

- Does the member's benefit plan get corrected anywhere later in the flow, or do all fills for these wallets use the default plan's rules?
- Would passing the real group through break the wallet ID (it is mixed into derivation as `groupIdHash`), and does that force a re-enrollment for existing wallets?
- Is `PLAN-GOLD-2026` / `ACME-CORP` reachable in a production boot, or only because the fixture seed registers them?
