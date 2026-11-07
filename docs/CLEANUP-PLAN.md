# Cleanup and out-of-the-box plan

Started 2026-11-07 at the owner's request: "a massive code clean up for good code hygiene and formatting this to be an out of the box experience while we are still adding more features and fixing bugs". This moves the cleanup and the out-of-the-box start forward. It runs alongside the hardening plan (`scripts/e2e-verify/PLAN-security-hardening.md`) and the feature order (price sources slice 2 next) instead of waiting for them. Per-role packaging and population sizing still come last (phase 6).

## Rules

1. **Behavior stays the same unless a slice says otherwise.** A slice that changes behavior names the change, has a test that fails before it, and is recorded in `docs/AUDIT.md` when it fixes a defect.
2. **Every slice is verified before it is committed:**
   - all typechecks;
   - the regression batch;
   - a live run (secured boot, explorer on 8010) when it touches anything the network runs;
   - a local commit (no push).
3. **Mechanical sweeps are one commit each**, such as formatting or line endings. Each one is listed in `.git-blame-ignore-revs`, so `git blame` skips it.
4. **Earlier owner decisions still hold:**
   - no demo or proof-of-concept language in production code;
   - fixtures are removed last;
   - no MINA;
   - never touch the servers on ports 8000 and 8080;
   - renames wait for the naming decision below.
5. **Features and fixes keep landing.** A cleanup slice is never left half-done across a feature commit. Long test runs happen in a separate worktree (`Z:/zpk_care-verify`, pinned to a commit), so the main tree stays free for editing.

## What the survey found (2026-11-07, at 4cc3807)

| Area | Finding |
|---|---|
| Size | 753 tracked files. Code lines (data files excluded): src 103K in 228 files; tests 80K in 218 suites; visualizer 37K; dashboards 25K; scripts 5K; tools 6.5K |
| Type errors | src 18, scripts 2. Tests are never typechecked: ts-jest only transpiles them, and checking finds about 140 errors, 98 of them calls to the wallet derivation without the identity salt (added in Step 2). visualizer/engine has 3 |
| Real defects behind type errors | `EnrollmentService.processEnrollment` and `migrateWallet` read fields the hash-only `TokenAuthority` no longer has (7 errors; dead code, and its suites fail by name). The prescriber's send-prescription answer reads `entry.index`, which does not exist, so `messageIndex` was never sent. The member's message route calls `BigInt(undefined)` when the device has no wallet, a 500 where a refusal belongs. Two quorum events are missing from `L2EventType` |
| Unused code | 111 unused imports, locals, parameters and types in src and scripts (TS6133, TS6196) |
| Test hygiene | 64 of 218 suites belong to no batch. The repo's list (`scripts/dev/regression-suites.txt`, 153) is behind the batch actually run (173, kept in a scratch file). `npm test` runs everything, including the suites that fail by name (onboarding, wallet-migration) and production-showcase, which takes over ten minutes |
| Line endings | 22 files are CRLF in the index and 9 are mixed. No text rule in `.gitattributes`, no `.editorconfig` |
| Format and lint | No formatter or linter. The code is mostly 2-space, single quotes and semicolons; 16K lines are over 100 characters |
| Dead code | `src/poc/` (8 files; plan F1c). `src/seed/nadac-formulary.ts` (12.5K lines), read only by `scripts/fetch-nadac.ts`, itself a dead 500-drug seed. `src/index.ts`, a barrel nothing imports (package.json `main` points at a `build/` nothing produces). The F3 list: verification services, `UserWalletService`, `AorService`, `CareContract`, `ProofDelegateClient`. The legacy visualizer (Parcel console on :1234, `dist/flowchart`, engine drivers); its future is an owner question |
| Dependencies | `docx` is a runtime dependency used only by an ignored local script; `ts-node` is unused. `visualizer/` and `tools/demo/` have their own manifests |
| Large files | `interactive-service.ts` 8,379 lines; `l2-sequencer-service.ts` 3,572; `l2-rpc-server.ts` 3,459; `insurer-routes.ts` 3,047; `interactive-routes.ts` 2,663 |
| Duplicates | `logo.png` 10 times (2.6 MB) |
| Logging | src has 774 `console.log`, 95 `warn` and 103 `error`; there are no levels |
| Configuration | 83 environment names (`ZKTRIDENT_*`, `HR_TOOL_*`, `E2E_*`, `NADAC_*`) read in 29 src files. There is no single list, and a misspelled name goes unnoticed |
| Out of the box | The README quick start boots the unsecure mode (shared token, open CORS). A secured boot needs a hand-made env file. There is no prerequisite check. The README says Node 20+, which reached end of life in April 2026; the code runs on 22 |
| Banned words in src | "demo" 7, "MINA" 17, "L1" 111 (`l1Status` and friends; plan F2) |
| Root | 10 markdown files. The patent drafts and work folders at the root are the owner's gitignored local files and are left alone |

