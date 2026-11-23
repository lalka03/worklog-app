"""Synthetic HTTP bridge for JS-to-Python cross-stack regression tests only.

In-memory FakeStore, no ydb connection, no filesystem writes and no cloud calls.
The bridge accepts line-delimited JSON on stdin and returns one response per line.
"""
import json
import sys
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "tests"))

from backend import index
from backend.security import hash_password
from backend.service import Service
from backend.store import Account
from fake_store import FakeStore

NOW = 1795430000
EMAIL = "crossstack-employee@example.test"
PASSWORD = "synthetic crossstack password"
UID = str(UUID(int=20261123, version=4))
SECOND_EMAIL = "crossstack-second@example.test"
SECOND_UID = str(UUID(int=20261124, version=4))

store = FakeStore()
service = Service(store, clock=lambda: NOW)
store.run_write(lambda tx: (
    tx.insert_account(Account(UID, EMAIL, hash_password(PASSWORD), "employee", True, NOW, 0)),
    tx.insert_account(Account(SECOND_UID, SECOND_EMAIL, hash_password(PASSWORD), "employee", True, NOW, 0)),
))


def dispatch(command):
    if not isinstance(command, dict) or command.get("op") != "http":
        return {"statusCode": 422, "body": {"error": "unsupported_operation"}}
    method = command.get("method")
    path = command.get("path")
    headers = command.get("headers", {})
    body = command.get("body")
    if not isinstance(method, str) or not isinstance(path, str) or not isinstance(headers, dict):
        return {"statusCode": 422, "body": {"error": "invalid_request"}}
    event = {
        "version": "2.0", "rawPath": path,
        "requestContext": {"http": {"method": method, "sourceIp": "192.0.2.25"}},
        "headers": headers,
    }
    if body is not None:
        event["body"] = body
    response = index.handle(event, service)
    return {
        "statusCode": response["statusCode"],
        "body": json.loads(response["body"]) if response["body"] else {},
    }


for line in sys.stdin:
    try:
        command = json.loads(line)
        result = dispatch(command)
    except (ValueError, TypeError):
        result = {"statusCode": 422, "body": {"error": "invalid_request"}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()
