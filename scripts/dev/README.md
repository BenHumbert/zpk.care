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

## The multi-member, multi-employer run

The launcher boots one member device. For the four-member harness, boot three more, each a keyed node
with its own state directory, then run `run-multi`:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/kill-zpk.ps1
npm run clean:state && rm -rf e2e-devices
source scripts/dev/live-env.sh
ZKTRIDENT_MEMBER_DEVICE_PORTS=4011,4012,4013 ZKTRIDENT_MEMBER_DEVICES_DIR=./e2e-devices \
  npx tsx src/nodes/start-leviathan.ts > /tmp/boot.log 2>&1 &
# when :3030/health and :4013/health answer:
npx tsx scripts/e2e-verify/run-multi.ts ./e2e-multi-out ./e2e-devices > /tmp/multi.log 2>&1
```

`ZKT_E2E_SERIAL=1` enrolls the members one at a time; the default, concurrent, is the acceptance run
for the proving lease (D7 interim, finding A-33): a device's proof commits to the ledger's exact roots,
so without the lease any transition landing during its 25 to 45 second proving window invalidated it
and one of three concurrent registrations starved. `ZKTRIDENT_PROVING_LEASE_MS` (default 120000) is how
long one prover may hold a partition's witnesses. `E2E_RESUME_DIR=<a previous out dir>` skips enrollment
and continues from the members that run registered, against the network that is still up.

Rules that have held since session 1:

- Never run the harness while Jest runs; they contend for the CPU and both time out.
- The harness output directory (`e2e-out/`) holds device PINs and tokens and is ignored by git.
- Compare failures by name against the previous run; a run is accepted when the set is identical
  or smaller and every new check passes.
- The regression batch is the suite list in `scripts/dev/regression-suites.txt`; a new acceptance
  suite is added to it with its commit. Run it with the harness stopped:
  `npx jest $(sed 's/\r$//' scripts/dev/regression-suites.txt | tr '\n' ' ')` (the sed strips the carriage returns a Windows checkout adds to the list). `tests/l2-network.test.ts`
  is outside it, because it is slow, and must be run by hand when the sequencer's gates change.
