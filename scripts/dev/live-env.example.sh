# The environment for a secured local network and the e2e harness. Copy to scripts/dev/live-env.sh
# (ignored by git), put fresh random values in the three secrets, then `source` it before booting
# and before running the harness, so both sides hold the same operator token.
#
#   openssl rand -hex 32        # ZKTRIDENT_ADMIN_TOKEN, ZKTRIDENT_GOSSIP_SECRET
#   openssl rand -base64 24     # ZKTRIDENT_INSURER_ADMIN_TOKEN
#
# Nothing here is a production value. A production network creates its secrets at deployment.
export ZKTRIDENT_ADMIN_TOKEN=replace-with-64-hex
export ZKTRIDENT_GOSSIP_SECRET=replace-with-64-hex
export ZKTRIDENT_INSURER_ADMIN_TOKEN=replace-with-a-random-string
export ZKTRIDENT_FORMULARY_LIMIT=100   # 100 drugs instead of 32,000: a boot in minutes, not an hour
export ZKTRIDENT_POOL_SIZE=2           # batch-proving workers; each takes ~800 MB
export ZKTRIDENT_PROOF_POOL_SIZE=4     # the engine's proving workers
export ZKTRIDENT_OPEN_BROWSERS=0
unset ZKTRIDENT_UNSECURE               # secured mode: every gate armed
