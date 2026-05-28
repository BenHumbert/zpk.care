# Security: status, known limitations, and the path to hardening

This is an honest accounting of where zpk.care stands. The goal of this
document is transparency: nothing here is hidden, and every limitation has a
known, concrete fix.

## TL;DR

- **The cryptographic core is real and complete.** Wallet derivation, the
  device-only enrollment key, zero-knowledge proof generation/verification,
  in-circuit claim settlement, the audit hash-chain, gossip replication, and
  quorum/write-ahead-log durability are all genuinely implemented.
- **The remaining gaps are at the edges** — message transport, browser key
  storage, and RPC access control — not in the proof system.
- **For local, single-machine testing and demonstration (the default mode),
  these gaps don't matter:** the demo data is fictional (no real PHI), nothing
  is exposed beyond `localhost`, and the privacy model can be observed working
  end to end. **They must be closed before any deployment with real data.**

---

## Known limitations and their fixes

### 1. Dashboard messaging uses base64, not real end-to-end encryption

Member/provider messages in the browser dashboards are currently base64-encoded
placeholders, so the sequencer stores payloads it could in principle read.

- **Fix:** X25519 ECDH (shared secret from sender + recipient key pairs) plus
  AES-256-GCM, so the sequencer only ever sees ciphertext + IV + tag. The
  primitives already exist in `src/security/encryption.ts`, and the node-side
  `MessagingService` performs encryption; the browser dashboards need to derive
  shared secrets from wallet-bound X25519 keys and stop using base64.
- **Local impact:** none — messages are fictional and stay on `localhost`.

### 2. The member's enrollment key is stored in plaintext in the browser

The member dashboard keeps the enrollment key (the device secret that gates the
wallet) in plaintext `localStorage`, where browser DevTools or an XSS vector
could read it.

This is the most important edge to harden, and it is squarely an **enrollment-
key storage** problem with several well-understood strategies:

- **Encrypt at rest in the browser** with the Web Crypto API
  (`crypto.subtle`), using a session passphrase or PIN-derived key.
- **Bind the key to hardware** via WebAuthn / FIDO2 or a platform secure
  enclave, so the secret can't be exfiltrated even with script access.
- **Don't persist it at all** — hold it in `sessionStorage` (cleared on tab
  close) and rely on the already-implemented **NFC recovery card** (AES-256-GCM
  + scrypt) to restore the wallet on a new device.
- **External token** — keep the enrollment key on a hardware key / NFC badge,
  which is exactly the model the provider-badge and recovery-card features
  already demonstrate.

- **Local impact:** none — there is no real member, and nothing is reachable
  off the machine.

### 3. RPC access control, proxy auth, and CORS are open by default

These three are intended to be solved together as a deployment ("hardware
provisioning") task, because they share one design — wallet-ownership-based
authorization:

- **~80 sequencer RPC methods are unauthenticated.** Read queries (claims,
  messages, accumulator reconstruction) are public. Fix: role-based access
  control plus wallet-ownership proofs (a caller proves it owns the wallet
  whose data it requests), provisioned with keys at deployment time.
- **The per-node `/rpc` proxy forwards with the node's own admin credentials.**
  Fix: a per-role method allowlist on each node's proxy, so a member node can
  only proxy read-your-own-data methods.
- **CORS defaults to `*`.** Fix: restrict `allowedOrigins` to the known
  dashboard origins in each startup script.

- **Local impact:** none for single-machine use; relevant the moment the
  sequencer is reachable by other machines.

### 4. `:unsecure` demo mode

The `:unsecure` run variants (and the on-demand employer nodes) intentionally
set `ZKTRIDENT_UNSECURE=true` and CORS `*` for frictionless local demos. This
is **local-development only** and must never be used with real data or on a
reachable host.

## What is *not* a concern

- **Demo data is fictional.** The bundled prescribers, pharmacies, medications,
  and members are invented; there are no real NPIs, NDCs, or individuals.
- **The privacy boundary itself is real.** Even today, the network stores only
  hashes and proofs — the gaps above are about *transport and storage at the
  edges*, not about the core design leaking identity.

## Reporting

This is a freely given open-source project (see [MISSION.md](MISSION.md)).
If you intend to deploy it with real data, treat items 1–3 above as required
pre-deployment work, and have the cryptography and key-management design
independently reviewed first.
