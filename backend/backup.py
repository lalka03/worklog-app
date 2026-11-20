"""Private, bounded Worklog backups and an isolated restore command."""

import argparse
from dataclasses import asdict, fields, replace
from datetime import datetime, timezone
from hashlib import sha256
from http.client import HTTPSConnection
import io
import json
import logging
import os
import re
from uuid import uuid4

import ydb

from .security import normalize_email
from .service import DomainError, _worklog_json
from .store import BACKUP_TABLES, Account, Invitation, Mutation, Worklog, YdbStore


_SCHEMA_VERSION = 1
_MAX_SNAPSHOT_BYTES = 36 * 1024 * 1024
_MAX_ROWS = 75_000
_MAX_MANIFEST_BYTES = 4096
_TIMER_TYPE = "yandex.cloud.events.serverless.triggers.TimerMessage"
_KEY = re.compile(r"yandex-test/(\d{4}-\d{2}-\d{2})/([0-9a-f]{32})/(snapshot\.jsonl|manifest\.json)", re.ASCII)
_SHA256 = re.compile(r"[0-9a-f]{64}")
_DATABASE_PATH = re.compile(r"/[a-z0-9-]+/[a-z0-9-]+/[a-z0-9-]+")
_LOG = logging.getLogger(__name__)


class BackupError(Exception):
    """A safe, reportable backup or restore failure."""


