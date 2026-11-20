"""Private Worklog Cloud Function. Never enable public invocation."""
import base64
import json
import os
import uuid
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BUCKET = "worklog-files"
MAX_BYTES = 512 * 1024


def reply(status, data):
    return {"statusCode": status, "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
            "isBase64Encoded": False, "body": json.dumps(data, ensure_ascii=True)}


def read_event(event):
    if not isinstance(event, dict):
        raise ValueError
    if "httpMethod" in event:
        if event["httpMethod"] != "POST":
            raise ValueError
        body = event.get("body", "")
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body, validate=True).decode("utf-8")
        if not isinstance(body, str) or len(body.encode("utf-8")) > MAX_BYTES:
            raise ValueError
        event = json.loads(body)
    if not isinstance(event, dict):
        raise ValueError
    return event


def storage(method, key, token, data=None):
    request = Request(f"https://storage.yandexcloud.net/{BUCKET}/{key}", data=data, method=method,
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urlopen(request, timeout=5) as response:
        result = response.read(MAX_BYTES + 1)
    if len(result) > MAX_BYTES:
        raise ValueError
    return result


def handler(event, context):
    try:
        payload = read_event(event)
        action = payload.get("action")
        if action not in ("probe", "save", "load"):
            return reply(400, {"error": "unknown_action"})
        # Only permit actual backups after a deliberate private deployment decision.
        if action != "probe" and os.environ.get("WORKLOG_BACKUPS_ENABLED") != "1":
            return reply(403, {"error": "backups_disabled"})
        token = (getattr(context, "token", None) or {}).get("access_token")
        if not token:
            return reply(503, {"error": "service_account_token_missing"})
        if action == "probe":
            key = "_diagnostics/probe.json"
            sample = json.dumps({"type": "worklog-probe", "nonce": uuid.uuid4().hex}).encode()
            storage("PUT", key, token, sample)
            if storage("GET", key, token) != sample:
                return reply(502, {"error": "probe_mismatch"})
            return reply(200, {"ok": True, "bucket": BUCKET, "object": key})
        if action == "save":
            backup = payload.get("backup")
            if (not isinstance(backup, dict) or not isinstance(backup.get("settings"), dict)
                    or not isinstance(backup.get("days"), dict) or backup.get("version") != 1):
                return reply(400, {"error": "invalid_backup"})
            backup_id = uuid.uuid4().hex
            data = json.dumps({"createdAt": datetime.now(timezone.utc).isoformat(), "backup": backup},
                              ensure_ascii=True, allow_nan=False).encode()
            if len(data) > MAX_BYTES:
                return reply(413, {"error": "backup_too_large"})
            storage("PUT", f"backups/{backup_id}.json", token, data)
            return reply(201, {"ok": True, "backupId": backup_id})
        backup_id = payload.get("backupId")
        if not isinstance(backup_id, str) or uuid.UUID(hex=backup_id).hex != backup_id:
            return reply(400, {"error": "invalid_backup_id"})
        raw = storage("GET", f"backups/{backup_id}.json", token)
        return reply(200, {"ok": True, **json.loads(raw)})
    except HTTPError as error:
        if error.code == 404:
            return reply(404, {"error": "object_not_found"})
        return reply(502, {"error": "storage_request_failed", "storageStatus": error.code})
    except (URLError, TimeoutError):
        return reply(502, {"error": "storage_unavailable"})
    except (ValueError, TypeError):
        return reply(400, {"error": "invalid_input"})