## The suites outside every batch (triage, 2026-11-07, at 4cc3807)

Each of the 64 suites outside the repo's list was run alone in the verification worktree. 20 of them were already in the batch kept in a scratch file, and 44 were in no batch. A 65th, `network`, was missed because its name is a substring of `l2-network` in the list; the new `tests/suite-lists.test.ts` found it on its first run.

| Result | Suites | What happens to them |
|---|---|---|
| Pass (37) | aor, audit, catalog-data, claim-accumulator(-integration), claim08, claim10, cms-nadac, employer-invites, employer-tenant-store, explorer-port, family, hr-tool-texts, insurer-key-provisioning, key-ceremony(-cli), key-seal, key-shamir, kill-ports, l2-network, l2-partition, l2-proving-pool, l2-quorum, l2-wal, launcher-ceremony, layer0, layer10, machine-seal, member-hold, message-store, nadac-dedupe, node-keyring, pcp, pcp-reads-follow-choice, plan-republish-limits-proof, portable-credential, price-list, registry-consistency, sealed-store; and accumulator, layer6, layer7, layer9 (slow, 75 to 158 s) | Into the batch; slow ones (over 60 s) into `scripts/dev/slow-suites.txt`, which `npm run test:all` runs |
| Stale test, fixed (13) | chain-program, l2-recursive, l2-settlement, layer2, layer3, layer3-recursive, layer4, layer5, security, benchmark in part: 98 calls without the identity salt (Step 2, 2026-10-18). epoch-accumulator: the claim fixture lacked `deductibleCreditCents`. l2: `MAX_TRANSITIONS_PER_BATCH` is 2 since 2026-03-02. layer8: the prescription lifecycle from before March. smoke: counted the 32,768-drug seed catalog | Fixed in phase 1, then into the batch or the slow list |
| Fail on the in-process `EnrollmentService` (4) | onboarding, wallet-migration, formulary-update (2 cases), benchmark | Phase 3.3. The engine calls this service only to terminate a console fixture member. `processEnrollment` and `processMigration` read fields the hash-only `TokenAuthority` no longer has (A-109) |
| Superseded (3) | smoke-e2e, smoke-leviathan, production-showcase: in-process HTTP walks of the flows from before the hardening (open routes, providers enrolling with codes) | Phase 3. The live harness (`scripts/e2e-verify/run.ts`, 260 checks) walks the same story against the hardened network |
| Research (1) | minimal-recursion: the February reproduction of an o1js recursion issue, whose fix lives in `BatchProgram` (tested by chain-program and l2-recursive) | Phase 3, delete |

**Found by the triage: A-148.** A partial fill cannot be proven. The engine proves FILLED -> PARTIALLY_FILLED for the first part and PARTIALLY_FILLED -> DISPENSED for the last, and the prescription circuit refuses both. It went unnoticed because no live run fills part of a script and the suites that do stub the prover. It is fixed as its own slice after phase 1.