def _json_bytes(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def _page_size(table):
    return 8 if table == "worklogs" else 512


def _capture(tx):
    payload = io.BytesIO()
    counts = {}
    for table, (_, keys) in BACKUP_TABLES.items():
        after = ("",) * len(keys)
        counts[table] = 0
        limit = _page_size(table)
        while True:
            page = tx.backup_page(table, after, limit)
            for record in page:
                line = _json_bytes([table, asdict(record)]) + b"\n"
                if payload.tell() + len(line) > _MAX_SNAPSHOT_BYTES:
                    raise BackupError("snapshot size exceeds pilot limit")
                payload.write(line)
            counts[table] += len(page)
            if sum(counts.values()) > _MAX_ROWS:
                raise BackupError("snapshot row count exceeds pilot limit")
            if len(page) < limit:
                break
            after = tuple(getattr(page[-1], key) for key in keys)
    return payload.getvalue(), counts


def export_snapshot(store, object_writer, clock=lambda: datetime.now(timezone.utc)):
    """Write a consistent read-transaction snapshot, followed by its manifest."""
    captured = clock()
    if captured.utcoffset() is None:
        raise BackupError("backup clock must include a timezone")
    timestamp = captured.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    prefix = f"yandex-test/{timestamp[:10]}/{uuid4().hex}"
    payload, counts = store.run_read(_capture)
    manifest = {
        "schema_version": _SCHEMA_VERSION, "created_at": timestamp,
        "source_database": getattr(store, "database", None),
        "data_key": f"{prefix}/snapshot.jsonl", "manifest_key": f"{prefix}/manifest.json",
        "sha256": sha256(payload).hexdigest(), "counts": counts,
    }
    try:
        object_writer.write(manifest["data_key"], payload)
        object_writer.write(manifest["manifest_key"], _json_bytes(manifest))
    except Exception:
        raise BackupError("snapshot upload failed") from None
    return manifest


def _validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise BackupError("invalid manifest")
    version = manifest.get("schema_version")
    if type(version) is not int or version != _SCHEMA_VERSION:
        raise BackupError("unsupported backup schema")
    data_key = manifest.get("data_key")
    match = _KEY.fullmatch(data_key) if isinstance(data_key, str) else None
    timestamp = manifest.get("created_at")
    expected = manifest.get("sha256")
    counts = manifest.get("counts")
    source = manifest.get("source_database")
    if (
        not match or match[3] != "snapshot.jsonl" or
        manifest.get("manifest_key") != data_key.removesuffix("snapshot.jsonl") + "manifest.json" or
        not isinstance(timestamp, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", timestamp) or
        match[1] != timestamp[:10] or not isinstance(expected, str) or not _SHA256.fullmatch(expected) or
        (source is not None and (not isinstance(source, str) or not _DATABASE_PATH.fullmatch(source))) or
        not isinstance(counts, dict) or set(counts) != BACKUP_TABLES.keys() or
        any(type(count) is not int or count < 0 for count in counts.values()) or sum(counts.values()) > _MAX_ROWS
    ):
        raise BackupError("invalid manifest")
    try:
        datetime.fromisoformat(timestamp)
    except ValueError:
        raise BackupError("invalid manifest timestamp") from None


def _decode_rows(payload, counts):
    records = {table: [] for table in BACKUP_TABLES}
    previous = {table: ("",) * len(keys) for table, (_, keys) in BACKUP_TABLES.items()}
    try:
        for line in io.BytesIO(payload):
            table, row = json.loads(line)
            model, keys = BACKUP_TABLES[table]
            if (
                not isinstance(row, dict) or set(row) != {field.name for field in fields(model)} or
                any(type(row[field.name]) is not field.type for field in fields(model)) or
                any(type(value) is int and not 0 <= value < 2**64 for value in row.values())
            ):
                raise BackupError("invalid snapshot row schema")
            pk = tuple(row[key] for key in keys)
            if not all(pk) or pk <= previous[table] or len(records[table]) >= counts[table]:
                raise BackupError("invalid snapshot row count or key")
            previous[table] = pk
            record = model(**row)
            if isinstance(record, Account) and (
                normalize_email(record.email) != record.email or
                record.role not in ("admin", "employee") or not record.password_hash.startswith("$argon2id$")
            ):
                raise BackupError("invalid snapshot account")
            if isinstance(record, Invitation):
                if not _SHA256.fullmatch(record.digest) or record.state not in ("available", "used", "revoked"):
                    raise BackupError("invalid snapshot invitation")
                if record.state == "available":
                    record = replace(record, state="revoked")
            if isinstance(record, Worklog):
                _worklog_json(record.data)
            if isinstance(record, Mutation) and not _SHA256.fullmatch(record.request_digest):
                raise BackupError("invalid snapshot mutation")
            records[table].append(record)
    except (ValueError, TypeError, KeyError, DomainError, RecursionError):
        raise BackupError("invalid snapshot contents") from None

    if {table: len(rows) for table, rows in records.items()} != counts:
        raise BackupError("snapshot counts do not match manifest")
    accounts = records["accounts"]
    ids = {record.uid for record in accounts}
    if len({record.email for record in accounts}) != len(accounts):
        raise BackupError("duplicate snapshot account email")
    invites = records["invitations"]
    if len({record.id for record in invites if record.id}) != len(invites) or any(
        (record.issuer_uid and record.issuer_uid not in ids) or
        (record.state == "used" and record.consumed_by not in ids) or
        (record.state != "used" and record.consumed_by)
        for record in invites
    ):
        raise BackupError("invalid snapshot invitation linkage")
    worklogs = {record.uid: record for record in records["worklogs"]}
    if worklogs.keys() - ids or any(
        record.uid not in worklogs or not 0 < record.revision <= worklogs[record.uid].revision
        for record in records["mutations"]
    ):
        raise BackupError("invalid snapshot worklog linkage")
    return records


def restore_snapshot(store, object_reader, manifest, confirm_isolated=False):
    """Verify the full backup and import it atomically into an empty isolated schema."""
    if confirm_isolated is not True:
        raise BackupError("explicit confirmation of an isolated restore target is required")
    _validate_manifest(manifest)
    if manifest.get("source_database") and manifest["source_database"] == getattr(store, "database", None):
        raise BackupError("restore target is the snapshot source database")
    try:
        payload = object_reader.read(manifest["data_key"], _MAX_SNAPSHOT_BYTES)
    except Exception:
        raise BackupError("could not read snapshot object") from None
    if (not isinstance(payload, bytes) or len(payload) > _MAX_SNAPSHOT_BYTES or
            sha256(payload).hexdigest() != manifest["sha256"]):
        raise BackupError("snapshot checksum or size is invalid")
    records = _decode_rows(payload, manifest["counts"])

    def restore(tx):
        if not tx.backup_target_empty():
            raise BackupError("restore target must be empty")
        for table, rows in records.items():
            limit = _page_size(table)
            for start in range(0, len(rows), limit):
                tx.insert_backup_page(table, rows[start:start + limit])

    store.run_write(restore)
    return {"counts": manifest["counts"]}


class ObjectStorage:
    """Yandex S3 API over TLS, using only a short-lived IAM token."""

    def __init__(self, bucket, token, kms_key=None):
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket) or not token:
            raise BackupError("invalid Object Storage configuration")
        self._bucket = bucket
        self._token = token
        self._kms_key = kms_key

    def _request(self, method, key, payload=None, max_bytes=0):
        if not _KEY.fullmatch(key):
            raise BackupError("invalid backup object key")
        headers = {"Authorization": f"Bearer {self._token}"}
        if method == "PUT":
            if not self._kms_key:
                raise BackupError("backup encryption key is required")
            headers.update({
                "If-None-Match": "*",
                "Content-Type": "application/json" if key.endswith("/manifest.json") else "application/x-ndjson",
                "X-Amz-Server-Side-Encryption": "aws:kms",
                "X-Amz-Server-Side-Encryption-Aws-Kms-Key-Id": self._kms_key,
            })
        connection = HTTPSConnection("storage.yandexcloud.net", timeout=30)
        try:
            connection.request(method, f"/{self._bucket}/{key}", body=payload, headers=headers)
            with connection.getresponse() as response:
                if response.status != 200:
                    raise BackupError(f"Object Storage {method} returned HTTP {response.status}")
                result = response.read(max_bytes + 1)
                if len(result) > max_bytes:
                    raise BackupError("object exceeds size limit")
                return result
        finally:
            connection.close()

    def write(self, key, data):
        self._request("PUT", key, data)

    def read(self, key, max_bytes):
        return self._request("GET", key, max_bytes=max_bytes)


def _timer_event(event, expected_trigger):
    if not expected_trigger or not isinstance(event, dict) or set(event) != {"messages"}:
        return False
    messages = event["messages"]
    if not isinstance(messages, list) or len(messages) != 1 or not isinstance(messages[0], dict):
        return False
    metadata, details = messages[0].get("event_metadata"), messages[0].get("details")
    return (isinstance(metadata, dict) and metadata.get("event_type") == _TIMER_TYPE and
            isinstance(details, dict) and details.get("trigger_id") == expected_trigger)


def handler(event, context):
    """Execute a scheduled export. Cloud IAM is the invocation boundary."""
    if not _timer_event(event, os.environ.get("WORKLOG_BACKUP_TRIGGER_ID")):
        raise BackupError("backup requires the configured timer invocation")
    try:
        token = context.token["access_token"]
        objects = ObjectStorage(
            os.environ["WORKLOG_BACKUP_BUCKET"], token,
            os.environ["WORKLOG_BACKUP_KMS_KEY_ID"],
        )
        store = YdbStore.connect(
            os.environ["WORKLOG_YDB_ENDPOINT"], os.environ["WORKLOG_YDB_DATABASE"],
            ydb.AccessTokenCredentials(token),
        )
        try:
            manifest = export_snapshot(store, objects)
        finally:
            store.close()
    except Exception:
        _LOG.error("Worklog scheduled backup failed")
        raise BackupError("scheduled backup failed") from None
    _LOG.info("Worklog scheduled backup completed")
    return {"manifest_key": manifest["manifest_key"], "counts": manifest["counts"]}


def main():
    parser = argparse.ArgumentParser(description="Restore a private backup to a freshly created isolated YDB")
    for option in ("bucket", "manifest-key", "endpoint", "source-database", "restore-database"):
        parser.add_argument(f"--{option}", required=True)
    parser.add_argument("--confirm-isolated", action="store_true", required=True)
    args = parser.parse_args()
    if (
        not _DATABASE_PATH.fullmatch(args.source_database) or not _DATABASE_PATH.fullmatch(args.restore_database) or
        args.source_database == args.restore_database or not args.endpoint.startswith("grpcs://")
    ):
        parser.error("supply different canonical source and restore database paths and a grpcs endpoint")

    try:
        token = os.environ["WORKLOG_RESTORE_IAM_TOKEN"]
        objects = ObjectStorage(args.bucket, token)
        manifest = json.loads(objects.read(args.manifest_key, _MAX_MANIFEST_BYTES))
        _validate_manifest(manifest)
        if manifest["manifest_key"] != args.manifest_key:
            raise BackupError("backup manifest key does not match")
        if manifest.get("source_database") != args.source_database:
            raise BackupError("backup source database does not match")
        store = YdbStore.connect(args.endpoint, args.restore_database, ydb.AccessTokenCredentials(token))
        try:
            result = restore_snapshot(store, objects, manifest, confirm_isolated=args.confirm_isolated)
        finally:
            store.close()
    except BackupError as exc:
        parser.exit(1, f"{exc}\n")
    except Exception:
        parser.exit(1, "isolated restore failed, check approved resource IDs and IAM bindings\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
