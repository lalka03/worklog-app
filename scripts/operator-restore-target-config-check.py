"""Read-only *post-provisioning* validation of a disposable restore YDB.

This is NOT a creator, billing check or backup reader. The owner must first
approve a numeric spending limit and specifically approve creation of the DB.
No writes, tokens, or personal data are handled.
"""
import argparse
import json
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

FOLDER_ID = "b1gbctisrf70nalca0ve"
SOURCE_ID = "etntoapt41gu9i5u5blj"
TARGET_NAME = "worklog-restore-qa-20261123"
MAX_STORAGE_BYTES = 1024 ** 3
MAX_RU_PER_SECOND = 10


def nonnegative_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        return int(value)
    return None


def check_target(target_id, info):
    if not isinstance(target_id, str) or not re.fullmatch(r"[a-z0-9]{20}", target_id):
        return "INVALID_TARGET_ID_STOP"
    if target_id == SOURCE_ID:
        return "SOURCE_ID_AS_TARGET_STOP"
    if not isinstance(info, dict):
        return "INVALID_TARGET_METADATA_STOP"
    if (info.get("id") != target_id or info.get("name") != TARGET_NAME
            or info.get("folder_id") != FOLDER_ID):
        return "WRONG_TARGET_STOP"
    if info.get("status") != "RUNNING":
        return "TARGET_NOT_RUNNING_STOP"
    if "dedicated_database" in info:
        return "DEDICATED_DATABASE_STOP"
    sls = info.get("serverless_database")
    if not isinstance(sls, dict):
        return "NOT_SERVERLESS_STOP"
    storage = nonnegative_int(sls.get("storage_size_limit"))
    throughput = nonnegative_int(sls.get("throttling_rcu_limit"))
    reserved = nonnegative_int(sls.get("provisioned_rcu_limit"))
    if storage is None or storage == 0 or storage > MAX_STORAGE_BYTES:
        return "STORAGE_LIMIT_STOP"
    # Both flags and numeric values matter. A value without enabling the
    # throttling flag does not cap actual request throughput.
    if sls.get("enable_throttling_rcu_limit") is not True:
        return "THROTTLING_DISABLED_STOP"
    if throughput is None or throughput == 0 or throughput > MAX_RU_PER_SECOND:
        return "RU_LIMIT_STOP"
    if reserved != 0:
        return "RESERVED_PAID_CAPACITY_STOP"
    endpoint = info.get("endpoint")
    if not isinstance(endpoint, str):
        return "TARGET_ENDPOINT_STOP"
    try:
        parsed = urlsplit(endpoint)
        paths = parse_qs(parsed.query).get("database", [])
        exact_path = "/ru-central1/" + FOLDER_ID + "/" + target_id
        valid = (
            parsed.scheme == "grpcs" and parsed.hostname == "ydb.serverless.yandexcloud.net"
            and parsed.port == 2135 and parsed.username is None
            and parsed.password is None and paths == [exact_path]
        )
    except ValueError:
        valid = False
    if not valid:
        return "TARGET_ENDPOINT_STOP"
    return "TARGET_LIMITS_VERIFIED_BILLING_NOT_VERIFIED"


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-id", required=True, help="exact newly created restore DB ID")
    args = parser.parse_args(argv)
    if args.target_id == SOURCE_ID:
        print("SOURCE_ID_AS_TARGET_STOP")
        return 1
    if not re.fullmatch(r"[a-z0-9]{20}", args.target_id):
        print("INVALID_TARGET_ID_STOP")
        return 1
    try:
        folder = subprocess.check_output(
            ["yc", "config", "get", "folder-id"],
            text=True, stderr=subprocess.DEVNULL, timeout=20,
        ).strip()
        if folder != FOLDER_ID:
            print("WRONG_FOLDER_STOP")
            return 1
        raw = subprocess.check_output(
            ["yc", "ydb", "database", "get", "--id", args.target_id, "--format", "json"],
            text=True, stderr=subprocess.DEVNULL, timeout=30,
        )
        status = check_target(args.target_id, json.loads(raw))
    except (OSError, ValueError, subprocess.SubprocessError):
        print("TARGET_READ_FAILED")
        return 1
    print(status)
    if status == "TARGET_LIMITS_VERIFIED_BILLING_NOT_VERIFIED":
        print("NO_RESTORE_PERFORMED")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