## Phases

### Phase 1: a safety net anyone can run (no behavior change)

- **1.1 Tests.** Bring the regression list in the repo up to date; `npm test` runs it and `npm run test:all` runs everything. Sort the 64 suites outside the batch:
  - those that pass join it;
  - those failing on code the network runs get fixed;
  - those failing on dead code are deleted together with that code in phase 3.
- **1.2 Typecheck to zero.** First src and scripts, then tests and visualizer/engine. One `npm run typecheck` covers them all.
- **1.3 Line endings.** `.gitattributes` (`text=auto eol=lf`, with binary types marked), `.editorconfig`, and one renormalizing commit.

### Phase 2: hygiene sweeps

- **2.1** Remove unused imports, locals and parameters, then turn on `noUnusedLocals` so new ones are refused.
- **2.2** Add Prettier as a pinned dev dependency, configured to match the current style. One formatting commit, `npm run format` and `npm run format:check`.
- **2.3** ESLint with typescript-eslint: the recommended rules plus `no-floating-promises`, which catches promise rejections nothing handles in the servers.
- **2.4** `npm run check` = every typecheck + the format check + lint.

### Phase 3: remove what is dead (plan F1c, F2, F3)

- **3.1** `src/poc/` and the two npm scripts that reach it (F1c; already decided).
- **3.2** These leftovers:
  - `scripts/fetch-nadac.ts` and `src/seed/nadac-formulary.ts`;
  - the `docx` and `ts-node` dependencies;
  - in package.json: the description ("on MINA Protocol"), `main` and the keywords, plus the deprecated `start:employer` stub;
  - `src/index.ts`.
- **3.3** The F3 services and their suites; `EnrollmentService.processEnrollment` and `migrateWallet` with the suites that fail on them. Before anything goes, an import-graph check confirms that nothing the network runs imports it.
- **3.4** F2: the MINA vestiges. They include RPC field names, so this goes with the naming pass, or ships with the old names still accepted.
- **3.5** The legacy visualizer, per the owner's answer.

### Phase 4: out of the box

**What a first-time user hits today** (a read-only map of the secured boot, 2026-11-07; file:line in the session record). The walkthrough cannot be finished from the browser alone:

1. **The marketplace dead-ends.** A fresh boot has no plan, and approving an employer's application needs the insurer node's token. That token is only in the env file, and no page says which tab takes it. The README's unsecure quick start hits the same wall: the insurer's token is derived from `admin123`, so `admin123` does not open the insurer dashboard.
2. **The HR Tool needs a terminal and a missing setting.** The launcher does not start it. The activation page's setup steps leave out `HR_TOOL_TEXT_SERVICE`, so an import fails with 503, and the documented syntax is bash-only.
3. **The member's enrollment PIN is only in a file** (`hr-tool-data/text-outbox.jsonl`).
4. **No sample roster CSV or CP 575 PDF ships** (only `tools/demo/lib/assets.mjs` makes them).
5. **The activation page's steps are wrong in places:**
   - the employer token is shown once but needed twice (HR Tool setup and the employer dashboard);
   - the page does not say to create the group first;
   - the HR Tool pre-fills a wrong employer URL (`localhost:4005`);
   - a stale "Download PINs" step remains.
