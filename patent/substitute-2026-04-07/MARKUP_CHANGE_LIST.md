# COMPLETE CHANGE LIST — Original → Substitute Specification
## For Producing the Marked-Up Copy (37 CFR 1.125(c))

**Instructions:** Open the ORIGINAL `01_SPECIFICATION.docx` in Word with Track Changes ON.
Apply each change below. The result with Track Changes visible = your marked-up copy.
Accept All Changes = your clean copy.

**Rule:** Underline = added text. Strikethrough = deleted text.
Paragraph number changes are EXEMPT from marking per 37 CFR 1.125(c).

---

## BRIEF DESCRIPTION OF THE DRAWINGS (6 changes)

These are the most substantial changes. Each replaces one paragraph with a rewritten version.

---

### Change 1 — Paragraph [0021] (FIG. 8)

**Location:** Brief Description of the Drawings section, 8th entry

**DELETE (strikethrough):**
> ~~FIG. 8 is a sequence diagram illustrating the gossip-based replication protocol with twelve typed event messages including state snapshot, quorum proposal, vote, and certificate messages.~~

**INSERT (underline):**
> <u>FIGS. 8A and 8B are diagrams illustrating the gossip-based replication protocol with twelve typed event messages. FIG. 8A illustrates the gossip message envelope structure, the twelve typed event messages organized in four functional groups, and the epidemic spread mechanism. FIG. 8B illustrates the gossip message deduplication using a bounded set with half-eviction, broadcast versus directed messaging modes, and the trust model distinguishing durability acknowledgments from validity determination.</u>

---

### Change 2 — Paragraph [0023] (FIG. 10)

**Location:** Brief Description of the Drawings section, 10th entry

**DELETE (strikethrough):**
> ~~FIG. 10 is a diagram illustrating the Poseidon hash audit chain with selective event disclosure.~~

**INSERT (underline):**
> <u>FIGS. 10A and 10B are diagrams illustrating the Poseidon hash audit chain with selective event disclosure. FIG. 10A illustrates the hash chain linking mechanism and ten-field event commitment structure. FIG. 10B illustrates the audit chain binding to global state via slot 8 of the ten-field GlobalState commitment and the six-check audit verification suite.</u>

---

### Change 3 — Paragraph [0025] (FIG. 12)

**Location:** Brief Description of the Drawings section, 12th entry

**DELETE (strikethrough):**
> ~~FIG. 12 is a sequence diagram illustrating the multi-leader heartbeat failover protocol with deterministic priority chain.~~

**INSERT (underline):**
> <u>FIGS. 12A and 12B are diagrams illustrating the multi-leader heartbeat failover protocol with deterministic priority chain. FIG. 12A illustrates the heartbeat protocol under normal operation, including the partition topology and heartbeat broadcast mechanism. FIG. 12B illustrates leader failure detection, deterministic failover promotion, split-brain resolution, and client-side transparent failover with automatic partition rediscovery.</u>

---

### Change 4 — Paragraph [0027] (FIG. 14)

**Location:** Brief Description of the Drawings section, 14th entry

**DELETE (strikethrough):**
> ~~FIG. 14 is a block diagram illustrating the portable zero-knowledge credential format and offline verification flow.~~

**INSERT (underline):**
> <u>FIGS. 14A and 14B are block diagrams illustrating the portable zero-knowledge credential format and offline verification flow. FIG. 14A illustrates the credential architecture, including the full zero-knowledge proof credential format and the compact NFC attestation format. FIG. 14B illustrates the NFC tag NDEF encoding for NTAG216, offline verification flows at point-of-care, and delegation credential time-to-live tiers.</u>

---

### Change 5 — Paragraph [0028] (FIG. 15)

**Location:** Brief Description of the Drawings section, 15th entry

**DELETE (strikethrough):**
> ~~FIG. 15 is a sequence diagram illustrating the write-ahead log and quorum durability protocol, including per-partition log append with fsync, quorum proposal broadcast, Ed25519-signed vote collection, quorum certificate assembly, and crash recovery replay.~~

**INSERT (underline):**
> <u>FIGS. 15A and 15B are diagrams illustrating the write-ahead log and quorum durability protocol. FIG. 15A illustrates the per-partition log structure, NDJSON entry format, commit marker lifecycle, and log compaction via atomic write strategy. FIG. 15B illustrates the five-step quorum write protocol with Ed25519-signed vote collection, quorum certificate assembly, state certificate generation at batch boundaries, and crash recovery by replaying uncommitted log entries.</u>

---

### Change 6 — Paragraph [0029] (FIG. 16)

**Location:** Brief Description of the Drawings section, 16th (last) entry

**DELETE (strikethrough):**
> ~~FIG. 16 is a block diagram illustrating the proving pool architecture within a Leviathan Sequencer, showing the split-phase batch construction protocol (prepare, prove, finalize), the worker process pool with isolated WASM contexts, the IPC message protocol, the worker recycling lifecycle for WASM heap reclamation, and the crash detection and automatic recovery mechanism.~~

