---
name: Formulary pipeline TODO
description: Insurer needs ability to push Medispan + NADAC drug updates directly to Leviathan for live formulary management
type: project
---

Insurer node needs the ability to update and insert Medispan and NADAC drug status data directly to the Leviathan sequencer, so the formulary stays clean and up to date in production.

**Why:** Currently formulary data is loaded from static JSON files at startup. In production, drug pricing (NADAC) and clinical data (Medispan GPI, therapeutic class, drug interactions) change frequently. The insurer — as attestation authority — should be the entity that pushes formulary updates to the network.

**How to apply:** When implementing, add RPC methods (e.g., `l2_updateFormularyEntry`, `l2_batchUpdateFormulary`) gated by admin auth. Insurer node should have a route to upload CSV/JSON drug data, validate it, and push to the Leviathan's FormularyService + ZK FormularyRegistry. Gossip replication ensures all nodes receive updates. Consider versioning (formulary generation number) for consistency.