6. **The prescriber's price card quietly shows the list price.** Its token is derived and never shown anywhere.
7. **The HR Tool cannot unlock on a second run or after its 15-minute relock** (409 with two workspaces), and `clean:state` keeps `hr-tool-data/`.
8. **Browser state goes stale when the secrets change:** a saved token or member wallet is not cleared on a 401.
9. **Secrets need care:**
   - `ZKTRIDENT_GOSSIP_SECRET` is also read as hex (the NFC attestation seed);
   - `ZKTRIDENT_PROVER_API_KEY` defaults to `dev-key` even on a secured boot;
   - without a ceremony the insurer seed is random at each boot (A-147's old way).

Items 4.1 to 4.6 are scoped to remove these, worst first.

- **4.1 `npm run setup`.** Checks Node 22 or newer, memory, disk and ports; it reports a port another program holds and never stops it. It then generates the local secrets file: gitignored, readable by the owner only, holding a random operator token, gossip secret and insurer token.
- **4.2 `npm start`, `npm stop`, `npm run status`.** `npm start` does a secured boot from that file and prints every dashboard's URL. `npm stop` stops only this checkout's processes.
- **4.3 One configuration module.** It lists every environment name with its type, default and meaning:
  - a boot warns on an unknown `ZKTRIDENT_` name;
  - `npm run config` prints the settings in force, without secrets;
  - the table in RUNNING.md is generated from it.
  - **What the inventory found** (2026-11-07). The code reads about 110 names: some 70 `ZKTRIDENT_*`, plus `HR_TOOL_*`, `E2E_*`, `ZPK_*`, `NADAC_*`, the generic `PORT` and `NODE_ENV`, and the visualizer's own. Every documented name has a reader.
    - **Values that misparse silently.**
      - Numbers go through `parseInt` with no check, so NaN or a prefix is taken as a value: batch interval, SSE cap, checkpoints kept, pool sizes, partition count and index, member device ports, formulary limit, and every port but the explorer's.
      - Booleans follow five conventions: `'true'`, not `'false'`, not `'0'`, `'1'`, `=== '1'`.
      - One TLS file without the other serves plain HTTP with no warning.
      - An empty `ZKTRIDENT_HOST` binds every interface.
      - CORS and public-host entries are never checked, and peer URLs are taken raw.
      - The gossip secret's hex seed was the worst case: A-149, fixed.
    - **Near-duplicate names.**
      - `MEMBER_DEVICE_PORTS` beside `MEMBER_DEVICES_DIR`.
      - `ZKT_E2E_SERIAL` among the `E2E_*` names.
      - `ZKP_DATA_DIR` beside `ZPK_*`.
      - Three names each for the sequencer's port and its URL.
      - `ZKTRIDENT_ADMIN_TOKEN` is the operator's token in the launcher but a node's own inside the nodes (on the naming list).
    - **Docs that say the wrong thing.**
      - CODEMAP §9 and RUNNING swap `POOL_SIZE` and `PROOF_POOL_SIZE`.
      - They also misstate `RPC_PROXY`'s default, `UNSECURE`'s readers and what `INSURER_URL` does.
      - The launcher's header gives the wrong batch interval and pool minimum.
    - **Unused or unsafe defaults.**
      - `ZKTRIDENT_PROVER_API_KEY` defaults to `dev-key` on a secured boot (A-85's family).
      - `ZKTRIDENT_PROVER_URL` and `ZKTRIDENT_EMPLOYER_URL` are read and never used.
      - `ZKTRIDENT_PRODUCTION_FORMULARY` is documented and read nowhere.
  - **The module, then:**
    - every name with its kind, type, default, readers and meaning;
    - one parser per type, which refuses a bad value at boot, with the reason;
    - a warning for an unknown `ZKTRIDENT_` name;
    - `npm run config`, with secrets masked;
    - RUNNING's table generated from the module, and a suite that fails when the code reads a name the module lacks.
- **4.4 Two profiles.**
  - `local`: one machine, generated secrets, no ceremony.
  - `production`: a ceremony record, TLS and public host names are required, and the boot refuses without them. This also answers the open question of whether a secured boot must have a ceremony: yes in production, no on one machine.
- **4.5 F1b.** Remove the unsecure mode once 4.1 and 4.2 make the secured boot the easy one.
- **4.6 Docs.**
  - The README quick start becomes setup + start.
  - RUNNING.md becomes the operator's guide.
  - ARCHITECTURE, ZKPROOFS, ZKP_OVERVIEW and STARTUP_HELP move under `docs/`, merged or retired where the code map supersedes them.
  - `deliverables/` (an earlier automated assessment, superseded by `docs/AUDIT.md`) moves to `docs/archive/`.
  - The code map follows every slice.

### Phase 5: structure (needs the owner's go-ahead)

- **5.1** Split the five largest files along the seams the code map already names, with no change to any route or RPC.
- **5.2** A small logger: levels, quiet under Jest, no PHI. It replaces `console.*` in src.
- **5.3** One shared logo and dashboard assets.
- **5.4** The naming refactor, from the running list in memory (to become `docs/NAMING.md`):
  - the env prefix `ZKTRIDENT_` becomes `ZPK_`, with the old names still accepted for one release;
  - route prefixes;
  - class names.

### Phase 6: packaging per role (last)

- Installers or containers per role.
- A deployment profile sized to the population.
- Health checks and an operator runbook.
- A machine seal for Linux, since DPAPI is Windows-only.

## Decisions for the owner

1. **The naming refactor:** fold it into this cleanup (5.4), or keep it for later?
2. **The legacy visualizer** (`visualizer/`): delete it, or keep the operator console and serve it from the network like the dashboards?
3. **From before:**
   - the ceremony (proposed: required in production, not on one machine);
   - who holds the keys;
   - pushing the local commits.

## State of work

- **2026-11-07.** Survey done, plan written, phase 1 done.
  - **1.3 Line endings:** committed first (00d6155). `.git-blame-ignore-revs` lists it.
  - **1.2 Typecheck:**
    - src went from 18 errors to 7; all seven are in the EnrollmentService paths phase 3.3 removes;
    - scripts went from 2 to 0;
    - the tests went from about 140 to the same EnrollmentService cluster.
    - Two small behavior changes came with it: the member's message send refuses with 409 when the device has no wallet, and the prescriber's send-prescription answer carries `messageIndex`.
  - **1.1 Tests:**
    - **Lists:** 200 suites in the batch, 11 slow and 8 failing until phase 3 in `scripts/dev/slow-suites.txt`, and `tests/suite-lists.test.ts` holding every suite in one list.
    - **Commands:** `npm test` and `npm run test:all` run them through `scripts/dev/run-tests.ts`.
    - **Revived:** 13 stale suites run again (the 14 reruns all passed). The guard found a 65th suite, `network`, that no batch ran; it passes (slow).
  - **Next:** the A-148 fix, then phase 3.1 to 3.3, then phase 4.1 (`npm run setup` / `npm start`, written and tested, waiting for a live boot).
- **2026-11-07 (later).** Two fixes, phase 3, and a clean typecheck.
  - **A-148 (be45bc1):** partial fills can be proven; the circuit and the table gained the two transitions. Batch 201/201; layer8 proves and verifies both.
  - **A-149 (7929569):** a gossip secret that is not hex no longer seeds a recomputable attestation key; the boot refuses it. Found by the inventory of every environment variable. Batch 202/202.
  - **Phase 3 (50a0691, aafd63c, 8bb7688, 3249ea2):** about 27,000 lines deleted.
    - `src/poc/` (F1c), `src/seed/`, `src/index.ts` and 14 barrels, the dead NADAC seed script and `ts-node`; `docx` stays (`employer-attestation.ts` writes the agreement with it).
    - `EnrollmentService` down to `terminateMember`.
    - Five superseded suites.
    - Every suite now passes: the batch has 205 and the slow list 11, with no failing section.
  - **Typecheck (8c69792):** `npm run typecheck` covers src, scripts and the suites, all at 0 errors. visualizer/engine keeps 2 errors in the legacy console drivers (owner question).
  - **Next:** a live run booted by `npm start -- --fresh`, then commit phase 4.1; then 2.1 (unused imports) and 2.2 (Prettier, width 140); then the rest of phase 4.