**INSERT (underline):**
> <u>FIGS. 16A and 16B are block diagrams illustrating the proving pool architecture within a Leviathan Sequencer. FIG. 16A illustrates the pool architecture overview, including the worker process pool with isolated WASM contexts, the IPC message protocol with six message types, and the FIFO job dispatch mechanism. FIG. 16B illustrates the worker lifecycle state machine, the split-phase batch construction integration with the sequencer, the WebAssembly heap reclamation through periodic worker recycling, and the crash detection with automatic recovery mechanism.</u>

---

## SECTION HEADING CHANGES (6 changes)

These are short find-and-replace edits in the section titles.

---

### Change 7 — Section VIII heading

**Location:** Before paragraph [0092]

**CHANGE:** ~~(FIG. 10)~~ → <u>(FIGS. 10A-10B)</u>

Full heading becomes: "VIII. Poseidon Hash Audit Chain <u>(FIGS. 10A-10B)</u>"

---

### Change 8 — Section X heading

**Location:** Before paragraph [0104]

**CHANGE:** ~~(FIG. 8)~~ → <u>(FIGS. 8A-8B)</u>

Full heading becomes: "X. Gossip-Replicated ZK Proof Propagation <u>(FIGS. 8A-8B)</u>"

---

### Change 9 — Section XI heading

**Location:** Before paragraph [0109]

**CHANGE:** ~~(FIG. 12)~~ → <u>(FIGS. 12A-12B)</u>

Full heading becomes: "XI. Multi-Leader Consensus-Free Failover <u>(FIGS. 12A-12B)</u>"

---

### Change 10 — Section XI-A heading

**Location:** Before paragraph [0115]

**CHANGE:** ~~(FIG. 15)~~ → <u>(FIGS. 15A-15B)</u>

Full heading becomes: "XI-A. Write-Ahead Log and Quorum Durability <u>(FIGS. 15A-15B)</u>"

---

### Change 11 — Section XIV heading

**Location:** Before paragraph [0143]

**CHANGE:** ~~(FIG. 14)~~ → <u>(FIGS. 14A-14B)</u>

Full heading becomes: "XIV. Portable ZK Credential with Offline Verification <u>(FIGS. 14A-14B)</u>"

---

### Change 12 — Section XVI heading

**Location:** Before paragraph [0150]

**CHANGE:** ~~(FIG. 16)~~ → <u>(FIGS. 16A-16B)</u>

Full heading becomes: "XVI. Parallel Zero-Knowledge Proving Architecture <u>(FIGS. 16A-16B)</u>"

---

## BODY TEXT — SECTION VIII: Poseidon Hash Audit Chain (5 changes)

---

### Change 13 — Paragraph [0092]

**Location:** First sentence of Section VIII

**CHANGE:** "Referring now to ~~FIG. 10~~ <u>FIGS. 10A and 10B</u>, the system provides..."

---

### Change 14 — Paragraph [0095]

**Location:** End of paragraph [0095], after "...breaks all subsequent chain hashes."

**INSERT (underline) at end of paragraph:**
> <u>The foregoing hash chain linking mechanism and event commitment structure are illustrated in FIG. 10A.</u>

---

### Change 15 — Paragraph [0096]

**Location:** Beginning of paragraph [0096]

**CHANGE:** "~~The~~ <u>As described with reference to FIG. 10A, the</u> hash chain structure inherently supports selective event disclosure..."

---

### Change 16 — Paragraph [0097]

**Location:** Beginning of paragraph [0097]

**CHANGE:** "~~The~~ <u>Referring still to FIG. 10B, the</u> current audit chain hash is committed..."

---

### Change 17 — Paragraph [0098]

**Location:** Beginning of paragraph [0098]

**CHANGE:** "~~A~~ <u>As further illustrated in FIG. 10B, a</u> full audit suite provides six verification checks..."

---

## BODY TEXT — SECTION X: Gossip Replication (3 changes)

---

### Change 18 — Paragraph [0104]

**Location:** First sentence of Section X

**CHANGE:** "Referring now to ~~FIG. 8~~ <u>FIGS. 8A and 8B</u>, the system replicates..."

---

### Change 19 — Paragraph [0105]

**Location:** Beginning of paragraph [0105]

**CHANGE:** "~~All~~ <u>As shown in FIG. 8B, all</u> replication is idempotent..."

---

### Change 20 — Paragraph [0107]

**Location:** Beginning of paragraph [0107]

**CHANGE:** "~~The~~ <u>Referring still to FIG. 8B, the</u> gossip protocol supports both broadcast messaging..."

---

## BODY TEXT — SECTION XI: Multi-Leader Failover (3 changes)

---

### Change 21 — Paragraph [0109]

**Location:** First sentence of Section XI

**CHANGE:** "Referring now to ~~FIG. 12~~ <u>FIG. 12A</u>, the system provides a multi-leader architecture..."

---

### Change 22 — Paragraph [0112]

**Location:** Beginning of paragraph [0112]

**CHANGE:** "~~Split-brain~~ <u>Referring now to FIG. 12B, split-brain</u> resolution is deterministic..."

