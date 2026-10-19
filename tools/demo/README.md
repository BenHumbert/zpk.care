# zpk.care walkthrough video tooling

Tooling for a recorded, narrated, single-screen walkthrough of one pharmacy claim, end to end: the insurer
publishes a plan, HR picks it and signs up, the member enrolls on her phone, her doctor prescribes, the pharmacy
fills, and she picks up. AI actors click and type on every real dashboard; the film shows one screen at a time; a
narrator explains what happens underneath; a whiteboard writes the equations stroke by stroke; a director-drawn status
card covers background steps that no product screen shows. Every person is fictional.

It is adapted from the SwapStreet demo (`Z:\ByteStreetCustomBeta\nft-swap-platform\testnet\site-e2e\demo-bid.mjs` and
its `lib/stage.mjs`, `lib/narrate.mjs`, `lib/board.mjs`, `voice-audition.mjs`, `voice-check.mjs`), which it only reads.
Nothing here is part of the product build: this folder has its own `package.json`, `node_modules` and `.gitignore`.

## Files

| File | What it does |
|---|---|
| `director.mjs` | The take. One headless Chromium, one browser context per person (insurer analyst, HR admin, member phone, prescriber, pharmacist, network view) plus the director's offline context (whiteboard, status card). Runs the 26 scenes in the order the UI enforces, records every page, logs the camera cuts, then builds the film. `--rehearsal`, `--stop-after <scene>`, `--voices role=engine:voice,...`, `--plan`, `--post-only <dir>`, `--no-post`, `--hr-port`, `--headed`, `--out`. |
| `whiteboard-preview.mjs` | The whiteboard alone, offline (no network, no servers): writes a few equation cards, or the script's board scenes (`--scenes board-wallet,...`), records it, saves PNG frames mid-write and at the end, and builds `preview.mp4` through the same post step, including one sped-up cut to the status card. `--texts` prints every card's glyph text for authoring `{ find }` targets. |
| `voice-audition.mjs` | Sample lines in several candidate voices per person (Kokoro, Chatterbox, Turbo, Maya1, Orpheus) and a listening page. GPU. |
| `voice-check.mjs` | Renders every line of the script in the chosen voices into the voice cache (exactly the director's parameters, so the take reuses the clips byte for byte) and checks them with Whisper (`py/check_asr.py`); saves word times next to each clip. GPU and CPU. |
| `py/check_asr.py` | faster-whisper listen-back (copied from `.tools/tts/check_asr.py`): zpk spoken forms, word times written to `<clip>.words.json`. |
| `lib/stage.mjs` | The on-screen layer: eased cursor, click ripples, captions, badge, the "behind this click" lower-third card; slow, visible clicks and typing on staged pages; fast mode for rehearsals; `check`/`uncheck`/`setInputFiles` glide too; `fill(v, { paste: true })`; `fillSecret()` (secrets go in by `page.evaluate` into masked fields, never as key presses); `scrollWithin()`; `uploadVia()` (clicks an upload button and answers the file chooser). |
| `lib/narrate.mjs` | Voices: engine workers under `ZPK_DEMO_TOOLS\tts`, the talking stick (one speaker at a time), the voice cache, `toSpeech()` (NADAC, NDC, Poseidon, zk, OOP, PCP, Merkle, wallet ID, o1js, Ed25519, money, NDC/EIN digits, CCYYMMDD dates), `MAYA_VOICES` (narrator, hr, analyst, member, prescriber, pharmacist), `say(..., { during })` for board strokes, `cacheOnly` (a take never synthesises), silent rehearsals, Piper resampled to 24 kHz, `mixTrack()`, `srt()`. |
| `lib/whiteboard.mjs`, `whiteboard/whiteboard.html` | The board.mjs pattern: an offline page fed by `page.evaluate`. MathJax 3.2.2 `es5/tex-svg-full.js` from `node_modules` (`fontCache: 'none'`); each glyph outline traced with `stroke-dasharray`/`stroke-dashoffset` and then filled, fraction bars grown from the left, a marker tip following the stroke; off-white board, faint grid and smudges, marker colours; Comic Neue for handwriting. API: `prepare`, `writeEquation(latex, { durationMs, color, at, size })`, `annotate`, `value`, `circle`, `underline`, `box`, `arrow`, `check`, `erase`, `clear` (eraser sweep, faint ghost), `setTitle`, `pen`, `idle()` (wait until the pen is done). Targets: `'eq-2b'`, `{ eq, find: 'f5' }`, `{ eq, line: 2 }`, `{ eq, cssId }`, `{ x, y, w, h }`. |
| `whiteboard/fonts/` | Comic Neue Regular 2.003 and its SIL OFL 1.1 licence (`ComicNeue-OFL.txt`), embedded as a data: URL. |
| `lib/board-beats.mjs` | Runs a line's board actions at their cues (start, a fraction of the clip, a word, the end) while the line plays. |
| `lib/status-card.mjs` | The director-drawn status page, labelled on screen: "No product screen shows this. Drawn by the video's director from the network's own answers." Each row names the read it came from. |
| `lib/camera.mjs` | The cut list: `cut(key)` waits for silence, brings a page to the front and logs the moment; `speedWhile(fn, { factor })` marks a silent wait to be sped up (the next spoken line ends it). |
| `lib/post.mjs` | ffmpeg: one piece per segment of the cut list (`-ss` into that page's webm, `setpts` for speed, 30 fps, 1920x1080, a "sped up Nx" badge), the concat demuxer, voices moved onto the film's timeline, one mixed track, loudnorm AAC, chapters per act, `+faststart`; writes `narration.srt`, `scenes.json`, `player.html`. |
| `lib/reads.mjs` | Read-only network reads with the operator token passed in: `/interactive/state` (field allowlist: no name, no employee ID), `l2_getReceiptsByWallet`, `l2_getWalletState`, `l2_getStatus`, the member's open `/onboarding/status` phase, `/events` in Node. Refuses any non-read RPC method; never logs bodies or the token. |
| `lib/sniff.mjs` | Learns from dashboard responses (allowlisted paths and fields: application ID, activation credentials, the HR import's codes and PINs, the derived wallet ID, the attestation); never touches request bodies. |
| `lib/masks.mjs` | Per-dashboard styles: token/PIN inputs masked, the activation token, HR codes/PINs and the recovery cards redacted, identity fields blurred; plus the page zoom (below). |
| `lib/assets.mjs` | Per-take files made from the cast: the fictional roster CSV and a one-page sample EIN letter PDF (labelled fictional; it imitates no government notice). |
| `lib/claim-script.mjs` | The cast and the script's shape: `PEOPLE`, `ACTS`, `SCENES` (order and camera), `BEATS` (what the director calls), `castOf()` (every number from the published plan; the fill priced with the fill circuit's own arithmetic), `storyLines()` (**placeholder lines**; the final script drops in with the same shape), `allLines()`. |
| `lib/equations.mjs` | All 32 whiteboard cards from the math preparation, verbatim (LaTeX, terms, plain words, who computes, who sees, `file:line` source), generated, never retyped. `eq('2b')`. |
| `lib/args.mjs`, `lib/browser.mjs` | Argument parsing; `chromiumPath()` (pinned chromium-1200). |

## Environment (Git Bash, every shell)

```bash
export ZPK_DEMO_TOOLS=Z:/ByteStreetCustomBeta/.tools        # ffmpeg, TTS workers, Whisper, Piper (read only)
export PW_CHROMIUM_PATH=C:/Users/BenHu/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe
export HF_HUB_OFFLINE=1                                      # Chatterbox Turbo must not reach the network
```

| Variable | Use |
|---|---|
| `ZPK_DEMO_TOOLS` | The tools folder (default `Z:/ByteStreetCustomBeta/.tools`; `SWAPSTREET_TOOLS` also works). |
| `PW_CHROMIUM_PATH` | The browser (default: chromium-1200 above). Never run `npx playwright install` (it would download chromium-1243). |
| `HF_HUB_OFFLINE` | Set to 1 (the voice workers default to 1 when it is unset). |
| `ZPK_DEMO_OUT` | Output root (default `tools/demo/demo-out`, git-ignored). |
| `ZKTRIDENT_ADMIN_TOKEN` | The operator token the network booted with (from `scripts/dev/live-env.sh`): the director's read-only reads and the Leviathan dashboard's request header. |
| `ZKTRIDENT_INSURER_ADMIN_TOKEN` | The insurer dashboard token, seeded through `storageState` (derived from the operator token as the launcher does when unset). |
| `ZPK_DEMO_SEQ_URL`, `ZPK_DEMO_INSURER_URL`, `ZPK_DEMO_MEMBER_URL`, `ZPK_DEMO_PRESCRIBER_URL`, `ZPK_DEMO_PHARMACY_URL` | Overrides; defaults `http://127.0.0.1:3030`, `:4004`, `:4001`, `:4002`, `:4003`. |

## Commands

```bash
cd /z/zpk_care/tools/demo

# install (Playwright from the npm cache, MathJax 3.2.2 the one download, no browser download)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefer-offline --no-audit --no-fund

# check the script and print the scene plan (offline)
node director.mjs --plan

# the whiteboard alone, offline (no network, no servers): demo-out/<stamp>-whiteboard/preview.mp4 + PNG frames
node whiteboard-preview.mjs
node whiteboard-preview.mjs --scenes board-wallet,board-ledger          # the script's board beats
node whiteboard-preview.mjs --scenes board-wallet --voices narrator=maya:narrator   # with checked, cached voices
```

Voices (the only steps that use the GPU; run them when no proofs are running):

```bash
node voice-audition.mjs --engines kokoro,maya,orpheus,turbo && node voice-audition.mjs --page
node voice-check.mjs --voices narrator=maya:narrator,hr=maya:hr,analyst=maya:analyst,member=turbo:af_heart,prescriber=maya:prescriber,pharmacist=orpheus:dan
# rework any line below 0.85; the take reuses these clips byte for byte
```

Boot from genesis (from the repo root; never while Jest or the harness is running; `scripts/dev/live-env.sh` is made
once from `live-env.example.sh` with fresh secrets, an explicit `ZKTRIDENT_INSURER_ADMIN_TOKEN`, no
`ZKTRIDENT_MEMBER_PIN`, and `ZKTRIDENT_FORMULARY_LIMIT=100`):

```bash
cd /z/zpk_care && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/kill-zpk.ps1 && npm run clean:state \
  && (source scripts/dev/live-env.sh && npx tsx src/nodes/start-leviathan.ts > /tmp/boot.log 2>&1 &)
```

Rehearsal (no voices, fast stage, still recorded, so framing and proof times under recording load can be checked):

```bash
cd /z/zpk_care/tools/demo && source ../../scripts/dev/live-env.sh && node director.mjs --rehearsal --stop-after pickup
```

Full take (after a fresh genesis boot, and after voice-check):

```bash
cd /z/zpk_care/tools/demo && source ../../scripts/dev/live-env.sh && node director.mjs --voices narrator=maya:narrator,hr=maya:hr,analyst=maya:analyst,member=turbo:af_heart,prescriber=maya:prescriber,pharmacist=orpheus:dan
```

Rebuild a film from a take's raw recordings (to tune the edit without re-recording):

```bash
node director.mjs --post-only demo-out/<stamp>
```

Output: `demo-out/<stamp>/` holds `walkthrough.mp4`, `narration.srt`, `scenes.json`, `player.html`, `take.json` (cuts,
speed-ups, scenes, lines, timings; no secrets), `director.log`, `raw/` (one webm per page), `assets/` (the roster CSV
and the sample letter) and `hr-tool-data/`. A failed take needs a new genesis boot.

## How a take runs

1. The script is checked (speakers, board actions, equation cards); every line is rendered if missing, then the voice
   engines are stopped so the proofs get the CPU.
2. The director waits until the engine has compiled every circuit, refuses to start unless the member device is in
   phase `awaiting_token`, and starts the HR Tool the way the harness does (`--import tsx src/tools/hr-tool-server.ts`,
   `PORT`, `HR_TOOL_DATA_DIR` under the take folder).
3. Pre-roll (cut from the film): the whiteboard typesets all 32 cards; a second plan is published through the
   insurer's form so the marketplace offers a choice; the first screens open.
4. T0. The scenes run in order; pages open one scene ahead and close after their last scene; waits with nobody
   speaking are sped up in the film. A 60-minute watchdog ends a stuck take.
5. T1. Contexts close (videos finish), `take.json` is written, `lib/post.mjs` builds the film.

Every page is a 1920x1080 viewport drawn at `html { zoom: 1.5 }`: it lays out as on a 1280x720 screen (as the
dashboards and the tooling spec intend) and records crisp at 1080p. A 1280x720 viewport at `deviceScaleFactor: 1.5`
does not work: Chrome's screencast ignores the emulated scale, and Playwright pads the 1280x720 frame into the
1920x1080 video.

## Secrets stay off camera

- The insurer token arrives through `storageState`, the operator token as a request header (`context.route`); the
  tenant token, the enrollment code, the SMS PIN, the device and recovery PINs and the HR passphrase go into masked
  fields through `page.evaluate` (`stage.fillSecret`). Nothing secret is typed as key presses.
- The marketplace's activation code is read from its native alert by a dialog handler (headless recording does not
  draw alerts) and kept in memory.
- The activation screen's admin token, the HR Tool's codes and PINs and the phone's two recovery cards are redacted
  (their text is not drawn); identity fields on the phone are blurred.
- The director reads responses only, from allowlisted paths and fields, never request bodies (derive-wallet's request
  carries the identity fields), and never writes through the API. Secrets live in memory only: never logged, never in
  `take.json`.

## Before the first real take

The screen audit (`prepare:screens`) lists product fixes the story depends on. The director is written against the UI
as it is, and says where it waits on these:

1. **Blocker:** `/nfc/scan` must pass the verified attestation into its reads (`src/nodes/routes/pharmacy-routes.ts`);
   today Verify Member answers 500 and Dispense stays disabled (scene `verify-dispense` fails there).
2. The dispense price (the pharmacy page sends an ingredient cost of 0), the plan's copay binding, the member's plan
   limits on the dashboard, the attestation card's field names, the onboarding compile budget, the wrong labels.
3. Fictional providers (`prescribers.json`, `pharmacies.json`); the director finds the doctor and the pharmacy by
   the names in `castOf()` (Fallowmere, Kettleby).
4. Gating `/interactive/console` and `/viz/history`.

Selectors marked `TODO(selector)` in `director.mjs` depend on those fixes or on data that is not in the repository yet:
the insurer's Review PDF link (401 today, and headless Chromium has no PDF viewer), the doctor's provider card and the
pharmacy option (fictional providers), the drug option label (formulary limit), the receipt-to-batch index on the
Leviathan dashboard, and on-screen labels that are wrong until fixed (activation banner, completion text, prescriber
badge, attestation card, claim card, spend hero). Confirm them in the first rehearsal.
