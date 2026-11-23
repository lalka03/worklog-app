"""Safely probe an empty read-write YDB transaction for one QA employee.
No UPDATE/DELETE/INSERT operations; account and other data cannot be changed.
"""
import json
import subprocess
import urllib.parse
from contextlib import closing

import ydb
from backend.store import StoreUnavailable, YdbStore

TARGET = "worklog.offline.qa.20261123@example.com"
if subprocess.check_output(["yc", "config", "get", "folder-id"], text=True).strip() != "b1gbctisrf70nalca0ve":
    raise SystemExit("WRONG_FOLDER_STOP")
info = json.loads(subprocess.check_output(
    ["yc", "ydb", "database", "get", "--id", "etntoapt41gu9i5u5blj", "--format", "json"],
    text=True
))
if info.get("id") != "etntoapt41gu9i5u5blj" or info.get("name") != "worklog-yandex-test-db":
    raise SystemExit("WRONG_DATABASE_STOP")
u = urllib.parse.urlsplit(info["endpoint"])
d = urllib.parse.parse_qs(u.query).get("database", [])
if u.scheme != "grpcs" or not u.netloc or len(d) != 1:
    raise SystemExit("BAD_ENDPOINT_STOP")
token = subprocess.check_output(["yc", "iam", "create-token"], text=True).strip()
with closing(YdbStore.connect(
    u.scheme + "://" + u.netloc, d[0], ydb.AccessTokenCredentials(token)
)) as store:
    account = store.run_read(lambda tx: tx.get_account_by_email(TARGET))
    if not (account and account.email == TARGET and account.role == "employee"
            and account.enabled and account.created_at >= 1795392000):
        raise SystemExit("QA_GUARD_STOP")
    try:
        # The transaction only SELECTs and commits; it contains no write statements.
        result = store.run_write(lambda tx: tx.get_account_by_email(TARGET))
    except StoreUnavailable as exc:
        print("QA_RW_PROBE_FAILED_" + type(exc.__cause__).__name__)
    else:
        if not (result and result.uid == account.uid):
            raise SystemExit("QA_RW_PROBE_INCONSISTENT")
        print("QA_RW_PROBE_OK")