---

### Change 23 — Paragraph [0114]

**Location:** Beginning of paragraph [0114]

**CHANGE:** "~~On~~ <u>As further illustrated in FIG. 12B, on</u> the client side, each entity node..."

---

## BODY TEXT — SECTION XI-A: WAL and Quorum Durability (5 changes)

---

### Change 24 — Paragraph [0115]

**Location:** First sentence of Section XI-A

**CHANGE:** "Referring now to ~~FIG. 15~~ <u>FIGS. 15A and 15B</u>, the system provides a write-ahead log..."

---

### Change 25 — Paragraph [0116]

**Location:** Beginning of [0116], after "**Write-Ahead Log.**"

**CHANGE:** "**Write-Ahead Log.** ~~Each~~ <u>Referring to FIG. 15A, each</u> sequencer node maintains..."

---

### Change 26 — Paragraph [0118]

**Location:** Beginning of [0118], after "**Crash Recovery.**"

**CHANGE:** "**Crash Recovery.** ~~Upon~~ <u>Referring now to FIG. 15B, upon</u> restart after a crash..."

---

### Change 27 — Paragraph [0120]

**Location:** Beginning of [0120], after "**Quorum Write Protocol.**"

**CHANGE:** "**Quorum Write Protocol.** ~~The~~ <u>Referring still to FIG. 15B, the</u> quorum write protocol ensures..."

---

### Change 28 — Paragraph [0134]

**Location:** Beginning of [0134], after "**Checkpoint Atomicity.**"

**CHANGE:** "**Checkpoint Atomicity.** ~~Checkpoint~~ <u>Referring again to FIG. 15A, checkpoint</u> files (JSON snapshots..."

---

## BODY TEXT — SECTION XIV: Portable Credential (4 changes)

---

### Change 29 — Paragraph [0143]

**Location:** First sentence of Section XIV

**CHANGE:** "Referring now to ~~FIG. 14~~ <u>FIGS. 14A and 14B</u>, the system provides a self-contained JSON credential format..."

---

### Change 30 — Paragraph [0145]

**Location:** Mid-paragraph, after "a compact credential attestation format is provided as an alternative:"

**INSERT (underline) after "alternative:":**
> "...is provided as an alternative: <u>as illustrated in FIG. 14B,</u> the sequencer verifies..."

---

### Change 31 — Paragraph [0146]

**Location:** Beginning of paragraph [0146]

**CHANGE:** "~~Offline~~ <u>As shown in FIG. 14B, offline</u> verification at point-of-care..."

---

### Change 32 — Paragraph [0147]

**Location:** Beginning of paragraph [0147]

**CHANGE:** "~~For~~ <u>Referring still to FIG. 14B, for</u> delegation credentials..."

---

## BODY TEXT — SECTION XVI: Proving Pool (5 changes)

---

### Change 33 — Paragraph [0150]

**Location:** First sentence of Section XVI

**CHANGE:** "Referring now to ~~FIG. 16~~ <u>FIGS. 16A and 16B</u>, the system addresses a fundamental resource constraint..."

---

### Change 34 — Paragraph [0152]

**Location:** First sentence of [0152]

**CHANGE:** "The proving pool 1600 ~~(FIG. 16)~~ <u>(FIG. 16A)</u> solves this resource constraint..."

---

### Change 35 — Paragraph [0159]

**Location:** End of paragraph [0159], after "...any ZkProgram proving or verification method."

**INSERT (underline) at end of paragraph:**
> <u>The split-phase protocol integration with the sequencer process is further illustrated in FIG. 16B.</u>

---

### Change 36 — Paragraph [0165]

**Location:** First sentence of [0165]

**CHANGE:** "The proving pool implements a worker recycling mechanism 1630 ~~(FIG. 16)~~ <u>(FIG. 16B)</u> that proactively terminates..."

---

### Change 37 — Paragraph [0169]

**Location:** Beginning of paragraph [0169]

**CHANGE:** "~~The~~ <u>Referring to FIG. 16B, the</u> coordinator monitors each worker process..."

---

## SUMMARY

| Section | Changes | Type |
|---|---|---|
| Brief Description [0021]-[0029] | 6 | Full paragraph rewrites (strikethrough old, underline new) |
| Section headings | 6 | Short find-replace in titles |
| Section VIII body (FIG. 10) | 5 | Insert "FIG. 10A/10B" references |
| Section X body (FIG. 8) | 3 | Insert "FIG. 8A/8B" references |
| Section XI body (FIG. 12) | 3 | Insert "FIG. 12A/12B" references |
| Section XI-A body (FIG. 15) | 5 | Insert "FIG. 15A/15B" references |
| Section XIV body (FIG. 14) | 4 | Insert "FIG. 14A/14B" references |
| Section XVI body (FIG. 16) | 5 | Insert "FIG. 16A/16B" references |
| **TOTAL** | **37** | |

**NO changes to:** Claims (1-19), Abstract, paragraphs [0001]-[0020], [0022], [0024], [0026],
or any body paragraph not listed above.
