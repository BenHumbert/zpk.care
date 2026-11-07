# Running zpk.care

How to install, run, and troubleshoot the system on a single machine.

---

## Prerequisites

- **Node.js 20 or newer.** The project is ES-modules + TypeScript run directly
  through [`tsx`](https://github.com/privatenumber/tsx) — there is **no build
  step** required to run it.
- **~32 GB RAM recommended.** The system compiles real zero-knowledge circuits
  and runs a pool of prover worker processes. It will run with less, but with
  fewer workers and slower batching.
- A modern browser for the dashboards.
- Works on macOS, Linux, and Windows.

## Install

```bash
npm install
```

## Run (the one command)

```bash
npm run start:leviathan:clean:100:unsecure
```

This is the recommended way to start everything fresh. It:

1. **`clean`** — kills processes on the dev ports and deletes local chain state
   so you start from genesis.
2. Starts the **Leviathan sequencer** + two replicas.
3. Compiles the zero-knowledge programs and starts the **prover pool**.
4. Boots the **insurer** node first (it credentials providers), waits for it to
   report `ready`, then boots **member / prescriber / pharmacy** nodes and the
   **explorer**.
5. Serves every dashboard.
6. **`100`** — limits the demo formulary to ~100 drugs so the first boot is
   quick.

> **First boot takes a few minutes** because real circuits are compiled. Watch
> the logs until each node prints that it has reached `ready`.

### Useful variants

| Command | What it changes |
|---|---|
| `npm run start:leviathan` | Start without cleaning (keeps existing state) |
| `npm run start:leviathan:clean` | Clean + start with the full formulary |
| `npm run start:leviathan:clean:100:unsecure` | Demo mode with relaxed local-dev security (CORS `*`, no admin auth). **Local use only.** |
| `npm run start:leviathan:warm:100:unsecure` | Same, but keeps existing state (no clean) |

### Other scripts

| Command | Purpose |
|---|---|
| `npm test` | Run the regression batch, the suites in `scripts/dev/regression-suites.txt`, one at a time (about ten minutes); `npm test -- tests/a.test.ts` runs only the suites named |
| `npm run test:all` | Run every suite, the slow ones that compile and prove circuits (`scripts/dev/slow-suites.txt`) included |
| `npm run start:explorer` | Run just the block explorer (port 8000) |
| `npm run fetch:nadac` | Fetch fresh NADAC drug-pricing data |
| `npm run bootstrap` | Scripted full-system bootstrap |
| `npm run start:hr-tool` | Run the HR Tool, on the employer's own machine (since A7 nothing spawns it); set `HR_TOOL_TEXT_SERVICE` or it issues no invite (A-109). `npm run hr-tool` is its command line, whose import refuses (A-141) |

> Individual `start:member` / `start:prescriber` / `start:pharmacy` /
> `start:insurer` scripts exist for running one node against an already-running
> sequencer. Employer nodes are **not** started manually — they are spawned on
> demand when an employer activates in the marketplace.

## Ports

| Port | Service |
|---|---|
| 3030 | Leviathan sequencer (JSON-RPC + SSE) |
| 3031, 3032 | Sequencer replicas |
| 4001 | Member portal |
| 4002 | Prescriber node |
| 4003 | Pharmacy node |
| 4004 | Insurer node + employer marketplace (`/marketplace/`) |
| 4040 | Proof delegate (prover) |
| 8000 | Block explorer |
| ephemeral | Employer nodes (assigned at activation) |

## A typical first walkthrough

1. Open the **marketplace** at `http://localhost:4004/marketplace/`, apply as an
   employer, sign the agreement, and activate. Note the HR Tool URL it returns.
2. Start the **HR Tool** with a text service: `HR_TOOL_TEXT_SERVICE=outbox npm run start:hr-tool` for a
   demonstration, which writes each text to `hr-tool-data/text-outbox.jsonl`. Import a small employee CSV with a
   `mobile` column. The tool texts each employee's PIN and shows HR none; send each enrollment code yourself.
3. Open the **member portal** (`:4001`), enroll with the code and the PIN from the text.
4. Write a script in the **prescriber** dashboard (`:4002`), fill it in the
   **pharmacy** dashboard (`:4003`).
5. Watch it all land in the **explorer** (`:8000`) as batched, proven claims.

## Environment variables

Most runs need none — the npm scripts set sensible defaults. The notable ones:

| Variable | Meaning |
|---|---|
| `ZKTRIDENT_FORMULARY_LIMIT` | Cap the demo formulary size (e.g. `100`) for fast boots |
| `ZKTRIDENT_PROOF_POOL_SIZE` | Number of batch-proving worker processes |
| `ZKTRIDENT_POOL_SIZE` | Entity proof-pool size |
| `ZKTRIDENT_UNSECURE` | `true` relaxes auth/CORS for local demos only |
| `ZKTRIDENT_PORT` / `ZKTRIDENT_HOST` | Bind address for a node |
| `HR_TOOL_TEXT_SERVICE` | How the HR Tool texts each enrollment PIN straight to its employee (A-109): `outbox` writes each text as a JSON line to `HR_TOOL_TEXT_OUTBOX`, for a demonstration; unset, the HR Tool issues no invite. A real SMS provider plugs in here once the operator has an account |
| `HR_TOOL_TEXT_OUTBOX` | The outbox file (default `<HR_TOOL_DATA_DIR>/text-outbox.jsonl`); it holds PINs, so keep it off shared drives |
| `HR_TOOL_NOTICE_INTERVAL_MS` | How often the unlocked HR Tool checks what became of its invites and texts the employee when one is used or locked (A-109), in ms (default `60000`; `0` turns the timer off). Locked, it holds no number to text, so the notices due go out at the next unlock |
| `ZKTRIDENT_EXPLORER_PORT` | The explorer's port (default `8000`), for a machine where another program holds 8000. The launcher, the explorer, the CORS list and the verification scripts all read it; anything but a port number stops the boot |
| `ZKTRIDENT_PUBLIC_HOSTS` | Host names a listener answers beyond loopback and its bind address, comma-separated `name` or `name:port` (a proxy's or a peer's); any other Host gets 421 |
| `ZKTRIDENT_TRUSTED_PROXIES` | The reverse proxies in front of a node, comma-separated exact IP addresses (IPv4 or IPv6). A node reads `X-Forwarded-For` only from these, to count each caller as the client the proxy names; an entry that is not an IP address stops the node at boot. See [Behind a reverse proxy](#behind-a-reverse-proxy) |
| `ZKTRIDENT_SEQUENCER_URL` | Where a node finds the sequencer |
| `ZKTRIDENT_CORS_ORIGINS` | Allowed browser origins (default `*` in dev) |
| `ZKTRIDENT_ADMIN_TOKEN` | Bearer token for admin endpoints |

### Behind a reverse proxy

A node bound to loopback behind a reverse proxy or TLS terminator on the same host
sees every request arrive from the proxy's address. The insurer and employer nodes
limit what each caller may do by its address: credentialing applications (10 open
and 20 an hour per source), card recovery (30 requests a minute), the plans an
employer can add, and the employer's validate oracle. A proxy the node does not
list is **one source for everyone behind it**, so one client could spend every
caller's allowance and have, say, every member's card recovery refused. Name the
proxy's address in `ZKTRIDENT_TRUSTED_PROXIES` beside its public name in
`ZKTRIDENT_PUBLIC_HOSTS`, and the node counts each request as the client the proxy
names in `X-Forwarded-For`. A node bound to loopback that answers a public name
with no trusted proxy says so when it starts.

- `X-Forwarded-For` is read only from a listed address. From any other address it
  is ignored, so a client cannot choose its own source by sending one.
- It is read from the right: the address the nearest listed proxy appended, past
  any other listed proxies. Entries further left are the client's own and are not
  read. An entry that is not a bare IP address (a port, a name, `unknown`) stops
  the walk, and the request counts as that proxy.
- List exact addresses, not names, ranges or ports. Trusting `127.0.0.1` trusts
  every process on the host to say who it forwards for, so list it only when a
  proxy on this host is the way in.

nginx in front of the insurer node on the same host:

```nginx
server {
    listen 443 ssl;
    server_name insurer.example.com;
    # ssl_certificate and ssl_certificate_key as usual

    location / {
        proxy_pass http://127.0.0.1:4004;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;   # the dashboards' event stream
    }
}
```

```bash
ZKTRIDENT_PUBLIC_HOSTS=insurer.example.com ZKTRIDENT_TRUSTED_PROXIES=127.0.0.1 npm run start:insurer
```

`$proxy_add_x_forwarded_for` appends the address nginx took the request from, so
the node counts that client, whatever the client itself put in the header.

## Where local data lives

Local state is written to (and ignored by git):

- `l2-data/`, `.l2-checkpoints/` — sequencer chain state & checkpoints
- `nautilus-data/` — per-node local state
- `hr-tool-data/` — the HR Tool's **encrypted employee correlation tables**
  (local PII — never commit this)

`clean:state` (run automatically by the `:clean` scripts) deletes the chain
state and checkpoints so you can start fresh.

## Troubleshooting

- **First boot seems stuck for minutes.** Expected — circuits are compiling.
  Watch for each node logging `ready`.
- **Port already in use.** Run `npm run kill:ports`, or use a `:clean` script
  which does it for you. It stops only this checkout's own processes. A port
  another program holds is named, with its process ID, and left alone: stop that
  program yourself, or for port 8000 set `ZKTRIDENT_EXPLORER_PORT` to a free port.
- **Memory grows during very long runs.** o1js's proving engine grows its WASM
  heap over time and has no compaction API; a long-running single-process demo
  can eventually slow down. Restart with a `:clean` script. (In a real
  deployment each participant proves on their own device, so this doesn't
  arise.)
- **Windows + tests:** use `npm test` or `npm run test:all` (scripts/dev/run-tests.ts runs Jest
  with `--runInBand --forceExit`) rather than invoking the jest binary directly.
