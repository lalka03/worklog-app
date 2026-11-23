"""Read-only Yandex Cloud metadata preflight for a future disposable restore DB.

Does NOT create/delete/change anything, download backups, query billing, or print
credentials. Stops on ambiguity. Run only with owner's own authorized yc profile.
"""
import json
import subprocess
import sys

FOLDER_ID = "b1gbctisrf70nalca0ve"
SOURCE_ID = "etntoapt41gu9i5u5blj"
SOURCE_NAME = "worklog-yandex-test-db"
TARGET_NAME = "worklog-restore-qa-20261123"


def check(folder, source, inventory):
    if folder != FOLDER_ID:
        return "WRONG_FOLDER_STOP"
    if not isinstance(source, dict) or source.get("id") != SOURCE_ID or source.get("name") != SOURCE_NAME:
        return "WRONG_SOURCE_DATABASE_STOP"
    if source.get("folder_id") not in (None, FOLDER_ID):
        return "WRONG_SOURCE_FOLDER_STOP"
    if source.get("status") != "RUNNING":
        return "SOURCE_NOT_RUNNING_STOP"
    if not isinstance(inventory, list) or not all(
        isinstance(item, dict) and isinstance(item.get("id"), str)
        and isinstance(item.get("name"), str) for item in inventory
    ):
        return "INVALID_DATABASE_LIST_STOP"
    if any(item["name"] == TARGET_NAME for item in inventory):
        return "RESTORE_DB_ALREADY_EXISTS_STOP"
    if not any(item["id"] == SOURCE_ID and item["name"] == SOURCE_NAME for item in inventory):
        return "SOURCE_NOT_LISTED_STOP"
    return "METADATA_READY_BILLING_NOT_VERIFIED"


def main():
    try:
        folder = subprocess.check_output(
            ["yc", "config", "get", "folder-id"], text=True, stderr=subprocess.DEVNULL, timeout=20
        ).strip()
        if folder != FOLDER_ID:
            print("WRONG_FOLDER_STOP")
            return 1
        raw = subprocess.check_output(
            ["yc", "ydb", "database", "get", "--id", SOURCE_ID, "--format", "json"],
            text=True, stderr=subprocess.DEVNULL, timeout=30,
        )
        source = json.loads(raw)
        raw = subprocess.check_output(
            ["yc", "ydb", "database", "list", "--folder-id", FOLDER_ID, "--format", "json"],
            text=True, stderr=subprocess.DEVNULL, timeout=30,
        )
        inventory = json.loads(raw)
        # yc may return a plain array or a JSON object with 'databases'.
        if isinstance(inventory, dict):
            inventory = inventory.get("databases")
        status = check(folder, source, inventory)
    except (OSError, ValueError, subprocess.SubprocessError):
        print("READONLY_CLOUD_CHECK_FAILED")
        return 1
    print(status)
    if status == "METADATA_READY_BILLING_NOT_VERIFIED":
        print("NO_DB_CREATED")
        print("NEXT: OWNER_BILLING_AND_RU_LIMIT_REVIEW")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
