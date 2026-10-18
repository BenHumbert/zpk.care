# A live run from a clean secured boot

The hardening program verifies every commit against a network booted from genesis in secured mode,
then runs the full harness against it. This is the sequence, in Git Bash on the development machine.

```bash
# 0. once: the environment (secrets are generated, never committed)
cp scripts/dev/live-env.example.sh scripts/dev/live-env.sh   # then edit the three secrets

# 1. stop whatever is running and clear the state
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/kill-zpk.ps1
npm run clean:state

# 2. boot the whole network from genesis (sequencer :3030, replicas :3031/:3032, nodes :4001-:4004,
#    prover :4040, explorer :8000, employer tenants and HR Tools on ephemeral ports)
source scripts/dev/live-env.sh && npx tsx src/nodes/start-leviathan.ts > /tmp/boot.log 2>&1 &

# 3. when :3030/health answers, run the harness (it waits for every circuit to compile)
source scripts/dev/live-env.sh && npx tsx scripts/e2e-verify/run.ts ./e2e-out > /tmp/e2e.log 2>&1

# 4. the failing checks by name, to compare with the previous run
grep -E "^[[:space:]]+FAIL  " /tmp/e2e.log | sed 's/^[[:space:]]*FAIL  //; s/  expected=.*$//' | sort -u
```

Rules that have held since session 1:

- Never run the harness while Jest runs; they contend for the CPU and both time out.
- The harness output directory (`e2e-out/`) holds device PINs and tokens and is ignored by git.
- Compare failures by name against the previous run; a run is accepted when the set is identical
  or smaller and every new check passes.
- The regression batch is the suite list in the plan's state of work; `tests/l2-network.test.ts`
  is outside it and must be run by hand when the sequencer's gates change.
